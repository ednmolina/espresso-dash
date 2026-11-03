// Verbatim JS ports of cloudrun/coffeegrindsize_core/_kernels.py.
//
// Conventions (see COMMON.md): images are row-major, pixel index p = r*width + c;
// `rowPos`/`colPos` are Int32Array (Python uses float64 holding the same integers);
// `xs` in filterClusterPixels is the ROW and `ys` the COLUMN (Python naming trap).
// Expression order is copied exactly from the Python source: JS never fuses
// multiply-add and numba runs without fastmath, so the results are bit-identical.

export const SQRT2 = Math.SQRT2
const GAP_THRESH = SQRT2 * 1.01

// ---------------------------------------------------------------- stable sort
/** Stable counting argsort of values[0..n) (uint8). Equals np.argsort(kind="stable"). */
export function stableArgsortU8(values, n) {
  const count = new Int32Array(257)
  for (let i = 0; i < n; i++) count[values[i] + 1]++
  for (let v = 0; v < 256; v++) count[v + 1] += count[v]
  const out = new Int32Array(n)
  for (let i = 0; i < n; i++) out[count[values[i]]++] = i
  return out
}

// ---------------------------------------------------------------- flood fill
const neigh = new Int32Array(4)
// true when the last growCluster call skipped an open neighbour because of the radius cut
let lastGrowExcluded = false

/**
 * 4-connected flood fill from `current` over open thresholded pixels within
 * sqrt(maxAxisSq) of the start pixel. Neighbours of a pixel are appended in
 * increasing pixel-index order. `queue` may alias `out` (they always hold the
 * same values). Returns the number of pixels written to `out`.
 */
export function growCluster(indexGrid, nRows, nCols, counted, rowPos, colPos, current, maxAxisSq,
  visitStamp, stamp, out, queue) {
  const r0 = rowPos[current]
  const c0 = colPos[current]
  out[0] = current
  queue[0] = current
  visitStamp[current] = stamp
  let nOut = 1
  let head = 0
  let tail = 1
  let excluded = false
  while (head < tail) {
    const p = queue[head++]
    const r = rowPos[p]
    const c = colPos[p]
    let k = 0
    for (let dir = 0; dir < 4; dir++) {
      let rr = r
      let cc = c
      if (dir === 0) rr = r - 1
      else if (dir === 1) rr = r + 1
      else if (dir === 2) cc = c - 1
      else cc = c + 1
      if (rr < 0 || rr >= nRows || cc < 0 || cc >= nCols) continue
      const q = indexGrid[rr * nCols + cc]
      if (q < 0 || counted[q] !== 0 || visitStamp[q] === stamp) continue
      const dr = r0 - rowPos[q]
      const dc = c0 - colPos[q]
      if (dr * dr + dc * dc > maxAxisSq) {
        excluded = true
        continue
      }
      neigh[k++] = q
    }
    // insertion sort (k <= 4) so neighbours are appended in index order
    for (let i = 1; i < k; i++) {
      const v = neigh[i]
      let j = i - 1
      while (j >= 0 && neigh[j] > v) {
        neigh[j + 1] = neigh[j]
        j--
      }
      neigh[j + 1] = v
    }
    for (let i = 0; i < k; i++) {
      const q = neigh[i]
      visitStamp[q] = stamp
      out[nOut++] = q
      queue[tail++] = q
    }
  }
  lastGrowExcluded = excluded
  return nOut
}

// ---------------------------------------------------------------- smoothed max
/** max(np.convolve(values, ones(w)/w, 'same') * w) for n > window, summed in numpy's order. */
export function smoothedMax(values, n, window) {
  const offset = Math.floor((window - 1) / 2)
  const inv = 1.0 / window
  let best = -Infinity
  for (let i = 0; i < n; i++) {
    const k = i + offset // index into the 'full' convolution
    let acc = 0.0
    const lo = Math.max(k - window + 1, 0)
    const hi = Math.min(k, n - 1)
    for (let src = lo; src <= hi; src++) acc += values[src] * inv
    acc *= window
    if (acc > best) best = acc
  }
  return best
}

// ---------------------------------------------------------------- polygon edge
/**
 * Flag per point (x = column, y = row): within ~1.4 px of any polygon segment.
 * Only the first `n` points are examined. Zero-length segments give NaN distances,
 * which compare false exactly as in the numba kernel.
 */
export function pointsAlongPolygon(xPts, yPts, n, xPoly, yPoly) {
  const triggered = new Uint8Array(n)
  const thresh = Math.sqrt(2.0) * 1.01
  const nPoly = xPoly.length
  for (let line = 0; line < nPoly - 1; line++) {
    const x1 = xPoly[line]
    const y1 = yPoly[line]
    const x2 = xPoly[line + 1]
    const y2 = yPoly[line + 1]
    const dy = y2 - y1
    const dx = x2 - x1
    const norm = Math.sqrt(dy * dy + dx * dx)
    const seg = Math.sqrt(dx * dx + dy * dy)
    for (let i = 0; i < n; i++) {
      if (triggered[i] !== 0) continue
      const x = xPts[i]
      const y = yPts[i]
      const d = Math.abs(((dy * x - dx * y) + x2 * y1) - y2 * x1) / norm
      if (d > thresh) continue
      const d1 = Math.sqrt((x1 - x) * (x1 - x) + (y1 - y) * (y1 - y))
      const d2 = Math.sqrt((x2 - x) * (x2 - x) + (y2 - y) * (y2 - y))
      if (d1 <= seg && d2 <= seg) triggered[i] = 1
    }
  }
  return triggered
}

// ---------------------------------------------------------------- outline mask
let outlineGrid = new Uint8Array(0)

/**
 * 1 where a cluster pixel has any 8-neighbour outside the image or outside its
 * own cluster. Equivalent to `outline_mask(cluster_label_grid)` because clusters
 * are disjoint. Works per cluster on a pooled bounding-box grid (no label frame).
 */
export function outlineMaskFromClusters(h, w, ds) {
  const out = new Uint8Array(h * w)
  const { px_row, px_col, px_start, px_len } = ds
  for (let k = 0; k < ds.n; k++) {
    const s = px_start[k]
    const len = px_len[k]
    if (len === 0) continue
    let rmin = h
    let rmax = -1
    let cmin = w
    let cmax = -1
    for (let i = s; i < s + len; i++) {
      const r = px_row[i]
      const c = px_col[i]
      if (r < rmin) rmin = r
      if (r > rmax) rmax = r
      if (c < cmin) cmin = c
      if (c > cmax) cmax = c
    }
    const gh = rmax - rmin + 3
    const gw = cmax - cmin + 3
    if (outlineGrid.length < gh * gw) outlineGrid = new Uint8Array(Math.max(gh * gw, outlineGrid.length * 2))
    const g = outlineGrid
    g.fill(0, 0, gh * gw)
    for (let i = s; i < s + len; i++) g[(px_row[i] - rmin + 1) * gw + (px_col[i] - cmin + 1)] = 1
    for (let i = s; i < s + len; i++) {
      const r = px_row[i]
      const c = px_col[i]
      let edge = r === 0 || r === h - 1 || c === 0 || c === w - 1
      if (!edge) {
        const gi = (r - rmin + 1) * gw + (c - cmin + 1)
        edge = g[gi - gw - 1] === 0 || g[gi - gw] === 0 || g[gi - gw + 1] === 0 ||
          g[gi - 1] === 0 || g[gi + 1] === 0 ||
          g[gi + gw - 1] === 0 || g[gi + gw] === 0 || g[gi + gw + 1] === 0
      }
      if (edge) out[r * w + c] = 1
    }
  }
  return out
}

// ---------------------------------------------------------------- polygon mask
let boundsBuf = new Int32Array(64)

/**
 * matplotlib point_in_path crossing rule, evaluated exactly per edge (the
 * polygon is implicitly closed: edge j -> i with j = i-1, wrapping).
 * xs = columns, ys = rows (polygon points are [x=col, y=row]).
 */
export function polygonMask(nRows, nCols, xs, ys) {
  const mask = new Uint8Array(nRows * nCols)
  const n = xs.length
  if (boundsBuf.length < n) boundsBuf = new Int32Array(n)
  const bounds = boundsBuf
  for (let r = 0; r < nRows; r++) {
    const ty = r
    let k = 0
    for (let i = 0; i < n; i++) {
      const j = i > 0 ? i - 1 : n - 1
      const x0 = xs[j]
      const y0 = ys[j]
      const x1 = xs[i]
      const y1 = ys[i]
      const yflag0 = y0 >= ty
      const yflag1 = y1 >= ty
      if (yflag0 === yflag1) continue
      const xc = x0 + ((ty - y0) * (x1 - x0)) / (y1 - y0)
      // the toggled set is {tx < b}; find b near xc with the exact predicate
      let b = Math.floor(xc) - 2
      for (;;) {
        const tx = b
        if (!((((y1 - ty) * (x0 - x1)) >= ((x1 - tx) * (y0 - y1))) === yflag1)) break
        b++
      }
      for (;;) {
        const tx = b - 1
        if ((((y1 - ty) * (x0 - x1)) >= ((x1 - tx) * (y0 - y1))) === yflag1) break
        b--
      }
      bounds[k++] = b
    }
    if (k < 2) continue
    if (k <= 16) {
      for (let i = 1; i < k; i++) {
        const v = bounds[i]
        let j = i - 1
        while (j >= 0 && bounds[j] > v) {
          bounds[j + 1] = bounds[j]
          j--
        }
        bounds[j + 1] = v
      }
    } else {
      bounds.subarray(0, k).sort()
    }
    // pixel tx is inside iff #(b > tx) is odd
    const rowBase = r * nCols
    for (let m = k - 1; m > 0; m -= 2) {
      const hi = Math.min(bounds[m], nCols)
      const lo = Math.max(bounds[m - 1], 0)
      for (let c = lo; c < hi; c++) mask[rowBase + c] = 1
    }
  }
  return mask
}

// ---------------------------------------------------------------- scratch buffers
function ensure(s, name, size, Type) {
  let a = s[name]
  if (a === undefined || a.length < size) {
    a = new Type(Math.max(size, a === undefined ? 256 : a.length * 2))
    s[name] = a
  }
  return a
}

// total order (proj, j) with NaN last; j is unique so stability is irrelevant
function pathLess(proj, path, a, b) {
  const pa = proj[a]
  const pb = proj[b]
  if (pa < pb) return true
  if (pa > pb) return false
  if (pa === pb) return path[a] < path[b]
  // at least one NaN: NaN sorts last, NaNs keep path order
  const na = pa !== pa
  const nb = pb !== pb
  if (na && nb) return path[a] < path[b]
  return nb // a is a number, b is NaN
}

/** Sort perm[0..n) by (proj, path) using insertion sort (small) or merge sort (large). */
function sortPerm(perm, tmp, proj, path, n) {
  if (n <= 24) {
    for (let i = 1; i < n; i++) {
      const v = perm[i]
      let j = i - 1
      while (j >= 0 && pathLess(proj, path, v, perm[j])) {
        perm[j + 1] = perm[j]
        j--
      }
      perm[j + 1] = v
    }
    return
  }
  // bottom-up merge sort with an insertion-sorted base run of 8
  const RUN = 8
  for (let s = 0; s < n; s += RUN) {
    const e = Math.min(s + RUN, n)
    for (let i = s + 1; i < e; i++) {
      const v = perm[i]
      let j = i - 1
      while (j >= s && pathLess(proj, path, v, perm[j])) {
        perm[j + 1] = perm[j]
        j--
      }
      perm[j + 1] = v
    }
  }
  let src = perm
  let dst = tmp
  for (let width = RUN; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n)
      const hi = Math.min(lo + 2 * width, n)
      let a = lo
      let b = mid
      let o = lo
      while (a < mid && b < hi) {
        if (pathLess(proj, path, src[b], src[a])) dst[o++] = src[b++]
        else dst[o++] = src[a++]
      }
      while (a < mid) dst[o++] = src[a++]
      while (b < hi) dst[o++] = src[b++]
    }
    const t = src
    src = dst
    dst = t
  }
  if (src !== perm) for (let i = 0; i < n; i++) perm[i] = src[i]
}

// ---------------------------------------------------------------- breakup filter
/**
 * Cluster breakup pass (`filter_cluster_pixels`). `ci[0..n)` are positions into
 * rowPos/colPos/blue sorted by (distance from the start pixel, BFS order), start
 * pixel first. Returns `{acc, nAcc}`: indices into `ci` of accepted pixels in
 * acceptance order. `acc` is a view into `scratch` and is valid until the next call.
 */
export function filterClusterPixels(ci, n, rowPos, colPos, blue, bgMedian, refThr, maxCost, window, scratch) {
  scratch = scratch || {}
  const current = ci[0]
  const bCur = blue[current]
  const bg2 = bgMedian * bgMedian
  const darkLimit = (bgMedian - bCur) * refThr + bCur

  const xs = ensure(scratch, 'xs', n, Float64Array)
  const ys = ensure(scratch, 'ys', n, Float64Array)
  const cost = ensure(scratch, 'cost', n, Float64Array)
  let rmin = 1 << 30
  let cmin = 1 << 30
  let rmax = -1
  let cmax = -1
  for (let i = 0; i < n; i++) {
    const idx = ci[i]
    const xi = rowPos[idx]
    const yi = colPos[idx]
    xs[i] = xi
    ys[i] = yi
    const d = blue[idx] - bCur
    const cst0 = (d * d) / bg2
    cost[i] = cst0 > 0.0 ? cst0 : 0.0
    if (xi < rmin) rmin = xi
    if (xi > rmax) rmax = xi
    if (yi < cmin) cmin = yi
    if (yi > cmax) cmax = yi
  }
  const h = rmax - rmin + 1
  const w = cmax - cmin + 1
  const local = ensure(scratch, 'local', h * w, Int32Array)
  const darkRank = ensure(scratch, 'darkRank', h * w, Int32Array)
  local.fill(-1, 0, h * w)
  darkRank.fill(-1, 0, h * w)
  for (let i = 0; i < n; i++) local[(xs[i] - rmin) * w + (ys[i] - cmin)] = i

  const accepted = ensure(scratch, 'accepted', n, Int32Array)
  accepted[0] = 0
  let nAcc = 1
  const dark = ensure(scratch, 'dark', n, Int32Array)
  let nDark = 0
  if (blue[current] <= darkLimit) {
    dark[0] = 0
    nDark = 1
    darkRank[(xs[0] - rmin) * w + (ys[0] - cmin)] = 0
  }

  const path = ensure(scratch, 'path', n, Int32Array)
  const proj = ensure(scratch, 'proj', n, Float64Array)
  const perm = ensure(scratch, 'perm', n, Int32Array)
  const permTmp = ensure(scratch, 'permTmp', n, Int32Array)
  const pathCost = ensure(scratch, 'pathCost', n, Float64Array)

  for (let li = 1; li < n; li++) {
    const x1 = xs[li]
    const y1 = ys[li]
    const r1 = x1 - rmin
    const c1 = y1 - cmin

    let ref = nDark > 0 ? dark[0] : 0 // nDark == 0 only for reference_threshold < 0
    if (nDark > 1) {
      let best = Infinity
      let bestRank = nDark
      let done = false
      if (nDark > 16) {
        // expanding Chebyshev rings; stop once ring radius^2 > best
        let visited = 0
        let rad = 0
        for (;;) {
          if (rad * rad > best) {
            done = true
            break
          }
          if (visited > nDark) break // linear scan is cheaper from here
          if (rad > h + w) {
            done = true
            break
          }
          for (let rr = r1 - rad; rr <= r1 + rad; rr++) {
            if (rr < 0 || rr >= h) continue
            const edgeRow = rr === r1 - rad || rr === r1 + rad
            let step = edgeRow ? 1 : 2 * rad
            if (step === 0) step = 1
            let cc = c1 - rad
            const rowBase = rr * w
            while (cc <= c1 + rad) {
              if (cc >= 0 && cc < w) {
                visited++
                const k = darkRank[rowBase + cc]
                if (k >= 0) {
                  const d = dark[k]
                  const ddx = xs[d] - x1
                  const ddy = ys[d] - y1
                  const d2 = ddx * ddx + ddy * ddy
                  if (d2 < best || (d2 === best && k < bestRank)) {
                    best = d2
                    bestRank = k
                  }
                }
              }
              cc += step
            }
          }
          rad++
        }
      }
      if (done) {
        ref = dark[bestRank]
      } else {
        best = Infinity
        for (let k = 0; k < nDark; k++) {
          const d = dark[k]
          const ddx = xs[d] - x1
          const ddy = ys[d] - y1
          const d2 = ddx * ddx + ddy * ddy
          if (d2 < best) {
            best = d2
            ref = d
          }
        }
      }
    }
    const x2 = xs[ref]
    const y2 = ys[ref]

    const denom = Math.sqrt((y2 - y1) * (y2 - y1) + (x2 - x1) * (x2 - x1))
    const refDist = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1))
    const a = y2 - y1
    const b = x2 - x1
    const cst = x2 * y1 - y2 * x1

    const rLo = Math.max(Math.trunc(Math.min(x1, x2)) - 2 - rmin, 0)
    const rHi = Math.min(Math.trunc(Math.max(x1, x2)) + 2 - rmin, h - 1)
    const cLo = Math.max(Math.trunc(Math.min(y1, y2)) - 2 - cmin, 0)
    const cHi = Math.min(Math.trunc(Math.max(y1, y2)) + 2 - cmin, w - 1)
    let nPath = 0
    const band = SQRT2 * denom
    for (let rr = rLo; rr <= rHi; rr++) {
      const x0 = rr + rmin
      let lo = cLo
      let hi = cHi
      if (b !== 0.0) {
        // |a*x0 - b*y0 + cst| <= band  ->  y0 in [(a*x0+cst-band)/b, (a*x0+cst+band)/b]
        let u = ((a * x0 + cst) - band) / b
        let v = ((a * x0 + cst) + band) / b
        if (u > v) {
          const t = u
          u = v
          v = t
        }
        lo = Math.max(lo, Math.floor(u) - 1 - cmin)
        hi = Math.min(hi, Math.ceil(v) + 1 - cmin)
      }
      const rowBase = rr * w
      for (let cc = lo; cc <= hi; cc++) {
        const j = local[rowBase + cc]
        if (j < 0) continue
        const y0 = ys[j]
        const ld = Math.abs((a * x0 - b * y0) + cst) / denom
        if (ld > SQRT2) continue
        const ds = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0))
        if (ds > refDist) continue
        const dref = Math.sqrt((x2 - x0) * (x2 - x0) + (y2 - y0) * (y2 - y0))
        if (dref > refDist) continue
        path[nPath] = j
        proj[nPath] = Math.sqrt(dref * dref - ld * ld)
        nPath++
      }
    }
    // Python: stable argsort(path), then stable argsort(proj) == sort by (proj, j)
    for (let i = 0; i < nPath; i++) perm[i] = i
    sortPerm(perm, permTmp, proj, path, nPath)
    let gap = false
    for (let k = 1; k < nPath; k++) {
      if (proj[perm[k]] - proj[perm[k - 1]] > GAP_THRESH) {
        gap = true
        break
      }
    }
    if (gap) continue

    for (let k = 0; k < nPath; k++) pathCost[k] = cost[path[perm[k]]]
    let worst
    if (window < nPath) {
      worst = smoothedMax(pathCost, nPath, window)
    } else {
      worst = 0.0
      for (let k = 0; k < nPath; k++) worst += pathCost[k]
    }

    if (worst < maxCost) {
      accepted[nAcc++] = li
      if (blue[ci[li]] <= darkLimit) {
        dark[nDark] = li
        darkRank[r1 * w + c1] = nDark
        nDark++
      }
    }
  }
  return { acc: accepted, nAcc }
}

// ---------------------------------------------------------------- driver
let BATCH_SMALL_REJECTS = true
/** Test hook: disable the small-component shortcut in detectCore (results must not change). */
export function setBatchSmallRejects(value) {
  BATCH_SMALL_REJECTS = !!value
}

function growI32(a, size) {
  const b = new Int32Array(size)
  b.set(a)
  return b
}

function growF64(a, size) {
  const b = new Float64Array(size)
  b.set(a)
  return b
}

/**
 * Whole particle-detection driver loop (flood fill, breakup filter, rejection).
 * Pixel arrays are sorted darkest-first (stable); `indexGrid` maps (row, col) -> position.
 * `blue` is the per-pixel blue value (Uint8Array). Returns cluster ids, a flat
 * (n*7) stats array [surface, roundness, short, long, volume, xmean, ymean] and
 * flat pixel row/col arrays with per-cluster offsets.
 * `onProgress(nextOpen, total)` is called at most once every 65536 seeds.
 */
export function detectCore(indexGrid, nRows, nCols, rowPos, colPos, blue, total, bgMedian, refThr, maxCost,
  window, maxAxis, minSurface, quick, edgeGrid, onProgress) {
  const counted = new Uint8Array(total)
  const visitStamp = new Int32Array(total)
  const out = new Int32Array(total) // also serves as the BFS queue (identical contents)
  const maxAxisSq = maxAxis * maxAxis
  const scratch = {}
  const useEdge = edgeGrid != null

  let cap = 256
  let ids = new Int32Array(cap)
  let stats = new Float64Array(cap * 7)
  let offsets = new Int32Array(cap + 1)
  let pixCap = Math.min(Math.max(total, 16), 1 << 16)
  let pixRow = new Int32Array(pixCap)
  let pixCol = new Int32Array(pixCap)
  let nc = 0
  let nPix = 0
  let nextOpen = 0

  let nextProgress = 0
  for (let clusterId = 0; clusterId < total; clusterId++) {
    if (onProgress && clusterId >= nextProgress) {
      onProgress(nextOpen, total)
      nextProgress = clusterId + 65536
    }
    // counted: 1 = taken by a cluster / rejected seed, 2 = pixel of a component already known to be
    // smaller than minSurface; reaching it still consumes a seed id exactly as Python does
    // (each of its pixels would become a seed whose flood is smaller than minSurface).
    while (nextOpen < total && counted[nextOpen] !== 0) {
      if (counted[nextOpen] === 2) clusterId++
      nextOpen++
    }
    if (nextOpen >= total) break
    const current = nextOpen
    const nFound = growCluster(indexGrid, nRows, nCols, counted, rowPos, colPos, current,
      maxAxisSq, visitStamp, clusterId + 1, out, out)
    if (nFound < minSurface) {
      counted[current] = 1
      // If the radius cut excluded nothing, the flood is the whole open component, so every
      // later flood inside it is smaller still: reject it in one go (python re-floods it per pixel).
      if (BATCH_SMALL_REJECTS && !lastGrowExcluded) for (let i = 1; i < nFound; i++) counted[out[i]] = 2
      continue
    }
    const ci = out // positions of the cluster, BFS order
    let acc = null
    let m
    if (quick) {
      m = nFound
    } else {
      // order by (squared distance from the seed, BFS position)
      const keys = ensure(scratch, 'keys', nFound, Float64Array)
      const tmp = ensure(scratch, 'tmp', nFound, Int32Array)
      let mult = 1
      while (mult < nFound) mult *= 2
      const rc = rowPos[current]
      const cc0 = colPos[current]
      let ok = true
      for (let i = 0; i < nFound; i++) {
        const dr = rowPos[ci[i]] - rc
        const dc = colPos[ci[i]] - cc0
        const d2 = dr * dr + dc * dc
        const key = d2 * mult + i
        if (key >= 9007199254740992) ok = false
        keys[i] = key
      }
      for (let i = 0; i < nFound; i++) tmp[i] = ci[i]
      if (ok) {
        const ks = keys.subarray(0, nFound)
        ks.sort()
        for (let i = 0; i < nFound; i++) ci[i] = tmp[ks[i] % mult]
      } else {
        // astronomically large radius: exact comparator fallback
        const order = Array.from({ length: nFound }, (_, i) => i)
        const d2s = new Float64Array(nFound)
        for (let i = 0; i < nFound; i++) {
          const dr = rowPos[tmp[i]] - rc
          const dc = colPos[tmp[i]] - cc0
          d2s[i] = dr * dr + dc * dc
        }
        order.sort((p, q) => (d2s[p] - d2s[q]) || (p - q))
        for (let i = 0; i < nFound; i++) ci[i] = tmp[order[i]]
      }
      const res = filterClusterPixels(ci, nFound, rowPos, colPos, blue, bgMedian, refThr, maxCost, window, scratch)
      acc = res.acc
      m = res.nAcc
    }
    for (let i = 0; i < nFound; i++) counted[ci[i]] = 1
    if (m < minSurface) continue

    let xmin = Infinity
    let xmax = -Infinity
    let ymin = Infinity
    let ymax = -Infinity
    let sx = 0.0
    let sy = 0.0
    let zmin = Infinity
    let hitEdge = false
    for (let k = 0; k < m; k++) {
      const p = acc === null ? ci[k] : ci[acc[k]]
      const x = rowPos[p]
      const y = colPos[p]
      if (x < xmin) xmin = x
      if (x > xmax) xmax = x
      if (y < ymin) ymin = y
      if (y > ymax) ymax = y
      sx += x
      sy += y
      const z = blue[p]
      if (z < zmin) zmin = z
      if (useEdge && edgeGrid[x * nCols + y] !== 0) hitEdge = true
    }
    if (xmin <= 0 || xmax >= nRows - 1 || ymin <= 0 || ymax >= nCols - 1) continue
    if (hitEdge) continue
    const mult2 = Math.max((bgMedian - zmin) / bgMedian, 1.0)
    const surface = m * mult2
    const xmean = sx / m
    const ymean = sy / m
    let longAxis = 0.0
    for (let k = 0; k < m; k++) {
      const p = acc === null ? ci[k] : ci[acc[k]]
      const dx = rowPos[p] - xmean
      const dy = colPos[p] - ymean
      let rd = Math.sqrt(dx * dx + dy * dy)
      if (!(rd >= 1e-4)) rd = rd !== rd ? rd : 1e-4
      if (rd > longAxis) longAxis = rd
    }
    if (longAxis > maxAxis) continue
    const roundness = surface === 1.0 ? 1.0 : surface / (Math.PI * (longAxis * longAxis))
    const shortAxis = surface / (Math.PI * longAxis)
    const volume = (Math.PI * (shortAxis * shortAxis)) * longAxis

    if (nc + 1 > cap) {
      cap *= 2
      ids = growI32(ids, cap)
      stats = growF64(stats, cap * 7)
      offsets = growI32(offsets, cap + 1)
    }
    if (nPix + m > pixCap) {
      pixCap = Math.max(pixCap * 2, nPix + m)
      pixRow = growI32(pixRow, pixCap)
      pixCol = growI32(pixCol, pixCap)
    }
    ids[nc] = clusterId
    const so = nc * 7
    stats[so] = surface
    stats[so + 1] = roundness
    stats[so + 2] = shortAxis
    stats[so + 3] = longAxis
    stats[so + 4] = volume
    stats[so + 5] = xmean
    stats[so + 6] = ymean
    for (let k = 0; k < m; k++) {
      const p = acc === null ? ci[k] : ci[acc[k]]
      pixRow[nPix] = rowPos[p]
      pixCol[nPix] = colPos[p]
      nPix++
    }
    nc++
    offsets[nc] = nPix
  }
  offsets[0] = 0
  return {
    ids: ids.slice(0, nc),
    stats: stats.slice(0, nc * 7),
    offsets: offsets.slice(0, nc + 1),
    pixRow: pixRow.slice(0, nPix),
    pixCol: pixCol.slice(0, nPix),
  }
}
