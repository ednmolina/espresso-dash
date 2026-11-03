import { describe, expect, it } from 'vitest'
import {
  MAX_INDEX,
  buildCalibration,
  buildCalibrationPoints,
  fitCalibration,
  grindSettingToScore,
  indexToSetting,
  parseGrindUm,
  parseSetting,
  scoreToGrindSetting,
  settingToIndex,
  settingToSize,
  sizeToSetting,
} from '../grindCalibration'

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
function gauss(r) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
}
const run = (id, x, um, extra = {}) => ({ id, grindSetting: indexToSetting(x), mean_um: um, ...extra })

describe('settings', () => {
  it('round-trips all 279 settings through index and legacy score', () => {
    expect(MAX_INDEX).toBe(278)
    for (let i = 0; i <= MAX_INDEX; i += 1) {
      const label = indexToSetting(i)
      expect(settingToIndex(label)).toBe(i)
      expect(scoreToGrindSetting(grindSettingToScore(label))).toBe(label)
    }
    expect(indexToSetting(-5)).toBe('1A')
    expect(indexToSetting(9999)).toBe('31I')
  })

  it('rejects invalid input and accepts loose input', () => {
    for (const bad of ['', null, undefined, '0A', '32A', '10J', 'abc']) {
      expect(parseSetting(bad)).toBeNull()
      expect(settingToIndex(bad)).toBeNull()
    }
    expect(parseSetting(' 10e ').label).toBe('10E')
    expect(settingToIndex('10E.5')).toBe(settingToIndex('10E') + 0.5)
    expect(parseSetting('10E.5').half).toBe(true)
  })

  it('keeps the legacy score behaviour', () => {
    expect(grindSettingToScore('10e')).toBe(104)
    expect(grindSettingToScore('10E.5')).toBe(104.5)
    expect(grindSettingToScore('nope')).toBeNull()
    expect(scoreToGrindSetting(104)).toBe('10E')
  })
})

describe('parseGrindUm', () => {
  it('parses micrometres, assumed millimetres and rejects junk', () => {
    expect(parseGrindUm('480')).toEqual({ um: 480, assumedMm: false })
    expect(parseGrindUm('480 µm')).toEqual({ um: 480, assumedMm: false })
    expect(parseGrindUm(480)).toEqual({ um: 480, assumedMm: false })
    const mm = parseGrindUm('0.48')
    expect(mm.um).toBeCloseTo(480, 6)
    expect(mm.assumedMm).toBe(true)
    for (const bad of ['', 'abc', '9000', null, undefined, '12']) {
      expect(parseGrindUm(bad)).toBeNull()
    }
  })
})

describe('points', () => {
  const shots = [
    { id: 's1', avgGrind: '500', grindSetting: '10E', date: '2025-01-01', roaster: 'A', region: 'B' },
    { id: 's2', avgGrind: '', grindSetting: '10E' },
    { id: 's3', avgGrind: '500', grindSetting: '' },
  ]
  it('weights shots 0.5 and photos 1, flags exclusions, skips missing data', () => {
    const runs = [
      { id: 'r1', grindSetting: '12A', mean_um: 600, dv50_um: 580 },
      { id: 'r2', grindSetting: '12B', dv50_um: 590, excluded: true },
      { id: 'r3', grindSetting: 'bad', mean_um: 600 },
    ]
    const points = buildCalibrationPoints(shots, runs, { excludedShotIds: ['s1'] })
    const byId = Object.fromEntries(points.map((p) => [p.id, p]))
    expect(Object.keys(byId).sort()).toEqual(['run:r1:dv50', 'run:r1:mean', 'run:r2:dv50', 'shot:s1'])
    expect(byId['shot:s1']).toMatchObject({ weight: 0.5, source: 'shot', metric: 'mean', excluded: true, coffee: 'A · B' })
    expect(byId['run:r1:mean']).toMatchObject({ weight: 1, source: 'photo', metric: 'mean', excluded: false })
    expect(byId['run:r2:dv50'].excluded).toBe(true)
  })

  it('leaves excluded points out of the fit', () => {
    const points = [0, 20, 40, 60].map((x, i) => ({
      id: `p${i}`, x, um: 300 * Math.exp(0.01 * x), metric: 'mean', source: 'photo', weight: 1, excluded: false,
    }))
    points.push({ id: 'out', x: 30, um: 5000, metric: 'mean', source: 'photo', weight: 1, excluded: true })
    const model = fitCalibration(points)
    expect(model.n).toBe(4)
    expect(model.b).toBeCloseTo(0.01, 6)
  })

  it('only builds dv50 with 3 or more active photo dv50 points', () => {
    const two = [run('a', 90, 500, { dv50_um: 520 }), run('b', 100, 550, { dv50_um: 560 })]
    expect(buildCalibration([], two, []).dv50).toBeNull()
    const three = [...two, run('c', 110, 600, { dv50_um: 610 })]
    const cal = buildCalibration([], three, [])
    expect(cal.dv50).not.toBeNull()
    expect(cal.dv50.metric).toBe('dv50')
    expect(cal.dv50.kind).toBe('curve')
    expect(cal.mean.kind).toBe('curve')
  })
})

describe('fitCalibration', () => {
  const exactRuns = () => [10, 40, 70, 100, 130, 160, 190].map((x) => run(`r${x}`, x, 300 * Math.exp(0.01 * x)))

  it('recovers exact exponential data', () => {
    const { mean } = buildCalibration([], exactRuns(), [])
    expect(mean.ok).toBe(true)
    expect(mean.kind).toBe('curve')
    expect(Math.abs(mean.b - 0.01)).toBeLessThan(1e-6)
    expect(mean.constrained).toBe(false)
    expect(mean.outlierIds).toEqual([])
    expect(mean.rangeFrom).toBe(indexToSetting(10))
    expect(mean.rangeTo).toBe(indexToSetting(190))
  })

  it('is robust to noise and outliers', () => {
    const r = rng(7)
    const runs = []
    for (let i = 0; i < 30; i += 1) {
      const x = Math.round(r() * 250)
      runs.push(run(`n${i}`, x, 300 * Math.exp(0.01 * x + 0.03 * gauss(r))))
    }
    runs.push(run('bad1', 60, 300 * Math.exp(0.6) * 4))
    runs.push(run('bad2', 200, 300 * Math.exp(2) / 4))
    const points = buildCalibrationPoints([], runs)
    const model = fitCalibration(points)
    expect(Math.abs(model.b - 0.01) / 0.01).toBeLessThan(0.05)
    expect(model.outlierIds).toEqual(expect.arrayContaining(['run:bad1:mean', 'run:bad2:mean']))

    const xs = points.map((p) => p.x)
    const ys = points.map((p) => Math.log(p.um))
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length
    const my = ys.reduce((s, v) => s + v, 0) / ys.length
    const olsB = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0)
    expect(Math.abs(model.b - 0.01)).toBeLessThan(Math.abs(olsB - 0.01))
  })

  it('constrains decreasing data to a non-decreasing curve', () => {
    const runs = [10, 50, 90, 130, 170].map((x, i) => run(`d${i}`, x, 800 - i * 100))
    const { mean } = buildCalibration([], runs, [])
    expect(mean.constrained).toBe(true)
    expect(mean.b).toBeGreaterThan(0)
    let prev = 0
    for (let x = 0; x <= MAX_INDEX; x += 10) {
      const um = settingToSize(mean, x).um
      expect(um).toBeGreaterThanOrEqual(prev)
      prev = um
    }
  })

  it('widens the interval and flags extrapolation outside the range', () => {
    const r = rng(3)
    const runs = [20, 50, 80, 110, 140, 170].map((x, i) => run(`w${i}`, x, 300 * Math.exp(0.01 * x + 0.04 * gauss(r))))
    const { mean } = buildCalibration([], runs, [])
    const atMax = settingToSize(mean, mean.xMax)
    const beyond = settingToSize(mean, mean.xMax + 9)
    expect(atMax.extrapolated).toBe(false)
    expect(beyond.extrapolated).toBe(true)
    expect(Math.log(beyond.high / beyond.low)).toBeGreaterThan(Math.log(atMax.high / atMax.low))
    expect(atMax.low).toBeLessThan(atMax.um)
    expect(atMax.high).toBeGreaterThan(atMax.um)
  })

  it('inverts exactly for every setting', () => {
    const { mean } = buildCalibration([], exactRuns(), [])
    for (let i = 0; i <= MAX_INDEX; i += 1) {
      const s = indexToSetting(i)
      expect(sizeToSetting(mean, settingToSize(mean, s).um).setting).toBe(s)
    }
    expect(sizeToSetting(mean, 1e9).index).toBe(MAX_INDEX)
    expect(sizeToSetting(mean, 1e9).extrapolated).toBe(true)
  })

  it('falls back to none / median when there is too little data', () => {
    const none = fitCalibration([])
    expect(none).toMatchObject({ kind: 'none', ok: false, n: 0 })
    expect(settingToSize(none, '10E')).toBeNull()
    expect(sizeToSetting(none, 500)).toBeNull()

    const two = fitCalibration(buildCalibrationPoints([], [run('a', 10, 400), run('b', 50, 600)]))
    expect(two.kind).toBe('median')
    expect(two.ok).toBe(false)
    expect(two.n).toBe(2)
    expect(settingToSize(two, '10E').kind).toBe('median')
    expect(sizeToSetting(two, 500)).toBeNull()

    const same = fitCalibration(buildCalibrationPoints([], [run('a', 10, 400), run('b', 10, 600), run('c', 10, 500)]))
    expect(same.kind).toBe('median')
    expect(same.medianUm).toBe(500)
  })
})
