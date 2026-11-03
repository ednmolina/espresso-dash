// Extraction forecast model. Pure JS, deterministic, no React / Firebase.
//
// Rows are the shots with a measured extraction, in date order. A shrunk ridge
// regression (global fit, then a per-coffee fit pulled toward it) predicts
// extraction from the inputs the brewer actually sets: grind, brew ratio, dose
// and pH. Which inputs are used is decided by forward selection on an
// expanding-window backtest, so every accuracy number is out-of-sample.
// Missing values are never filled in: a row (or planned shot) without a value
// simply cannot use that input.
import {
  indexToSetting,
  MAX_INDEX,
  parseGrindUm,
  settingToIndex,
  settingToSize,
} from './grindCalibration'

export const LIMITS = {
  MIN_SHOTS: 8,
  MIN_FEATURE_ROWS: 8,
  BACKTEST_MIN_TRAIN: 8,
  MIN_EVAL: 5,
  MIN_RESIDUALS_Q: 10,
  RIDGE_GLOBAL: 1,
  SHRINK_COFFEE: 8,
  IMPROVE_EPS: 0.01,
  TARGET: 20,
  WITHIN: 1,
}

export const CANDIDATE_FEATURES = ['grind', 'ratio', 'dose', 'ph']
export const NOT_INPUTS = [
  { key: 'time', label: 'Shot time' },
  { key: 'tempC', label: 'Temperature' },
]

const RATING_KEYS = ['bad', 'good', 'great']
const RATING_NAMES = ['Bad', 'Good', 'Great']
const NOT_INPUT_DETAIL = {
  time: 'Shot time is a result of the grind and dose, not something you set, so it is never an input.',
  tempC: 'Temperature is measured at tasting, not a recipe input, so it is never used.',
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? Number(v.trim()) : v
  return isNum(n) ? n : null
}

function text(v) {
  return v === null || v === undefined ? '' : String(v).trim()
}

// ---- coffees ----------------------------------------------------------------

export function coffeeKey(x) {
  return [x?.roaster, x?.region, x?.variety].map((v) => text(v).toLowerCase()).join('|')
}

export function coffeeLabel(x) {
  return [x?.roaster, x?.region, x?.variety].map(text).filter(Boolean).join(' · ') || 'Unknown coffee'
}

const hasCoffee = (key) => Boolean(key) && key.replace(/\|/g, '') !== ''

export function listCoffees(shots) {
  const byKey = new Map()
  ;(shots || []).forEach((shot) => {
    if (!shot) return
    const key = coffeeKey(shot)
    const entry = byKey.get(key) || { key, label: coffeeLabel(shot), shots: 0, lastDate: '', last: null }
    entry.shots += 1
    const date = shot.date || ''
    if (!entry.last || date >= entry.lastDate) {
      entry.lastDate = date
      entry.last = shot
    }
    byKey.set(key, entry)
  })
  return [...byKey.values()].sort((a, b) => (
    b.lastDate.localeCompare(a.lastDate) || a.label.localeCompare(b.label)
  ))
}

// ---- features ---------------------------------------------------------------

function calibrationMean(calibration) {
  return calibration?.mean?.ok ? calibration.mean : null
}

function grindFeature(basisModel, grindIndex, measuredUm) {
  if (!basisModel) return grindIndex
  const um = measuredUm ?? (grindIndex === null ? null : settingToSize(basisModel, grindIndex)?.um)
  return isNum(um) && um > 0 ? Math.log(um) : null
}

function ratioOf(yieldGrams, dose) {
  return isNum(yieldGrams) && isNum(dose) && dose > 0 ? yieldGrams / dose : null
}

export function featurize(shot, { calibration = null } = {}) {
  const model = calibrationMean(calibration)
  const grindIndex = settingToIndex(shot?.grindSetting)
  const measured = parseGrindUm(shot?.avgGrind)
  const dose = numOrNull(shot?.dose)
  return {
    id: shot?.id ?? null,
    order: null,
    date: shot?.date ?? null,
    coffee: coffeeKey(shot),
    coffeeLabel: coffeeLabel(shot),
    extraction: numOrNull(shot?.extraction),
    rating: Math.max(0, Math.min(2, Math.round(Number(shot?.rating) || 0))),
    grind: grindFeature(model, grindIndex, measured?.um ?? null),
    grindIndex,
    ratio: ratioOf(numOrNull(shot?.yieldGrams), dose),
    dose,
    ph: numOrNull(shot?.ph),
    createdAt: shot?.createdAt ?? null,
  }
}

function makeRows(shots, calibration) {
  const rows = (shots || [])
    .map((shot) => featurize(shot, { calibration }))
    .filter((row) => isNum(row.extraction) && row.date)
  rows.sort((a, b) => (
    String(a.date).localeCompare(String(b.date))
    || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
    || String(a.id ?? '').localeCompare(String(b.id ?? ''))
  ))
  rows.forEach((row, index) => { row.order = index })
  return rows
}

// ---- linear algebra ---------------------------------------------------------

/** Solve A x = b by Gaussian elimination with partial pivoting; null if singular. */
function solve(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null
    if (pivot !== col) [M[pivot], M[col]] = [M[col], M[pivot]]
    for (let r = col + 1; r < n; r += 1) {
      const f = M[r][col] / M[col][col]
      if (f === 0) continue
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c]
    }
  }
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = M[i][n]
    for (let c = i + 1; c < n; c += 1) s -= M[i][c] * x[c]
    x[i] = s / M[i][i]
  }
  return x
}

/**
 * Ridge regression of y on Z (rows of standardised features, no intercept column).
 * Returns [intercept, ...slopes]. With `prior` (same layout) the penalty pulls
 * toward it instead of toward zero. Returns null when the system is singular.
 */
export function fitRidge(Z, y, { lambda = 1, prior = null, penalizeIntercept = false } = {}) {
  const p = Z.length ? Z[0].length : (prior ? prior.length - 1 : 0)
  const m = p + 1
  const A = Array.from({ length: m }, () => new Array(m).fill(0))
  const rhs = new Array(m).fill(0)
  for (let i = 0; i < Z.length; i += 1) {
    const x = [1, ...Z[i]]
    for (let j = 0; j < m; j += 1) {
      rhs[j] += x[j] * y[i]
      for (let k = 0; k < m; k += 1) A[j][k] += x[j] * x[k]
    }
  }
  for (let j = 0; j < m; j += 1) {
    const pen = j === 0 ? (penalizeIntercept ? lambda : 0) : lambda
    A[j][j] += pen
    rhs[j] += pen * (prior ? prior[j] : 0)
  }
  return solve(A, rhs)
}

// ---- fitting / prediction ---------------------------------------------------

const meanOf = (values) => values.reduce((s, v) => s + v, 0) / values.length

function quantile(sorted, q) {
  if (!sorted.length) return null
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Features usable for a target, and the training rows that have all of them. */
function resolveUsed(train, features, target) {
  let used = features.filter((f) => target[f] !== null && target[f] !== undefined)
  let rowsOk = train
  for (;;) {
    rowsOk = train.filter((r) => used.every((f) => r[f] !== null && r[f] !== undefined))
    if (rowsOk.length >= LIMITS.MIN_FEATURE_ROWS || used.length === 0) break
    used = used.slice(0, -1)
  }
  if (used.length === 0) rowsOk = train
  return { used, rowsOk }
}

/** Global ridge + coffee model shrunk toward it. */
function fitModel(rows, used, coffee) {
  const stats = used.map((f) => {
    const values = rows.map((r) => r[f])
    const mean = meanOf(values)
    const sd = Math.sqrt(meanOf(values.map((v) => (v - mean) ** 2)))
    return { f, mean, sd }
  }).filter((s) => s.sd > 1e-12)
  const feats = stats.map((s) => s.f)
  const Z = rows.map((r) => stats.map((s) => (r[s.f] - s.mean) / s.sd))
  const y = rows.map((r) => r.extraction)
  const fallback = [meanOf(y), ...stats.map(() => 0)]
  const betaG = fitRidge(Z, y, { lambda: LIMITS.RIDGE_GLOBAL }) || fallback
  let betaC = betaG
  let coffeeN = 0
  if (hasCoffee(coffee)) {
    const idx = rows.map((r, i) => (r.coffee === coffee ? i : -1)).filter((i) => i >= 0)
    coffeeN = idx.length
    if (idx.length) {
      betaC = fitRidge(
        idx.map((i) => Z[i]),
        idx.map((i) => y[i]),
        { lambda: LIMITS.SHRINK_COFFEE, prior: betaG, penalizeIntercept: true },
      ) || betaG
    }
  }
  return { rows, used: feats, stats, betaG, betaC, coffeeN }
}

function predictFit(fit, target) {
  let value = fit.betaC[0]
  fit.stats.forEach((s, j) => {
    value += fit.betaC[j + 1] * ((target[s.f] - s.mean) / s.sd)
  })
  return value
}

function ratingProbabilities(fit, target) {
  const rows = fit.rows
  const prior = [0, 0, 0]
  rows.forEach((r) => { prior[r.rating] += 1 })
  prior.forEach((_, k) => { prior[k] /= rows.length || 1 })
  const sums = [0, 0, 0]
  let total = 0
  let similar = 0
  rows.forEach((r) => {
    let d2 = 0
    fit.stats.forEach((s) => { d2 += ((r[s.f] - target[s.f]) / s.sd) ** 2 })
    const base = Math.exp(-0.5 * d2)
    if (base >= 0.5) similar += 1
    const w = base * (hasCoffee(target.coffee) && r.coffee === target.coffee ? 2 : 1)
    sums[r.rating] += w
    total += w
  })
  const probs = sums.map((s, k) => (s + prior[k]) / (total + 1))
  return { probs, similar }
}

function argmaxRating(probs) {
  let best = 0
  probs.forEach((p, k) => { if (p >= probs[best]) best = k })
  return best
}

// ---- backtest ---------------------------------------------------------------

function backtestCore(rows, features, { onFit = null, withProbs = false } = {}) {
  const out = []
  let running = 0
  for (let i = 0; i < rows.length; i += 1) {
    if (i >= LIMITS.BACKTEST_MIN_TRAIN) {
      const target = rows[i]
      const train = rows.slice(0, i)
      const { used, rowsOk } = resolveUsed(train, features, target)
      const fit = fitModel(rowsOk, used, target.coffee)
      if (onFit) onFit(rowsOk.map((r) => r.order), target.order)
      out.push({
        row: target,
        pred: predictFit(fit, target),
        basePred: running / i,
        probs: withProbs ? ratingProbabilities(fit, target).probs : null,
      })
    }
    running += rows[i].extraction
  }
  return out
}

function metricsFrom(actuals, preds) {
  const n = actuals.length
  const errs = actuals.map((a, i) => a - preds[i])
  const mae = errs.reduce((s, e) => s + Math.abs(e), 0) / n
  const sse = errs.reduce((s, e) => s + e * e, 0)
  const mean = meanOf(actuals)
  const sst = actuals.reduce((s, a) => s + (a - mean) ** 2, 0)
  return {
    mae,
    rmse: Math.sqrt(sse / n),
    r2: sst > 0 ? 1 - sse / sst : null,
    within1: errs.filter((e) => Math.abs(e) <= LIMITS.WITHIN).length / n,
  }
}

function ratingMetrics(results) {
  const n = results.length
  let brier = 0
  const recalls = [0, 0, 0]
  const counts = [0, 0, 0]
  const bins = Array.from({ length: 5 }, (_, i) => ({ lo: i * 0.2, hi: (i + 1) * 0.2, sumP: 0, hits: 0, count: 0 }))
  results.forEach(({ row, probs }) => {
    probs.forEach((p, k) => { brier += (p - (row.rating === k ? 1 : 0)) ** 2 })
    counts[row.rating] += 1
    if (argmaxRating(probs) === row.rating) recalls[row.rating] += 1
    const bin = bins[Math.min(4, Math.floor(probs[2] * 5))]
    bin.sumP += probs[2]
    bin.hits += row.rating === 2 ? 1 : 0
    bin.count += 1
  })
  const present = counts.map((c, k) => (c ? recalls[k] / c : null)).filter((v) => v !== null)
  return {
    evaluated: n,
    balancedAccuracy: present.length ? meanOf(present) : null,
    brier: brier / n,
    calibration: bins.filter((b) => b.count).map((b) => ({
      lo: b.lo, hi: b.hi, predicted: b.sumP / b.count, observed: b.hits / b.count, count: b.count,
    })),
  }
}

/**
 * Expanding-window backtest: row i (i >= BACKTEST_MIN_TRAIN) is predicted from rows
 * with a smaller order only. Returns null when nothing can be evaluated; the model
 * builder additionally requires MIN_EVAL evaluated rows before it reports metrics.
 */
export function runBacktest(rows, features, { onFit = null } = {}) {
  const results = backtestCore(rows, features, { onFit, withProbs: true })
  if (!results.length) return null
  const actual = results.map((r) => r.row.extraction)
  const model = metricsFrom(actual, results.map((r) => r.pred))
  const baseline = metricsFrom(actual, results.map((r) => r.basePred))
  const points = results.map((r) => ({
    id: r.row.id,
    date: r.row.date,
    order: r.row.order,
    coffee: r.row.coffee,
    coffeeLabel: r.row.coffeeLabel,
    actual: r.row.extraction,
    predicted: r.pred,
    baselinePred: r.basePred,
    absError: Math.abs(r.row.extraction - r.pred),
  }))
  const halfSize = Math.min(15, Math.floor(points.length / 2))
  const sorted = results.map((r) => r.row.extraction - r.pred).sort((a, b) => a - b)
  return {
    evaluated: results.length,
    model,
    baseline,
    improvementPct: baseline.mae > 0 ? ((baseline.mae - model.mae) / baseline.mae) * 100 : 0,
    points,
    firstHalfMae: halfSize ? meanOf(points.slice(0, halfSize).map((p) => p.absError)) : null,
    lastHalfMae: halfSize ? meanOf(points.slice(-halfSize).map((p) => p.absError)) : null,
    halfSize,
    residualQuantiles: sorted.length >= LIMITS.MIN_RESIDUALS_Q
      ? { q10: quantile(sorted, 0.1), q90: quantile(sorted, 0.9) }
      : null,
    rating: ratingMetrics(results),
  }
}

function backtestMae(rows, features) {
  const results = backtestCore(rows, features)
  if (!results.length) return null
  return results.reduce((s, r) => s + Math.abs(r.row.extraction - r.pred), 0) / results.length
}

// ---- model assembly ---------------------------------------------------------

const memo = new WeakMap()

function ratingPriorOf(rows) {
  const counts = [0, 0, 0]
  rows.forEach((r) => { counts[r.rating] += 1 })
  const n = rows.length || 1
  return { bad: counts[0] / n, good: counts[1] / n, great: counts[2] / n }
}

function featureLabel(key, basis) {
  if (key === 'grind') return basis === 'um' ? 'Grind size (µm)' : 'Grind setting'
  if (key === 'ratio') return 'Brew ratio'
  if (key === 'dose') return 'Dose'
  return 'pH'
}

function round3(v) { return Math.round(v * 1000) / 1000 }

function toOriginalUnits(fit) {
  const coefficients = { intercept: fit.betaG[0] }
  fit.stats.forEach((s, j) => {
    const slope = fit.betaG[j + 1] / s.sd
    coefficients[s.f] = slope
    coefficients.intercept -= slope * s.mean
  })
  return coefficients
}

function unavailableModel(rows, calibration) {
  return {
    available: false,
    reason: `Log ${LIMITS.MIN_SHOTS} shots with extraction to unlock forecasts (${rows.length} so far).`,
    n: rows.length,
    grindBasis: null,
    selected: [],
    coefficients: null,
    features: [],
    backtest: null,
    ratingPrior: ratingPriorOf(rows),
    _rows: rows,
    _calibration: calibration,
  }
}

function compute(shots, calibration) {
  const rows = makeRows(shots, calibration)
  if (rows.length < LIMITS.MIN_SHOTS) return unavailableModel(rows, calibration)

  const basis = calibrationMean(calibration) ? 'um' : 'setting'
  const counts = {}
  CANDIDATE_FEATURES.forEach((f) => { counts[f] = rows.filter((r) => r[f] !== null).length })
  const eligible = CANDIDATE_FEATURES.filter((f) => counts[f] >= LIMITS.MIN_FEATURE_ROWS)
  const canBacktest = rows.length - LIMITS.BACKTEST_MIN_TRAIN >= LIMITS.MIN_EVAL

  let selected = []
  const gains = {}
  if (canBacktest) {
    let current = backtestMae(rows, [])
    for (;;) {
      let best = null
      eligible.filter((f) => !selected.includes(f)).forEach((f) => {
        const mae = backtestMae(rows, [...selected, f])
        const gain = current - mae
        if (best === null || gain > best.gain) best = { f, gain, mae }
      })
      if (best === null || !(best.gain > LIMITS.IMPROVE_EPS)) break
      selected = [...selected, best.f]
      gains[best.f] = best.gain
      current = best.mae
    }
  }

  const backtest = canBacktest ? runBacktest(rows, selected) : null

  const importance = {}
  if (backtest && selected.length) {
    const raw = selected.map((f) => (
      Math.max(0, backtestMae(rows, selected.filter((g) => g !== f)) - backtest.model.mae)
    ))
    const total = raw.reduce((s, v) => s + v, 0)
    selected.forEach((f, i) => { importance[f] = total > 0 ? raw[i] / total : 0 })
  }

  const features = CANDIDATE_FEATURES.map((key) => {
    const label = featureLabel(key, basis)
    const count = counts[key]
    let reason
    let detail
    if (selected.includes(key)) {
      reason = 'used'
      detail = `Lowers backtest error by ${round3(gains[key])} points`
    } else if (count < LIMITS.MIN_FEATURE_ROWS) {
      reason = 'too_few'
      detail = `${label}: ${count} ${count === 1 ? 'shot has' : 'shots have'} it, needs ${LIMITS.MIN_FEATURE_ROWS}`
    } else if (!canBacktest) {
      reason = 'no_gain'
      detail = `Needs ${LIMITS.BACKTEST_MIN_TRAIN + LIMITS.MIN_EVAL} shots with extraction to be tested`
    } else {
      reason = 'no_gain'
      detail = `Did not lower backtest error by more than ${LIMITS.IMPROVE_EPS} points`
    }
    return {
      key, label, used: reason === 'used', count, reason, detail, importance: importance[key] ?? null,
    }
  })
  NOT_INPUTS.forEach(({ key, label }) => {
    features.push({
      key,
      label,
      used: false,
      count: shots.filter((s) => isNum(s?.extraction) && isNum(s?.[key])).length,
      reason: 'not_an_input',
      detail: NOT_INPUT_DETAIL[key],
      importance: null,
    })
  })

  // Coefficients of the overall (all-coffee) fit, in original units.
  const { used, rowsOk } = resolveUsed(rows, selected, Object.fromEntries(selected.map((f) => [f, 0])))
  const coefficients = toOriginalUnits(fitModel(rowsOk, used, ''))

  return {
    available: true,
    reason: null,
    n: rows.length,
    grindBasis: basis,
    selected,
    coefficients,
    features,
    backtest,
    ratingPrior: ratingPriorOf(rows),
    _rows: rows,
    _calibration: calibration,
  }
}

export function buildForecastModel(shots, { calibration = null } = {}) {
  const list = shots || []
  const calKey = calibration?.mean ?? null
  let byCal = memo.get(list)
  if (!byCal) {
    byCal = new Map()
    memo.set(list, byCal)
  }
  if (!byCal.has(calKey)) byCal.set(calKey, compute(list, calibration))
  return byCal.get(calKey)
}

// ---- forecasting ------------------------------------------------------------

function plannedTarget(model, planned) {
  const calModel = calibrationMean(model._calibration)
  const grindIndex = settingToIndex(planned?.grindSetting)
  const plannedUm = numOrNull(planned?.grindUm)
  const dose = numOrNull(planned?.dose)
  return {
    grindIndex,
    target: {
      coffee: text(planned?.coffee),
      grind: grindFeature(calModel, grindIndex, plannedUm !== null && plannedUm > 0 ? plannedUm : null),
      grindIndex,
      ratio: ratioOf(numOrNull(planned?.yieldGrams), dose),
      dose,
      ph: numOrNull(planned?.ph),
    },
  }
}

function indexRange(model, coffee) {
  const pick = (rows) => rows.map((r) => r.grindIndex).filter((v) => v !== null)
  let values = hasCoffee(coffee) ? pick(model._rows.filter((r) => r.coffee === coffee)) : []
  if (!values.length) values = pick(model._rows)
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null
}

export function forecast(model, planned) {
  if (!model?.available) return null
  const { grindIndex, target } = plannedTarget(model, planned)
  const { used, rowsOk } = resolveUsed(model._rows, model.selected, target)
  const fit = fitModel(rowsOk, used, target.coffee)
  const extraction = predictFit(fit, target)
  const { probs, similar } = ratingProbabilities(fit, target)

  const finalUsed = fit.used
  const featuresSkipped = model.selected
    .filter((f) => !finalUsed.includes(f))
    .map((f) => ({ key: f, reason: target[f] === null || target[f] === undefined ? 'not_entered' : 'too_few' }))

  let extrapolated = false
  let widen = 1
  const range = grindIndex === null ? null : indexRange(model, target.coffee)
  if (range) {
    const d = grindIndex < range.min ? range.min - grindIndex : (grindIndex > range.max ? grindIndex - range.max : 0)
    extrapolated = d > 0
    widen = 1 + (0.5 * d) / 9
  }

  let low = null
  let high = null
  let interval = null
  const bt = model.backtest
  if (bt?.residualQuantiles) {
    interval = 'quantile'
    low = extraction + Math.min(0, bt.residualQuantiles.q10) * widen
    high = extraction + Math.max(0, bt.residualQuantiles.q90) * widen
  } else if (bt && bt.evaluated >= LIMITS.MIN_EVAL) {
    interval = 'rmse'
    low = extraction - 1.2816 * bt.model.rmse * widen
    high = extraction + 1.2816 * bt.model.rmse * widen
  }

  const calModel = calibrationMean(model._calibration)
  const size = calModel && grindIndex !== null ? settingToSize(calModel, grindIndex) : null

  return {
    extraction,
    low,
    high,
    interval,
    featuresUsed: finalUsed,
    featuresSkipped,
    probabilities: { bad: probs[0], good: probs[1], great: probs[2] },
    ratingLabel: RATING_NAMES[argmaxRating(probs)],
    coffeeShots: hasCoffee(target.coffee) ? model._rows.filter((r) => r.coffee === target.coffee).length : 0,
    similarCount: similar,
    grindIndex,
    grindUm: size ? { um: size.um, low: size.low, high: size.high } : null,
    extrapolated,
  }
}

export function sweepGrind(model, planned, { span = 6 } = {}) {
  if (!model?.available) return []
  const center = settingToIndex(planned?.grindSetting)
  if (center === null) return []
  const mid = Math.round(center)
  const calModel = calibrationMean(model._calibration)
  const out = []
  for (let index = Math.max(0, mid - span); index <= Math.min(MAX_INDEX, mid + span); index += 1) {
    const setting = indexToSetting(index)
    const f = forecast(model, { ...planned, grindSetting: setting, grindUm: null })
    if (!f) continue
    out.push({
      index,
      setting,
      um: calModel ? (settingToSize(calModel, index)?.um ?? null) : null,
      extraction: f.extraction,
      low: f.low,
      high: f.high,
      bad: f.probabilities.bad,
      good: f.probabilities.good,
      great: f.probabilities.great,
    })
  }
  return out
}

/** Grind setting (within 27 steps) whose forecast is closest to target; null if grind is not an input. */
export function suggestGrind(model, planned, target = LIMITS.TARGET) {
  if (!model?.available || !model.selected.includes('grind')) return null
  const center = settingToIndex(planned?.grindSetting)
  if (center === null) return null
  const mid = Math.round(center)
  let best = null
  for (let index = Math.max(0, mid - 27); index <= Math.min(MAX_INDEX, mid + 27); index += 1) {
    const f = forecast(model, { ...planned, grindSetting: indexToSetting(index), grindUm: null })
    if (!f || !f.featuresUsed.includes('grind')) return null
    const dist = Math.abs(f.extraction - target)
    if (best === null || dist < best.dist - 1e-12
      || (Math.abs(dist - best.dist) <= 1e-12 && Math.abs(index - mid) < Math.abs(best.index - mid))) {
      best = { dist, index, extraction: f.extraction }
    }
  }
  return best ? { setting: indexToSetting(best.index), index: best.index, extraction: best.extraction } : null
}

export function dataCoverage(shots, { calibration = null } = {}) {
  const list = shots || []
  const calModel = calibrationMean(calibration)
  const ph52 = list.filter((s) => s?.ph === 5.2)
  let grindMeasured = 0
  let grindEstimated = 0
  list.forEach((s) => {
    if (parseGrindUm(s?.avgGrind)) {
      grindMeasured += 1
    } else if (calModel && settingToIndex(s?.grindSetting) !== null) {
      grindEstimated += 1
    }
  })
  return {
    total: list.length,
    withExtraction: list.filter((s) => isNum(s?.extraction)).length,
    ph: { count: list.filter((s) => isNum(s?.ph)).length },
    ph52: { count: ph52.length, ids: ph52.map((s) => s.id), dates: ph52.map((s) => s.date) },
    grindMeasured,
    grindEstimated,
    tds: list.filter((s) => isNum(s?.tds)).length,
    doseYield: list.filter((s) => isNum(s?.dose) && isNum(s?.yieldGrams)).length,
  }
}
