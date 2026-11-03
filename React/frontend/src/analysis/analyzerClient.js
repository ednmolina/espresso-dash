// The single swap point between the analyzer UI and its engine.
//
//   'local' (default): everything runs on this device, no network
//   'cloud' (?engine=cloud): the original Cloud Run API, unchanged
//
//   const client = createAnalyzerClient({ getUser })
//   client.request('/analyze', { json })   // same call shape as the old apiRequest
//   client.cancel()  client.onProgress(cb)  client.dispose()
//
// Nothing here talks to Cloud Run (or /health) unless ?engine=cloud is in the URL.

import { API } from '../constants'
import { errorMessage } from '../analyzerUtils'
import { createLocalEngine } from './localEngine.js'

export function engineMode() {
  try {
    return new URLSearchParams(window.location.search).get('engine') === 'cloud' ? 'cloud' : 'local'
  } catch {
    return 'local'
  }
}

// ---- cloud (the previous apiRequest, moved here unchanged) ---------------------------------

async function authHeaders(user) {
  if (!user) return {}
  try {
    const token = await user.getIdToken()
    return { Authorization: `Bearer ${token}` }
  } catch {
    return {}
  }
}

/** fetch + JSON with the server's error detail surfaced as the thrown message. */
async function apiRequest(user, path, { json, form, method = 'POST' } = {}) {
  const headers = { ...await authHeaders(user) }
  if (json) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : form,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    throw new Error(errorMessage(data, res.status))
  }
  return data
}

// ---- local ---------------------------------------------------------------------------------

// One engine per page, shared by every client instance: AnalyzerApp re-creates its client
// when the signed-in user changes, which must not lose the loaded photo or the results.
let sharedEngine = null
const getEngine = () => (sharedEngine ??= createLocalEngine())

/** Free the worker and the stored photo/results (the analyzer page was left). */
export function disposeLocalEngine() {
  // The engine object stays (clients hold it); dispose() only drops the worker and the
  // photo, and the next call starts a fresh worker.
  sharedEngine?.dispose()
}

const DEV = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)

function devLog(entry) {
  if (!DEV || typeof window === 'undefined') return
  ;(window.__grindEngineLog ??= []).push(entry)
}

function devDelayMs() {
  if (!DEV) return 0
  try {
    const v = Number(new URLSearchParams(window.location.search).get('engineDelay'))
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch {
    return 0
  }
}

function notFound(message) {
  const err = new Error(message)
  err.status = 404
  return err
}

async function renderPng(data) {
  const { renderChartPng } = await import('./chartPng.js')
  return renderChartPng(data)
}

export function createAnalyzerClient({ getUser } = {}) {
  const mode = engineMode()
  const delays = new Set() // cancellable ?engineDelay waits

  if (mode === 'cloud') {
    return {
      mode,
      request: (path, opts) => apiRequest(getUser?.() ?? null, path, opts),
      cancel() {},
      onProgress: () => () => {},
      dispose() {},
    }
  }

  const engine = getEngine()

  const wait = (ms) => new Promise((resolve, reject) => {
    const entry = { reject: null, timer: null }
    entry.timer = setTimeout(() => { delays.delete(entry); resolve() }, ms)
    entry.reject = reject
    delays.add(entry)
  })

  async function route(path, { json, form, method = 'POST', expect } = {}) {
    if (path === '/upload') {
      const file = form?.get?.('file')
      if (!file) throw new Error('No file selected.')
      return engine.upload(file, { expect })
    }
    if (method === 'GET' && path.startsWith('/preview/')) {
      return engine.preview(decodeURIComponent(path.slice('/preview/'.length)))
    }
    if (path === '/analyze') {
      const ms = devDelayMs()
      if (ms) await wait(ms)
      return engine.analyze(json)
    }
    if (path === '/erase') {
      const ms = devDelayMs()
      if (ms) await wait(ms)
      return engine.erase(json)
    }
    if (path === '/histogram') {
      const data = await engine.histogram(json)
      if (json?.include_png) data.histogram_b64 = await renderPng(data)
      return data
    }
    if (path === '/histogram/compare') {
      const data = await engine.compare(json)
      if (json?.include_png) data.histogram_b64 = await renderPng(data)
      return data
    }
    throw notFound(`Not found: ${path}`)
  }

  return {
    mode,
    async request(path, opts = {}) {
      const t0 = performance.now()
      const op = path.replace(/^\//, '')
      try {
        const data = await route(path, opts)
        devLog({ op, ok: true, ms: Math.round(performance.now() - t0), nclusters: data?.nclusters, summary: data?.summary ?? null })
        return data
      } catch (err) {
        devLog({ op, ok: false, ms: Math.round(performance.now() - t0), error: err?.message })
        throw err
      }
    },
    cancel() {
      const pending = [...delays]
      delays.clear()
      for (const d of pending) {
        clearTimeout(d.timer)
        const err = new Error('Cancelled')
        err.status = 499
        err.cancelled = true
        d.reject(err)
      }
      engine.cancel()
    },
    onProgress: (cb) => engine.onProgress(cb),
    dispose: disposeLocalEngine,
  }
}
