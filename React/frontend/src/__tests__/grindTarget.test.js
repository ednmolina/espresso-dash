import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCalibration, indexToSetting } from '../grindCalibration'
import {
  LIMITS, buildForecastModel, coffeeKey, suggestGrind, targetFor,
} from '../forecastModel'
import {
  GRIND_TARGET_KEY, getGrindTargetMode, resetGrindTargetModeCache, setGrindTargetMode, targetLine,
} from '../grindTargetPref'

const A = { roaster: 'Onyx', region: 'Huila', variety: 'Caturra' }
const B = { roaster: 'Sey', region: 'Gedeo', variety: 'Heirloom' }
const keyA = coffeeKey(A)
const day = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)

let counter = 0
const shot = (coffee, extraction, rating, over = {}) => {
  counter += 1
  return { id: `t${counter}`, date: day(counter), ...coffee, extraction, rating, grindSetting: '10E', ...over }
}
const many = (n, coffee, extraction, rating, over) => Array.from({ length: n }, (_, i) => shot(coffee, extraction + i * 0.1, rating, over))

describe('targetFor', () => {
  it("'fixed' (and anything unknown) is always 20%", () => {
    const shots = many(6, A, 21, 2)
    expect(targetFor(shots, keyA, 'fixed')).toEqual({ target: 20, source: 'fixed', n: 0 })
    expect(targetFor(shots, keyA)).toEqual({ target: 20, source: 'fixed', n: 0 })
    expect(targetFor(shots, keyA, 'nonsense').source).toBe('fixed')
  })

  it("'best' averages this coffee's Great shots when there are at least 3", () => {
    const shots = [...many(5, A, 20, 2), ...many(8, B, 22, 2)]
    const t = targetFor(shots, keyA, 'best')
    expect(t.source).toBe('coffee')
    expect(t.n).toBe(5)
    expect(t.target).toBeCloseTo(20.2, 10)
    expect(t.coffeeLabel).toBe('Onyx · Huila · Caturra')
  })

  it('falls back to all Great shots when this coffee has fewer than 3', () => {
    const shots = [...many(2, A, 20, 2), ...many(4, B, 22, 2)]
    const t = targetFor(shots, keyA, 'best')
    expect(t.source).toBe('all')
    expect(t.n).toBe(6)
    expect(t.target).toBeCloseTo((20 + 20.1 + 22 + 22.1 + 22.2 + 22.3) / 6, 10)
    expect(t.coffeeLabel).toBeUndefined()
  })

  it('falls back to 20 when fewer than 3 Great shots exist at all', () => {
    const t = targetFor(many(2, A, 21, 2), keyA, 'best')
    expect(t).toMatchObject({ target: 20, source: 'fallback', n: 2 })
    expect(targetFor([], keyA, 'best')).toMatchObject({ target: 20, source: 'fallback', n: 0 })
    expect(targetFor(null, keyA, 'best').source).toBe('fallback')
  })

  it('ignores Good/Bad, unrated (rated:false) and non-finite extractions', () => {
    const shots = [
      ...many(2, A, 20, 2),
      ...many(5, A, 25, 1),
      ...many(5, A, 15, 0),
      ...many(5, A, 30, 2, { rated: false }),
      ...Array.from({ length: 5 }, () => shot(A, null, 2)),
      shot(A, NaN, 2),
      shot(A, undefined, 2),
    ]
    const t = targetFor(shots, keyA, 'best')
    expect(t).toMatchObject({ source: 'fallback', n: 2, target: 20 })
    const more = [...shots, shot(A, 22, 2)]
    const u = targetFor(more, keyA, 'best')
    expect(u.source).toBe('coffee')
    expect(u.n).toBe(3)
    expect(u.target).toBeCloseTo((20 + 20.1 + 22) / 3, 10)
  })

  it('matches the coffee by key, not by label text', () => {
    const shots = [...many(3, { ...A, roaster: ' ONYX ' }, 21, 2), ...many(3, B, 19, 2)]
    expect(targetFor(shots, keyA, 'best')).toMatchObject({ source: 'coffee', n: 3 })
  })
})

describe('targetLine', () => {
  it('words each source', () => {
    expect(targetLine(targetFor([], keyA, 'fixed'))).toBe('Aiming for 20%.')
    expect(targetLine({ target: 20.64, source: 'coffee', n: 5, coffeeLabel: 'Ethiopia Guji' }))
      .toBe('Target 20.6% · average of your 5 Great shots of Ethiopia Guji')
    expect(targetLine({ target: 20.4, source: 'all', n: 12 }))
      .toContain('Not enough Great shots of this coffee — using all your Great shots (12)')
    expect(targetLine({ target: 20, source: 'fallback', n: 1 })).toBe('Not enough Great shots yet — using 20%')
  })
})

describe('suggestGrind in fixed mode', () => {
  function rng(seed) {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const fixture = (n, seed, noise) => {
    const r = rng(seed)
    return Array.from({ length: n }, (_, i) => {
      const idx = 60 + Math.floor(r() * 80)
      const ratio = 1.8 + r() * 0.8
      return {
        id: `f${i}`, date: day(i), createdAt: `${day(i)}T08:00:00Z`, ...(i % 2 ? A : B),
        grindSetting: indexToSetting(idx), dose: 18, yieldGrams: 18 * ratio,
        extraction: 20 + (100 - idx) * 0.05 - 0.8 * (ratio - 2.2) + noise * (r() - 0.5),
        rating: Math.floor(r() * 3),
      }
    })
  }

  it('is byte-identical to the previous behaviour (target 20)', () => {
    for (const [n, seed, noise] of [[30, 1, 0.3], [60, 2, 1], [120, 3, 0.1]]) {
      const shots = fixture(n, seed, noise)
      const model = buildForecastModel(shots)
      for (const coffee of [keyA, coffeeKey(B)]) {
        for (const grindSetting of ['8A', '10E', '14H']) {
          const planned = { coffee, grindSetting, dose: 18, yieldGrams: 40 }
          const target = targetFor(shots, coffee, 'fixed')
          expect(target.target).toBe(LIMITS.TARGET)
          const old = suggestGrind(model, planned, 20)
          expect(JSON.stringify(suggestGrind(model, planned, target.target))).toBe(JSON.stringify(old))
          expect(JSON.stringify(suggestGrind(model, planned))).toBe(JSON.stringify(old))
        }
      }
    }
  })

  it('with a calibration curve too', () => {
    const shots = fixture(40, 5, 0.4)
    const runs = [40, 80, 120].map((x, i) => ({ id: `r${i}`, grindSetting: indexToSetting(x), mean_um: 300 * Math.exp(0.01 * x) }))
    const cal = buildCalibration(shots, runs, [])
    const model = buildForecastModel(shots, { calibration: { mean: cal.mean } })
    const planned = { coffee: keyA, grindSetting: '10E', dose: 18, yieldGrams: 40 }
    const old = suggestGrind(model, planned, 20)
    expect(old).not.toBeNull()
    expect(JSON.stringify(suggestGrind(model, planned, targetFor(shots, keyA, 'fixed').target))).toBe(JSON.stringify(old))
  })

  it('a different target moves the suggestion', () => {
    const shots = fixture(60, 2, 0.2)
    const model = buildForecastModel(shots)
    const planned = { coffee: keyA, grindSetting: '10E', dose: 18, yieldGrams: 40 }
    const at20 = suggestGrind(model, planned, 20)
    const at22 = suggestGrind(model, planned, 22)
    expect(at22.extraction).toBeGreaterThan(at20.extraction)
    expect(at22.index).toBeLessThan(at20.index)
  })
})

describe('grind target preference', () => {
  beforeEach(() => { globalThis.window = { localStorage: mem(), addEventListener() {}, removeEventListener() {} }; resetGrindTargetModeCache() })
  afterEach(() => { delete globalThis.window })
  function mem() {
    const m = new Map()
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }
  }

  it('defaults to fixed and persists the choice', () => {
    expect(getGrindTargetMode()).toBe('fixed')
    setGrindTargetMode('best')
    expect(window.localStorage.getItem(GRIND_TARGET_KEY)).toBe('best')
    resetGrindTargetModeCache()
    expect(getGrindTargetMode()).toBe('best')
    setGrindTargetMode('weird')
    expect(getGrindTargetMode()).toBe('fixed')
  })

  it('survives broken storage', () => {
    window.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    resetGrindTargetModeCache()
    expect(getGrindTargetMode()).toBe('fixed')
    expect(() => setGrindTargetMode('best')).not.toThrow()
    expect(getGrindTargetMode()).toBe('best')
  })

  it('ignores garbage in storage', () => {
    window.localStorage.setItem(GRIND_TARGET_KEY, 'zzz')
    resetGrindTargetModeCache()
    expect(getGrindTargetMode()).toBe('fixed')
  })
})
