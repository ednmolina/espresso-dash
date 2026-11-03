// The on-device engine (default): no backend traffic, progress + cancel, HEIC message, and agreement
// with the Python core on the shared fixture photo. Run at desktop, tablet and phone widths.
import { test, expect } from '@playwright/test'
import {
  openAnalyzer, uploadFixture, setScale, detect, clickImage, particleCount, trackErrors, GRID,
  engineLogLength, waitForEngineOp,
} from './helpers.js'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'phone', width: 390, height: 844 },
]

// Recorded from the Python core on fixtures/grind.png with the UI defaults (poly4 background, half-contrast
// threshold, edge correction) and the scale set by setScale() (200 px = US quarter, 24.26 mm). The legacy
// settings give the same count (24). To regenerate:
//   cd cloudrun && python - <<'PY'
//   import math; from PIL import Image
//   from coffeegrindsize_core import AnalysisSettings, analyze_image, summarize_dataset
//   s = AnalysisSettings(pixel_scale=200 / 24.26, reference_px_length=200.0)
//   r = analyze_image(Image.open('../React/frontend/e2e/fixtures/grind.png'), s)
//   print(r.dataset.nclusters, summarize_dataset(r.dataset)['dv50_mm'])
//   PY
const PYTHON_NCLUSTERS = 24
const PYTHON_DV50_MM = 2.2115742504438374

for (const vp of VIEWPORTS) {
  test.describe(`on-device engine @ ${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('a full workflow makes no /api requests', async ({ page }) => {
      const errors = trackErrors(page)
      const apiCalls = []
      page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls.push(r.url()) })

      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      const entry = await detect(page)
      expect(entry.nclusters).toBeGreaterThan(10)
      await expect(page.locator('.histogram-chart svg').first()).toBeVisible({ timeout: 15_000 })

      const before = await particleCount(page)
      await page.keyboard.press('4')
      await clickImage(page, GRID.xs[2], GRID.ys[1])
      const from = await engineLogLength(page)
      await page.keyboard.press('Enter')
      await waitForEngineOp(page, 'erase', from)
      await expect.poll(() => particleCount(page)).toBeLessThan(before)

      const save = page.getByRole('button', { name: /save run/i })
      await save.click()
      await expect(page.getByText(/saved/i).first()).toBeVisible()
      await save.click()
      await page.getByRole('button', { name: /compare/i }).first().click()
      await expect(page.locator('.compare-summary')).toBeVisible({ timeout: 30_000 })

      expect(apiCalls).toEqual([])
      expect(errors).toEqual([])
    })

    test('progress is shown and Cancel stops detection; detecting again works', async ({ page }) => {
      await openAnalyzer(page, '?engineDelay=3000')
      await uploadFixture(page)
      await setScale(page)
      await page.keyboard.press('Enter')

      await expect(page.locator('.canvas-area[aria-busy="true"]')).toBeVisible()
      await expect(page.locator('.busy-progress')).toBeVisible()
      await page.getByRole('button', { name: /^cancel$/i }).click()
      await expect(page.getByText('Detection cancelled.').first()).toBeVisible()
      await expect(page.locator('.canvas-area[aria-busy="true"]')).toHaveCount(0)

      const entry = await detect(page)
      expect(entry.nclusters).toBeGreaterThan(10)
    })

    test('a file that cannot be decoded as HEIC shows the HEIC message', async ({ page }) => {
      await openAnalyzer(page)
      await page.locator('input[type=file]:not([capture])').first().setInputFiles({
        name: 'x.heic',
        mimeType: 'image/heic',
        buffer: Buffer.from('this is not a real heic file'),
      })
      await expect(page.getByText(/can't open HEIC photos/i).first()).toBeVisible({ timeout: 15_000 })
    })

    test('the particle count and Dv50 match the Python core', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      const entry = await detect(page)
      expect(entry.nclusters).toBe(PYTHON_NCLUSTERS)
      await expect.poll(() => particleCount(page)).toBe(PYTHON_NCLUSTERS)
      // JS fits the illumination polynomial itself, so allow a hair of drift in Dv50 (exactness is
      // covered by the vitest parity suite)
      expect(Math.abs(entry.summary.dv50_mm / PYTHON_DV50_MM - 1)).toBeLessThan(0.01)
    })
  })
}
