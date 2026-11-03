import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STORAGE_KEY, _resetForTests, addCheck, exportJson, importJson, listChecks, setExcluded, subscribe, updateCheck, saveCheck,
} from '../repeatStore'

function memoryStorage({ throwOnSet = false, throwOnGet = false } = {}) {
  const data = new Map()
  return {
    data,
    getItem: (k) => {
      if (throwOnGet) throw new Error('denied')
      return data.has(k) ? data.get(k) : null
    },
    setItem: (k, v) => {
      if (throwOnSet) throw new Error('quota')
      data.set(k, String(v))
    },
    removeItem: (k) => data.delete(k),
  }
}

const photo = (v) => ({ dv10_um: v / 2, dv50_um: v, dv90_um: v * 2, n_particles: 4000 })
const partial = (over = {}) => ({ grindSetting: '10E', runs: [photo(450), photo(470), photo(485)], ...over })

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

describe('updateCheck', () => {
  it('replaces the photos of the same check: id, date and excluded flag stay', () => {
    const first = addCheck(partial()).check
    setExcluded(first.id, true)
    const seen = vi.fn()
    subscribe(seen)
    const res = updateCheck(first.id, { grindSetting: '12A', runs: [photo(450), photo(470), photo(485), photo(460)] })
    expect(res).toMatchObject({ ok: true, persisted: true })
    expect(res.check).toMatchObject({ id: first.id, createdAt: first.createdAt, excluded: true, grindSetting: '12A' })
    expect(res.check.runs).toHaveLength(4)
    expect(listChecks()).toHaveLength(1)
    expect(seen).toHaveBeenCalledTimes(1)
    _resetForTests() // a fresh page load
    expect(listChecks()).toEqual([res.check])
  })

  it('keeps the old setting when none is given, and rejects bad input without changing anything', () => {
    const first = addCheck(partial()).check
    expect(updateCheck(first.id, { runs: [photo(500), photo(510)] }).check.grindSetting).toBe('10E')
    const before = listChecks()
    expect(updateCheck(first.id, { runs: [photo(500)] })).toMatchObject({ ok: false })
    expect(updateCheck(first.id, {})).toMatchObject({ ok: false })
    expect(updateCheck('nope', { runs: [photo(1), photo(2)] })).toMatchObject({ ok: false, notFound: true })
    expect(listChecks()).toBe(before)
  })
})

describe('saveCheck (adding photos after a save)', () => {
  it('first save adds; saving again with the id updates the same check instead of overlapping it', () => {
    const a = saveCheck(null, partial())
    expect(a).toMatchObject({ ok: true, updated: false })
    const b = saveCheck(a.check.id, partial({ runs: [photo(450), photo(470), photo(485), photo(460)] }))
    expect(b).toMatchObject({ ok: true, updated: true })
    expect(b.check.id).toBe(a.check.id)
    expect(listChecks()).toHaveLength(1)
    expect(listChecks()[0].runs).toHaveLength(4)
    const c = saveCheck(a.check.id, partial({ runs: [photo(450), photo(470), photo(485), photo(460), photo(455)] }))
    expect(c.check.id).toBe(a.check.id)
    expect(listChecks()).toHaveLength(1)
  })

  it('adds a new check when the old one has been removed from storage', () => {
    const a = saveCheck(null, partial())
    _resetForTests()
    storage.data.clear()
    const b = saveCheck(a.check.id, partial())
    expect(b).toMatchObject({ ok: true, updated: false })
    expect(b.check.id).not.toBe(a.check.id)
    expect(listChecks()).toHaveLength(1)
  })

  it('does not add a second check when the update itself is invalid', () => {
    const a = saveCheck(null, partial())
    expect(saveCheck(a.check.id, { runs: [photo(1)] })).toMatchObject({ ok: false, updated: false })
    expect(listChecks()).toHaveLength(1)
  })
})

describe('repeatStore', () => {
  it('starts empty', () => {
    expect(listChecks()).toEqual([])
  })

  it('round-trips a check through localStorage', () => {
    const res = addCheck(partial())
    expect(res).toMatchObject({ ok: true, persisted: true })
    expect(res.check.id).toBeTruthy()
    expect(res.check.excluded).toBe(false)
    expect(Number.isNaN(Date.parse(res.check.createdAt))).toBe(false)
    expect(res.check.grindSetting).toBe('10E')
    expect(res.check.runs).toHaveLength(3)

    expect(storage.data.has(STORAGE_KEY)).toBe(true)
    _resetForTests() // a fresh page load
    expect(listChecks()).toEqual([res.check])
  })

  it('keeps a missing grind setting as null and drops runs without a size', () => {
    const res = addCheck({ runs: [photo(450), photo(470), { n_particles: 5 }, null] })
    expect(res.ok).toBe(true)
    expect(res.check.grindSetting).toBeNull()
    expect(res.check.runs).toHaveLength(2)
  })

  it('rejects checks with fewer than 2 usable photos', () => {
    expect(addCheck(partial({ runs: [photo(450)] }))).toMatchObject({ ok: false, persisted: false })
    expect(addCheck({})).toMatchObject({ ok: false })
    expect(addCheck(null)).toMatchObject({ ok: false })
    expect(listChecks()).toEqual([])
  })

  it('survives corrupt or wrongly shaped storage', () => {
    storage.data.set(STORAGE_KEY, '{not json')
    expect(listChecks()).toEqual([])
    _resetForTests()
    storage.data.set(STORAGE_KEY, JSON.stringify({ a: 1 }))
    expect(listChecks()).toEqual([])
    _resetForTests()
    storage.data.set(STORAGE_KEY, JSON.stringify([null, 3, { id: 'x' }, { id: 'ok', runs: [photo(1), photo(2)] }]))
    expect(listChecks().map((c) => c.id)).toEqual(['ok'])
    expect(addCheck(partial()).ok).toBe(true)
  })

  it('works in memory when storage throws or is missing', () => {
    vi.stubGlobal('localStorage', memoryStorage({ throwOnSet: true, throwOnGet: true }))
    _resetForTests()
    expect(listChecks()).toEqual([])
    const res = addCheck(partial())
    expect(res).toMatchObject({ ok: true, persisted: false })
    expect(listChecks()).toHaveLength(1)
    expect(setExcluded(res.check.id, true)).toBe(true)

    vi.stubGlobal('localStorage', undefined)
    _resetForTests()
    expect(listChecks()).toEqual([])
    expect(addCheck(partial())).toMatchObject({ ok: true, persisted: false })
  })

  it('excludes and re-includes a check', () => {
    const { check } = addCheck(partial())
    expect(setExcluded(check.id, true)).toBe(true)
    expect(listChecks()[0].excluded).toBe(true)
    expect(JSON.parse(storage.data.get(STORAGE_KEY))[0].excluded).toBe(true)
    expect(setExcluded(check.id, false)).toBe(true)
    expect(listChecks()[0].excluded).toBe(false)
    expect(setExcluded('nope', true)).toBe(false)
  })

  it('notifies subscribers and keeps the list identity until something changes', () => {
    const fn = vi.fn()
    const off = subscribe(fn)
    const before = listChecks()
    expect(listChecks()).toBe(before)
    const { check } = addCheck(partial())
    expect(fn).toHaveBeenCalledTimes(1)
    expect(listChecks()).not.toBe(before)
    const same = listChecks()
    setExcluded(check.id, false) // no change
    expect(listChecks()).toBe(same)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    addCheck(partial())
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('exports and re-imports, de-duplicating by id', () => {
    const a = addCheck(partial({ id: 'a' })).check
    addCheck(partial({ id: 'b', grindSetting: '9H' }))
    const text = exportJson()
    expect(JSON.parse(text).format).toBe('espressoLab.repeatChecks')

    expect(importJson(text)).toEqual({ added: 0, duplicates: 2, invalid: 0 })
    expect(listChecks()).toHaveLength(2)

    _resetForTests()
    storage.data.clear()
    expect(importJson(text)).toEqual({ added: 2, duplicates: 0, invalid: 0 })
    expect(listChecks()[0]).toEqual(a)
    expect(importJson(text).duplicates).toBe(2)
    expect(JSON.parse(storage.data.get(STORAGE_KEY))).toHaveLength(2)
  })

  it('counts invalid import entries and rejects bad files', () => {
    const res = importJson(JSON.stringify({ checks: [{ id: 'z', runs: [photo(1), photo(2)] }, { id: 'bad', runs: [] }, 7] }))
    expect(res).toEqual({ added: 1, duplicates: 0, invalid: 2 })
    expect(importJson('nope')).toMatchObject({ added: 0, error: expect.any(String) })
    expect(importJson('{"x":1}')).toMatchObject({ added: 0, error: expect.any(String) })
    expect(importJson(JSON.stringify([{ id: 'arr', runs: [photo(1), photo(2)] }])).added).toBe(1)
  })
})
