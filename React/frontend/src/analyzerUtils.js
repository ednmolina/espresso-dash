/** Helpers shared by the analyzer components (API shapes, formatting, errors). */

/** Readable message from a failed response body: {detail:string} or a FastAPI 422 list. */
export function errorMessage(data, status) {
  const detail = data?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d) => {
        const where = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== 'body').join('.') : ''
        const msg = d?.msg ?? (typeof d === 'string' ? d : 'invalid value')
        return where ? `${where}: ${msg}` : msg
      })
      .join('; ')
  }
  if (typeof data?.message === 'string') return data.message
  return `Request failed (${status})`
}

/**
 * Particles arrive either as an array of row objects (old API) or as columns
 * {id:[], surface:[], ...} (new API). Normalise to { columns, rows, length }.
 */
export function normalizeParticles(particles) {
  if (!particles) return { columns: [], rows: [], length: 0 }
  if (Array.isArray(particles)) {
    const columns = particles.length ? Object.keys(particles[0]) : []
    return { columns, rows: particles, length: particles.length }
  }
  const columns = Object.keys(particles).filter((k) => Array.isArray(particles[k]))
  const length = columns.length ? Math.max(...columns.map((k) => particles[k].length)) : 0
  const rows = new Array(length)
  for (let i = 0; i < length; i += 1) {
    const row = {}
    for (const c of columns) row[c] = particles[c][i]
    rows[i] = row
  }
  return { columns, rows, length }
}

/** Drop removed ids from a particles payload of either shape. */
export function filterParticles(particles, removedIds) {
  if (!particles || !removedIds?.length) return particles
  const gone = new Set(removedIds)
  if (Array.isArray(particles)) return particles.filter((p) => !gone.has(p.id ?? p.ID))
  if (!Array.isArray(particles.id)) return particles
  const keep = []
  particles.id.forEach((id, i) => { if (!gone.has(id)) keep.push(i) })
  const out = {}
  for (const [k, v] of Object.entries(particles)) out[k] = Array.isArray(v) ? keep.map((i) => v[i]) : v
  return out
}

export function particlesToCsv(particles, removedIds = []) {
  const { columns, rows } = normalizeParticles(filterParticles(particles, removedIds))
  if (!rows.length) return ''
  const cell = (v) => (v == null || (typeof v === 'number' && !Number.isFinite(v)) ? '' : JSON.stringify(v))
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n')
}

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** mm -> rounded µm string, thousands-separated. */
export const um = (mm) => (isNum(mm) ? Math.round(mm * 1000).toLocaleString() : '—')

export const sig = (v, p = 3) => (isNum(v) ? String(+v.toPrecision(p)) : '—')

export const fixed = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '—')

export const cleanUnit = (u) => (u ?? 'mm').replace(/\$\\mu\$/g, 'µ')

/** Run-to-run spread in µm (1 decimal), "< 0.1 µm" when negligible. */
export function formatSigma(valueInUnit, unit) {
  if (!isNum(valueInUnit)) return '—'
  if (Math.abs(valueInUnit) < 0.05) return `< 0.1 ${unit}`
  return `±${valueInUnit.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`
}
