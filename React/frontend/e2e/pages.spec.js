import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { openHarness, gotoWorkspace, trackErrors, horizontalOverflow, showAllPoints, CALIBRATION_IMPORT } from './helpers.js'

/** The element with this testid if it is an <input>, else the first input inside it. */
async function inputOf(page, testId) {
  const el = page.locator(`[data-testid=${testId}]`).first()
  await expect(el).toBeVisible()
  const tag = await el.evaluate((n) => n.tagName)
  return tag === 'INPUT' ? el : el.locator('input').first()
}

test.describe('Grinder page @ 1440px', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('with calibration data: chart, converter, points table', async ({ page }) => {
    const errors = trackErrors(page)
    await openHarness(page, '?calib=1', '#/grinder')
    await expect(page.locator('[data-testid=grinder-page]')).toBeVisible()
    await expect(page.locator('[data-testid=cal-chart]')).toBeVisible()
    await expect(page.locator('[data-testid=cal-empty]')).toHaveCount(0)
    await expect(page.locator('[data-testid=converter-um]')).toContainText('µm')
    await expect(page.locator('[data-testid=converter-setting]')).toContainText(/[1-3]?\d[A-I]/)
    await expect(page.locator('[data-testid=cal-points]')).toBeVisible()
    await showAllPoints(page)
    // 4 seeded analyzer runs + 16 shot-log points
    await expect(page.locator('[data-testid=cal-point-row]')).toHaveCount(20)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })

  test('excluding a point flips its row and lowers the active count', async ({ page }) => {
    await openHarness(page, '?calib=1', '#/grinder')
    const rows = page.locator('[data-testid=cal-point-row]')
    await expect(rows.first()).toBeVisible()
    await showAllPoints(page)
    const toggles = page.locator('[data-testid=cal-exclude]')
    const exclude = toggles.filter({ hasText: /^\s*Exclude\s*$/ })
    const include = toggles.filter({ hasText: /^\s*Include\s*$/ })
    const excludedBefore = await include.count() // the seeded 11C run
    expect(excludedBefore).toBe(1)
    const activeBefore = await exclude.count()
    expect(activeBefore).toBe(19)

    const row = rows.filter({ has: exclude }).first()
    await row.locator('[data-testid=cal-exclude]').click()
    await expect(include).toHaveCount(excludedBefore + 1)
    await expect(exclude).toHaveCount(activeBefore - 1)

    // and back again
    await include.first().click()
    await expect(exclude).toHaveCount(activeBefore)
  })

  test('export downloads the calibration JSON', async ({ page }) => {
    await openHarness(page, '?calib=1', '#/grinder')
    await expect(page.locator('[data-testid=cal-export]')).toBeVisible()
    const download = page.waitForEvent('download')
    await page.locator('[data-testid=cal-export]').click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/\.json$/)
    const json = JSON.parse(fs.readFileSync(await file.path(), 'utf8'))
    expect(json.format).toBe('espressoLab.calibrationRuns')
    expect(json.runs).toHaveLength(4)
  })

  test('importing a file adds new runs and skips duplicates', async ({ page }) => {
    await openHarness(page, '?calib=1', '#/grinder')
    const rows = page.locator('[data-testid=cal-point-row]')
    await expect(rows.first()).toBeVisible()
    await showAllPoints(page)
    const before = await rows.count()
    const input = await (async () => {
      const el = page.locator('[data-testid=cal-import]').first()
      const tag = await el.evaluate((n) => n.tagName)
      return tag === 'INPUT' ? el : el.locator('input[type=file]')
    })()
    await input.setInputFiles(CALIBRATION_IMPORT)
    await expect(page.getByText(/Added 2/)).toBeVisible()
    await expect(page.getByText(/1 duplicate/)).toBeVisible()
    await expect(rows).toHaveCount(before + 2)
  })

  test('only shot-log points are used when there are no analyzer runs', async ({ page }) => {
    await openHarness(page, '?nocalib=1', '#/grinder')
    await expect(page.locator('[data-testid=cal-chart]')).toBeVisible()
    await expect(page.locator('[data-testid=cal-point-row]').first()).toBeVisible()
    await showAllPoints(page)
    await expect(page.locator('[data-testid=cal-point-row]')).toHaveCount(16)
  })

  test('no points at all shows the empty state', async ({ page }) => {
    await openHarness(page, '?empty=1&nocalib=1', '#/grinder')
    await expect(page.locator('[data-testid=cal-empty]')).toBeVisible()
    await expect(page.locator('[data-testid=cal-empty]')).toContainText(/No calibration points yet/i)
    await expect(page.locator('[data-testid=cal-point-row]')).toHaveCount(0)
  })
})

test.describe('Grinder page @ 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the converter swaps direction', async ({ page }) => {
    const errors = trackErrors(page)
    await openHarness(page, '?calib=1', '#/grinder')
    await expect(page.locator('[data-testid=grinder-page]')).toBeVisible()
    await expect(page.locator('[data-testid=converter-um]')).toBeVisible()
    await page.locator('[data-testid=converter-swap]').click()
    await expect(page.locator('[data-testid=converter-setting]')).toBeVisible()
    await page.locator('[data-testid=converter-swap]').click()
    await expect(page.locator('[data-testid=converter-um]')).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })
})

test.describe('Forecast page @ 1440px', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('pH starts blank, is validated, and the grind can be suggested', async ({ page }) => {
    const errors = trackErrors(page)
    await openHarness(page, '?calib=1', '#/forecast')
    await expect(page.locator('[data-testid=forecast-page]')).toBeVisible()
    await expect(page.locator('[data-testid=forecast-empty]')).toHaveCount(0)

    const ph = await inputOf(page, 'forecast-ph')
    await expect(ph).toHaveValue('')
    await expect(page.locator('[data-testid=forecast-extraction]')).toContainText(/\d/)
    await expect(page.locator('[data-testid=forecast-range]')).toContainText(/\d/)
    await expect(page.locator('[data-testid=forecast-odds]')).toContainText(/Great\s*\d+%/)

    await ph.fill('9')
    await expect(page.getByText(/pH must be between 3\.5 and 8\.0/)).toBeVisible()
    await ph.fill('')
    await expect(page.getByText(/pH must be between/)).toHaveCount(0)

    // move the grind away from the suggestion, then ask for the suggestion
    const value = page.locator('[data-testid=forecast-grind-value]')
    const inc = page.locator('[data-testid=forecast-grind-inc]')
    for (let i = 0; i < 8; i++) await inc.click()
    const moved = (await value.innerText()).trim()
    await page.locator('[data-testid=forecast-suggest]').click()
    await expect(value).not.toHaveText(moved)
    await expect(page.locator('[data-testid=forecast-extraction]')).toContainText(/\d/)
    expect(errors).toEqual([])
  })

  test('with no shots the page explains what is missing', async ({ page }) => {
    await openHarness(page, '?empty=1&nocalib=1', '#/forecast')
    await expect(page.locator('[data-testid=forecast-empty]')).toBeVisible()
    await expect(page.locator('[data-testid=forecast-empty]')).toContainText(/8 shots/)
  })
})

test.describe('Diagnostics page @ 1440px', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('tiles show numbers, the baseline, and the 5.2 pH warning', async ({ page }) => {
    const errors = trackErrors(page)
    await openHarness(page, '?calib=1', '#/diagnostics')
    await expect(page.locator('[data-testid=diagnostics-page]')).toBeVisible()
    await expect(page.locator('[data-testid=diag-empty]')).toHaveCount(0)
    for (const id of ['diag-mae', 'diag-r2', 'diag-within']) {
      const tile = page.locator(`[data-testid=${id}]`)
      await expect(tile).toBeVisible()
      await expect(tile).toContainText(/\d/)
      await expect(tile).toContainText(/Always your average/i)
    }
    await expect(page.locator('[data-testid=diag-headline]')).toContainText(/guessing your average/i)
    await expect(page.locator('[data-testid=diag-ph52]')).toContainText(/\b2 shots?\b/)
    await expect(page.locator('[data-testid=diag-ph52]')).toContainText('5.2')
    await expect(page.locator('[data-testid=diag-coverage]')).toBeVisible()
    await expect(page.locator('[data-testid=diag-scatter]')).toBeVisible()
    await expect(page.locator('[data-testid=diag-importance]')).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })

  test('with no shots coverage still renders and the empty state explains why', async ({ page }) => {
    await openHarness(page, '?empty=1&nocalib=1', '#/diagnostics')
    await expect(page.locator('[data-testid=diag-empty]')).toBeVisible()
    await expect(page.locator('[data-testid=diag-coverage]')).toBeVisible()
  })

  test('Shots, Forecast and Diagnostics link up through the nav', async ({ page }) => {
    await openHarness(page, '?calib=1')
    await gotoWorkspace(page, 'diagnostics')
    await gotoWorkspace(page, 'forecast')
    await gotoWorkspace(page, 'shots')
  })
})
