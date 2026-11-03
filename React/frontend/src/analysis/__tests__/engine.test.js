// Engine ops run inline (no Worker, no DOM): registerImage -> analyze -> erase -> histogram -> compare.
import { describe, expect, it } from 'vitest'
import { createEngine, layerToRgba } from '../engine.js'

const GLOBAL = { background_model: 'global', threshold_mode: 'fixed', edge_correction: false }

/** Bright paper (200) with dark discs: [{r: row, c: col, rad}] */
function discImage(width, height, discs) {
  const blue = new Uint8Array(width * height).fill(200)
  for (const { r, c, rad } of discs) {
    for (let y = Math.max(0, r - rad); y <= Math.min(height - 1, r + rad); y++) {
      for (let x = Math.max(0, c - rad); x <= Math.min(width - 1, c + rad); x++) {
        if ((y - r) * (y - r) + (x - c) * (x - c) <= rad * rad) blue[y * width + x] = 40
      }
    }
  }
  return blue
}

const DISCS = [
  { r: 200, c: 300, rad: 14 }, // full-resolution row 200, column 300
  { r: 60, c: 80, rad: 12 },
  { r: 120, c: 150, rad: 10 },
]
const REF = { reference_points: [[10, 280], [130, 280]], reference_physical_mm: 24.26 }

function setup(discs = DISCS, width = 400, height = 300) {
  const engine = createEngine()
  const up = engine.registerImage({ width, height, blue: discImage(width, height, discs) })
  return { engine, up, width, height }
}

const fail = (fn) => {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw')
}

describe('registerImage', () => {
  it('returns the upload response', () => {
    const { up } = setup()
    expect(up.width).toBe(400)
    expect(up.height).toBe(300)
    expect(up.image_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(up.reference_objects['US Quarter']).toBe(24.26)
    expect(up.reference_objects.Custom).toBeUndefined()
  })

  it('keeps a supplied image_id, forgets the previous image and rejects huge photos', () => {
    const engine = createEngine()
    engine.registerImage({ image_id: 'a', width: 2, height: 2, blue: new Uint8Array(4) })
    engine.registerImage({ image_id: 'b', width: 2, height: 2, blue: new Uint8Array(4) })
    expect(engine.hasImage('a')).toBe(false)
    expect(engine.hasImage('b')).toBe(true)
    const err = fail(() => engine.registerImage({ width: 8000, height: 6000, blue: new Uint8Array(0) }))
    expect(err.status).toBe(413)
    expect(err.message).toBe('Image is too large (8000x6000); limit is 40 megapixels.')
  })
})

describe('photos shrunk while decoding', () => {
  it('accepts a >40 MP photo when it was decoded smaller, and keeps full-resolution coordinates', () => {
    // 8064x6048 (48.8 MP) decoded at 80x60; the UI keeps showing / clicking the full photo.
    const engine = createEngine()
    const up = engine.registerImage({
      width: 80, height: 60, blue: new Uint8Array(80 * 60).fill(200),
      fullWidth: 8064, fullHeight: 6048, decodeScale: 80 / 8064,
    })
    expect([up.width, up.height]).toEqual([8064, 6048])
    const out = engine.analyze({
      image_id: up.image_id, ...GLOBAL,
      reference_points: [[1000, 500], [5000, 500]], reference_physical_mm: 24.26,
    }, {})
    expect([out.width, out.height]).toEqual([80, 60])
    expect(out.analysis_scale).toBeCloseTo(80 / 8064, 12)
    expect(out.pixel_scale).toBeCloseTo((4000 / 24.26) * (80 / 8064), 12)
  })

  it('still rejects an undecoded photo above 40 MP', () => {
    const engine = createEngine()
    const err = fail(() => engine.registerImage({ width: 8064, height: 6048, blue: new Uint8Array(0) }))
    expect(err.status).toBe(413)
  })
})

describe('analyze', () => {
  it('returns the server shape with plain arrays and drawable layers', () => {
    const { engine, up, width, height } = setup()
    const out = engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF, min_surface: 5 }, {})
    expect(out.engine).toBe('local')
    expect(out.nclusters).toBe(3)
    expect(out.width).toBe(width)
    expect(out.height).toBe(height)
    expect(out.analysis_scale).toBe(1)
    expect(out.analysis_id).toMatch(new RegExp(`^${up.image_id}\\.[0-9a-f]{12}$`))
    expect(out.pixel_scale).toBeCloseTo(120 / 24.26, 9)
    expect(Array.isArray(out.particles.id)).toBe(true)
    expect(out.particles.id).toHaveLength(3)
    expect(out.summary).toBeTruthy()
    for (const key of ['threshold_layer', 'cluster_layer']) {
      expect(out[key].width).toBe(width)
      expect(out[key].height).toBe(height)
      expect(out[key].index).toBeInstanceOf(Uint8Array)
    }
    expect(Object.keys(out.timings_ms)).toEqual(expect.arrayContaining(['analyze', 'total']))
    expect(out.threshold_layer.index.some((v) => v === 1)).toBe(true)
    expect(out.cluster_layer.index.some((v) => v === 1)).toBe(true)
  })

  it('has no summary without a pixel scale', () => {
    const { engine, up } = setup()
    const out = engine.analyze({ image_id: up.image_id, ...GLOBAL, min_surface: 5 }, {})
    expect(out.summary).toBeNull()
    expect(out.pixel_scale).toBeNull()
    expect(out.nclusters).toBe(3)
  })

  it('reports progress phases', () => {
    const { engine, up } = setup()
    const phases = new Set()
    engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF }, { onProgress: (phase) => phases.add(phase) })
    expect(phases.has('layers')).toBe(true)
  })

  it('uses the server error text', () => {
    const { engine, up } = setup()
    let err = fail(() => engine.analyze({ image_id: 'nope' }, {}))
    expect([err.status, err.message]).toEqual([404, 'Image not found. Upload first.'])

    err = fail(() => engine.analyze({ image_id: up.image_id, reference_points: [[10, 10], [10.5, 10.5]], reference_physical_mm: 24 }, {}))
    expect([err.status, err.message]).toEqual([400, 'Reference points are too close together (need at least 2 px).'])
  })

  it('validates request ranges like the API (422, field: message)', () => {
    const { engine, up } = setup()
    const id = up.image_id
    const cases = [
      [{ analysis_scale_pct: 5 }, 'analysis_scale_pct'],
      [{ analysis_scale_pct: 55.5 }, 'analysis_scale_pct'],
      [{ threshold_percent: 0 }, 'threshold_percent'],
      [{ reference_threshold: 1.5 }, 'reference_threshold'],
      [{ max_cost: -1 }, 'max_cost'],
      [{ max_cluster_axis: 500 }, 'max_cluster_axis'],
      [{ min_roundness: 2 }, 'min_roundness'],
      [{ reference_points: [[1, 1], [2, 2], [3, 3]] }, 'reference_points'],
      [{ reference_physical_mm: 0 }, 'reference_physical_mm'],
      [{ reference_physical_mm: 1001 }, 'reference_physical_mm'],
      [{ background_model: 'cubic' }, 'background_model'],
      [{ volume_model: 'cube' }, 'volume_model'],
      [{ min_diameter_um: -1 }, 'min_diameter_um'],
      [{ click_sigma_px: 101 }, 'click_sigma_px'],
    ]
    for (const [extra, field] of cases) {
      const err = fail(() => engine.analyze({ image_id: id, ...extra }, {}))
      expect(err.status, field).toBe(422)
      expect(err.message.startsWith(`${field}:`), err.message).toBe(true)
    }
  })

  it('rounds the analysis size half-to-even and scales the pixel scale', () => {
    // 201x161 at 50% -> 100.5 x 80.5 -> banker's rounding gives 100 x 80 (Math.round would give 101 x 81)
    const engine = createEngine()
    const up = engine.registerImage({ width: 201, height: 161, blue: new Uint8Array(201 * 161).fill(200) })
    const out = engine.analyze({
      image_id: up.image_id, ...GLOBAL, analysis_scale_pct: 50,
      reference_points: [[0, 0], [100, 0]], reference_physical_mm: 25,
    }, {})
    expect([out.width, out.height]).toEqual([100, 80])
    expect(out.analysis_scale).toBe(0.5)
    expect(out.pixel_scale).toBeCloseTo((100 / 25) * 0.5, 12)
    expect(out.nclusters).toBe(0)
    expect(out.cluster_layer.width).toBe(100)
  })

  it('caps the analysis size at 16 MP', () => {
    const w = 4400
    const h = 3700 // 16.28 MP
    const engine = createEngine()
    const up = engine.registerImage({ width: w, height: h, blue: new Uint8Array(w * h).fill(200) })
    const out = engine.analyze({ image_id: up.image_id, ...GLOBAL, quick_mode: true }, {})
    expect(out.analysis_scale).toBeCloseTo(Math.sqrt(16e6 / (w * h)), 12)
    expect(out.width * out.height).toBeLessThanOrEqual(16e6 * 1.001)
    expect(out.width).toBeLessThan(w)
  }, 60000)
})

describe('erase', () => {
  it('needs an analysis', () => {
    const { engine, up } = setup()
    const err = fail(() => engine.erase({ image_id: up.image_id, erase_points: [[1, 1]] }))
    expect([err.status, err.message]).toEqual([404, 'No analysis found for this image.'])
  })

  it('validates points and radius', () => {
    const { engine, up } = setup()
    expect(fail(() => engine.erase({ image_id: up.image_id, erase_points: [] })).status).toBe(422)
    expect(fail(() => engine.erase({ image_id: up.image_id, erase_points: [[1, 1]], erase_radius_px: 0 })).status).toBe(422)
    expect(fail(() => engine.erase({ image_id: up.image_id, erase_points: [[1, 1]], erase_radius_px: 6000 })).status).toBe(422)
  })

  it('maps a click [x=col, y=row] in full-resolution pixels to analysis [row*s, col*s] at 50%', () => {
    const { engine, up } = setup()
    const analysed = engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF, analysis_scale_pct: 50 }, {})
    expect(analysed.nclusters).toBe(3)
    expect(analysed.width).toBe(200)

    // swapped coordinates (x=row, y=col) hit nothing
    const miss = engine.erase({ image_id: up.image_id, erase_points: [[200, 300]], erase_radius_px: 8 })
    expect(miss.removed_ids).toEqual([])
    expect(miss.nclusters).toBe(3)

    // x=300 (column), y=200 (row) hits the first disc
    const hit = engine.erase({ image_id: up.image_id, erase_points: [[300, 200]], erase_radius_px: 8 })
    expect(hit.removed_ids).toHaveLength(1)
    expect(hit.nclusters).toBe(2)
    expect(hit.cluster_layer.width).toBe(200)
    expect(hit.summary.cluster_count).toBe(2)

    // earlier removals are carried and merged, ids come back sorted
    const more = engine.erase({
      image_id: up.image_id, erase_points: [[80, 60]], erase_radius_px: 8, already_removed_ids: hit.removed_ids,
    })
    expect(more.removed_ids).toHaveLength(2)
    expect([...more.removed_ids]).toEqual([...more.removed_ids].sort((a, b) => a - b))
    expect(more.nclusters).toBe(1)
  })

  it('scales the brush radius with the analysis scale', () => {
    const { engine, up } = setup()
    engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF, analysis_scale_pct: 50 }, {})
    // 20 px (full-resolution) away from the disc centre: out of reach for a 10 px brush, within a 30 px one
    const near = engine.erase({ image_id: up.image_id, erase_points: [[300, 220]], erase_radius_px: 10 })
    expect(near.removed_ids).toEqual([])
    const wide = engine.erase({ image_id: up.image_id, erase_points: [[300, 220]], erase_radius_px: 30 })
    expect(wide.removed_ids).toHaveLength(1)
  })
})

describe('histogram and compare', () => {
  it('builds the series the chart draws', () => {
    const { engine, up } = setup()
    engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF }, {})
    const h = engine.histogram({ image_id: up.image_id, removed_cluster_ids: [], include_png: false, weight_mode: 'number' })
    expect(h.series.edges.length).toBeGreaterThan(2)
    expect(h.series.series[0].fractions).toHaveLength(h.series.edges.length - 1)
    expect(typeof h.unit).toBe('string')
    expect(h.scale).toBeGreaterThan(0)
  })

  it('answers with the server texts', () => {
    const { engine, up } = setup()
    let err = fail(() => engine.histogram({ image_id: up.image_id }))
    expect([err.status, err.message]).toEqual([404, 'No analysis found for this image.'])
    err = fail(() => engine.compare({ runs: [{ image_id: 'ghost.1' }] }))
    expect([err.status, err.message]).toEqual([404, 'No analysis found for image ghost.1.'])

    engine.analyze({ image_id: up.image_id, ...GLOBAL }, {}) // no scale
    err = fail(() => engine.histogram({ image_id: up.image_id }))
    expect([err.status, err.message]).toEqual([400, 'No particles or no pixel scale set.'])
  })

  it('compares frozen runs by analysis_id even after the image is analysed again', () => {
    const { engine, up } = setup()
    const first = engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF }, {})
    const second = engine.analyze({ image_id: up.image_id, ...GLOBAL, ...REF, threshold_percent: 50 }, {})
    expect(second.analysis_id).not.toBe(first.analysis_id)
    const out = engine.compare({
      runs: [
        { image_id: first.analysis_id, removed_cluster_ids: [], label: 'Run 1' },
        { image_id: second.analysis_id, removed_cluster_ids: [], label: 'Run 2' },
      ],
      include_png: false,
    })
    expect(out.per_run.map((r) => r.label)).toEqual(['Run 1', 'Run 2'])
    expect(out.series.series).toHaveLength(2)
    expect(out.combined).toBeTruthy()
    // erase still works on the latest analysis
    const er = engine.erase({ image_id: up.image_id, erase_points: [[300, 200]], erase_radius_px: 8 })
    expect(er.removed_ids.length).toBeGreaterThan(0)
  })
})

describe('layerToRgba', () => {
  it('writes palette colours with alpha 255 and leaves index 0 transparent', () => {
    const layer = {
      width: 3, height: 1, index: Uint8Array.from([0, 1, 2]), palette: [[255, 59, 48], [80, 160, 255]],
    }
    expect([...layerToRgba(layer)]).toEqual([0, 0, 0, 0, 255, 59, 48, 255, 80, 160, 255, 255])
  })
})
