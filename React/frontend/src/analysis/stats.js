// Statistics helpers (port of cloudrun/coffeegrindsize_core/stats.py).
//
// Summation orders follow numpy (np.sum = pairwise, np.cumsum = sequential). numpy's default
// np.argsort is unstable; here stableArgsortF64 is used, so ties between equal values with
// different weights may give tiny differences (COMMON.md section 6).
import {
  npSum, cumsum, interp, percentileLinear, stableArgsortF64, histogramUniform, roundHalfEven,
} from './np.js'
import { mulberry32 } from './prng.js'

export const MAX_EDGE_WEIGHT = 10.0
export const BOOTSTRAP_B = 200
export const FINES_RELIABLE_LIMIT_UM = 100.0

function sortedCopy(values) {
  return Float64Array.from(values).sort()
}

/**
 * Percentiles of `values` where each sample counts in proportion to `weights` (midpoint rule).
 * Returns number[] with one entry per requested percentile.
 */
export function weightedPercentiles(values, weights, ps) {
  const n = values.length
  const order = stableArgsortF64(values, n)
  const sv = new Float64Array(n)
  const sw = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    sv[i] = values[order[i]]
    sw[i] = weights[order[i]]
  }
  const cum = cumsum(sw)
  const total = cum[n - 1]
  if (total <= 0) {
    return Array.from(ps, p => percentileLinear(sv, p))
  }
  const pos = new Float64Array(n)
  for (let i = 0; i < n; i++) pos[i] = ((cum[i] - 0.5 * sw[i]) / total) * 100.0
  return Array.from(ps, p => interp(p, pos, sv))
}

/** Diameter (um) of a disc of `minSurface` pixels. */
export function detectionLimitUm(minSurface, pixelScale) {
  return (2000.0 * Math.sqrt(Math.max(minSurface, 0.0) / Math.PI)) / pixelScale
}

/** Diameter (um) of ~6 pixels, below which sizes are biased (blur/thresholding). */
export function reliableLimitUm(pixelScale) {
  return 6000.0 / pixelScale
}

/** Weighted geometric mean and geometric standard deviation: [gm, gsd]. */
export function geometricStats(values, weights) {
  const n = values.length
  const w = Float64Array.from(weights)
  const ln = new Float64Array(n)
  for (let i = 0; i < n; i++) ln[i] = Math.log(values[i])
  const total = npSum(w)
  const prod = new Float64Array(n)
  for (let i = 0; i < n; i++) prod[i] = w[i] * ln[i]
  const gmLn = npSum(prod) / total
  for (let i = 0; i < n; i++) {
    const d = ln[i] - gmLn
    prod[i] = w[i] * (d * d)
  }
  const variance = npSum(prod) / total
  return [Math.exp(gmLn), Math.exp(Math.sqrt(Math.max(variance, 0.0)))]
}

// np.convolve(hist, kernel, 'same') for a length-5 kernel: out[i] = sum_j hist[i + j - 2] * k[j]
function convolveSame5(hist, kernel) {
  const n = hist.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let j = 0; j < 5; j++) {
      const s = i + j - 2
      if (s >= 0 && s < n) acc += hist[s] * kernel[4 - j]
    }
    out[i] = acc
  }
  return out
}

/** Peak of the smoothed, log-binned weighted size histogram (centre of the peak bin), or null. */
export function volumeMode(values, weights, binsPerDecade = 40) {
  const n = values.length
  let count = 0
  for (let i = 0; i < n; i++) if (values[i] > 0) count++
  if (count < 3) return null
  const ln = new Float64Array(count)
  const w = new Float64Array(count)
  let first = null
  let q = 0
  for (let i = 0; i < n; i++) {
    if (values[i] > 0) {
      if (first === null) first = values[i]
      ln[q] = Math.log10(values[i])
      w[q] = weights[i]
      q++
    }
  }
  let lo = ln[0]
  let hi = ln[0]
  for (let i = 1; i < count; i++) {
    if (ln[i] < lo) lo = ln[i]
    if (ln[i] > hi) hi = ln[i]
  }
  if (hi - lo < 1e-9) return first
  const nBins = Math.max(Math.ceil((hi - lo) * binsPerDecade), 8)
  const { hist, edges } = histogramUniform(ln, w, nBins, lo, hi)
  const kernel = Float64Array.from([1.0, 2.0, 3.0, 2.0, 1.0], v => v / 9.0)
  const smooth = convolveSame5(hist, kernel)
  let peak = 0
  for (let i = 1; i < smooth.length; i++) if (smooth[i] > smooth[peak]) peak = i
  return Math.pow(10.0, 0.5 * (edges[peak] + edges[peak + 1]))
}

/**
 * Seeded bootstrap 95 % interval of weighted percentiles (resampling particles).
 * Returns [[lo, hi], ...] with one pair per percentile. Uses mulberry32(seed), one stream for all
 * resamples, so it is deterministic but not equal to numpy's default_rng.
 */
export function bootstrapPercentileCi(values, weights, ps = [10.0, 50.0, 90.0], nBoot = BOOTSTRAP_B, seed = 0) {
  const n = values.length
  const order = stableArgsortF64(values, n)
  const sv = new Float64Array(n)
  const sw = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    sv[i] = values[order[i]]
    sw[i] = weights[order[i]]
  }
  const rng = mulberry32(seed)
  const nP = ps.length
  const out = new Float64Array(nBoot * nP)
  const counts = new Int32Array(n)
  const wb = new Float64Array(n)
  const pos = new Float64Array(n)
  for (let b = 0; b < nBoot; b++) {
    counts.fill(0)
    for (let i = 0; i < n; i++) counts[Math.floor(rng() * n)]++
    let acc = 0
    for (let i = 0; i < n; i++) {
      wb[i] = sw[i] * counts[i]
      acc += wb[i]
      pos[i] = acc // cumulative for now
    }
    const total = acc
    if (total <= 0) {
      for (let k = 0; k < nP; k++) out[b * nP + k] = NaN
      continue
    }
    for (let i = 0; i < n; i++) pos[i] = ((pos[i] - 0.5 * wb[i]) / total) * 100.0
    for (let k = 0; k < nP; k++) out[b * nP + k] = interp(ps[k], pos, sv)
  }
  const result = []
  const col = new Float64Array(nBoot)
  for (let k = 0; k < nP; k++) {
    let m = 0
    for (let b = 0; b < nBoot; b++) {
      const v = out[b * nP + k]
      if (!Number.isNaN(v)) col[m++] = v
    }
    if (m === 0) {
      result.push([NaN, NaN])
      continue
    }
    const s = col.slice(0, m).sort()
    result.push([percentileLinear(s, 2.5), percentileLinear(s, 97.5)])
  }
  return result
}

/** Relative 1-sigma uncertainty of the px/mm scale from two imprecise clicks, or null. */
export function scaleRelativeUncertainty(referencePxLength, clickSigmaPx) {
  if (referencePxLength == null || !Number.isFinite(referencePxLength) || referencePxLength <= 0) return null
  return (Math.SQRT2 * clickSigmaPx) / referencePxLength
}

/** Mean/median and percentile spread of a (weighted) distribution. Same keys as stats.distribution_stats. */
export function distributionStats(values, weights = null) {
  const nAll = values.length
  const vArr = []
  const wArr = []
  for (let i = 0; i < nAll; i++) {
    const v = values[i]
    const wi = weights == null ? 1 : weights[i]
    if (Number.isFinite(v) && Number.isFinite(wi) && wi >= 0) {
      vArr.push(v)
      wArr.push(wi)
    }
  }
  const v = Float64Array.from(vArr)
  const w = Float64Array.from(wArr)
  const n = v.length
  const wSum = npSum(w)
  if (n === 0 || wSum <= 0) {
    const err = new Error('No data available for distribution statistics.')
    err.status = 400
    throw err
  }
  const prod = new Float64Array(n)
  for (let i = 0; i < n; i++) prod[i] = v[i] * w[i]
  const mean = npSum(prod) / wSum
  const [p16, p25, p50, p75, p84] = weightedPercentiles(v, w, [16, 25, 50, 75, 84])
  for (let i = 0; i < n; i++) prod[i] = w[i] * w[i]
  return {
    mean, mean_upper: p84 - mean, mean_lower: mean - p16,
    median: p50, median_upper: p75 - p50, median_lower: p50 - p25,
    mean_spread_upper: p84 - mean, mean_spread_lower: mean - p16,
    median_spread_upper: p75 - p50, median_spread_lower: p50 - p25,
    p16, p25, p75, p84,
    n, n_eff: (wSum * wSum) / npSum(prod),
  }
}

/**
 * Miles-Lantuejoul weights for particles rejected when touching the region border.
 * `ds` is a Dataset (px_row = image rows, px_col = columns), shape = [rows, cols].
 */
export function edgeWeights(ds, shape, polygonMask = null) {
  const n = ds.n
  const [rows, cols] = shape
  if (n === 0) return new Float64Array(0)
  const bh = new Float64Array(n)
  const bw = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const s = ds.px_start[k]
    const e = s + ds.px_len[k]
    let rmin = Infinity, rmax = -Infinity, cmin = Infinity, cmax = -Infinity
    for (let j = s; j < e; j++) {
      const r = ds.px_row[j]
      const c = ds.px_col[j]
      if (r < rmin) rmin = r
      if (r > rmax) rmax = r
      if (c < cmin) cmin = c
      if (c > cmax) cmax = c
    }
    bh[k] = rmax - rmin + 1
    bw[k] = cmax - cmin + 1
  }
  const out = new Float64Array(n)
  if (!polygonMask) {
    for (let k = 0; k < n; k++) {
      const denom = Math.max(cols - bw[k], 1.0) * Math.max(rows - bh[k], 1.0)
      out[k] = Math.min((rows * cols) / denom, MAX_EDGE_WEIGHT)
    }
    return out
  }

  const f = Math.max(1, Math.ceil(Math.sqrt((rows * cols) / 250000.0)))
  const mR = Math.ceil(rows / f)
  const mC = Math.ceil(cols / f)
  const sw = mC + 1
  const sat = new Int32Array((mR + 1) * sw)
  let aPoly = 0
  for (let i = 0; i < mR; i++) {
    let rowAcc = 0
    for (let j = 0; j < mC; j++) {
      const v = polygonMask[i * f * cols + j * f]
      rowAcc += v
      aPoly += v
      sat[(i + 1) * sw + (j + 1)] = sat[i * sw + (j + 1)] + rowAcc
    }
  }
  if (aPoly <= 0) return out.fill(1)

  const anchors = (h0, w0) => {
    const h = Math.min(h0, mR)
    const w = Math.min(w0, mC)
    const target = h * w
    let count = 0
    for (let i = 0; i + h <= mR; i++) {
      const top = i * sw
      const bot = (i + h) * sw
      for (let j = 0; j + w <= mC; j++) {
        if (sat[bot + j + w] - sat[top + j + w] - sat[bot + j] + sat[top + j] === target) count++
      }
    }
    return count
  }

  const cache = new Map()
  for (let k = 0; k < n; k++) {
    const binH = roundHalfEven(2.0 * Math.log2(Math.max(bh[k], 1.0)))
    const binW = roundHalfEven(2.0 * Math.log2(Math.max(bw[k], 1.0)))
    const key = binH * 4096 + binW
    let wgt = cache.get(key)
    if (wgt === undefined) {
      const h = Math.max(1, roundHalfEven(Math.pow(2.0, binH / 2.0) / f))
      const w = Math.max(1, roundHalfEven(Math.pow(2.0, binW / 2.0) / f))
      const cnt = anchors(h, w)
      wgt = cnt <= 0 ? MAX_EDGE_WEIGHT : Math.min(aPoly / cnt, MAX_EDGE_WEIGHT)
      cache.set(key, wgt)
    }
    out[k] = wgt
  }
  return out
}
