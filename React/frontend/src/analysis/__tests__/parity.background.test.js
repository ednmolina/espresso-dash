// poly4 illumination flattening vs Python. With the Python coefficients injected the whole float32
// chain must be bit-exact; without them only the fit itself (normal equations) may differ.
import { describe, expect, it } from 'vitest'
import { flattenBlue } from '../background.js'
import { buildPolygonMask } from '../detect.js'
import { approx, caseNames, fnvBytes, inflateBlue, loadCase, settingsFor } from './fixtureUtils.js'

const N_FIT_SLACK = 1

const flattenCases = caseNames('core_').filter((n) => {
  return settingsFor(loadCase(n)).background_model === 'poly4'
})

function run(c, coefOverride) {
  const s = settingsFor(c)
  const blue = inflateBlue(c)
  const pm = buildPolygonMask([c.height, c.width], s.analysis_polygon)
  return { blue, ...flattenBlue(blue, c.height, c.width, pm, s.threshold_percent, coefOverride ? { coefOverride } : {}) }
}

describe('flattenBlue', () => {
  it('covers the poly4 fixtures', () => {
    expect(flattenCases.length).toBeGreaterThanOrEqual(6)
  })

  for (const name of flattenCases) {
    const c = loadCase(name)
    const f = c.expected.flatten

    it(`${name}: bit-exact with the Python coefficients`, () => {
      const out = run(c, f.coef ? Float64Array.from(f.coef) : null)
      expect(out.info.applied).toBe(f.applied)
      expect(fnvBytes(out.blue), 'flattened blue hash').toBe(f.blue_hash)
      if (f.applied) {
        expect(out.info.reference_level, 'reference_level').toBe(f.reference_level)
        // n_fit_points counts |resid| < 3*sigma with resid = z - A@coef. numpy computes A@coef with BLAS gemv
        // (FMA, vectorised accumulation), JS with a plain loop, so one borderline point can land on the other
        // side of the cut-off. It is informational only (the flattened blue above is bit-exact), hence +-1.
        expect(Math.abs(out.info.n_fit_points - f.n_fit_points), `n_fit_points js=${out.info.n_fit_points} py=${f.n_fit_points}`)
          .toBeLessThanOrEqual(N_FIT_SLACK)
      }
    })

    it(`${name}: own fit agrees with numpy`, () => {
      const out = run(c, null)
      expect(out.info.applied).toBe(f.applied)
      if (!f.applied) {
        expect(fnvBytes(out.blue)).toBe(f.blue_hash)
        return
      }
      expect(out.info.coef.length).toBe(15)
      const bad = f.coef.findIndex((v, i) => !approx(out.info.coef[i], v, 1e-8, 1e-10))
      expect(bad, `coef[${bad}] js=${out.info.coef[bad]} py=${f.coef[bad]}`).toBe(-1)
      // pixels: >= 99.99% identical, |diff| <= 1
      // The fixture stores only the hash of Python's flattened blue; the override path reproduces it
      // bit-exactly (previous test), so it serves as the pixel reference here.
      const ref = run(c, Float64Array.from(f.coef)).blue
      let diff = 0
      let maxd = 0
      for (let i = 0; i < ref.length; i++) {
        const d = Math.abs(ref[i] - out.blue[i])
        if (d) diff++
        if (d > maxd) maxd = d
      }
      expect(maxd, 'max |diff|').toBeLessThanOrEqual(1)
      expect(diff / ref.length, `${diff} of ${ref.length} pixels differ`).toBeLessThanOrEqual(1e-4)
    })
  }
})
