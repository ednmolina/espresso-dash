import { test, expect } from '@playwright/test'
import {
  openAnalyzer, uploadFixture, setScale, detect, clickImage, imageToPage,
  particleCount, trackErrors, GRID, engineLogLength, waitForEngineOp, waitForAutoDetect,
} from './helpers.js'

test.describe('analyzer workflow', () => {
  test('upload, scale, detect, histogram, erase, save, compare', async ({ page }) => {
    const errors = trackErrors(page)
    await openAnalyzer(page)
    await uploadFixture(page)
    await setScale(page)

    const body = await detect(page)
    expect(body.nclusters).toBeGreaterThan(10)
    await expect(page.locator('.stat-hero-value')).toContainText(/\d.*µm/)

    // histogram appears without an extra click
    await expect(page.locator('.histogram-chart svg').first()).toBeVisible({ timeout: 15_000 })

    // erase the particle at the grid centre
    const before = await particleCount(page)
    await page.keyboard.press('4')
    await clickImage(page, GRID.xs[2], GRID.ys[1])
    const from = await engineLogLength(page)
    await page.keyboard.press('Enter')
    await waitForEngineOp(page, 'erase', from)
    await expect.poll(() => particleCount(page)).toBeLessThan(before)

    // save two runs and compare
    const save = page.getByRole('button', { name: /save run/i })
    await save.click()
    await expect(page.getByText(/saved/i).first()).toBeVisible()
    await save.click()
    await page.getByRole('button', { name: /compare/i }).first().click()
    await expect(page.locator('.compare-summary')).toBeVisible({ timeout: 30_000 })

    expect(errors).toEqual([])
  })

  test('Threshold is unavailable until the scale is set, then detects by itself', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    const thresholdStep = page.locator('.step[data-step=threshold]')
    await expect(thresholdStep).toBeDisabled()
    const from = await engineLogLength(page)
    await page.keyboard.press('Enter') // no scale: detecting is refused, not started
    await page.waitForTimeout(300)
    expect(await engineLogLength(page)).toBe(from)
    await setScale(page)
    await waitForAutoDetect(page, from)
    await expect(thresholdStep).toHaveAttribute('aria-current', 'step')
  })
})

test.describe('analyzer UI acceptance', () => {
  test('no horizontal overflow, toolbar stays on one row', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    await setScale(page)
    await detect(page)
    // Threshold is a taller card by design (steps, then the control); Clean up keeps the one-row toolbar.
    for (const step of ['3', '4']) {
    await page.keyboard.press(step)
    for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h })
      await page.waitForTimeout(250)
      const overflow = await page.evaluate(() => {
        const bad = []
        if (document.documentElement.scrollWidth > window.innerWidth) bad.push('document')
        for (const el of document.querySelectorAll('.results-column *, .toolbar *, .histogram-stat-row')) {
          if (!(el instanceof SVGElement) && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow === 'visible' && el.clientWidth > 0) {
            bad.push(`${el.tagName}.${String(el.className?.baseVal ?? el.className)}`)
          }
        }
        return bad
      })
      expect(overflow, `overflow at ${w}px, step ${step}`).toEqual([])
      if (w >= 1280 && step === '4') {
        const tb = await page.evaluate(() => {
          const t = document.querySelector('.toolbar')
          const tops = [...t.children].map((c) => c.offsetTop)
          return { h: t.getBoundingClientRect().height, spread: Math.max(...tops) - Math.min(...tops) }
        })
        expect(tb.h, `toolbar height at ${w}`).toBeLessThanOrEqual(56)
        expect(tb.spread, `toolbar row spread at ${w}`).toBeLessThanOrEqual(4)
      }
    }
    }
  })

  test('overlay toggle lives on the canvas as a radiogroup', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    await setScale(page)
    await detect(page)
    await expect(page.locator('.canvas-area .overlay-btns[role=radiogroup]')).toBeVisible()
  })

  test('stepper states are exclusive and disabled buttons look disabled', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    await setScale(page)
    await detect(page)
    await page.keyboard.press('2')
    await expect(page.locator('.step[aria-current="step"]')).toHaveCount(1)
    await expect(page.locator('.step[data-step=reference]')).toHaveAttribute('aria-current', 'step')
    const thresholdStep = page.locator('.step[data-step=threshold]')
    await expect(thresholdStep).not.toHaveAttribute('aria-current', 'step')
    const bg = await thresholdStep.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).not.toBe('rgb(212, 135, 74)')

    await page.keyboard.press('4')
    const primary = page.locator('.btn-primary:disabled').first()
    await expect(primary).toBeVisible()
    const style = await primary.evaluate((el) => {
      const s = getComputedStyle(el)
      return { opacity: s.opacity, bg: s.backgroundColor }
    })
    expect(style.opacity).toBe('1')
    expect(style.bg).not.toBe('rgb(212, 135, 74)')
  })

  test('zoom HUD', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    const hud = page.locator('.hud-zoom')
    await expect(hud).toBeVisible()
    const pct = hud.locator('button', { hasText: /%$/ })
    const before = await pct.innerText()
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect(pct).not.toHaveText(before)
    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible()
    await expect(hud.getByRole('button', { name: 'Fit' })).toBeVisible()
    await expect(hud.getByRole('button', { name: '1:1' })).toBeVisible()
  })

  test('coin guide circle is drawn after the first click', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    await page.keyboard.press('2')
    await page.locator('[data-testid=scale-preset]').selectOption('US Quarter') // a coin draws the circle, a ruler a line
    const p1 = await imageToPage(page, 200, 300)
    const p2 = await imageToPage(page, 360, 300)
    await page.mouse.click(p1.x, p1.y)
    await page.mouse.move(p2.x, p2.y, { steps: 4 })
    await page.waitForTimeout(150)
    const found = await page.evaluate(([a, b]) => {
      const c = document.querySelector('canvas')
      const r = c.getBoundingClientRect()
      const sx = c.width / r.width
      const cx = ((a.x + b.x) / 2 - r.left) * sx
      const cy = ((a.y + b.y) / 2 - r.top) * sx
      const rad = (Math.hypot(b.x - a.x, b.y - a.y) / 2) * sx
      const ctx = c.getContext('2d')
      // top of the circle (perpendicular to the diameter, which is horizontal here)
      const d = ctx.getImageData(Math.round(cx) - 6, Math.round(cy - rad) - 6, 13, 13).data
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0 && d[i] > 150 && d[i] > d[i + 1] + 50 && d[i] > d[i + 2] + 50) return true
      }
      return false
    }, [p1, p2])
    expect(found).toBe(true)
  })

  test('keyboard shortcut sheet', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    await page.keyboard.press('Shift+Slash')
    await expect(page.locator('[role=dialog].kbd-sheet')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[role=dialog].kbd-sheet')).toBeHidden()
  })

  test('busy state while detecting', async ({ page }) => {
    await openAnalyzer(page, '?engineDelay=1200')
    await uploadFixture(page)
    await setScale(page) // Threshold detects on its own
    await expect(page.locator('.canvas-area[aria-busy="true"]')).toBeVisible()
    await expect(page.locator('.canvas-area').getByText(/Detecting particles/)).toBeVisible()
    await expect(page.locator('.stat-hero-value')).toContainText(/\d/, { timeout: 30_000 })
    await expect(page.locator('.canvas-area[aria-busy="true"]')).toHaveCount(0)
  })

  test('sliders have a fill, steps show focus, hints are readable', async ({ page }) => {
    await openAnalyzer(page)
    await uploadFixture(page)
    await setScale(page)
    await detect(page)

    const ranges = await page.locator('input[type=range]').evaluateAll((els) => els.map((e) => e.style.getPropertyValue('--fill')))
    expect(ranges.length).toBeGreaterThan(0)
    for (const f of ranges) expect(f).toMatch(/%$/)

    await page.locator('.step').first().focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    const shadow = await page.locator('.step').first().evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow).not.toBe('none')

    const ratio = await page.evaluate(() => {
      const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number)
      const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const hint = document.querySelector('.metric-hint')
      if (!hint) return null
      const probe = document.createElement('div')
      probe.style.background = 'var(--dk-surface-2)'
      document.querySelector('.analyzer-app').appendChild(probe)
      const bg = parse(getComputedStyle(probe).backgroundColor)
      probe.remove()
      const fgc = parse(getComputedStyle(hint).color)
      const a = fgc.length > 3 ? fgc[3] : 1
      const fg = [0, 1, 2].map((i) => fgc[i] * a + bg[i] * (1 - a))
      const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x)
      return (l1 + 0.05) / (l2 + 0.05)
    })
    expect(ratio).not.toBeNull()
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
})
