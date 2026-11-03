// The latest analyzer result of this page session, kept in memory only, so the Diagnostics page
// can show "Photo analysis checks" without re-running anything.
//
// Nothing here is persisted: no localStorage, no Firestore. A reload empties it, by design.
// AnalyzerApp calls setLatestAnalysis() after each successful analyze (not after an erase, so the
// with/without-separation comparison stays what it was at detection).
import { useSyncExternalStore } from 'react'

let latest = null
const listeners = new Set()

function notify() {
  listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // a bad subscriber must not break the others
    }
  })
}

/**
 * Remember the newest analysis. Only the small, serialisable parts are kept (no particles,
 * no layers): `{ summary, shape_summary, split_info, at }`.
 */
export function setLatestAnalysis({ summary = null, shape_summary = null, split_info = null, at = Date.now() } = {}) {
  latest = { summary, shape_summary, split_info, at }
  notify()
}

export function getLatestAnalysis() {
  return latest
}

export function clearLatestAnalysis() {
  if (latest === null) return
  latest = null
  notify()
}

export function subscribeLatestAnalysis(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The latest analysis of this session, or null before any. Re-renders on change. */
export function useLatestAnalysis() {
  return useSyncExternalStore(subscribeLatestAnalysis, getLatestAnalysis, getLatestAnalysis)
}

export function _resetForTests() {
  latest = null
  listeners.clear()
}
