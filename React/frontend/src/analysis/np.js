// numpy-compatible numeric primitives (see specs COMMON.md section 6).
// Everything here mirrors numpy semantics (summation order, rounding, interpolation) so the
// browser port of the grind analysis reproduces the Python results.

export const fround = Math.fround

/**
 * float32 fused step used by the flatten chain: fround(a*b + c).
 * a and b are float32 values, so a*b is exact in double. The double rounding (double then float)
 * can differ from a true float32 FMA only in astronomically rare cases (0 in 12M verified).
 */
export function fma32(a, b, c) {
  return Math.fround(a * b + c)
}

/** Banker's rounding (np.round / Python round()). */
export function roundHalfEven(x) {
  const r = Math.round(x)
  return (r - x === 0.5 && r % 2 !== 0) ? r - 1 : r
}

/**
 * numpy pairwise summation of arr[start .. start+n) (float64, contiguous). The accumulator
 * identity is 0.0, exactly as np.sum does for float64.
 */
export function pairwiseSum(arr, start = 0, n = arr.length - start) {
  return pw(arr, start, n)
}

function pw(a, s, n) {
  if (n < 8) {
    let r = 0
    for (let i = 0; i < n; i++) r += a[s + i]
    return r
  }
  if (n <= 128) {
    let r0 = a[s], r1 = a[s + 1], r2 = a[s + 2], r3 = a[s + 3]
    let r4 = a[s + 4], r5 = a[s + 5], r6 = a[s + 6], r7 = a[s + 7]
    const lim = n - (n % 8)
    let i = 8
    for (; i < lim; i += 8) {
      r0 += a[s + i]
      r1 += a[s + i + 1]
      r2 += a[s + i + 2]
      r3 += a[s + i + 3]
      r4 += a[s + i + 4]
      r5 += a[s + i + 5]
      r6 += a[s + i + 6]
      r7 += a[s + i + 7]
    }
    let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7))
    for (; i < n; i++) res += a[s + i]
    return res
  }
  let n2 = Math.floor(n / 2)
  n2 -= n2 % 8
  return pw(a, s, n2) + pw(a, s + n2, n - n2)
}

/** np.sum / np.nansum (no NaNs) of a float64 array. */
export function npSum(arr) {
  return pw(arr, 0, arr.length)
}

/** np.cumsum (sequential). */
export function cumsum(arr) {
  const n = arr.length
  const out = new Float64Array(n)
  let acc = 0
  for (let i = 0; i < n; i++) {
    acc += arr[i]
    out[i] = acc
  }
  return out
}

/** np.interp for a scalar x with increasing xp (duplicates allowed). */
export function interp(x, xp, fp) {
  const n = xp.length
  if (x > xp[n - 1]) return fp[n - 1]
  if (x < xp[0]) return fp[0]
  // upper bound: first index with xp[idx] > x, then j = idx - 1
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (x < xp[mid]) hi = mid
    else lo = mid + 1
  }
  const j = lo - 1
  if (j < 0) return fp[0]
  if (j >= n - 1) return fp[n - 1]
  if (xp[j] === x) return fp[j]
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j])
  let res = slope * (x - xp[j]) + fp[j]
  if (Number.isNaN(res)) {
    res = slope * (x - xp[j + 1]) + fp[j + 1]
    if (Number.isNaN(res) && fp[j] === fp[j + 1]) res = fp[j]
  }
  return res
}

/** np.percentile(a, p) (method="linear") of an already ascending-sorted array, no NaNs. */
export function percentileLinear(sortedAsc, p) {
  const n = sortedAsc.length
  const q = p / 100
  const vi = (n - 1) * q
  if (vi >= n - 1) return sortedAsc[n - 1]
  const lo = Math.floor(vi)
  const g = vi - lo
  const a = sortedAsc[lo]
  const b = sortedAsc[lo + 1]
  const d = b - a
  return g >= 0.5 ? b - d * (1 - g) : a + d * g
}

/** np.median of an ascending-sorted float64 array. */
export function medianSortedF64(sorted) {
  const n = sorted.length
  if (n === 0) return NaN
  const h = n >> 1
  if (n % 2 === 1) return sorted[h]
  return (sorted[h - 1] + sorted[h]) / 2
}

/** np.median of a float32 array (float32 arithmetic for the middle pair). */
export function medianF32(values) {
  const n = values.length
  if (n === 0) return NaN
  const s = Float32Array.from(values).sort()
  if (Number.isNaN(s[n - 1])) return NaN
  const h = n >> 1
  if (n % 2 === 1) return s[h]
  return Math.fround(s[h - 1] + s[h]) / 2
}

/** np.linspace(start, stop, num) (endpoint=True) as Float64Array. */
export function linspace(start, stop, num) {
  const y = new Float64Array(num)
  if (num <= 0) return y
  const div = num - 1
  const delta = stop - start
  if (div > 0) {
    const step = delta / div
    if (step === 0) {
      for (let i = 0; i < num; i++) y[i] = (i / div) * delta + start
    } else {
      for (let i = 0; i < num; i++) y[i] = i * step + start
    }
  } else {
    y[0] = 0 * delta + start
  }
  if (num > 1) y[num - 1] = stop
  return y
}

/** np.logspace(start, stop, num) with base 10. */
export function logspace10(start, stop, num) {
  const y = linspace(start, stop, num)
  for (let i = 0; i < num; i++) y[i] = Math.pow(10, y[i])
  return y
}

/** Stable argsort of keys[0..n) ascending (ties keep the original order). */
export function stableArgsortF64(keys, n = keys.length) {
  const idx = new Int32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  idx.sort((a, b) => {
    const ka = keys[a]
    const kb = keys[b]
    if (ka < kb) return -1
    if (ka > kb) return 1
    return a - b
  })
  return idx
}

/** np.searchsorted(sortedArr, v, side) for a scalar v; side is 'left' (default) or 'right'. */
export function searchsorted(sortedArr, v, side = 'left') {
  let lo = 0
  let hi = sortedArr.length
  if (side === 'right') {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (v < sortedArr[mid]) hi = mid
      else lo = mid + 1
    }
  } else {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sortedArr[mid] < v) lo = mid + 1
      else hi = mid
    }
  }
  return lo
}

const BLOCK = 65536

/**
 * np.histogram(values, bins=edges, weights=weights)[0] for explicit (non-uniform) edges:
 * numpy's cumulative path (stable sort here, numpy's default sort is unstable).
 * weights may be null (counts). Returns Float64Array(edges.length - 1).
 */
export function histogramEdges(values, weights, edges) {
  const nE = edges.length
  const cumN = new Float64Array(nE)
  const total = values.length
  for (let i0 = 0; i0 < total; i0 += BLOCK) {
    const i1 = Math.min(total, i0 + BLOCK)
    const m = i1 - i0
    const tmp = new Float64Array(m)
    for (let i = 0; i < m; i++) tmp[i] = values[i0 + i]
    const order = stableArgsortF64(tmp, m)
    const sa = new Float64Array(m)
    for (let i = 0; i < m; i++) sa[i] = tmp[order[i]]
    let cw = null
    if (weights) {
      cw = new Float64Array(m + 1)
      let acc = 0
      for (let i = 0; i < m; i++) {
        acc += weights[i0 + order[i]]
        cw[i + 1] = acc
      }
    }
    for (let e = 0; e < nE; e++) {
      const b = searchsorted(sa, edges[e], e === nE - 1 ? 'right' : 'left')
      cumN[e] += cw ? cw[b] : b
    }
  }
  const out = new Float64Array(Math.max(nE - 1, 0))
  for (let e = 0; e < out.length; e++) out[e] = cumN[e + 1] - cumN[e]
  return out
}

/**
 * np.histogram(values, bins=nBins, range=(lo, hi), weights=weights): numpy's equal-width
 * fast path. Returns { hist: Float64Array(nBins), edges: Float64Array(nBins + 1) }.
 */
export function histogramUniform(values, weights, nBins, lo, hi) {
  const edges = linspace(lo, hi, nBins + 1)
  const hist = new Float64Array(nBins)
  const total = values.length
  const denom = hi - lo
  for (let i0 = 0; i0 < total; i0 += BLOCK) {
    const i1 = Math.min(total, i0 + BLOCK)
    const blk = new Float64Array(nBins)
    for (let i = i0; i < i1; i++) {
      const v = values[i]
      if (!(v >= lo && v <= hi)) continue
      let idx = Math.trunc(((v - lo) / denom) * nBins)
      if (idx === nBins) idx -= 1
      if (v < edges[idx]) idx -= 1
      if (v >= edges[idx + 1] && idx !== nBins - 1) idx += 1
      blk[idx] += weights ? weights[i] : 1
    }
    for (let b = 0; b < nBins; b++) hist[b] += blk[b]
  }
  return { hist, edges }
}

// ---- near-correctly-rounded log10 (double-double) -------------------------------------------
// V8's Math.log10 differs from libm's (numpy) in ~27 % of inputs by 1 ulp, which moves the first and
// last log-histogram edges (10**log10(x) vs x). glibc/numpy are correctly rounded in ~99.5 % of
// cases, so a double-double evaluation matches numpy far more often.
const SPLIT = 134217729 // 2^27 + 1

function twoSum(a, b) {
  const s = a + b
  const bb = s - a
  return [s, (a - (s - bb)) + (b - bb)]
}

function twoProd(a, b) {
  const p = a * b
  let t = SPLIT * a
  const ah = t - (t - a)
  const al = a - ah
  t = SPLIT * b
  const bh = t - (t - b)
  const bl = b - bh
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl]
}

function ddAdd(a, b) {
  const [s, e] = twoSum(a[0], b[0])
  const lo = e + a[1] + b[1]
  const hi = s + lo
  return [hi, lo - (hi - s)]
}

function ddMul(a, b) {
  const [p, e] = twoProd(a[0], b[0])
  const lo = e + (a[0] * b[1] + a[1] * b[0])
  const hi = p + lo
  return [hi, lo - (hi - p)]
}

function ddDiv(a, b) {
  const q1 = a[0] / b[0]
  const [p, pe] = twoProd(q1, b[0])
  let r = ddAdd(a, [-p, -pe])
  r = ddAdd(r, [-q1 * b[1], 0])
  const q2 = r[0] / b[0]
  const hi = q1 + q2
  return [hi, q2 - (hi - q1)]
}

const LN2_DD = [0.6931471805599453, 2.3190468138462996e-17]
const INV_LN10_DD = [0.4342944819032518, 1.098319650216765e-17]
const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)

/** log10(x) accurate to well under 1 ulp (matches numpy's log10 in ~99.5 % of inputs). */
export function log10Accurate(x) {
  if (!(x > 0) || !Number.isFinite(x) || x < 2.2250738585072014e-308) return Math.log10(x)
  // x = m * 2^e with m in [sqrt(1/2), sqrt(2))
  f64[0] = x
  let e = ((u32[1] >>> 20) & 0x7ff) - 1023
  u32[1] = (u32[1] & 0x000fffff) | 0x3ff00000 // m in [1, 2)
  let m = f64[0]
  if (m > Math.SQRT2) { m /= 2; e += 1 }
  const num = [m - 1, 0] // exact
  const den = twoSum(m, 1)
  const s = ddDiv(num, den)
  const s2 = ddMul(s, s)
  let term = s
  let sum = s
  for (let k = 1; k < 40; k++) {
    term = ddMul(term, s2)
    const t = ddDiv(term, [2 * k + 1, 0])
    sum = ddAdd(sum, t)
    if (Math.abs(t[0]) < 1e-36 * Math.abs(sum[0]) || t[0] === 0) break
  }
  const lnM = [2 * sum[0], 2 * sum[1]]
  const lnX = ddAdd(lnM, ddMul(LN2_DD, [e, 0]))
  const r = ddMul(lnX, INV_LN10_DD)
  return r[0] + r[1]
}

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15,
  1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22]

function pow10(k) {
  if (Number.isInteger(k) && k >= -22 && k <= 22) return k >= 0 ? POW10[k] : 1 / POW10[-k]
  return Math.pow(10, k)
}

/** main.py _sig6: round to 6 significant digits; non-finite values become null. */
export function sig6(values) {
  const n = values.length
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = values[i]
    if (!Number.isFinite(a)) {
      out[i] = null
    } else if (a === 0) {
      out[i] = a
    } else {
      const mag = Math.floor(Math.log10(Math.abs(a)))
      const f = pow10(5 - mag)
      out[i] = roundHalfEven(a * f) / f
    }
  }
  return out
}

/** Deep copy replacing non-finite numbers with null and typed arrays with plain arrays (main.py _finite). */
export function finiteOrNull(obj) {
  if (typeof obj === 'number') return Number.isFinite(obj) ? obj : null
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj
  if (ArrayBuffer.isView(obj)) {
    const n = obj.length
    const out = new Array(n)
    for (let i = 0; i < n; i++) out[i] = finiteOrNull(obj[i])
    return out
  }
  if (Array.isArray(obj)) return obj.map(finiteOrNull)
  const out = {}
  for (const k of Object.keys(obj)) out[k] = finiteOrNull(obj[k])
  return out
}
