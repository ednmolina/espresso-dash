// Exact parity of the ellipse fit (feature A) against the numpy reference.
// Fixtures: parity/export_ellipse_fixtures.py -> __fixtures_ellipse__/ellipse_*.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzeImageBlue, legacySettings } from '../detect.js'
import { shapeSummaryOrNone } from '../summary.js'
import { fnvBytes, inflateBlue, approx, firstMismatch } from './fixtureUtils.js'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures_ellipse__')
const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json').map((f) => f.slice(0, -5)).sort()
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'))

const exactColumn = (label, got, want) => {
  expect(got.length, `${label} length`).toBe(want.length)
  const i = firstMismatch(got, want)
  expect(i, i >= 0 ? `${label}[${i}]: ${got[i]} !== ${want[i]}` : label).toBe(-1)
}

describe('ellipse fit matches the numpy reference exactly', () => {
  it('has the six committed cases', () => {
    expect(names).toHaveLength(6)
  })
  for (const name of names) {
    it(name, () => {
      const c = load(name)
      const e = c.expected
      const blue = inflateBlue(c)
      expect(fnvBytes(blue)).toBe(c.blue_hash)

      const ds = analyzeImageBlue(blue, c.height, c.width, legacySettings({ ...c.settings })).dataset
      expect(Array.from(ds.cluster_id)).toEqual(e.cluster_id)
      exactColumn('major_axis_measured', ds.major_axis_measured, e.major)
      exactColumn('minor_axis_measured', ds.minor_axis_measured, e.minor)
      exactColumn('aspect_ratio', ds.aspect_ratio, e.aspect)
      exactColumn('long_axis', ds.long_axis, e.long_axis)
      if (c.settings.axis_method === 'moments') exactColumn('long_axis == major', ds.long_axis, e.major)

      const shape = shapeSummaryOrNone(ds)
      const want = e.shape_summary
      expect(Object.keys(shape)).toEqual(Object.keys(want))
      expect(shape.aspect_ratio_n).toBe(want.aspect_ratio_n)
      expect(shape.min_px).toBe(want.min_px)
      for (const k of ['aspect_ratio_median', 'aspect_ratio_p10', 'aspect_ratio_p90']) {
        if (want[k] === null) expect(shape[k], k).toBeNull()
        else expect(approx(shape[k], want[k], 1e-12), `${k}: ${shape[k]} vs ${want[k]}`).toBe(true)
      }

      const ell = analyzeImageBlue(blue, c.height, c.width,
        legacySettings({ ...c.settings, volume_model: 'ellipsoid' })).dataset
      exactColumn('volume (ellipsoid)', ell.volume, e.volume_ellipsoid)
      // the measured axes do not depend on the volume model
      exactColumn('aspect_ratio (ellipsoid run)', ell.aspect_ratio, e.aspect)
    })
  }
})
