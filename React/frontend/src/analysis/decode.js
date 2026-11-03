// Image decoding for the on-device analyzer: file -> blue channel (Uint8Array, row-major).
//
// The server decodes with Pillow, applies EXIF rotation and takes channel 2 of the RGB
// image. Here the browser does the decoding. Pixels are read in strips so no canvas is
// ever larger than ~4 MP (iOS Safari limits a canvas to about 16.7 MP and will silently
// return blank pixels or throw above that).
//
// Parity with Pillow: the PIL path ignores ICC profiles, so bitmaps are created with
// colorSpaceConversion 'none'. JPEG decoders differ slightly between browsers (Safari
// uses ImageIO), so real photos are tolerance-only; lossless blue channels are exact.

// No heavy imports here: the main thread loads this file even when the engine lives in a worker.

export const MAX_PIXELS = 40e6

export function httpError(status, detail) {
  const err = new Error(detail)
  err.status = status
  return err
}

export const HEIC_MESSAGE =
  "This browser can't open HEIC photos. Use Safari, set iPhone Camera → Formats → Most Compatible, or export the photo as JPEG."

export const MAX_DECODE_PIXELS = 16e6
const STRIP_PIXELS = 4e6
const MAX_STRIP_WIDTH = 4096

export function looksLikeHeic(file) {
  const type = (file?.type || '').toLowerCase()
  const name = (file?.name || '').toLowerCase()
  return type.includes('heic') || type.includes('heif') || /\.(heic|heif)$/.test(name)
}

/** The error to report when `file` could not be decoded at all. */
export function decodeError(file) {
  return httpError(400, looksLikeHeic(file) ? HEIC_MESSAGE : 'Could not decode image.')
}

const BITMAP_OPTIONS = { imageOrientation: 'from-image', colorSpaceConversion: 'none', premultiplyAlpha: 'none' }

/**
 * createImageBitmap with the PIL-like options. Some Safari versions reject an unknown
 * `imageOrientation` value with a TypeError; the retry drops only that option, so the
 * colour handling (no conversion, no premultiply) is kept.
 */
export async function bitmapFromFile(file, extra = {}) {
  try {
    return await createImageBitmap(file, { ...BITMAP_OPTIONS, ...extra })
  } catch (err) {
    if (err instanceof TypeError) {
      const { imageOrientation: _dropped, ...kept } = BITMAP_OPTIONS
      return createImageBitmap(file, { ...kept, ...extra })
    }
    throw err
  }
}

function tooLargeError(width, height) {
  const err = httpError(413, `Image is too large (${width}x${height}); limit is ${(MAX_PIXELS / 1e6).toFixed(0)} megapixels.`)
  err.tooLarge = { width, height }
  return err
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * Copy the blue channel of a CanvasImageSource (ImageBitmap or loaded <img>) into a
 * Uint8Array, one <= ~4 MP strip at a time (columns are tiled when wider than 4096).
 */
export function readBlue(source, width, height, { onProgress } = {}) {
  const stripW = Math.min(width, MAX_STRIP_WIDTH)
  const stripH = Math.max(1, Math.floor(STRIP_PIXELS / stripW))
  const canvas = makeCanvas(stripW, Math.min(stripH, height))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw httpError(400, 'Could not decode image.')
  const blue = new Uint8Array(width * height)
  for (let sy = 0; sy < height; sy += stripH) {
    const sh = Math.min(stripH, height - sy)
    for (let sx = 0; sx < width; sx += stripW) {
      const sw = Math.min(stripW, width - sx)
      ctx.clearRect(0, 0, sw, sh)
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
      const data = ctx.getImageData(0, 0, sw, sh).data
      let k = 2
      for (let r = 0; r < sh; r++) {
        const base = (sy + r) * width + sx
        for (let c = 0; c < sw; c++, k += 4) blue[base + c] = data[k]
      }
    }
    onProgress?.('decode', Math.min(1, (sy + stripH) / height))
  }
  return blue
}

/**
 * Decode a File to its blue channel via createImageBitmap (honours EXIF orientation).
 * `resize` ({width, height}) asks the browser to shrink while decoding, the memory
 * fallback for photos too big to decode at full size (parity is tolerance-only there).
 */
export async function decodeFile(file, { resize = null, onProgress } = {}) {
  let bitmap
  try {
    bitmap = await bitmapFromFile(file, resize ? { resizeWidth: resize.width, resizeHeight: resize.height, resizeQuality: 'high' } : {})
  } catch (err) {
    const e = decodeError(file)
    e.cause = err
    e.decodeFailed = true
    throw e
  }
  try {
    const { width, height } = bitmap
    if (!resize && width * height > MAX_PIXELS) throw tooLargeError(width, height)
    if (resize && (Math.abs(width - resize.width) > 1 || Math.abs(height - resize.height) > 1)) {
      // The browser ignored the resize request or applied it before the EXIF rotation:
      // coordinates would no longer match what the UI shows.
      const e = decodeError(file)
      e.decodeFailed = true
      throw e
    }
    const blue = readBlue(bitmap, width, height, { onProgress })
    return { width, height, blue }
  } finally {
    bitmap.close?.()
  }
}

/**
 * Main-thread decode through an <img> element (honours EXIF in every browser that can
 * display the file), the fallback for browsers without a worker-side OffscreenCanvas
 * and for orientation mismatches.
 */
export async function decodeViaImg(file, { onProgress } = {}) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    try {
      if (typeof img.decode === 'function') await img.decode()
      else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject })
    } catch (err) {
      const e = decodeError(file)
      e.cause = err
      throw e
    }
    const width = img.naturalWidth
    const height = img.naturalHeight
    if (!(width > 0 && height > 0)) throw decodeError(file)
    if (width * height > MAX_PIXELS) throw tooLargeError(width, height)
    return { width, height, blue: readBlue(img, width, height, { onProgress }) }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Dimensions that bring a w x h image under `maxPixels`, preserving aspect. */
export function cappedDims(w, h, maxPixels = MAX_DECODE_PIXELS) {
  if (w * h <= maxPixels) return { width: w, height: h, scale: 1 }
  const s = Math.sqrt(maxPixels / (w * h))
  return { width: Math.max(1, Math.floor(w * s)), height: Math.max(1, Math.floor(h * s)), scale: s }
}

/**
 * RGBA bytes -> something the 2D canvas can draw. ImageBitmap where possible, otherwise
 * a <canvas>. Main thread (and worker, for the bitmap branch).
 */
export async function rgbaToImageSource(width, height, rgba) {
  const data = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  if (typeof ImageData !== 'undefined' && typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(new ImageData(data, width, height))
    } catch {
      // fall through to a canvas
    }
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0)
  return canvas
}

/** JPEG (quality 0.9) of a File as base64, for the rare /preview call. */
export async function previewJpegB64(file) {
  const bitmap = await bitmapFromFile(file)
  try {
    const canvas = makeCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    let blob
    if (typeof canvas.convertToBlob === 'function') blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    else blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    if (!blob) throw httpError(400, 'Could not decode image.')
    const buf = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk))
    return { image_b64: btoa(bin), image_mime: 'image/jpeg' }
  } finally {
    bitmap.close?.()
  }
}
