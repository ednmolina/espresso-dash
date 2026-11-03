// Grind setting <-> particle size calibration. Pure: no React, no Firebase.
//
// A "setting" is the Baratza Sette 270 style label: macro 1..31 + micro A..I
// (optionally ".5"). It maps to a linear index 0..278. Particle size grows
// roughly exponentially with the index, so we fit ln(um) = a + b*index with a
// Huber-robust, weighted regression and report a likely range from the scatter.

export const MAX_INDEX = 278 // 31*9-1
const MICROS = 'ABCDEFGHI'
const SETTING_RE = /^\s*(\d{1,2})\s*([A-Ia-i])(\.5)?\s*$/

/** '10e' -> {macro, micro, microIndex, half, label, index, score} | null. */
export function parseSetting(text) {
  if (text === null || text === undefined) return null
  const match = SETTING_RE.exec(String(text))
  if (!match) return null
  const macro = Number(match[1])
  if (macro < 1 || macro > 31) return null
  const micro = match[2].toUpperCase()
  const microIndex = MICROS.indexOf(micro)
  const half = Boolean(match[3])
  const halfValue = half ? 0.5 : 0
  return {
    macro,
    micro,
    microIndex,
    half,
    label: `${macro}${micro}${half ? '.5' : ''}`,
    index: (macro - 1) * 9 + microIndex + halfValue,
    score: macro * 10 + microIndex + halfValue,
  }
}

export function settingToIndex(text) {
  const parsed = parseSetting(text)
  return parsed ? parsed.index : null
}

export function indexToSetting(index) {
  const safe = Math.min(MAX_INDEX, Math.max(0, Math.round(Number.isFinite(index) ? index : 0)))
  const macro = Math.floor(safe / 9) + 1
  return `${macro}${MICROS[safe % 9]}`
}

// Legacy 10*macro + micro score, behaviour identical to the old dashboardData versions.
export function grindSettingToScore(value) {
  const text = (value === null || value === undefined ? '' : String(value)).trim().toUpperCase()
  const match = text.match(/^(\d{1,2})([A-I])(?:\.5)?$/)
  if (!match) return null
  const macro = Number(match[1])
  const micro = MICROS.indexOf(match[2])
  const half = text.endsWith('.5') ? 0.5 : 0
  return macro * 10 + micro + half
}

export function scoreToGrindSetting(score) {
  const safe = Math.max(10, Math.round(score))
  const macro = Math.min(31, Math.max(1, Math.floor(safe / 10)))
  const microIndex = Math.min(MICROS.length - 1, Math.max(0, safe - macro * 10))
  return `${macro}${MICROS[microIndex]}`
}

/** Average grind text/number -> micrometres. 0.05-5 is assumed to be mm. */
export function parseGrindUm(avgGrind) {
  if (avgGrind === null || avgGrind === undefined) return null
  let value
  if (typeof avgGrind === 'number') {
    value = avgGrind
  } else {
    const text = String(avgGrind).trim().replace(/\s*[µμu]m\s*$/i, '').trim()
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null
    value = Number(text)
  }
  if (!Number.isFinite(value)) return null
  if (value >= 50 && value <= 3000) return { um: value, assumedMm: false }
  if (value >= 0.05 && value < 5) return { um: value * 1000, assumedMm: true }
  return null
}

function coffeeText(item) {
  return [item?.roaster, item?.region, item?.variety].filter(Boolean).join(' · ')
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)

export function buildCalibrationPoints(shots, runs, { excludedShotIds = [] } = {}) {
  const excludedShots = new Set(excludedShotIds || [])
  const points = []

  ;(shots || []).forEach((shot) => {
    if (!shot) return
    const grind = parseGrindUm(shot.avgGrind)
    const setting = parseSetting(shot.grindSetting)
    if (!grind || !setting) return
    points.push({
      id: `shot:${shot.id}`,
      x: setting.index,
      setting: setting.label,
      um: grind.um,
      metric: 'mean',
      source: 'shot',
      weight: 0.5,
      date: shot.date ?? null,
      coffee: coffeeText(shot) || null,
      excluded: excludedShots.has(shot.id),
    })
  })

  ;(runs || []).forEach((run) => {
    if (!run) return
    const setting = parseSetting(run.grindSetting)
    if (!setting) return
    const base = {
      x: setting.index,
      setting: setting.label,
      source: 'photo',
      weight: 1,
      date: run.createdAt ? String(run.createdAt).slice(0, 10) : null,
      coffee: run.coffee ?? null,
      excluded: Boolean(run.excluded),
      ...(run.separated === true ? { separated: true } : {}),
    }
    if (isFiniteNum(run.mean_um) && run.mean_um > 0) {
      points.push({ ...base, id: `run:${run.id}:mean`, um: run.mean_um, metric: 'mean' })
    }
    if (isFiniteNum(run.dv50_um) && run.dv50_um > 0) {
      points.push({ ...base, id: `run:${run.id}:dv50`, um: run.dv50_um, metric: 'dv50' })
    }
  })

  return points
}

// ---- robust fitting helpers -------------------------------------------------

function weightedMedian(values, weights) {
  const pairs = values.map((v, i) => [v, weights[i]]).sort((p, q) => p[0] - q[0])
  const total = pairs.reduce((s, p) => s + p[1], 0)
  if (!pairs.length || !(total > 0)) return null
  let cum = 0
  for (let i = 0; i < pairs.length; i += 1) {
    cum += pairs[i][1]
    if (cum >= total / 2 - 1e-12) {
      if (Math.abs(cum - total / 2) < 1e-12 && i + 1 < pairs.length) {
        return (pairs[i][0] + pairs[i + 1][0]) / 2
      }
      return pairs[i][0]
    }
  }
  return pairs[pairs.length - 1][0]
}

function weightedMad(residuals, weights) {
  const med = weightedMedian(residuals, weights)
  if (med === null) return 0
  return weightedMedian(residuals.map((r) => Math.abs(r - med)), weights) ?? 0
}

function wls(xs, ys, ws) {
  let sw = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < xs.length; i += 1) {
    sw += ws[i]
    sx += ws[i] * xs[i]
    sy += ws[i] * ys[i]
  }
  const mx = sx / sw
  const my = sy / sw
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < xs.length; i += 1) {
    sxx += ws[i] * (xs[i] - mx) ** 2
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my)
  }
  const b = sxx > 0 ? sxy / sxx : 0
  return { a: my - b * mx, b }
}

function huberFit(xs, ys, ws) {
  let { a, b } = wls(xs, ys, ws)
  for (let iter = 0; iter < 50; iter += 1) {
    const res = xs.map((x, i) => ys[i] - a - b * x)
    const s = Math.max(0.02, 1.4826 * weightedMad(res, ws))
    const delta = 1.345 * s
    const rw = ws.map((w, i) => w * Math.min(1, delta / Math.max(Math.abs(res[i]), 1e-12)))
    const next = wls(xs, ys, rw)
    const change = Math.abs(next.a - a) + Math.abs(next.b - b)
    a = next.a
    b = next.b
    if (change < 1e-9) break
  }
  return { a, b }
}

function huberLocation(values, ws) {
  let mu = weightedMedian(values, ws) ?? 0
  for (let iter = 0; iter < 50; iter += 1) {
    const res = values.map((v) => v - mu)
    const s = Math.max(0.02, 1.4826 * weightedMad(res, ws))
    const delta = 1.345 * s
    const rw = ws.map((w, i) => w * Math.min(1, delta / Math.max(Math.abs(res[i]), 1e-12)))
    const total = rw.reduce((sum, w) => sum + w, 0)
    const next = values.reduce((sum, v, i) => sum + rw[i] * v, 0) / total
    const change = Math.abs(next - mu)
    mu = next
    if (change < 1e-9) break
  }
  return mu
}

function emptyModel(metric) {
  return {
    ok: false,
    kind: 'none',
    metric,
    n: 0,
    nPhoto: 0,
    nShot: 0,
    a: null,
    b: null,
    sigma: null,
    scatterPct: null,
    xMin: null,
    xMax: null,
    xMean: null,
    sxx: null,
    rangeFrom: null,
    rangeTo: null,
    constrained: false,
    outlierIds: [],
    medianUm: null,
  }
}

export function fitCalibration(points, { metric = 'mean' } = {}) {
  const active = (points || []).filter((p) => p.metric === metric && !p.excluded
    && isFiniteNum(p.x) && isFiniteNum(p.um) && p.um > 0)
  const model = emptyModel(metric)
  const n = active.length
  if (n === 0) return model

  model.n = n
  model.nPhoto = active.filter((p) => p.source === 'photo').length
  model.nShot = active.filter((p) => p.source === 'shot').length
  const xs = active.map((p) => p.x)
  const ws = active.map((p) => p.weight ?? 1)
  model.xMin = Math.min(...xs)
  model.xMax = Math.max(...xs)
  model.rangeFrom = indexToSetting(model.xMin)
  model.rangeTo = indexToSetting(model.xMax)
  model.medianUm = weightedMedian(active.map((p) => p.um), ws)

  const distinct = new Set(xs).size
  if (n < 3 || distinct < 2) {
    model.kind = 'median'
    return model
  }

  const ys = active.map((p) => Math.log(p.um))
  let { a, b } = huberFit(xs, ys, ws)
  if (b < 1e-4) {
    b = 1e-4
    a = huberLocation(ys.map((y, i) => y - b * xs[i]), ws)
    model.constrained = true
  }

  const res = xs.map((x, i) => ys[i] - a - b * x)
  const mad = 1.4826 * weightedMad(res, ws)
  const s = Math.max(0.02, mad)
  const sigma = Math.max(0.01, mad)
  const xMean = xs.reduce((sum, x) => sum + x, 0) / n
  const sxx = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0)

  model.ok = true
  model.kind = 'curve'
  model.a = a
  model.b = b
  model.sigma = sigma
  model.scatterPct = (Math.exp(sigma) - 1) * 100
  model.xMean = xMean
  model.sxx = sxx
  model.outlierIds = active.filter((_, i) => Math.abs(res[i]) > 2.5 * s).map((p) => p.id)
  return model
}

export function settingToSize(model, setting) {
  if (!model || model.kind === 'none') return null
  const x = typeof setting === 'number' ? setting : settingToIndex(setting)
  if (!isFiniteNum(x)) return null

  if (model.kind === 'median') {
    return { um: model.medianUm, low: null, high: null, extrapolated: false, kind: 'median' }
  }

  const d = x < model.xMin ? model.xMin - x : (x > model.xMax ? x - model.xMax : 0)
  let half = 1.645 * model.sigma * Math.sqrt(1 + 1 / model.n + (x - model.xMean) ** 2 / model.sxx)
  half *= 1 + (0.5 * d) / 9
  const center = model.a + model.b * x
  return {
    um: Math.exp(center),
    low: Math.exp(center - half),
    high: Math.exp(center + half),
    extrapolated: d > 0,
    kind: 'curve',
  }
}

export function sizeToSetting(model, um) {
  if (!model || model.kind !== 'curve' || !isFiniteNum(um) || um <= 0) return null
  const raw = (Math.log(um) - model.a) / model.b
  const index = Math.min(MAX_INDEX, Math.max(0, Math.round(raw)))
  const setting = indexToSetting(index)
  return {
    setting,
    index,
    score: grindSettingToScore(setting),
    extrapolated: raw < model.xMin - 1e-6 || raw > model.xMax + 1e-6,
  }
}

export function buildCalibration(shots, runs, excludedShotIds) {
  const points = buildCalibrationPoints(shots, runs, { excludedShotIds })
  const mean = fitCalibration(points, { metric: 'mean' })
  const dv50Active = points.filter((p) => p.metric === 'dv50' && p.source === 'photo' && !p.excluded)
  const dv50 = dv50Active.length >= 3 ? fitCalibration(points, { metric: 'dv50' }) : null
  return { points, mean, dv50 }
}
