// Module-level shots store (stale-while-revalidate). Import it only from lazy
// chunks, never from App.jsx, so Firestore stays out of the main bundle.
import { useSyncExternalStore } from 'react'
import { fetchShotsFromServer, loadShotsData, readCachedShots } from './dashboardData'

const listeners = new Set()
let started = false
let requestId = 0
let state = null
let snapshot = null

function emptyState() {
  const cached = readCachedShots()
  return {
    shots: cached ? cached.shots : null,
    source: cached ? 'cache' : null,
    syncState: 'syncing',
    lastSyncedAt: cached?.lastSyncedAt ?? null,
    loadError: '',
  }
}

function publish(patch) {
  state = { ...state, ...patch }
  snapshot = { ...state, revalidate, reload }
  listeners.forEach((listener) => listener())
}

function ensure() {
  if (!state) {
    state = emptyState()
    snapshot = { ...state, revalidate, reload }
  }
  return snapshot
}

/** Ask the Firestore server; keep showing whatever we have while it answers. */
export async function revalidate() {
  ensure()
  const mine = ++requestId
  publish({ syncState: 'syncing', loadError: '' })
  try {
    const next = await fetchShotsFromServer({ timeoutMs: 6000 })
    if (mine !== requestId) return
    publish({ shots: next.shots, source: 'firebase', syncState: 'live', lastSyncedAt: next.lastSyncedAt, loadError: '' })
  } catch (err) {
    if (mine !== requestId) return
    if (state.shots) publish({ syncState: 'offline', loadError: '' })
    else publish({ syncState: 'error', loadError: err?.message || 'Unable to reach Firestore.' })
  }
}

/** Server first, falling back to the cache. Used after writes; rejects when nothing is available. */
export async function reload() {
  ensure()
  const mine = ++requestId
  const next = await loadShotsData()
  if (mine === requestId) {
    publish({
      shots: next.shots,
      source: next.source,
      syncState: next.source === 'firebase' ? 'live' : 'offline',
      lastSyncedAt: next.lastSyncedAt ?? null,
      loadError: '',
    })
  }
  return next
}

function subscribe(listener) {
  ensure()
  listeners.add(listener)
  if (!started) {
    started = true
    // out of the subscribe call, so the store never updates during React's commit
    setTimeout(() => { revalidate() }, 0)
  }
  return () => { listeners.delete(listener) }
}

/** { shots, source, syncState, lastSyncedAt, loadError, revalidate(), reload() } */
export function useShots() {
  return useSyncExternalStore(subscribe, ensure, ensure)
}

/** Test helper. */
export function _resetShotsStoreForTests() {
  started = false
  requestId += 1
  state = null
  snapshot = null
  listeners.clear()
}
