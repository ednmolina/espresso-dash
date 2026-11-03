// Performance probe for a 12 MP photo, skipped unless E2E_PERF=1:
//   E2E_PERF=1 npx playwright test -c e2e/playwright.config.js perf
// The CPU is throttled 4x as a stand-in for a phone. Target: <= 3 s unthrottled, assert < 20 s throttled.
import { test, expect } from '@playwright/test'
import { openAnalyzer, waitForEngineOp, engineLogLength } from './helpers.js'

test.skip(process.env.E2E_PERF !== '1', 'set E2E_PERF=1 to run the performance probe')

const W = 4000
const H = 3000

test('12 MP photo: upload to results', async ({ page }) => {
  test.setTimeout(180_000)
  await openAnalyzer(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })

  const t0 = Date.now()
  // Build the photo in the page (canvas + random dark ellipses) and hand it to the file input.
  await page.evaluate(async ([w, h]) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    const g = ctx.createRadialGradient(w / 2, h / 2, h / 8, w / 2, h / 2, w * 0.7)
    g.addColorStop(0, '#ebebeb')
    g.addColorStop(1, '#c8c8c8')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    let seed = 12345
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < 6000; i++) {
      const r = 4 + rnd() * 18
      ctx.fillStyle = `rgb(${80 + rnd() * 30},${50 + rnd() * 20},${30 + rnd() * 20})`
      ctx.beginPath()
      ctx.ellipse(rnd() * w, rnd() * h, r, r * (0.6 + rnd() * 0.4), rnd() * Math.PI, 0, 2 * Math.PI)
      ctx.fill()
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'perf.png', { type: 'image/png' }))
    const input = document.querySelector('input[type=file]:not([capture])')
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, [W, H])
  const synthMs = Date.now() - t0

  const tUpload = Date.now()
  await expect(page.locator('.toolbar')).toBeVisible({ timeout: 120_000 })
  await waitForEngineOp(page, 'upload', 0, { timeout: 120_000 })
  const uploadMs = Date.now() - tUpload
  await page.waitForTimeout(500)

  // Scale: two clicks 1/5 of the image width apart, on the fitted canvas
  const bb = await page.locator('canvas').first().boundingBox()
  const z = Math.min(bb.width / W, bb.height / H, 1)
  const at = (x, y) => ({
    x: bb.x + (bb.width - W * z) / 2 + x * z,
    y: bb.y + (bb.height - H * z) / 2 + y * z,
  })
  await page.keyboard.press('2')
  for (const [x, y] of [[500, 200], [1300, 200]]) {
    const p = at(x, y)
    await page.mouse.click(p.x, p.y)
  }

  // The second tap opens the Area step; "Use whole photo" is what starts the detection
  const from = await engineLogLength(page)
  const tDetect = Date.now()
  await page.getByTestId('whole-photo').click()
  const entry = await waitForEngineOp(page, 'analyze', from, { timeout: 150_000 })
  await expect(page.locator('.stat-hero-value')).toContainText(/\d/, { timeout: 60_000 })
  const detectMs = Date.now() - tDetect
  const totalMs = uploadMs + detectMs

  const log = await page.evaluate(() => window.__grindEngineLog)
  console.log(JSON.stringify({
    perf: '12MP, 4x CPU throttle',
    synth_ms: synthMs, upload_ms: uploadMs, detect_ms: detectMs, total_ms: totalMs,
    nclusters: entry.nclusters,
    engine_log: log.map(({ op, ok, ms }) => ({ op, ok, ms })),
    timings_ms: entry.timings_ms ?? null,
  }))
  expect(totalMs).toBeLessThan(20_000)
})
