import { test, expect } from '@playwright/test'
import { openHarness, trackErrors } from './helpers.js'

const CACHE_KEY = 'espresso_dash_cached_shots_v1'
const SIZES = [{ width: 390, height: 844 }, { width: 1440, height: 900 }]

async function tabNames(page) {
  await expect(page.locator('.dashboard-tab').first()).toBeVisible()
  return page.locator('.dashboard-tab').allInnerTexts()
}

for (const size of SIZES) {
  test.describe(`dashboard @ ${size.width}px`, () => {
    test.use({ viewport: size })

    test('renders from cache quickly, goes offline, keeps the cache', async ({ page }) => {
      const t0 = Date.now()
      await openHarness(page)
      await expect(page.locator('.dashboard-app')).toBeVisible({ timeout: 2000 })
      expect(Date.now() - t0).toBeLessThan(8000) // sanity bound including dev-server transform time
      await expect(page.locator('[data-testid=shots-count]')).toContainText('48')
      await expect(page.locator('[data-sync-state="offline"]')).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(15_000)
      const n = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).shots.length, CACHE_KEY)
      expect(n).toBe(48)
    })

    test('every tab fits the viewport width', async ({ page }) => {
      await openHarness(page)
      await expect(page.locator('.dashboard-app')).toBeVisible()
      await expect(page.locator('.dashboard-tab').first()).toBeVisible()
      const count = await page.locator('.dashboard-tab').count()
      expect(count).toBeGreaterThanOrEqual(3)
      for (let i = 0; i < count; i++) {
        await page.locator('.dashboard-tab').nth(i).click()
        await page.waitForTimeout(300)
        const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))
        expect(w.s, `tab ${i}`).toBeLessThanOrEqual(w.c)
      }
    })

    test('chart text is legible', async ({ page }) => {
      await openHarness(page)
      await expect(page.locator('.dashboard-app')).toBeVisible()
      await expect(page.locator('.dashboard-tab').first()).toBeVisible()
      const count = await page.locator('.dashboard-tab').count()
      for (let i = 0; i < count; i++) {
        await page.locator('.dashboard-tab').nth(i).click()
        await page.waitForTimeout(300)
        const small = await page.evaluate(() => {
          const bad = []
          for (const t of document.querySelectorAll('.dashboard-chart text')) {
            const r = t.getBoundingClientRect()
            if (r.width > 0 && r.height < 10) bad.push(`${t.textContent} (${r.height.toFixed(1)}px)`)
          }
          return bad
        })
        expect(small, `tab ${i}`).toEqual([])
      }
    })

    test('no duplicate-key warnings, no nested panels, panels are spaced', async ({ page }) => {
      const messages = []
      page.on('console', (m) => messages.push(m.text()))
      const errors = trackErrors(page)
      await openHarness(page)
      await expect(page.locator('.dashboard-app')).toBeVisible()
      await expect(page.locator('.dashboard-tab').first()).toBeVisible()
      const count = await page.locator('.dashboard-tab').count()
      for (let i = 0; i < count; i++) {
        await page.locator('.dashboard-tab').nth(i).click()
        await page.waitForTimeout(300)
        await expect(page.locator('.dashboard-panel .dashboard-panel')).toHaveCount(0)
        const gaps = await page.evaluate(() => {
          const panels = [...document.querySelectorAll('.dashboard-tab-panel > .dashboard-panel')]
          const out = []
          for (let k = 1; k < panels.length; k++) {
            out.push(panels[k].getBoundingClientRect().top - panels[k - 1].getBoundingClientRect().bottom)
          }
          return out
        })
        for (const g of gaps) expect(g).toBeGreaterThanOrEqual(16)
      }
      expect(messages.filter((m) => m.includes('same key'))).toEqual([])
      expect(errors.filter((e) => e.startsWith('pageerror'))).toEqual([])
    })

    test('Ported-from-Streamlit dev copy is gone', async ({ page }) => {
      await openHarness(page)
      await expect(page.locator('.dashboard-app')).toBeVisible()
      await expect(page.getByText('Ported from the Streamlit')).toHaveCount(0)
    })
  })
}

test.describe('dashboard desktop details', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('empty cache and unreachable Firestore shows an error with Retry', async ({ page }) => {
    await openHarness(page, '?empty=1')
    await expect(page.locator('.dashboard-error')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.dashboard-error').getByRole('button', { name: /retry/i })).toBeVisible()
  })

  test('scatter legend toggles series with fixed colours', async ({ page }) => {
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    const legend = page.locator('.dashboard-legend-toggle')
    await expect(legend.first()).toBeVisible()
    const labels = (await legend.allInnerTexts()).map((s) => s.trim())
    for (const l of ['Bad', 'Good', 'Great']) expect(labels).toContain(l)
    const colours = await page.evaluate(() => {
      const out = {}
      for (const b of document.querySelectorAll('.dashboard-legend-toggle')) {
        const sw = b.querySelector('[class*=swatch], span, svg *')
        if (sw) out[b.textContent.trim()] = getComputedStyle(sw).backgroundColor !== 'rgba(0, 0, 0, 0)'
          ? getComputedStyle(sw).backgroundColor
          : getComputedStyle(sw).fill
      }
      return out
    })
    expect(colours.Bad).toBe('rgb(192, 80, 58)')
    expect(colours.Good).toBe('rgb(212, 160, 23)')
    expect(colours.Great).toBe('rgb(15, 143, 132)')

    const bad = legend.filter({ hasText: 'Bad' }).first()
    const points = page.locator('.dashboard-chart-point')
    const before = await points.count()
    await bad.click()
    await expect(bad).toHaveAttribute('aria-pressed', 'false')
    expect(await points.count()).toBeLessThan(before)
  })

  test('y tick labels are unique per axis', async ({ page }) => {
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    const dups = await page.evaluate(() => {
      const bad = []
      for (const chart of document.querySelectorAll('.dashboard-chart')) {
        const ticks = [...chart.querySelectorAll('.dashboard-axis-y text, text.dashboard-tick-y, [class*=tick-y]')]
          .map((t) => t.textContent.trim())
        if (new Set(ticks).size !== ticks.length) bad.push(ticks.join(','))
      }
      return bad
    })
    expect(dups).toEqual([])
  })

  test('hovering a point shows a tooltip', async ({ page }) => {
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    await page.locator('.dashboard-chart-point').first().hover({ force: true })
    await expect(page.locator('.dashboard-chart-tooltip').first()).toBeVisible()
  })

  test('bar rows keep their values inside the panel and truncated labels have titles', async ({ page }) => {
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    const names = await tabNames(page)
    for (let i = 0; i < names.length; i++) {
      await page.locator('.dashboard-tab').nth(i).click()
      await page.waitForTimeout(250)
      const res = await page.evaluate(() => {
        const bad = []
        for (const row of document.querySelectorAll('.dashboard-bar-row')) {
          const panel = row.closest('.dashboard-panel')
          const pb = panel.getBoundingClientRect()
          for (const child of row.children) {
            const r = child.getBoundingClientRect()
            if (r.right > pb.right + 1 || r.left < pb.left - 1) bad.push(`outside: ${child.textContent}`)
            if (child.scrollWidth > child.clientWidth + 1 && !child.title && !child.getAttribute('title')) {
              bad.push(`no title: ${child.textContent}`)
            }
          }
        }
        return bad
      })
      expect(res).toEqual([])
    }
  })

  test('map tiles are loaded or hidden', async ({ page }) => {
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    const names = await tabNames(page)
    const idx = names.findIndex((n) => /origin/i.test(n))
    if (idx >= 0) await page.locator('.dashboard-tab').nth(idx).click()
    await page.waitForTimeout(3000)
    const broken = await page.evaluate(() =>
      [...document.querySelectorAll('.dashboard-map-tile')].filter(
        (t) => t.naturalWidth === 0 && getComputedStyle(t).visibility !== 'hidden',
      ).length,
    )
    expect(broken).toBe(0)
  })
})

test.describe('dashboard shots workflow @ 1440px', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('Origins: filters change the row count; map and legend render', async ({ page }) => {
    const errors = trackErrors(page)
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    await page.locator('[data-testid=tab-origins]').click()
    await expect(page.locator('[data-testid=origins-map]')).toBeVisible()
    await expect(page.locator('[data-testid=map-legend]')).toBeVisible()
    // tile images may be blocked in CI/sandbox, so assert the elements rather than pixels
    expect(await page.locator('img.dashboard-map-tile').count()).toBeGreaterThan(0)
    await expect(page.locator('.dashboard-map-marker')).toHaveCount(48)

    const rows = page.locator('[data-testid=table-origins-log] tbody tr')
    await expect(rows).toHaveCount(48)
    const filter = page.locator('[data-testid=filter-roaster]')
    await filter.locator('.dashboard-chip-select-trigger').click()
    await filter.locator('.dashboard-chip-select-option input[type=checkbox]').first().check()
    await expect.poll(() => rows.count()).toBeLessThan(48)
    expect(await rows.count()).toBeGreaterThan(0)
    await expect(page.locator('[data-testid=table-origins-log]')).toContainText('of 48')
    expect(errors.filter((e) => e.startsWith('pageerror'))).toEqual([])
  })

  test('Log a shot sheet opens with an empty pH that is never prefilled', async ({ page }) => {
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    await page.locator('[data-testid=log-shot-open]').click()
    await expect(page.locator('[role=dialog]')).toBeVisible()
    await expect(page.locator('[data-testid=shot-form]')).toBeVisible()
    await expect(page.locator('[data-testid=ph-input]')).toHaveValue('')
    await expect(page.locator('[data-testid=ph-input]')).toHaveAttribute('placeholder', /5\.4/)
    await page.keyboard.press('Escape')
    await expect(page.locator('[role=dialog]')).toHaveCount(0)
  })

  test('pH coverage is shown against the total shot count', async ({ page }) => {
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    const coverage = page.locator('[data-testid=ph-coverage]:visible').first()
    await expect(coverage).toContainText('of 48')
    await expect(coverage).toContainText('12') // 12 of the 48 seeded shots have a pH
  })

  test('Experiments tab no longer shows a made-up R² metric', async ({ page }) => {
    await openHarness(page)
    await expect(page.locator('.dashboard-app')).toBeVisible()
    await page.locator('[data-testid=tab-experiments]').click()
    await expect(page.locator('.dashboard-tab-panel').first()).toBeVisible()
    await expect(page.getByText('Extraction R²')).toHaveCount(0)
    await expect(page.getByText(/Typical miss/i).first()).toBeVisible()
  })
})
