// Metric values/weights and dataset summary (port of analysis.py summary functions and the
// main.py helpers _summary_or_none / _particles_payload).
import { npSum, finiteOrNull, sig6 } from './np.js'
import { selectDataset } from './dataset.js'
import {
  weightedPercentiles, bootstrapPercentileCi, detectionLimitUm, reliableLimitUm, geometricStats,
  volumeMode, scaleRelativeUncertainty, FINES_RELIABLE_LIMIT_UM,
} from './stats.js'

export const COFFEE_CELL_SIZE_MICRONS = 20.0
export const FINES_DIAMETER_MM = 0.1
export const MODEL_NOTES = [
  'Extraction yield, efficiency and surface quality come from an uncalibrated model '
  + '(Gagne heuristic), not from measurements.',
]

function valueError(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

function resolveScale(ds, scale, what) {
  const s = scale != null ? scale : ds.pixel_scale
  if (s == null || s <= 0) throw valueError(`A positive pixel scale in pixels/mm is required ${what}.`)
  return Number(s)
}

function datasetMinSurface(ds) {
  const v = (ds.meta || {}).min_surface
  if (v != null) return Number(v)
  if (ds.n === 0) return 0.0
  let m = Infinity
  for (let i = 0; i < ds.n; i++) if (ds.surface[i] < m) m = ds.surface[i]
  return m
}

// np.nansum: NaNs count as 0, then the usual pairwise sum
function nansum(a) {
  let has = false
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) { has = true; break }
  }
  if (!has) return npSum(a)
  const c = Float64Array.from(a, v => (Number.isNaN(v) ? 0 : v))
  return npSum(c)
}

/** Volume (mm^3) that is not reachable by extraction (outer 0.1 mm shell only). */
export function attainableMass(volumes) {
  const depthLimit = 0.1
  const n = volumes.length
  const out = new Float64Array(n)
  const fourThirdsPi = (4.0 / 3.0) * Math.PI
  for (let i = 0; i < n; i++) {
    const v = volumes[i]
    const radius = Math.pow((3.0 * v) / (4.0 * Math.PI), 1.0 / 3.0)
    let unreachable = 0
    if (radius > depthLimit) unreachable = fourThirdsPi * Math.pow(radius - depthLimit, 3)
    out[i] = v - unreachable
  }
  return out
}

/** Heuristic extraction yield (fraction) from particle surface in mm^2. */
export function extractionYield(surfaces) {
  const kReference = 0.25014
  const extractionLimit = 0.3
  const n = surfaces.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const speed = 1.0 / surfaces[i]
    out[i] = (speed / (kReference + speed)) * extractionLimit
  }
  return out
}

function diametersMm(ds, scale) {
  const out = new Float64Array(ds.n)
  for (let i = 0; i < ds.n; i++) out[i] = (2.0 * Math.sqrt(ds.long_axis[i] * ds.short_axis[i])) / scale
  return out
}

function surfacesMm2(ds, scale) {
  const s2 = scale * scale
  const out = new Float64Array(ds.n)
  for (let i = 0; i < ds.n; i++) out[i] = ds.surface[i] / s2
  return out
}

function volumesMm3(ds, scale) {
  const s3 = Math.pow(scale, 3)
  const out = new Float64Array(ds.n)
  for (let i = 0; i < ds.n; i++) out[i] = ds.volume[i] / s3
  return out
}

/** Values of a histogram metric ('diameter' | 'surface' | 'volume' | 'extraction_yield'). */
export function metricValues(ds, metric, scale) {
  const s = scale != null ? scale : ds.pixel_scale
  if (s == null || s <= 0) throw valueError('A positive pixel scale in pixels/mm is required for physical metrics.')
  if (metric === 'diameter') return diametersMm(ds, s)
  if (metric === 'surface') return surfacesMm2(ds, s)
  if (metric === 'volume') return volumesMm3(ds, s)
  if (metric === 'extraction_yield') {
    const ey = extractionYield(surfacesMm2(ds, s))
    for (let i = 0; i < ey.length; i++) ey[i] *= 100.0
    return ey
  }
  throw valueError(`Unsupported histogram metric: ${metric}`)
}

/** Weights of a histogram weight mode ('number' | 'surface' | 'mass' | 'available_mass' | 'extracted_mass'). */
export function metricWeights(ds, mode, scale) {
  const s = scale != null ? scale : ds.pixel_scale
  if (s == null || s <= 0) throw valueError('A positive pixel scale in pixels/mm is required for weighted histograms.')
  const n = ds.n
  const edge = ds.edge_weight
  const out = new Float64Array(n)
  if (mode === 'number') {
    out.set(edge)
  } else if (mode === 'surface') {
    for (let i = 0; i < n; i++) out[i] = ds.surface[i] * edge[i]
  } else if (mode === 'mass') {
    const d = diametersMm(ds, s)
    for (let i = 0; i < n; i++) out[i] = ((Math.PI / 6.0) * Math.pow(d[i], 3)) * edge[i]
  } else if (mode === 'available_mass') {
    const reach = attainableMass(volumesMm3(ds, s))
    for (let i = 0; i < n; i++) out[i] = reach[i] * edge[i]
  } else if (mode === 'extracted_mass') {
    const reach = attainableMass(volumesMm3(ds, s))
    const yieldPct = extractionYield(surfacesMm2(ds, s))
    for (let i = 0; i < n; i++) out[i] = (reach[i] * (yieldPct[i] * 100.0)) * edge[i]
  } else {
    throw valueError(`Unsupported histogram weight mode: ${mode}`)
  }
  return out
}

/** Dataset without particles whose area-equivalent diameter is below `minUm` micrometres. */
export function filterByMinDiameter(ds, scale, minUm) {
  if (minUm == null || minUm <= 0 || ds.n === 0) return ds
  const s = resolveScale(ds, scale, 'to apply a minimum diameter')
  const keep = []
  const m = Number(minUm)
  for (let i = 0; i < ds.n; i++) {
    if ((2000.0 * Math.sqrt(ds.long_axis[i] * ds.short_axis[i])) / s >= m) keep.push(i)
  }
  return selectDataset(ds, keep)
}

/** Common size cutoff for comparing runs: the largest detection limit (or explicit minimum), in um. */
export function commonMinDiameterUm(dsList, scales) {
  let best = 0.0
  dsList.forEach((ds, i) => {
    const s = resolveScale(ds, scales ? scales[i] : null, 'to compare runs')
    best = Math.max(best, detectionLimitUm(datasetMinSurface(ds), s))
    const explicit = (ds.meta || {}).min_diameter_um
    if (explicit) best = Math.max(best, Number(explicit))
  })
  return best
}

// analysis._weighted_stddev(frequency=True, unbiased=True)
function weightedStddev(data, weights) {
  const n = data.length
  const sumW = nansum(weights)
  const bias = (sumW - 1.0) / sumW
  const normalized = new Float64Array(n)
  for (let i = 0; i < n; i++) normalized[i] = weights[i] / sumW
  const tmp = new Float64Array(n)
  for (let i = 0; i < n; i++) tmp[i] = data[i] * normalized[i]
  const mean = nansum(tmp)
  for (let i = 0; i < n; i++) {
    const d = data[i] - mean
    tmp[i] = (d * d) * normalized[i]
  }
  const variance = nansum(tmp) / bias
  return Math.sqrt(Number.isNaN(variance) ? variance : Math.max(variance, 0.0))
}

const mul = (a, b) => {
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i]
  return out
}

/**
 * Summary statistics (all values JSON-safe; non-finite -> null). Size percentiles are weighted by
 * equivalent-sphere volume (and border-loss weights). opts: { min_diameter_um, min_surface,
 * reference_px_length, click_sigma_px, legacy_summary }.
 */
export function summarizeDataset(ds, scale, opts = {}) {
  const s = resolveScale(ds, scale, 'to summarize the dataset')
  if (ds.n === 0) throw valueError('No detected particles are available for summary statistics.')
  const meta = ds.meta || {}
  let minDiameterUm = opts.min_diameter_um
  if (minDiameterUm == null) minDiameterUm = meta.min_diameter_um
  let referencePxLength = opts.reference_px_length
  if (referencePxLength == null) referencePxLength = meta.reference_px_length
  let clickSigmaPx = opts.click_sigma_px
  if (clickSigmaPx == null) clickSigmaPx = meta.click_sigma_px ?? 2.0
  const legacySummary = !!opts.legacy_summary
  const minSurf = opts.min_surface != null ? Number(opts.min_surface) : datasetMinSurface(ds)

  const nTotal = ds.n
  const f = filterByMinDiameter(ds, s, minDiameterUm)
  if (f.n === 0) throw valueError('No particles remain above the minimum diameter.')
  const n = f.n

  const edgeW = f.edge_weight
  const diameters = diametersMm(f, s)
  const surfaces = surfacesMm2(f, s)
  const volumes = volumesMm3(f, s)
  const extractionYields = extractionYield(surfaces)
  const reachable = attainableMass(volumes)
  const efficiencies = new Float64Array(n)
  for (let i = 0; i < n; i++) efficiencies[i] = reachable[i] / volumes[i]

  const cellVolume = Math.pow(COFFEE_CELL_SIZE_MICRONS / 1e3, 3)
  const massWeights = new Float64Array(n)
  for (let i = 0; i < n; i++) massWeights[i] = Math.max(Math.ceil(reachable[i] / cellVolume), 1.0) * edgeW[i]
  const sumMw = npSum(massWeights)
  const diamAvg = npSum(mul(diameters, massWeights)) / sumMw
  const diamStd = weightedStddev(diameters, massWeights)

  const surfAvg = npSum(mul(surfaces, massWeights)) / sumMw
  const surfStd = weightedStddev(surfaces, massWeights)

  const extractionWeights = new Float64Array(n)
  for (let i = 0; i < n; i++) extractionWeights[i] = (extractionYields[i] * reachable[i]) * edgeW[i]
  const eyAvg = (npSum(mul(extractionYields, extractionWeights)) / npSum(extractionWeights)) * 100.0
  const eyStd = weightedStddev(extractionYields, extractionWeights) * 100.0

  const volumeWeights = new Float64Array(n)
  let efficiencyPct
  if (legacySummary) {
    for (let i = 0; i < n; i++) volumeWeights[i] = Math.max(volumes[i], 0.0) * edgeW[i]
    efficiencyPct = (npSum(efficiencies) / n) * 100.0
  } else {
    for (let i = 0; i < n; i++) volumeWeights[i] = ((Math.PI / 6.0) * Math.pow(diameters[i], 3)) * edgeW[i]
    efficiencyPct = (npSum(mul(reachable, edgeW)) / npSum(mul(volumes, edgeW))) * 100.0
  }
  const [dv10, dv50, dv90] = weightedPercentiles(diameters, volumeWeights, [10.0, 50.0, 90.0])
  const ci = bootstrapPercentileCi(diameters, volumeWeights)

  const limitUm = detectionLimitUm(minSurf, s)
  const finesMeasurable = limitUm < FINES_RELIABLE_LIMIT_UM
  let finesPct = null
  if (finesMeasurable || legacySummary) {
    const sub = []
    for (let i = 0; i < n; i++) if (diameters[i] < FINES_DIAMETER_MM) sub.push(volumeWeights[i])
    finesPct = (npSum(Float64Array.from(sub)) / npSum(volumeWeights)) * 100.0
  }

  const [gmN, gsdN] = geometricStats(diameters, edgeW)
  const [gmV, gsdV] = geometricStats(diameters, volumeWeights)
  const relUnc = scaleRelativeUncertainty(referencePxLength, Number(clickSigmaPx))
  const numberMedian = weightedPercentiles(diameters, edgeW, [50.0])[0]

  let anyEdge = false
  for (let i = 0; i < n; i++) if (edgeW[i] !== 1.0) { anyEdge = true; break }

  const summary = {
    cluster_count: n,
    diameter_number_mean_mm: npSum(mul(diameters, edgeW)) / npSum(edgeW),
    diameter_number_median_mm: numberMedian,
    dv10_mm: dv10,
    dv50_mm: dv50,
    dv90_mm: dv90,
    span: dv50 > 0 ? (dv90 - dv10) / dv50 : null,
    fines_volume_pct: finesPct,
    diameter_mean_mm: diamAvg,
    diameter_std_mm: diamStd,
    surface_mean_mm2: surfAvg,
    surface_std_mm2: surfStd,
    surface_quality: surfStd > 0 ? surfAvg / surfStd : null,
    average_extraction_yield_pct: eyAvg,
    extraction_yield_std_pct: eyStd,
    average_efficiency_pct: efficiencyPct,
    // --- measurement-model additions ---
    detection_limit_um: limitUm,
    reliable_limit_um: reliableLimitUm(s),
    fines_measurable: finesMeasurable,
    dv_ci95: { dv10: ci[0], dv50: ci[1], dv90: ci[2] },
    geometric_mean_number_mm: gmN,
    gsd_number: gsdN,
    geometric_mean_volume_mm: gmV,
    gsd_volume: gsdV,
    volume_mode_mm: volumeMode(diameters, volumeWeights),
    diameter_scale_unc_pct: relUnc == null ? null : 100.0 * relUnc,
    volume_scale_unc_pct: relUnc == null ? null : 300.0 * relUnc,
    min_diameter_um: !minDiameterUm ? null : Number(minDiameterUm),
    n_excluded_below_min: nTotal - n,
    edge_correction_applied: anyEdge,
    effective_cluster_count: npSum(edgeW),
    model_notes: [...MODEL_NOTES],
  }
  for (const key of ['threshold_percent_used', 'background_model', 'threshold_mode', 'axis_method', 'volume_model', 'split_touching']) {
    if (key in meta) summary[key] = meta[key]
  }
  return finiteOrNull(summary)
}

/** main._summary_or_none: the summary, or null when there is nothing to summarise. */
export function summaryOrNone(ds) {
  if (ds.n > 0 && ds.pixel_scale != null) {
    try {
      return finiteOrNull(summarizeDataset(ds))
    } catch (err) {
      return null
    }
  }
  return null
}

export const ASPECT_MIN_PX = 20
export const ASPECT_MIN_COUNT = 10

/**
 * Aspect-ratio statistics of the measured moment ellipses (volume-weighted like Dv).
 * Only particles of at least ASPECT_MIN_PX pixels qualify (digitisation inflates the aspect
 * ratio of smaller ones). null when the dataset is empty; the three aspect values are null
 * when fewer than ASPECT_MIN_COUNT particles qualify or the moment columns are NaN.
 * Pure; never throws.
 */
export function shapeSummaryOrNone(ds) {
  try {
    if (!ds || ds.n === 0) return null
    let scale = ds.pixel_scale
    let f
    if (typeof scale === 'number' && scale > 0) {
      f = filterByMinDiameter(ds, scale, (ds.meta || {}).min_diameter_um)
    } else {
      f = ds
      scale = 1
    }
    const ar = []
    const w = []
    for (let i = 0; i < f.n; i++) {
      const a = f.aspect_ratio[i]
      if (f.surface[i] >= ASPECT_MIN_PX && Number.isFinite(a)) {
        const d = (2.0 * Math.sqrt(f.long_axis[i] * f.short_axis[i])) / scale
        ar.push(a)
        w.push(((Math.PI / 6.0) * Math.pow(d, 3)) * f.edge_weight[i])
      }
    }
    const kept = ar.length
    let p10 = null
    let p50 = null
    let p90 = null
    if (kept >= ASPECT_MIN_COUNT) {
      ;[p10, p50, p90] = weightedPercentiles(Float64Array.from(ar), Float64Array.from(w), [10, 50, 90])
    }
    return finiteOrNull({
      aspect_ratio_median: p50,
      aspect_ratio_p10: p10,
      aspect_ratio_p90: p90,
      aspect_ratio_n: kept,
      min_px: ASPECT_MIN_PX,
    })
  } catch (err) {
    return null
  }
}

/** main._particles_payload: plain arrays, floats rounded to 6 significant digits. */
export function particlesPayload(ds) {
  return {
    id: Array.from(ds.cluster_id),
    surface: sig6(ds.surface),
    roundness: sig6(ds.roundness),
    short_axis: sig6(ds.short_axis),
    long_axis: sig6(ds.long_axis),
    volume: sig6(ds.volume),
    major_axis_measured: sig6(ds.major_axis_measured),
    minor_axis_measured: sig6(ds.minor_axis_measured),
    aspect_ratio: sig6(ds.aspect_ratio),
  }
}
