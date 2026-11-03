// Illumination flattening and contrast-based threshold selection (port of background.py).
//
// Float32 sites mirror numpy exactly (see COMMON.md section 6): every float32 operation is
// wrapped in Math.fround and the float32 matmul is the sequential chain
// acc = fround(P[k]*X[k] + acc), k = 0..degree, starting from 0.
import { fround, medianF32, medianSortedF64, percentileLinear, linspace } from './np.js'

const CLIP_GAIN_LO = 0.5
const CLIP_GAIN_HI = 1.5
const HALF_CONTRAST_BOUNDS = [50.0, 80.0]
const MIN_CONTRAST_CLUSTERS = 10
const CONTRAST_CLUSTER_MIN_PIXELS = 150
const MAX_CONTRAST_CLUSTERS = 600
const MAX_FIT_POINTS = 60000

/** _dilate3: 3x3 cross-free box dilation exactly as the numpy slice assignments compose. */
function dilate3(mask, R, C) {
  const out = new Uint8Array(R * C)
  // rows first
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const p = r * C + c
      let v = mask[p]
      if (r > 0) v |= mask[p - C]
      if (r < R - 1) v |= mask[p + C]
      out[p] = v
    }
  }
  // then columns on the already row-dilated array
  const t = new Uint8Array(C)
  for (let r = 0; r < R; r++) {
    const o = r * C
    t[0] = out[o]
    for (let c = 1; c < C; c++) t[c] = out[o + c] | out[o + c - 1]
    for (let c = 0; c < C; c++) out[o + c] = t[c] | (c < C - 1 ? t[c + 1] : 0)
  }
  return out
}

/**
 * Normal equations G = A^T A, g = A^T z (A: m x k row-major, optional row keep mask), with
 * Neumaier-compensated accumulation, solved by Gaussian elimination with partial pivoting.
 */
function solveNormal(A, z, m, k, keep) {
  const nG = k * k
  const gS = new Float64Array(nG)
  const gC = new Float64Array(nG)
  const bS = new Float64Array(k)
  const bC = new Float64Array(k)
  for (let r = 0; r < m; r++) {
    if (keep && !keep[r]) continue
    const o = r * k
    const zr = z[r]
    for (let i = 0; i < k; i++) {
      const ai = A[o + i]
      // rhs
      {
        const x = ai * zr
        const s = bS[i]
        const t = s + x
        bC[i] += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s
        bS[i] = t
      }
      for (let j = i; j < k; j++) {
        const x = ai * A[o + j]
        const idx = i * k + j
        const s = gS[idx]
        const t = s + x
        gC[idx] += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s
        gS[idx] = t
      }
    }
  }
  // augmented matrix
  const w = k + 1
  const M = new Float64Array(k * w)
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      const v = gS[i * k + j] + gC[i * k + j]
      M[i * w + j] = v
      M[j * w + i] = v
    }
    M[i * w + k] = bS[i] + bC[i]
  }
  for (let col = 0; col < k; col++) {
    let piv = col
    let best = Math.abs(M[col * w + col])
    for (let r = col + 1; r < k; r++) {
      const v = Math.abs(M[r * w + col])
      if (v > best) { best = v; piv = r }
    }
    if (piv !== col) {
      for (let j = 0; j < w; j++) {
        const tmp = M[col * w + j]
        M[col * w + j] = M[piv * w + j]
        M[piv * w + j] = tmp
      }
    }
    const d = M[col * w + col]
    for (let r = col + 1; r < k; r++) {
      const f = M[r * w + col] / d
      if (f === 0) continue
      for (let j = col; j < w; j++) M[r * w + j] -= f * M[col * w + j]
    }
  }
  const x = new Float64Array(k)
  for (let i = k - 1; i >= 0; i--) {
    let s = M[i * w + k]
    for (let j = i + 1; j < k; j++) s -= M[i * w + j] * x[j]
    x[i] = s / M[i * w + i]
  }
  return x
}

/** numpy-style `v ** j` for float64 v and small integer j. */
function powInt(v, j) {
  if (j === 0) return 1
  if (j === 1) return v
  if (j === 2) return v * v
  return Math.pow(v, j)
}

/**
 * Divide out a smooth illumination field (2D polynomial fit on background pixels).
 * Returns { blue: Uint8Array, info } where info = { applied, reference_level?, n_fit_points?, coef? }.
 * `coefOverride` (Float64Array of (degree+1)(degree+2)/2) replaces both solves (used for exact parity tests).
 */
export function flattenBlue(blue, h, w, polygonMask, globalThresholdPercent, { degree = 4, step = 4, coefOverride = null } = {}) {
  const rows = h
  const cols = w
  const info = { applied: false }
  const R = Math.ceil(rows / step)
  const C = Math.ceil(cols / step)
  const bs = new Float32Array(R * C) // exact small integers
  let ms = null
  let msAny = false
  if (polygonMask) ms = new Uint8Array(R * C)
  for (let r = 0; r < R; r++) {
    const src = r * step * cols
    for (let c = 0; c < C; c++) {
      bs[r * C + c] = blue[src + c * step]
      if (ms) {
        const v = polygonMask[src + c * step]
        ms[r * C + c] = v
        if (v) msAny = true
      }
    }
  }
  let ref0
  if (ms && msAny) {
    let cnt = 0
    for (let i = 0; i < ms.length; i++) cnt += ms[i]
    const sub = new Float32Array(cnt)
    let q = 0
    for (let i = 0; i < ms.length; i++) if (ms[i]) sub[q++] = bs[i]
    ref0 = medianF32(sub)
  } else {
    ref0 = medianF32(bs)
  }
  // NEP 50: float32 array < python float compares against the float32-rounded scalar
  const thr = fround((ref0 * globalThresholdPercent) / 100.0)
  const lowMask = new Uint8Array(R * C)
  for (let i = 0; i < lowMask.length; i++) lowMask[i] = bs[i] < thr ? 1 : 0
  const dark = dilate3(lowMask, R, C)
  const valid = new Uint8Array(R * C)
  let nValid = 0
  for (let i = 0; i < valid.length; i++) {
    const v = ms ? (!dark[i] && ms[i] ? 1 : 0) : (dark[i] ? 0 : 1)
    valid[i] = v
    nValid += v
  }
  if (nValid < 10 * (degree + 1) * (degree + 2)) return { blue, info }

  const ys = new Float64Array(R)
  const xs = new Float64Array(C)
  for (let k = 0; k < R; k++) ys[k] = ((k * step) / rows) * 2.0 - 1.0
  for (let k = 0; k < C; k++) xs[k] = ((k * step) / cols) * 2.0 - 1.0
  let vy = new Int32Array(nValid)
  let vx = new Int32Array(nValid)
  {
    let q = 0
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (valid[r * C + c]) { vy[q] = r; vx[q] = c; q++ }
  }
  let m = nValid
  if (m > MAX_FIT_POINTS) {
    const pick = linspace(0, m - 1, MAX_FIT_POINTS)
    const py = new Int32Array(MAX_FIT_POINTS)
    const px = new Int32Array(MAX_FIT_POINTS)
    for (let i = 0; i < MAX_FIT_POINTS; i++) {
      const s = Math.trunc(pick[i])
      py[i] = vy[s]
      px[i] = vx[s]
    }
    vy = py
    vx = px
    m = MAX_FIT_POINTS
  }
  const terms = []
  for (let i = 0; i <= degree; i++) for (let j = 0; j <= degree - i; j++) terms.push([i, j])
  const nT = terms.length
  const A = new Float64Array(m * nT)
  const z = new Float64Array(m)
  const xp = new Float64Array(degree + 1)
  const yp = new Float64Array(degree + 1)
  for (let p = 0; p < m; p++) {
    const X = xs[vx[p]]
    const Y = ys[vy[p]]
    xp[0] = 1
    yp[0] = 1
    for (let d = 1; d <= degree; d++) {
      xp[d] = xp[d - 1] * X
      yp[d] = yp[d - 1] * Y
    }
    for (let t = 0; t < nT; t++) A[p * nT + t] = xp[terms[t][0]] * yp[terms[t][1]]
    z[p] = bs[vy[p] * C + vx[p]]
  }

  let coef
  if (coefOverride) coef = Float64Array.from(coefOverride)
  else coef = solveNormal(A, z, m, nT, null)
  const absResid = new Float64Array(m)
  const resid = new Float64Array(m)
  for (let p = 0; p < m; p++) {
    let s = 0
    for (let t = 0; t < nT; t++) s += A[p * nT + t] * coef[t]
    resid[p] = z[p] - s
    absResid[p] = Math.abs(resid[p])
  }
  const sorted = Float64Array.from(absResid).sort()
  const sigma = 1.4826 * medianSortedF64(sorted) + 1e-6
  const keep = new Uint8Array(m)
  let keepCount = 0
  for (let p = 0; p < m; p++) {
    const k = absResid[p] < 3.0 * sigma ? 1 : 0
    keep[p] = k
    keepCount += k
  }
  if (!coefOverride && keepCount > 5 * nT) coef = solveNormal(A, z, m, nT, keep)

  // C[i][j] = coef[t]
  const Cm = new Float64Array((degree + 1) * (degree + 1))
  for (let t = 0; t < nT; t++) Cm[terms[t][0] * (degree + 1) + terms[t][1]] = coef[t]
  const D = degree + 1
  // P[r][i] = fround(sum_j C[i][j] * y^j), xpow[i][c] = fround(x^i)
  const P = new Float32Array(rows * D)
  for (let r = 0; r < rows; r++) {
    const y = (r / rows) * 2.0 - 1.0
    for (let i = 0; i < D; i++) {
      let s = 0
      for (let j = 0; j < D; j++) s += powInt(y, j) * Cm[i * D + j]
      P[r * D + i] = s
    }
  }
  const xpow = new Float32Array(D * cols)
  for (let c = 0; c < cols; c++) {
    const x = (c / cols) * 2.0 - 1.0
    for (let i = 0; i < D; i++) xpow[i * cols + c] = powInt(x, i)
  }

  // reference level: median of the model over the (strided) analysis area
  const Bs = new Float32Array(R * C)
  for (let r = 0; r < R; r++) {
    const pr = r * step * D
    for (let c = 0; c < C; c++) {
      const cc = c * step
      let acc = 0
      for (let i = 0; i < D; i++) acc = fround(P[pr + i] * xpow[i * cols + cc] + acc)
      Bs[r * C + c] = acc
    }
  }
  let ref
  if (ms && msAny) {
    let cnt = 0
    for (let i = 0; i < ms.length; i++) cnt += ms[i]
    const sub = new Float32Array(cnt)
    let q = 0
    for (let i = 0; i < ms.length; i++) if (ms[i]) sub[q++] = Bs[i]
    ref = medianF32(sub)
  } else {
    ref = medianF32(Bs)
  }
  if (!Number.isFinite(ref) || ref <= 1.0) return { blue, info }

  const out = new Uint8Array(rows * cols)
  const fref = fround(ref)
  const row = new Float32Array(cols)
  for (let r = 0; r < rows; r++) {
    const pr = r * D
    // Bm = P[r] @ xpow (float32 sequential chain)
    for (let c = 0; c < cols; c++) {
      let acc = 0
      for (let i = 0; i < D; i++) acc = fround(P[pr + i] * xpow[i * cols + c] + acc)
      row[c] = acc
    }
    const o = r * cols
    for (let c = 0; c < cols; c++) {
      let b = row[c]
      if (!(b >= 1.0)) b = Number.isNaN(b) ? b : 1.0 // np.maximum(Bm, 1.0), NaN propagates
      let g = fround(fref / b)
      if (g < CLIP_GAIN_LO) g = CLIP_GAIN_LO
      else if (g > CLIP_GAIN_HI) g = CLIP_GAIN_HI
      let v = fround(g * blue[o + c])
      v = fround(v + 0.5)
      if (v < 0) v = 0
      else if (v > 255) v = 255
      out[o + c] = v // Uint8Array store truncates, like the float32 -> uint8 cast
    }
  }
  info.applied = true
  info.reference_level = ref
  info.n_fit_points = keepCount
  info.coef = coef
  return { blue: out, info }
}

/**
 * Threshold (percent of background) halfway between background and particle intensity.
 * Ip is the median over big preliminary clusters (> 150 px) of each cluster's 5th-percentile blue.
 * Returns [percent, { n_contrast_clusters, contrast_particle_intensity }].
 */
export function halfContrastPercent(blue, width, ds, background, fallbackPercent) {
  let big = []
  for (let i = 0; i < ds.n; i++) if (ds.px_len[i] > CONTRAST_CLUSTER_MIN_PIXELS) big.push(i)
  const info = { n_contrast_clusters: big.length, contrast_particle_intensity: null }
  if (big.length < MIN_CONTRAST_CLUSTERS || background <= 0) return [Number(fallbackPercent), info]
  if (big.length > MAX_CONTRAST_CLUSTERS) {
    const pick = linspace(0, big.length - 1, MAX_CONTRAST_CLUSTERS)
    const sel = new Array(MAX_CONTRAST_CLUSTERS)
    for (let i = 0; i < MAX_CONTRAST_CLUSTERS; i++) sel[i] = big[Math.trunc(pick[i])]
    big = sel
  }
  const p5 = new Float64Array(big.length)
  for (let k = 0; k < big.length; k++) {
    const ci = big[k]
    const s = ds.px_start[ci]
    const len = ds.px_len[ci]
    const vals = new Uint8Array(len)
    for (let j = 0; j < len; j++) vals[j] = blue[ds.px_row[s + j] * width + ds.px_col[s + j]]
    vals.sort()
    p5[k] = percentileLinear(vals, 5)
  }
  const ip = medianSortedF64(Float64Array.from(p5).sort())
  info.contrast_particle_intensity = ip
  const pct = ((100.0 * 0.5) * (background + ip)) / background
  const [lo, hi] = HALF_CONTRAST_BOUNDS
  return [Math.min(Math.max(pct, lo), hi), info]
}
