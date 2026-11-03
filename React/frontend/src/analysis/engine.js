// On-device analysis engine: a synchronous, server-equivalent port of the Cloud Run
// endpoints in cloudrun/main.py (/upload, /analyze, /erase, /histogram, /histogram/compare).
//
// Pure: no DOM, no Worker, so it runs in a Web Worker, inline on the main thread, and in
// vitest/node. Errors are thrown as Error(detail) with `.status` set, using the server's
// detail strings verbatim.

import { makeSettings, analyzeImageBlue, clustersWithinRadius, thresholdIndexLayer, clusterIndexLayer } from './detect.js'
import { filterDatasetByClusterIds, dropPixels } from './dataset.js'
import { summaryOrNone, particlesPayload } from './summary.js'
import { histogramFromStored, compareFromStored } from './histogram.js'
import { resizeLanczosU8 } from './resample.js'
import { roundHalfEven, finiteOrNull } from './np.js'
import { httpError, MAX_PIXELS } from './decode.js'

export { httpError, MAX_PIXELS }

export const MAX_ANALYSIS_PIXELS = 16e6
const RESULT_CAPACITY = 32

/** Non-null REFERENCE_OBJECTS_MM from cloudrun/coffeegrindsize_core/analysis.py, verbatim. */
export const REFERENCE_OBJECTS_MM = {
  'Canadian Quarter': 23.81,
  'Canadian Dollar': 26.5,
  'Canadian Dime': 18.03,
  'Canadian Two Dollars': 28.0,
  'Canadian Five Cents': 21.3,
  'US Quarter': 24.26,
  'US Dollar': 26.92,
  'US Dime': 17.91,
  'US Penny': 19.05,
  '2 Euros': 25.75,
  '1 Euro': 23.25,
  '50 Euro Cents': 24.25,
  '20 Euro Cents': 22.25,
}

// ---------------------------------------------------------------------------
// Request validation (pydantic AnalyzeRequest / EraseRequest ranges)
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const bad = (field, message) => httpError(422, `${field}: ${message}`)

function checkNumber(body, field, { min, max, minExclusive = false, integer = false } = {}) {
  const v = body[field]
  if (v === undefined || v === null) return
  if (!isNum(v)) throw bad(field, 'Input should be a valid number')
  if (integer && !Number.isInteger(v)) throw bad(field, 'Input should be a valid integer')
  if (min !== undefined) {
    if (minExclusive ? v <= min : v < min) {
      throw bad(field, minExclusive ? `Input should be greater than ${min}` : `Input should be greater than or equal to ${min}`)
    }
  }
  if (max !== undefined && v > max) throw bad(field, `Input should be less than or equal to ${max}`)
}

function checkEnum(body, field, allowed) {
  const v = body[field]
  if (v === undefined || v === null) return
  if (!allowed.includes(v)) throw bad(field, `Input should be ${allowed.map((a) => `'${a}'`).join(', ')}`)
}

function checkBool(body, field) {
  const v = body[field]
  if (v === undefined || v === null) return
  if (typeof v !== 'boolean') throw bad(field, 'Input should be a valid boolean')
}

function checkPoints(body, field, { min = 0, max }) {
  const v = body[field]
  if (v === undefined || v === null) return
  if (!Array.isArray(v)) throw bad(field, 'Input should be a valid list')
  if (v.length < min) throw bad(field, `List should have at least ${min} item${min === 1 ? '' : 's'} after validation, not ${v.length}`)
  if (v.length > max) throw bad(field, `List should have at most ${max} items after validation, not ${v.length}`)
  v.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) {
      throw bad(`${field}.${i}`, 'Input should be a valid [x, y] pair of numbers')
    }
  })
}

function validateAnalyze(body) {
  if (typeof body?.image_id !== 'string' || !body.image_id) throw bad('image_id', 'Field required')
  checkNumber(body, 'threshold_percent', { min: 1, max: 100 })
  checkNumber(body, 'reference_threshold', { min: 0, max: 1 })
  checkNumber(body, 'max_cost', { min: 0 })
  checkNumber(body, 'max_cluster_axis', { min: 1, max: 200 })
  checkNumber(body, 'min_surface', { min: 0 })
  checkNumber(body, 'min_roundness', { min: 0, max: 1 })
  checkBool(body, 'quick_mode')
  checkNumber(body, 'analysis_scale_pct', { min: 10, max: 100, integer: true })
  checkPoints(body, 'reference_points', { max: 2 })
  checkNumber(body, 'reference_physical_mm', { min: 0, max: 1000, minExclusive: true })
  checkPoints(body, 'polygon_points', { max: 2000 })
  checkEnum(body, 'background_model', ['global', 'poly4'])
  checkEnum(body, 'threshold_mode', ['fixed', 'half_contrast'])
  checkBool(body, 'edge_correction')
  checkEnum(body, 'axis_method', ['max_radius', 'moments'])
  checkEnum(body, 'volume_model', ['legacy', 'spheroid'])
  checkNumber(body, 'min_diameter_um', { min: 0, max: 100000 })
  checkNumber(body, 'click_sigma_px', { min: 0, max: 100 })
}

function validateErase(body) {
  if (typeof body?.image_id !== 'string' || !body.image_id) throw bad('image_id', 'Field required')
  if (body.erase_points === undefined || body.erase_points === null) throw bad('erase_points', 'Field required')
  checkPoints(body, 'erase_points', { min: 1, max: 2000 })
  checkNumber(body, 'erase_radius_px', { min: 0, max: 5000, minExclusive: true })
  const ids = body.already_removed_ids
  if (ids !== undefined && ids !== null) {
    if (!Array.isArray(ids)) throw bad('already_removed_ids', 'Input should be a valid list')
    if (ids.length > 200000) throw bad('already_removed_ids', 'List should have at most 200000 items')
  }
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * IndexLayer -> RGBA bytes (alpha 255 for index > 0, 0 otherwise), written through a
 * Uint32Array view (little-endian: a<<24 | b<<16 | g<<8 | r). One layer at a time.
 */
export function layerToRgba(layer) {
  const { width, height, index, palette } = layer
  const n = width * height
  const rgba = new Uint8ClampedArray(n * 4)
  const px = new Uint32Array(rgba.buffer)
  const lut = new Uint32Array(256)
  for (let k = 1; k < 256; k++) {
    const c = palette[k - 1] ?? palette[palette.length - 1] ?? [255, 59, 48]
    lut[k] = ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0
  }
  for (let i = 0; i < n; i++) {
    const v = index[i]
    if (v !== 0) px[i] = lut[v]
  }
  return rgba
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`
}

function hex12() {
  let s = ''
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const a = new Uint8Array(6)
    crypto.getRandomValues(a)
    for (const b of a) s += b.toString(16).padStart(2, '0')
    return s
  }
  while (s.length < 12) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Adapt the detection code's progress callback to (phase, fraction). */
function phaseReporter(onProgress) {
  if (!onProgress) return undefined
  return (a, b) => {
    if (typeof a === 'string') onProgress(a, typeof b === 'number' ? b : 0)
    else if (a && typeof a === 'object') onProgress(a.phase ?? 'detect', a.fraction ?? 0)
    else if (typeof a === 'number' && typeof b === 'number' && b > 0) onProgress('detect', Math.min(1, a / b))
  }
}

export function createEngine() {
  /** image_id -> {width, height, fullWidth, fullHeight, decodeScale, blue}; the latest image only. */
  const images = new Map()
  /** key (image_id or analysis_id) -> StoredResult; insertion order = recency. */
  const results = new Map()
  /** The most recent resized copy of the latest image: {imageId, width, height, blue}. */
  let resized = null

  const putResult = (keys, stored) => {
    for (const key of keys) {
      results.delete(key)
      results.set(key, stored)
    }
    while (results.size > RESULT_CAPACITY) results.delete(results.keys().next().value)
  }

  const getResult = (key) => {
    const r = results.get(key)
    if (r) {
      results.delete(key)
      results.set(key, r)
    }
    return r ?? null
  }

  /** Free the pixel lists of every stored result except `keep` (frozen results keep scalars only). */
  const freezeResults = (keep) => {
    const seen = new Set()
    for (const stored of results.values()) {
      if (stored === keep || seen.has(stored)) continue
      seen.add(stored)
      if (stored.has_pixels) {
        stored.dataset = dropPixels(stored.dataset)
        stored.has_pixels = false
      }
    }
  }

  function registerImage({ image_id = newId(), width, height, blue, fullWidth, fullHeight, decodeScale = 1 }) {
    if (!(width >= 1 && height >= 1) || !Number.isInteger(width) || !Number.isInteger(height)) {
      throw httpError(400, 'Could not decode image.')
    }
    const fw = fullWidth ?? width
    const fh = fullHeight ?? height
    if (fw * fh > MAX_PIXELS) {
      throw httpError(413, `Image is too large (${fw}x${fh}); limit is ${(MAX_PIXELS / 1e6).toFixed(0)} megapixels.`)
    }
    if (!blue || blue.length !== width * height) throw httpError(400, 'Could not decode image.')
    images.clear() // latest image only
    resized = null
    freezeResults(null)
    images.set(image_id, { width, height, fullWidth: fw, fullHeight: fh, decodeScale, blue })
    return { image_id, width: fw, height: fh, reference_objects: { ...REFERENCE_OBJECTS_MM } }
  }

  function dropImage(imageId) {
    images.delete(imageId)
    if (resized?.imageId === imageId) resized = null
  }

  const hasImage = (id) => images.has(id)

  function analysisBlue(imageId, img, tw, th, onProgress) {
    if (tw === img.width && th === img.height) return img.blue
    if (resized && resized.imageId === imageId && resized.width === tw && resized.height === th) return resized.blue
    onProgress?.('resize', 0)
    const out = resizeLanczosU8(img.blue, img.width, img.height, tw, th)
    resized = { imageId, width: tw, height: th, blue: out }
    onProgress?.('resize', 1)
    return out
  }

  function analyze(body, { onProgress } = {}) {
    const t0 = now()
    validateAnalyze(body)
    const img = images.get(body.image_id)
    if (!img) throw httpError(404, 'Image not found. Upload first.')

    const W = img.fullWidth
    const H = img.fullHeight
    let s = (body.analysis_scale_pct ?? 100) / 100
    if (W * H * s * s > MAX_ANALYSIS_PIXELS) s = Math.sqrt(MAX_ANALYSIS_PIXELS / (W * H))
    // A photo that was already shrunk at decode time (iOS memory fallback) cannot be
    // analysed at a finer scale than it was decoded at. Parity with the server is
    // tolerance-only on that path.
    if (img.decodeScale < 1) s = Math.min(s, img.decodeScale)
    let tw = Math.max(1, roundHalfEven(W * s))
    let th = Math.max(1, roundHalfEven(H * s))
    if (img.decodeScale < 1 && Math.abs(tw - img.width) <= 1 && Math.abs(th - img.height) <= 1) {
      tw = img.width
      th = img.height
      s = img.width / W
    }

    let pixelScale = null
    let pxLength = null
    const rp = body.reference_points
    if (Array.isArray(rp) && rp.length === 2 && body.reference_physical_mm) {
      const [[x1, y1], [x2, y2]] = rp
      pxLength = Math.hypot(x2 - x1, y2 - y1)
      if (pxLength < 2) throw httpError(400, 'Reference points are too close together (need at least 2 px).')
      pixelScale = (pxLength / body.reference_physical_mm) * s
    }

    let polygon = null
    if (Array.isArray(body.polygon_points) && body.polygon_points.length >= 3) {
      polygon = body.polygon_points.map(([x, y]) => [x * s, y * s])
    }

    const overrides = {
      threshold_percent: body.threshold_percent,
      reference_threshold: body.reference_threshold,
      max_cluster_axis: body.max_cluster_axis,
      min_surface: body.min_surface,
      min_roundness: body.min_roundness,
      max_cost: body.max_cost,
      quick_mode: body.quick_mode,
      analysis_polygon: polygon,
      pixel_scale: pixelScale,
    }
    for (const name of ['background_model', 'threshold_mode', 'edge_correction', 'axis_method', 'volume_model', 'min_diameter_um', 'click_sigma_px']) {
      if (body[name] !== undefined && body[name] !== null) overrides[name] = body[name]
    }
    if (pxLength !== null) overrides.reference_px_length = pxLength * s
    // Only non-null fields override the defaults.
    for (const k of Object.keys(overrides)) if (overrides[k] === undefined || overrides[k] === null) delete overrides[k]
    const settings = makeSettings(overrides) // ValueError -> "background_model must be one of ..."

    const report = phaseReporter(onProgress)
    const tResize = now()
    const blue = analysisBlue(body.image_id, img, tw, th, report)
    const tAnalyze = now()
    let result
    try {
      result = analyzeImageBlue(blue, th, tw, settings, { onProgress: report })
    } catch (err) {
      if (err && err.status == null) err.status = err.constructor === Error ? 400 : 500
      throw err
    }
    const tLayers = now()
    onProgress?.('layers', 0)
    const dataset = result.dataset
    const thresholdLayer = thresholdIndexLayer(result.threshold_mask, th, tw)
    const clusterLayer = clusterIndexLayer([th, tw], dataset)
    const backgroundMedian = Number(result.background_median)
    onProgress?.('layers', 1)

    const stored = {
      dataset,
      shape: [th, tw],
      background_median: backgroundMedian,
      analysis_scale: s,
      min_surface: body.min_surface ?? 5.0,
      has_pixels: true,
    }
    // Only the newest result per image keeps pixels.
    freezeResults(stored)
    const analysisId = `${body.image_id}.${hex12()}`
    putResult([body.image_id, analysisId], stored)

    const t1 = now()
    const payload = finiteOrNull({
      background_median: backgroundMedian,
      nclusters: dataset.n,
      pixel_scale: dataset.pixel_scale,
      summary: summaryOrNone(dataset),
      particles: particlesPayload(dataset),
      analysis_scale: s,
      analysis_id: analysisId,
      width: tw,
      height: th,
      engine: 'local',
      timings_ms: {
        resize: Math.round(tAnalyze - tResize),
        analyze: Math.round(tLayers - tAnalyze),
        layers: Math.round(t1 - tLayers),
        total: Math.round(t1 - t0),
      },
    })
    payload.threshold_layer = thresholdLayer
    payload.cluster_layer = clusterLayer
    return payload
  }

  function erase(body) {
    validateErase(body)
    const stored = getResult(body.image_id)
    if (!stored) throw httpError(404, 'No analysis found for this image.')
    if (!stored.has_pixels) throw httpError(404, 'No analysis found for this image.')

    const s = stored.analysis_scale
    const already = new Set(body.already_removed_ids ?? [])
    const ds = filterDatasetByClusterIds(stored.dataset, already)
    // Clicks arrive as full-image [x=col, y=row]; xmean is the ROW and ymean the COLUMN
    // in analysis pixels.
    const points = body.erase_points.map(([x, y]) => [y * s, x * s])
    const radius = (body.erase_radius_px ?? 20) * s
    const hits = clustersWithinRadius(ds, points, radius)
    const all = new Set(already)
    for (const id of hits) all.add(id)
    const filtered = filterDatasetByClusterIds(stored.dataset, all)
    const removed = Array.from(all).sort((a, b) => a - b)
    const layer = clusterIndexLayer(stored.shape, filtered)
    const summary = summaryOrNone(filtered)
    return {
      removed_ids: removed,
      nclusters: filtered.n,
      cluster_layer: layer,
      summary: finiteOrNull(summary),
    }
  }

  function histogramDefaults(body) {
    return {
      removed_cluster_ids: [],
      x_metric: 'diameter',
      weight_mode: 'number',
      x_log: true,
      bins: null,
      include_png: true,
      min_diameter_um: null,
      ...body,
    }
  }

  function histogram(body) {
    const stored = getResult(body?.image_id)
    if (!stored) throw httpError(404, 'No analysis found for this image.')
    return histogramFromStored(stored, histogramDefaults(body))
  }

  function compare(body) {
    const runs = body?.runs
    if (!Array.isArray(runs) || runs.length < 1) throw bad('runs', 'List should have at least 1 item after validation, not 0')
    if (runs.length > 6) throw bad('runs', `List should have at most 6 items after validation, not ${runs.length}`)
    const storedList = []
    for (const run of runs) {
      const stored = getResult(run.image_id)
      if (!stored) throw httpError(404, `No analysis found for image ${run.image_id}.`)
      storedList.push(stored)
    }
    const req = histogramDefaults(body)
    req.runs = runs.map((r) => ({ removed_cluster_ids: [], label: '', ...r }))
    return compareFromStored(storedList, req)
  }

  return { registerImage, analyze, erase, histogram, compare, hasImage, dropImage }
}
