// Repeatability: 3 saved runs -> Repeatability block -> "Save repeat check" -> kept in localStorage.
// The detection is run on-device (default engine); the maths is client-side, so ?engine=cloud behaves the same.
import { test, expect } from '@playwright/test'
import {
  openAnalyzer, uploadFixture, setScaleAndArea, detect, engineLogLength, waitForEngineOp, showResults, trackErrors,
  horizontalOverflow, TOUCHING_FIXTURE,
} from './helpers.js'

const KEY = 'espressoLab.repeatChecks.v1'

const SIZES = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, phone: false },
  { name: 'tablet', viewport: { width: 1024, height: 1366 }, phone: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, phone: true, hasTouch: true },
]

/** Picks 10E in the "Grind setting used" picker, on either layout (desktop chips or phone steppers). */
async function pick10E(page) {
  const chip = page.locator('[data-testid=grind-picker-micro-E]')
  if (await chip.isVisible().catch(() => false)) await chip.click()
  else await page.locator('[data-testid=grind-picker-macro-inc]').click() // first press of an empty picker sets 10E
  await expect(page.locator('[data-testid=grind-picker-value]')).toHaveText('10E')
}

/** Nudges the threshold (a different detection of the same photo) and waits for it. */
async function redetect(page, label) {
  const from = await engineLogLength(page)
  await page.getByRole('button', { name: label }).click()
  await waitForEngineOp(page, 'analyze', from)
  await showResults(page)
}

for (const size of SIZES) {
  test.describe(`repeat check @ ${size.name}`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.hasTouch ?? false })

    test('3 saved runs show Repeatability; Save repeat check is kept on this device', async ({ page }) => {
      const errors = trackErrors(page)
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScaleAndArea(page)
      await detect(page)

      const save = page.getByRole('button', { name: /^save run/i })
      await expect(save).toHaveText('Save run (0/5)')
      await save.click()
      // one run: no Repeatability block yet
      await expect(page.locator('[data-testid=repeatability]')).toHaveCount(0)
      // the same analysis is already saved: it can't be saved again (it would count one photo twice)
      await expect(save).toBeDisabled()
      await expect(page.locator('[data-testid=save-run-reason]')).toHaveText('Already saved')

      await redetect(page, 'Raise the threshold')
      await expect(save).toBeEnabled() // a new detection is a new photo reading
      await expect(page.locator('[data-testid=save-run-reason]')).toHaveCount(0)
      await save.click()
      await expect(save).toHaveText('Save run (2/5)')
      await expect(page.locator('[data-testid=repeatability]')).toBeVisible()

      await redetect(page, 'Lower the threshold')
      await redetect(page, 'Lower the threshold')
      await save.click()
      await expect(save).toHaveText('Save run (3/5)')

      const block = page.locator('[data-testid=repeatability]')
      await expect(block).toBeVisible()
      await expect(block).toContainText('Mean ± SD across 3 photos of the same sample')
      for (const key of ['dv10', 'dv50', 'dv90']) {
        await expect(block.locator(`[data-testid=repeat-${key}]`)).toContainText(/µm\s*±\s*[\d,]+\s*CV \d+\.\d%/)
      }
      await expect(block.locator('[data-testid=repeat-claim]')).toContainText(/One photo is typically within ±\d+(\.\d)?% \(Dv50\)\./)
      await expect(block).toContainText('Stir or reshuffle the grounds between photos.')
      await expect(block).toContainText('Numbers only, kept on this device')
      // Compare runs keeps working next to it
      await expect(page.getByRole('button', { name: 'Compare runs' })).toBeVisible()

      await pick10E(page)
      const saveCheck = block.locator('[data-testid=save-repeat-check]')
      await expect(saveCheck).toBeEnabled()
      if (size.phone) expect((await saveCheck.boundingBox()).height).toBeGreaterThanOrEqual(44)
      await saveCheck.click()
      await expect(page.getByText(/Repeat check saved \(3 photos · 10E\)/)).toBeVisible()
      await expect(saveCheck).toBeDisabled() // same set of runs

      const readStored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), KEY)
      let stored = await readStored()
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ grindSetting: '10E', excluded: false })
      expect(stored[0].runs).toHaveLength(3)
      for (const r of stored[0].runs) {
        expect(r.dv10_um).toBeGreaterThan(0)
        expect(r.dv50_um).toBeGreaterThan(r.dv10_um)
        expect(r.dv90_um).toBeGreaterThan(r.dv50_um)
      }

      // a fourth run: saving again UPDATES the same check (same id) instead of adding an overlapping one
      const firstId = stored[0].id
      await redetect(page, 'Raise the threshold')
      await save.click()
      await expect(save).toHaveText('Save run (4/5)')
      await expect(saveCheck).toBeEnabled()
      await expect(saveCheck).toHaveText('Update repeat check')
      await saveCheck.click()
      await expect(page.getByText(/Repeat check updated \(4 photos · 10E\)/)).toBeVisible()
      await expect(saveCheck).toBeDisabled()
      stored = await readStored()
      expect(stored).toHaveLength(1)
      expect(stored[0].id).toBe(firstId)
      expect(stored[0].runs).toHaveLength(4)

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

      // reload: the updated check is still there
      await page.reload()
      stored = await readStored()
      expect(stored).toHaveLength(1)
      expect(stored[0].id).toBe(firstId)
      expect(stored[0].runs).toHaveLength(4)
      expect(errors).toEqual([])
    })
  })
}

test.describe('repeat check limits', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('Save run stops at 5 and identical readings show no spread', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    await setScaleAndArea(page)
    await detect(page)
    const save = page.getByRole('button', { name: /^save run/i })
    await save.click()
    await expect(save).toBeDisabled() // this analysis is saved already
    await expect(page.locator('[data-testid=save-run-reason]')).toHaveText('Already saved')
    // Raise then Lower returns to the same threshold: a new detection (own analysis id) with identical numbers
    for (let i = 2; i <= 5; i++) {
      await redetect(page, 'Raise the threshold')
      await redetect(page, 'Lower the threshold')
      await save.click()
    }
    await expect(save).toHaveText('Save run (5/5)')
    await expect(save).toBeDisabled()
    await expect(page.locator('[data-testid=repeatability]')).toBeVisible()
    await expect(page.locator('[data-testid=repeatability]')).toContainText('across 5 photos')
    // identical photos: no spread at all
    await expect(page.locator('[data-testid=repeat-dv50]')).toContainText('CV 0.0%')

    // five runs, five colours, never cycled; each also has its own line style (colour alone can't separate 5 lines)
    const swatches = async (selector) => page.locator(selector).evaluateAll((els) => els.map((el) => {
      const line = el.querySelector('line')
      return `${line.getAttribute('stroke')}|${line.getAttribute('stroke-dasharray') ?? 'solid'}`
    }))
    const inTable = await swatches('.saved-runs-table .run-swatch')
    expect(inTable).toHaveLength(5)
    expect(new Set(inTable.map((x) => x.split('|')[0])).size).toBe(5)
    expect(new Set(inTable.map((x) => x.split('|')[1])).size).toBe(5)
    await page.getByRole('button', { name: 'Compare runs' }).click()
    await expect(page.locator('.histogram-legend-item')).toHaveCount(5)
    await expect(page.locator('.histogram-legend-item').nth(4)).toContainText('Run 5')
    expect(await swatches('.histogram-legend .run-swatch')).toEqual(inTable)
    // runs 2-5 are drawn as lines with their dash pattern
    await expect(page.locator('.histogram-chart svg path[stroke-dasharray]')).toHaveCount(4)
  })
})

test.describe('repeat check on different samples', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a big Dv50 spread warns that the photos look like different samples; same-sample runs do not', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    await setScaleAndArea(page)
    await detect(page)
    const save = page.getByRole('button', { name: /^save run/i })
    await save.click()
    await redetect(page, 'Raise the threshold')
    await save.click()
    const block = page.locator('[data-testid=repeatability]')
    await expect(block).toBeVisible()
    await expect(block.locator('[data-testid=repeat-warning]')).toHaveCount(0)

    // a different grind photographed
    await uploadFixture(page, TOUCHING_FIXTURE)
    await setScaleAndArea(page)
    await detect(page)
    await save.click()
    await expect(save).toHaveText('Save run (3/5)')
    const warning = block.locator('[data-testid=repeat-warning]')
    await expect(warning).toHaveText('These look like different samples — repeat checks should be photos of the same grind.')
    // still saveable: the warning informs, it does not block
    await expect(block.locator('[data-testid=save-repeat-check]')).toBeEnabled()
  })
})

const CHECKS = [
  { id: 'a', createdAt: '2026-11-02T12:00:00.000Z', grindSetting: '10E', excluded: false, runs: [450, 470, 485, 460] },
  { id: 'b', createdAt: '2026-10-28T12:00:00.000Z', grindSetting: '10C', excluded: false, runs: [500, 520, 510] },
].map((c) => ({ ...c, runs: c.runs.map((v) => ({ dv10_um: v / 2, dv50_um: v, dv90_um: v * 1.8, n_particles: 4000 })) }))

// The Diagnostics "Measurement precision" card (mounted by DiagnosticsPage; a phone opens it from a list row).
for (const size of SIZES.filter((s) => s.name !== 'tablet')) {
  test.describe(`Diagnostics precision card @ ${size.name}`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.hasTouch ?? false })

    async function openCard(page) {
      await page.locator('[data-testid=nav-diagnostics]:visible, [data-testid=tabbar-diagnostics]:visible').click()
      await expect(page.locator('[data-testid=diagnostics-page]')).toBeVisible()
      if (size.phone) await page.locator('[data-testid=diag-open-precision]').click()
    }

    test('empty state without checks', async ({ page }) => {
      await openAnalyzer(page)
      await openCard(page)
      await expect(page.locator('[data-testid=diag-precision-empty]')).toHaveText(
        'Save a repeat check in the Analyzer (2+ photos of the same sample) to see this.',
      )
      if (size.phone) await expect(page.locator('[data-testid=diag-open-precision]')).toContainText('No repeat checks yet')
    })

    test('pooled precision and the dot strip from saved checks', async ({ page }) => {
      const errors = trackErrors(page)
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value)
      }, [KEY, JSON.stringify(CHECKS)])
      await openAnalyzer(page)
      if (size.phone) {
        await page.locator('[data-testid=tabbar-diagnostics]').click()
        await expect(page.locator('[data-testid=diag-open-precision]')).toContainText(/Dv50 ±\d+% per photo · 2 checks/)
        await page.locator('[data-testid=diag-open-precision]').click()
      } else {
        await openCard(page)
      }
      await expect(page.locator('[data-testid=diag-precision-dv50]')).toHaveText(/^±\d+%$/)
      await expect(page.locator('[data-testid=diag-precision]')).toContainText('From 2 repeat checks · 7 photos')
      const strip = page.locator('[data-testid=diag-precision-strip]')
      await expect(strip).toHaveAttribute('role', 'img')
      await expect(strip).toHaveAttribute('aria-label', /Dv50 of each photo.*10E, 10C/)
      await expect(strip.locator('.el-prec-dot')).toHaveCount(7)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })

    test('each repeat check can be excluded and included; the pooled numbers follow', async ({ page }) => {
      const errors = trackErrors(page)
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value)
      }, [KEY, JSON.stringify(CHECKS)])
      await openAnalyzer(page)
      if (size.phone) await page.locator('[data-testid=tabbar-diagnostics]').click()
      else await openCard(page)
      const row = page.locator('[data-testid=diag-open-precision]')
      if (size.phone) {
        await expect(row).toContainText('2 checks')
        await row.click()
      }
      const items = page.locator('[data-testid=diag-precision-check]')
      await expect(items).toHaveCount(2)
      await expect(page.locator('[data-testid=diag-precision]')).toContainText('From 2 repeat checks · 7 photos')
      const exclude = items.nth(0).locator('[data-testid=diag-precision-exclude]')
      if (size.phone) expect((await exclude.boundingBox()).height).toBeGreaterThanOrEqual(44)
      await expect(items.nth(0)).toHaveAttribute('data-excluded', 'false')
      await expect(page.locator('[data-testid=diag-precision-excluded]')).toHaveCount(0)

      await exclude.click()
      // dimmed AND labelled: the row says "Excluded" in words, not only by colour
      await expect(items.nth(0)).toHaveAttribute('data-excluded', 'true')
      await expect(items.nth(0).locator('[data-testid=diag-precision-excluded]')).toHaveText('Excluded')
      await expect(items.nth(0).locator('[data-testid=diag-precision-exclude]')).toHaveText('Include')
      await expect(page.locator('[data-testid=diag-precision]')).toContainText('From 1 repeat check · 3 photos')
      await expect(page.locator('[data-testid=diag-precision-strip] .el-prec-dot')).toHaveCount(3)
      let stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY)
      expect(stored.filter((c) => c.excluded)).toHaveLength(1)
      expect(stored).toHaveLength(2) // nothing is deleted

      // excluding the other leaves the list so they can be included again
      await items.nth(1).locator('[data-testid=diag-precision-exclude]').click()
      await expect(page.locator('[data-testid=diag-precision-empty]')).toContainText('Every repeat check is excluded')
      await expect(items).toHaveCount(2)

      await items.nth(0).locator('[data-testid=diag-precision-exclude]').click() // Include
      await expect(items.nth(0)).toHaveAttribute('data-excluded', 'false')
      await expect(page.locator('[data-testid=diag-precision]')).toContainText('From 1 repeat check')
      stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY)
      expect(stored.filter((c) => c.excluded)).toHaveLength(1)

      if (size.phone) {
        // the list row behind the sheet follows the change without a reload
        await page.locator('[data-testid=diag-sheet]').getByRole('button', { name: 'Back' }).click()
        await expect(row).toContainText('1 check')
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })
  })
}
