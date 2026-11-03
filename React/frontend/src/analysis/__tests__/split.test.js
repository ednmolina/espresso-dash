// Touching-particle split (feature B): geometry primitives, the full pipeline on synthetic discs,
// conservation / ids, the off path, the unsplit Dv, acceptance, phases and the engine operations.
import { describe, expect, it } from 'vitest'
import { analyzeImageBlue, legacySettings, makeSettings, clusterIndexLayer, detectParticles } from '../detect.js'
import { createEngine } from '../engine.js'
import { summaryOrNone } from '../summary.js'
import { mulberry32 } from '../prng.js'
import { makeDataset } from '../dataset.js'
import {
  SPLIT_MIN_PX, SPLIT_SOLIDITY_MAX, SPLIT_MIN_PEAK_PX, clusterSolidity, edtSquared, splitClusterPixels,
  splitTouching, unsplitDv, releaseSplitBuffers,
} from '../split.js'
import { loadCase, inflateBlue, settingsFor, expectClusters } from './fixtureUtils.js'

// ---------------------------------------------------------------- helpers
/** Paper (200) with dark (40) discs {r, c, rad} and optional axis-aligned ellipses {r, c, a, b}. */
function drawImage(width, height, shapes) {
  const blue = new Uint8Array(width * height).fill(200)
  for (const s of shapes) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dy = y - s.r
        const dx = x - s.c
        const inside = s.rad !== undefined ? dy * dy + dx * dx <= s.rad * s.rad
          : s.half !== undefined ? Math.abs(dy) <= s.half && Math.abs(dx) <= s.half
            : (dx / s.a) ** 2 + (dy / s.b) ** 2 <= 1
        if (inside) blue[y * width + x] = 40
      }
    }
  }
  return blue
}
const run = (blue, h, w, extra = {}) => analyzeImageBlue(blue, h, w, legacySettings({ split_touching: true, ...extra }))
const pad = (core, gh, gw) => {
  const m = new Uint8Array((gh + 2) * (gw + 2))
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) m[(y + 1) * (gw + 2) + x + 1] = core[y * gw + x]
  return { mask: m, gh: gh + 2, gw: gw + 2 }
}
const bruteEdt = (mask, gh, gw) => {
  const bg = []
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (!mask[y * gw + x]) bg.push([y, x])
  const out = new Float64Array(gh * gw)
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!mask[y * gw + x]) continue
      let best = Infinity
      for (const [by, bx] of bg) best = Math.min(best, (by - y) ** 2 + (bx - x) ** 2)
      out[y * gw + x] = best
    }
  }
  return out
}
const shapeRC = (fn, R = 40) => {
  const rows = []
  const cols = []
  for (let r = 0; r < 2 * R; r++) for (let c = 0; c < 2 * R; c++) if (fn(r + 0.5 - R, c + 0.5 - R)) { rows.push(r + 3); cols.push(c + 3) }
  return [Int32Array.from(rows), Int32Array.from(cols)]
}
const disc = (cy, cx, r) => (y, x) => (y - cy) ** 2 + (x - cx) ** 2 <= r * r
const fourConnected = (rows, cols, ids) => {
  const key = (r, c) => r * 100000 + c
  const cells = new Set(ids.map((i) => key(rows[i], cols[i])))
  const seen = new Set([key(rows[ids[0]], cols[ids[0]])])
  const stack = [[rows[ids[0]], cols[ids[0]]]]
  while (stack.length) {
    const [r, c] = stack.pop()
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(r + dr, c + dc)
      if (cells.has(k) && !seen.has(k)) { seen.add(k); stack.push([r + dr, c + dc]) }
    }
  }
  return seen.size === cells.size
}
const pixelSet = (ds, i) => {
  const out = new Set()
  for (let k = ds.px_start[i]; k < ds.px_start[i] + ds.px_len[i]; k++) out.add(ds.px_row[k] * 1000 + ds.px_col[k])
  return out
}

// ---------------------------------------------------------------- 1. edtSquared
describe('edtSquared', () => {
  it('equals brute force on 200 seeded random masks up to 50x50', () => {
    const rnd = mulberry32(777)
    for (let t = 0; t < 200; t++) {
      const gh = 1 + Math.floor(rnd() * 50)
      const gw = 1 + Math.floor(rnd() * 50)
      const p = 0.3 + rnd() * 0.65
      const core = new Uint8Array(gh * gw)
      for (let i = 0; i < core.length; i++) core[i] = rnd() < p ? 1 : 0
      const { mask, gh: H, gw: W } = pad(core, gh, gw)
      const out = new Float64Array(H * W)
      edtSquared(mask, H, W, out)
      expect(Array.from(out), `mask ${t} (${gh}x${gw}, p=${p.toFixed(2)})`).toEqual(Array.from(bruteEdt(mask, H, W)))
    }
  })

  it('handles the edge cases: single pixel, 1 x n line, full rectangle, ring with a hole', () => {
    const cases = {
      single: [new Uint8Array([1]), 1, 1],
      line: [new Uint8Array(17).fill(1), 1, 17],
      rect: [new Uint8Array(9 * 13).fill(1), 9, 13],
      ring: (() => {
        const core = new Uint8Array(13 * 13).fill(1)
        for (let y = 4; y < 9; y++) for (let x = 4; x < 9; x++) core[y * 13 + x] = 0
        return [core, 13, 13]
      })(),
    }
    for (const [name, [core, h, w]] of Object.entries(cases)) {
      const { mask, gh, gw } = pad(core, h, w)
      const out = new Float64Array(gh * gw)
      edtSquared(mask, gh, gw, out)
      expect(Array.from(out), name).toEqual(Array.from(bruteEdt(mask, gh, gw)))
    }
    const { mask, gh, gw } = pad(new Uint8Array(81).fill(1), 9, 9)
    const out = new Float64Array(gh * gw)
    edtSquared(mask, gh, gw, out)
    expect(out[5 * gw + 5]).toBe(25) // the centre of a 9x9 block is 5 cells from the background
  })
})

// ---------------------------------------------------------------- 2. clusterSolidity
describe('clusterSolidity', () => {
  it('is high for convex shapes and low for non convex ones', () => {
    const sol = (fn) => { const [r, c] = shapeRC(fn); return clusterSolidity(r, c, 0, r.length) }
    expect(sol(disc(0, 0, 12))).toBeGreaterThanOrEqual(SPLIT_SOLIDITY_MAX)
    expect(sol((y, x) => Math.abs(x) <= 8 && Math.abs(y) <= 8)).toBeGreaterThanOrEqual(0.99)
    expect(sol((y, x) => disc(0, -10, 10)(y, x) || disc(0, 10, 10)(y, x))).toBeLessThan(0.9)
    expect(sol((y, x) => Math.abs(x) <= 12 && Math.abs(y) <= 12 && (x < -4 || y < -4))).toBeLessThan(0.9) // L shape
  })
  it('gives 1 for a 1 x 40 line (horizontal and vertical)', () => {
    const z = new Int32Array(40)
    const a = Int32Array.from({ length: 40 }, (_, i) => i + 5)
    expect(clusterSolidity(z, a, 0, 40)).toBeCloseTo(1, 12)
    expect(clusterSolidity(a, z, 0, 40)).toBeCloseTo(1, 12)
  })
  it('works on a sub-range of shared arrays', () => {
    const [r, c] = shapeRC(disc(0, 0, 10))
    const rr = Int32Array.from([...Array(7).fill(1), ...r])
    const cc = Int32Array.from([...Array(7).fill(1), ...c])
    expect(clusterSolidity(rr, cc, 7, rr.length)).toBe(clusterSolidity(r, c, 0, r.length))
  })
})

// ---------------------------------------------------------------- splitClusterPixels
describe('splitClusterPixels', () => {
  it('assigns every pixel a piece and numbers pieces by first row-major appearance', () => {
    const [r, c] = shapeRC((y, x) => disc(0, -10, 10)(y, x) || disc(0, 10, 10)(y, x))
    const labels = new Int32Array(r.length)
    expect(splitClusterPixels(r, c, 0, r.length, 0.7, labels)).toBe(2)
    // piece 0 holds the pixel with the smallest (row, column) of the bbox scan
    let first = 0
    for (let i = 1; i < r.length; i++) if (r[i] < r[first] || (r[i] === r[first] && c[i] < c[first])) first = i
    expect(labels[first]).toBe(0)
    expect(new Set(labels)).toEqual(new Set([0, 1]))
  })
  it('does not depend on the order of the pixel list', () => {
    const [r, c] = shapeRC((y, x) => disc(0, -16, 8)(y, x) || disc(0, 0, 8)(y, x) || disc(0, 16, 8)(y, x))
    const n = r.length
    const a = new Int32Array(n)
    expect(splitClusterPixels(r, c, 0, n, 0.7, a)).toBe(3)
    const rnd = mulberry32(5)
    const perm = Array.from({ length: n }, (_, i) => i).sort(() => rnd() - 0.5)
    const r2 = Int32Array.from(perm, (i) => r[i])
    const c2 = Int32Array.from(perm, (i) => c[i])
    const b = new Int32Array(n)
    expect(splitClusterPixels(r2, c2, 0, n, 0.7, b)).toBe(3)
    for (let k = 0; k < n; k++) expect(b[k]).toBe(a[perm[k]])
  })
  it('keeps the module constants', () => {
    expect([SPLIT_MIN_PX, SPLIT_SOLIDITY_MAX, SPLIT_MIN_PEAK_PX]).toEqual([40, 0.95, 2.0])
  })
})

// ---------------------------------------------------------------- 3. pipeline on synthetic discs
describe('full pipeline on synthetic touching discs (legacy settings, split on)', () => {
  const W = 200
  const H = 120
  const count = (shapes, extra) => run(drawImage(W, H, shapes), H, W, extra).dataset.n

  it('tangent pair -> 2, chain of 3 -> 3, 2x2 block of tangent discs -> 4, r12 + r5 tangent -> 2', () => {
    expect(count([{ r: 60, c: 70, rad: 10 }, { r: 60, c: 90, rad: 10 }])).toBe(2)
    expect(count([{ r: 60, c: 50, rad: 8 }, { r: 60, c: 66, rad: 8 }, { r: 60, c: 82, rad: 8 }])).toBe(3)
    expect(count([
      { r: 50, c: 80, rad: 9 }, { r: 50, c: 98, rad: 9 }, { r: 68, c: 80, rad: 9 }, { r: 68, c: 98, rad: 9 },
    ])).toBe(4)
    expect(count([{ r: 60, c: 60, rad: 12 }, { r: 60, c: 77, rad: 5 }])).toBe(2)
  })
  it('isolated disc, ellipse with AR 3 and square -> 1 each', () => {
    expect(count([{ r: 60, c: 100, rad: 12 }])).toBe(1)
    expect(count([{ r: 60, c: 100, a: 24, b: 8 }])).toBe(1)
    expect(count([{ r: 60, c: 100, half: 10 }])).toBe(1)
  })
  it('an overlap with neck/peak about 0.75 stays whole at ratio 0.7 and splits at 0.8', () => {
    const shapes = [{ r: 60, c: 92, rad: 12 }, { r: 60, c: 108, rad: 12 }]
    expect(count(shapes)).toBe(1)
    expect(count(shapes, { split_neck_ratio: 0.8 })).toBe(2)
  })
  it('reports the counts in split_info', () => {
    const res = run(drawImage(W, H, [{ r: 60, c: 70, rad: 10 }, { r: 60, c: 90, rad: 10 }, { r: 20, c: 20, rad: 6 }]), H, W)
    const { ms, unsplit, ...counts } = res.split_info
    expect(counts).toMatchObject({ neck_ratio: 0.7, clusters_split: 1, pieces_added: 1, rejected_splits: 0 })
    expect(counts.candidates).toBeGreaterThanOrEqual(1)
    expect(typeof ms).toBe('number')
    expect(unsplit).toBeNull() // no pixel scale
    expect(res.model_info.split_touching).toBe(true)
    expect(res.model_info.split_neck_ratio).toBe(0.7)
    expect(res.dataset.meta.split_touching).toBe(true)
    expect(res.dataset.meta.split_neck_ratio).toBe(0.7)
  })
})

// ---------------------------------------------------------------- 4. conservation and ids
describe('conservation and ids', () => {
  const W = 220
  const H = 140
  const shapes = [
    { r: 30, c: 30, rad: 10 }, { r: 30, c: 50, rad: 10 }, // pair (becomes ids max+1, max+2)
    { r: 30, c: 120, rad: 6 }, // isolated
    { r: 90, c: 40, rad: 8 }, { r: 90, c: 56, rad: 8 }, { r: 90, c: 72, rad: 8 }, // chain
    { r: 90, c: 160, rad: 7 },
  ]
  const blue = drawImage(W, H, shapes)
  const off = analyzeImageBlue(blue, H, W, legacySettings()).dataset
  const on = run(blue, H, W).dataset

  it('keeps the pixels, retires the parent ids and numbers the pieces after the old maximum', () => {
    expect(off.n).toBe(4)
    expect(on.n).toBe(off.n + 3)
    const maxOld = Math.max(...off.cluster_id)
    const oldIds = new Set(off.cluster_id)
    const ids = Array.from(on.cluster_id)
    expect(new Set(ids).size).toBe(ids.length)
    const newIds = ids.filter((id) => !oldIds.has(id))
    expect(newIds).toHaveLength(5)
    expect(newIds.every((id) => id > maxOld)).toBe(true)
    expect(newIds).toEqual([...newIds].sort((a, b) => a - b))
    expect(newIds).toEqual(Array.from({ length: 5 }, (_, j) => maxOld + 1 + j))
    // the retired parents are absent, the others untouched and in place
    const kept = ids.filter((id) => oldIds.has(id))
    expect(kept).toHaveLength(2)
    expect(on.px_row.length).toBe(Array.from(on.px_len).reduce((a, b) => a + b, 0))
  })
  it('the pieces partition the parent pixels, are 4-connected and sum to the parent surface', () => {
    const oldIds = new Set(off.cluster_id)
    const owner = new Map()
    for (let i = 0; i < off.n; i++) for (const p of pixelSet(off, i)) owner.set(p, off.cluster_id[i])
    const byParent = new Map()
    let total = 0
    for (let i = 0; i < on.n; i++) {
      const px = pixelSet(on, i)
      total += px.size
      const parents = new Set([...px].map((p) => owner.get(p)))
      expect(parents.size).toBe(1)
      const pid = [...parents][0]
      if (!oldIds.has(on.cluster_id[i])) {
        const ids = Array.from({ length: on.px_len[i] }, (_, k) => on.px_start[i] + k)
        expect(fourConnected(on.px_row, on.px_col, ids)).toBe(true)
      }
      const acc = byParent.get(pid) ?? new Set()
      for (const p of px) {
        expect(acc.has(p)).toBe(false)
        acc.add(p)
      }
      byParent.set(pid, acc)
    }
    for (let i = 0; i < off.n; i++) expect(byParent.get(off.cluster_id[i])).toEqual(pixelSet(off, i))
    expect(total).toBe(Array.from(off.px_len).reduce((a, b) => a + b, 0))
  })
  it('pieces are measured like the detector (xmean, surface, long axis)', () => {
    for (let i = 0; i < on.n; i++) {
      let sx = 0
      let sy = 0
      const n = on.px_len[i]
      for (let k = on.px_start[i]; k < on.px_start[i] + n; k++) { sx += on.px_row[k]; sy += on.px_col[k] }
      expect(on.surface[i]).toBe(n)
      expect(on.xmean[i]).toBe(sx / n)
      expect(on.ymean[i]).toBe(sy / n)
      expect(on.short_axis[i]).toBe(on.surface[i] / (Math.PI * on.long_axis[i]))
    }
  })
  it('the outline layer gives every piece its own centre dot (n2 = n)', () => {
    const layer = clusterIndexLayer([H, W], on)
    let n2 = 0
    for (const v of layer.index) if (v === 2) n2++
    expect(n2).toBe(on.n)
  })
})

// ---------------------------------------------------------------- 5. off is a no-op
describe('split off is a no-op', () => {
  it('matches the committed parity expectations bit for bit and adds no keys', () => {
    for (const name of ['core_legacy_00', 'core_legacy_05', 'core_modern_00']) {
      const c = loadCase(name)
      const blue = inflateBlue(c)
      const flatten = c.expected.flatten.coef ? { flattenCoefOverride: Float64Array.from(c.expected.flatten.coef) } : undefined
      const base = analyzeImageBlue(blue, c.height, c.width, settingsFor(c), flatten)
      const explicit = analyzeImageBlue(inflateBlue(c), c.height, c.width, makeSettings({ ...settingsFor(c), split_touching: false }), flatten)
      expectClusters(explicit.dataset, c.expected.clusters, c.width, { label: name })
      expect(explicit.model_info).toEqual(c.expected.model_info)
      expect(explicit.dataset.meta).toEqual(base.dataset.meta)
      expect(Object.keys(explicit.model_info)).not.toContain('split_touching')
      expect(Object.keys(explicit.dataset.meta)).not.toContain('split_touching')
      expect(Object.keys(explicit.dataset.meta)).not.toContain('split_neck_ratio')
      expect(explicit.split_info).toBeNull()
      expect(base.split_info).toBeNull()
    }
  })
  it('emits no split progress phase and returns the same dataset layout', () => {
    const blue = drawImage(60, 60, [{ r: 30, c: 25, rad: 8 }, { r: 30, c: 41, rad: 8 }])
    const phases = []
    analyzeImageBlue(blue, 60, 60, legacySettings(), { onProgress: (p) => { if (!phases.includes(p)) phases.push(p) } })
    expect(phases).toEqual(['detect', 'measure'])
  })
})

// ---------------------------------------------------------------- 6. nothing to split
describe('split on, nothing to split', () => {
  it('splitTouching returns the same dataset object', () => {
    const blue = drawImage(120, 80, [{ r: 40, c: 30, rad: 12 }, { r: 40, c: 80, a: 20, b: 8 }, { r: 20, c: 100, half: 6 }])
    const thr = new Uint8Array(blue.length)
    for (let i = 0; i < blue.length; i++) thr[i] = blue[i] < 100 ? 1 : 0
    const ds = detectParticles(blue, 80, 120, thr, 200, makeSettings(legacySettings()), null)
    expect(ds.n).toBe(3)
    const out = splitTouching(ds, makeSettings(legacySettings({ split_touching: true })))
    expect(out.dataset).toBe(ds)
    expect(out.info.clusters_split).toBe(0)
    expect(out.info.pieces_added).toBe(0)
  })
  it('reports zero splits and the unsplit Dv of the very same dataset', () => {
    const blue = drawImage(120, 80, [{ r: 40, c: 30, rad: 12 }, { r: 40, c: 80, rad: 9 }])
    const res = run(blue, 80, 120, { pixel_scale: 20 })
    expect(res.split_info.clusters_split).toBe(0)
    expect(res.split_info.unsplit).toEqual(unsplitDv(res.dataset))
    const sum = summaryOrNone(res.dataset)
    expect(res.split_info.unsplit.dv50_mm).toBe(sum.dv50_mm)
  })
  it('handles an empty dataset', () => {
    const ds = makeDataset({ n: 0 }, { pixel_scale: 10 })
    const out = splitTouching(ds, makeSettings(legacySettings({ split_touching: true })))
    expect(out.dataset).toBe(ds)
    expect(unsplitDv(ds)).toBeNull()
  })
})

// ---------------------------------------------------------------- 7. unsplit equals an off run
describe('split_info.unsplit equals what a run with the split off reports', () => {
  const W = 260
  const H = 180
  const shapes = [
    { r: 40, c: 40, rad: 11 }, { r: 40, c: 62, rad: 11 }, { r: 40, c: 180, rad: 14 }, { r: 40, c: 208, rad: 14 },
    { r: 110, c: 60, rad: 9 }, { r: 128, c: 60, rad: 9 }, { r: 110, c: 78, rad: 9 }, { r: 128, c: 78, rad: 9 },
    { r: 120, c: 160, rad: 16 }, { r: 120, c: 180, rad: 5 }, { r: 150, c: 230, rad: 7 }, { r: 8, c: 100, rad: 6 },
  ]
  const scenarios = {
    'legacy settings': legacySettings({ pixel_scale: 18 }),
    'default (poly4, half contrast, edge correction), min diameter': makeSettings({ pixel_scale: 18, min_diameter_um: 400 }),
    'edge correction with a polygon': makeSettings({
      pixel_scale: 18, background_model: 'global', threshold_mode: 'fixed',
      analysis_polygon: [[4, 4], [250, 6], [252, 172], [6, 174]],
    }),
  }
  for (const [label, base] of Object.entries(scenarios)) {
    it(label, () => {
      const blue = drawImage(W, H, shapes)
      const offRes = analyzeImageBlue(Uint8Array.from(blue), H, W, makeSettings({ ...base, split_touching: false }))
      const onRes = analyzeImageBlue(Uint8Array.from(blue), H, W, makeSettings({ ...base, split_touching: true }))
      expect(onRes.split_info.clusters_split).toBeGreaterThan(0)
      const sum = summaryOrNone(offRes.dataset)
      const u = onRes.split_info.unsplit
      expect(u.cluster_count).toBe(sum.cluster_count)
      expect(u.dv10_mm).toBe(sum.dv10_mm)
      expect(u.dv50_mm).toBe(sum.dv50_mm)
      expect(u.dv90_mm).toBe(sum.dv90_mm)
      // splitting changes the distribution, never the pixel total
      const total = (ds) => Array.from(ds.px_len).reduce((a, b) => a + b, 0)
      expect(total(onRes.dataset)).toBe(total(offRes.dataset))
      expect(onRes.dataset.n).toBeGreaterThan(offRes.dataset.n)
    })
  }
})

// ---------------------------------------------------------------- 8. acceptance
describe('all-or-nothing acceptance', () => {
  it('min_surface 60 keeps the r12 + r4 pair whole', () => {
    const blue = drawImage(160, 100, [{ r: 50, c: 60, rad: 12 }, { r: 50, c: 76, rad: 4 }])
    const loose = run(blue, 100, 160)
    expect(loose.dataset.n).toBe(2)
    const strict = run(blue, 100, 160, { min_surface: 60 })
    const parent = analyzeImageBlue(blue, 100, 160, legacySettings({ min_surface: 60 })).dataset
    expect(parent.n).toBe(1)
    expect(strict.split_info.rejected_splits).toBe(1)
    expect(strict.split_info.clusters_split).toBe(0)
    expect(strict.dataset.n).toBe(1)
    expect(strict.dataset.cluster_id[0]).toBe(parent.cluster_id[0])
    expect(strict.dataset.surface[0]).toBe(parent.surface[0])
    expect(strict.dataset.long_axis[0]).toBe(parent.long_axis[0])
  })
  it('a piece failing min_roundness or max_cluster_axis rejects the whole split', () => {
    const blue = drawImage(160, 100, [{ r: 50, c: 60, rad: 12 }, { r: 50, c: 84, rad: 12 }])
    const base = makeSettings(legacySettings())
    const thr = new Uint8Array(blue.length)
    for (let i = 0; i < blue.length; i++) thr[i] = blue[i] < 100 ? 1 : 0
    const ds = detectParticles(blue, 100, 160, thr, 200, base, null)
    expect(ds.n).toBe(1)
    const ok = splitTouching(ds, makeSettings(legacySettings({ split_touching: true })))
    expect(ok.info.clusters_split).toBe(1)
    for (const strict of [{ min_roundness: 0.99 }, { max_cluster_axis: 10 }, { min_surface: 430 }]) {
      const out = splitTouching(ds, { ...base, split_touching: true, ...strict })
      expect(out.dataset, JSON.stringify(strict)).toBe(ds)
      expect(out.info.rejected_splits, JSON.stringify(strict)).toBe(1)
      expect(out.info.clusters_split).toBe(0)
      expect(out.info.pieces_added).toBe(0)
    }
  })
})

// ---------------------------------------------------------------- 9. phases
describe('progress phases', () => {
  it('detect, split, measure with the split on', () => {
    const blue = drawImage(80, 60, [{ r: 30, c: 30, rad: 9 }, { r: 30, c: 48, rad: 9 }])
    const phases = []
    const events = []
    analyzeImageBlue(blue, 60, 80, legacySettings({ split_touching: true }), {
      onProgress: (p, f) => { events.push([p, f]); if (!phases.includes(p)) phases.push(p) },
    })
    expect(phases).toEqual(['detect', 'split', 'measure'])
    expect(events.filter(([p]) => p === 'split').map(([, f]) => f)).toEqual([0, 1])
  })
  it('reports intermediate progress for many candidates (at most every 64)', () => {
    // 150 touching pairs
    const shapes = []
    for (let i = 0; i < 15; i++) for (let j = 0; j < 10; j++) shapes.push({ r: 12 + i * 26, c: 14 + j * 52, rad: 9 }, { r: 12 + i * 26, c: 32 + j * 52, rad: 9 })
    const W = 530
    const H = 400
    const seen = []
    analyzeImageBlue(drawImage(W, H, shapes), H, W, legacySettings({ split_touching: true }), {
      onProgress: (p, f) => { if (p === 'split') seen.push(f) },
    })
    expect(seen[0]).toBe(0)
    expect(seen[seen.length - 1]).toBe(1)
    expect(seen.length).toBe(4) // 0, 64/150, 128/150, 1
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })
})

// ---------------------------------------------------------------- 10. engine
describe('engine', () => {
  const W = 300
  const H = 200
  const shapes = [{ r: 100, c: 100, rad: 14 }, { r: 100, c: 128, rad: 14 }, { r: 40, c: 220, rad: 12 }]
  const REF = { reference_points: [[10, 190], [130, 190]], reference_physical_mm: 12 }
  const GLOBAL = { background_model: 'global', threshold_mode: 'fixed', edge_correction: false }
  const setup = () => {
    const engine = createEngine()
    const up = engine.registerImage({ width: W, height: H, blue: drawImage(W, H, shapes) })
    return { engine, id: up.image_id }
  }
  const fail = (fn) => { try { fn() } catch (e) { return e } throw new Error('expected a throw') }

  it('analyze returns split_info only when asked and 422s a bad value', () => {
    const { engine, id } = setup()
    const off = engine.analyze({ image_id: id, ...REF, ...GLOBAL })
    expect('split_info' in off).toBe(false)
    expect(off.nclusters).toBe(2)
    const on = engine.analyze({ image_id: id, ...REF, ...GLOBAL, split_touching: true })
    expect(on.nclusters).toBe(3)
    expect(on.split_info).toMatchObject({ neck_ratio: 0.7, clusters_split: 1, pieces_added: 1, rejected_splits: 0 })
    expect(on.split_info.unsplit.cluster_count).toBe(2)
    expect(on.split_info.unsplit.dv50_mm).toBe(off.summary.dv50_mm)
    expect(on.summary.split_touching).toBe(true)
    expect(off.summary.split_touching).toBeUndefined()
    const err = fail(() => engine.analyze({ image_id: id, ...REF, split_touching: 'yes' }))
    expect(err.status).toBe(422)
    expect(fail(() => engine.analyze({ image_id: id, ...REF, split_neck_ratio: 2 })).status).toBe(422)
  })

  it('erase removes only the clicked piece', () => {
    const { engine, id } = setup()
    const on = engine.analyze({ image_id: id, ...REF, ...GLOBAL, split_touching: true })
    // the left piece of the pair has its centroid near full-res (x=100, y=100); the right one near x=128
    const res = engine.erase({ image_id: id, erase_points: [[100, 100]], erase_radius_px: 10 })
    expect(res.removed_ids).toHaveLength(1)
    expect(res.nclusters).toBe(on.nclusters - 1)
    expect(on.particles.id).toContain(res.removed_ids[0])
    // the removed id is a piece id: the parent id is gone from the split dataset
    const parentId = on.particles.id.filter((x) => x < res.removed_ids[0])
    expect(parentId.length).toBeGreaterThan(0) // the isolated disc keeps its own, smaller id
    // erasing the same place again with the id carried over keeps it removed
    const again = engine.erase({ image_id: id, erase_points: [[220, 40]], erase_radius_px: 3, already_removed_ids: res.removed_ids })
    expect(again.removed_ids).toHaveLength(2)
    expect(again.nclusters).toBe(on.nclusters - 2)
  })

  it('histogram accepts a piece id and compare works between a split and an unsplit run', () => {
    const { engine, id } = setup()
    const off = engine.analyze({ image_id: id, ...REF, ...GLOBAL })
    const offKey = off.analysis_id
    const on = engine.analyze({ image_id: id, ...REF, ...GLOBAL, split_touching: true })
    const pieceId = Math.max(...on.particles.id)
    const full = engine.histogram({ image_id: on.analysis_id, include_png: false })
    const h = engine.histogram({ image_id: on.analysis_id, removed_cluster_ids: [pieceId], include_png: false })
    expect(full.n).toBe(3)
    expect(h.n).toBe(2)
    const cmp = engine.compare({
      runs: [{ image_id: offKey, label: 'unsplit' }, { image_id: on.analysis_id, label: 'split', removed_cluster_ids: [pieceId] }],
      include_png: false,
    })
    expect(cmp.per_run.map((r) => r.label)).toEqual(['unsplit', 'split'])
    expect(cmp.per_run[0].n).toBe(2)
    expect(cmp.per_run[1].n).toBe(2)
    expect(cmp.per_run[1].mean).toBeLessThan(cmp.per_run[0].mean) // the pieces are smaller than the pair
  })
})

// ---------------------------------------------------------------- 11. determinism
describe('determinism', () => {
  it('two runs give identical datasets', () => {
    const blue = drawImage(220, 140, [
      { r: 30, c: 30, rad: 10 }, { r: 30, c: 50, rad: 10 }, { r: 90, c: 40, rad: 8 }, { r: 90, c: 56, rad: 8 }, { r: 90, c: 72, rad: 8 },
    ])
    const a = run(Uint8Array.from(blue), 140, 220).dataset
    releaseSplitBuffers()
    const b = run(Uint8Array.from(blue), 140, 220).dataset
    expect(b.n).toBe(a.n)
    for (const k of ['cluster_id', 'surface', 'roundness', 'short_axis', 'long_axis', 'volume', 'xmean', 'ymean', 'px_start', 'px_len', 'px_row', 'px_col']) {
      expect(Array.from(b[k]), k).toEqual(Array.from(a[k]))
    }
  })
})
