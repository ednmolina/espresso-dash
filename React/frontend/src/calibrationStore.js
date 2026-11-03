// Local-only store for grinder calibration runs (analyzer photos tagged with the
// grind setting used) and shots the user excluded from the curve. Plain JS +
// localStorage, no Firebase. Every storage access is wrapped in try/catch.
import { parseSetting } from './grindCalibration'

export const STORAGE_KEY = 'espressoLab.calibrationRuns.v1'
export const EXCLUDED_SHOTS_KEY = 'espressoLab.calibrationExcludedShots.v1'

const EXPORT_FORMAT = 'espressoLab.calibrationRuns'
const UM_MIN = 20
const UM_MAX = 5000

let runs = []
let excludedShotIds = []
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

/** Clean one stored/imported run into canonical shape, or null if unusable. */
function sanitizeRun(raw, { range = false } = {}) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  const setting = parseSetting(raw.grindSetting)
  if (!setting) return null
  let mean = finiteOrNull(raw.mean_um)
  let dv50 = finiteOrNull(raw.dv50_um)
  if (range) {
    if (mean !== null && (mean < UM_MIN || mean > UM_MAX)) mean = null
    if (dv50 !== null && (dv50 < UM_MIN || dv50 > UM_MAX)) dv50 = null
  }
  if (mean === null && dv50 === null) return null
  const created = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
    ? raw.createdAt
    : new Date().toISOString()
  return {
    id: raw.id,
    grindSetting: setting.label,
    score: setting.score,
    index: setting.index,
    dv10_um: finiteOrNull(raw.dv10_um),
    dv50_um: dv50,
    dv90_um: finiteOrNull(raw.dv90_um),
    mean_um: mean,
    n_particles: finiteOrNull(raw.n_particles),
    coffee: typeof raw.coffee === 'string' && raw.coffee ? raw.coffee : null,
    createdAt: created,
    excluded: Boolean(raw.excluded),
    apiShape: raw.apiShape === 'legacy' || raw.apiShape === 'new'
      ? raw.apiShape
      : (dv50 !== null ? 'new' : 'legacy'),
  }
}

function load() {
  runs = readJsonArray(STORAGE_KEY).map((r) => sanitizeRun(r)).filter(Boolean)
  excludedShotIds = readJsonArray(EXCLUDED_SHOTS_KEY).filter((id) => typeof id === 'string' && id)
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
  if (event && event.key && event.key !== STORAGE_KEY && event.key !== EXCLUDED_SHOTS_KEY) return
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

export function getRuns() {
  ensureLoaded()
  return runs
}

export function getExcludedShotIds() {
  ensureLoaded()
  return excludedShotIds
}

export function subscribe(listener) {
  listeners.add(listener)
  attachStorageListener()
  return () => {
    listeners.delete(listener)
    if (!listeners.size) detachStorageListener()
  }
}

/** Analyzer summary (mm) -> partial run (um), or null when unusable. */
export function runFromSummary(summary, { grindSetting, coffee = null, nclusters = null } = {}) {
  const setting = parseSetting(grindSetting)
  if (!setting || !summary || typeof summary !== 'object') return null
  const um = (mm) => {
    const v = finiteOrNull(mm)
    return v === null ? null : v * 1000
  }
  const dv50 = um(summary.dv50_mm)
  const mean = um(summary.diameter_mean_mm)
  if (dv50 === null && mean === null) return null
  const count = finiteOrNull(summary.cluster_count) ?? finiteOrNull(nclusters)
  return {
    grindSetting: setting.label,
    score: setting.score,
    index: setting.index,
    dv10_um: um(summary.dv10_mm),
    dv50_um: dv50,
    dv90_um: um(summary.dv90_mm),
    mean_um: mean,
    n_particles: count,
    coffee: coffee || null,
    apiShape: dv50 !== null ? 'new' : 'legacy',
  }
}

function newId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return uuid
  } catch {
    // fall through
  }
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function addRun(partial) {
  ensureLoaded()
  const candidate = {
    ...(partial || {}),
    id: typeof partial?.id === 'string' && partial.id ? partial.id : newId(),
    createdAt: partial?.createdAt || new Date().toISOString(),
    excluded: false,
  }
  const run = sanitizeRun(candidate)
  if (!run) {
    return { ok: false, run: null, persisted: false, error: 'Run needs a valid grind setting and a particle size.' }
  }
  runs = [...runs, run]
  const persisted = writeJson(STORAGE_KEY, runs)
  notify()
  return { ok: true, run, persisted }
}

export function setRunExcluded(id, excluded) {
  ensureLoaded()
  const index = runs.findIndex((r) => r.id === id)
  if (index < 0) return false
  const flag = Boolean(excluded)
  if (runs[index].excluded !== flag) {
    runs = runs.map((r, i) => (i === index ? { ...r, excluded: flag } : r))
    writeJson(STORAGE_KEY, runs)
    notify()
  }
  return true
}

export function setShotExcluded(shotId, excluded) {
  ensureLoaded()
  if (typeof shotId !== 'string' || !shotId) return false
  const has = excludedShotIds.includes(shotId)
  const flag = Boolean(excluded)
  if (flag && !has) {
    excludedShotIds = [...excludedShotIds, shotId]
  } else if (!flag && has) {
    excludedShotIds = excludedShotIds.filter((id) => id !== shotId)
  } else {
    return true
  }
  writeJson(EXCLUDED_SHOTS_KEY, excludedShotIds)
  notify()
  return true
}

export function exportJson() {
  ensureLoaded()
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    runs,
    excludedShotIds,
  })
}

export function importJson(text) {
  ensureLoaded()
  const result = { added: 0, duplicates: 0, invalid: 0 }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ...result, error: 'That file is not valid JSON.' }
  }
  const incoming = Array.isArray(data) ? data : (Array.isArray(data?.runs) ? data.runs : null)
  if (!incoming) return { ...result, error: 'No calibration runs found in that file.' }

  const seen = new Set(runs.map((r) => r.id))
  const additions = []
  incoming.forEach((raw) => {
    const run = sanitizeRun(raw, { range: true })
    if (!run) {
      result.invalid += 1
    } else if (seen.has(run.id)) {
      result.duplicates += 1
    } else {
      seen.add(run.id)
      additions.push(run)
    }
  })

  let changed = false
  if (additions.length) {
    runs = [...runs, ...additions]
    writeJson(STORAGE_KEY, runs)
    result.added = additions.length
    changed = true
  }
  if (!Array.isArray(data) && Array.isArray(data?.excludedShotIds)) {
    const extra = data.excludedShotIds.filter((id) => typeof id === 'string' && id && !excludedShotIds.includes(id))
    if (extra.length) {
      excludedShotIds = [...excludedShotIds, ...new Set(extra)]
      writeJson(EXCLUDED_SHOTS_KEY, excludedShotIds)
      changed = true
    }
  }
  if (changed) notify()
  return result
}

export function _resetForTests() {
  runs = []
  excludedShotIds = []
  loaded = false
  listeners.clear()
  detachStorageListener()
}
