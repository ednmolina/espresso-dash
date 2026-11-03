// Pillow LANCZOS resize (8-bit, one channel), a port of Pillow's Resample.c (two-pass separable
// convolution with 22-bit fixed-point coefficients, horizontal pass first). Channels of an RGB
// image are independent, so resizing the blue channel alone equals Image.resize(...).split()[2].
const PRECISION_BITS = 32 - 8 - 2
const SUPPORT = 3.0

function sincFilter(x) {
  if (x === 0.0) return 1.0
  const px = x * Math.PI
  return Math.sin(px) / px
}

function lanczosFilter(x) {
  if (x >= -3.0 && x < 3.0) return sincFilter(x) * sincFilter(x / 3)
  return 0.0
}

/** precompute_coeffs + normalize_coeffs_8bpc. Returns { ksize, bounds: Int32Array(2*out), kk: Int32Array(out*ksize) }. */
function precomputeCoeffs(inSize, outSize) {
  const scale = inSize / outSize
  const filterscale = scale < 1.0 ? 1.0 : scale
  const support = SUPPORT * filterscale
  const ksize = Math.ceil(support) * 2 + 1
  const bounds = new Int32Array(outSize * 2)
  const kk = new Int32Array(outSize * ksize)
  const pre = new Float64Array(ksize)
  const ss = 1.0 / filterscale
  const one = 1 << PRECISION_BITS
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale
    let xmin = Math.trunc(center - support + 0.5)
    if (xmin < 0) xmin = 0
    let xmax = Math.trunc(center + support + 0.5)
    if (xmax > inSize) xmax = inSize
    xmax -= xmin
    let ww = 0.0
    pre.fill(0)
    for (let x = 0; x < xmax; x++) {
      const w = lanczosFilter((x + xmin - center + 0.5) * ss)
      pre[x] = w
      ww += w
    }
    for (let x = 0; x < xmax; x++) {
      if (ww !== 0.0) pre[x] /= ww
    }
    const o = xx * ksize
    for (let x = 0; x < ksize; x++) {
      const v = pre[x]
      kk[o + x] = v < 0 ? Math.trunc(-0.5 + v * one) : Math.trunc(0.5 + v * one)
    }
    bounds[xx * 2] = xmin
    bounds[xx * 2 + 1] = xmax
  }
  return { ksize, bounds, kk }
}

function clip8(ss) {
  const v = ss >> PRECISION_BITS
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function horizontalPass(src, w, firstRow, rows, newW, { ksize, bounds, kk }) {
  const half = 1 << (PRECISION_BITS - 1)
  const out = new Uint8Array(rows * newW)
  for (let r = 0; r < rows; r++) {
    const inBase = (r + firstRow) * w
    const outBase = r * newW
    for (let xx = 0; xx < newW; xx++) {
      const xmin = bounds[xx * 2]
      const xmax = bounds[xx * 2 + 1]
      const k = xx * ksize
      let ss = half
      for (let x = 0; x < xmax; x++) ss += src[inBase + xmin + x] * kk[k + x]
      out[outBase + xx] = clip8(ss)
    }
  }
  return out
}

function verticalPass(src, w, rowShift, newH, { ksize, bounds, kk }) {
  const half = 1 << (PRECISION_BITS - 1)
  const out = new Uint8Array(w * newH)
  for (let yy = 0; yy < newH; yy++) {
    const ymin = bounds[yy * 2] - rowShift
    const ymax = bounds[yy * 2 + 1]
    const k = yy * ksize
    const outBase = yy * w
    for (let xx = 0; xx < w; xx++) {
      let ss = half
      for (let y = 0; y < ymax; y++) ss += src[(y + ymin) * w + xx] * kk[k + y]
      out[outBase + xx] = clip8(ss)
    }
  }
  return out
}

/**
 * Resize a single-channel Uint8Array (row-major, `w` x `h`) to newW x newH with Pillow's LANCZOS filter.
 * Returns a new Uint8Array(newW * newH); when the size is unchanged a copy is returned.
 * Pass order as in Pillow's ImagingResampleInner: horizontal first, unless the height shrinks by
 * more than twice as many pixels as the width (then vertical first).
 */
export function resizeLanczosU8(src, w, h, newW, newH) {
  const needH = newW !== w
  const needV = newH !== h
  if (!needH && !needV) return Uint8Array.from(src)
  const horizontalFirst = !((h - newH) > 0 && (h - newH) > (w - newW) * 2)
  const hc = needH ? precomputeCoeffs(w, newW) : null
  const vc = needV || (needH && horizontalFirst) ? precomputeCoeffs(h, newH) : null
  if (horizontalFirst) {
    let cur = src
    let rowShift = 0
    if (needH) {
      // only the source rows used by the vertical pass are needed (bounds_vert[0] .. last)
      const vb = vc.bounds
      const yboxFirst = vb[0]
      const yboxLast = vb[newH * 2 - 2] + vb[newH * 2 - 1]
      cur = horizontalPass(src, w, yboxFirst, yboxLast - yboxFirst, newW, hc)
      rowShift = yboxFirst
    }
    if (!needV) return cur
    return verticalPass(cur, needH ? newW : w, rowShift, newH, vc)
  }
  let cur = verticalPass(src, w, 0, newH, vc)
  if (needH) cur = horizontalPass(cur, w, 0, newH, newW, hc)
  return cur
}
