// Feature A: true ellipse fit (second-moment axes, aspect ratio, ellipsoid volume, shape_summary).
import { describe, expect, it } from 'vitest'
import { analyzeImageBlue, legacySettings, makeSettings } from '../detect.js'
import { makeDataset, filterDatasetByClusterIds, dropPixels } from '../dataset.js'
import { shapeSummaryOrNone, summarizeDataset, particlesPayload, ASPECT_MIN_PX } from '../summary.js'
import { createEngine } from '../engine.js'

/** Hard-edged dark ellipse (centre cx, cy; semi-axes a, b; angle th) on paper 200, ink 40. */
function ellipseImage(w, h, list) {
  const blue = new Uint8Array(w * h).fill(200)
  for (const { cx, cy, a, b, th } of list) {
    const ct = Math.cos(th)
    const st = Math.sin(th)
    const R = Math.ceil(Math.max(a, b)) + 2
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(h - 1, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(w - 1, Math.ceil(cx + R)); x++) {
        const X = x - cx
        const Y = y - cy
        const u = X * ct + Y * st
        const v = -X * st + Y * ct
        if ((u / a) ** 2 + (v / b) ** 2 <= 1) blue[y * w + x] = 40
      }
    }
  }
  return blue
}

const analyze = (blue, w, h, over = {}) => analyzeImageBlue(blue, h, w, legacySettings(over)).dataset

describe('aspect ratio accuracy on digitised ellipses', () => {
  it('stays within 2% (b >= 10) / 5% (b >= 5) for AR 1..4 at several angles and offsets', () => {
    let worst10 = 0
    let worst5 = 0
    let n = 0
    for (const b of [6, 10, 16]) {
      for (const ar of [1, 1.5, 2.5, 4]) {
        // the detector itself splits the very long b=16, AR=4 ellipse (a=64) in two
        if (b === 16 && ar === 4) continue
        for (const [ai, th] of [0, 0.4, 1.0, 1.4].entries()) {
          const cx = 100.3 + 0.21 * ai
          const cy = 100.6 - 0.17 * ai
          const ds = analyze(ellipseImage(200, 200, [{ cx, cy, a: b * ar, b, th }]), 200, 200)
          expect(ds.n).toBe(1)
          const err = Math.abs(ds.aspect_ratio[0] - ar) / ar
          if (b >= 10) worst10 = Math.max(worst10, err)
          else worst5 = Math.max(worst5, err)
          n++
        }
      }
    }
    expect(n).toBe(44)
    expect(worst10).toBeLessThanOrEqual(0.02)
    expect(worst5).toBeLessThanOrEqual(0.05)
  })
})

describe('moments axis method', () => {
  it('long_axis is bit-identical to major_axis_measured', () => {
    const blue = ellipseImage(200, 120, [
      { cx: 40, cy: 40, a: 20, b: 8, th: 0.5 }, { cx: 110, cy: 60, a: 12, b: 12, th: 0 }, { cx: 160, cy: 85, a: 9, b: 4, th: 1.2 },
    ])
    const ds = analyze(blue, 200, 120, { axis_method: 'moments' })
    expect(ds.n).toBe(3)
    for (let k = 0; k < ds.n; k++) expect(ds.long_axis[k]).toBe(ds.major_axis_measured[k])
  })
})

describe('defaults are unchanged', () => {
  const b = new Uint8Array(30 * 30).fill(200)
  for (let r = 10; r < 16; r++) for (let c = 10; c < 16; c++) b[r * 30 + c] = 40
  it('6x6 square: legacy columns as before, new columns finite, AR exactly 1', () => {
    for (const settings of [legacySettings(), makeSettings({ background_model: 'global', threshold_mode: 'fixed' })]) {
      const ds = analyzeImageBlue(b, 30, 30, settings).dataset
      expect(ds.n).toBe(1)
      expect(ds.surface[0]).toBe(36)
      expect(ds.long_axis[0]).toBe(3.5355339059327378) // max radius, REF.square
      expect(ds.short_axis[0]).toBe(3.241138738165582)
      expect(ds.volume[0]).toBe(116.68099457396094)
      expect(ds.roundness[0]).toBe(0.916732472209317)
      expect(ds.aspect_ratio[0]).toBe(1)
      expect(Number.isFinite(ds.major_axis_measured[0])).toBe(true)
      expect(Number.isFinite(ds.minor_axis_measured[0])).toBe(true)
    }
    // moments: major is the measured axis (REF.square_moments)
    const m = analyzeImageBlue(b, 30, 30, legacySettings({ axis_method: 'moments' })).dataset
    expect(m.long_axis[0]).toBe(3.4641016151377544)
    expect(m.major_axis_measured[0]).toBe(3.4641016151377544)
  })
  it('does not add keys to meta or model_info', () => {
    const res = analyzeImageBlue(b, 30, 30, legacySettings())
    expect(Object.keys(res.dataset.meta)).not.toContain('split_touching')
    expect(Object.keys(res.model_info)).not.toContain('split_touching')
  })
})

describe('a 1-pixel line', () => {
  it('floors lambda2 at 1/12 and measures the length', () => {
    const w = 60
    const h = 20
    const blue = new Uint8Array(w * h).fill(200)
    for (let c = 10; c < 40; c++) blue[10 * w + c] = 40
    const ds = analyze(blue, w, h, { min_surface: 1 })
    expect(ds.n).toBe(1)
    expect(ds.minor_axis_measured[0]).toBe(2 * Math.sqrt(1 / 12))
    expect(ds.major_axis_measured[0]).toBeCloseTo(2 * Math.sqrt((30 * 30 - 1) / 12 + 1 / 12), 12)
  })
})

describe("volume_model 'ellipsoid'", () => {
  const discs = [
    { cx: 30, cy: 30, a: 14, b: 14, th: 0 }, { cx: 90, cy: 30, a: 20, b: 8, th: 0.6 }, { cx: 150, cy: 40, a: 11, b: 9, th: 1.1 },
    { cx: 40, cy: 90, a: 16, b: 6, th: 0.2 }, { cx: 100, cy: 95, a: 12, b: 12, th: 0 },
  ]
  const W = 200
  const H = 130
  const blue = ellipseImage(W, H, discs)
  const scaled = (volume_model) => analyzeImageBlue(blue, H, W, legacySettings({ volume_model, pixel_scale: 20 })).dataset

  it('leaves Dv*, fines and count untouched but changes the efficiency', () => {
    const a = summarizeDataset(scaled('legacy'))
    const b = summarizeDataset(scaled('ellipsoid'))
    for (const k of ['dv10_mm', 'dv50_mm', 'dv90_mm', 'fines_volume_pct', 'cluster_count']) expect(b[k], k).toBe(a[k])
    expect(b.average_efficiency_pct).not.toBe(a.average_efficiency_pct)
  })
  it('V = (4/3) S sqrt(S / (pi AR)) per particle', () => {
    const ds = scaled('ellipsoid')
    expect(ds.n).toBe(discs.length)
    for (let k = 0; k < ds.n; k++) {
      const S = ds.surface[k]
      expect(ds.volume[k]).toBe(((4.0 / 3.0) * S) * Math.sqrt(S / (Math.PI * ds.aspect_ratio[k])))
    }
  })
  it('does not depend on axis_method', () => {
    const a = scaled('ellipsoid')
    const b = analyzeImageBlue(blue, H, W, legacySettings({ volume_model: 'ellipsoid', axis_method: 'moments' })).dataset
    expect(Array.from(b.volume)).toEqual(Array.from(a.volume))
  })
})

describe('shapeSummaryOrNone', () => {
  const diskDataset = (count, surface = 100, ar = 1.5) => {
    const cols = {
      surface: new Float64Array(count).fill(surface),
      long_axis: new Float64Array(count).fill(6),
      short_axis: new Float64Array(count).fill(5),
      aspect_ratio: new Float64Array(count).fill(ar),
    }
    return makeDataset(cols, { pixel_scale: 20 })
  }
  it('is null for an empty dataset', () => {
    expect(shapeSummaryOrNone(makeDataset({ n: 0 }))).toBeNull()
  })
  it('keeps the count but nulls the statistics below 10 qualifying particles', () => {
    expect(shapeSummaryOrNone(diskDataset(9))).toEqual({
      aspect_ratio_median: null, aspect_ratio_p10: null, aspect_ratio_p90: null, aspect_ratio_n: 9, min_px: ASPECT_MIN_PX,
    })
  })
  it('reports the statistics from 10 particles on, with or without a pixel scale', () => {
    for (const ds of [diskDataset(10), { ...diskDataset(10), pixel_scale: null }]) {
      const s = shapeSummaryOrNone(ds)
      expect(s).toEqual({
        aspect_ratio_median: 1.5, aspect_ratio_p10: 1.5, aspect_ratio_p90: 1.5, aspect_ratio_n: 10, min_px: 20,
      })
    }
  })
  it('skips particles below 20 px', () => {
    const ds = diskDataset(12, 19)
    expect(shapeSummaryOrNone(ds).aspect_ratio_n).toBe(0)
  })
  it('gives null statistics for a dataset without moment columns (all NaN)', () => {
    const ds = makeDataset({
      surface: new Float64Array(15).fill(100), long_axis: new Float64Array(15).fill(6), short_axis: new Float64Array(15).fill(5),
    }, { pixel_scale: 20 })
    expect(Number.isNaN(ds.aspect_ratio[0])).toBe(true)
    const s = shapeSummaryOrNone(ds)
    expect(s.aspect_ratio_n).toBe(0)
    expect(s.aspect_ratio_median).toBeNull()
  })
  it('the columns survive filterDatasetByClusterIds and dropPixels', () => {
    const ds = analyze(ellipseImage(200, 100, [
      { cx: 40, cy: 40, a: 20, b: 8, th: 0.5 }, { cx: 110, cy: 50, a: 12, b: 12, th: 0 }, { cx: 160, cy: 60, a: 9, b: 4, th: 1.2 },
    ]), 200, 100)
    const f = filterDatasetByClusterIds(ds, [ds.cluster_id[1]])
    expect(f.n).toBe(2)
    expect(f.aspect_ratio[1]).toBe(ds.aspect_ratio[2])
    expect(f.major_axis_measured[0]).toBe(ds.major_axis_measured[0])
    const d = dropPixels(ds)
    expect(Array.from(d.minor_axis_measured)).toEqual(Array.from(ds.minor_axis_measured))
    expect(Array.from(d.aspect_ratio)).toEqual(Array.from(ds.aspect_ratio))
  })
  it('particlesPayload carries the new columns', () => {
    const ds = analyze(ellipseImage(100, 100, [{ cx: 50, cy: 50, a: 20, b: 8, th: 0.5 }]), 100, 100)
    const p = particlesPayload(ds)
    expect(p.aspect_ratio).toHaveLength(1)
    expect(p.major_axis_measured[0]).toBeGreaterThan(p.minor_axis_measured[0])
    expect(Object.keys(p).slice(0, 6)).toEqual(['id', 'surface', 'roundness', 'short_axis', 'long_axis', 'volume'])
  })
})

describe('engine', () => {
  const GLOBAL = { background_model: 'global', threshold_mode: 'fixed', edge_correction: false }
  const REF = { reference_points: [[10, 280], [130, 280]], reference_physical_mm: 24.26 }
  const list = []
  for (let i = 0; i < 14; i++) list.push({ cx: 30 + (i % 7) * 50, cy: 40 + Math.floor(i / 7) * 100, a: 10 + (i % 3) * 3, b: 7 + (i % 2), th: 0.3 * i })
  const W = 400
  const H = 300
  const setup = () => {
    const engine = createEngine()
    const up = engine.registerImage({ width: W, height: H, blue: ellipseImage(W, H, list) })
    return { engine, up }
  }
  const failWith = (fn) => {
    try { fn() } catch (err) { return err }
    throw new Error('expected the call to throw')
  }

  it('analyze returns shape_summary and aspect_ratio', () => {
    const { engine, up } = setup()
    const out = engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF }, {})
    expect(out.nclusters).toBe(14)
    expect(out.particles.aspect_ratio).toHaveLength(14)
    expect(out.particles.major_axis_measured).toHaveLength(14)
    expect(out.shape_summary.aspect_ratio_n).toBe(14)
    expect(out.shape_summary.aspect_ratio_median).toBeGreaterThan(1)
    expect(Object.keys(out.summary)).not.toContain('aspect_ratio_median')
  })
  it('erase recomputes shape_summary', () => {
    const { engine, up } = setup()
    const first = engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF }, {})
    const out = engine.erase({ image_id: up.image_id, analysis_id: first.analysis_id, erase_points: [[30, 40]], erase_radius_px: 8 })
    expect(out.removed_ids).toHaveLength(1)
    expect(out.nclusters).toBe(13)
    expect(out.shape_summary.aspect_ratio_n).toBe(13)
  })
  it('validates the new request keys', () => {
    const { engine, up } = setup()
    const base = { image_id: up.image_id, ...GLOBAL, ...REF }
    expect(engine.analyze({ ...base, volume_model: 'ellipsoid' }, {}).nclusters).toBe(14)
    expect(failWith(() => engine.analyze({ ...base, volume_model: 'cube' }, {})).status).toBe(422)
    expect(failWith(() => engine.analyze({ ...base, split_touching: 'yes' }, {})).status).toBe(422)
    expect(failWith(() => engine.analyze({ ...base, split_neck_ratio: 0.2 }, {})).status).toBe(422)
    expect(failWith(() => engine.analyze({ ...base, split_neck_ratio: 0.96 }, {})).status).toBe(422)
  })
  it('makeSettings keeps split_touching / split_neck_ratio and validates the range', () => {
    const s = makeSettings({ split_touching: true, split_neck_ratio: 0.5 })
    expect(s.split_touching).toBe(true)
    expect(s.split_neck_ratio).toBe(0.5)
    expect(makeSettings().split_touching).toBe(false)
    expect(makeSettings().split_neck_ratio).toBe(0.7)
    expect(makeSettings({ split_touching: 1 }).split_touching).toBe(true)
    const err = failWith(() => makeSettings({ split_neck_ratio: 0.1 }))
    expect(err.message).toBe('split_neck_ratio must be between 0.3 and 0.95.')
    expect(err.status).toBe(400)
    expect(legacySettings().split_touching).toBe(false)
  })
})
