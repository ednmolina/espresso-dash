// Measurement precision from repeat photos of the same sample. Pure maths, no React, no storage.
//
// A "repeat check" is 2+ photos of one sample (the Analyzer's saved runs). For each of Dv10/Dv50/Dv90
// we take the spread between photos (sample SD, n - 1) relative to the mean (CV). Several checks are
// pooled by degrees of freedom, so a check with more photos counts for more. "One photo is typically
// within +-X%" is 2 x CV: roughly the 95% range of a single photo around the true value.
//
// CV is a fraction here (0.036 = 3.6%); onePhotoPct is already a percentage (7.2).

export const METRICS = ['dv10', 'dv50', 'dv90']
export const MIN_RUNS_PER_CHECK = 2
export const MIN_POOLED_PHOTOS = 3
// Dv50 spread above this (15%) between "repeat" photos means they are most likely not the same grind.
export const DIFFERENT_SAMPLE_CV = 0.15

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/** {n, mean, sd, cv} of the finite numbers in `values`. sd/cv are null below 2 values or for a mean <= 0. */
export function summaryStats(values) {
  const xs = (Array.isArray(values) ? values : []).filter(finite)
  const n = xs.length
  if (n === 0) return { n: 0, mean: null, sd: null, cv: null }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { n, mean, sd: null, cv: null }
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
  return { n, mean, sd, cv: mean > 0 ? sd / mean : null }
}

/** Dv10/Dv50/Dv90 (um) and particle count from an Analyzer summary (mm). Missing fields are null (old API). */
export function dvFromSummary(summary) {
  const s = summary && typeof summary === 'object' ? summary : {}
  const um = (mm) => (finite(mm) ? mm * 1000 : null)
  return {
    dv10_um: um(s.dv10_mm),
    dv50_um: um(s.dv50_mm),
    dv90_um: um(s.dv90_mm),
    n_particles: finite(s.cluster_count) ? s.cluster_count : null,
  }
}

/** Per-metric stats of one check's runs ([{dv10_um, dv50_um, dv90_um}]); null for a metric with < 2 usable values. */
export function checkFromRuns(runs) {
  const list = Array.isArray(runs) ? runs : []
  const out = {}
  METRICS.forEach((m) => {
    const stats = summaryStats(list.map((r) => r?.[`${m}_um`]))
    out[m] = stats.n >= MIN_RUNS_PER_CHECK && stats.cv !== null ? stats : null
  })
  return out
}

/**
 * Pool several checks (stored records with `runs`, or the output of checkFromRuns; excluded ones are skipped).
 * Per metric: { cv, onePhotoPct, checks, photos }, or null while there are fewer than 3 photos in total.
 * cv = sqrt( sum((n_i - 1) cv_i^2) / sum(n_i - 1) ).
 */
export function pooledPrecision(checks) {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && !c.excluded)
  const stats = list.map((c) => (Array.isArray(c.runs) ? checkFromRuns(c.runs) : c))
  const out = {}
  METRICS.forEach((m) => {
    const used = stats.map((s) => s?.[m]).filter((s) => s && s.n >= MIN_RUNS_PER_CHECK && finite(s.cv))
    const photos = used.reduce((a, s) => a + s.n, 0)
    if (used.length === 0 || photos < MIN_POOLED_PHOTOS) { out[m] = null; return }
    const df = used.reduce((a, s) => a + (s.n - 1), 0)
    const cv = Math.sqrt(used.reduce((a, s) => a + (s.n - 1) * s.cv ** 2, 0) / df)
    out[m] = { cv, onePhotoPct: 2 * cv * 100, checks: used.length, photos }
  })
  return out
}

/**
 * The "±X" number for a percentage: whole numbers from 1% up, one decimal below that so a tight
 * result never reads "±0%" (0.04 -> "0.1" at the smallest, exactly 0 -> "0").
 */
export function formatPct(pct) {
  if (!finite(pct) || pct <= 0) return '0'
  if (pct < 1) return Math.max(0.1, Math.round(pct * 10) / 10).toFixed(1)
  return String(Math.round(pct))
}

/** Identity of an Analyzer saved run: the frozen analysis plus the clusters removed from it. */
export function savedRunKey(run) {
  const ids = Array.isArray(run?.removedIds) ? [...run.removedIds].map(String).sort() : []
  const sm = run?.summary ?? {}
  // Older servers give no analysis_id, so one image id covers every detection: add the numbers too.
  return `${run?.imageId ?? ''}|${ids.join(',')}|${sm.cluster_count ?? ''}|${sm.dv50_mm ?? ''}`
}

/** The saved runs with repeats of the same analysis dropped (first one wins). */
export function uniqueSavedRuns(runs) {
  const seen = new Set()
  return (Array.isArray(runs) ? runs : []).filter((r) => {
    const key = savedRunKey(r)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
