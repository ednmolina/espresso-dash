// Optional: the main workflow through the Python backend (?engine=cloud). Runs only with E2E_CLOUD=1,
// which also starts uvicorn (see playwright.config.js):
//   E2E_CLOUD=1 PYTHON=/path/to/venv/bin/python npx playwright test -c e2e/playwright.config.js cloud
import { test, expect } from '@playwright/test'
import {
  openAnalyzer, uploadFixture, setScale, detect, clickImage, particleCount, trackErrors, GRID,
} from './helpers.js'

test.skip(process.env.E2E_CLOUD !== '1', 'set E2E_CLOUD=1 to run against the Python backend')

test('cloud engine: upload, scale, detect, histogram, erase, save, compare', async ({ page }) => {
  const errors = trackErrors(page)
  await openAnalyzer(page, '?engine=cloud')
  await uploadFixture(page)
  await setScale(page)

  const body = await detect(page)
  expect(body.nclusters).toBeGreaterThan(10)
  await expect(page.locator('.stat-hero-value')).toContainText(/\d.*µm/)
  await expect(page.locator('.histogram-chart svg').first()).toBeVisible({ timeout: 15_000 })

  const before = await particleCount(page)
  await page.keyboard.press('4')
  await clickImage(page, GRID.xs[2], GRID.ys[1])
  const erase = page.waitForResponse((r) => r.url().includes('/erase'))
  await page.keyboard.press('Enter')
  expect((await erase).status()).toBe(200)
  await expect.poll(() => particleCount(page)).toBeLessThan(before)

  const save = page.getByRole('button', { name: /save run/i })
  await save.click()
  await expect(page.getByText(/saved/i).first()).toBeVisible()
  await expect(save).toBeDisabled() // the same analysis can't be saved twice
  // erase one more particle: a different analysis, so a second run
  await page.evaluate(() => window.scrollTo(0, 0)) // saving scrolled the photo out of view
  await clickImage(page, GRID.xs[3], GRID.ys[1])
  const erase2 = page.waitForResponse((r) => r.url().includes('/erase'))
  await page.keyboard.press('Enter')
  expect((await erase2).status()).toBe(200)
  await expect(save).toBeEnabled()
  await save.click()
  await page.getByRole('button', { name: /compare/i }).first().click()
  await expect(page.locator('.compare-summary')).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})
