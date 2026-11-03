import { describe, expect, it } from 'vitest'
import { buildCalibration, fitCalibration, buildCalibrationPoints, indexToSetting, settingToIndex } from '../grindCalibration'
import {
  CANDIDATE_FEATURES,
  LIMITS,
  buildForecastModel,
  coffeeKey,
  coffeeLabel,
  dataCoverage,
  featurize,
  fitRidge,
  forecast,
  listCoffees,
  resolveUsed,
  runBacktest,
  suggestGrind,
  sweepGrind,
} from '../forecastModel'

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
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
const sd = (a) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)))

const COFFEES = [
  { roaster: 'Onyx', region: 'Huila', variety: 'Caturra' },
  { roaster: 'Onyx', region: 'Gedeo', variety: 'Heirloom' },
  { roaster: 'Tandem', region: 'Kirinyaga', variety: 'SL28' },
]

function day(i) {
  return new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)
}

/** Build shots; spec(i, r) returns overrides. */
function makeShots(n, spec, seed = 1) {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => ({
    id: `s${String(i).padStart(3, '0')}`,
    date: day(i),
    createdAt: `${day(i)}T08:00:00.000Z`,
    ...COFFEES[i % COFFEES.length],
    grindSetting: indexToSetting(60 + Math.floor(r() * 100)),
    avgGrind: '',
    dose: 18,
    yieldGrams: 36,
    ph: null,
    tds: 9,
    extraction: 20,
    rating: 1,
    ...spec(i, r),
  }))
}

function syntheticLinear(n = 200) {
  const r = rng(11)
  const idx = Array.from({ length: n }, () => 60 + Math.floor(r() * 100))
  const ratio = Array.from({ length: n }, () => 1.8 + r() * 0.8)
  const zg = idx.map((v) => (v - mean(idx)) / sd(idx))
  const zr = ratio.map((v) => (v - mean(ratio)) / sd(ratio))
  const shots = makeShots(n, (i) => ({
    grindSetting: indexToSetting(idx[i]),
    yieldGrams: 18 * ratio[i],
    extraction: 20 + 1.5 * zg[i] - 0.8 * zr[i] + 0.2 * gauss(r),
  }))
  return { shots, idx, ratio }
}

const planned = (over = {}) => ({ coffee: coffeeKey(COFFEES[0]), grindSetting: '10E', dose: 18, yieldGrams: 36, ...over })

describe('availability', () => {
  it('is unavailable below 8 shots with extraction', () => {
    for (const n of [0, 1, 7]) {
      const model = buildForecastModel(makeShots(n, () => ({})))
      expect(model.available).toBe(false)
      expect(model.reason).toBe(`Log 8 shots with extraction to unlock forecasts (${n} so far).`)
      expect(forecast(model, planned())).toBeNull()
      expect(model.backtest).toBeNull()
    }
  })

  it('ignores shots without extraction when counting', () => {
    const shots = makeShots(10, (i) => (i < 4 ? { extraction: null } : {}))
    const model = buildForecastModel(shots)
    expect(model.available).toBe(false)
    expect(model.n).toBe(6)
  })

  it('with 8 shots forecasts a point value but no interval', () => {
    const model = buildForecastModel(makeShots(8, (i) => ({ extraction: 19 + (i % 3) })))
    expect(model.available).toBe(true)
    expect(model.backtest).toBeNull()
    expect(model.selected).toEqual([])
    const f = forecast(model, planned())
    expect(Number.isFinite(f.extraction)).toBe(true)
    expect(f.low).toBeNull()
    expect(f.high).toBeNull()
    expect(f.interval).toBeNull()
  })
})

describe('fitting', () => {
  it('fitRidge solves a linear problem and respects priors', () => {
    const Z = [[-1], [0], [1], [2]]
    const y = Z.map(([z]) => 3 + 2 * z)
    const beta = fitRidge(Z, y, { lambda: 1e-9 })
    expect(beta[0]).toBeCloseTo(3, 4)
    expect(beta[1]).toBeCloseTo(2, 4)
    const pulled = fitRidge(Z, y, { lambda: 1e9, prior: [10, 5], penalizeIntercept: true })
    expect(pulled[0]).toBeCloseTo(10, 2)
    expect(pulled[1]).toBeCloseTo(5, 2)
    expect(fitRidge([], [], { lambda: 2, prior: [4, 1], penalizeIntercept: true })).toEqual([4, 1])
  })

  it('selects grind and ratio, recovers coefficients and beats the baseline', () => {
    const { shots, idx, ratio } = syntheticLinear(200)
    const model = buildForecastModel(shots)
    expect(model.available).toBe(true)
    expect(model.grindBasis).toBe('setting')
    expect(model.selected).toEqual(expect.arrayContaining(['grind', 'ratio']))
    expect(model.selected).not.toContain('ph')
    const wantGrind = 1.5 / sd(idx)
    const wantRatio = -0.8 / sd(ratio)
    expect(Math.abs(model.coefficients.grind - wantGrind) / wantGrind).toBeLessThan(0.1)
    expect(Math.abs(model.coefficients.ratio - wantRatio) / Math.abs(wantRatio)).toBeLessThan(0.1)
    expect(model.backtest.evaluated).toBe(192)
    expect(model.backtest.model.mae).toBeLessThan(model.backtest.baseline.mae)
    expect(model.backtest.improvementPct).toBeGreaterThan(30)
    const importance = model.features.filter((f) => f.used).map((f) => f.importance)
    expect(importance.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6)
    expect(model.features.find((f) => f.key === 'time').reason).toBe('not_an_input')
    expect(model.features.map((f) => f.key)).toEqual([...CANDIDATE_FEATURES, 'time', 'tempC'])
  })

  it('only trains on earlier rows during the backtest', () => {
    const { shots } = syntheticLinear(40)
    const shuffled = [...shots].reverse()
    const model = buildForecastModel(shuffled)
    const calls = []
    const bt = runBacktest(model._rows, model.selected, { onFit: (train, test) => calls.push([train, test]) })
    expect(calls).toHaveLength(bt.evaluated)
    expect(calls[0][1]).toBe(LIMITS.BACKTEST_MIN_TRAIN)
    calls.forEach(([train, test]) => {
      expect(train.length).toBeGreaterThanOrEqual(1)
      expect(Math.max(...train)).toBeLessThan(test)
    })
    expect(model._rows.map((r) => r.date)).toEqual([...model._rows.map((r) => r.date)].sort())
  })

  it('matches a hand-computed running-mean baseline', () => {
    const shots = makeShots(12, (i) => ({ extraction: 18 + ((i * 7) % 5) }))
    const model = buildForecastModel(shots)
    const ys = model._rows.map((r) => r.extraction)
    let total = 0
    for (let i = 8; i < 12; i += 1) total += Math.abs(ys[i] - mean(ys.slice(0, i)))
    const bt = runBacktest(model._rows, [])
    expect(bt.evaluated).toBe(4)
    expect(bt.baseline.mae).toBeCloseTo(total / 4, 10)
    // below 5 evaluated shots the model builder reports no accuracy at all
    expect(model.backtest).toBeNull()
    const thirteen = buildForecastModel(makeShots(13, (i) => ({ extraction: 18 + ((i * 7) % 5) })))
    expect(thirteen.backtest.evaluated).toBe(5)
  })

  it('is deterministic', () => {
    const { shots } = syntheticLinear(60)
    const a = buildForecastModel(shots)
    const b = buildForecastModel(shots.map((s) => ({ ...s })))
    expect(a).not.toBe(b)
    expect(JSON.stringify([a.selected, a.coefficients, a.backtest, a.features]))
      .toBe(JSON.stringify([b.selected, b.coefficients, b.backtest, b.features]))
    expect(buildForecastModel(shots)).toBe(a)
  })
})

describe('missing pH', () => {
  it('never uses pH when no shot has it, even if one is planned', () => {
    const { shots } = syntheticLinear(40)
    const model = buildForecastModel(shots)
    const ph = model.features.find((f) => f.key === 'ph')
    expect(ph).toMatchObject({ used: false, count: 0, reason: 'too_few' })
    expect(ph.detail).toBe('pH: 0 shots have it, needs 8')
    const f = forecast(model, planned({ ph: 5.2 }))
    expect(f.featuresUsed).not.toContain('ph')
    expect(f.extraction).toBeCloseTo(forecast(model, planned()).extraction, 12)
  })

  it('uses pH where recorded and skips it when the plan has none', () => {
    const r = rng(5)
    const shots = makeShots(60, (i) => {
      const latent = 5.0 + r() * 0.8
      return {
        ph: i % 3 === 0 ? null : Math.round(latent * 100) / 100,
        extraction: 20 + 6 * (latent - 5.4) + 0.1 * gauss(r),
      }
    })
    expect(featurize(shots[0], {}).ph).toBeNull()
    expect(featurize(shots[1], {}).ph).toBe(shots[1].ph)
    const model = buildForecastModel(shots)
    expect(model.selected).toContain('ph')
    const without = forecast(model, planned())
    expect(without.featuresUsed).not.toContain('ph')
    expect(without.featuresSkipped).toContainEqual({ key: 'ph', reason: 'not_entered' })
    const withPh = forecast(model, planned({ ph: 5.7 }))
    expect(withPh.featuresUsed).toContain('ph')
    expect(withPh.extraction).toBeGreaterThan(forecast(model, planned({ ph: 5.1 })).extraction)
  })

  it('counts exactly 5.2 as the old default', () => {
    const phs = [5.2, 5.2, 5.21, 5.19, 5.0, null, undefined, 52]
    const shots = makeShots(phs.length, (i) => ({ ph: phs[i] }))
    const cov = dataCoverage(shots)
    expect(cov.ph52.count).toBe(2)
    expect(cov.ph52.ids).toEqual(['s000', 's001'])
    expect(cov.ph52.dates).toEqual([day(0), day(1)])
    expect(cov.ph.count).toBe(6)
    expect(cov.total).toBe(8)
  })
})

describe('grind basis and calibration', () => {
  it('uses setting without a calibration and micrometres with one', () => {
    const r = rng(9)
    const shots = makeShots(30, () => ({ extraction: 20 + 0.1 * gauss(r) }))
    expect(buildForecastModel(shots).grindBasis).toBe('setting')

    const runs = [40, 80, 120, 160, 200].map((x, i) => ({ id: `r${i}`, grindSetting: indexToSetting(x), mean_um: 300 * Math.exp(0.01 * x) }))
    const cal = buildCalibration(shots, runs, [])
    expect(cal.mean.ok).toBe(true)
    const model = buildForecastModel(shots, { calibration: { mean: cal.mean } })
    expect(model.grindBasis).toBe('um')
    expect(buildForecastModel(shots, { calibration: { mean: cal.mean } })).toBe(model)
    const row = featurize(shots[0], { calibration: { mean: cal.mean } })
    expect(row.grind).toBeCloseTo(Math.log(300) + 0.01 * settingToIndex(shots[0].grindSetting), 6)
    const measured = featurize({ ...shots[0], avgGrind: '500' }, { calibration: { mean: cal.mean } })
    expect(measured.grind).toBeCloseTo(Math.log(500), 10)
    const notOk = fitCalibration(buildCalibrationPoints([], runs.slice(0, 2)))
    expect(buildForecastModel(shots, { calibration: { mean: notOk } }).grindBasis).toBe('setting')
    expect(forecast(model, planned()).grindUm.um).toBeGreaterThan(0)
  })
})

describe('intervals and probabilities', () => {
  it('uses residual quantiles with 10+ residuals and widens when extrapolating', () => {
    const { shots } = syntheticLinear(60)
    const model = buildForecastModel(shots)
    const q = model.backtest.residualQuantiles
    expect(q).not.toBeNull()
    const inside = forecast(model, planned({ grindSetting: '10E' }))
    expect(inside.interval).toBe('quantile')
    expect(inside.extrapolated).toBe(false)
    expect(inside.low).toBeCloseTo(inside.extraction + Math.min(0, q.q10), 10)
    expect(inside.high).toBeCloseTo(inside.extraction + Math.max(0, q.q90), 10)
    const outside = forecast(model, planned({ grindSetting: indexToSetting(160 + 18) }))
    expect(outside.extrapolated).toBe(true)
    expect(outside.high - outside.low).toBeGreaterThan(inside.high - inside.low)
  })

  it('falls back to RMSE for 5-9 residuals', () => {
    const { shots } = syntheticLinear(16)
    const model = buildForecastModel(shots)
    expect(model.backtest.evaluated).toBe(8)
    const f = forecast(model, planned())
    expect(f.interval).toBe('rmse')
    expect(f.extraction - f.low).toBeCloseTo(1.2816 * model.backtest.model.rmse, 10)
  })

  it('returns probabilities that sum to 1 and follow the history', () => {
    const { shots } = syntheticLinear(40)
    const f = forecast(buildForecastModel(shots), planned())
    const { bad, good, great } = f.probabilities
    expect(bad + good + great).toBeCloseTo(1, 12)

    const allGreat = buildForecastModel(makeShots(20, () => ({ rating: 2 })))
    const g = forecast(allGreat, planned())
    expect(g.ratingLabel).toBe('Great')
    expect(g.probabilities.great).toBeGreaterThan(g.probabilities.good)
    expect(g.probabilities.great).toBeGreaterThan(g.probabilities.bad)
    expect(allGreat.backtest.rating.evaluated).toBe(12)
  })
})

describe('sweep and suggestion', () => {
  it('sweeps 13 settings and suggests the setting closest to 20%', () => {
    const r = rng(21)
    const shots = makeShots(80, () => ({}))
    shots.forEach((s) => {
      const idx = settingToIndex(s.grindSetting)
      s.extraction = 23 - 0.05 * (idx - 60) + 0.1 * gauss(r) // finer grind extracts more
    })
    const model = buildForecastModel(shots)
    expect(model.selected).toContain('grind')
    const p = planned({ grindSetting: indexToSetting(70) })
    const sweep = sweepGrind(model, p)
    expect(sweep).toHaveLength(13)
    expect(sweep[0].index).toBe(64)
    expect(sweep[12].index).toBe(76)
    expect(sweep[0].extraction).toBeGreaterThan(sweep[12].extraction)
    sweep.forEach((row) => expect(row.bad + row.good + row.great).toBeCloseTo(1, 10))
    const suggestion = suggestGrind(model, p)
    const here = forecast(model, p).extraction
    expect(Math.abs(suggestion.extraction - 20)).toBeLessThanOrEqual(Math.abs(here - 20))
    expect(suggestion.setting).toBe(indexToSetting(suggestion.index))
    expect(Math.abs(suggestion.index - 70)).toBeLessThanOrEqual(27)
  })

  it('suggests nothing when grind is not an input', () => {
    const model = buildForecastModel(makeShots(20, () => ({})))
    expect(suggestGrind(model, planned())).toBeNull()
    expect(sweepGrind(buildForecastModel([]), planned())).toEqual([])
  })
})

describe('helpers', () => {
  it('builds coffee keys, labels and lists', () => {
    expect(coffeeKey({ roaster: ' Onyx ', region: 'HUILA', variety: '' })).toBe('onyx|huila|')
    expect(coffeeLabel({ roaster: 'Onyx', region: '', variety: 'SL28' })).toBe('Onyx · SL28')
    expect(coffeeLabel({})).toBe('Unknown coffee')
    const list = listCoffees(makeShots(7, () => ({})))
    expect(list).toHaveLength(3)
    expect(list[0].lastDate >= list[1].lastDate).toBe(true)
    expect(list.reduce((s, c) => s + c.shots, 0)).toBe(7)
    expect(list[0].last.id).toBeTruthy()
  })

  it('reports data coverage including estimated grinds', () => {
    const shots = makeShots(5, (i) => ({
      avgGrind: i === 0 ? '480' : '',
      grindSetting: i === 4 ? '' : '10E',
      tds: i < 2 ? 9 : null,
      yieldGrams: i === 1 ? null : 36,
    }))
    const runs = [40, 80, 120].map((x, i) => ({ id: `r${i}`, grindSetting: indexToSetting(x), mean_um: 300 * Math.exp(0.01 * x) }))
    const cal = buildCalibration(shots, runs, [])
    const cov = dataCoverage(shots, { calibration: cal })
    expect(cov).toMatchObject({ total: 5, withExtraction: 5, grindMeasured: 1, grindEstimated: 3, tds: 2, doseYield: 4 })
    expect(dataCoverage(shots).grindEstimated).toBe(0)
  })
})

describe('out-of-sample reporting', () => {
  const noisy = (n, seed) => {
    const r = rng(seed)
    return makeShots(n, (i) => ({
      ph: i % 2 ? 5 + Math.round(r() * 80) / 100 : null,
      extraction: 20 + gauss(r),
    }), seed)
  }

  it('re-selects features per fold from earlier rows only', () => {
    const model = buildForecastModel(syntheticLinear(60).shots)
    const folds = []
    const bt = runBacktest(model._btRows, null, { nested: true, onSelect: (seen, test) => folds.push([seen, test]) })
    expect(folds).toHaveLength(bt.evaluated)
    folds.forEach(([seen, test]) => {
      expect(Math.max(...seen)).toBeLessThan(test)
      expect(seen).toHaveLength(test)
    })
    expect(bt.points.map((p) => p.selected)).toHaveLength(bt.evaluated)
  })

  it('a fold never changes when row i or later is altered', () => {
    const { shots } = syntheticLinear(60)
    const k = 35
    const altered = shots.map((s, i) => (i >= k ? { ...s, extraction: s.extraction + 50 * (i % 2 ? 1 : -1), ph: 5.5, rating: 2 } : s))
    const a = runBacktest(buildForecastModel(shots)._btRows, null, { nested: true })
    const b = runBacktest(buildForecastModel(altered)._btRows, null, { nested: true })
    const upTo = a.points.filter((p) => p.order <= k)
    expect(upTo.length).toBeGreaterThan(10)
    upTo.forEach((p, i) => {
      expect(b.points[i].predicted).toBe(p.predicted)
      expect(b.points[i].selected).toEqual(p.selected)
    })
    expect(b.points.find((p) => p.order === k + 5).predicted).not.toBe(a.points.find((p) => p.order === k + 5).predicted)
  })

  it('does not look better than a fixed-set backtest on pure noise', () => {
    const model = buildForecastModel(noisy(80, 3))
    const fixed = runBacktest(model._btRows, model.selected)
    expect(model.backtest.model.mae).toBeGreaterThanOrEqual(fixed.model.mae - 1e-9)
    // noise cannot beat the plain running mean by a wide margin once selection is nested
    expect(model.backtest.improvementPct).toBeLessThan(10)
  })

  it('builds 200 shots in under 200ms', () => {
    const { shots } = syntheticLinear(200)
    const t0 = performance.now()
    const model = buildForecastModel(shots)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(model.backtest.evaluated).toBe(192)
  })

  it('scores grind on the setting index so a calibration cannot leak into the backtest', () => {
    const { shots } = syntheticLinear(40)
    const runs = [40, 80, 120, 160, 200].map((x, i) => ({ id: `r${i}`, grindSetting: indexToSetting(x), mean_um: 300 * Math.exp(0.01 * x) }))
    const runs2 = runs.map((r, i) => ({ ...r, mean_um: r.mean_um * (i % 2 ? 1.4 : 0.8) }))
    const calA = { mean: buildCalibration(shots, runs, []).mean }
    const calB = { mean: buildCalibration(shots, runs2, []).mean }
    const a = buildForecastModel(shots, { calibration: calA })
    const b = buildForecastModel(shots, { calibration: calB })
    expect(a.grindBasis).toBe('um')
    expect(a._rows.some((r) => r.grind !== r.grindIndex)).toBe(true)
    expect(a._btRows.every((r) => r.grind === r.grindIndex)).toBe(true)
    expect(JSON.stringify(a.backtest)).toBe(JSON.stringify(b.backtest))
    expect(JSON.stringify(a.backtest)).toBe(JSON.stringify(buildForecastModel(shots).backtest))
  })
})

describe('interval with missing inputs', () => {
  it('is at least as wide as the full-input interval and says why', () => {
    const r = rng(5)
    const shots = makeShots(80, (i) => {
      const latent = 5.0 + r() * 0.8
      return { ph: Math.round(latent * 100) / 100, extraction: 20 + 6 * (latent - 5.4) + 0.1 * gauss(r) }
    })
    const model = buildForecastModel(shots)
    expect(model.selected).toContain('ph')
    const full = forecast(model, planned({ ph: 5.4 }))
    const reduced = forecast(model, planned())
    expect(full.intervalReduced).toBeNull()
    expect(reduced.intervalReduced).toEqual(['ph'])
    expect(reduced.featuresSkipped).toContainEqual({ key: 'ph', reason: 'not_entered' })
    expect(reduced.high - reduced.low).toBeGreaterThanOrEqual(full.high - full.low)
    // without pH the model misses by roughly the pH signal, so the range must grow a lot
    expect(reduced.high - reduced.low).toBeGreaterThan(3 * (full.high - full.low))
  })

  it('also widens the RMSE interval', () => {
    const r = rng(8)
    const shots = makeShots(16, () => ({}))
    shots.forEach((s) => { s.ph = 5 + r(); s.extraction = 20 + 6 * (s.ph - 5.5) })
    const model = buildForecastModel(shots)
    expect(model.backtest.evaluated).toBe(8)
    const reduced = forecast(model, planned())
    const full = forecast(model, planned({ ph: 5.5 }))
    expect(model.selected).toContain('ph')
    expect(reduced.interval).toBe('rmse')
    expect(reduced.intervalReduced).toEqual(['ph'])
    expect(reduced.high - reduced.low).toBeGreaterThanOrEqual(full.high - full.low)
  })
})

describe('unrated shots', () => {
  it('stay out of rating probabilities, priors and calibration', () => {
    const shots = makeShots(30, (i) => (i < 12 ? { rating: 0, rated: false } : { rating: 2, rated: true }))
    const model = buildForecastModel(shots)
    expect(model.ratingPrior).toEqual({ bad: 0, good: 0, great: 1 })
    const f = forecast(model, planned())
    expect(f.ratingLabel).toBe('Great')
    expect(f.probabilities.bad).toBeLessThan(0.01)
    // rows 8..29 are evaluated; only the 18 rated ones count for rating metrics
    expect(model.backtest.evaluated).toBe(22)
    expect(model.backtest.rating.evaluated).toBe(18)
    expect(model.backtest.rating.calibration.reduce((s, b) => s + b.count, 0)).toBe(18)
  })

  it('treats shots without a rated flag as rated and copes with none rated', () => {
    const model = buildForecastModel(makeShots(20, () => ({ rating: 0 })))
    expect(model.ratingPrior.bad).toBe(1)
    const none = buildForecastModel(makeShots(20, () => ({ rating: 0, rated: false })))
    expect(none.backtest.rating).toEqual({ evaluated: 0, balancedAccuracy: null, brier: null, calibration: [] })
    const p = forecast(none, planned()).probabilities
    expect(p.bad + p.good + p.great).toBeCloseTo(1, 10)
    expect(p.bad).toBeCloseTo(p.great, 10)
  })
})

describe('resolveUsed', () => {
  it('drops the sparsest input, not the last one listed', () => {
    const train = Array.from({ length: 30 }, (_, i) => ({
      a: i, b: i < 5 ? i : null, c: i,
    }))
    const target = { a: 1, b: 1, c: 1 }
    // b is first in the list, so dropping "the last" would remove c instead
    const { used, rowsOk } = resolveUsed(train, ['b', 'a', 'c'], target)
    expect(used).toEqual(['a', 'c'])
    expect(rowsOk).toHaveLength(30)
  })
})
