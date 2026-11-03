// Extraction forecast model. Pure JS, deterministic, no React / Firebase.
//
// Rows are the shots with a measured extraction, in date order. A shrunk ridge
// regression (global fit, then a per-coffee fit pulled toward it) predicts
// extraction from the inputs the brewer actually sets: grind, brew ratio, dose
// and pH. Which inputs are used is decided by forward selection on an
// expanding-window backtest. The reported backtest repeats that selection for every
// test row using only the rows before it, so every accuracy number is out-of-sample.
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
    // Shots stored without a rating read as 0 ("Bad"); `rated: false` keeps them out of rating stats.
    rated: shot?.rated !== false,
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
  return solveAugmented(A.map((row, i) => [...row, b[i]]))
}

/** Solve from the augmented matrix [A | b] (modified in place). */
function solveAugmented(M) {
  const n = M.length
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

function hasAll(r, used) {
  for (let k = 0; k < used.length; k += 1) {
    const v = r[used[k]]
    if (v === null || v === undefined) return false
  }
  return true
}

/**
 * Features usable for a target, and the training rows that have all of them. When
 * too few rows have every input, the sparsest input is dropped until enough remain.
 */
export function resolveUsed(train, features, target) {
  let used = features.filter((f) => target[f] !== null && target[f] !== undefined)
  let rowsOk = train
  for (;;) {
    rowsOk = used.length ? train.filter((r) => hasAll(r, used)) : train
    if (rowsOk.length >= LIMITS.MIN_FEATURE_ROWS || used.length === 0) break
    let drop = 0
    let dropCount = Infinity
    used.forEach((f, k) => {
      const c = train.reduce((n, r) => n + (r[f] !== null && r[f] !== undefined ? 1 : 0), 0)
      if (c <= dropCount) { drop = k; dropCount = c }
    })
    used = used.filter((_, k) => k !== drop)
  }
  if (used.length === 0) rowsOk = train
  return { used, rowsOk }
}

/**
 * Normal equations of the ridge problem over `rows`, global and (when `coffee` is
 * given) for that coffee only, in one pass and without a design matrix: this runs
 * thousands of times in a backtest.
 */
function accumulate(sys, x, y, m) {
  const { A, rhs } = sys
  sys.n += 1
  for (let j = 0; j < m; j += 1) {
    const xj = x[j]
    rhs[j] += xj * y
    for (let k = j; k < m; k += 1) A[j * m + k] += xj * x[k]
  }
}

function ridgeSystems(rows, stats, coffee) {
  const m = stats.length + 1
  const sys = () => ({ A: new Float64Array(m * m), rhs: new Float64Array(m), n: 0 })
  const G = sys()
  const C = coffee === null ? null : sys()
  const x = new Float64Array(m)
  x[0] = 1
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]
    for (let j = 0; j < stats.length; j += 1) x[j + 1] = (r[stats[j].f] - stats[j].mean) / stats[j].sd
    const inCoffee = C !== null && r.coffee === coffee
    accumulate(G, x, r.extraction, m)
    if (inCoffee) accumulate(C, x, r.extraction, m)
  }
  return { G, C }
}

function solveRidge({ A, rhs }, { lambda, prior = null, penalizeIntercept = false }) {
  const m = rhs.length
  const M = Array.from({ length: m }, (_, j) => {
    const row = new Array(m)
    for (let k = 0; k < m; k += 1) row[k] = k >= j ? A[j * m + k] : A[k * m + j]
    const pen = j === 0 ? (penalizeIntercept ? lambda : 0) : lambda
    row[j] += pen
    row.push(rhs[j] + pen * (prior ? prior[j] : 0))
    return row
  })
  return solveAugmented(M)
}

/** Global ridge + coffee model shrunk toward it. */
function fitModel(rows, used, coffee) {
  const stats = []
  for (let u = 0; u < used.length; u += 1) {
    const f = used[u]
    let sum = 0
    let sq = 0
    const shift = rows[0][f]
    for (let i = 0; i < rows.length; i += 1) {
      const v = rows[i][f] - shift
      sum += v
      sq += v * v
    }
    const dm = sum / rows.length
    const sd = Math.sqrt(Math.max(0, sq / rows.length - dm * dm))
    if (sd > 1e-12) stats.push({ f, mean: shift + dm, sd })
  }
  const feats = stats.map((s) => s.f)
  let ySum = 0
  for (let i = 0; i < rows.length; i += 1) ySum += rows[i].extraction
  const fallback = [ySum / rows.length, ...stats.map(() => 0)]
  const { G, C } = ridgeSystems(rows, stats, hasCoffee(coffee) ? coffee : null)
  const betaG = solveRidge(G, { lambda: LIMITS.RIDGE_GLOBAL }) || fallback
  let betaC = betaG
  const coffeeN = C ? C.n : 0
  if (coffeeN) {
    betaC = solveRidge(C, { lambda: LIMITS.SHRINK_COFFEE, prior: betaG, penalizeIntercept: true }) || betaG
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

function ratingFrequencies(rows) {
  const rated = rows.filter((r) => r.rated)
  if (!rated.length) return [1 / 3, 1 / 3, 1 / 3]
  const freq = [0, 0, 0]
  rated.forEach((r) => { freq[r.rating] += 1 })
  return freq.map((c) => c / rated.length)
}

// Shots without a rating still count as "similar" but never vote for Bad/Good/Great.
function ratingProbabilities(fit, target) {
  const rows = fit.rows
  const prior = ratingFrequencies(rows)
  const sums = [0, 0, 0]
  let total = 0
  let similar = 0
  rows.forEach((r) => {
    let d2 = 0
    fit.stats.forEach((s) => { d2 += ((r[s.f] - target[s.f]) / s.sd) ** 2 })
    const base = Math.exp(-0.5 * d2)
    if (base >= 0.5) similar += 1
    if (!r.rated) return
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

const featureKey = (features) => CANDIDATE_FEATURES.filter((f) => features.includes(f))

/**
 * Cached expanding-window predictor over `rows`. entry(features, j) is the prediction
 * for row j from rows 0..j-1 only, so it is the same number whether it is read as an
 * outer backtest point or as part of an inner backtest of any later fold.
 */
function makePredictor(rows) {
  const cache = new Map()
  function slot(features) {
    const canon = featureKey(features)
    const key = canon.join(',')
    let hit = cache.get(key)
    if (!hit) { hit = { canon, list: [] }; cache.set(key, hit) }
    return hit
  }
  function compute(hit, j) {
    const target = rows[j]
    const { used, rowsOk } = resolveUsed(rows.slice(0, j), hit.canon, target)
    const fit = fitModel(rowsOk, used, target.coffee)
    const pred = predictFit(fit, target)
    hit.list[j] = { fit, pred, err: Math.abs(target.extraction - pred) }
    return hit.list[j]
  }
  const entry = (features, j) => {
    const hit = slot(features)
    return hit.list[j] || compute(hit, j)
  }
  /** Mean abs error of a fixed feature set over rows BACKTEST_MIN_TRAIN..upTo-1. */
  function mae(features, upTo = rows.length) {
    const hit = slot(features)
    let sum = 0
    for (let j = LIMITS.BACKTEST_MIN_TRAIN; j < upTo; j += 1) sum += (hit.list[j] || compute(hit, j)).err
    return sum / (upTo - LIMITS.BACKTEST_MIN_TRAIN)
  }
  /** Forward selection using only rows 0..upTo-1. */
  function select(upTo, onSelect = null) {
    let selected = []
    const gains = {}
    if (upTo - LIMITS.BACKTEST_MIN_TRAIN >= LIMITS.MIN_EVAL) {
      const eligible = CANDIDATE_FEATURES.filter((f) => {
        let c = 0
        for (let j = 0; j < upTo; j += 1) if (rows[j][f] !== null && rows[j][f] !== undefined) c += 1
        return c >= LIMITS.MIN_FEATURE_ROWS
      })
      let current = mae([], upTo)
      for (;;) {
        let best = null
        eligible.filter((f) => !selected.includes(f)).forEach((f) => {
          const m = mae([...selected, f], upTo)
          const gain = current - m
          if (best === null || gain > best.gain) best = { f, gain, mae: m }
        })
        if (best === null || !(best.gain > LIMITS.IMPROVE_EPS)) break
        selected = [...selected, best.f]
        gains[best.f] = best.gain
        current = best.mae
      }
    }
    if (onSelect) onSelect(upTo)
    return { selected, gains }
  }
  return { entry, mae, select }
}

function backtestCore(rows, features, { onFit = null, onSelect = null, nested = false } = {}) {
  const predictor = makePredictor(rows)
  const out = []
  let running = 0
  for (let i = 0; i < rows.length; i += 1) {
    if (i >= LIMITS.BACKTEST_MIN_TRAIN) {
      const target = rows[i]
      // Nested: choose the features for this fold from rows before i only.
      const chosen = nested ? predictor.select(i, (upTo) => { if (onSelect) onSelect(rows.slice(0, upTo).map((r) => r.order), target.order) }).selected : features
      const e = predictor.entry(chosen, i)
      if (onFit) onFit(e.fit.rows.map((r) => r.order), target.order)
      out.push({
        row: target,
        pred: e.pred,
        basePred: running / i,
        selected: featureKey(chosen),
        probs: target.rated ? ratingProbabilities(e.fit, target).probs : null,
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

function ratingMetrics(allResults) {
  const results = allResults.filter((r) => r.probs)
  const n = results.length
  if (!n) return { evaluated: 0, balancedAccuracy: null, brier: null, calibration: [] }
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
 * with a smaller order only. With `nested`, the features for row i are also chosen by
 * forward selection on rows before i only (`features` is then ignored), so the result
 * is fully out-of-sample. Returns null when nothing can be evaluated; the model
 * builder additionally requires MIN_EVAL evaluated rows before it reports metrics.
 */
export function runBacktest(rows, features, { onFit = null, onSelect = null, nested = false } = {}) {
  const results = backtestCore(rows, features, { onFit, onSelect, nested })
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
    selected: r.selected,
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

// ---- model assembly ---------------------------------------------------------

const memo = new WeakMap()

function ratingPriorOf(rows) {
  const [bad, good, great] = ratingFrequencies(rows)
  return { bad, good, great }
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

// The backtest always scores grind on the setting index. Where a calibration exists
// the micrometre feature is an affine function of the index, which standardisation
// removes, so this ranks inputs the same way without letting a curve fitted on the
// whole history (including the shot being predicted) leak into earlier folds.
const backtestRowsOf = (rows, basis) => (
  basis === 'um' ? rows.map((r) => ({ ...r, grind: r.grindIndex })) : rows
)

function compute(shots, calibration) {
  const rows = makeRows(shots, calibration)
  if (rows.length < LIMITS.MIN_SHOTS) return unavailableModel(rows, calibration)

  const basis = calibrationMean(calibration) ? 'um' : 'setting'
  const btRows = backtestRowsOf(rows, basis)
  const counts = {}
  CANDIDATE_FEATURES.forEach((f) => { counts[f] = btRows.filter((r) => r[f] !== null).length })
  const canBacktest = rows.length - LIMITS.BACKTEST_MIN_TRAIN >= LIMITS.MIN_EVAL

  // Production selection uses every row; the reported backtest re-selects per fold.
  const predictor = makePredictor(btRows)
  const { selected, gains } = predictor.select(btRows.length)
  const backtest = canBacktest ? runBacktest(btRows, null, { nested: true }) : null

  const importance = {}
  if (backtest && selected.length) {
    const full = predictor.mae(selected)
    const raw = selected.map((f) => (
      Math.max(0, predictor.mae(selected.filter((g) => g !== f)) - full)
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
    _btRows: btRows,
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

/** Fixed-feature backtest for the inputs a plan can actually use; cached on the model. */
function reducedBacktest(model, features) {
  const key = featureKey(features).join(',')
  if (!model._reduced) model._reduced = new Map()
  if (!model._reduced.has(key)) {
    model._reduced.set(key, runBacktest(model._btRows, featureKey(features)))
  }
  return model._reduced.get(key)
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

  // Residual spread to use. When the plan lacks inputs the model was selected with,
  // the full model's backtest understates the error, so use a backtest of the inputs
  // actually used and never go narrower than the full model's.
  const full = model.backtest
  let spread = full?.residualQuantiles ? { q: full.residualQuantiles } : (full ? { rmse: full.model.rmse } : null)
  let intervalReduced = null
  if (spread && featuresSkipped.length) {
    const reduced = reducedBacktest(model, finalUsed)
    if (reduced?.residualQuantiles && spread.q) {
      spread = {
        q: {
          q10: Math.min(spread.q.q10, reduced.residualQuantiles.q10),
          q90: Math.max(spread.q.q90, reduced.residualQuantiles.q90),
        },
      }
    } else if (reduced) {
      const rmse = Math.max(full.model.rmse, reduced.model.rmse)
      spread = { rmse }
    }
    intervalReduced = featuresSkipped.map((x) => x.key)
  }

  let low = null
  let high = null
  let interval = null
  if (spread?.q) {
    interval = 'quantile'
    low = extraction + Math.min(0, spread.q.q10) * widen
    high = extraction + Math.max(0, spread.q.q90) * widen
  } else if (spread && full.evaluated >= LIMITS.MIN_EVAL) {
    interval = 'rmse'
    low = extraction - 1.2816 * spread.rmse * widen
    high = extraction + 1.2816 * spread.rmse * widen
  }

  const calModel = calibrationMean(model._calibration)
  const size = calModel && grindIndex !== null ? settingToSize(calModel, grindIndex) : null

  return {
    extraction,
    low,
    high,
    interval,
    intervalReduced,
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

// ---- grind target -----------------------------------------------------------

export const GREAT_MIN_SHOTS = 3

const isGreatItem = (x) => (
  x.rated !== false
  && isNum(x.extraction)
  && Math.max(0, Math.min(2, Math.round(Number(x.rating) || 0))) === 2
)

/** Target from shot-like items ({ coffee: key, extraction, rating, rated }); shared by targetFor and the replay. */
function targetFromItems(items, coffee, mode) {
  if (mode !== 'best') return { target: LIMITS.TARGET, source: 'fixed', n: 0 }
  const great = items.filter(isGreatItem)
  const mine = hasCoffee(coffee) ? great.filter((x) => x.coffee === coffee) : []
  if (mine.length >= GREAT_MIN_SHOTS) {
    return { target: meanOf(mine.map((x) => x.extraction)), source: 'coffee', n: mine.length }
  }
  if (great.length >= GREAT_MIN_SHOTS) {
    return { target: meanOf(great.map((x) => x.extraction)), source: 'all', n: great.length }
  }
  return { target: LIMITS.TARGET, source: 'fallback', n: great.length }
}

/**
 * The extraction a grind suggestion aims for. mode 'fixed' (default) is 20%. mode 'best'
 * is the mean extraction of this coffee's Great shots (needs 3), else of all Great shots
 * (needs 3), else 20%. `coffee` is a coffee key (see coffeeKey). `source` says which was used.
 */
export function targetFor(shots, coffee, mode = 'fixed') {
  if (mode !== 'best') return { target: LIMITS.TARGET, source: 'fixed', n: 0 }
  const items = (shots || []).filter(Boolean).map((s) => ({
    coffee: coffeeKey(s), extraction: numOrNull(s.extraction), rating: s.rating, rated: s.rated,
  }))
  const out = targetFromItems(items, coffee, mode)
  if (out.source === 'coffee') {
    const first = (shots || []).find((s) => s && coffeeKey(s) === coffee)
    out.coffeeLabel = first ? coffeeLabel(first) : undefined
  }
  return out
}

// ---- suggestion replay ------------------------------------------------------

const REPLAY_SPAN = 27
const FOLLOW_STEPS = 1
const DIRECTION_STEPS = 2

function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return quantile(s, 0.5)
}

function replaySummary(rows) {
  const n = rows.length
  if (!n) return { n: 0, medianAbsFromTarget: null, withinPct: null }
  const miss = rows.map((r) => Math.abs(r.extraction - r.target))
  return {
    n,
    medianAbsFromTarget: median(miss),
    withinPct: (miss.filter((m) => m <= LIMITS.WITHIN).length / n) * 100,
  }
}

/**
 * Replays every past shot: what would the grind suggestion have been using only the shots
 * before it? The inputs the full model selected stay fixed (`features` overrides them);
 * only the ridge is refitted on each prefix, so this is fast. A shot "followed" the
 * suggestion when its setting was within one step of it.
 */
export function replaySuggestions(shots, { calibration = null, mode = 'fixed', features = null } = {}) {
  const empty = {
    followed: replaySummary([]),
    notFollowed: replaySummary([]),
    direction: { agree: 0, total: 0 },
    evaluated: 0,
    enough: false,
    rows: [],
  }
  const model = buildForecastModel(shots, { calibration })
  if (!model.available) return empty
  const selected = featureKey(features || model.selected)
  if (!selected.includes('grind')) return empty
  const rows = model._btRows
  const out = []
  for (let i = LIMITS.BACKTEST_MIN_TRAIN; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.grindIndex === null) continue
    const train = rows.slice(0, i)
    const mid = Math.round(row.grindIndex)
    const { used, rowsOk } = resolveUsed(train, selected, row)
    if (!used.includes('grind')) continue
    const fit = fitModel(rowsOk, used, row.coffee)
    if (!fit.used.includes('grind')) continue
    const tgt = targetFromItems(train, row.coffee, mode)
    let best = null
    for (let index = Math.max(0, mid - REPLAY_SPAN); index <= Math.min(MAX_INDEX, mid + REPLAY_SPAN); index += 1) {
      const pred = predictFit(fit, { ...row, grind: index, grindIndex: index })
      const dist = Math.abs(pred - tgt.target)
      if (best === null || dist < best.dist - 1e-12
        || (Math.abs(dist - best.dist) <= 1e-12 && Math.abs(index - mid) < Math.abs(best.index - mid))) {
        best = { dist, index, pred }
      }
    }
    if (!best) continue
    const step = row.grindIndex - best.index
    out.push({
      id: row.id,
      order: row.order,
      extraction: row.extraction,
      target: tgt.target,
      targetSource: tgt.source,
      actualIndex: row.grindIndex,
      suggestedIndex: best.index,
      suggestedExtraction: best.pred,
      followed: Math.abs(step) <= FOLLOW_STEPS,
      // Positive when the shot was ground finer than suggested.
      stepsFiner: -step,
    })
  }
  const followed = out.filter((r) => r.followed)
  const notFollowed = out.filter((r) => !r.followed)
  const moved = out.filter((r) => Math.abs(r.stepsFiner) >= DIRECTION_STEPS)
  // Finer grinding should raise extraction, coarser should lower it, against what the
  // prefix model expected at the suggested setting.
  const agreeing = (r) => (r.stepsFiner > 0 ? r.extraction > r.suggestedExtraction : r.extraction < r.suggestedExtraction)
  const finer = moved.filter((r) => r.stepsFiner > 0)
  const coarser = moved.filter((r) => r.stepsFiner < 0)
  return {
    followed: replaySummary(followed),
    notFollowed: replaySummary(notFollowed),
    direction: {
      agree: moved.filter(agreeing).length,
      total: moved.length,
      finer: { agree: finer.filter(agreeing).length, total: finer.length },
      coarser: { agree: coarser.filter(agreeing).length, total: coarser.length },
    },
    evaluated: out.length,
    enough: followed.length >= 5,
    rows: out,
  }
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
