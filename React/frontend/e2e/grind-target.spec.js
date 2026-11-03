import { test, expect } from '@playwright/test'
import { openHarness, gotoWorkspace, trackErrors, horizontalOverflow } from './helpers.js'

const SIZES = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, phone: false },
  { name: 'tablet', viewport: { width: 1024, height: 1366 }, phone: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, phone: true, hasTouch: true },
]

const TARGET_KEY = 'espressoLab.grindTarget.v1'
const targetNumber = (text) => Number(/(\d+\.\d)%/.exec(text)?.[1])

for (const size of SIZES) {
  test.describe(`grind target @ ${size.name} ${size.viewport.width}px`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.hasTouch ?? false })

    test('Forecast toggle changes the target line and the suggestion; Shots shows the same target; it persists', async ({ page }) => {
      const errors = trackErrors(page)
      await openHarness(page, '?calib=1&great=1&learn=1', '#/forecast')
      await expect(page.locator('[data-testid=forecast-page]')).toBeVisible()
      const line = page.locator('[data-testid=forecast-target-line]')
      const note = page.locator('[data-testid=forecast-suggest-note]')
      const grind = page.locator('[data-testid=forecast-grind-value]')

      // default: 20%
      await expect(page.locator('[data-testid=forecast-target-fixed]')).toHaveAttribute('aria-checked', 'true')
      await expect(line).toContainText('20%')
      await page.locator('[data-testid=forecast-suggest]').click()
      await expect(note).toContainText(/Suggested \d+[A-I]/)
      await expect(note).toContainText(/expected \d+\.\d%/)
      const fixedNote = (await note.innerText()).trim()
      const fixedGrind = (await grind.innerText()).trim()

      // best for this coffee: the harness adds 4 Great shots of the latest coffee
      await page.locator('[data-testid=forecast-target-best]').click()
      await expect(page.locator('[data-testid=forecast-target-best]')).toHaveAttribute('aria-checked', 'true')
      await expect(note).toHaveCount(0) // a stale suggestion is cleared
      await expect(line).toContainText(/Target \d+\.\d% · average of your \d+ Great shots of /)
      const bestText = await line.innerText()
      const target = targetNumber(bestText)
      expect(Number.isFinite(target)).toBe(true)
      expect(target).not.toBe(20)
      expect(await page.evaluate((k) => localStorage.getItem(k), TARGET_KEY)).toBe('best')

      await page.locator('[data-testid=forecast-suggest]').click()
      await expect(note).toContainText(/Suggested \d+[A-I]/)
      const bestNote = (await note.innerText()).trim()
      expect(bestNote).not.toBe(fixedNote)
      expect((await grind.innerText()).trim()).not.toBe(fixedGrind)

      // Shots: the next-shot card uses the same target
      await gotoWorkspace(page, 'shots')
      const shotsTarget = page.locator('[data-testid=next-shot-target]')
      await expect(shotsTarget).toBeVisible()
      expect(targetNumber(await shotsTarget.innerText())).toBe(target)
      await expect(page.locator('[data-testid=next-shot-forecast]')).toContainText(/Suggested grind\s*\d+[A-I]/)

      // it survives a reload
      await page.reload()
      await expect(page.locator('[data-testid=dashboard-app]')).toBeVisible()
      expect(targetNumber(await page.locator('[data-testid=next-shot-target]').innerText())).toBe(target)
      await gotoWorkspace(page, 'forecast')
      await expect(page.locator('[data-testid=forecast-target-best]')).toHaveAttribute('aria-checked', 'true')
      await expect(line).toContainText(`Target ${target.toFixed(1)}%`)

      // and back to 20%: the Shots card follows
      await page.locator('[data-testid=forecast-target-fixed]').click()
      await expect(line).toContainText('20%')
      await gotoWorkspace(page, 'shots')
      expect(targetNumber(await page.locator('[data-testid=next-shot-target]').innerText())).toBe(20)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })

    test('with too few Great shots of the coffee it says it is using all Great shots', async ({ page }) => {
      await openHarness(page, '?calib=1', '#/forecast')
      await expect(page.locator('[data-testid=forecast-page]')).toBeVisible()
      await page.locator('[data-testid=forecast-target-best]').click()
      await expect(page.locator('[data-testid=forecast-target-line]'))
        .toContainText(/Not enough Great shots of this coffee — using all your Great shots \(\d+\)/)
    })

    test('the fixed target reads as in the mockups; the Aim-for group is named', async ({ page }) => {
      await openHarness(page, '?calib=1', '#/forecast')
      await expect(page.locator('[data-testid=forecast-page]')).toBeVisible()
      await expect(page.locator('[data-testid=forecast-target-line]')).toHaveText(
        size.phone ? 'Target 20% · middle of the usual 18–22%' : 'Target 20%: the middle of the usual 18–22% range',
      )
      const group = page.getByRole('radiogroup', { name: 'Aim for' })
      await expect(group).toBeVisible()
      await expect(group.getByRole('radio')).toHaveCount(2)
      if (size.phone) {
        for (const id of ['fixed', 'best']) {
          expect((await page.locator(`[data-testid=forecast-target-${id}]`).boundingBox()).height).toBeGreaterThanOrEqual(44)
        }
      }
    })

    test('without a learned grind effect the suggest button falls back to the closest shot to the target', async ({ page }) => {
      await openHarness(page, '?calib=1', '#/forecast')
      await expect(page.locator('[data-testid=forecast-page]')).toBeVisible()
      await page.locator('[data-testid=forecast-suggest]').click()
      await expect(page.locator('[data-testid=forecast-suggest-note]')).toContainText(/closest shot to 20\.0% used \d+[A-I]/)
      await page.locator('[data-testid=forecast-target-best]').click()
      await page.locator('[data-testid=forecast-suggest]').click()
      await expect(page.locator('[data-testid=forecast-suggest-note]')).toContainText(/closest shot to \d+\.\d% used/)
    })

    test('Diagnostics shows the Grind suggestions and Precision cards', async ({ page }) => {
      const errors = trackErrors(page)
      await openHarness(page, '?calib=1', '#/diagnostics')
      await expect(page.locator('[data-testid=diagnostics-page]')).toBeVisible()
      if (size.phone) {
        const precisionRow = page.locator('[data-testid=diag-open-precision]')
        await expect(precisionRow).toBeVisible()
        await expect(precisionRow).toContainText('Measurement precision')
        const row = page.locator('[data-testid=diag-open-grind-suggestions]')
        await row.scrollIntoViewIfNeeded()
        await expect(row).toContainText('Grind suggestions')
        await row.click()
        const sheet = page.locator('[data-testid=diag-sheet]')
        await expect(sheet).toBeVisible()
        await expect(sheet.locator('[data-testid=diag-grind-suggestions], [data-testid=diag-grind-suggestions-empty]')).toBeVisible()
        await expect(sheet).toContainText('Each past shot replayed')
        await sheet.getByRole('button', { name: 'Back' }).click()
        await precisionRow.click()
        await expect(sheet.locator('[data-testid=diag-precision]')).toBeVisible()
        await expect(sheet.locator('[data-testid=diag-precision-empty]')).toBeVisible()
      } else {
        const gs = page.locator('[data-testid=diag-grind-suggestions], [data-testid=diag-grind-suggestions-empty]')
        await expect(gs).toBeVisible()
        await expect(gs).toContainText('Grind suggestions')
        await expect(gs).toContainText('Each past shot replayed: what would the app have suggested from earlier shots only?')
        await expect(page.locator('[data-testid=diag-precision]')).toBeVisible()
        await expect(page.locator('[data-testid=diag-precision-empty]')).toBeVisible()
        // side by side
        const a = await page.locator('[data-testid=diag-precision]').boundingBox()
        const b = await gs.boundingBox()
        if (size.viewport.width >= 1024) expect(Math.abs(a.y - b.y)).toBeLessThan(4)
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })

    test('Diagnostics fills the Grind suggestions card once the forecast learns grind', async ({ page }) => {
      await openHarness(page, '?calib=1&learn=1&follow=1', '#/diagnostics')
      await expect(page.locator('[data-testid=diagnostics-page]')).toBeVisible()
      if (size.phone) {
        const row = page.locator('[data-testid=diag-open-grind-suggestions]')
        await row.scrollIntoViewIfNeeded()
        await expect(row).toContainText(/Followed: \d+\.\d% from target/)
        await row.click()
      }
      const card = page.locator('[data-testid=diag-grind-suggestions]')
      await expect(card).toBeVisible()
      await expect(page.locator('[data-testid=diag-grind-suggestions-empty]')).toHaveCount(0)
      await expect(card.locator('[data-testid=diag-gs-followed]')).toContainText(/Followed \(±1 step\)/)
      await expect(card.locator('[data-testid=diag-gs-not-followed]')).toContainText(/Didn't follow/)
      await expect(card.locator('[data-testid=diag-gs-followed]')).toContainText(/median from target/)
      await expect(card.locator('[data-testid=diag-gs-followed]')).toContainText(/% within ±1%/)
    })
  })
}

test.describe('grind target @ narrow phone 320px', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true })

  test('the Aim-for row wraps instead of overflowing, and every control stays reachable', async ({ page }) => {
    await openHarness(page, '?calib=1&great=1', '#/forecast')
    await expect(page.locator('[data-testid=forecast-page]')).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    const vw = 320
    for (const sel of ['forecast-target-fixed', 'forecast-target-best', 'forecast-suggest']) {
      const box = await page.locator(`[data-testid=${sel}]`).boundingBox()
      expect(box.x, sel).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, sel).toBeLessThanOrEqual(vw)
      expect(box.height, sel).toBeGreaterThanOrEqual(44)
    }
    await page.locator('[data-testid=forecast-target-best]').click()
    await expect(page.locator('[data-testid=forecast-target-best]')).toHaveAttribute('aria-checked', 'true')
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  })
})
