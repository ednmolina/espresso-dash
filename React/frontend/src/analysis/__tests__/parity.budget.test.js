import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURE_DIR } from './fixtureUtils.js'

describe('fixtures', () => {
  it('total less than 3 MB', () => {
    const total = fs.readdirSync(FIXTURE_DIR).reduce((sum, f) => sum + fs.statSync(path.join(FIXTURE_DIR, f)).size, 0)
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThan(3 * 1024 * 1024)
  })
})
