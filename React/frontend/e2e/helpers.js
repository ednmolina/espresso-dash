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

export const TOUCHING_FIXTURE = path.join(here, 'fixtures', 'touching.png')

export async function uploadFixture(page, file = FIXTURE) {
  await page.locator('input[type=file]:not([capture])').first().setInputFiles(file)
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

/**
 * Two clicks 200 image-px apart on the Scale step. The default reference is Custom 20 mm; pass
 * `{ preset: 'US Quarter' }` (or `{ mm: 24.26 }`) to measure against something else first. The second
 * click moves to the Threshold step, which detects on its own (see `detect`, `waitForAutoDetect`).
 */
export async function setScale(page, { preset, mm } = {}) {
  await page.keyboard.press('2')
  if (preset) await page.locator('[data-testid=scale-preset]').selectOption(preset)
  if (mm != null) await page.locator('[data-testid=scale-mm]').fill(String(mm))
  await clickImage(page, 100, 40)
  // The second click starts a detection by itself. On the cloud engine, listen for its /analyze response
  // before clicking, so `detect` can't miss a reply that lands before it starts waiting.
  if (isCloud(page)) {
    const pending = page.waitForResponse(isAnalyzeResponse)
    pending.catch(() => {}) // unused when a test never calls detect(); don't surface the page-close rejection
    pendingCloudAnalyze.set(page, pending)
  }
  await clickImage(page, 300, 40)
}

const pendingCloudAnalyze = new WeakMap()
const isAnalyzeResponse = (r) => r.url().includes('/analyze') && r.request().method() === 'POST'

/** True when the page was opened with ?engine=cloud (requests go to the Python backend). */
export function isCloud(page) {
  return /[?&]engine=cloud\b/.test(page.url())
}

/** Number of entries in the dev-only `window.__grindEngineLog` (see analyzerClient.js). */
export function engineLogLength(page) {
  return page.evaluate(() => (window.__grindEngineLog || []).length)
}

/**
 * Waits for an entry for `op` ('upload' | 'analyze' | 'erase' | ...) at index >= fromIndex in the engine log
 * and returns it ({op, ok, ms, nclusters?, summary?, error?}). Entries with ok = false only match with
 * `{ ok: false }`; `{ ok: null }` matches either.
 */
export async function waitForEngineOp(page, op, fromIndex = 0, { ok = true, timeout = 60_000 } = {}) {
  const handle = await page.waitForFunction(
    ({ op, fromIndex, ok }) => {
      const log = window.__grindEngineLog || []
      for (let i = fromIndex; i < log.length; i++) {
        if (log[i].op === op && (ok === null || !!log[i].ok === ok)) return log[i]
      }
      return null
    },
    { op, fromIndex, ok },
    { timeout },
  )
  return handle.jsonValue()
}

/** Waits for the detection that the Threshold step starts by itself and returns its engine log entry. */
export async function waitForAutoDetect(page, fromIndex = 0) {
  const entry = await waitForEngineOp(page, 'analyze', fromIndex)
  await expect(page.locator('.stat-hero-value')).toContainText(/\d/, { timeout: 60_000 })
  return entry
}

/**
 * On a phone the Threshold step keeps the results sheet collapsed to a one-line peek so the photo stays visible;
 * this presses its Show button (a no-op on other layouts, or when the results are already open).
 */
export async function showResults(page) {
  const toggle = page.locator('[data-testid=results-toggle]:visible').first()
  if ((await toggle.count()) && (await toggle.getAttribute('aria-label')) === 'Show results') await toggle.click()
}

/**
 * Presses Enter to detect and waits for the results. After `setScale` a detection is already running
 * (Enter is ignored while busy), so this resolves with that run; otherwise Enter starts a new one. Local engine: resolves with the engine log entry
 * ({nclusters, summary, ms}); cloud engine (?engine=cloud): with the /analyze response body.
 */
export async function detect(page) {
  if (isCloud(page)) {
    // Use the response `setScale` is already waiting for (the Threshold step's own detection); otherwise
    // press Enter to start one.
    let analyze = pendingCloudAnalyze.get(page)
    pendingCloudAnalyze.delete(page)
    if (!analyze) {
      analyze = page.waitForResponse(isAnalyzeResponse)
      await page.keyboard.press('Enter')
    }
    const res = await analyze
    expect(res.status()).toBe(200)
    await expect(page.locator('.stat-hero-value')).toContainText(/\d/, { timeout: 60_000 })
    await showResults(page)
    return res.json()
  }
  const from = await engineLogLength(page)
  await page.keyboard.press('Enter')
  const entry = await waitForEngineOp(page, 'analyze', from)
  await expect(page.locator('.stat-hero-value')).toContainText(/\d/, { timeout: 60_000 })
  await showResults(page)
  return entry
}

/** Parse the "N particles" count out of the results heading. */
export async function particleCount(page) {
  const text = await page.locator('.results-count').first().innerText()
  return Number(text.replace(/[^0-9]/g, ''))
}

/** Image-space position of a canvas point as page coordinates, for the current (possibly zoomed) view. */
export async function canvasBox(page) {
  return page.locator('canvas').first().boundingBox()
}

/**
 * Dispatches raw touch events through CDP (Playwright has no multi-touch API).
 * `points` = [{ x, y, id }, ...] in page coordinates; type is touchStart | touchMove | touchEnd | touchCancel.
 */
export async function cdpTouch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0, radiusX: 4, radiusY: 4, force: 1 })),
  })
}

/** A single-finger tap (press, hold `holdMs`, release) at page coordinates. */
export async function cdpTap(page, cdp, x, y, holdMs = 40) {
  await cdpTouch(cdp, 'touchStart', [{ x, y, id: 1 }])
  await page.waitForTimeout(holdMs)
  await cdpTouch(cdp, 'touchEnd', [])
}

/** Two fingers moving apart (pinch out) around (cx, cy), then lifting one finger after the other. */
export async function cdpPinch(page, cdp, cx, cy, { from = 30, to = 110, steps = 6 } = {}) {
  const at = (d) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }]
  await cdpTouch(cdp, 'touchStart', at(from))
  for (let i = 1; i <= steps; i++) {
    await cdpTouch(cdp, 'touchMove', at(from + ((to - from) * i) / steps))
    await page.waitForTimeout(16)
  }
  const d = to
  // lift the first finger (the second stays down briefly), then the second
  await cdpTouch(cdp, 'touchEnd', [{ x: cx + d, y: cy, id: 2 }])
  await page.waitForTimeout(40)
  await cdpTouch(cdp, 'touchEnd', [])
}

/** Number of strongly red pixels on the photo canvas (the threshold overlay paints coffee red). */
export function redPixelCount(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] > 180 && d[i] > d[i + 1] + 70 && d[i] > d[i + 2] + 70) n++
    return n
  })
}
