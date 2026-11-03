import { expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE = path.join(here, 'fixtures', 'grind.png')
// Image geometry of fixtures/grind.png (see make_fixture.py)
export const IMG = { w: 800, h: 600 }
export const GRID = {
  xs: [100, 220, 340, 460, 580, 700],
  ys: [120, 240, 360, 480],
}

export const HARNESS = '/e2e/harness/index.html'

/** Collect uncaught page errors and console errors so tests can assert none happened. */
export function trackErrors(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    // The sandbox/CI has no route to Firestore, map tiles or fonts; those failures are expected.
    if (/Failed to load resource|@firebase\/firestore|ERR_(FAILED|TUNNEL|INTERNET|NAME)/.test(text)) return
    errors.push(`console: ${text}`)
  })
  return errors
}

/**
 * Opens the harness. `query` is a query string such as '?empty=1' or '?calib=1'; `hash` is a route
 * such as '#/grinder'. See e2e/harness/main.jsx for the query params.
 */
export async function openHarness(page, query = '', hash = '') {
  // Firestore is never reachable in tests; fail fast so the app uses its cache.
  await page.route('**/firestore.googleapis.com/**', (r) => r.abort())
  await page.goto(`${HARNESS}${query}${hash}`)
}

export const WORKSPACE_ROOTS = {
  shots: '[data-testid=dashboard-app]',
  analyzer: '.analyzer-app',
  grinder: '[data-testid=grinder-page]',
  forecast: '[data-testid=forecast-page]',
  diagnostics: '[data-testid=diagnostics-page]',
}

/** Clicks the visible top-nav or phone tab-bar item for a workspace id and waits for its page root. */
export async function gotoWorkspace(page, id) {
  await page.locator(`[data-testid=nav-${id}]:visible, [data-testid=tabbar-${id}]:visible`).click()
  await expect(page.locator(WORKSPACE_ROOTS[id]).first()).toBeVisible()
}

export async function openAnalyzer(page, query = '') {
  await openHarness(page, query)
  await gotoWorkspace(page, 'analyzer')
}

/** Expands the Grinder points table (it shows 12 rows until "Show all N points" is pressed). */
export async function showAllPoints(page) {
  const more = page.getByRole('button', { name: /^Show all \d+ points$/ })
  if (await more.isVisible().catch(() => false)) await more.click()
}

/** Horizontal overflow of the document, in px (0 = none). */
export function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

export const CALIBRATION_IMPORT = path.join(here, 'fixtures', 'calibration.json')

export async function uploadFixture(page) {
  await page.locator('input[type=file]:not([capture])').first().setInputFiles(FIXTURE)
  const canvas = page.locator('canvas').first()
  await expect(canvas).toBeVisible()
  // the toolbar only exists once an image is loaded
  await expect(page.locator('.toolbar')).toBeVisible()
  await page.waitForTimeout(500) // fit-to-canvas settles
  return canvas
}

/** Maps image pixel coordinates to page coordinates for the freshly fitted (never upscaled) canvas. */
export async function imageToPage(page, x, y) {
  const bb = await page.locator('canvas').first().boundingBox()
  const z = Math.min(bb.width / IMG.w, bb.height / IMG.h, 1)
  return {
    x: bb.x + (bb.width - IMG.w * z) / 2 + x * z,
    y: bb.y + (bb.height - IMG.h * z) / 2 + y * z,
    zoom: z,
  }
}

export async function clickImage(page, x, y) {
  const p = await imageToPage(page, x, y)
  await page.mouse.click(p.x, p.y)
}

/** Two clicks 200 image-px apart on the coin step (default preset: US quarter, 24.26 mm). */
export async function setScale(page) {
  await page.keyboard.press('1')
  await clickImage(page, 100, 40)
  await clickImage(page, 300, 40)
}

export async function detect(page) {
  const analyze = page.waitForResponse((r) => r.url().includes('/analyze') && r.request().method() === 'POST')
  await page.keyboard.press('Enter')
  const res = await analyze
  expect(res.status()).toBe(200)
  await expect(page.locator('.stat-hero-value')).toContainText(/\d/, { timeout: 60_000 })
  return res.json()
}

/** Parse the "N particles" count out of the results heading. */
export async function particleCount(page) {
  const text = await page.locator('.results-count').first().innerText()
  return Number(text.replace(/[^0-9]/g, ''))
}
