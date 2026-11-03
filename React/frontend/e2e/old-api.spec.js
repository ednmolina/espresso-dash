// The frontend must keep working against the previous analyzer backend (main @ e299811), which
// has no Dv10/Dv50/Dv90, no layer images, no /preview and no /health, and returns the histogram as a PNG.
// That path is only used with ?engine=cloud (the default engine runs on the device).
import { test, expect } from '@playwright/test'
import {
  openAnalyzer, uploadFixture, setScale, detect, clickImage, particleCount, trackErrors, GRID,
} from './helpers.js'
import { installOldApi } from './stubs/oldApi.js'

test.use({ viewport: { width: 1440, height: 900 } })

const paths = (calls) => calls.map((c) => c.path)

async function analyzeWithStub(page, opts) {
  const api = await installOldApi(page, opts)
  await openAnalyzer(page, '?engine=cloud')
  await uploadFixture(page)
  await setScale(page)
  await detect(page)
  return api
}

test.describe('analyzer against the old backend', () => {
  test('upload, scale and detect show a mean size and no confidence interval', async ({ page }) => {
    const errors = trackErrors(page)
    const api = await analyzeWithStub(page)

    await expect(page.locator('.stat-hero-value')).toContainText('512')
    await expect(page.locator('.stat-hero-value')).toContainText('µm')
    await expect(page.getByText(/95% confidence/i)).toHaveCount(0)
    await expect.poll(() => particleCount(page)).toBe(24)

    expect(paths(api.calls)).toEqual(expect.arrayContaining(['/upload', '/analyze', '/histogram']))
    expect(errors).toEqual([])
  })

  test('the Clusters / Threshold overlay toggle works', async ({ page }) => {
    await analyzeWithStub(page)
    const group = page.locator('.canvas-area .overlay-btns[role=radiogroup]')
    await expect(group).toBeVisible()
    const clusters = group.getByRole('radio', { name: /cluster/i })
    const threshold = group.getByRole('radio', { name: /threshold/i })
    // detecting lands on the Threshold step, which shows the threshold overlay
    await expect(threshold).toHaveAttribute('aria-checked', 'true')
    await clusters.click()
    await expect(clusters).toHaveAttribute('aria-checked', 'true')
    await expect(threshold).toHaveAttribute('aria-checked', 'false')
    await threshold.click()
    await expect(threshold).toHaveAttribute('aria-checked', 'true')
  })

  test('erase reduces the particle count', async ({ page }) => {
    const api = await analyzeWithStub(page)
    const before = await particleCount(page)
    expect(before).toBe(24)
    await page.keyboard.press('4')
    await clickImage(page, GRID.xs[2], GRID.ys[1])
    const erase = page.waitForResponse((r) => r.url().includes('/erase'))
    await page.keyboard.press('Enter')
    expect((await erase).status()).toBe(200)
    await expect.poll(() => particleCount(page)).toBeLessThan(before)
    expect(paths(api.calls)).toContain('/erase')
  })

  test('expanding the distribution shows the server-rendered PNG', async ({ page }) => {
    await analyzeWithStub(page)
    await page.locator('[data-testid=histogram-expand]').click()
    const img = page.locator('img.histogram-png')
    await expect(img.first()).toBeVisible()
    await expect(img.first()).toHaveAttribute('alt', 'Size distribution')
  })

  test('save run twice and compare shows the comparison PNG', async ({ page }) => {
    const errors = trackErrors(page)
    const api = await analyzeWithStub(page)
    const save = page.getByRole('button', { name: /save run/i })
    await save.click()
    await expect(page.getByText(/saved/i).first()).toBeVisible()
    await save.click()
    const compare = page.waitForResponse((r) => r.url().includes('/histogram/compare'))
    await page.getByRole('button', { name: 'Compare runs' }).click()
    expect((await compare).status()).toBe(200)
    await expect(page.locator('.compare-summary')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('img.histogram-png').first()).toBeVisible()
    expect(paths(api.calls)).toContain('/histogram/compare')
    expect(errors).toEqual([])
  })

  test('saving a calibration point works with a legacy summary', async ({ page }) => {
    await analyzeWithStub(page)
    const save = page.locator('[data-testid=save-calibration]')
    await expect(save).toBeDisabled()
    const chip = page.locator('[data-testid=grind-picker-micro-E]')
    await chip.click()
    await expect(page.locator('[data-testid=grind-picker-value]')).toHaveText('10E')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(page.getByText(/Calibration point saved/)).toBeVisible()
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('espressoLab.calibrationRuns.v1') || '[]'))
    expect(stored).toHaveLength(1)
    expect(stored[0].grindSetting).toBe('10E')
    expect(stored[0].mean_um).toBeGreaterThan(400)
    expect(stored[0].apiShape).toBe('legacy')
  })

  for (const mismatch of [false, true]) {
    test(`never requests /preview or /health (image size ${mismatch ? 'mismatch' : 'match'})`, async ({ page }) => {
      const errors = trackErrors(page)
      const api = await analyzeWithStub(page, { mismatch })
      await expect(page.locator('canvas').first()).toBeVisible()
      const requested = paths(api.calls)
      expect(requested.filter((p) => p.startsWith('/preview') || p === '/health')).toEqual([])
      expect(requested).toContain('/upload')
      expect(errors).toEqual([])
    })
  }
})
