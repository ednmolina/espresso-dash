// Default (modern) settings: poly4 background + half-contrast threshold + edge correction.
// With the Python flatten coefficients injected everything is exact; with JS's own fit the result is
// exact whenever the flattened blue hashes equal, and within a small band otherwise.
import { describe, expect, it } from 'vitest'
import { analyzeImageBlue, clusterIndexLayer } from '../detect.js'
import { summaryOrNone } from '../summary.js'
import { caseNames, expectClusters, fnvBytes, inflateBlue, layerInfo, loadCase, maskInfo, settingsFor } from './fixtureUtils.js'

function expectExact(res, c) {
  const e = c.expected
  if (e.polygon_mask === null) expect(res.polygon_mask).toBeNull()
  else expect(maskInfo(res.polygon_mask), 'polygon mask').toEqual(e.polygon_mask)
  expect(fnvBytes(res.blue), 'flattened blue').toBe(e.flatten.blue_hash)
  expect(res.background_median, 'background_median').toBe(e.background_median)
  expect(res.threshold_percent_used, 'threshold_percent_used').toBe(e.threshold_percent_used)
  expect(res.model_info, 'model_info').toEqual(e.model_info)
  expect(maskInfo(res.threshold_mask), 'threshold mask').toEqual(e.threshold_mask)
  expectClusters(res.dataset, e.clusters, c.width, { label: c.name })
  expect(layerInfo(clusterIndexLayer([c.height, c.width], res.dataset).index), 'cluster layer').toEqual(e.cluster_layer)
}

describe('modern settings with the Python flatten coefficients', () => {
  for (const name of caseNames('core_modern_')) {
    it(`${name}: exact`, () => {
      const c = loadCase(name)
      const coef = c.expected.flatten.coef
      const res = analyzeImageBlue(inflateBlue(c), c.height, c.width, settingsFor(c),
        { flattenCoefOverride: coef ? Float64Array.from(coef) : undefined })
      expectExact(res, c)
    })
  }
})

describe('modern settings with the JS fit', () => {
  for (const name of caseNames('core_modern_')) {
    it(name, () => {
      const c = loadCase(name)
      const e = c.expected
      const res = analyzeImageBlue(inflateBlue(c), c.height, c.width, settingsFor(c))
      if (fnvBytes(res.blue) === e.flatten.blue_hash) {
        expect(res.threshold_percent_used, 'threshold_percent_used').toBe(e.threshold_percent_used)
        expectExact(res, c)
        return
      }
      const n = e.clusters.cluster_id.length
      expect(Math.abs(res.dataset.n - n), `cluster count js=${res.dataset.n} py=${n}`).toBeLessThanOrEqual(Math.max(2, 0.005 * n))
      const js = summaryOrNone(res.dataset)
      if (e.summary === null) expect(js).toBeNull()
      else expect(Math.abs(js.dv50_mm / e.summary.dv50_mm - 1), 'Dv50').toBeLessThanOrEqual(0.005)
    })
  }
})
