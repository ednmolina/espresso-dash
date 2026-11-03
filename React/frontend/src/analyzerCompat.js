/**
 * Compatibility layer between the analyzer UI and the two API generations.
 *
 *  new API (cloudrun, this repo):  *_layer_b64 (transparent PNG), /histogram `series`,
 *                                  summary with dv10/dv50/dv90, CI, GSD; /upload has no image_b64
 *  old API (deployed e299811):     *_overlay_b64 (opaque composite of photo + overlay),
 *                                  /histogram returns a matplotlib PNG only, legacy summary
 *                                  (diameter_mean_mm and friends, no dv50_mm); /upload returns image_b64
 *
 * Everything here is pure so it can be unit tested without a browser.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * Layer for the chosen overlay. Either a base64 string (cloud engine: transparent layer first,
 * old opaque composite as fallback) or a drawable image (on-device engine: ImageBitmap/canvas).
 */
export function layerOf(result, mode /* 'clusters' | 'threshold' */) {
  if (!result) return null
  if (mode === 'threshold') return result.threshold_layer ?? result.threshold_layer_b64 ?? result.threshold_overlay_b64 ?? null
  if (mode === 'clusters') return result.cluster_layer ?? result.cluster_layer_b64 ?? result.cluster_overlay_b64 ?? null
  return null
}

/**
 * Merge an /erase response into the previous analysis result.
 * `removedIds` is the full list of removed cluster ids after this erase (used to filter a
 * local particle copy when the server no longer sends particles).
 */
export function mergeErase(prev, data, removedIds) {
  const base = prev ?? {}
  const next = data ?? {}
  let particles = base.particles
  if (next.particles != null) {
    particles = next.particles
  } else if (removedIds?.length && base.particles) {
    particles = filterParticleIds(base.particles, removedIds)
  }
  return {
    ...base,
    cluster_layer: next.cluster_layer ?? base.cluster_layer,
    cluster_layer_b64: next.cluster_layer_b64 ?? next.cluster_overlay_b64 ?? base.cluster_layer_b64 ?? base.cluster_overlay_b64 ?? null,
    nclusters: next.nclusters ?? base.nclusters,
    summary: next.summary !== undefined ? next.summary : base.summary,
    shape_summary: next.shape_summary !== undefined ? next.shape_summary : base.shape_summary,
    particles,
  }
}

/** Same filtering as analyzerUtils.filterParticles, duplicated here so this module has no imports. */
function filterParticleIds(particles, removedIds) {
  const gone = new Set(removedIds)
  if (Array.isArray(particles)) return particles.filter((p) => !gone.has(p.id ?? p.ID))
  if (!Array.isArray(particles.id)) return particles
  const keep = []
  particles.id.forEach((id, i) => { if (!gone.has(id)) keep.push(i) })
  const out = {}
  for (const [k, v] of Object.entries(particles)) out[k] = Array.isArray(v) ? keep.map((i) => v[i]) : v
  return out
}

/**
 * A data URL for the photo when the upload response already carries one (old API),
 * otherwise null: the caller then decides whether /preview is needed (only when the
 * browser cannot decode the file itself or its size disagrees with the server's).
 */
export function previewSrc(uploadData) {
  const b64 = uploadData?.image_b64
  if (!b64) return null
  const mime = typeof uploadData.image_mime === 'string' && uploadData.image_mime ? uploadData.image_mime : 'image/png'
  return `data:${mime};base64,${b64}`
}

/** [lo, hi] confidence interval -> millimetres (tolerates values already in µm). */
function ciToMm(ci) {
  if (!Array.isArray(ci) || ci.length !== 2 || !ci.every(isNum)) return null
  const inUm = Math.max(...ci) > 50
  return ci.map((v) => (inUm ? v / 1000 : v))
}

/**
 * Normalised view of a /analyze summary for either API generation.
 *  legacy:   true when the server did not report volume percentiles (no dv50_mm)
 *  dv*, meanMm, stdMm: millimetres or null
 *  ci50:     [lo, hi] in millimetres or null
 */
export function normalizeSummary(summary) {
  const s = summary ?? {}
  const num = (v) => (isNum(v) ? v : null)
  const finesPct = num(s.fines_volume_pct)
  const legacy = !isNum(s.dv50_mm)
  return {
    legacy,
    dv10: num(s.dv10_mm),
    dv50: num(s.dv50_mm),
    dv90: num(s.dv90_mm),
    meanMm: num(s.diameter_mean_mm),
    stdMm: num(s.diameter_std_mm),
    ci50: ciToMm(s.dv_ci95?.dv50),
    gsd: num(s.gsd_volume),
    count: num(s.cluster_count),
    finesPct,
    finesMeasurable: !legacy && s.fines_measurable !== false && finesPct != null,
    limitUm: num(s.detection_limit_um),
    raw: summary ?? null,
  }
}

/**
 * Normalised view of the analyze/erase `shape_summary` (aspect-ratio statistics of the
 * measured ellipses). null when absent or without a median.
 */
export function normalizeShape(s) {
  if (!s || !isNum(s.aspect_ratio_median)) return null
  const num = (v) => (isNum(v) ? v : null)
  return {
    arMedian: s.aspect_ratio_median,
    arP10: num(s.aspect_ratio_p10),
    arP90: num(s.aspect_ratio_p90),
    n: num(s.aspect_ratio_n),
  }
}

/**
 * Normalised view of the analyze `split_info` (present only when "Separate touching particles"
 * was on). `pieces` is the number of particles the split clumps became; `before` is what the same
 * photo reports without separation (null without a pixel scale). Values are analysis-time:
 * a clean-up afterwards does not change them.
 */
export function normalizeSplit(info) {
  if (!info || typeof info !== 'object') return null
  const clustersSplit = isNum(info.clusters_split) ? info.clusters_split : 0
  const added = isNum(info.pieces_added) ? info.pieces_added : 0
  const u = info.unsplit && typeof info.unsplit === 'object' ? info.unsplit : null
  const num = (v) => (isNum(v) ? v : null)
  return {
    clustersSplit,
    pieces: clustersSplit + added,
    before: u ? { count: num(u.cluster_count), dv10: num(u.dv10_mm), dv50: num(u.dv50_mm), dv90: num(u.dv90_mm) } : null,
  }
}

/** Saved-run label as shown in the runs table: " · separated" when the run used separation. */
export function savedRunLabel(run) {
  return run?.summary?.split_touching === true ? `${run.label} · separated` : String(run?.label ?? '')
}

/** 'series' when the browser can draw the chart, 'png' for the old server-rendered image, else 'none'. */
export function histogramKind(h) {
  if (h?.edges?.length && h?.series) return 'series'
  if (h?.series?.edges?.length && h?.series?.series) return 'series'
  if (h?.histogram_b64) return 'png'
  return 'none'
}
