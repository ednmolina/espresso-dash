// Web Worker host for the on-device analysis engine.
//
// Protocol (structured clone):
//   in : { id, op: 'upload' | 'registerBlue' | 'analyze' | 'thresholdPreview' | 'erase' | 'histogram' | 'compare' | 'preview', payload }
//   out: { id, type: 'progress', phase, fraction }
//        { id, type: 'result', ok: true, result }  |  { id, type: 'result', ok: false, error: { message, status } }
//
// Static imports only: Vite bundles workers as a single script.

import { createEngine, layerToRgba } from './engine.js'
import { decodeFile, previewJpegB64, decodeError } from './decode.js'

const engine = createEngine()

const PROGRESS_INTERVAL_MS = 100

function makeProgress(id) {
  let last = 0
  let lastPhase = ''
  return (phase, fraction) => {
    const t = performance.now()
    if (phase === lastPhase && fraction < 1 && t - last < PROGRESS_INTERVAL_MS) return
    last = t
    lastPhase = phase
    self.postMessage({ id, type: 'progress', phase, fraction })
  }
}

/**
 * Replace each IndexLayer by something drawable: an ImageBitmap (transferred), or, when the
 * worker cannot create one, raw RGBA that the main thread turns into a bitmap/canvas.
 * One layer at a time keeps the transient RGBA (64 MB at 16 MP) to a single copy.
 */
async function materializeLayers(result, transfer) {
  for (const key of ['threshold_layer', 'cluster_layer']) {
    const layer = result[key]
    if (!layer || !layer.index) continue
    const rgba = layerToRgba(layer)
    result[key] = null
    let bitmap = null
    if (typeof createImageBitmap === 'function' && typeof ImageData !== 'undefined') {
      try {
        bitmap = await createImageBitmap(new ImageData(rgba, layer.width, layer.height))
      } catch {
        bitmap = null
      }
    }
    if (bitmap) {
      result[key] = bitmap
      transfer.push(bitmap)
    } else {
      result[key] = { width: layer.width, height: layer.height, rgba }
      transfer.push(rgba.buffer)
    }
  }
  return result
}

async function handle(op, payload, id) {
  const transfer = []
  let result
  switch (op) {
    case 'upload': {
      const { file, image_id: imageId, resize = null, fullWidth, fullHeight } = payload
      const report = makeProgress(id)
      const decoded = await decodeFile(file, { resize, onProgress: report })
      result = engine.registerImage({
        image_id: imageId,
        width: decoded.width,
        height: decoded.height,
        blue: decoded.blue,
        fullWidth: resize ? fullWidth : undefined,
        fullHeight: resize ? fullHeight : undefined,
        decodeScale: resize ? decoded.width / fullWidth : 1,
      })
      break
    }
    case 'registerBlue':
      result = engine.registerImage(payload)
      break
    case 'analyze': {
      result = engine.analyze(payload, { onProgress: makeProgress(id) })
      await materializeLayers(result, transfer)
      break
    }
    case 'thresholdPreview':
      result = engine.thresholdPreview(payload)
      if (!result.stale) await materializeLayers(result, transfer)
      break
    case 'erase':
      result = engine.erase(payload)
      await materializeLayers(result, transfer)
      break
    case 'histogram':
      result = engine.histogram(payload)
      break
    case 'compare':
      result = engine.compare(payload)
      break
    case 'preview':
      try {
        result = await previewJpegB64(payload.file)
      } catch (err) {
        throw err.status ? err : decodeError(payload.file)
      }
      break
    default: {
      const err = new Error(`Unknown operation: ${op}`)
      err.status = 400
      throw err
    }
  }
  return { result, transfer }
}

self.onmessage = async (event) => {
  const { id, op, payload } = event.data
  try {
    const { result, transfer } = await handle(op, payload, id)
    self.postMessage({ id, type: 'result', ok: true, result }, transfer)
  } catch (err) {
    self.postMessage({
      id,
      type: 'result',
      ok: false,
      error: { message: err?.message || String(err), status: err?.status ?? 500, decodeFailed: Boolean(err?.decodeFailed), tooLarge: err?.tooLarge ?? null },
    })
  }
}
