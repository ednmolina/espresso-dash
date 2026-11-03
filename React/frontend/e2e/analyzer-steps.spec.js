// The four-step analyzer flow (Photo, Scale, Threshold, Clean up): the default reference, the automatic move
// to Threshold, touch gestures that must never leave a mark, and the live threshold control.
import { test, expect } from '@playwright/test'
import {
  openAnalyzer, uploadFixture, setScale, detect, trackErrors, imageToPage,
  engineLogLength, waitForEngineOp, waitForAutoDetect, cdpTouch, cdpTap, cdpPinch, redPixelCount,
} from './helpers.js'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'phone', width: 390, height: 844 },
]

const countText = (page) => page.getByTestId('threshold-count').innerText()
/** Dv50 (mm) of the newest detection in the engine log: the particle count of the fixture barely moves with the threshold. */
const lastDv50 = (page) => page.evaluate(() => [...window.__grindEngineLog].reverse().find((e) => e.op === 'analyze')?.summary?.dv50_mm)
const sliderValue = (page) => page.getByTestId('threshold-value').innerText()

for (const vp of VIEWPORTS) {
  test.describe(`analyzer steps @ ${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: true })

    test('the default reference is Custom 20 mm; typing a size makes it Custom, a coin fills its size', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      const preset = page.getByTestId('scale-preset')
      const mm = page.getByTestId('scale-mm')
      await expect(preset).toHaveValue('custom')
      await expect(mm).toHaveValue('20')
      await expect(page.locator('.toolbar-hint')).toContainText('Tap both ends of 20 mm on your ruler')

      await preset.selectOption('US Quarter')
      await expect(mm).toHaveValue('24.26')
      await mm.fill('21')
      await expect(preset).toHaveValue('custom')
      await expect(page.locator('.toolbar-hint')).toContainText('Tap both ends of 21 mm')
    })

    test('steps run Photo, Scale, Threshold, Clean up; the second scale tap opens Threshold and detects', async ({ page }) => {
      const errors = trackErrors(page)
      await openAnalyzer(page)
      await uploadFixture(page)
      await expect(page.locator('.stepper .step-label')).toHaveText(['Photo', 'Scale', 'Threshold', 'Clean up'])
      const step = (id) => page.locator(`.step[data-step=${id}]`)
      await expect(step('photo')).toHaveClass(/done/) // an image is loaded
      await expect(step('reference')).toHaveAttribute('aria-current', 'step')
      await expect(step('threshold')).toBeDisabled()
      await expect(step('erase')).toBeDisabled()

      const from = await engineLogLength(page)
      await setScale(page)
      const entry = await waitForAutoDetect(page, from)
      expect(entry.nclusters).toBeGreaterThan(10)
      await expect(step('threshold')).toHaveAttribute('aria-current', 'step')
      await expect(step('reference')).toHaveClass(/done/)
      await expect(page.getByTestId('threshold-control')).toBeVisible()
      await expect(page.getByTestId('threshold-chip')).toHaveText('Auto')
      await expect(page.getByTestId('threshold-value')).toHaveText(/^\d+\.\d%$/)
      await expect(page.getByTestId('threshold-count')).toContainText(String(entry.nclusters))
      await expect(page.getByRole('button', { name: /^Limit area$/ })).toBeVisible()

      await page.getByTestId('next-cleanup').click()
      await expect(step('erase')).toHaveAttribute('aria-current', 'step')
      await expect(page.getByRole('button', { name: /^Remove/ })).toBeDisabled()
      await page.keyboard.press('3') // back: nothing changed, so no new detection
      const n = await engineLogLength(page)
      await page.waitForTimeout(300)
      expect(await engineLogLength(page)).toBe(n)
      await expect(step('threshold')).toHaveAttribute('aria-current', 'step')
      expect(errors).toEqual([])
    })

    test('Limit area re-detects when the area closes, and the area can be cleared', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      const first = await waitForAutoDetect(page)
      await page.getByTestId('limit-area').click()
      const from = await engineLogLength(page)
      // a small triangle on the grid (kept inside the first screenful), closed by tapping the first point again
      for (const [x, y] of [[150, 150], [480, 150], [480, 330]]) {
        const p = await imageToPage(page, x, y)
        await page.mouse.click(p.x, p.y)
      }
      const start = await imageToPage(page, 150, 150)
      await page.mouse.click(start.x, start.y)
      const entry = await waitForEngineOp(page, 'analyze', from)
      expect(entry.nclusters).toBeLessThan(first.nclusters)
      await expect(page.locator('.step[data-step=threshold]')).toHaveAttribute('aria-current', 'step')
      await expect(page.getByTestId('clear-area')).toBeVisible()

      const from2 = await engineLogLength(page)
      await page.getByTestId('clear-area').click()
      const again = await waitForEngineOp(page, 'analyze', from2)
      expect(again.nclusters).toBe(first.nclusters)
      await expect(page.getByTestId('clear-area')).toHaveCount(0)
    })

    test.describe('touch gestures never add points', () => {
      let cdp
      let centre
      test.beforeEach(async ({ page }) => {
        await openAnalyzer(page)
        await uploadFixture(page)
        cdp = await page.context().newCDPSession(page)
        const bb = await page.locator('canvas').first().boundingBox()
        // upper part of the photo: the results sheet covers the lower half on a phone
        centre = { x: bb.x + bb.width / 2, y: bb.y + bb.height * 0.3 }
      })

      /** A press that stays down well past the tap limit. */
      const longPress = (page, x, y) => cdpTap(page, cdp, x, y, 600)

      test('Scale', async ({ page }) => {
        await page.keyboard.press('2')
        const hint = page.locator('.toolbar-hint')
        const undo = page.getByRole('button', { name: 'Undo' })
        await expect(undo).toHaveCount(0)
        await cdpPinch(page, cdp, centre.x, centre.y)
        await longPress(page, centre.x - 60, centre.y)
        await cdpTouch(cdp, 'touchStart', [{ x: centre.x, y: centre.y, id: 1 }])
        await page.waitForTimeout(50)
        await cdpTouch(cdp, 'touchCancel', [])
        await page.waitForTimeout(100)
        await expect(undo).toHaveCount(0) // no point: no Undo/Clear, still the first prompt
        await expect(hint).toContainText('Tap both ends')

        await cdpTap(page, cdp, centre.x - 60, centre.y)
        await expect(hint).toContainText('Now tap the other end') // exactly one point
        await cdpPinch(page, cdp, centre.x, centre.y + 40)
        await longPress(page, centre.x + 60, centre.y)
        await page.waitForTimeout(100)
        await expect(hint).toContainText('Now tap the other end') // still one
      })

      test('Limit area', async ({ page }) => {
        await setScale(page)
        await waitForAutoDetect(page)
        await page.getByTestId('limit-area').click()
        const undo = page.getByRole('button', { name: 'Undo' })
        await expect(undo).toBeDisabled()
        await cdpPinch(page, cdp, centre.x, centre.y)
        await longPress(page, centre.x - 80, centre.y)
        await cdpTouch(cdp, 'touchStart', [{ x: centre.x, y: centre.y, id: 1 }])
        await page.waitForTimeout(50)
        await cdpTouch(cdp, 'touchCancel', [])
        await page.waitForTimeout(100)
        await expect(undo).toBeDisabled() // no vertex

        await cdpTap(page, cdp, centre.x - 80, centre.y)
        await expect(undo).toBeEnabled()
        await undo.click()
        await expect(undo).toBeDisabled()
        await cdpPinch(page, cdp, centre.x, centre.y + 30)
        await expect(undo).toBeDisabled()
      })

      test('Clean up', async ({ page }) => {
        await setScale(page)
        await waitForAutoDetect(page)
        await page.keyboard.press('4')
        const remove = page.locator('.toolbar').getByRole('button', { name: /^Remove/ })
        await expect(remove).toHaveText('Remove')

        // pinch, lifting the fingers one after the other
        await cdpPinch(page, cdp, centre.x, centre.y)
        // pinch, then keep the second finger down and let it pan a little before lifting
        await cdpTouch(cdp, 'touchStart', [{ x: centre.x - 40, y: centre.y, id: 1 }, { x: centre.x + 40, y: centre.y, id: 2 }])
        await cdpTouch(cdp, 'touchEnd', [{ x: centre.x + 40, y: centre.y, id: 2 }])
        await page.waitForTimeout(30)
        await cdpTouch(cdp, 'touchMove', [{ x: centre.x + 41, y: centre.y + 1, id: 2 }])
        await cdpTouch(cdp, 'touchEnd', [])
        // a still press that is too long, a drag, and a cancelled touch
        await longPress(page, centre.x, centre.y)
        await cdpTouch(cdp, 'touchStart', [{ x: centre.x, y: centre.y, id: 1 }])
        await cdpTouch(cdp, 'touchMove', [{ x: centre.x + 30, y: centre.y, id: 1 }])
        await cdpTouch(cdp, 'touchEnd', [])
        await cdpTouch(cdp, 'touchStart', [{ x: centre.x, y: centre.y, id: 1 }])
        await page.waitForTimeout(40)
        await cdpTouch(cdp, 'touchCancel', [])
        await page.waitForTimeout(100)
        await expect(remove).toHaveText('Remove')

        // a quick still tap marks exactly one place
        await cdpTap(page, cdp, centre.x, centre.y)
        await expect(remove).toHaveText('Remove (1)')
        await cdpPinch(page, cdp, centre.x, centre.y + 30)
        await longPress(page, centre.x - 90, centre.y + 20)
        await page.waitForTimeout(100)
        await expect(remove).toHaveText('Remove (1)')
      })
    })

    test('the threshold slider previews live, detects on release, and Auto restores the original', async ({ page }) => {
      test.skip(vp.name !== 'desktop' && vp.name !== 'phone', 'covered at the other two widths')
      const errors = trackErrors(page)
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await waitForAutoDetect(page)
      const autoValue = await sliderValue(page)
      const autoCount = await countText(page)
      const autoDv50 = await lastDv50(page)
      expect(autoDv50).toBeGreaterThan(0)
      await expect(page.getByTestId('threshold-chip')).toHaveText('Auto')
      const redAuto = await redPixelCount(page)
      expect(redAuto).toBeGreaterThan(0)

      // drag the thumb to the left; hold the pointer down
      const slider = page.getByTestId('threshold-slider')
      const box = await slider.boundingBox()
      const y = box.y + box.height / 2
      const frac = (autoPct) => box.x + 14 + (box.width - 28) * ((autoPct - 1) / 99)
      const log0 = await engineLogLength(page)
      await page.mouse.move(frac(parseFloat(autoValue)), y)
      await page.mouse.down()
      await page.mouse.move(frac(30), y, { steps: 8 })
      await page.mouse.move(frac(20), y, { steps: 6 })

      // before the release: a preview was computed, the chip says Manual, the overlay changed, no detection ran yet
      const preview = await waitForEngineOp(page, 'thresholdPreview', log0)
      expect(preview.stale).toBe(false)
      await expect(page.getByTestId('threshold-chip')).toHaveText('Manual')
      await expect.poll(() => redPixelCount(page), { timeout: 10_000 }).not.toBe(redAuto)
      const log = await page.evaluate((i) => window.__grindEngineLog.slice(i).map((e) => e.op), log0)
      expect(log).not.toContain('analyze')
      const valueWhileDragging = await sliderValue(page)
      expect(parseFloat(valueWhileDragging)).toBeLessThan(parseFloat(autoValue))

      // release: the full detection runs, staying in Threshold, and the particle count follows
      await page.mouse.up()
      const entry = await waitForEngineOp(page, 'analyze', log0)
      await expect(page.getByTestId('threshold-count')).toHaveText(`${entry.nclusters.toLocaleString()} particle${entry.nclusters === 1 ? '' : 's'}`)
      await expect(page.locator('.step[data-step=threshold]')).toHaveAttribute('aria-current', 'step')
      expect(await sliderValue(page)).toBe(valueWhileDragging)
      expect(await lastDv50(page)).not.toBe(autoDv50) // the lower threshold measured the particles differently

      // Auto restores the original value and count
      const log1 = await engineLogLength(page)
      await page.getByTestId('threshold-auto').click()
      await waitForEngineOp(page, 'analyze', log1)
      await expect(page.getByTestId('threshold-chip')).toHaveText('Auto')
      await expect(page.getByTestId('threshold-value')).toHaveText(autoValue)
      await expect(page.getByTestId('threshold-count')).toHaveText(autoCount)
      expect(await lastDv50(page)).toBe(autoDv50)

      // Manual at the auto value gives the same count as Auto (keys: a step away and back again)
      const log2 = await engineLogLength(page)
      await page.getByRole('button', { name: 'Raise the threshold' }).click()
      await waitForEngineOp(page, 'analyze', log2) // debounced detection
      await expect(page.getByTestId('threshold-chip')).toHaveText('Manual')
      const log3 = await engineLogLength(page)
      await page.getByRole('button', { name: 'Lower the threshold' }).click()
      await waitForEngineOp(page, 'analyze', log3)
      await expect(page.getByTestId('threshold-chip')).toHaveText('Manual')
      await expect(page.getByTestId('threshold-value')).toHaveText(autoValue)
      await expect(page.getByTestId('threshold-count')).toHaveText(autoCount)
      expect(await lastDv50(page)).toBe(autoDv50) // bit-identical to Auto at the same percent
      expect(errors).toEqual([])
    })

    test('Enter detects again and Next still reaches Clean up', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScale(page)
      await waitForAutoDetect(page)
      const entry = await detect(page)
      expect(entry.nclusters).toBeGreaterThan(10)
      await expect(page.locator('.step[data-step=threshold]')).toHaveAttribute('aria-current', 'step') // Enter stays in Threshold
      await page.getByTestId('next-cleanup').click()
      await expect(page.locator('.step[data-step=erase]')).toHaveAttribute('aria-current', 'step')
    })
  })
}
