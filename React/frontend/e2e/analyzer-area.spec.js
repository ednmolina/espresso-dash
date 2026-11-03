// The required Area step: after the scale the analyzer waits in Area and detects nothing until the grounds are
// outlined (closed polygon) or "Use whole photo" is chosen on purpose.
import { test, expect } from '@playwright/test'
import {
  openAnalyzer, uploadFixture, clickImage, setScale, setScaleAndArea, useWholePhoto, drawArea, trackErrors,
  engineLogLength, engineStarts, waitForEngineOp, waitForAutoDetect, detect, cdpTap, cdpPinch, horizontalOverflow,
} from './helpers.js'
import { installOldApi } from './stubs/oldApi.js'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'phone', width: 390, height: 844 },
]

const step = (page, id) => page.locator(`.step[data-step=${id}]`)
/**
 * Number of detections STARTED (dev-only window.__grindEngineStarts, counted when the app calls the engine, not
 * when one finishes): an attempt that is still running or that failed counts too.
 */
const analyzeCount = (page) => engineStarts(page, 'analyze')
/** Neither a detection nor a threshold preview was ever started. */
const expectNoDetection = async (page) => {
  expect(await engineStarts(page, 'analyze'), 'analyze started').toBe(0)
  expect(await engineStarts(page, 'thresholdPreview'), 'thresholdPreview started').toBe(0)
}
const AREA_STALE = 'Area changed — close it to update'
// by text, not role: on a phone the sheet body is visibility:hidden while the results are a one-line peek
const saveRun = (page) => page.locator('button', { hasText: /^Save run/ })
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
      await expectNoDetection(page)
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
      await expectNoDetection(page)
      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
      await noResultsYet(page)
      if (vp.width > 640) await expect(page.getByRole('button', { name: /Run particle detection/ })).toBeDisabled()

      // one or two points are not an area either
      await clickTwoPoints(page)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(400)
      await expectNoDetection(page)
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
      await expectNoDetection(page)
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
      await expectNoDetection(page)
    })

    test('reopening the area after a detection: results are outdated, Save run and Threshold are off, nothing detects', async ({ page }) => {
      const errors = trackErrors(page)
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScaleAndArea(page, { area: 'whole' })
      await waitForAutoDetect(page)
      await expect(saveRun(page)).toBeEnabled()
      await expect(step(page, 'threshold')).toHaveAttribute('aria-current', 'step')
      const started = await analyzeCount(page)
      expect(started).toBe(1)

      // the reported repro: press 3, tap one point
      await page.keyboard.press('3')
      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
      await clickImage(page, 150, 150)
      await expect(page.getByTestId('area-undo')).toBeEnabled()

      await expect(step(page, 'threshold')).toHaveAttribute('aria-disabled', 'true')
      await expect(step(page, 'threshold')).not.toHaveClass(/done/)
      await expect(step(page, 'threshold')).not.toContainText('(done)')
      await expect(step(page, 'erase')).toHaveAttribute('aria-disabled', 'true')
      await expect(step(page, 'polygon')).not.toHaveClass(/done/)
      // the old numbers are still there but say (in words) that they are outdated
      await expect(page.getByTestId('stale-note')).toHaveText(AREA_STALE)
      if (vp.name === 'phone') await expect(page.getByTestId('stale-tag')).toBeVisible()
      else await expect(page.getByTestId('stale-note')).toBeVisible()
      await expect(saveRun(page)).toBeDisabled()
      await expect(page.getByTestId('save-run-reason')).toHaveText(AREA_STALE)
      await expect(page.locator('button', { hasText: /^Download/ })).toBeDisabled()
      await expect(page.getByTestId('save-calibration')).toBeDisabled()
      await page.waitForTimeout(600)
      expect(await analyzeCount(page)).toBe(started)
      expect(await engineStarts(page, 'thresholdPreview')).toBe(0)

      // closing the outline refreshes the results; only then is everything back
      const from = await engineLogLength(page)
      await clickImage(page, 480, 150)
      await clickImage(page, 480, 330)
      await clickImage(page, 150, 150)
      await waitForAutoDetect(page, from)
      await expect(page.getByTestId('stale-note')).toHaveCount(0)
      await expect(saveRun(page)).toBeEnabled()
      await expect(step(page, 'polygon')).toHaveClass(/done/)
      expect(await analyzeCount(page)).toBe(started + 1)
      expect(errors).toEqual([])
    })

    test('Esc on a closed outline after a result also marks the results outdated; Undo brings the outline back without detecting', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await drawArea(page)
      await waitForAutoDetect(page)
      await page.keyboard.press('3')
      await page.keyboard.press('Escape')
      await expect(step(page, 'threshold')).toHaveAttribute('aria-disabled', 'true')
      await expect(page.getByTestId('stale-note')).toHaveText(AREA_STALE)
      await expect(saveRun(page)).toBeDisabled()
      await expect(page.getByTestId('restore-area')).toBeVisible()
      const started = await analyzeCount(page)

      await page.getByTestId('area-undo').click() // "Undo last point" restores the cleared outline
      await expect(step(page, 'threshold')).toHaveAttribute('aria-current', 'step')
      await expect(page.getByTestId('stale-note')).toHaveCount(0)
      await expect(saveRun(page)).toBeEnabled() // the same inputs as the result: nothing to detect again
      await page.waitForTimeout(500)
      expect(await analyzeCount(page)).toBe(started)
      await expect(page.getByTestId('restore-area')).toHaveCount(0)
    })

    test('Use whole photo keeps a closed outline for Undo', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await drawArea(page)
      await waitForAutoDetect(page)
      let from = await engineLogLength(page)
      await page.keyboard.press('3')
      await page.getByTestId('whole-photo').click()
      await waitForEngineOp(page, 'analyze', from)
      await expect(step(page, 'threshold')).toHaveAttribute('aria-current', 'step')
      await expect(page.getByTestId('restore-area')).toBeVisible()

      from = await engineLogLength(page)
      await page.getByTestId('restore-area').click() // Undo: the outline is the area again and detects
      await waitForEngineOp(page, 'analyze', from)
      await expect(step(page, 'threshold')).toHaveAttribute('aria-current', 'step')
      await expect(page.getByTestId('restore-area')).toHaveCount(0)
      await page.keyboard.press('3')
      await expect(page.getByTestId('area-hint')).toContainText('3-point area')
      expect(await analyzeCount(page)).toBe(3)
    })

    test('Enter in Area with an open outline after a result does nothing', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await drawArea(page)
      await waitForAutoDetect(page)
      const started = await analyzeCount(page)
      await page.keyboard.press('3')
      await page.getByTestId('area-undo').click() // the outline is open again (2 points)
      await expect(step(page, 'threshold')).toHaveAttribute('aria-disabled', 'true')
      await page.locator('canvas').first().focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('4')
      await page.keyboard.press('5')
      await page.waitForTimeout(700)
      expect(await analyzeCount(page)).toBe(started)
      expect(await engineStarts(page, 'thresholdPreview')).toBe(0)
      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
      await expect(page.getByTestId('stale-note')).toHaveText(AREA_STALE)
    })

    test('changing Settings before the area is chosen does not detect', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await page.getByTestId('settings-open').click()
      await page.getByTestId('split-toggle').check()
      await page.waitForTimeout(800)
      await expectNoDetection(page)
      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
      await expect(step(page, 'threshold')).toHaveAttribute('aria-disabled', 'true')
      await noResultsYet(page)
    })

    test('a disabled step stays focusable, explains itself, and does nothing when activated', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      const threshold = step(page, 'threshold')
      await expect(threshold).toHaveAttribute('aria-disabled', 'true')
      await expect(threshold).not.toHaveAttribute('disabled', /.*/)
      const reasonId = await threshold.getAttribute('aria-describedby')
      expect(reasonId).toBeTruthy()
      await expect(page.locator(`#${reasonId}`)).toHaveText('Select the area first')
      await threshold.focus()
      await expect(threshold).toBeFocused()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await threshold.click({ force: true })
      await page.waitForTimeout(500)
      await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
      await expectNoDetection(page)
      // the scale step is done: assistive tech hears it
      await expect(step(page, 'reference')).toContainText('(done)')
      if (vp.width > 640) {
        const run = page.getByRole('button', { name: /Run particle detection/ })
        await expect(run).toHaveAttribute('aria-disabled', 'true')
        await expect(page.locator(`#${await run.getAttribute('aria-describedby')}`)).toHaveText('Select the area first')
        await run.click({ force: true })
        await page.waitForTimeout(300)
        await expectNoDetection(page)
      }
    })

    test('the area cannot be edited while a detection runs', async ({ page }) => {
      await openAnalyzer(page, '?engineDelay=2500')
      await uploadFixture(page)
      await setScale(page)
      await drawArea(page)
      await waitForAutoDetect(page)
      await page.keyboard.press('3') // reopen the closed outline: Undo / Clear are live ...
      await expect(page.getByTestId('area-clear')).toBeEnabled()
      await expect(page.getByTestId('area-undo')).toBeEnabled()
      await page.locator('canvas').first().focus()
      await page.keyboard.press('Enter') // ... until a detection runs
      await expect(page.locator('.canvas-area[aria-busy="true"]')).toBeVisible()
      await expect(page.getByTestId('area-undo')).toBeDisabled()
      await expect(page.getByTestId('area-clear')).toBeDisabled()
      await expect(page.getByTestId('whole-photo')).toBeDisabled()
      await expect(step(page, 'polygon')).toHaveAttribute('aria-disabled', 'true')
      await expect(step(page, 'threshold')).toHaveAttribute('aria-disabled', 'true')
      await expect(step(page, 'threshold').locator('.spinner')).toBeVisible()
      // the result that arrives belongs to the outline that was sent, and the outline is still there
      await expect(page.locator('.canvas-area[aria-busy="false"]')).toBeVisible({ timeout: 30_000 })
      await expect(step(page, 'threshold')).toHaveAttribute('aria-current', 'step')
      await expect(page.getByTestId('stale-note')).toHaveCount(0)
      await expect(saveRun(page)).toBeEnabled()
      expect(await analyzeCount(page)).toBe(2)
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

    test('the outdated peek (headline, Outdated tag, Show button) fits after the area is reopened', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await useWholePhoto(page)
      await waitForAutoDetect(page)
      await page.keyboard.press('3')
      await clickImage(page, 150, 150)
      await expect(page.getByTestId('stale-tag')).toBeVisible()
      await page.waitForTimeout(300)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
      const toggle = await page.locator('[data-testid=results-toggle]:visible').first().boundingBox()
      const headline = await page.locator('.sheet-headline').boundingBox()
      expect(toggle.x + toggle.width, 'Show button inside the screen').toBeLessThanOrEqual(width)
      expect(headline.x + headline.width, 'headline does not run under Show').toBeLessThanOrEqual(toggle.x + 1)
    })

    test('the stepper still fits while a detection runs (spinner in the Threshold step, every step disabled)', async ({ page }) => {
      await openAnalyzer(page, '?engineDelay=4000')
      await uploadFixture(page)
      await setScale(page)
      await drawArea(page)
      await expect(page.locator('.canvas-area[aria-busy="true"]')).toBeVisible()
      await expect(page.locator('.step[data-step=threshold] .spinner')).toBeVisible()
      await page.waitForTimeout(300)
      expect(await horizontalOverflow(page), 'page overflow while detecting').toBeLessThanOrEqual(0)
      const boxes = await page.locator('.stepper .step').evaluateAll((els) => els.map((e) => {
        const r = e.getBoundingClientRect()
        const label = e.querySelector('.step-label').getBoundingClientRect()
        const spinner = e.querySelector('.spinner')?.getBoundingClientRect()
        return {
          left: r.left, right: r.right, label: e.querySelector('.step-label').textContent,
          clipped: e.scrollWidth > e.clientWidth + 1,
          // nothing inside the button sticks out of it
          innerRight: Math.max(label.right, spinner?.right ?? 0), disabled: e.getAttribute('aria-disabled'),
        }
      }))
      expect(boxes.map((b) => b.label)).toEqual(['Photo', 'Scale', 'Area', 'Threshold', 'Clean up'])
      for (const b of boxes) {
        expect(b.left, `${b.label} left while detecting`).toBeGreaterThanOrEqual(0)
        expect(b.right, `${b.label} right while detecting`).toBeLessThanOrEqual(width)
        expect(b.clipped, `${b.label} clipped while detecting`).toBe(false)
        expect(b.innerRight, `${b.label} content sticks out while detecting`).toBeLessThanOrEqual(b.right + 0.5)
        expect(b.disabled).toBe('true')
      }
    })
  })
}

// ?engine=cloud: the same rule against the Python API: not a single POST /analyze before the area is chosen.
test.describe('?engine=cloud waits for the area too', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('no POST /analyze until the outline is closed or Use whole photo is chosen', async ({ page }) => {
    const api = await installOldApi(page)
    const analyzePosts = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/analyze')) analyzePosts.push(r.url())
    })
    await openAnalyzer(page, '?engine=cloud')
    await uploadFixture(page)
    await setScale(page)
    await expect(step(page, 'polygon')).toHaveAttribute('aria-current', 'step')
    await page.locator('canvas').first().focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('4')
    await page.keyboard.press('5')
    await clickTwoPoints(page) // an open outline is not an area either
    await page.keyboard.press('Enter')
    await page.getByTestId('settings-open').click()
    await page.getByTestId('settings-open').click()
    await page.waitForTimeout(1000) // longer than the cloud debounce (400 ms)
    expect(analyzePosts).toEqual([])
    expect(api.calls.map((c) => c.path)).not.toContain('/analyze')
    expect(await engineStarts(page, 'analyze')).toBe(0)
    await noResultsYet(page)

    await useWholePhoto(page)
    const body = await detect(page)
    expect(body.nclusters).toBeGreaterThan(0)
    expect(analyzePosts).toHaveLength(1)
    expect(await engineStarts(page, 'analyze')).toBe(1)
  })
})
