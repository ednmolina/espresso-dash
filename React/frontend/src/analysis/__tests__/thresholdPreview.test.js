// flatten_threshold_percent + the threshold preview cache/op (engine, worker protocol shape, local front).
import { describe, expect, it } from 'vitest'
import { createEngine } from '../engine.js'
import { analyzeImageBlue, makeSettings } from '../detect.js'
import { createLocalEngine } from '../localEngine.js'
import { createAnalyzerClient } from '../analyzerClient.js'
import { caseNames, inflateBlue, loadCase, maskInfo, settingsFor } from './fixtureUtils.js'

/** Bright paper with a vignette (so poly4 flattening does real work) and dark discs. */
function synthetic(width = 320, height = 240) {
  const blue = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - width / 2, y - height / 2) / width
      blue[y * width + x] = Math.round(230 - 40 * d)
    }
  }
  let seed = 7
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < 40; i++) {
    const cx = 12 + rnd() * (width - 24)
    const cy = 12 + rnd() * (height - 24)
    const rad = 3 + rnd() * 6
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) blue[y * width + x] = 40 + Math.round(rnd() * 30)
      }
    }
  }
  return { width, height, blue }
}

const REF = { reference_points: [[10, 20], [110, 20]], reference_physical_mm: 24.26 }
const POLY = [[20, 20], [300, 15], [305, 220], [15, 225]]

function setup(img = synthetic(), id = 'img') {
  const engine = createEngine()
  engine.registerImage({ image_id: id, width: img.width, height: img.height, blue: img.blue.slice() })
  return { engine, id, ...img }
}

const strip = (r) => {
  const { analysis_id, timings_ms, threshold_layer, cluster_layer, ...rest } = r
  return { rest, threshold: threshold_layer.index, cluster: cluster_layer.index }
}

describe('flatten_threshold_percent', () => {
  it('equal to threshold_percent is identical to omitting it', () => {
    for (const extra of [{}, { analysis_polygon: true }, { background_model: 'global' }]) {
      const body = { ...REF, threshold_percent: 61, ...(extra.analysis_polygon ? { polygon_points: POLY } : {}), ...extra }
      delete body.analysis_polygon
      const a = setup()
      const b = setup()
      const ra = strip(a.engine.analyze({ image_id: a.id, ...body }))
      const rb = strip(b.engine.analyze({ image_id: b.id, ...body, flatten_threshold_percent: 61 }))
      expect(rb.rest).toEqual(ra.rest)
      expect(Buffer.compare(rb.threshold, ra.threshold)).toBe(0)
      expect(Buffer.compare(rb.cluster, ra.cluster)).toBe(0)
    }
  })

  it('is validated like threshold_percent and null is allowed', () => {
    const { engine, id } = setup()
    for (const v of [0.5, 101, 'x']) {
      expect(() => engine.analyze({ image_id: id, ...REF, flatten_threshold_percent: v })).toThrow(/flatten_threshold_percent/)
    }
    expect(() => engine.analyze({ image_id: id, ...REF, flatten_threshold_percent: null })).not.toThrow()
  })

  it('makeSettings defaults it to null and seeds the flatten when set', () => {
    expect(makeSettings({}).flatten_threshold_percent).toBeNull()
    const img = synthetic()
    const a = analyzeImageBlue(img.blue, img.height, img.width, makeSettings({ pixel_scale: 10 }))
    const b = analyzeImageBlue(img.blue, img.height, img.width, makeSettings({ pixel_scale: 10, flatten_threshold_percent: 30 }))
    expect(Buffer.compare(a.blue, b.blue)).not.toBe(0) // the seed matters
  })
})

describe('fixed @ threshold_percent_used + flatten seed 58.8 == default half_contrast', () => {
  const compare = (blue, w, h, base) => {
    const d = analyzeImageBlue(blue.slice(), h, w, makeSettings(base))
    const f = analyzeImageBlue(blue.slice(), h, w, makeSettings({
      ...base, threshold_mode: 'fixed', threshold_percent: d.threshold_percent_used, flatten_threshold_percent: 58.8,
    }))
    expect(maskInfo(f.threshold_mask)).toEqual(maskInfo(d.threshold_mask))
    expect(f.dataset.n).toBe(d.dataset.n)
    expect(f.background_median).toBe(d.background_median)
    expect(Buffer.compare(f.blue, d.blue)).toBe(0)
    expect(f.threshold_percent_used).toBe(d.threshold_percent_used)
    return { d, f }
  }

  it('synthetic image, with and without polygon', () => {
    const img = synthetic()
    compare(img.blue, img.width, img.height, { pixel_scale: 12 })
    compare(img.blue, img.width, img.height, { pixel_scale: 12, analysis_polygon: POLY })
  })

  for (const name of caseNames('core_modern_')) {
    it(name, () => {
      const c = loadCase(name)
      compare(inflateBlue(c), c.width, c.height, settingsFor(c))
    })
  }

  it('through the engine: summary equal apart from threshold_mode', () => {
    const a = setup()
    const b = setup()
    const d = a.engine.analyze({ image_id: a.id, ...REF })
    const f = b.engine.analyze({
      image_id: b.id, ...REF, threshold_mode: 'fixed', threshold_percent: d.summary.threshold_percent_used, flatten_threshold_percent: 58.8,
    })
    expect(f.nclusters).toBe(d.nclusters)
    expect(Buffer.compare(f.threshold_layer.index, d.threshold_layer.index)).toBe(0)
    expect(f.particles).toEqual(d.particles)
    expect({ ...f.summary, threshold_mode: null }).toEqual({ ...d.summary, threshold_mode: null })
  })
})

describe('thresholdPreview', () => {
  const analyzed = (body = {}, img) => {
    const s = setup(img)
    const res = s.engine.analyze({ image_id: s.id, ...REF, ...body })
    return { ...s, res }
  }

  it('at full size equals analyze\'s threshold_layer for the same percent and seed', () => {
    for (const body of [{}, { polygon_points: POLY }, { background_model: 'global' }, { flatten_threshold_percent: 45 }]) {
      const { engine, id, res } = analyzed(body)
      const used = res.summary.threshold_percent_used
      const p = engine.thresholdPreview({ image_id: id, threshold_percent: used, max_pixels: Infinity })
      expect(p.stale).toBeUndefined()
      expect(p.threshold_percent).toBe(used)
      expect([p.width, p.height]).toEqual([res.width, res.height])
      expect(p.step).toBe(1)
      expect(p.threshold_layer.width).toBe(res.threshold_layer.width)
      expect(p.threshold_layer.palette).toEqual(res.threshold_layer.palette)
      expect(Buffer.compare(p.threshold_layer.index, res.threshold_layer.index)).toBe(0)
    }
  })

  it('a fixed-mode analyze at another percent is reproduced by the preview', () => {
    const { engine, id } = analyzed({ background_model: 'poly4', threshold_mode: 'fixed', threshold_percent: 58.8 })
    const p = engine.thresholdPreview({ image_id: id, threshold_percent: 70, max_pixels: Infinity })
    const ref = setup()
    const r = ref.engine.analyze({ image_id: ref.id, ...REF, threshold_mode: 'fixed', threshold_percent: 70, flatten_threshold_percent: 58.8 })
    expect(Buffer.compare(p.threshold_layer.index, r.threshold_layer.index)).toBe(0)
  })

  it('downsampled preview is a strided sample of the full one', () => {
    const { engine, id, res } = analyzed({ polygon_points: POLY })
    const pct = 52
    const full = engine.thresholdPreview({ image_id: id, threshold_percent: pct, max_pixels: Infinity })
    const small = engine.thresholdPreview({ image_id: id, threshold_percent: pct, max_pixels: 10_000 })
    expect(small.step).toBeGreaterThan(1)
    expect(small.width * small.height).toBeLessThanOrEqual(10_000 + small.width + small.height)
    expect([small.source_width, small.source_height]).toEqual([res.width, res.height])
    const { step } = small
    expect(small.width).toBe(Math.ceil(res.width / step))
    expect(small.height).toBe(Math.ceil(res.height / step))
    for (let r = 0; r < small.height; r++) {
      for (let c = 0; c < small.width; c++) {
        expect(small.threshold_layer.index[r * small.width + c]).toBe(full.threshold_layer.index[r * step * res.width + c * step])
      }
    }
  })

  it('default max_pixels leaves small images at full size', () => {
    const { engine, id, res } = analyzed()
    const p = engine.thresholdPreview({ image_id: id, threshold_percent: 60 })
    expect([p.width, p.height, p.step]).toEqual([res.width, res.height, 1])
  })

  it('is stale without an analysis, for another image, and after the image is replaced or dropped', () => {
    const s = setup()
    expect(s.engine.thresholdPreview({ image_id: s.id, threshold_percent: 60 })).toEqual({ stale: true })
    const res = s.engine.analyze({ image_id: s.id, ...REF })
    expect(s.engine.thresholdPreview({ image_id: 'other', threshold_percent: 60 })).toEqual({ stale: true })
    expect(s.engine.thresholdPreview({ image_id: s.id, threshold_percent: 60 }).stale).toBeUndefined()
    s.engine.dropImage(s.id)
    expect(s.engine.thresholdPreview({ image_id: s.id, threshold_percent: 60 })).toEqual({ stale: true })

    const t = setup()
    t.engine.analyze({ image_id: t.id, ...REF })
    t.engine.registerImage({ image_id: 'new', width: 4, height: 4, blue: new Uint8Array(16) })
    expect(t.engine.thresholdPreview({ image_id: t.id, threshold_percent: 60 })).toEqual({ stale: true })
    expect(t.engine.thresholdPreview({ image_id: 'new', threshold_percent: 60 })).toEqual({ stale: true })
    expect(res.analysis_id).toBeTruthy()
  })

  it('is stale when the polygon, analysis_id, background model, seed or scale differ from the cached analysis', () => {
    const { engine, id, res } = analyzed({ polygon_points: POLY })
    const ask = (extra) => engine.thresholdPreview({ image_id: id, threshold_percent: 60, ...extra })
    expect(ask({ polygon_points: POLY }).stale).toBeUndefined()
    expect(ask({ analysis_id: res.analysis_id, analysis_scale_pct: 100, background_model: 'poly4', flatten_threshold_percent: 58.8 }).stale).toBeUndefined()
    expect(ask({ polygon_points: POLY.slice(0, 3) })).toEqual({ stale: true })
    expect(ask({ polygon_points: null })).toEqual({ stale: true })
    expect(ask({ polygon_points: POLY.map(([x, y]) => [x + 1, y]) })).toEqual({ stale: true })
    expect(ask({ analysis_id: 'img.nope' })).toEqual({ stale: true })
    expect(ask({ background_model: 'global' })).toEqual({ stale: true })
    expect(ask({ flatten_threshold_percent: 40 })).toEqual({ stale: true })
    expect(ask({ analysis_scale_pct: 50 })).toEqual({ stale: true })
    // a new analyze with a different polygon replaces the cache
    engine.analyze({ image_id: id, ...REF, polygon_points: POLY.slice(0, 3) })
    expect(ask({ polygon_points: POLY })).toEqual({ stale: true })
    expect(ask({ polygon_points: POLY.slice(0, 3) }).stale).toBeUndefined()
  })

  it('validates its body', () => {
    const { engine, id } = analyzed()
    expect(() => engine.thresholdPreview({ image_id: id })).toThrow(/threshold_percent/)
    expect(() => engine.thresholdPreview({ image_id: id, threshold_percent: 500 })).toThrow(/threshold_percent/)
  })
})

describe('local engine front (inline)', () => {
  const img = synthetic(160, 120)
  const FILE = { name: 'p.png', type: 'image/png' }

  const install = () => {
    globalThis.OffscreenCanvas = class {
      getContext() {
        return {
          clearRect() {},
          drawImage() {},
          getImageData: (sx, sy, sw, sh) => {
            const data = new Uint8ClampedArray(sw * sh * 4)
            for (let r = 0; r < sh; r++) {
              for (let c = 0; c < sw; c++) data[(r * sw + c) * 4] = img.blue[(sy + r) * img.width + sx + c]
            }
            return { data }
          },
        }
      }
    }
    globalThis.createImageBitmap = async () => ({ width: img.width, height: img.height, close() {} })
  }
  const uninstall = () => {
    delete globalThis.OffscreenCanvas
    delete globalThis.createImageBitmap
  }

  it('previews like the engine, returns stale after cancel() without throwing, and never needs cancel itself', async () => {
    install()
    const eng = createLocalEngine({ forceInline: true })
    try {
      const up = await eng.upload(FILE, { expect: Promise.resolve({ width: img.width, height: img.height }) })
      expect(await eng.thresholdPreview({ image_id: up.image_id, threshold_percent: 60 })).toEqual({ stale: true })
      const res = await eng.analyze({ image_id: up.image_id, ...REF, threshold_mode: 'fixed', threshold_percent: 58.8 })
      const [a, b] = await Promise.all([
        eng.thresholdPreview({ image_id: up.image_id, threshold_percent: 50 }),
        eng.thresholdPreview({ image_id: up.image_id, threshold_percent: 58.8, max_pixels: Infinity }),
      ])
      expect(a.threshold_percent).toBe(50)
      // node has no DOM: the raw layer comes back
      expect(Buffer.compare(b.threshold_layer.index, res.threshold_layer.index)).toBe(0)
      expect(eng.cancel()).toBe(false) // inline: nothing terminated
      expect(await eng.thresholdPreview({ image_id: up.image_id, threshold_percent: 60 })).toEqual({ stale: true })
      await eng.analyze({ image_id: up.image_id, ...REF }) // re-registers the photo transparently
      expect((await eng.thresholdPreview({ image_id: up.image_id, threshold_percent: 60 })).stale).toBeUndefined()
    } finally {
      eng.dispose()
      uninstall()
    }
  })
})

describe('worker mode cancel', () => {
  it('a preview after cancel() is stale without spawning a worker', async () => {
    const spawned = []
    globalThis.Worker = class {
      constructor() { spawned.push(this); this.terminated = false }
      postMessage({ id, op }) {
        // the fake worker only knows registerBlue
        queueMicrotask(() => this.onmessage?.({ data: { id, type: 'result', ok: true, result: { image_id: 'x', op } } }))
      }
      terminate() { this.terminated = true }
    }
    globalThis.OffscreenCanvas = class {}
    globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} })
    try {
      const eng = createLocalEngine()
      // upload goes to the worker ('upload' op); the fake replies with a canned result
      await eng.upload({ name: 'a.png' }, { expect: Promise.resolve({ width: 2, height: 2 }) })
      const imageId = (await eng.thresholdPreview({ image_id: 'nope', threshold_percent: 50 }))
      expect(imageId).toEqual({ stale: true })
      expect(eng.cancel()).toBe(true)
      expect(spawned[0].terminated).toBe(true)
      const n = spawned.length
      expect(await eng.thresholdPreview({ image_id: 'x', threshold_percent: 50 })).toEqual({ stale: true })
      expect(spawned.length).toBe(n)
      eng.dispose()
    } finally {
      delete globalThis.Worker
      delete globalThis.OffscreenCanvas
      delete globalThis.createImageBitmap
    }
  })
})

describe('cloud client', () => {
  it('answers { unsupported: true } and never sends the field to the server layer', async () => {
    const original = globalThis.window
    globalThis.window = { location: { search: '?engine=cloud' } }
    try {
      const client = createAnalyzerClient({})
      expect(client.mode).toBe('cloud')
      expect(await client.thresholdPreview({ image_id: 'x', threshold_percent: 50 })).toEqual({ unsupported: true })
    } finally {
      if (original === undefined) delete globalThis.window
      else globalThis.window = original
    }
  })
})
