// Lanczos downscale (resample.js) vs Pillow's Image.resize(LANCZOS) on blue-only L images.
import { describe, expect, it } from 'vitest'
import { resizeLanczosU8 } from '../resample.js'
import { caseNames, inflateBytes, loadCase } from './fixtureUtils.js'

describe('resizeLanczosU8 matches Pillow', () => {
  for (const name of caseNames('resize_')) {
    it(name, () => {
      const c = loadCase(name)
      const src = inflateBytes(c.src_b64z)
      const want = inflateBytes(c.expected_b64z)
      expect(src.length).toBe(c.src_width * c.src_height)
      expect(want.length).toBe(c.width * c.height)
      const got = resizeLanczosU8(src, c.src_width, c.src_height, c.width, c.height)
      expect(got.length).toBe(want.length)
      let diff = 0
      let maxd = 0
      for (let i = 0; i < want.length; i++) {
        const d = Math.abs(got[i] - want[i])
        if (d) diff++
        if (d > maxd) maxd = d
      }
      // Target is bit-exact; Math.sin may differ from libm by an ulp, so allow |d| <= 1 on <= 0.01% of pixels.
      if (diff) console.warn(`${name}: ${diff}/${want.length} pixels differ from Pillow (max |d| ${maxd})`)
      expect(maxd, 'max |diff|').toBeLessThanOrEqual(1)
      expect(diff / want.length, `${diff} pixels differ`).toBeLessThanOrEqual(1e-4)
    })
  }
})
