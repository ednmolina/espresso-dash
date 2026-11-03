// Local-only store for repeat checks: 2+ photos of the same sample, kept as numbers only (Dv10/50/90
// in um and the particle count per photo). Plain JS + localStorage, no Firebase, no network. Every storage
// access is wrapped in try/catch, and the store keeps working in memory when storage is missing,
// full or corrupt. Same pattern as calibrationStore.js.
import { parseSetting } from './grindCalibration'

export const STORAGE_KEY = 'espressoLab.repeatChecks.v1'
const EXPORT_FORMAT = 'espressoLab.repeatChecks'
const MIN_RUNS = 2

let checks = []
let loaded = false
const listeners = new Set()
let storageListenerAttached = false

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)

function getStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readJsonArray(key) {
  try {
    const storage = getStorage()
    if (!storage) return []
    const raw = storage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeJson(key, value) {
  try {
    const storage = getStorage()
    if (!storage) return false
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function finiteOrNull(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return isFiniteNum(n) ? n : null
}

function sanitizeRunEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const dv10 = finiteOrNull(raw.dv10_um)
  const dv50 = finiteOrNull(raw.dv50_um)
  const dv90 = finiteOrNull(raw.dv90_um)
  if (dv10 === null && dv50 === null && dv90 === null) return null
  return { dv10_um: dv10, dv50_um: dv50, dv90_um: dv90, n_particles: finiteOrNull(raw.n_particles) }
}

/** Clean one stored/imported check into canonical shape, or null if unusable (needs 2+ photos with sizes). */
function sanitizeCheck(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (!Array.isArray(raw.runs)) return null
  const runs = raw.runs.map(sanitizeRunEntry).filter(Boolean)
  if (runs.length < MIN_RUNS) return null
  const created = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
    ? raw.createdAt
    : new Date().toISOString()
  const setting = parseSetting(raw.grindSetting)
  return {
    id: raw.id,
    createdAt: created,
    grindSetting: setting ? setting.label : null,
    runs,
    excluded: Boolean(raw.excluded),
  }
}

function load() {
  checks = readJsonArray(STORAGE_KEY).map(sanitizeCheck).filter(Boolean)
  loaded = true
}

function ensureLoaded() {
  if (!loaded) load()
}

function notify() {
  listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // a bad subscriber must not break the others
    }
  })
}

function onStorageEvent(event) {
  if (event && event.key && event.key !== STORAGE_KEY) return
  load()
  notify()
}

function attachStorageListener() {
  if (storageListenerAttached || typeof window === 'undefined' || !window.addEventListener) return
  window.addEventListener('storage', onStorageEvent)
  storageListenerAttached = true
}

function detachStorageListener() {
  if (!storageListenerAttached || typeof window === 'undefined') return
  window.removeEventListener('storage', onStorageEvent)
  storageListenerAttached = false
}

function newId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return uuid
  } catch {
    // fall through
  }
  return `rep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** All saved checks, oldest first. The same array instance until something changes (safe for useSyncExternalStore). */
export function listChecks() {
  ensureLoaded()
  return checks
}

export function subscribe(listener) {
  listeners.add(listener)
  attachStorageListener()
  return () => {
    listeners.delete(listener)
    if (!listeners.size) detachStorageListener()
  }
}

/** Save a check: partial = { grindSetting?, runs: [{dv10_um, dv50_um, dv90_um, n_particles}], id?, createdAt? }. */
export function addCheck(partial) {
  ensureLoaded()
  const candidate = {
    ...(partial || {}),
    id: typeof partial?.id === 'string' && partial.id ? partial.id : newId(),
    createdAt: partial?.createdAt || new Date().toISOString(),
    excluded: false,
  }
  const check = sanitizeCheck(candidate)
  if (!check) {
    return { ok: false, check: null, persisted: false, error: 'A repeat check needs 2 or more photos with a particle size.' }
  }
  checks = [...checks, check]
  const persisted = writeJson(STORAGE_KEY, checks)
  notify()
  return { ok: true, check, persisted }
}

/**
 * Replace the photos (and setting) of an existing check, keeping its id, date and excluded flag. Used when
 * more photos of the same sample are added after a check was already saved. Unknown id: { ok: false, notFound: true }.
 */
export function updateCheck(id, partial) {
  ensureLoaded()
  const index = checks.findIndex((c) => c.id === id)
  if (index < 0) return { ok: false, notFound: true, check: null, persisted: false, error: 'That repeat check is no longer saved.' }
  const prev = checks[index]
  const check = sanitizeCheck({
    ...prev,
    ...(partial && 'grindSetting' in partial ? { grindSetting: partial.grindSetting } : {}),
    runs: partial?.runs,
    id: prev.id,
    createdAt: prev.createdAt,
    excluded: prev.excluded,
  })
  if (!check) {
    return { ok: false, check: null, persisted: false, error: 'A repeat check needs 2 or more photos with a particle size.' }
  }
  checks = checks.map((c, i) => (i === index ? check : c))
  const persisted = writeJson(STORAGE_KEY, checks)
  notify()
  return { ok: true, check, persisted }
}

/**
 * Save the photos of one sample: updates check `existingId` in place when it is still stored (more
 * photos were added since it was saved), otherwise adds a new check. `updated` says which happened.
 */
export function saveCheck(existingId, partial) {
  if (existingId) {
    const res = updateCheck(existingId, partial)
    if (res.ok || !res.notFound) return { ...res, updated: res.ok }
  }
  return { ...addCheck(partial), updated: false }
}

export function setExcluded(id, excluded) {
  ensureLoaded()
  const index = checks.findIndex((c) => c.id === id)
  if (index < 0) return false
  const flag = Boolean(excluded)
  if (checks[index].excluded !== flag) {
    checks = checks.map((c, i) => (i === index ? { ...c, excluded: flag } : c))
    writeJson(STORAGE_KEY, checks)
    notify()
  }
  return true
}

export function exportJson() {
  ensureLoaded()
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    checks,
  })
}

/** Merge checks from an export (or a bare array); invalid entries are counted, known ids skipped. */
export function importJson(text) {
  ensureLoaded()
  const result = { added: 0, duplicates: 0, invalid: 0 }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ...result, error: 'That file is not valid JSON.' }
  }
  const incoming = Array.isArray(data) ? data : (Array.isArray(data?.checks) ? data.checks : null)
  if (!incoming) return { ...result, error: 'No repeat checks found in that file.' }

  const seen = new Set(checks.map((c) => c.id))
  const additions = []
  incoming.forEach((raw) => {
    const check = sanitizeCheck(raw)
    if (!check) {
      result.invalid += 1
    } else if (seen.has(check.id)) {
      result.duplicates += 1
    } else {
      seen.add(check.id)
      additions.push(check)
    }
  })
  if (additions.length) {
    checks = [...checks, ...additions]
    writeJson(STORAGE_KEY, checks)
    result.added = additions.length
    notify()
  }
  return result
}

export function _resetForTests() {
  checks = []
  loaded = false
  listeners.clear()
  detachStorageListener()
}
