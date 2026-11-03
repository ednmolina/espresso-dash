// Regression: log-spaced bin edges are 10 ** linspace(log10(xmin), log10(xmax)), and
// 10 ** log10(x) is not always exactly x (libm / JS engine dependent). If the last edge lands
// just below xmax (or the first just above xmin) the extreme particle falls outside every bin and
// the fractions no longer sum to 1. buildBins must pin the end edges to xmin / xmax exactly.
import { describe, it, expect } from 'vitest'
import { buildBins } from '../histogram.js'
import { histogramEdges, log10Accurate } from '../np.js'

// Found by brute force: Math.pow(10, log10Accurate(x)) < x on V8 (the raw edge would miss x).
const ROUNDS_DOWN = [89.785237, 82.268304, 1288.062909, 1824.557552, 1539.3605070043973]
// ... and > x (the raw first edge would sit above xmin).
const ROUNDS_UP = [269.300255, 1119.280246, 1212.395228, 1577.728311]

const sum = a => Array.from(a).reduce((s, v) => s + v, 0)

function fractionsSum(xmin, xmax, xLog, bins) {
  const edges = buildBins(xmin, xmax, xLog, bins)
  const values = Float64Array.from([xmin, xmax, (xmin + xmax) / 2, xmin * 1.01 + 0.01 * xmax])
  const weights = new Float64Array(values.length).fill(1 / values.length)
  return { edges, total: sum(histogramEdges(values, weights, edges)) }
}

describe('buildBins end edges', () => {
  for (const bins of [null, 10, 37]) {
    it(`log edges: first === xmin, last === xmax (bins=${bins})`, () => {
      for (const x of [...ROUNDS_DOWN, ...ROUNDS_UP]) {
        const lo = 0.05
        const e1 = buildBins(lo, x, true, bins)
        expect(e1[0]).toBe(lo)
        expect(e1[e1.length - 1]).toBe(x)
        const e2 = buildBins(x / 7, x, true, bins)
        expect(e2[0]).toBe(x / 7)
        expect(e2[e2.length - 1]).toBe(x)
        // smallest value that rounds the wrong way as xmin
        const e3 = buildBins(x, x * 3, true, bins)
        expect(e3[0]).toBe(x)
        expect(e3[e3.length - 1]).toBe(x * 3)
      }
    })

    it(`linear edges: first === xmin, last === xmax (bins=${bins})`, () => {
      for (const x of ROUNDS_DOWN) {
        const e = buildBins(0.3, x, false, bins)
        expect(e[0]).toBe(0.3)
        expect(e[e.length - 1]).toBe(x)
      }
    })
  }

  it('edges stay strictly increasing', () => {
    for (const x of [...ROUNDS_DOWN, ...ROUNDS_UP]) {
      const e = buildBins(x / 50, x, true, null)
      for (let i = 1; i < e.length; i++) expect(e[i]).toBeGreaterThan(e[i - 1])
    }
  })

  it('fractions sum to 1 including the min and max values (log and linear)', () => {
    for (const x of [...ROUNDS_DOWN, ...ROUNDS_UP]) {
      for (const xLog of [true, false]) {
        const { edges, total } = fractionsSum(x / 20, x, xLog, null)
        expect(edges[edges.length - 1]).toBe(x)
        expect(Math.abs(total - 1)).toBeLessThan(1e-12)
        const r = fractionsSum(x, x * 4, xLog, 25)
        expect(Math.abs(r.total - 1)).toBeLessThan(1e-12)
      }
    }
  })
})
