// The main-thread engine front, inline mode (no Worker in node), with a faked decoder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalEngine } from '../localEngine.js'
import { cappedDims, MAX_DECODE_PIXELS } from '../decode.js'

let bitmapCalls

/** A fake browser: `natural` is the (post-EXIF) size of the photo; resize options shrink it. */
function installBrowser(natural, { rejectFull = false } = {}) {
  bitmapCalls = []
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        clearRect() {},
        drawImage() {},
        getImageData: (sx, sy, sw, sh) => ({ data: new Uint8ClampedArray(sw * sh * 4) }),
      }
    }
  }
  globalThis.createImageBitmap = vi.fn(async (file, opts) => {
    bitmapCalls.push(opts)
    if (opts.resizeWidth) return { width: opts.resizeWidth, height: opts.resizeHeight, close() {} }
    if (rejectFull) throw new Error('out of memory')
    return { width: natural.width, height: natural.height, close() {} }
  })
}

beforeEach(() => { bitmapCalls = [] })
afterEach(() => {
  delete globalThis.createImageBitmap
  delete globalThis.OffscreenCanvas
})

const FILE = { name: 'p.jpg', type: 'image/jpeg' }

describe('upload of large photos', () => {
  it('decodes a 48 MP photo straight to the capped size, never at full size', async () => {
    const natural = { width: 8064, height: 6048 }
    installBrowser(natural)
    const engine = createLocalEngine({ forceInline: true })
    const res = await engine.upload(FILE, { expect: Promise.resolve(natural) })
    const cap = cappedDims(natural.width, natural.height)
    expect(cap.width * cap.height).toBeLessThanOrEqual(MAX_DECODE_PIXELS)
    expect(bitmapCalls).toHaveLength(1)
    expect(bitmapCalls[0]).toMatchObject({ resizeWidth: cap.width, resizeHeight: cap.height })
    // the UI keeps working in full-resolution coordinates
    expect([res.width, res.height]).toEqual([8064, 6048])
    engine.dispose()
  }, 60000)

  it('uses the capped decode for a 16-40 MP photo too', async () => {
    const natural = { width: 6000, height: 4000 } // 24 MP
    installBrowser(natural)
    const engine = createLocalEngine({ forceInline: true })
    const res = await engine.upload(FILE, { expect: Promise.resolve(natural) })
    expect(bitmapCalls).toHaveLength(1)
    expect(bitmapCalls[0].resizeWidth).toBeLessThan(natural.width)
    expect([res.width, res.height]).toEqual([6000, 4000])
    engine.dispose()
  }, 60000)

  it('decodes a photo at or under the cap at full size', async () => {
    const natural = { width: 400, height: 300 }
    installBrowser(natural)
    const engine = createLocalEngine({ forceInline: true })
    const res = await engine.upload(FILE, { expect: Promise.resolve(natural) })
    expect(bitmapCalls).toHaveLength(1)
    expect(bitmapCalls[0].resizeWidth).toBeUndefined()
    expect([res.width, res.height]).toEqual([400, 300])
    engine.dispose()
  })

  it('falls back to the decoder-reported size when the probe failed (over 40 MP still loads, downscaled)', async () => {
    const natural = { width: 8064, height: 6048 }
    installBrowser(natural)
    const engine = createLocalEngine({ forceInline: true })
    const res = await engine.upload(FILE, { expect: Promise.resolve(null) })
    expect(bitmapCalls).toHaveLength(2) // full decode saw the size, then the capped decode
    expect(bitmapCalls[0].resizeWidth).toBeUndefined()
    expect(bitmapCalls[1].resizeWidth).toBeGreaterThan(0)
    expect([res.width, res.height]).toEqual([8064, 6048])
    engine.dispose()
  }, 60000)

  it('still reports 413 when even the capped decode fails', async () => {
    const natural = { width: 8064, height: 6048 }
    installBrowser(natural)
    globalThis.createImageBitmap = vi.fn(async (file, opts) => {
      if (opts.resizeWidth) throw new Error('nope')
      return { width: natural.width, height: natural.height, close() {} }
    })
    const engine = createLocalEngine({ forceInline: true })
    const err = await engine.upload(FILE, { expect: Promise.resolve(natural) }).catch((e) => e)
    expect(err.status).toBe(413)
    engine.dispose()
  }, 60000)
})

describe('cancel', () => {
  it('rejects an in-flight inline upload and reports no lost results without a worker', async () => {
    const natural = { width: 400, height: 300 }
    installBrowser(natural)
    const engine = createLocalEngine({ forceInline: true })
    const p = engine.upload(FILE, { expect: Promise.resolve(natural) })
    const lost = engine.cancel()
    const err = await p.catch((e) => e)
    expect(lost).toBe(false)
    expect(err.cancelled).toBe(true)
    engine.dispose()
  })
})

describe('worker crash fallback', () => {
  let workers
  beforeEach(() => {
    workers = []
    globalThis.Worker = class {
      constructor() {
        this.terminated = false
        workers.push(this)
        // module scripts that fail to load fire `error` before any reply
        setTimeout(() => this.onerror?.({ preventDefault() {} }), 0)
      }
      postMessage() {}
      terminate() { this.terminated = true }
    }
  })
  afterEach(() => { delete globalThis.Worker })

  it('terminates a worker that dies before replying and retries the upload inline', async () => {
    const natural = { width: 400, height: 300 }
    installBrowser(natural)
    const engine = createLocalEngine()
    const res = await engine.upload(FILE, { expect: Promise.resolve(natural) })
    expect(workers.length).toBeGreaterThanOrEqual(1)
    expect(workers.every((w) => w.terminated)).toBe(true)
    expect([res.width, res.height]).toEqual([400, 300])
    // worker mode stays off: no further workers are created
    const before = workers.length
    await engine.upload(FILE, { expect: Promise.resolve(natural) })
    expect(workers).toHaveLength(before)
    engine.dispose()
  })
})
