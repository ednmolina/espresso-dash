// UI-side logic of "particle shape" and "Separate touching particles":
// settings defaults / legacy preset, the cloud payload, saved-run labels, the grinder "separated" tag,
// the in-memory latest analysis and the Diagnostics "Photo analysis checks" view-model.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS, LEGACY_SETTINGS, MEASUREMENT_KEYS, analysisSettingsPayload, settingsPayload,
} from '../constants'
import { normalizeShape, normalizeSplit, savedRunLabel, mergeErase } from '../analyzerCompat'
import {
  STORAGE_KEY, _resetForTests as resetStore, addRun, getRuns, importJson, exportJson, runFromSummary, setRunExcluded,
} from '../calibrationStore'
import { buildCalibrationPoints } from '../grindCalibration'
import {
  _resetForTests as resetLatest, clearLatestAnalysis, getLatestAnalysis, setLatestAnalysis, subscribeLatestAnalysis,
} from '../analysisSession'
import { checksSubtitle, formatChange, photoChecksModel } from '../photoChecks'

describe('settings defaults', () => {
  it('separation is off by default and in the legacy preset, so Legacy switches it off', () => {
    expect(DEFAULT_SETTINGS.split_touching).toBe(false)
    expect(LEGACY_SETTINGS.split_touching).toBe(false)
    expect(MEASUREMENT_KEYS).toContain('split_touching')
    // the Legacy checkbox is "every measurement key equals its legacy value"
    const isLegacy = (s) => MEASUREMENT_KEYS.every((k) => s[k] === LEGACY_SETTINGS[k])
    expect(isLegacy({ ...DEFAULT_SETTINGS, ...LEGACY_SETTINGS })).toBe(true)
    expect(isLegacy({ ...DEFAULT_SETTINGS, ...LEGACY_SETTINGS, split_touching: true })).toBe(false)
  })

  it('the default volume model is still legacy', () => {
    expect(DEFAULT_SETTINGS.volume_model).toBe('legacy')
  })
})

describe('analysisSettingsPayload', () => {
  const on = { ...DEFAULT_SETTINGS, split_touching: true, volume_model: 'ellipsoid', min_diameter_um: null }

  it('on-device: sends everything (nulls dropped), nothing stripped', () => {
    const { body, stripped } = analysisSettingsPayload(on, { isLocal: true })
    expect(body).toEqual(settingsPayload(on))
    expect(body.split_touching).toBe(true)
    expect(body.volume_model).toBe('ellipsoid')
    expect('min_diameter_um' in body).toBe(false)
    expect(stripped).toEqual([])
  })

  it('on-device with defaults: the same body as before plus split_touching: false', () => {
    const { body } = analysisSettingsPayload(DEFAULT_SETTINGS)
    expect(body).toEqual({ ...settingsPayload({ ...DEFAULT_SETTINGS, split_touching: undefined }), split_touching: false })
  })

  it('cloud: strips the split options and falls ellipsoid back to legacy', () => {
    const { body, stripped } = analysisSettingsPayload({ ...on, split_neck_ratio: 0.6 }, { isLocal: false })
    expect('split_touching' in body).toBe(false)
    expect('split_neck_ratio' in body).toBe(false)
    expect(body.volume_model).toBe('legacy')
    expect(stripped).toEqual(['Separate touching particles', 'Ellipsoid volume'])
  })

  it('cloud with defaults: the request body is exactly the pre-feature one and nothing is reported', () => {
    const { body, stripped } = analysisSettingsPayload(DEFAULT_SETTINGS, { isLocal: false })
    const { split_touching, ...before } = settingsPayload(DEFAULT_SETTINGS) // eslint-disable-line no-unused-vars
    expect(body).toEqual(before)
    expect(stripped).toEqual([])
  })

  it('cloud keeps the existing volume models', () => {
    for (const volume_model of ['legacy', 'spheroid']) {
      expect(analysisSettingsPayload({ ...DEFAULT_SETTINGS, volume_model }, { isLocal: false }).body.volume_model).toBe(volume_model)
    }
  })

  it('does not mutate the settings object', () => {
    const copy = { ...on }
    analysisSettingsPayload(on, { isLocal: false })
    expect(on).toEqual(copy)
  })
})

describe('normalizeShape (volume-weighted aspect statistics)', () => {
  it('is null without a median, and keeps the numbers otherwise', () => {
    expect(normalizeShape(null)).toBeNull()
    expect(normalizeShape({ aspect_ratio_median: null, aspect_ratio_n: 8 })).toBeNull()
    expect(normalizeShape({ aspect_ratio_median: 1.32, aspect_ratio_p10: 1.08, aspect_ratio_p90: 1.75, aspect_ratio_n: 2410, min_px: 20 }))
      .toEqual({ arMedian: 1.32, arP10: 1.08, arP90: 1.75, n: 2410 })
  })
})

describe('normalizeSplit', () => {
  it('is null unless split_info is present', () => {
    expect(normalizeSplit(undefined)).toBeNull()
    expect(normalizeSplit(null)).toBeNull()
  })

  it('counts the pieces the split clumps became (clusters_split + pieces_added)', () => {
    const n = normalizeSplit({
      clusters_split: 71, pieces_added: 77, candidates: 900, rejected_splits: 3,
      unsplit: { cluster_count: 3991, dv10_mm: 0.251, dv50_mm: 0.468, dv90_mm: 0.823 },
    })
    expect(n).toEqual({ clustersSplit: 71, pieces: 148, before: { count: 3991, dv10: 0.251, dv50: 0.468, dv90: 0.823 } })
  })

  it('handles "on, nothing found" and a missing pixel scale', () => {
    expect(normalizeSplit({ clusters_split: 0, pieces_added: 0, unsplit: null })).toEqual({ clustersSplit: 0, pieces: 0, before: null })
  })
})

describe('saved-run label', () => {
  it('adds " · separated" only for runs with summary.split_touching === true', () => {
    expect(savedRunLabel({ label: 'Run 1', summary: { split_touching: true } })).toBe('Run 1 · separated')
    expect(savedRunLabel({ label: 'Run 2', summary: { split_touching: false } })).toBe('Run 2')
    expect(savedRunLabel({ label: 'Run 3', summary: { dv50_mm: 0.4 } })).toBe('Run 3')
    expect(savedRunLabel({ label: 'Run 4', summary: null })).toBe('Run 4')
    expect(savedRunLabel({ label: 'Run 5' })).toBe('Run 5')
  })
})

describe('mergeErase keeps the analysis-time split_info', () => {
  it('does not drop split_info or shape_summary of the base result', () => {
    const base = { split_info: { clusters_split: 2 }, shape_summary: { aspect_ratio_median: 1.2 }, summary: { a: 1 }, nclusters: 10 }
    const merged = mergeErase(base, { summary: { a: 2 }, nclusters: 9, shape_summary: { aspect_ratio_median: 1.3 } }, [1])
    expect(merged.split_info).toEqual({ clusters_split: 2 })
    expect(merged.shape_summary.aspect_ratio_median).toBe(1.3)
    expect(merged.summary).toEqual({ a: 2 })
  })
})

function memoryStorage() {
  const data = new Map()
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)) },
    removeItem: (k) => data.delete(k),
  }
}

describe('grinder calibration: the "separated" tag', () => {
  let storage
  beforeEach(() => { storage = memoryStorage(); vi.stubGlobal('localStorage', storage); resetStore() })
  afterEach(() => { vi.unstubAllGlobals(); resetStore() })

  it('runFromSummary tags separated runs only', () => {
    const s = { dv50_mm: 0.5, diameter_mean_mm: 0.48, cluster_count: 400 }
    expect(runFromSummary({ ...s, split_touching: true }, { grindSetting: '10E' }).separated).toBe(true)
    expect('separated' in runFromSummary(s, { grindSetting: '10E' })).toBe(false)
    expect('separated' in runFromSummary({ ...s, split_touching: false }, { grindSetting: '10E' })).toBe(false)
  })

  it('stores the tag, reloads it, exports and imports it', () => {
    const res = addRun(runFromSummary({ dv50_mm: 0.5, diameter_mean_mm: 0.48, split_touching: true }, { grindSetting: '10E' }))
    expect(res.run.separated).toBe(true)
    expect(JSON.parse(storage.data.get(STORAGE_KEY))[0].separated).toBe(true)
    const text = exportJson()
    resetStore()
    expect(getRuns()[0].separated).toBe(true) // reloaded from localStorage
    storage.data.clear()
    resetStore()
    expect(importJson(text)).toMatchObject({ added: 1, invalid: 0 })
    expect(getRuns()[0].separated).toBe(true)
  })

  it('old stored runs (no tag) still load, unchanged in shape', () => {
    const old = {
      id: 'old1', grindSetting: '9A', score: 90, index: 73, dv10_um: 250, dv50_um: 440, dv90_um: 800, mean_um: 420,
      n_particles: 500, coffee: 'Huila', createdAt: '2026-10-29T10:00:00.000Z', excluded: false, apiShape: 'new',
    }
    storage.setItem(STORAGE_KEY, JSON.stringify([old]))
    resetStore()
    const [run] = getRuns()
    expect(run).toMatchObject({ id: 'old1', grindSetting: '9A', mean_um: 420 })
    expect('separated' in run).toBe(false)
    // a hand-edited non-boolean tag is not trusted
    storage.setItem(STORAGE_KEY, JSON.stringify([{ ...old, separated: 'yes' }]))
    resetStore()
    expect('separated' in getRuns()[0]).toBe(false)
  })

  it('a separated point can be excluded like any other', () => {
    const { run } = addRun(runFromSummary({ dv50_mm: 0.5, diameter_mean_mm: 0.48, split_touching: true }, { grindSetting: '10E' }))
    expect(setRunExcluded(run.id, true)).toBe(true)
    const points = buildCalibrationPoints([], getRuns())
    expect(points.length).toBe(2)
    for (const p of points) expect(p).toMatchObject({ source: 'photo', separated: true, excluded: true })
  })

  it('calibration points carry the tag only for separated runs', () => {
    const points = buildCalibrationPoints([], [
      { id: 'a', grindSetting: '10E', mean_um: 480, dv50_um: 460, createdAt: '2026-10-01' },
      { id: 'b', grindSetting: '10E', mean_um: 470, dv50_um: 450, createdAt: '2026-10-02', separated: true },
    ])
    expect(points.filter((p) => p.separated).map((p) => p.id).sort()).toEqual(['run:b:dv50', 'run:b:mean'])
    expect(points.find((p) => p.id === 'run:a:mean')).not.toHaveProperty('separated')
  })
})

describe('analysisSession (in memory only)', () => {
  beforeEach(() => resetLatest())
  afterEach(() => resetLatest())

  it('starts empty, stores the latest analysis and notifies', () => {
    expect(getLatestAnalysis()).toBeNull()
    const fn = vi.fn()
    const off = subscribeLatestAnalysis(fn)
    setLatestAnalysis({ summary: { dv50_mm: 0.4 }, shape_summary: { aspect_ratio_median: 1.3 }, split_info: null, at: 5 })
    expect(getLatestAnalysis()).toEqual({ summary: { dv50_mm: 0.4 }, shape_summary: { aspect_ratio_median: 1.3 }, split_info: null, at: 5 })
    expect(fn).toHaveBeenCalledTimes(1)
    setLatestAnalysis({ summary: null })
    expect(getLatestAnalysis().summary).toBeNull()
    off()
    clearLatestAnalysis()
    expect(getLatestAnalysis()).toBeNull()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('writes nothing to localStorage', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    try {
      setLatestAnalysis({ summary: { dv50_mm: 0.4 } })
      expect(storage.data.size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('photoChecksModel (Diagnostics "Photo analysis checks")', () => {
  const shape = { aspect_ratio_median: 1.32, aspect_ratio_p10: 1.08, aspect_ratio_p90: 1.75, aspect_ratio_n: 2410, min_px: 20 }

  it('is null before any analysis (empty state)', () => {
    expect(photoChecksModel(null)).toBeNull()
    expect(checksSubtitle(null)).toBe('Analyze a photo to see them')
  })

  it('separation off: shape only, no comparison table', () => {
    const m = photoChecksModel({ summary: { dv50_mm: 0.468, dv90_mm: 0.823, cluster_count: 3991 }, shape_summary: shape, split_info: null })
    expect(m.shape).toMatchObject({ arMedian: 1.32, n: 2410 })
    expect(m.table).toBeNull()
    expect(m.minPx).toBe(20)
    expect(checksSubtitle(m)).toBe('Shape 1.32 : 1 · separation off')
  })

  it('separation on: before/after table and the Dv90 change', () => {
    const m = photoChecksModel({
      summary: { dv50_mm: 0.459, dv90_mm: 0.792, cluster_count: 4068, split_touching: true },
      shape_summary: shape,
      split_info: { clusters_split: 71, pieces_added: 77, unsplit: { cluster_count: 3991, dv10_mm: 0.251, dv50_mm: 0.468, dv90_mm: 0.823 } },
    })
    expect(m.table.particles).toEqual([3991, 4068])
    expect(m.table.dv50).toEqual([0.468, 0.459])
    expect(m.table.dv90).toEqual([0.823, 0.792])
    expect(m.table.change.text).toBe('−3.8%')
    expect(m.table.change.lower).toBe(true)
    expect(checksSubtitle(m)).toBe('Shape 1.32 : 1 · Dv90 −3.8% separated')
  })

  it('separation on without a pixel scale: no change figure, dashes instead of numbers', () => {
    const m = photoChecksModel({ summary: null, shape_summary: null, split_info: { clusters_split: 0, pieces_added: 0, unsplit: null } })
    expect(m.shape).toBeNull()
    expect(m.table.change).toBeNull()
    expect(m.table.dv90).toEqual([null, null])
    expect(checksSubtitle(m)).toBe('Shape not measured · separated')
  })

  it('formats changes with a real minus sign', () => {
    expect(formatChange(-3.84)).toBe('−3.8%')
    expect(formatChange(2.26)).toBe('+2.3%')
    expect(formatChange(0)).toBe('0.0%')
  })
})
