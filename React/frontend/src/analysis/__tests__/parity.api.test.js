// Replays the recorded /analyze, /erase, /histogram and /histogram/compare requests of the Python API
// against the inline engine and compares the responses. Analyses at scale < 1 also pass through
// resample.js: if a failure here goes away when parity.resize.test.js passes, the resize is the cause.
import { describe, expect, it } from 'vitest'
import { createEngine } from '../engine.js'
import { approx, caseNames, expectClose, expectSummary, fnvBytes, inflateBlue, layerInfo, loadCase } from './fixtureUtils.js'

const STAT_RTOL = 1e-9

/** Replace "$image" / "$step:K" placeholders by the real ids. */
function resolve(body, imageId, ids) {
  return JSON.parse(JSON.stringify(body), (k, v) => {
    if (k !== 'image_id' || typeof v !== 'string') return v
    if (v === '$image') return imageId
    const m = /^\$step:(\d+)$/.exec(v)
    if (!m) throw new Error(`bad placeholder ${v}`)
    return ids[Number(m[1])]
  })
}

function expectLayer(layer, want, label) {
  expect(layer && layer.index, `${label}: IndexLayer`).toBeTruthy()
  expect(layerInfo(layer.index), label).toEqual(want)
}

/** Per-bin fractions: 1e-12 everywhere, except <= 2 bins where one particle sits on the other side of an edge. */
function expectFractions(js, py, label) {
  expect(js.length, `${label} bins`).toBe(py.length)
  const off = []
  for (let b = 0; b < py.length; b++) {
    const d = Math.abs(js[b] - py[b])
    if (d > 1e-12) off.push({ b, d, cap: Math.max(js[b], py[b]) })
  }
  expect(off.length, `${label}: ${off.length} bins differ: ${JSON.stringify(off)}`).toBeLessThanOrEqual(2)
  // A particle moving across an edge changes a bin by that particle's fraction, which cannot exceed the
  // bin it leaves (the larger of the two values).
  for (const o of off) expect(o.d, `${label} bin ${o.b}`).toBeLessThanOrEqual(o.cap)
}

function expectSeries(js, py, label) {
  expect(js.x_log, `${label} x_log`).toBe(py.x_log)
  expect(js.edges.length, `${label} edges`).toBe(py.edges.length)
  const bad = py.edges.findIndex((e, i) => !approx(js.edges[i], e, 1e-12))
  expect(bad, `${label} edge ${bad}: js=${js.edges[bad]} py=${py.edges[bad]}`).toBe(-1)
  expect(js.series.length).toBe(py.series.length)
  py.series.forEach((s, i) => {
    expect(js.series[i].label, `${label} series[${i}].label`).toBe(s.label)
    expectFractions(js.series[i].fractions, s.fractions, `${label} series[${i}]`)
  })
}

function expectHistogram(js, py, label) {
  const { series, histogram_b64: _ignored, ...jsRest } = js
  const { series: pySeries, ...pyRest } = py
  expect(Object.keys(jsRest).sort(), `${label} keys`).toEqual(Object.keys(pyRest).sort())
  expectSeries(series, pySeries, `${label} series`)
  for (const k of ['unit', 'axis_label', 'scale']) expect(js[k], `${label} ${k}`).toBe(py[k])
  const { unit, axis_label, scale, ...stats } = pyRest
  expectClose(Object.fromEntries(Object.keys(stats).map((k) => [k, jsRest[k]])), stats, { rtol: STAT_RTOL, label })
}

function expectCompare(js, py, label) {
  const { series, histogram_b64: _ignored, per_run, combined, min_diameter_um_applied, ...jsRest } = js
  expect(Object.keys(js).filter((k) => k !== 'histogram_b64').sort(), `${label} keys`).toEqual(Object.keys(py).sort())
  expectSeries(series, py.series, `${label} series`)
  for (const k of ['unit', 'axis_label', 'scale']) expect(jsRest[k], `${label} ${k}`).toBe(py[k])
  expect(min_diameter_um_applied, `${label} min_diameter_um_applied`).toBe(py.min_diameter_um_applied)
  expectClose(per_run, py.per_run, { rtol: STAT_RTOL, label: `${label} per_run`, exactKeys: ['label'] })
  expectClose(combined, py.combined, { rtol: STAT_RTOL, label: `${label} combined` })
}

function expectAnalyze(js, py, label) {
  for (const k of ['nclusters', 'analysis_scale', 'width', 'height']) expect(js[k], `${label} ${k}`).toBe(py[k])
  expect(approx(js.background_median, py.background_median, 1e-9), `${label} background_median js=${js.background_median} py=${py.background_median}`).toBe(true)
  expect(approx(js.pixel_scale, py.pixel_scale, 1e-12), `${label} pixel_scale`).toBe(true)
  expect(js.particles.id, `${label} particle ids`).toEqual(py.particles.id)
  for (const k of ['surface', 'roundness', 'short_axis', 'long_axis', 'volume']) {
    expect(js.particles[k].length).toBe(py.particles[k].length)
    const bad = py.particles[k].findIndex((v, i) => !approx(js.particles[k][i], v, 2e-6))
    expect(bad, `${label} particles.${k}[${bad}] js=${js.particles[k][bad]} py=${py.particles[k][bad]}`).toBe(-1)
  }
  expectLayer(js.threshold_layer, py.threshold_layer, `${label} threshold_layer`)
  expectLayer(js.cluster_layer, py.cluster_layer, `${label} cluster_layer`)
  // summary tie flags are not recorded for API cases; ties can only loosen the dv/median keys, so use 1e-6 on them
  expectSummary(js.summary, py.summary, { dv: true, number: true }, label)
}

describe('API replay matches the Python server', () => {
  for (const name of caseNames('api_')) {
    it(name, () => {
      const c = loadCase(name)
      const engine = createEngine()
      const reg = engine.registerImage({ width: c.width, height: c.height, blue: inflateBlue(c) })
      expect(fnvBytes(inflateBlue(c))).toBe(c.blue_hash)
      expect(reg.width).toBe(c.upload.width)
      expect(reg.height).toBe(c.upload.height)
      expect(reg.reference_objects).toEqual(c.upload.reference_objects)

      const ids = {}
      c.steps.forEach((step, i) => {
        const label = `${name} step ${i} (${step.op})`
        const body = resolve(step.body, reg.image_id, ids)
        const call = () => {
          switch (step.op) {
            case 'analyze': return engine.analyze(body, {})
            case 'erase': return engine.erase(body)
            case 'histogram': return engine.histogram(body)
            case 'compare': return engine.compare(body)
            default: throw new Error(`unknown op ${step.op}`)
          }
        }
        if (step.expect) {
          let err = null
          try { call() } catch (e) { err = e }
          expect(err, `${label} should fail`).not.toBeNull()
          expect(err.status, `${label} status`).toBe(step.expect.status)
          expect(err.message, `${label} detail`).toBe(step.expect.detail)
          return
        }
        const js = call()
        const py = step.response
        if (step.op === 'analyze') {
          ids[i] = js.analysis_id
          expectAnalyze(js, py, label)
        } else if (step.op === 'erase') {
          expect(js.removed_ids, `${label} removed_ids`).toEqual(py.removed_ids)
          expect(js.nclusters, `${label} nclusters`).toBe(py.nclusters)
          expectLayer(js.cluster_layer, py.cluster_layer, `${label} cluster_layer`)
          expectSummary(js.summary, py.summary, { dv: true, number: true }, label)
        } else if (step.op === 'histogram') {
          expectHistogram(js, py, label)
        } else {
          expectCompare(js, py, label)
        }
      })
    })
  }
})
