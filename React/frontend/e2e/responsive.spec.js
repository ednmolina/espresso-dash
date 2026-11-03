import { test, expect } from '@playwright/test'
import { openHarness, gotoWorkspace, horizontalOverflow, trackErrors, WORKSPACE_ROOTS } from './helpers.js'

const IDS = Object.keys(WORKSPACE_ROOTS) // shots, analyzer, grinder, forecast, diagnostics

const SIZES = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, phone: false },
  { name: 'tablet', viewport: { width: 1024, height: 1366 }, phone: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, phone: true, hasTouch: true },
]

for (const size of SIZES) {
  test.describe(`responsive shell @ ${size.name} ${size.viewport.width}px`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.hasTouch ?? false })

    test('shows the right navigation', async ({ page }) => {
      await openHarness(page, '?calib=1')
      await expect(page.locator('[data-testid=dashboard-app]')).toBeVisible()
      if (size.phone) {
        const bar = page.locator('nav.app-tabbar[data-testid=app-tabbar]')
        await expect(bar).toBeVisible()
        await expect(bar.getByRole('button')).toHaveCount(5)
        await expect(page.locator('nav.workspace-switcher')).toBeHidden()
        for (const id of IDS) await expect(page.locator(`[data-testid=tabbar-${id}]`)).toBeVisible()
      } else {
        const nav = page.locator('nav.workspace-switcher')
        await expect(nav).toBeVisible()
        await expect(nav.locator('.workspace-switch')).toHaveCount(5)
        await expect(page.locator('[data-testid=app-tabbar]')).toBeHidden()
        for (const id of IDS) await expect(page.locator(`[data-testid=nav-${id}]`)).toBeVisible()
      }
      // exactly one workspace is the current page
      await expect(page.locator('[data-testid^=nav-][aria-current=page]:visible, [data-testid^=tabbar-][aria-current=page]:visible')).toHaveCount(1)
    })

    test('every workspace opens without errors or horizontal overflow', async ({ page }) => {
      const errors = trackErrors(page)
      await openHarness(page, '?calib=1')
      await expect(page.locator('[data-testid=dashboard-app]')).toBeVisible()
      for (const id of IDS) {
        await gotoWorkspace(page, id)
        await page.waitForTimeout(400) // lazy chunk + layout settle
        expect(await horizontalOverflow(page), `${id} overflows horizontally`).toBeLessThanOrEqual(0)
        const current = page.locator(`[data-testid=nav-${id}][aria-current=page]:visible, [data-testid=tabbar-${id}][aria-current=page]:visible`)
        await expect(current).toHaveCount(1)
      }
      expect(errors).toEqual([])
    })

    test('the hash route opens a workspace directly', async ({ page }) => {
      await openHarness(page, '?calib=1', '#/forecast')
      await expect(page.locator(WORKSPACE_ROOTS.forecast)).toBeVisible()
      await gotoWorkspace(page, 'grinder')
      expect(new URL(page.url()).hash).toBe('#/grinder')
    })

    if (size.phone) {
      test('tab bar items are at least 44px tall', async ({ page }) => {
        await openHarness(page, '?calib=1')
        for (const id of IDS) {
          const box = await page.locator(`[data-testid=tabbar-${id}]`).boundingBox()
          expect(box.height, `tabbar-${id}`).toBeGreaterThanOrEqual(44)
          expect(box.width, `tabbar-${id}`).toBeGreaterThanOrEqual(44)
        }
        const bar = await page.locator('[data-testid=app-tabbar]').boundingBox()
        expect(bar.y + bar.height).toBeGreaterThan(844 - 4) // pinned to the bottom
      })

      for (const id of ['shots', 'forecast', 'grinder']) {
        test(`${id} fits one screen (no vertical page scroll)`, async ({ page }) => {
          await openHarness(page, '?calib=1')
          await gotoWorkspace(page, id)
          await page.waitForTimeout(600)
          const m = await page.evaluate(() => ({
            scrollHeight: document.documentElement.scrollHeight,
            inner: window.innerHeight,
          }))
          expect(m.scrollHeight, `${id} scrollHeight`).toBeLessThanOrEqual(m.inner + 4)
        })
      }

      test('the next-shot forecast is in the first viewport on Shots Overview', async ({ page }) => {
        await openHarness(page, '?calib=1')
        const card = page.locator('[data-testid=next-shot-forecast]')
        await expect(card).toBeVisible()
        const box = await card.boundingBox()
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.y + box.height).toBeLessThanOrEqual(844)
      })
    }
  })
}
