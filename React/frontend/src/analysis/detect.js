// Port of the detection half of cloudrun/coffeegrindsize_core/analysis.py:
// settings, polygon mask, background median, _detect_particles, _remeasure_clusters,
// analyze_image (on a blue channel), clusters_within_radius and the index layers.
//
// Python naming trap preserved: `xmean` is the mean ROW, `ymean` the mean COLUMN.
// Polygon points are [x=col, y=row] in analysis pixels (objects {x, y} also accepted).

import {
  detectCore, pointsAlongPolygon, polygonMask as polygonMaskKernel, outlineMaskFromClusters,
} from './kernels.js'
import { makeDataset } from './dataset.js'
import { roundHalfEven } from './np.js'
import { pow2 } from './glibcPow.js'
import { flattenBlue, halfContrastPercent } from './background.js'
import { edgeWeights } from './stats.js'
import { splitTouching, unsplitDv } from './split.js'

export const CONTRAST_CLUSTER_MIN_PIXELS = 150

// The reference implementation skipped the closing edge (last point -> first point)
// when rejecting particles cut by the analysis region border.
let CLOSE_POLYGON_EDGES = true
export function setClosePolygonEdges(value) {
  CLOSE_POLYGON_EDGES = !!value
}

const fail = (message, status = 400) => {
  const err = new Error(message)
  err.status = status
  return err
}

// ---------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = Object.freeze({
  threshold_percent: 58.8,
  // Seed percent for the poly4 flatten's dark-pixel exclusion; null = use threshold_percent.
  flatten_threshold_percent: null,
  reference_threshold: 0.4,
  max_cluster_axis: 100.0,
  min_surface: 5.0,
  min_roundness: 0.0,
  max_cost: 0.35,
  smoothing_window: 3,
  quick_mode: false,
  analysis_polygon: null,
  pixel_scale: null,
  background_model: 'poly4',
  threshold_mode: 'half_contrast',
  edge_correction: true,
  axis_method: 'max_radius',
  volume_model: 'legacy',
  min_diameter_um: null,
  reference_px_length: null,
  click_sigma_px: 2.0,
  split_touching: false,
  split_neck_ratio: 0.7,
})

const ENUMS = [
  ['background_model', ['global', 'poly4']],
  ['threshold_mode', ['fixed', 'half_contrast']],
  ['axis_method', ['max_radius', 'moments']],
  ['volume_model', ['legacy', 'spheroid', 'ellipsoid']],
]

/** AnalysisSettings(**overrides): unknown keys are ignored, undefined values keep the default. */
export function makeSettings(overrides = {}) {
  const s = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (overrides && overrides[key] !== undefined) s[key] = overrides[key]
  }
  for (const [name, allowed] of ENUMS) {
    if (!allowed.includes(s[name])) throw fail(`${name} must be one of ${allowed.join(', ')}.`)
  }
  s.split_touching = !!s.split_touching
  if (!(s.split_neck_ratio >= 0.3 && s.split_neck_ratio <= 0.95)) {
    throw fail('split_neck_ratio must be between 0.3 and 0.95.')
  }
  return s
}

/** Settings reproducing the original (e299811) behaviour exactly. */
export function legacySettings(overrides = {}) {
  return makeSettings({
    background_model: 'global',
    threshold_mode: 'fixed',
    edge_correction: false,
    axis_method: 'max_radius',
    volume_model: 'legacy',
    split_touching: false,
    ...overrides,
  })
}

// ---------------------------------------------------------------- polygon / median
function polygonCoords(points) {
  const n = points.length
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const p = points[i]
    if (Array.isArray(p) || ArrayBuffer.isView(p)) {
      xs[i] = p[0]
      ys[i] = p[1]
    } else {
      xs[i] = p.x
      ys[i] = p.y
    }
  }
  return [xs, ys]
}

/** Polygon mask (Uint8Array h*w) or null when there are no points. */
export function buildPolygonMask(shape, points) {
  if (points == null) return null
  if (points.length < 3) throw fail('An analysis polygon must contain at least three points.')
  const [rows, cols] = shape
  const [xs, ys] = polygonCoords(points)
  return polygonMaskKernel(rows, cols, xs, ys)
}

/** Boolean image marking thresholded pixels (rows[i], cols[i], i < n) on the polygon border. */
export function polygonEdgeGrid(shape, rows, cols, n, points) {
  if (points == null) return null
  const [h, w] = shape
  const polygon = Array.from(points, (p) => (Array.isArray(p) || ArrayBuffer.isView(p) ? [p[0], p[1]] : [p.x, p.y]))
  if (CLOSE_POLYGON_EDGES && polygon.length >= 3) {
    const a = polygon[0]
    const b = polygon[polygon.length - 1]
    if (!(a[0] === b[0] && a[1] === b[1])) polygon.push(a)
  }
  const xp = new Float64Array(polygon.length)
  const yp = new Float64Array(polygon.length)
  for (let i = 0; i < polygon.length; i++) {
    xp[i] = polygon[i][0]
    yp[i] = polygon[i][1]
  }
  const triggered = pointsAlongPolygon(cols, rows, n, xp, yp)
  const grid = new Uint8Array(h * w)
  for (let i = 0; i < n; i++) if (triggered[i] !== 0) grid[rows[i] * w + cols[i]] = 1
  return grid
}

/** np.median of a uint8 array via a 256-bin histogram (`_median`); NaN when empty. */
export function medianU8(values, n = values.length) {
  if (n === 0) return NaN
  const counts = new Int32Array(256)
  for (let i = 0; i < n; i++) counts[values[i]]++
  return medianFromCounts(counts, n)
}

function medianFromCounts(counts, n) {
  const lowTarget = Math.floor((n - 1) / 2) + 1
  const highTarget = Math.floor(n / 2) + 1
  let cum = 0
  let low = -1
  let high = -1
  for (let v = 0; v < 256; v++) {
    cum += counts[v]
    if (low < 0 && cum >= lowTarget) low = v
    if (high < 0 && cum >= highTarget) {
      high = v
      break
    }
  }
  return (low + high) / 2.0
}

/** Median of blue (whole image, or only pixels where polygonMask = 1). */
export function backgroundMedian(blue, polygonMask = null) {
  if (polygonMask == null) return medianU8(blue, blue.length)
  const counts = new Int32Array(256)
  let n = 0
  for (let i = 0; i < blue.length; i++) {
    if (polygonMask[i] !== 0) {
      counts[blue[i]]++
      n++
    }
  }
  if (n === 0) throw fail('The selected analysis polygon does not contain any image pixels.')
  return medianFromCounts(counts, n)
}

// ---------------------------------------------------------------- detection
let indexGridBuf = new Int32Array(0)

function indexGridFor(size) {
  if (indexGridBuf.length < size) {
    indexGridBuf = new Int32Array(Math.max(size, 1))
    indexGridBuf.fill(-1)
  }
  return indexGridBuf
}

/** Free the module-level index grid (up to 4 bytes per image pixel) once analysis is done. */
export function releaseDetectBuffers() {
  indexGridBuf = new Int32Array(0)
}

function emptyDataset(settings, meta = {}) {
  return makeDataset({ n: 0 }, { pixel_scale: settings.pixel_scale, label: 'Current Data', meta })
}

/**
 * Grow, break up and measure particles (`_detect_particles`). `blue` is the uint8 channel
 * (flattened or original); `thresholdMask` a Uint8Array h*w. `onProgress(fraction)` optional.
 */
export function detectParticles(blue, h, w, thresholdMask, bgMedian, settings, polygonMask, onProgress) {
  const size = h * w
  // pass 1: histogram of blue values over thresholded pixels
  const counts = new Int32Array(256)
  let total = 0
  for (let i = 0; i < size; i++) {
    if (thresholdMask[i] !== 0) {
      counts[blue[i]]++
      total++
    }
  }
  if (total === 0) return emptyDataset(settings)
  if (!settings.quick_mode && !(settings.reference_threshold >= 0)) throw fail('reference_threshold must be >= 0.')

  // pass 2: stable counting sort by blue value (== np.argsort(kind="stable")), row-major ties
  const start = new Int32Array(256)
  let acc = 0
  for (let v = 0; v < 256; v++) {
    start[v] = acc
    acc += counts[v]
  }
  const rowPos = new Int32Array(total)
  const colPos = new Int32Array(total)
  const blueSorted = new Uint8Array(total)
  for (let r = 0, p = 0; r < h; r++) {
    for (let c = 0; c < w; c++, p++) {
      if (thresholdMask[p] !== 0) {
        const v = blue[p]
        const k = start[v]++
        rowPos[k] = r
        colPos[k] = c
        blueSorted[k] = v
      }
    }
  }

  const useEdge = polygonMask != null
  const edgeGrid = useEdge ? polygonEdgeGrid([h, w], rowPos, colPos, total, settings.analysis_polygon) : null

  const indexGrid = indexGridFor(size)
  let res
  try {
    for (let i = 0; i < total; i++) indexGrid[rowPos[i] * w + colPos[i]] = i
    res = detectCore(
      indexGrid, h, w, rowPos, colPos, blueSorted, total,
      Number(bgMedian), Number(settings.reference_threshold), Number(settings.max_cost),
      Math.trunc(settings.smoothing_window), Number(settings.max_cluster_axis), Number(settings.min_surface),
      !!settings.quick_mode, edgeGrid,
      onProgress ? (open, tot) => onProgress(tot > 0 ? open / tot : 1) : undefined,
    )
  } finally {
    for (let i = 0; i < total; i++) indexGrid[rowPos[i] * w + colPos[i]] = -1
  }

  const { ids, stats, offsets, pixRow, pixCol } = res
  const minRoundness = settings.min_roundness
  // roundness / short / volume are recomputed here exactly as Python does: `x ** 2` on a
  // Python float is libm pow(), which is not always x*x (see glibcPow.js).
  const keep = []
  const roundnessAll = new Float64Array(ids.length)
  for (let i = 0; i < ids.length; i++) {
    const surface = stats[i * 7]
    const longAxis = stats[i * 7 + 3]
    const roundness = surface === 1.0 ? 1.0 : surface / (Math.PI * pow2(longAxis))
    roundnessAll[i] = roundness
    if (roundness < minRoundness) continue
    keep.push(i)
  }
  const n = keep.length
  const cols = {
    n,
    cluster_id: new Int32Array(n),
    surface: new Float64Array(n),
    roundness: new Float64Array(n),
    short_axis: new Float64Array(n),
    long_axis: new Float64Array(n),
    volume: new Float64Array(n),
    xmean: new Float64Array(n),
    ymean: new Float64Array(n),
    px_start: new Int32Array(n),
    px_len: new Int32Array(n),
    px_row: pixRow,
    px_col: pixCol,
  }
  for (let k = 0; k < n; k++) {
    const i = keep[k]
    const o = i * 7
    const surface = stats[o]
    const longAxis = stats[o + 3]
    const shortAxis = surface / (Math.PI * longAxis)
    cols.cluster_id[k] = ids[i]
    cols.surface[k] = surface
    cols.roundness[k] = roundnessAll[i]
    cols.short_axis[k] = shortAxis
    cols.long_axis[k] = longAxis
    cols.volume[k] = (Math.PI * pow2(shortAxis)) * longAxis
    cols.xmean[k] = stats[o + 5]
    cols.ymean[k] = stats[o + 6]
    cols.px_start[k] = offsets[i]
    cols.px_len[k] = offsets[i + 1] - offsets[i]
  }
  return makeDataset(cols, { pixel_scale: settings.pixel_scale, label: 'Current Data', meta: {} })
}

/**
 * Measure every cluster's second moments and (optionally) recompute axes / roundness /
 * volume in place (surface unchanged).
 *
 * The moment fit always runs: it writes major_axis_measured / minor_axis_measured
 * (semi-axes 2*sqrt(lambda), pixel variance 1/12 included, lambda2 floored at 1/12) and
 * aspect_ratio = major / minor. The detector columns are untouched for max_radius + legacy.
 * Otherwise long_axis is the max radius (max_radius) or the measured major axis (moments);
 * short_axis stays surface / (pi * long_axis) for every axis method.
 * volume_model: 'legacy' (pi b^2 a), 'spheroid' (4/3 pi a b^2) or 'ellipsoid' (measured
 * aspect ratio, area-normalised: B = sqrt(S / (pi * AR)), V = 4/3 * S * B, thickness = width).
 */
export function remeasureClusters(ds, axisMethod, volumeModel) {
  const n = ds.n
  if (n === 0) return
  const major = new Float64Array(n)
  const minor = new Float64Array(n)
  const aspect = new Float64Array(n)
  const { px_row, px_col, px_start, px_len } = ds
  for (let k = 0; k < n; k++) {
    const s = px_start[k]
    const e = s + px_len[k]
    const cnt = px_len[k]
    if (cnt === 0) {
      major[k] = NaN
      minor[k] = NaN
      aspect[k] = NaN
      continue
    }
    let sx = 0.0
    let sy = 0.0
    for (let i = s; i < e; i++) {
      sx += px_row[i]
      sy += px_col[i]
    }
    const mx = sx / cnt
    const my = sy / cnt
    let axx = 0.0
    let ayy = 0.0
    let axy = 0.0
    for (let i = s; i < e; i++) {
      const dx = px_row[i] - mx
      const dy = px_col[i] - my
      axx += dx * dx
      ayy += dy * dy
      axy += dx * dy
    }
    const sxx = axx / cnt + 1.0 / 12.0
    const syy = ayy / cnt + 1.0 / 12.0
    const sxy = axy / cnt
    const halfTrace = 0.5 * (sxx + syy)
    const dd = sxx - syy
    const root = Math.sqrt(Math.max(0.25 * (dd * dd) + sxy * sxy, 0.0))
    const lam1 = halfTrace + root
    const lam2 = Math.max(halfTrace - root, 1.0 / 12.0)
    major[k] = 2.0 * Math.sqrt(lam1)
    minor[k] = 2.0 * Math.sqrt(lam2)
    aspect[k] = major[k] / minor[k]
  }
  ds.major_axis_measured = major
  ds.minor_axis_measured = minor
  ds.aspect_ratio = aspect
  if (axisMethod === 'max_radius' && volumeModel === 'legacy') return // default: nothing else changes
  const longAxes = axisMethod === 'moments' ? major : Float64Array.from(ds.long_axis)
  for (let k = 0; k < n; k++) {
    const longAxis = longAxes[k]
    const surface = ds.surface[k]
    ds.long_axis[k] = longAxis
    const shortAxis = surface / (Math.PI * longAxis)
    ds.short_axis[k] = shortAxis
    if (axisMethod === 'moments') {
      ds.roundness[k] = surface === 1.0 ? 1.0 : surface / (Math.PI * pow2(longAxis))
    }
    if (volumeModel === 'spheroid') {
      ds.volume[k] = (((4.0 / 3.0) * Math.PI) * longAxis) * pow2(shortAxis)
    } else if (volumeModel === 'ellipsoid') {
      const B = Math.sqrt(surface / (Math.PI * aspect[k]))
      ds.volume[k] = ((4.0 / 3.0) * surface) * B
    } else {
      ds.volume[k] = (Math.PI * pow2(shortAxis)) * longAxis
    }
  }
}

// ---------------------------------------------------------------- analyze
/** Percent that seeds the poly4 flatten: `flatten_threshold_percent` when set, else `threshold_percent`. */
export function flattenSeedPercent(settings) {
  return settings.flatten_threshold_percent ?? settings.threshold_percent
}

export function thresholdMaskFor(blue, size, bgMedian, percent, polygonMask, into) {
  const thr = bgMedian * percent / 100.0
  const mask = into || new Uint8Array(size)
  if (polygonMask) {
    for (let i = 0; i < size; i++) mask[i] = (blue[i] < thr && polygonMask[i] !== 0) ? 1 : 0
  } else {
    for (let i = 0; i < size; i++) mask[i] = blue[i] < thr ? 1 : 0
  }
  return mask
}

/**
 * Threshold mask sampled every `step` pixels in both directions (output ceil(h/step) x ceil(w/step)),
 * with exactly the rule of thresholdMaskFor. step = 1 is thresholdMaskFor.
 */
export function thresholdMaskStrided(blue, height, width, bgMedian, percent, polygonMask, step = 1) {
  if (step <= 1) return thresholdMaskFor(blue, height * width, bgMedian, percent, polygonMask, null)
  const ow = Math.ceil(width / step)
  const oh = Math.ceil(height / step)
  const thr = bgMedian * percent / 100.0
  const out = new Uint8Array(ow * oh)
  for (let r = 0; r < oh; r++) {
    const src = r * step * width
    const dst = r * ow
    for (let c = 0; c < ow; c++) {
      const i = src + c * step
      out[dst + c] = (blue[i] < thr && (!polygonMask || polygonMask[i] !== 0)) ? 1 : 0
    }
  }
  return out
}

/**
 * `analyze_image` on an already-decoded blue channel (Uint8Array h*w).
 * `onProgress(phase, fraction)` with phase in 'flatten' | 'prelim' | 'detect' | 'measure'.
 * Returns { blue (flattened or original), threshold_mask, polygon_mask|null, background_median,
 *           threshold_percent_used, model_info, flatten_info, dataset }.
 */
export function analyzeImageBlue(blue, height, width, settings, { onProgress, flattenCoefOverride } = {}) {
  settings = makeSettings(settings)
  const report = (phase, fraction) => { if (onProgress) onProgress(phase, fraction) }
  const size = height * width
  if (blue.length !== size) throw fail('blue channel length does not match height * width.')

  const polygonMask = buildPolygonMask([height, width], settings.analysis_polygon)
  const modelInfo = {
    background_model: settings.background_model,
    threshold_mode: settings.threshold_mode,
    edge_correction: !!settings.edge_correction,
    axis_method: settings.axis_method,
    volume_model: settings.volume_model,
    flattened: false,
  }

  let flattenInfo = { applied: false }
  if (settings.background_model === 'poly4') {
    report('flatten', 0)
    const flat = flattenBlue(blue, height, width, polygonMask, flattenSeedPercent(settings),
      flattenCoefOverride ? { coefOverride: flattenCoefOverride } : undefined)
    blue = flat.blue
    flattenInfo = flat.info
    modelInfo.flattened = !!flattenInfo.applied
    report('flatten', 1)
  }

  const bg = backgroundMedian(blue, polygonMask)
  let thresholdPercent = Number(settings.threshold_percent)
  let mask = null
  if (settings.threshold_mode === 'half_contrast') {
    mask = thresholdMaskFor(blue, size, bg, thresholdPercent, polygonMask, null)
    const prelim = detectParticles(
      blue, height, width, mask, bg,
      { ...settings, quick_mode: true, min_surface: Number(CONTRAST_CLUSTER_MIN_PIXELS) },
      polygonMask,
      onProgress ? (f) => onProgress('prelim', f) : undefined,
    )
    const [pct, contrastInfo] = halfContrastPercent(blue, width, prelim, bg, thresholdPercent)
    thresholdPercent = pct
    Object.assign(modelInfo, contrastInfo)
  }
  modelInfo.threshold_percent_used = thresholdPercent

  const thresholdMask = thresholdMaskFor(blue, size, bg, thresholdPercent, polygonMask, mask)
  if (polygonMask) {
    let any = false
    for (let i = 0; i < size; i++) {
      if (thresholdMask[i] !== 0) {
        any = true
        break
      }
    }
    if (!any) throw fail('No thresholded pixels were found inside the selected analysis region.')
  }

  report('detect', 0)
  let ds = detectParticles(
    blue, height, width, thresholdMask, bg, settings, polygonMask,
    onProgress ? (f) => onProgress('detect', f) : undefined,
  )
  let splitInfo = null
  let ds0 = null
  if (settings.split_touching) {
    report('split', 0)
    const t = performance.now()
    const out = splitTouching(ds, settings, onProgress ? (f) => onProgress('split', f) : undefined)
    ds0 = out.dataset === ds ? null : ds
    ds = out.dataset
    splitInfo = { ...out.info, ms: 0 }
    report('split', 1)
    splitInfo.ms = Math.round(performance.now() - t)
  }
  report('measure', 0)
  remeasureClusters(ds, settings.axis_method, settings.volume_model)
  if (settings.edge_correction && ds.n > 0) {
    ds.edge_weight = edgeWeights(ds, [height, width], polygonMask)
  }
  ds.pixel_scale = settings.pixel_scale
  ds.label = 'Current Data'
  ds.meta = {
    min_surface: Number(settings.min_surface),
    reference_px_length: settings.reference_px_length,
    click_sigma_px: Number(settings.click_sigma_px),
    min_diameter_um: settings.min_diameter_um,
    image_shape: [height, width],
    threshold_percent_used: Number(thresholdPercent),
    background_model: settings.background_model,
    threshold_mode: settings.threshold_mode,
    edge_correction: !!settings.edge_correction,
    axis_method: settings.axis_method,
    volume_model: settings.volume_model,
  }
  if (splitInfo) {
    ds.meta.split_touching = true
    ds.meta.split_neck_ratio = Number(settings.split_neck_ratio)
    modelInfo.split_touching = true
    modelInfo.split_neck_ratio = Number(settings.split_neck_ratio)
    if (ds0) {
      // Dv at detection (what a run with the split off reports); the extra measurement counts as 'measure'.
      remeasureClusters(ds0, settings.axis_method, settings.volume_model)
      if (settings.edge_correction && ds0.n > 0) ds0.edge_weight = edgeWeights(ds0, [height, width], polygonMask)
      ds0.pixel_scale = settings.pixel_scale
      ds0.meta = { ...ds.meta }
    }
    splitInfo.unsplit = unsplitDv(ds0 ?? ds)
    ds0 = null
  }
  report('measure', 1)

  return {
    blue,
    threshold_mask: thresholdMask,
    polygon_mask: polygonMask,
    background_median: Number(bg),
    threshold_percent_used: Number(thresholdPercent),
    model_info: modelInfo,
    flatten_info: flattenInfo,
    dataset: ds,
    split_info: splitInfo,
  }
}

// ---------------------------------------------------------------- erase / layers
/** Cluster ids whose centroid lies within `radius` of any point ([row, col] analysis pixels). */
export function clustersWithinRadius(ds, points, radius) {
  const hits = new Set()
  if (!(radius > 0) || !points || points.length === 0 || ds.n === 0) return hits
  const { xmean, ymean, cluster_id } = ds
  for (let i = 0; i < ds.n; i++) {
    const xm = xmean[i]
    const ym = ymean[i]
    for (let k = 0; k < points.length; k++) {
      const xp = points[k][0]
      const yp = points[k][1]
      if (Math.sqrt((xm - xp) * (xm - xp) + (ym - yp) * (ym - yp)) <= radius) {
        hits.add(cluster_id[i])
        break
      }
    }
  }
  return hits
}

const PALETTE = [[255, 59, 48], [80, 160, 255]]

/** Threshold overlay layer: index 1 where the mask is set. */
export function thresholdIndexLayer(mask, h, w) {
  return { width: w, height: h, index: mask.slice(0, h * w), palette: PALETTE.map((c) => c.slice()) }
}

/** Cluster overlay layer: 1 = outline, 2 = centre (centres override outlines). */
export function clusterIndexLayer(shape, ds) {
  const [h, w] = shape
  const index = outlineMaskFromClusters(h, w, ds)
  for (let i = 0; i < ds.n; i++) {
    const xm = ds.xmean[i]
    const ym = ds.ymean[i]
    if (!Number.isFinite(xm) || !Number.isFinite(ym)) continue
    const r = roundHalfEven(xm)
    const c = roundHalfEven(ym)
    if (r >= 0 && r < h && c >= 0 && c < w) index[r * w + c] = 2
  }
  return { width: w, height: h, index, palette: PALETTE.map((c) => c.slice()) }
}
