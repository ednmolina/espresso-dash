// Histogram series and stats responses (port of cloudrun/main.py /histogram and
// /histogram/compare, plus plotting._build_bins). No PNG is produced here: the browser draws
// the chart from `series`.
import { npSum, histogramEdges, linspace, logspace10, finiteOrNull, log10Accurate } from './np.js'
import { filterDatasetByClusterIds } from './dataset.js'
import { distributionStats } from './stats.js'
import { metricValues, metricWeights, filterByMinDiameter, commonMinDiameterUm } from './summary.js'

const DEFAULT_LOG_BIN_SIZE = 0.05
const DEFAULT_LINEAR_BIN_SIZE = 0.1

function httpError(status, detail) {
  const err = new Error(detail)
  err.status = status
  return err
}

/** plotting._build_bins: log- or linear-spaced bin edges (`bins` points; bins - 1 intervals). */
export function buildBins(xmin, xmax, xLog, bins) {
  let n = bins
  if (n == null) {
    if (xLog) {
      const span = log10Accurate(xmax) - log10Accurate(xmin)
      n = Math.max(Math.ceil(span / DEFAULT_LOG_BIN_SIZE), 10)
    } else {
      n = Math.max(Math.ceil((xmax - xmin) / DEFAULT_LINEAR_BIN_SIZE), 10)
    }
  }
  const edges = xLog
    ? logspace10(log10Accurate(xmin), log10Accurate(xmax), n)
    : linspace(xmin, xmax, n)
  // 10**log10(x) can round slightly away from x (engine dependent), leaving the smallest/largest
  // value outside every bin. Pin the end edges to the exact range (mirrors plotting._build_bins).
  if (n > 0) edges[0] = xmin
  if (n > 1) edges[n - 1] = xmax
  return edges
}

/** main._value_range: [xmin, xmax] over all runs (NaNs ignored). */
export function valueRange(valuesList, metric) {
  let xmin = Infinity
  let xmax = -Infinity
  for (const values of valuesList) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (v < xmin) xmin = v
      if (v > xmax) xmax = v
    }
  }
  if (metric === 'extraction_yield') {
    xmin = Math.min(xmin, 20.0)
    xmax = Math.max(xmax, 30.0)
  }
  if (xmax <= xmin) { // single particle / identical sizes
    xmin = xmin * 0.95
    xmax = xmax * 1.05 + 1e-9
  }
  return [xmin, xmax]
}

/** main._unit_for_metric: { scale, unit, latex_unit, axis_label } chosen from the data range. */
export function unitForMetric(metric, values) {
  let maxVal = 0
  for (let i = 0; i < values.length; i++) {
    const a = Math.abs(values[i])
    if (a > maxVal || Number.isNaN(a)) maxVal = a
  }
  if (metric === 'diameter') {
    if (maxVal >= 1.0) return { scale: 1.0, unit: 'mm', latex_unit: '\\mathrm{mm}', axis_label: 'Particle Diameter (mm)' }
    if (maxVal >= 1e-3) return { scale: 1e3, unit: '$\\mu$m', latex_unit: '\\mu\\mathrm{m}', axis_label: 'Particle Diameter ($\\mu$m)' }
    return { scale: 1e6, unit: 'nm', latex_unit: '\\mathrm{nm}', axis_label: 'Particle Diameter (nm)' }
  }
  if (metric === 'surface') {
    if (maxVal >= 1.0) return { scale: 1.0, unit: 'mm²', latex_unit: '\\mathrm{mm}^2', axis_label: 'Particle Surface (mm²)' }
    return { scale: 1e6, unit: '$\\mu$m²', latex_unit: '\\mu\\mathrm{m}^2', axis_label: 'Particle Surface ($\\mu$m²)' }
  }
  if (metric === 'volume') {
    if (maxVal >= 1.0) return { scale: 1.0, unit: 'mm³', latex_unit: '\\mathrm{mm}^3', axis_label: 'Particle Volume (mm³)' }
    return { scale: 1e9, unit: '$\\mu$m³', latex_unit: '\\mu\\mathrm{m}^3', axis_label: 'Particle Volume ($\\mu$m³)' }
  }
  // extraction_yield - already in %
  return { scale: 1.0, unit: '%', latex_unit: '\\%', axis_label: 'Extraction Yield (%)' }
}

function nansumOf(a) {
  const c = Float64Array.from(a, v => (Number.isNaN(v) ? 0 : v))
  return npSum(c)
}

/**
 * main._histogram_series: bin edges and per-run weight fractions.
 * `s` = { x_metric, weight_mode, x_log, bins }. Returns { edges, series: [{label, fractions}], x_log }.
 */
export function histogramSeries(dsList, s) {
  const values = dsList.map(ds => metricValues(ds, s.x_metric))
  const weights = dsList.map(ds => metricWeights(ds, s.weight_mode))
  const [xmin, xmax] = valueRange(values, s.x_metric)
  const edges = buildBins(xmin, xmax, s.x_log, s.bins ?? null)
  const series = dsList.map((ds, k) => {
    const w = weights[k]
    const total = nansumOf(w)
    let ww = w
    if (total !== 0) {
      ww = new Float64Array(w.length)
      for (let i = 0; i < w.length; i++) ww[i] = w[i] / total
    }
    const counts = histogramEdges(values[k], ww, edges)
    return { label: ds.label, fractions: Array.from(counts) }
  })
  return { edges: Array.from(edges), series, x_log: s.x_log }
}

function minDiameterFilter(ds, cutoffUm) {
  if (!cutoffUm || ds.n === 0 || ds.pixel_scale == null) return ds
  return filterByMinDiameter(ds, ds.pixel_scale, cutoffUm)
}

const storedMinDiameter = stored => (stored.dataset.meta || {}).min_diameter_um

function requestSettings(req) {
  return {
    x_metric: req.x_metric ?? 'diameter',
    weight_mode: req.weight_mode ?? 'number',
    x_log: req.x_log ?? true,
    bins: req.bins ?? null,
  }
}

/**
 * POST /histogram. `stored` = StoredResult { dataset, shape, background_median, analysis_scale, min_surface }.
 * req: { x_metric, weight_mode, x_log, bins, include_png, min_diameter_um, removed_cluster_ids }.
 * `histogram_b64` is always null here (the browser draws the chart from `series`).
 */
export function histogramFromStored(stored, req = {}) {
  const s = requestSettings(req)
  let dataset = filterDatasetByClusterIds(stored.dataset, req.removed_cluster_ids ?? [])
  if (dataset.n === 0 || dataset.pixel_scale == null) throw httpError(400, 'No particles or no pixel scale set.')
  const cutoff = req.min_diameter_um != null ? req.min_diameter_um : storedMinDiameter(stored)
  dataset = minDiameterFilter(dataset, cutoff)
  if (dataset.n === 0) throw httpError(400, 'No particles above the minimum diameter.')

  const values = metricValues(dataset, s.x_metric)
  const weights = metricWeights(dataset, s.weight_mode)
  const { scale, unit, axis_label } = unitForMetric(s.x_metric, values)
  const stats = distributionStats(values, weights)
  return finiteOrNull({
    histogram_b64: null,
    series: histogramSeries([dataset], s),
    unit,
    scale,
    axis_label,
    ...stats,
  })
}

function meanOf(a) {
  return npSum(Float64Array.from(a)) / a.length
}

/**
 * POST /histogram/compare. `storedList[k]` is the StoredResult of `req.runs[k]`
 * (runs: [{ image_id, removed_cluster_ids, label }]).
 */
export function compareFromStored(storedList, req = {}) {
  const s = requestSettings(req)
  const runs = req.runs || []
  // Common size cutoff so runs are compared above the coarsest detection limit.
  let cutoff = null
  if (storedList.length > 1) {
    cutoff = commonMinDiameterUm(storedList.map(r => r.dataset), storedList.map(r => r.dataset.pixel_scale))
  }
  let explicit = req.min_diameter_um
  if (explicit == null) {
    let best = 0.0
    for (const r of storedList) {
      const m = storedMinDiameter(r)
      if (m && m > best) best = m
    }
    explicit = best
  }
  if (explicit) cutoff = Math.max(cutoff || 0.0, explicit)

  const datasets = []
  storedList.forEach((result, k) => {
    const run = runs[k] || {}
    let ds = filterDatasetByClusterIds(result.dataset, run.removed_cluster_ids ?? [])
    if (ds.n === 0 || ds.pixel_scale == null) throw httpError(400, `Run '${run.label ?? ''}' has no particles or no scale.`)
    ds = minDiameterFilter(ds, cutoff)
    if (ds.n === 0) throw httpError(400, `Run '${run.label ?? ''}' has no particles above the minimum diameter.`)
    datasets.push({ ...ds, label: run.label || `Run ${datasets.length + 1}` })
  })

  const first = metricValues(datasets[0], s.x_metric)
  const { scale, unit, axis_label } = unitForMetric(s.x_metric, first)
  const perRun = datasets.map(ds => ({
    label: ds.label,
    ...distributionStats(metricValues(ds, s.x_metric), metricWeights(ds, s.weight_mode)),
  }))

  const allMeans = perRun.map(r => r.mean)
  const allMedians = perRun.map(r => r.median)
  const meanOfMeans = meanOf(allMeans)
  const sq = Float64Array.from(allMeans, v => (v - meanOfMeans) * (v - meanOfMeans))
  const sortedMed = Float64Array.from(allMedians).sort()
  const h = sortedMed.length >> 1
  const combined = {
    mean_of_means: meanOfMeans,
    median_of_medians: sortedMed.length % 2 === 1 ? sortedMed[h] : (sortedMed[h - 1] + sortedMed[h]) / 2,
    std_of_means: Math.sqrt(npSum(sq) / allMeans.length),
  }

  return finiteOrNull({
    histogram_b64: null,
    series: histogramSeries(datasets, s),
    unit,
    scale,
    axis_label,
    per_run: perRun,
    combined,
    min_diameter_um_applied: cutoff,
  })
}
