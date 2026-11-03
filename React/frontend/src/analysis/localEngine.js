// Main-thread front for the on-device engine.
//
//   createLocalEngine() -> { upload(file, {expect}), analyze, erase, histogram, compare, preview,
//                            cancel(), dispose(), onProgress(cb) -> unsubscribe }
//
// Where things run:
//   Worker + OffscreenCanvas : decoding and analysis both in the worker (the normal case)
//   Worker, no OffscreenCanvas (iOS < 16.4): decode here, post the blue channel (transferred)
//   No Worker (or forceInline) : the engine runs inline on this thread (and in node/vitest)
//
// Cancel terminates the worker. The File of the current photo is kept, so the next analyze
// re-registers it under the same image_id transparently. Stored analyses die with the
// worker, so erase/histogram then answer 404 and the UI asks the user to detect again.

import {
  decodeError, decodeFile, decodeViaImg, cappedDims, httpError,
  MAX_DECODE_PIXELS, previewJpegB64, rgbaToImageSource,
} from './decode.js'

const CANCELLED = 'Cancelled'

function cancelError() {
  const err = httpError(499, CANCELLED)
  err.cancelled = true
  return err
}

function newImageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))

export function createLocalEngine({ forceInline = false } = {}) {
  const listeners = new Set()
  const pending = new Map() // request id -> { resolve, reject }
  const files = new Map() // image_id -> File (latest photo only)
  const decodeInfo = new Map() // image_id -> how it was decoded, for transparent re-registration
  let worker = null
  let inline = null // { engine, layerToRgba }
  let epoch = 0 // bumped by cancel(); inline work checks it between its async steps
  let seq = 0
  let registeredId = null // the image currently held by the worker / inline engine

  let hasWorker = !forceInline && typeof Worker !== 'undefined'
  const workerDecodes = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function'

  const emit = (phase, fraction) => {
    for (const cb of listeners) {
      try { cb({ phase, fraction }) } catch { /* a listener must not break the engine */ }
    }
  }

  // ---- worker plumbing ---------------------------------------------------------------------

  function failAll(err) {
    const all = [...pending.values()]
    pending.clear()
    for (const p of all) p.reject(err)
  }

  function spawn() {
    if (worker) return worker
    // Static URL form: Vite bundles ./worker.js (with the whole engine) as its own chunk.
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    w.onmessage = (event) => {
      const msg = event.data
      if (msg.type === 'progress') {
        emit(msg.phase, msg.fraction)
        return
      }
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else {
        const err = new Error(msg.error.message)
        err.status = msg.error.status
        err.decodeFailed = msg.error.decodeFailed
        p.reject(err)
      }
    }
    w.onerror = (event) => {
      event.preventDefault?.()
      if (worker === w) { worker = null; registeredId = null }
      failAll(httpError(500, 'The analysis worker stopped unexpectedly. Try again.'))
    }
    w.onmessageerror = () => failAll(httpError(500, 'The analysis worker sent an unreadable message.'))
    worker = w
    return w
  }

  function call(op, payload, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      try {
        spawn().postMessage({ id, op, payload }, transfer)
      } catch (err) {
        pending.delete(id)
        reject(err)
      }
    })
  }

  async function inlineEngine() {
    if (!inline) {
      const mod = await import('./engine.js')
      inline = { engine: mod.createEngine(), layerToRgba: mod.layerToRgba }
    }
    return inline
  }

  /** Run `fn` on the inline engine after a macrotask, so the busy card can paint first. */
  async function runInline(fn) {
    const myEpoch = epoch
    const eng = await inlineEngine()
    await nextTick()
    if (epoch !== myEpoch) throw cancelError()
    return fn(eng)
  }

  async function layersToImages(result, layerToRgba) {
    for (const key of ['threshold_layer', 'cluster_layer']) {
      const layer = result?.[key]
      if (!layer) continue
      let source = null
      if (layer.index && layerToRgba) source = await rgbaToImageSource(layer.width, layer.height, layerToRgba(layer))
      else if (layer.rgba) source = await rgbaToImageSource(layer.width, layer.height, layer.rgba)
      if (source) result[key] = source // else keep the raw layer (node / no DOM)
    }
    return result
  }

  /** Start the worker if it is wanted; a browser that refuses (CSP, file://) falls back to inline. */
  function ensureWorkerMode() {
    if (hasWorker && !worker) {
      try { spawn() } catch { hasWorker = false }
    }
  }

  // ---- registering photos ------------------------------------------------------------------

  async function registerDecoded(decoded, imageId, extra = {}) {
    const payload = {
      image_id: imageId,
      width: decoded.width,
      height: decoded.height,
      blue: decoded.blue,
      fullWidth: extra.fullWidth,
      fullHeight: extra.fullHeight,
      decodeScale: extra.decodeScale ?? 1,
    }
    let res
    if (hasWorker) res = await call('registerBlue', payload, [decoded.blue.buffer])
    else res = await runInline(({ engine }) => engine.registerImage(payload))
    registeredId = imageId
    return res
  }

  /** Decode on this thread (bitmap, or <img> when `viaImg`) and hand the blue channel over. */
  async function decodeHere(file, imageId, { viaImg = false, resize = null, fullWidth, fullHeight } = {}) {
    const onProgress = (phase, fraction) => emit(phase, fraction)
    const decoded = viaImg ? await decodeViaImg(file, { onProgress }) : await decodeFile(file, { resize, onProgress })
    const extra = resize
      ? { fullWidth, fullHeight, decodeScale: decoded.width / fullWidth }
      : {}
    const res = await registerDecoded(decoded, imageId, extra)
    decodeInfo.set(imageId, { viaImg, resize, fullWidth, fullHeight })
    return res
  }

  async function decodeInWorker(file, imageId, { resize = null, fullWidth, fullHeight } = {}) {
    const res = await call('upload', { file, image_id: imageId, resize, fullWidth, fullHeight })
    registeredId = imageId
    decodeInfo.set(imageId, { viaImg: false, resize, fullWidth, fullHeight, inWorker: true })
    return res
  }

  /** One decode attempt with a given strategy. */
  function decodeWith(file, imageId, opts = {}) {
    if (hasWorker && workerDecodes && !opts.viaImg) return decodeInWorker(file, imageId, opts)
    return decodeHere(file, imageId, opts)
  }

  async function upload(file, { expect = null } = {}) {
    ensureWorkerMode()
    const myEpoch = epoch
    const imageId = newImageId()
    let res
    try {
      res = await decodeWith(file, imageId)
    } catch (err) {
      if (err?.cancelled || epoch !== myEpoch) throw err?.cancelled ? err : cancelError()
      if (!err?.decodeFailed && err?.status !== 500) throw err
      // Memory failure on a very large photo: let the browser shrink it while decoding.
      const dims = expect ? await expect : null
      if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
        const cap = cappedDims(dims.width, dims.height)
        try {
          res = await decodeWith(file, imageId, { resize: cap, fullWidth: dims.width, fullHeight: dims.height })
        } catch (err2) {
          if (err2?.cancelled) throw err2
          // fall through to the <img> path below
        }
      }
      if (!res && typeof document !== 'undefined') {
        try {
          res = await decodeHere(file, imageId, { viaImg: true })
        } catch (err3) {
          if (err3?.cancelled) throw err3
        }
      }
      if (!res) throw err.decodeFailed ? decodeError(file) : err
    }
    // Orientation check against what the browser displays (EXIF handling differs between
    // decoders). A mismatch is redone through <img>, which honours EXIF like the page does.
    const shown = expect ? await expect : null
    if (shown && (shown.width !== res.width || shown.height !== res.height) && typeof document !== 'undefined') {
      try {
        const again = await decodeHere(file, imageId, { viaImg: true })
        res = again
      } catch (err) {
        if (err?.cancelled) throw err
        // keep the first decode; the caller falls back to the preview image
      }
    }
    if (epoch !== myEpoch) throw cancelError()
    // Only the latest photo is kept (a failed upload leaves the previous one usable).
    for (const key of [...files.keys()]) if (key !== imageId) files.delete(key)
    for (const key of [...decodeInfo.keys()]) if (key !== imageId) decodeInfo.delete(key)
    files.set(imageId, file)
    return res
  }

  /** After a cancel the worker is gone: put the current photo back under its old id. */
  async function ensureRegistered(imageId) {
    if (registeredId === imageId) return
    const file = files.get(imageId)
    if (!file) return // the engine answers 404 "Image not found. Upload first."
    const info = decodeInfo.get(imageId) ?? {}
    if (info.viaImg) await decodeHere(file, imageId, info)
    else await decodeWith(file, imageId, info)
  }

  // ---- operations --------------------------------------------------------------------------

  async function analyze(body) {
    ensureWorkerMode()
    await ensureRegistered(body.image_id)
    if (hasWorker) {
      const result = await call('analyze', body)
      return layersToImages(result, null)
    }
    return runInline(async ({ engine, layerToRgba }) => {
      const result = engine.analyze(body, { onProgress: emit })
      return layersToImages(result, layerToRgba)
    })
  }

  async function erase(body) {
    ensureWorkerMode()
    if (hasWorker) return layersToImages(await call('erase', body), null)
    return runInline(async ({ engine, layerToRgba }) => layersToImages(engine.erase(body), layerToRgba))
  }

  async function histogram(body) {
    ensureWorkerMode()
    if (hasWorker) return call('histogram', body)
    return runInline(({ engine }) => engine.histogram(body))
  }

  async function compare(body) {
    ensureWorkerMode()
    if (hasWorker) return call('compare', body)
    return runInline(({ engine }) => engine.compare(body))
  }

  async function preview(imageId) {
    const file = files.get(imageId)
    if (!file) throw httpError(404, 'Image not found. Upload first.')
    if (hasWorker && workerDecodes) return call('preview', { file })
    try {
      return await previewJpegB64(file)
    } catch {
      throw decodeError(file)
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  function cancel() {
    epoch += 1
    if (worker) {
      worker.terminate()
      worker = null
    }
    registeredId = null
    failAll(cancelError())
  }

  function dispose() {
    cancel()
    files.clear()
    decodeInfo.clear()
    inline = null
  }

  function onProgress(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  return { upload, analyze, erase, histogram, compare, preview, cancel, dispose, onProgress }
}
