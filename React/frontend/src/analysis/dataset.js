// Struct-of-arrays particle dataset (port of analysis.ParticleDataset / Cluster).
//
// Python naming trap preserved: `xmean` is the mean ROW and `ymean` the mean
// COLUMN of a cluster (Cluster.x_pixels are rows, y_pixels are columns).
// Pixels of cluster i live in px_row/px_col[px_start[i] .. px_start[i] + px_len[i]).
// px_* arrays are shared backing storage: selecting/filtering never copies them.

const F64_COLUMNS = ['surface', 'roundness', 'short_axis', 'long_axis', 'volume', 'xmean', 'ymean', 'edge_weight']

const asF64 = (a, n, fill) => {
  if (a instanceof Float64Array && a.length === n) return a
  const out = new Float64Array(n)
  if (a == null) {
    if (fill !== 0) out.fill(fill)
    return out
  }
  for (let i = 0; i < n; i++) out[i] = a[i]
  return out
}

const asI32 = (a, n) => {
  if (a instanceof Int32Array && a.length === n) return a
  const out = new Int32Array(n)
  if (a != null) for (let i = 0; i < n; i++) out[i] = a[i]
  return out
}

/**
 * Build a Dataset from column arrays. `cols.n` may be omitted (taken from the
 * first available column). edge_weight defaults to 1; px_* default to "no pixels".
 */
export function makeDataset(cols, { pixel_scale = null, label = 'Current Data', meta = {} } = {}) {
  let n = cols.n
  if (n == null) {
    const first = cols.cluster_id ?? cols.surface ?? cols.long_axis ?? cols.volume
    n = first ? first.length : 0
  }
  const ds = {
    n,
    cluster_id: asI32(cols.cluster_id, n),
  }
  if (cols.cluster_id == null) for (let i = 0; i < n; i++) ds.cluster_id[i] = i
  for (const name of F64_COLUMNS) ds[name] = asF64(cols[name], n, name === 'edge_weight' ? 1 : 0)
  ds.px_start = asI32(cols.px_start, n)
  ds.px_len = asI32(cols.px_len, n)
  ds.px_row = cols.px_row instanceof Int32Array ? cols.px_row : asI32(cols.px_row, cols.px_row ? cols.px_row.length : 0)
  ds.px_col = cols.px_col instanceof Int32Array ? cols.px_col : asI32(cols.px_col, cols.px_col ? cols.px_col.length : 0)
  ds.pixel_scale = pixel_scale
  ds.label = label
  ds.meta = meta
  return ds
}

/**
 * Sub-dataset of the kept indices (ascending). Scalar columns are copied; the
 * pixel backing arrays are shared. `overrides` may set pixel_scale, label, meta.
 */
export function selectDataset(ds, keepIdx, overrides = {}) {
  const m = keepIdx.length
  const out = {
    n: m,
    cluster_id: new Int32Array(m),
    px_start: new Int32Array(m),
    px_len: new Int32Array(m),
    px_row: ds.px_row,
    px_col: ds.px_col,
    pixel_scale: 'pixel_scale' in overrides ? overrides.pixel_scale : ds.pixel_scale,
    label: 'label' in overrides ? overrides.label : ds.label,
    meta: 'meta' in overrides ? overrides.meta : ds.meta,
  }
  for (const name of F64_COLUMNS) out[name] = new Float64Array(m)
  for (let k = 0; k < m; k++) {
    const i = keepIdx[k]
    out.cluster_id[k] = ds.cluster_id[i]
    out.px_start[k] = ds.px_start[i]
    out.px_len[k] = ds.px_len[i]
    for (const name of F64_COLUMNS) out[name][k] = ds[name][i]
  }
  return out
}

/** Dataset without the clusters whose cluster_id is in `excludedIds` (meta shared). */
export function filterDatasetByClusterIds(ds, excludedIds) {
  const excluded = new Set()
  for (const id of excludedIds) excluded.add(Math.trunc(Number(id)))
  const keep = []
  for (let i = 0; i < ds.n; i++) if (!excluded.has(ds.cluster_id[i])) keep.push(i)
  return selectDataset(ds, keep)
}

/** Same clusters with the pixel lists dropped (frozen results keep scalars only). */
export function dropPixels(ds) {
  const out = selectDataset(ds, Array.from({ length: ds.n }, (_, i) => i))
  out.px_len = new Int32Array(ds.n)
  out.px_start = new Int32Array(ds.n)
  out.px_row = new Int32Array(0)
  out.px_col = new Int32Array(0)
  return out
}
