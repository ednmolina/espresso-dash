// Exact parity of the touching-particle split (feature B) against the Python reference.
// Fixtures: parity/export_split_fixtures.py -> __fixtures_split__/split_*.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzeImageBlue, legacySettings } from '../detect.js'
import { clusterSolidity, SPLIT_MIN_PX, SPLIT_SOLIDITY_MAX } from '../split.js'
import { fnvBytes, inflateBlue, approx, expectClusters } from './fixtureUtils.js'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures_split__')
const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json').map((f) => f.slice(0, -5)).sort()
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'))

describe('touching-particle split matches the Python reference exactly', () => {
  it('has the eight committed cases', () => {
    expect(names).toHaveLength(8)
  })
  for (const name of names) {
    it(name, () => {
      const c = load(name)
      const e = c.expected
      const blue = inflateBlue(c)
      expect(fnvBytes(blue)).toBe(c.blue_hash)

      // the unsplit parents: candidates and their solidity are exact
      const off = analyzeImageBlue(inflateBlue(c), c.height, c.width, legacySettings({ ...c.settings })).dataset
      const minPx = Math.max(SPLIT_MIN_PX, 2 * (c.settings.min_surface ?? 5))
      const cands = []
      for (let k = 0; k < off.n; k++) {
        const s = off.px_start[k]
        if (off.px_len[k] < minPx) continue
        const sol = clusterSolidity(off.px_row, off.px_col, s, s + off.px_len[k])
        if (sol < SPLIT_SOLIDITY_MAX) cands.push({ parent_id: off.cluster_id[k], solidity: sol })
      }
      expect(cands).toEqual(e.candidates)

      const res = analyzeImageBlue(blue, c.height, c.width,
        legacySettings({ ...c.settings, split_touching: true, split_neck_ratio: c.neck_ratio }))
      const { ms, unsplit, ...counts } = res.split_info
      expect(typeof ms).toBe('number')
      expect(counts).toEqual(e.info)
      expectClusters(res.dataset, e.clusters, c.width, { label: name })

      expect(unsplit.cluster_count).toBe(e.unsplit.cluster_count)
      for (const k of ['dv10_mm', 'dv50_mm', 'dv90_mm']) {
        expect(approx(unsplit[k], e.unsplit[k], 1e-12), `${k}: ${unsplit[k]} vs ${e.unsplit[k]}`).toBe(true)
      }
    })
  }
})
