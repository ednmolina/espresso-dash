// Pure view-model for the Diagnostics "Photo analysis checks" card: what the latest in-memory
// analysis (see analysisSession.js) says about particle shape and about touching-particle separation.
import { normalizeShape, normalizeSplit, normalizeSummary } from './analyzerCompat'

const MINUS = '\u2212'

/** Signed percent text with a real minus sign: -3.84 -> "\u22123.8%". */
export function formatChange(pct) {
  const rounded = Math.round(pct * 10) / 10
  return `${rounded < 0 ? MINUS : rounded > 0 ? '+' : ''}${Math.abs(rounded).toFixed(1)}%`
}

/** What the in-memory latest analysis says, ready to render (null before any analysis). */
export function photoChecksModel(latest) {
  if (!latest) return null
  const shape = normalizeShape(latest.shape_summary)
  const split = normalizeSplit(latest.split_info)
  const sum = normalizeSummary(latest.summary)
  let table = null
  if (split) {
    const before = split.before
    let change = null
    if (before?.dv90 != null && sum.dv90 != null && before.dv90 > 0) {
      const pct = ((sum.dv90 - before.dv90) / before.dv90) * 100
      const rounded = Math.round(pct * 10) / 10
      change = { pct: rounded, text: formatChange(pct), lower: rounded < 0 }
    }
    table = {
      particles: [before?.count ?? null, sum.count],
      dv50: [before?.dv50 ?? null, sum.dv50],
      dv90: [before?.dv90 ?? null, sum.dv90],
      change,
    }
  }
  return { shape, split, table, minPx: latest.shape_summary?.min_px ?? 20 }
}


/** Subtitle of the phone list row. */
export function checksSubtitle(model) {
  if (!model) return 'Analyze a photo to see them'
  const shape = model.shape ? `Shape ${model.shape.arMedian.toFixed(2)} : 1` : 'Shape not measured'
  if (!model.table) return `${shape} · separation off`
  return `${shape}${model.table.change ? ` · Dv90 ${model.table.change.text} separated` : ' · separated'}`
}
