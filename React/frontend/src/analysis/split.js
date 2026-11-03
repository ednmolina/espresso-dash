// Separate touching particles (optional, `split_touching`): cut merged clusters at a narrow neck.
//
// Pure (no DOM). Runs after detection and before measurement (detect.js analyzeImageBlue):
//   1. candidates: clusters with >= max(SPLIT_MIN_PX, 2 * min_surface) pixels whose solidity
//      (Pick's-theorem hull measure) is < SPLIT_SOLIDITY_MAX;
//   2. per candidate: exact squared Euclidean distance transform on the padded bbox mask, then a
//      union-find flooding watershed in descending-EDT order with a neck-ratio merge rule;
//   3. all-or-nothing: a split is kept only if every piece passes the detector's own rules.
// The Python mirror is parity/split_reference.py; both follow the same operations so the results
// are bit-identical. All tie-breaks are by row-major grid cell, never by pixel-list order.
//
// Hot loops use pooled module-level typed arrays (no Set / Map / push / closures per pixel).
import { makeDataset } from './dataset.js'
import { pow2 } from './glibcPow.js'
import { weightedPercentiles } from './stats.js'
import { filterByMinDiameter, metricValues, metricWeights } from './summary.js'
import { finiteOrNull } from './np.js'

export const SPLIT_MIN_PX = 40
export const SPLIT_SOLIDITY_MAX = 0.95
export const SPLIT_MIN_PEAK_PX = 2.0

const INT_MAX = 0x7fffffff

// ---------------------------------------------------------------- pooled buffers
const grownCopy = (a, need, used) => {
  if (a.length >= need) return a
  const out = new a.constructor(Math.max(need, a.length * 2, 16))
  out.set(used === undefined ? a : a.subarray(0, used))
  return out
}

// solidity
let solLo = new Int32Array(0)
let solHi = new Int32Array(0)
let solPtR = new Int32Array(0)
let solPtC = new Int32Array(0)
let solLowR = new Int32Array(0)
let solLowC = new Int32Array(0)
let solUpR = new Int32Array(0)
let solUpC = new Int32Array(0)
let solHullR = new Int32Array(0)
let solHullC = new Int32Array(0)

// EDT / watershed
let gridMask = new Uint8Array(0)
let gridD = new Float64Array(0)
let gridLab = new Int32Array(0)
let cellIdx = new Int32Array(0)
let cellOrder = new Int32Array(0)
let keyCount = new Int32Array(0)
let basinPar = new Int32Array(0)
let basinPeak = new Float64Array(0)
let basinPiece = new Int32Array(0)
let edtF = new Float64Array(0)
let edtV = new Int32Array(0)
let edtZ = new Float64Array(0)
let edtD = new Float64Array(0)
const roots4 = new Int32Array(4)

// splitTouching
let candList = new Int32Array(0)
let labTmp = new Int32Array(0)
let pieceM = new Float64Array(0)
let pieceSx = new Float64Array(0)
let pieceSy = new Float64Array(0)
let pieceLong = new Float64Array(0)
let pieceOff = new Int32Array(0)
let accK = new Int32Array(0)
let accNp = new Int32Array(0)
let accLabOff = new Int32Array(0)
let accPieceOff = new Int32Array(0)
let labStore = new Int32Array(0)
let pieceStats = new Float64Array(0) // 7 per accepted piece, in output order

/** Free every pooled scratch buffer (nothing calls this yet; for symmetry with releaseDetectBuffers). */
export function releaseSplitBuffers() {
  solLo = solHi = solPtR = solPtC = solLowR = solLowC = solUpR = solUpC = solHullR = solHullC = new Int32Array(0)
  gridMask = new Uint8Array(0)
  gridD = new Float64Array(0)
  gridLab = cellIdx = cellOrder = keyCount = basinPar = basinPiece = edtV = new Int32Array(0)
  basinPeak = edtF = edtZ = edtD = new Float64Array(0)
  candList = labTmp = pieceOff = accK = accNp = accLabOff = accPieceOff = labStore = new Int32Array(0)
  pieceM = pieceSx = pieceSy = pieceLong = pieceStats = new Float64Array(0)
}

// ---------------------------------------------------------------- 1. solidity
/**
 * Solidity of the pixel set i in [s, e): n / (A_hull + P_hull / 2 + 1), the hull of the pixel
 * centres (built from per-row extents). Pick's theorem: about 1 for a convex digital set.
 * Rows are taken relative to the bbox top, columns absolute (the result is translation invariant).
 */
export function clusterSolidity(pxRow, pxCol, s, e) {
  let rmin = pxRow[s]
  let rmax = rmin
  for (let i = s + 1; i < e; i++) {
    const r = pxRow[i]
    if (r < rmin) rmin = r
    else if (r > rmax) rmax = r
  }
  const nr = rmax - rmin + 1
  if (solLo.length < nr) {
    const cap = Math.max(nr, solLo.length * 2, 64)
    solLo = new Int32Array(cap)
    solHi = new Int32Array(cap)
    solPtR = new Int32Array(cap * 2)
    solPtC = new Int32Array(cap * 2)
    solLowR = new Int32Array(cap * 2)
    solLowC = new Int32Array(cap * 2)
    solUpR = new Int32Array(cap * 2)
    solUpC = new Int32Array(cap * 2)
    solHullR = new Int32Array(cap * 4)
    solHullC = new Int32Array(cap * 4)
  }
  const lo = solLo
  const hi = solHi
  lo.fill(INT_MAX, 0, nr)
  hi.fill(-1, 0, nr)
  for (let i = s; i < e; i++) {
    const r = pxRow[i] - rmin
    const c = pxCol[i]
    if (c < lo[r]) lo[r] = c
    if (c > hi[r]) hi[r] = c
  }
  // points: rows ascending, (r, lo) then (r, hi) when different => already sorted by (r, c)
  const ptR = solPtR
  const ptC = solPtC
  let np = 0
  for (let r = 0; r < nr; r++) {
    if (hi[r] < 0) continue
    ptR[np] = r
    ptC[np] = lo[r]
    np++
    if (hi[r] !== lo[r]) {
      ptR[np] = r
      ptC[np] = hi[r]
      np++
    }
  }
  // Andrew's monotone chain, popping while cross(o, a, b) <= 0
  const lowR = solLowR
  const lowC = solLowC
  let nl = 0
  for (let q = 0; q < np; q++) {
    const pr = ptR[q]
    const pc = ptC[q]
    while (nl >= 2) {
      const or = lowR[nl - 2]
      const oc = lowC[nl - 2]
      if ((lowR[nl - 1] - or) * (pc - oc) - (lowC[nl - 1] - oc) * (pr - or) <= 0) nl--
      else break
    }
    lowR[nl] = pr
    lowC[nl] = pc
    nl++
  }
  const upR = solUpR
  const upC = solUpC
  let nu = 0
  for (let q = np - 1; q >= 0; q--) {
    const pr = ptR[q]
    const pc = ptC[q]
    while (nu >= 2) {
      const or = upR[nu - 2]
      const oc = upC[nu - 2]
      if ((upR[nu - 1] - or) * (pc - oc) - (upC[nu - 1] - oc) * (pr - or) <= 0) nu--
      else break
    }
    upR[nu] = pr
    upC[nu] = pc
    nu++
  }
  // hull = lower[0..-1) ++ upper[0..-1)
  const hr = solHullR
  const hc = solHullC
  let nh = 0
  for (let q = 0; q < nl - 1; q++) {
    hr[nh] = lowR[q]
    hc[nh] = lowC[q]
    nh++
  }
  for (let q = 0; q < nu - 1; q++) {
    hr[nh] = upR[q]
    hc[nh] = upC[q]
    nh++
  }
  let A = 0
  let P = 0
  for (let q = 0; q < nh; q++) {
    const q2 = q + 1 === nh ? 0 : q + 1
    const ar = hr[q]
    const ac = hc[q]
    const br = hr[q2]
    const bc = hc[q2]
    A += ar * bc - br * ac
    const dr = ar - br
    const dc = ac - bc
    P += Math.sqrt(dr * dr + dc * dc)
  }
  A = Math.abs(A) / 2
  return (e - s) / (A + P / 2 + 1)
}

// ---------------------------------------------------------------- 2. exact squared EDT
/**
 * Squared Euclidean distance to the nearest background cell centre, for every cell of a gh x gw
 * grid (Felzenszwalb-Huttenlocher). `mask[y*gw + x]` = 1 for particle cells. Row 0 must be
 * background (the grid is padded by one cell). `out` (Float64Array, gh*gw) receives exact
 * integers; background cells get 0.
 */
export function edtSquared(mask, gh, gw, out) {
  // column pass (integer, exact): vertical distance to the nearest background cell
  for (let x = 0; x < gw; x++) out[x] = 0
  for (let y = 1; y < gh; y++) {
    const o = y * gw
    const p = o - gw
    for (let x = 0; x < gw; x++) out[o + x] = mask[o + x] !== 0 ? out[p + x] + 1 : 0
  }
  for (let y = gh - 2; y >= 0; y--) {
    const o = y * gw
    const nx = o + gw
    for (let x = 0; x < gw; x++) {
      const t = out[nx + x] + 1
      if (t < out[o + x]) out[o + x] = t
    }
  }
  const total = gh * gw
  for (let i = 0; i < total; i++) out[i] *= out[i]
  // row pass: lower envelope of parabolas
  if (edtF.length < gw + 2) {
    const cap = Math.max(gw + 2, edtF.length * 2)
    edtF = new Float64Array(cap)
    edtV = new Int32Array(cap)
    edtZ = new Float64Array(cap + 1)
    edtD = new Float64Array(cap)
  }
  const f = edtF
  const v = edtV
  const z = edtZ
  for (let y = 0; y < gh; y++) {
    const o = y * gw
    for (let q = 0; q < gw; q++) f[q] = out[o + q]
    let k = 0
    v[0] = 0
    z[0] = -Infinity
    z[1] = Infinity
    for (let q = 1; q < gw; q++) {
      const fq = f[q] + q * q
      let p = v[k]
      let sx = (fq - (f[p] + p * p)) / (2 * q - 2 * p)
      while (sx <= z[k]) {
        k--
        p = v[k]
        sx = (fq - (f[p] + p * p)) / (2 * q - 2 * p)
      }
      k++
      v[k] = q
      z[k] = sx
      z[k + 1] = Infinity
    }
    k = 0
    for (let q = 0; q < gw; q++) {
      while (z[k + 1] < q) k++
      const p = v[k]
      out[o + q] = (q - p) * (q - p) + f[p]
    }
  }
  return out
}

// ---------------------------------------------------------------- 3. watershed
function findRoot(par, x) {
  while (par[x] !== x) {
    par[x] = par[par[x]]
    x = par[x]
  }
  return x
}

/**
 * Core of splitClusterPixels: the piece of pixel i (in [s, e)) is written to labels[base + i - s].
 * Returns the number of pieces.
 */
function splitCore(pxRow, pxCol, s, e, ratio, labels, base) {
  let rmin = pxRow[s]
  let rmax = rmin
  let cmin = pxCol[s]
  let cmax = cmin
  for (let i = s + 1; i < e; i++) {
    const r = pxRow[i]
    const c = pxCol[i]
    if (r < rmin) rmin = r
    else if (r > rmax) rmax = r
    if (c < cmin) cmin = c
    else if (c > cmax) cmax = c
  }
  const gh = rmax - rmin + 3
  const gw = cmax - cmin + 3
  const G = gh * gw
  const n = e - s
  if (gridMask.length < G) {
    const cap = Math.max(G, gridMask.length * 2)
    gridMask = new Uint8Array(cap)
    gridD = new Float64Array(cap)
    gridLab = new Int32Array(cap)
  }
  if (cellIdx.length < n) {
    const cap = Math.max(n, cellIdx.length * 2)
    cellIdx = new Int32Array(cap)
    cellOrder = new Int32Array(cap)
    basinPar = new Int32Array(cap)
    basinPeak = new Float64Array(cap)
    basinPiece = new Int32Array(cap)
  }
  const mask = gridMask
  const D = gridD
  const lab = gridLab
  mask.fill(0, 0, G)
  const r0 = rmin - 1
  const c0 = cmin - 1
  for (let i = s; i < e; i++) mask[(pxRow[i] - r0) * gw + (pxCol[i] - c0)] = 1
  edtSquared(mask, gh, gw, D)

  // particle cells in row-major order: j = cell number (the tie-break key)
  let nc = 0
  let maxD = 0
  for (let y = 1; y < gh - 1; y++) {
    const o = y * gw
    for (let x = 1; x < gw - 1; x++) {
      if (mask[o + x] !== 0) {
        cellIdx[nc++] = o + x
        if (D[o + x] > maxD) maxD = D[o + x]
      }
    }
  }
  // counting sort by D descending (key = maxD - D), ties by j ascending (stable over j order)
  if (keyCount.length < maxD + 2) keyCount = new Int32Array(Math.max(maxD + 2, keyCount.length * 2))
  const cnt = keyCount
  cnt.fill(0, 0, maxD + 2)
  for (let j = 0; j < nc; j++) cnt[maxD - D[cellIdx[j]]]++
  for (let k = 1; k <= maxD + 1; k++) cnt[k] += cnt[k - 1]
  for (let j = nc - 1; j >= 0; j--) cellOrder[--cnt[maxD - D[cellIdx[j]]]] = j

  // flooding
  lab.fill(-1, 0, G)
  const par = basinPar
  const peak = basinPeak
  const minPeak = SPLIT_MIN_PEAK_PX * SPLIT_MIN_PEAK_PX
  const r2 = ratio * ratio
  const roots = roots4
  let nBasins = 0
  for (let t = 0; t < nc; t++) {
    const g = cellIdx[cellOrder[t]]
    const lev = D[g]
    // roots of the already-labelled 4-neighbours in the order up, left, right, down (deduplicated)
    let nr = 0
    let l = lab[g - gw]
    if (l >= 0) roots[nr++] = findRoot(par, l)
    l = lab[g - 1]
    if (l >= 0) {
      const r = findRoot(par, l)
      let dup = false
      for (let q = 0; q < nr; q++) if (roots[q] === r) dup = true
      if (!dup) roots[nr++] = r
    }
    l = lab[g + 1]
    if (l >= 0) {
      const r = findRoot(par, l)
      let dup = false
      for (let q = 0; q < nr; q++) if (roots[q] === r) dup = true
      if (!dup) roots[nr++] = r
    }
    l = lab[g + gw]
    if (l >= 0) {
      const r = findRoot(par, l)
      let dup = false
      for (let q = 0; q < nr; q++) if (roots[q] === r) dup = true
      if (!dup) roots[nr++] = r
    }
    if (nr === 0) {
      par[nBasins] = nBasins
      peak[nBasins] = lev
      lab[g] = nBasins
      nBasins++
      continue
    }
    if (nr === 1) {
      lab[g] = roots[0]
      continue
    }
    // insertion sort by (peak desc, id asc)
    for (let a = 1; a < nr; a++) {
      const x = roots[a]
      const px = peak[x]
      let b = a - 1
      while (b >= 0 && (peak[roots[b]] < px || (peak[roots[b]] === px && roots[b] > x))) {
        roots[b + 1] = roots[b]
        b--
      }
      roots[b + 1] = x
    }
    const main = roots[0]
    for (let a = 1; a < nr; a++) {
      const b = roots[a]
      const pb = peak[b]
      if (!(pb >= minPeak && lev < r2 * pb)) par[b] = main
    }
    lab[g] = main
  }

  // pieces: numbered by first appearance of the root in a row-major scan
  if (basinPiece.length < nBasins) basinPiece = new Int32Array(Math.max(nBasins, basinPiece.length * 2))
  const bp = basinPiece
  bp.fill(-1, 0, nBasins)
  let pieces = 0
  for (let j = 0; j < nc; j++) {
    const g = cellIdx[j]
    const r = findRoot(par, lab[g])
    let p = bp[r]
    if (p < 0) {
      p = pieces++
      bp[r] = p
    }
    lab[g] = p
  }
  for (let i = s; i < e; i++) labels[base + i - s] = lab[(pxRow[i] - r0) * gw + (pxCol[i] - c0)]
  return pieces
}

/**
 * Watershed split of the pixel set i in [s, e) (rows pxRow, cols pxCol). Writes the piece index
 * (0, 1, ...) of pixel i to labels[i] and returns the number of pieces. Two regions stay apart only
 * when the saddle between them has an inscribed radius below `ratio` times the smaller region's
 * peak inscribed radius, and that region is at least SPLIT_MIN_PEAK_PX in radius.
 */
export function splitClusterPixels(pxRow, pxCol, s, e, ratio, labels) {
  return splitCore(pxRow, pxCol, s, e, ratio, labels, s)
}

// ---------------------------------------------------------------- 4. splitTouching
/**
 * Split touching clusters of `ds`. Returns { dataset, info }; `dataset === ds` (same object) when
 * nothing was split. `info` = { neck_ratio, candidates, clusters_split, pieces_added, rejected_splits }.
 */
export function splitTouching(ds, settings, onProgress) {
  try {
    return splitTouchingImpl(ds, settings, onProgress)
  } finally {
    // the per-call stores can be large (labels of every split parent); the small geometry pools stay
    candList = labTmp = accK = accNp = accLabOff = accPieceOff = labStore = new Int32Array(0)
    pieceStats = new Float64Array(0)
  }
}

function splitTouchingImpl(ds, settings, onProgress) {
  const ratio = Number(settings.split_neck_ratio)
  const info = { neck_ratio: ratio, candidates: 0, clusters_split: 0, pieces_added: 0, rejected_splits: 0 }
  const n = ds.n
  if (n === 0) return { dataset: ds, info }
  const { px_row: pxRow, px_col: pxCol, px_start: pxStart, px_len: pxLen } = ds
  const minPx = Math.max(SPLIT_MIN_PX, 2 * settings.min_surface)

  // candidates, in dataset order
  let nCand = 0
  for (let k = 0; k < n; k++) {
    const len = pxLen[k]
    if (len < minPx) continue
    const s = pxStart[k]
    if (clusterSolidity(pxRow, pxCol, s, s + len) < SPLIT_SOLIDITY_MAX) {
      if (candList.length <= nCand) candList = grownCopy(candList, nCand + 1, nCand)
      candList[nCand++] = k
    }
  }
  info.candidates = nCand
  if (nCand === 0) return { dataset: ds, info }

  const minSurface = settings.min_surface
  const maxAxis = settings.max_cluster_axis
  const minRoundness = settings.min_roundness
  let nAcc = 0
  let nAccPieces = 0
  let labUsed = 0
  let added = 0
  for (let t = 0; t < nCand; t++) {
    if (onProgress && t > 0 && (t & 63) === 0) onProgress(t / nCand)
    const k = candList[t]
    const s = pxStart[k]
    const len = pxLen[k]
    const e = s + len
    if (labTmp.length < len) labTmp = new Int32Array(Math.max(len, labTmp.length * 2))
    const np = splitCore(pxRow, pxCol, s, e, ratio, labTmp, 0)
    if (np < 2) continue

    // detector-equivalent measurement of every piece (per-piece sums in the parent's stored order)
    if (pieceM.length < np) {
      const cap = Math.max(np, pieceM.length * 2)
      pieceM = new Float64Array(cap)
      pieceSx = new Float64Array(cap)
      pieceSy = new Float64Array(cap)
      pieceLong = new Float64Array(cap)
    }
    pieceM.fill(0, 0, np)
    pieceSx.fill(0, 0, np)
    pieceSy.fill(0, 0, np)
    pieceLong.fill(0, 0, np)
    for (let i = 0; i < len; i++) {
      const p = labTmp[i]
      pieceM[p]++
      pieceSx[p] += pxRow[s + i]
      pieceSy[p] += pxCol[s + i]
    }
    for (let i = 0; i < len; i++) {
      const p = labTmp[i]
      const dx = pxRow[s + i] - pieceSx[p] / pieceM[p]
      const dy = pxCol[s + i] - pieceSy[p] / pieceM[p]
      let rd = Math.sqrt(dx * dx + dy * dy)
      if (!(rd >= 1e-4)) rd = 1e-4
      if (rd > pieceLong[p]) pieceLong[p] = rd
    }
    const unit = ds.surface[k] / len
    let ok = true
    for (let p = 0; p < np; p++) {
      const m = pieceM[p]
      const longAxis = pieceLong[p]
      const surface = m * unit
      const roundness = surface === 1.0 ? 1.0 : surface / (Math.PI * pow2(longAxis))
      if (!(m >= minSurface) || longAxis > maxAxis || roundness < minRoundness) {
        ok = false
        break
      }
    }
    if (!ok) {
      info.rejected_splits++
      continue
    }
    // accept: record the labels and the pieces' scalar columns
    if (accK.length <= nAcc) {
      const cap = Math.max(16, accK.length * 2)
      accK = grownCopy(accK, cap, nAcc)
      accNp = grownCopy(accNp, cap, nAcc)
      accLabOff = grownCopy(accLabOff, cap, nAcc)
      accPieceOff = grownCopy(accPieceOff, cap, nAcc)
    }
    accK[nAcc] = k
    accNp[nAcc] = np
    accLabOff[nAcc] = labUsed
    accPieceOff[nAcc] = nAccPieces
    nAcc++
    if (labStore.length < labUsed + len) labStore = grownCopy(labStore, labUsed + len, labUsed)
    labStore.set(labTmp.subarray(0, len), labUsed)
    labUsed += len
    if (pieceStats.length < (nAccPieces + np) * 7) pieceStats = grownCopy(pieceStats, (nAccPieces + np) * 7, nAccPieces * 7)
    for (let p = 0; p < np; p++) {
      const m = pieceM[p]
      const longAxis = pieceLong[p]
      const surface = m * unit
      const shortAxis = surface / (Math.PI * longAxis)
      const o = (nAccPieces + p) * 7
      pieceStats[o] = surface
      pieceStats[o + 1] = surface === 1.0 ? 1.0 : surface / (Math.PI * pow2(longAxis))
      pieceStats[o + 2] = shortAxis
      pieceStats[o + 3] = longAxis
      pieceStats[o + 4] = (Math.PI * pow2(shortAxis)) * longAxis
      pieceStats[o + 5] = pieceSx[p] / m
      pieceStats[o + 6] = pieceSy[p] / m
    }
    nAccPieces += np
    added += np - 1
  }
  info.clusters_split = nAcc
  info.pieces_added = added
  if (nAcc === 0) return { dataset: ds, info }

  // ---- build the new dataset once
  const nOut = n + added
  let maxId = ds.cluster_id[0]
  let totalPx = 0
  for (let k = 0; k < n; k++) {
    if (ds.cluster_id[k] > maxId) maxId = ds.cluster_id[k]
    totalPx += pxLen[k]
  }
  const outId = new Int32Array(nOut)
  const outSurface = new Float64Array(nOut)
  const outRoundness = new Float64Array(nOut)
  const outShort = new Float64Array(nOut)
  const outLong = new Float64Array(nOut)
  const outVolume = new Float64Array(nOut)
  const outX = new Float64Array(nOut)
  const outY = new Float64Array(nOut)
  const outEdge = new Float64Array(nOut)
  const outStart = new Int32Array(nOut)
  const outLen = new Int32Array(nOut)
  const outRow = new Int32Array(totalPx)
  const outCol = new Int32Array(totalPx)
  let nextId = maxId + 1
  let o = 0 // output cluster index
  let w = 0 // output pixel position
  let si = 0
  // pending run of consecutive unsplit clusters whose pixels are contiguous in the source
  let runS = 0
  let runE = 0
  let runOut = 0
  const flush = () => {
    if (runE > runS) {
      outRow.set(pxRow.subarray(runS, runE), runOut)
      outCol.set(pxCol.subarray(runS, runE), runOut)
    }
    runS = runE = 0
  }
  for (let k = 0; k < n; k++) {
    const s = pxStart[k]
    const len = pxLen[k]
    if (si < nAcc && accK[si] === k) {
      flush()
      const np = accNp[si]
      const lo = accLabOff[si]
      const po = accPieceOff[si]
      // piece start offsets (pieces contiguous, in piece order; pixels in the parent's order)
      if (pieceOff.length < np + 1) pieceOff = new Int32Array(Math.max(np + 1, pieceOff.length * 2))
      pieceOff.fill(0, 0, np + 1)
      for (let i = 0; i < len; i++) pieceOff[labStore[lo + i] + 1]++
      for (let p = 0; p < np; p++) pieceOff[p + 1] += pieceOff[p]
      for (let p = 0; p < np; p++) {
        const so = (po + p) * 7
        outId[o] = nextId++
        outSurface[o] = pieceStats[so]
        outRoundness[o] = pieceStats[so + 1]
        outShort[o] = pieceStats[so + 2]
        outLong[o] = pieceStats[so + 3]
        outVolume[o] = pieceStats[so + 4]
        outX[o] = pieceStats[so + 5]
        outY[o] = pieceStats[so + 6]
        outEdge[o] = ds.edge_weight[k]
        outStart[o] = w + pieceOff[p]
        outLen[o] = pieceOff[p + 1] - pieceOff[p]
        o++
      }
      // scatter (pieceOff[p] doubles as the write cursor, restored afterwards is not needed)
      for (let i = 0; i < len; i++) {
        const p = labStore[lo + i]
        const q = w + pieceOff[p]++
        outRow[q] = pxRow[s + i]
        outCol[q] = pxCol[s + i]
      }
      w += len
      si++
    } else {
      if (runE > runS && s === runE) {
        runE += len
      } else {
        flush()
        runS = s
        runE = s + len
        runOut = w
      }
      outId[o] = ds.cluster_id[k]
      outSurface[o] = ds.surface[k]
      outRoundness[o] = ds.roundness[k]
      outShort[o] = ds.short_axis[k]
      outLong[o] = ds.long_axis[k]
      outVolume[o] = ds.volume[k]
      outX[o] = ds.xmean[k]
      outY[o] = ds.ymean[k]
      outEdge[o] = ds.edge_weight[k]
      outStart[o] = w
      outLen[o] = len
      o++
      w += len
    }
  }
  flush()
  const dataset = makeDataset({
    n: nOut,
    cluster_id: outId,
    surface: outSurface,
    roundness: outRoundness,
    short_axis: outShort,
    long_axis: outLong,
    volume: outVolume,
    xmean: outX,
    ymean: outY,
    edge_weight: outEdge,
    px_start: outStart,
    px_len: outLen,
    px_row: outRow,
    px_col: outCol,
  }, { pixel_scale: ds.pixel_scale, label: ds.label, meta: ds.meta })
  return { dataset, info }
}

// ---------------------------------------------------------------- 5. Dv at detection
/**
 * What `summarizeDataset` reports for Dv10/50/90 and the particle count of `ds`
 * (same filter, same diameters, same volume-equivalent weights), or null without a pixel scale
 * or particles. Used for `split_info.unsplit`.
 */
export function unsplitDv(ds) {
  const s = ds.pixel_scale
  if (!(s > 0)) return null
  const f = filterByMinDiameter(ds, s, (ds.meta || {}).min_diameter_um)
  if (f.n === 0) return null
  const d = metricValues(f, 'diameter', s)
  const w = metricWeights(f, 'mass', s)
  const [dv10, dv50, dv90] = weightedPercentiles(d, w, [10.0, 50.0, 90.0])
  return finiteOrNull({ cluster_count: f.n, dv10_mm: dv10, dv50_mm: dv50, dv90_mm: dv90 })
}
