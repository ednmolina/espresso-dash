import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXCLUDED_SHOTS_KEY,
  STORAGE_KEY,
  _resetForTests,
  addRun,
  exportJson,
  getExcludedShotIds,
  getRuns,
  importJson,
  runFromSummary,
  setRunExcluded,
  setShotExcluded,
  subscribe,
} from '../calibrationStore'

function memoryStorage({ throwOnSet = false } = {}) {
  const data = new Map()
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (throwOnSet) throw new Error('quota')
      data.set(k, String(v))
    },
    removeItem: (k) => data.delete(k),
  }
}
const partial = (over = {}) => ({ grindSetting: '10E', mean_um: 480, dv50_um: 500, ...over })

let storage
beforeEach(() => {
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  _resetForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
  _resetForTests()
})

describe('calibrationStore', () => {
  it('starts empty', () => {
    expect(getRuns()).toEqual([])
    expect(getExcludedShotIds()).toEqual([])
    expect(getRuns()).toBe(getRuns())
  })

  it('adds, persists, excludes and includes runs without deleting', () => {
    const res = addRun(partial())
    expect(res.ok).toBe(true)
    expect(res.persisted).toBe(true)
    expect(res.run.id).toBeTruthy()
    expect(res.run.excluded).toBe(false)
    expect(res.run.grindSetting).toBe('10E')
    expect(getRuns()).toHaveLength(1)
    expect(JSON.parse(storage.data.get(STORAGE_KEY))).toHaveLength(1)

    expect(setRunExcluded(res.run.id, true)).toBe(true)
    expect(getRuns()[0].excluded).toBe(true)
    expect(setRunExcluded(res.run.id, false)).toBe(true)
    expect(getRuns()[0].excluded).toBe(false)
    expect(setRunExcluded('missing', true)).toBe(false)
    expect(getRuns()).toHaveLength(1)

    expect(setShotExcluded('shotA', true)).toBe(true)
    expect(getExcludedShotIds()).toEqual(['shotA'])
    expect(JSON.parse(storage.data.get(EXCLUDED_SHOTS_KEY))).toEqual(['shotA'])
    expect(setShotExcluded('shotA', false)).toBe(true)
    expect(getExcludedShotIds()).toEqual([])
  })

  it('rejects runs without a valid setting or size', () => {
    expect(addRun(partial({ grindSetting: 'zz' })).ok).toBe(false)
    expect(addRun({ grindSetting: '10E' }).ok).toBe(false)
    expect(getRuns()).toEqual([])
  })

  it('reloads previously saved runs and survives corrupt JSON', () => {
    addRun(partial({ id: 'keep' }))
    _resetForTests()
    expect(getRuns().map((r) => r.id)).toEqual(['keep'])
    _resetForTests()
    storage.data.set(STORAGE_KEY, '{not json')
    storage.data.set(EXCLUDED_SHOTS_KEY, '42')
    expect(getRuns()).toEqual([])
    expect(getExcludedShotIds()).toEqual([])
  })

  it('exports and imports round trip with dedupe and invalid counts', () => {
    addRun(partial({ id: 'a' }))
    addRun(partial({ id: 'b', grindSetting: '12C', mean_um: 700 }))
    setShotExcluded('s1', true)
    const text = exportJson()
    const parsed = JSON.parse(text)
    expect(parsed).toMatchObject({ format: 'espressoLab.calibrationRuns', version: 1 })
    expect(parsed.runs).toHaveLength(2)
    expect(parsed.excludedShotIds).toEqual(['s1'])

    _resetForTests()
    storage.data.clear()
    expect(importJson(text)).toEqual({ added: 2, duplicates: 0, invalid: 0 })
    expect(getRuns().map((r) => r.id)).toEqual(['a', 'b'])
    expect(getExcludedShotIds()).toEqual(['s1'])
    expect(importJson(text)).toEqual({ added: 0, duplicates: 2, invalid: 0 })

    const mixed = JSON.stringify([
      { id: 'c', grindSetting: '5B', mean_um: 300 },
      { id: 'c', grindSetting: '5B', mean_um: 300 },
      { id: 'd', grindSetting: 'bad', mean_um: 300 },
      { id: 'e', grindSetting: '5B', mean_um: 10 },
      { grindSetting: '5B', mean_um: 300 },
      'junk',
    ])
    expect(importJson(mixed)).toEqual({ added: 1, duplicates: 1, invalid: 4 })
    expect(getRuns().find((r) => r.id === 'c').createdAt).toBeTruthy()
  })

  it('keeps the existing copy when importing a duplicate id', () => {
    addRun(partial({ id: 'x', mean_um: 480 }))
    importJson(JSON.stringify([{ id: 'x', grindSetting: '10E', mean_um: 999 }]))
    expect(getRuns()[0].mean_um).toBe(480)
  })

  it('reports errors for bad import files', () => {
    expect(importJson('nope').error).toBeTruthy()
    expect(importJson('{"foo":1}').error).toBeTruthy()
  })

  it('updates memory and reports persisted:false when storage throws', () => {
    vi.stubGlobal('localStorage', memoryStorage({ throwOnSet: true }))
    _resetForTests()
    const res = addRun(partial())
    expect(res.ok).toBe(true)
    expect(res.persisted).toBe(false)
    expect(getRuns()).toHaveLength(1)
  })

  it('works with no localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    _resetForTests()
    expect(getRuns()).toEqual([])
    expect(addRun(partial()).persisted).toBe(false)
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn()
    const off = subscribe(listener)
    const { run } = addRun(partial())
    setRunExcluded(run.id, true)
    setShotExcluded('s', true)
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    addRun(partial())
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('maps new and legacy analyzer summaries', () => {
    const fresh = runFromSummary(
      { dv10_mm: 0.3, dv50_mm: 0.5, dv90_mm: 0.8, diameter_mean_mm: 0.48, cluster_count: 1200 },
      { grindSetting: '10e', coffee: 'Ethiopia' },
    )
    expect(fresh).toMatchObject({
      grindSetting: '10E', dv50_um: 500, mean_um: 480, n_particles: 1200, coffee: 'Ethiopia', apiShape: 'new',
    })
    expect(fresh.dv10_um).toBeCloseTo(300, 6)
    expect(fresh.dv90_um).toBeCloseTo(800, 6)

    const legacy = runFromSummary({ diameter_mean_mm: 0.4 }, { grindSetting: '8A', nclusters: 50 })
    expect(legacy).toMatchObject({ apiShape: 'legacy', dv50_um: null, mean_um: 400, n_particles: 50, coffee: null })

    expect(runFromSummary({ dv50_mm: 0.5 }, { grindSetting: 'zzz' })).toBeNull()
    expect(runFromSummary({}, { grindSetting: '10E' })).toBeNull()
    expect(runFromSummary(null, { grindSetting: '10E' })).toBeNull()
    expect(addRun(fresh).ok).toBe(true)
  })
})
