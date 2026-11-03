// summarize_dataset parity. The datasets are produced by the JS detector (with the Python flatten
// coefficients, so the inputs are identical to Python's) and summarised by JS, then compared key by key.
import { describe, expect, it } from 'vitest'
import { analyzeImageBlue } from '../detect.js'
import { summaryOrNone } from '../summary.js'
import { caseNames, expectSummary, inflateBlue, loadCase, settingsFor } from './fixtureUtils.js'

function summarise(c) {
  const coef = c.expected.flatten.coef
  const res = analyzeImageBlue(inflateBlue(c), c.height, c.width, settingsFor(c),
    { flattenCoefOverride: coef ? Float64Array.from(coef) : undefined })
  return summaryOrNone(res.dataset)
}

describe('summary matches Python', () => {
  for (const name of caseNames('core_')) {
    it(name, () => {
      const c = loadCase(name)
      expectSummary(summarise(c), c.expected.summary, c.expected.tie_sensitive, name)
    })
  }

  it('is deterministic (seeded bootstrap)', () => {
    const c = loadCase('core_modern_02')
    const a = summarise(c)
    const b = summarise(c)
    expect(a).not.toBeNull()
    expect(b).toEqual(a)
    expect(b.dv_ci95).toEqual(a.dv_ci95)
  })
})
