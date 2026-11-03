import { test, expect } from '@playwright/test'
import { openAnalyzer, uploadFixture, setScale, detect, gotoWorkspace, showAllPoints, trackErrors, openHarness } from './helpers.js'

const HIDDEN_KEY = 'espressoLab.analyzer.resultsHidden.v1'

async function analyze(page) {
  await uploadFixture(page)
  await setScale(page)
  await detect(page)
}

/** Selects 10E in the "Grind setting used" picker, on either layout (desktop chips or phone steppers). */
async function pick10E(page) {
  const chip = page.locator('[data-testid=grind-picker-micro-E]')
  if (await chip.isVisible().catch(() => false)) await chip.click()
  else await page.locator('[data-testid=grind-picker-macro-inc]').click() // first press of an empty picker sets 10E
  await expect(page.locator('[data-testid=grind-picker-value]')).toHaveText('10E')
}

test.describe('analyzer results card @ 1440px', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('hide shows a Dv50 pill, expand restores the card, and the choice survives a reload', async ({ page }) => {
    const errors = trackErrors(page)
    await openAnalyzer(page)
    await analyze(page)

    const card = page.locator('[data-testid=results-card]')
    await expect(card).toBeVisible()
    await expect(card.locator('.stat-hero-value')).toContainText(/\d/)
    await expect(card.locator('[data-testid=results-toggle]')).toHaveAttribute('aria-expanded', 'true')

    await card.locator('[data-testid=results-toggle]').click()
    const pill = page.locator('[data-testid=results-pill]')
    await expect(pill).toBeVisible()
    await expect(pill).toContainText(/Dv50\s*[\d,.]+\s*µm/)
    await expect(card).toBeHidden()
    expect(await page.evaluate((k) => localStorage.getItem(k), HIDDEN_KEY)).not.toBeNull()

    // reload: the hidden choice is remembered, so after the next detect the pill (not the card) is shown
    await page.reload()
    await gotoWorkspace(page, 'analyzer')
    await analyze(page)
    await expect(page.locator('[data-testid=results-pill]')).toBeVisible()
    await expect(page.locator('[data-testid=results-card]')).toBeHidden()

    await page.locator('[data-testid=results-pill]').click()
    await expect(page.locator('[data-testid=results-card]')).toBeVisible()
    await expect(page.locator('[data-testid=results-pill]')).toBeHidden()
    expect(errors).toEqual([])
  })

  test('the card never covers the toolbar or the zoom HUD', async ({ page }) => {
    await openAnalyzer(page)
    await analyze(page)
    await expect(page.locator('[data-testid=results-card]')).toBeVisible()
    await page.waitForTimeout(500) // spring-in animation
    const geo = await page.evaluate(() => {
      const r = (sel) => {
        const e = document.querySelector(sel)
        if (!e) return null
        const b = e.getBoundingClientRect()
        return { l: b.left, t: b.top, r: b.right, b: b.bottom }
      }
      const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t
      const card = r('[data-testid=results-card]')
      const toolbar = r('.toolbar')
      const hud = r('.hud-zoom')
      const cx = (hud.l + hud.r) / 2
      const cy = (hud.t + hud.b) / 2
      const top = document.elementFromPoint(cx, cy)
      return {
        overlapsToolbar: hit(card, toolbar),
        overlapsHud: hit(card, hud),
        hudOnTop: !!top?.closest('.hud-zoom'),
      }
    })
    expect(geo.overlapsToolbar).toBe(false)
    expect(geo.overlapsHud).toBe(false)
    expect(geo.hudOnTop).toBe(true)
  })

  test('Dv50 is shown with its confidence range and an expandable distribution', async ({ page }) => {
    await openAnalyzer(page)
    await analyze(page)
    const card = page.locator('[data-testid=results-card]')
    await expect(card).toContainText(/95% confidence/i)
    await expect(card.locator('.results-count')).toContainText(/particles/i)
    await card.locator('[data-testid=histogram-expand]').click()
    await expect(page.locator('[data-testid=histogram-full]')).toBeVisible()
  })

  test('picking 10E and saving adds a calibration point that the Grinder page shows', async ({ page }) => {
    const errors = trackErrors(page)
    await openHarness(page, '?calib=1')
    await gotoWorkspace(page, 'grinder')
    const rows = page.locator('[data-testid=cal-point-row]')
    await expect(rows.first()).toBeVisible()
    await showAllPoints(page)
    const before = await rows.count()

    await gotoWorkspace(page, 'analyzer')
    await analyze(page)
    const save = page.locator('[data-testid=save-calibration]')
    await expect(save).toBeDisabled() // no setting picked yet
    await pick10E(page)
    await expect(page.locator('[data-testid=grind-estimate]')).toContainText('10E')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(page.getByText(/Calibration point saved/)).toBeVisible()
    await expect(save).toBeDisabled() // already saved for this result

    await gotoWorkspace(page, 'grinder')
    await showAllPoints(page)
    await expect(rows).toHaveCount(before + 1)
    await expect(page.locator('[data-testid=converter-um]')).toContainText('µm')
    expect(errors).toEqual([])
  })
})

test.describe('analyzer results card @ 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the card is a bottom sheet that drags down to a pill and taps back up', async ({ page }) => {
    const errors = trackErrors(page)
    await openAnalyzer(page)
    await analyze(page)
    const card = page.locator('[data-testid=results-card]')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-detent', /^(pill|half|full)$/)

    const handle = card.locator('[data-testid=results-handle]')
    for (let i = 0; i < 3 && (await card.getAttribute('data-detent')) !== 'pill'; i++) {
      const box = await handle.boundingBox()
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y + 60, { steps: 5 })
      await page.mouse.move(x, y + 160, { steps: 5 })
      await page.mouse.up()
      await page.waitForTimeout(500)
    }
    await expect(card).toHaveAttribute('data-detent', 'pill')

    await card.click({ position: { x: 150, y: 24 } })
    await expect(card).toHaveAttribute('data-detent', 'half')
    expect(errors).toEqual([])
  })
})
