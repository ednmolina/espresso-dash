// decode.js with a faked createImageBitmap / OffscreenCanvas (node has neither).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bitmapFromFile, decodeFile, MAX_PIXELS } from '../decode.js'

function installCanvas() {
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h }
    getContext() {
      return {
        clearRect() {},
        drawImage() {},
        getImageData: (sx, sy, sw, sh) => {
          const data = new Uint8ClampedArray(sw * sh * 4)
          for (let k = 2; k < data.length; k += 4) data[k] = 77
          return { data }
        },
      }
    }
  }
}

beforeEach(installCanvas)
afterEach(() => {
  delete globalThis.createImageBitmap
  delete globalThis.OffscreenCanvas
})

describe('bitmapFromFile', () => {
  it('retries a TypeError without imageOrientation only, keeping the colour options', async () => {
    const calls = []
    globalThis.createImageBitmap = vi.fn(async (file, opts) => {
      calls.push(opts)
      if ('imageOrientation' in opts) throw new TypeError('bad option')
      return { width: 2, height: 2, close() {} }
    })
    await bitmapFromFile({}, { resizeWidth: 10, resizeHeight: 5 })
    expect(calls).toHaveLength(2)
    expect(calls[0].imageOrientation).toBe('from-image')
    expect(calls[1]).toEqual({
      colorSpaceConversion: 'none', premultiplyAlpha: 'none', resizeWidth: 10, resizeHeight: 5,
    })
  })

  it('does not swallow other errors', async () => {
    globalThis.createImageBitmap = vi.fn(async () => { throw new Error('boom') })
    await expect(bitmapFromFile({})).rejects.toThrow('boom')
    expect(globalThis.createImageBitmap).toHaveBeenCalledTimes(1)
  })
})

describe('decodeFile', () => {
  it('reads the blue channel at the decoded size', async () => {
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 7, height: 3, close() {} }))
    const out = await decodeFile({})
    expect([out.width, out.height, out.blue.length, out.blue[20]]).toEqual([7, 3, 21, 77])
  })

  it('rejects a full-size decode above the pixel limit, reporting the size it saw', async () => {
    const big = { width: 8064, height: 6048, close: vi.fn() }
    expect(big.width * big.height).toBeGreaterThan(MAX_PIXELS)
    globalThis.createImageBitmap = vi.fn(async () => big)
    const err = await decodeFile({}).catch((e) => e)
    expect(err.status).toBe(413)
    expect(err.tooLarge).toEqual({ width: 8064, height: 6048 })
    expect(big.close).toHaveBeenCalled()
  })

  it('accepts any source size when asked to resize, and passes the target to the browser', async () => {
    globalThis.createImageBitmap = vi.fn(async (file, opts) => ({ width: opts.resizeWidth, height: opts.resizeHeight, close() {} }))
    const out = await decodeFile({}, { resize: { width: 40, height: 30 } })
    expect([out.width, out.height]).toEqual([40, 30])
    const opts = globalThis.createImageBitmap.mock.calls[0][1]
    expect(opts).toMatchObject({ resizeWidth: 40, resizeHeight: 30, colorSpaceConversion: 'none' })
  })

  it('fails (decodeFailed) when the browser does not honour the requested size', async () => {
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 30, height: 40, close() {} })) // rotated
    const err = await decodeFile({}, { resize: { width: 40, height: 30 } }).catch((e) => e)
    expect(err.decodeFailed).toBe(true)
  })
})
