import { describe, expect, it } from 'vitest'
import { checkFromRuns, dvFromSummary, formatPct, pooledPrecision, savedRunKey, summaryStats, uniqueSavedRuns } from '../precision'

const runs = (dv50s, extra = {}) => dv50s.map((v) => ({ dv10_um: v / 2, dv50_um: v, dv90_um: v * 2, ...extra }))

describe('summaryStats', () => {
  it('uses the sample SD (n - 1) and CV = SD / mean', () => {
    const s = summaryStats([2, 4, 4, 4, 5, 5, 7, 9])
    expect(s.n).toBe(8)
    expect(s.mean).toBeCloseTo(5, 10)
    expect(s.sd).toBeCloseTo(Math.sqrt(32 / 7), 10)
    expect(s.cv).toBeCloseTo(Math.sqrt(32 / 7) / 5, 10)
  })

  it('handles small and dirty input', () => {
    expect(summaryStats([])).toEqual({ n: 0, mean: null, sd: null, cv: null })
    expect(summaryStats([10])).toEqual({ n: 1, mean: 10, sd: null, cv: null })
    expect(summaryStats(null).n).toBe(0)
    expect(summaryStats([10, NaN, null, undefined, '12', 20])).toMatchObject({ n: 2, mean: 15 })
    expect(summaryStats([0, 0]).cv).toBeNull() // no relative spread around a zero mean
  })
})

describe('dvFromSummary', () => {
  it('converts mm to um and leaves missing fields null', () => {
    expect(dvFromSummary({ dv10_mm: 0.25, dv50_mm: 0.47, dv90_mm: 0.82, cluster_count: 4000 }))
      .toEqual({ dv10_um: 250, dv50_um: 470, dv90_um: 820, n_particles: 4000 })
    expect(dvFromSummary({ diameter_mean_mm: 0.4 })).toEqual({ dv10_um: null, dv50_um: null, dv90_um: null, n_particles: null })
    expect(dvFromSummary(null).dv50_um).toBeNull()
  })
})

describe('checkFromRuns', () => {
  it('gives stats per metric', () => {
    const c = checkFromRuns(runs([90, 100, 110]))
    expect(c.dv50.n).toBe(3)
    expect(c.dv50.mean).toBeCloseTo(100, 10)
    expect(c.dv50.sd).toBeCloseTo(10, 10)
    expect(c.dv50.cv).toBeCloseTo(0.1, 10)
    expect(c.dv10.cv).toBeCloseTo(0.1, 10) // scaling does not change the CV
  })

  it('needs 2 usable values per metric', () => {
    expect(checkFromRuns(runs([100]))).toEqual({ dv10: null, dv50: null, dv90: null })
    expect(checkFromRuns([])).toEqual({ dv10: null, dv50: null, dv90: null })
    const mixed = checkFromRuns([{ dv50_um: 100 }, { dv50_um: 110, dv90_um: 900 }])
    expect(mixed.dv50.n).toBe(2)
    expect(mixed.dv10).toBeNull()
    expect(mixed.dv90).toBeNull() // only one Dv90
  })
})

describe('pooledPrecision', () => {
  it('pools CV by degrees of freedom', () => {
    const a = runs([90, 100, 110]) // n 3, cv 0.1
    const b = runs([95, 105]) // n 2, cv = sqrt(50) / 100
    const cvB = Math.sqrt(50) / 100
    const p = pooledPrecision([{ runs: a }, { runs: b }])
    const expected = Math.sqrt((2 * 0.1 ** 2 + 1 * cvB ** 2) / 3)
    expect(p.dv50.cv).toBeCloseTo(expected, 10)
    expect(p.dv50.onePhotoPct).toBeCloseTo(expected * 200, 8)
    expect(p.dv50.checks).toBe(2)
    expect(p.dv50.photos).toBe(5)
  })

  it('weights a check with more photos more heavily', () => {
    const tight = runs([100, 100.5, 99.5, 100.2, 99.8, 100.1]) // 6 photos, very tight
    const loose = runs([80, 120]) // 2 photos, loose
    const heavy = pooledPrecision([{ runs: tight }, { runs: loose }]).dv50.cv
    const plain = (checkFromRuns(tight).dv50.cv + checkFromRuns(loose).dv50.cv) / 2
    expect(heavy).toBeLessThan(plain)
  })

  it('accepts already computed checks', () => {
    const c = checkFromRuns(runs([90, 100, 110]))
    expect(pooledPrecision([c]).dv50.cv).toBeCloseTo(0.1, 10)
  })

  it('is null until there are 3 photos in total', () => {
    expect(pooledPrecision([])).toEqual({ dv10: null, dv50: null, dv90: null })
    expect(pooledPrecision([{ runs: runs([100, 110]) }]).dv50).toBeNull() // 2 photos
    expect(pooledPrecision([{ runs: runs([100]) }, { runs: runs([100]) }, { runs: runs([100]) }]).dv50).toBeNull() // no check has 2
    expect(pooledPrecision([{ runs: runs([100, 110]) }, { runs: runs([200, 210]) }]).dv50.photos).toBe(4)
    expect(pooledPrecision([{ runs: runs([100, 110, 105]) }]).dv50.photos).toBe(3)
  })

  it('skips excluded checks and metrics that are missing', () => {
    const p = pooledPrecision([
      { runs: runs([100, 110, 105]) },
      { runs: runs([1, 500]), excluded: true },
      { runs: [{ dv50_um: 100 }, { dv50_um: 104 }] },
    ])
    expect(p.dv50.checks).toBe(2)
    expect(p.dv90.checks).toBe(1)
    expect(p.dv90.photos).toBe(3)
    expect(pooledPrecision(null).dv50).toBeNull()
  })
})

describe('formatPct', () => {
  it('rounds to whole numbers from 1% and shows one decimal below, never "0"', () => {
    expect(formatPct(7.2)).toBe('7')
    expect(formatPct(0.96)).toBe('1.0')
    expect(formatPct(1)).toBe('1')
    expect(formatPct(0.6)).toBe('0.6')
    expect(formatPct(0.04)).toBe('0.1')
    expect(formatPct(0)).toBe('0')
    expect(formatPct(null)).toBe('0')
  })
})

describe('saved run identity', () => {
  const run = (over = {}) => ({ imageId: 'img.a1', removedIds: [], summary: { cluster_count: 10, dv50_mm: 0.5 }, ...over })
  it('same analysis and same removed clusters is the same run, in any order', () => {
    expect(savedRunKey(run({ removedIds: [3, 1] }))).toBe(savedRunKey(run({ removedIds: [1, 3] })))
    expect(savedRunKey(run())).not.toBe(savedRunKey(run({ imageId: 'img.b2' })))
    expect(savedRunKey(run())).not.toBe(savedRunKey(run({ removedIds: [1] })))
  })
  it('uniqueSavedRuns drops repeats and keeps the first', () => {
    const a = run(); const b = run({ imageId: 'img.b2' })
    expect(uniqueSavedRuns([a, b, { ...a }, b])).toEqual([a, b])
    expect(uniqueSavedRuns(null)).toEqual([])
  })
})
