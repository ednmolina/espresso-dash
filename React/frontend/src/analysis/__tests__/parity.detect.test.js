// Exact-tier parity of the detection pipeline against the Python core (legacy settings: global
// background, fixed threshold). Fixtures: parity/export_js_fixtures.py -> core_legacy_*.json.
import { describe, expect, it } from 'vitest'
import { analyzeImageBlue, clusterIndexLayer, legacySettings } from '../detect.js'
import { caseNames, expectClusters, inflateBlue, layerInfo, loadCase, maskInfo, fnvBytes } from './fixtureUtils.js'

describe('legacy detection matches Python exactly', () => {
  for (const name of caseNames('core_legacy_')) {
    it(name, () => {
      const c = loadCase(name)
      const e = c.expected
      const blue = inflateBlue(c)
      expect(fnvBytes(blue)).toBe(c.blue_hash)
      const res = analyzeImageBlue(blue, c.height, c.width, legacySettings(c.settings))

      if (e.polygon_mask === null) expect(res.polygon_mask).toBeNull()
      else expect(maskInfo(res.polygon_mask), 'polygon mask').toEqual(e.polygon_mask)
      expect(fnvBytes(res.blue), 'blue is untouched for the global model').toBe(e.flatten.blue_hash)
      expect(res.background_median, 'background_median').toBe(e.background_median)
      expect(res.threshold_percent_used, 'threshold_percent_used').toBe(e.threshold_percent_used)
      expect(maskInfo(res.threshold_mask), 'threshold mask').toEqual(e.threshold_mask)
      expectClusters(res.dataset, e.clusters, c.width, { label: name })
      const layer = clusterIndexLayer([c.height, c.width], res.dataset)
      expect(layerInfo(layer.index), 'cluster layer').toEqual(e.cluster_layer)
    })
  }
})
