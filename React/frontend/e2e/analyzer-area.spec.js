// The required Area step: after the scale the analyzer waits in Area and detects nothing until the grounds are
// outlined (closed polygon) or "Use whole photo" is chosen on purpose.
import { test, expect } from '@playwright/test'
import {
  openAnalyzer, uploadFixture, clickImage, setScale, setScaleAndArea, useWholePhoto, drawArea, trackErrors,
  engineLogLength, waitForEngineOp, waitForAutoDetect, cdpTap, cdpPinch, horizontalOverflow,
} from './helpers.js'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'phone', width: 390, height: 844 },
]

const step = (page, id) => page.locator(`.step[data-step=${id}]`)
/** Number of 'analyze' entries in the engine log: any detection ever started. */
const analyzeCount = (page) => page.evaluate(() => (window.__grindEngineLog || []).filter((e) => e.op === 'analyze').length)
const noResultsYet = async (page) => {
  await expect(page.locator('.stat-hero-value')).toHaveCount(0)
  await expect(page.locator('.results-count')).toHaveCount(0)
  await expect(page.getByTestId('threshold-count')).toHaveCount(0)
}

for (const vp of VIEWPORTS) {
  test.describe(`area step @ ${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: true })

    test('after the scale the app waits in Area: no detection, Threshold and Clean up are disabled', async ({ page }) => {
      const errors = trackErrors(page)
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)

      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
      await expect(step(page, 'reference')).toHaveClass(/done/)
      await expect(step(page, 'polygon')).not.toHaveClass(/done/)
      await expect(page.getByTestId('area-hint')).toHaveText('Tap around the coffee grounds, then tap the first point to close the area.')
      await expect(page.getByTestId('area-undo')).toBeDisabled()
      await expect(page.getByTestId('area-clear')).toBeDisabled()
      await expect(page.getByTestId('whole-photo')).toBeVisible()
      await expect(page.getByTestId('whole-photo')).toHaveText('Use whole photo')
      await expect(step(page, 'threshold')).toBeDisabled()
      await expect(step(page, 'threshold')).toHaveAttribute('title', 'Select the area first')
      await expect(step(page, 'erase')).toBeDisabled()

      // give an (unwanted) auto-detection time to start: nothing may run
      await page.waitForTimeout(800)
      expect(await analyzeCount(page)).toBe(0)
      await noResultsYet(page)
      await expect(page.locator('.canvas-area[aria-busy="true"]')).toHaveCount(0)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })

    test('Enter, 4 and 5 do nothing before the area is chosen; the Detect button is disabled', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await page.locator('canvas').first().focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('4')
      await page.keyboard.press('5')
      await page.waitForTimeout(600)
      expect(await analyzeCount(page)).toBe(0)
      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
      await noResultsYet(page)
      if (vp.width > 640) await expect(page.getByRole('button', { name: /Run particle detection/ })).toBeDisabled()

      // one or two points are not an area either
      await clickTwoPoints(page)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(400)
      expect(await analyzeCount(page)).toBe(0)
      await expect(step(page, 'threshold')).toBeDisabled()
    })

    test('drawing and closing an area starts the detection and opens Threshold', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      const from = await engineLogLength(page)
      await drawArea(page)
      const entry = await waitForAutoDetect(page, from)
      expect(entry.nclusters).toBeGreaterThan(0)
      await expect(step(page, 'threshold')).toHaveAttribute('aria-current', 'step')
      await expect(step(page, 'polygon')).toHaveClass(/done/)
      await expect(step(page, 'threshold')).toBeEnabled()
      expect(await analyzeCount(page)).toBe(1)
    })

    test('Use whole photo starts the detection on the full photo', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      const from = await engineLogLength(page)
      await useWholePhoto(page)
      const entry = await waitForAutoDetect(page, from)
      expect(entry.nclusters).toBeGreaterThan(10) // the whole grid of the fixture
      await expect(step(page, 'threshold')).toHaveAttribute('aria-current', 'step')
      await expect(step(page, 'polygon')).toHaveClass(/done/)
      await expect(page.getByTestId('whole-photo')).toHaveCount(0) // that choice is made: the link only lives in Area
      expect(await analyzeCount(page)).toBe(1)
    })

    test('a new photo resets the area and the whole-photo choice', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScaleAndArea(page, { area: 'whole' })
      await waitForAutoDetect(page)

      let upload = await engineLogLength(page)
      await uploadFixture(page)
      await waitForEngineOp(page, 'upload', upload)
      await expect(step(page, 'reference')).toHaveAttribute('aria-current', 'step')
      await expect(step(page, 'polygon')).not.toHaveClass(/done/)
      await expect(step(page, 'threshold')).toBeDisabled()
      const before = await analyzeCount(page)
      await setScale(page)
      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step') // Area again, not Threshold
      await page.waitForTimeout(600)
      expect(await analyzeCount(page)).toBe(before) // the old whole-photo choice did not carry over
      await noResultsYet(page)

      // the same for a drawn area
      await drawArea(page)
      await waitForEngineOp(page, 'analyze', await engineLogLength(page) - 1)
      upload = await engineLogLength(page)
      await uploadFixture(page)
      await waitForEngineOp(page, 'upload', upload)
      const n = await analyzeCount(page)
      await setScale(page)
      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
      await expect(page.getByTestId('area-undo')).toBeDisabled() // no vertices left over
      await page.waitForTimeout(600)
      expect(await analyzeCount(page)).toBe(n)
    })

    test('changing the scale keeps the area', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScaleAndArea(page, { area: 'whole' })
      await waitForAutoDetect(page)
      const from = await engineLogLength(page)
      // a new scale (taps a little lower than setScale's, clear of the overlay buttons): its second tap goes
      // straight on to Threshold, because the area is still set
      await page.keyboard.press('2')
      await page.locator('[data-testid=scale-preset]').selectOption('US Quarter')
      await clickImage(page, 100, 120)
      await clickImage(page, 300, 120)
      await waitForEngineOp(page, 'analyze', from)
      await expect(step(page, 'threshold')).toHaveAttribute('aria-current', 'step')
      await expect(step(page, 'polygon')).toHaveClass(/done/)
    })

    test('touch gestures never add area points (pinch, drag, long press), a quick tap adds one', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      const cdp = await page.context().newCDPSession(page)
      const bb = await page.locator('canvas').first().boundingBox()
      const centre = { x: bb.x + bb.width / 2, y: bb.y + bb.height * 0.4 }
      const undo = page.getByTestId('area-undo')
      await expect(undo).toBeDisabled()
      await cdpPinch(page, cdp, centre.x, centre.y)
      await cdpTap(page, cdp, centre.x - 60, centre.y, 600) // too long to be a tap
      await page.waitForTimeout(100)
      await expect(undo).toBeDisabled()
      await cdpTap(page, cdp, centre.x - 60, centre.y)
      await expect(undo).toBeEnabled()
      await cdpPinch(page, cdp, centre.x, centre.y + 30)
      await undo.click()
      await expect(undo).toBeDisabled() // the pinch added nothing: one tap, one point
      expect(await analyzeCount(page)).toBe(0)
    })

    test('Undo and Clear edit the outline; a drawn area can be undone back to nothing', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await clickTwoPoints(page)
      await expect(page.getByTestId('area-undo')).toBeEnabled()
      await page.getByTestId('area-undo').click()
      await page.getByTestId('area-undo').click()
      await expect(page.getByTestId('area-undo')).toBeDisabled()
      await clickTwoPoints(page)
      await page.getByTestId('area-clear').click()
      await expect(page.getByTestId('area-undo')).toBeDisabled()
      await expect(page.getByTestId('area-clear')).toBeDisabled()
      expect(await analyzeCount(page)).toBe(0)
    })
  })
}

async function clickTwoPoints(page) {
  await clickImage(page, 150, 150)
  await clickImage(page, 480, 150)
}

// Five steps still fit a very narrow phone, with no horizontal scroll, in Area and in Threshold.
for (const width of [390, 320]) {
  test.describe(`stepper fits @ ${width}px`, () => {
    test.use({ viewport: { width, height: 700 }, hasTouch: true })

    test('all five steps are visible and inside the screen', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      for (const phase of ['scale', 'area', 'threshold']) {
        if (phase === 'area') await setScale(page)
        if (phase === 'threshold') {
          const from = await engineLogLength(page)
          await drawArea(page)
          await waitForEngineOp(page, 'analyze', from)
        }
        await page.waitForTimeout(300)
        expect(await horizontalOverflow(page), `overflow in ${phase}`).toBeLessThanOrEqual(0)
        const boxes = await page.locator('.stepper .step').evaluateAll((els) => els.map((e) => {
          const r = e.getBoundingClientRect()
          return { left: r.left, right: r.right, label: e.querySelector('.step-label').textContent, clipped: e.scrollWidth > e.clientWidth + 1 }
        }))
        expect(boxes.map((b) => b.label)).toEqual(['Photo', 'Scale', 'Area', 'Threshold', 'Clean up'])
        for (const b of boxes) {
          expect(b.left, `${b.label} left in ${phase}`).toBeGreaterThanOrEqual(0)
          expect(b.right, `${b.label} right in ${phase}`).toBeLessThanOrEqual(width)
          expect(b.clipped, `${b.label} clipped in ${phase}`).toBe(false)
        }
      }
    })
  })
}
