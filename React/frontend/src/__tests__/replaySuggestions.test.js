import { describe, expect, it } from 'vitest'
import { indexToSetting } from '../grindCalibration'
import { LIMITS, buildForecastModel, replaySuggestions } from '../forecastModel'
import { directionText, grindSuggestionsSubtitle } from '../components/diagnostics/GrindSuggestionsCard'

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
const day = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)
const COFFEES = [
  { roaster: 'Onyx', region: 'Huila', variety: 'Caturra' },
  { roaster: 'Sey', region: 'Gedeo', variety: 'Heirloom' },
]
const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Noise-free: extraction = 20 - 0.25 * (index - 100), so index 100 is exactly 20%. */
function linearShots(n, seed = 7, over = () => ({})) {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => {
    const idx = 80 + Math.floor(r() * 41)
    const extraction = 20 - 0.25 * (idx - 100)
    return {
      id: `s${String(i).padStart(3, '0')}`, date: day(i), createdAt: `${day(i)}T08:00:00Z`,
      ...COFFEES[i % 2], grindSetting: indexToSetting(idx), dose: 18, yieldGrams: 36,
      extraction, rating: extraction >= 19.5 && extraction <= 20.5 ? 2 : 1, ...over(i, r),
    }
  })
}

describe('replaySuggestions', () => {
  it('classifies, summarises and checks direction on a noise-free example', () => {
    const shots = linearShots(60)
    const res = replaySuggestions(shots, { mode: 'fixed' })
    expect(res.evaluated).toBe(60 - LIMITS.BACKTEST_MIN_TRAIN)
    expect(res.rows).toHaveLength(res.evaluated)
    expect(res.followed.n + res.notFollowed.n).toBe(res.evaluated)

    // the prefix model finds the 20% setting (index 100) once it has a few shots
    res.rows.filter((r) => r.order >= 20).forEach((r) => {
      expect(Math.abs(r.suggestedIndex - 100)).toBeLessThanOrEqual(3)
      expect(r.target).toBe(20)
      expect(r.targetSource).toBe('fixed')
    })

    // independent recount from the rows
    const fol = res.rows.filter((r) => Math.abs(r.actualIndex - r.suggestedIndex) <= 1)
    const not = res.rows.filter((r) => Math.abs(r.actualIndex - r.suggestedIndex) > 1)
    expect(res.rows.filter((r) => r.followed).map((r) => r.id)).toEqual(fol.map((r) => r.id))
    expect(res.followed.n).toBe(fol.length)
    expect(res.notFollowed.n).toBe(not.length)
    expect(res.followed.medianAbsFromTarget).toBeCloseTo(median(fol.map((r) => Math.abs(r.extraction - 20))), 10)
    expect(res.notFollowed.medianAbsFromTarget).toBeCloseTo(median(not.map((r) => Math.abs(r.extraction - 20))), 10)
    expect(res.followed.withinPct).toBeCloseTo((fol.filter((r) => Math.abs(r.extraction - 20) <= 1).length / fol.length) * 100, 10)
    expect(res.notFollowed.withinPct).toBeCloseTo((not.filter((r) => Math.abs(r.extraction - 20) <= 1).length / not.length) * 100, 10)
    // shots at index 96..104 are within 1 pt of 20% by construction, so followers land close
    expect(res.followed.medianAbsFromTarget).toBeLessThan(res.notFollowed.medianAbsFromTarget)

    const moved = res.rows.filter((r) => Math.abs(r.actualIndex - r.suggestedIndex) >= 2)
    const agree = moved.filter((r) => (r.actualIndex < r.suggestedIndex ? r.extraction > r.suggestedExtraction : r.extraction < r.suggestedExtraction))
    expect(res.direction.total).toBe(moved.length)
    expect(res.direction.agree).toBe(agree.length)
    expect(res.direction.agree / res.direction.total).toBeGreaterThan(0.9)
    expect(res.direction.finer.total + res.direction.coarser.total).toBe(res.direction.total)
    expect(res.enough).toBe(res.followed.n >= 5)
  })

  it('never uses shots after the one being replayed', () => {
    const shots = linearShots(50, 3)
    const K = 30
    const pristine = replaySuggestions(shots, { mode: 'best', features: ['grind'] })
    const r2 = rng(99)
    const mutated = shots.map((s, i) => (i <= K ? s : {
      ...s, extraction: 12 + 16 * r2(), rating: Math.floor(r2() * 3), grindSetting: indexToSetting(40 + Math.floor(r2() * 120)),
    }))
    const after = replaySuggestions(mutated, { mode: 'best', features: ['grind'] })
    const upTo = (res) => res.rows.filter((r) => r.order <= K)
    expect(upTo(after).length).toBeGreaterThan(10)
    expect(upTo(after)).toEqual(upTo(pristine))
    // and it does react to earlier history
    expect(after.rows.filter((r) => r.order > K)).not.toEqual(pristine.rows.filter((r) => r.order > K))
  })

  it('best mode targets the average of earlier Great shots only', () => {
    const shots = linearShots(40, 5, () => ({}))
    const res = replaySuggestions(shots, { mode: 'best' })
    const fixed = replaySuggestions(shots, { mode: 'fixed' })
    expect(res.rows.some((r) => r.targetSource !== 'fixed')).toBe(true)
    res.rows.forEach((r) => {
      const earlier = shots.filter((s, i) => i < r.order && s.rating === 2)
      if (earlier.length >= 3) {
        const mine = earlier.filter((s) => s.roaster === shots[r.order].roaster)
        const pool = mine.length >= 3 ? mine : earlier
        expect(r.target).toBeCloseTo(pool.reduce((a, s) => a + s.extraction, 0) / pool.length, 9)
      } else {
        expect(r.target).toBe(20)
        expect(r.targetSource).toBe('fallback')
      }
    })
    expect(fixed.rows.every((r) => r.target === 20)).toBe(true)
  })

  it('is empty when there is too little data or grind is not an input', () => {
    const few = replaySuggestions(linearShots(6))
    expect(few).toMatchObject({ evaluated: 0, enough: false, followed: { n: 0, medianAbsFromTarget: null, withinPct: null } })
    expect(few.direction).toMatchObject({ agree: 0, total: 0 })
    const flat = replaySuggestions(linearShots(30, 1, () => ({ extraction: 20, grindSetting: '10E' })))
    expect(flat.enough).toBe(false)
    expect(replaySuggestions(null).evaluated).toBe(0)
    expect(replaySuggestions([]).enough).toBe(false)
  })

  it('skips shots without a grind setting', () => {
    const shots = linearShots(40, 2, (i) => (i % 2 ? { grindSetting: '' } : {}))
    const res = replaySuggestions(shots)
    const noGrind = new Set(shots.filter((s) => !s.grindSetting).map((s) => s.id))
    expect(res.rows.length).toBeGreaterThan(0)
    res.rows.forEach((r) => expect(noGrind.has(r.id)).toBe(false))
  })

  it('reports "enough" once 5 shots followed the suggestion', () => {
    const res = replaySuggestions(linearShots(80, 11))
    expect(res.followed.n).toBeGreaterThanOrEqual(5)
    expect(res.enough).toBe(true)
  })

  it('is fast: well under 200 ms for 300 shots (model already built)', () => {
    const r = rng(21)
    const shots = Array.from({ length: 300 }, (_, i) => {
      const idx = 60 + Math.floor(r() * 80)
      const ratio = 1.8 + r() * 0.8
      return {
        id: `p${i}`, date: day(i), createdAt: `${day(i)}T08:00:00Z`, ...COFFEES[i % 2],
        grindSetting: indexToSetting(idx), dose: 18, yieldGrams: 18 * ratio,
        extraction: 20 + (100 - idx) * 0.05 - 0.8 * (ratio - 2.2) + (r() - 0.5), rating: Math.floor(r() * 3),
      }
    })
    const model = buildForecastModel(shots)
    expect(model.selected).toContain('grind')
    replaySuggestions(shots, { mode: 'best' }) // warm JIT
    const t0 = performance.now()
    const res = replaySuggestions(shots, { mode: 'best' })
    const ms = performance.now() - t0
    console.log(`replaySuggestions(300 shots): ${ms.toFixed(1)} ms, ${res.evaluated} rows`)
    expect(res.evaluated).toBeGreaterThan(250)
    expect(ms).toBeLessThan(200)
  })
})

describe('card wording', () => {
  const base = { followed: { n: 9, medianAbsFromTarget: 0.6, withinPct: 67 }, notFollowed: { n: 23, medianAbsFromTarget: 1.4, withinPct: 35 }, enough: true }
  it('subtitle', () => {
    expect(grindSuggestionsSubtitle({ ...base })).toBe('Followed: 0.6% from target vs 1.4%')
    expect(grindSuggestionsSubtitle({ ...base, notFollowed: { n: 0, medianAbsFromTarget: null, withinPct: null } })).toBe('Followed: 0.6% from target')
    expect(grindSuggestionsSubtitle({ ...base, enough: false, followed: { n: 3 } })).toBe('Too few shots yet (3, needs 5)')
    expect(grindSuggestionsSubtitle(null)).toBe('Not measured yet')
  })
  it('direction sentence matches the data', () => {
    expect(directionText({ agree: 15, total: 18, finer: { agree: 15, total: 18 }, coarser: { agree: 0, total: 0 } }).text)
      .toBe('Finer than suggested → higher extraction in 15 of 18 shots, as expected.')
    expect(directionText({ agree: 4, total: 6, finer: { agree: 0, total: 0 }, coarser: { agree: 4, total: 6 } }).text)
      .toBe('Coarser than suggested → lower extraction in 4 of 6 shots, as expected.')
    expect(directionText({ agree: 5, total: 9, finer: { agree: 3, total: 5 }, coarser: { agree: 2, total: 4 } }).text)
      .toContain('in 5 of 9 shots, as expected')
    expect(directionText({ agree: 2, total: 9, finer: { agree: 2, total: 9 }, coarser: { total: 0 } }))
      .toMatchObject({ good: false, text: 'Finer than suggested → higher extraction in only 2 of 9 shots.' })
    expect(directionText({ agree: 0, total: 0 }).good).toBeNull()
  })
})
