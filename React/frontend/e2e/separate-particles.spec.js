// Particle shape and "Separate touching particles": settings, results card (Mac, iPad, iPhone sheet),
// Diagnostics "Photo analysis checks", the Grinder "separated" chip and the ?engine=cloud guard.
// All on-device (no backend); the old-API stub covers the cloud request body.
import { test, expect } from '@playwright/test'
import {
  openAnalyzer, openHarness, gotoWorkspace, uploadFixture, setScaleAndArea, detect, showAllPoints, trackErrors,
  horizontalOverflow, TOUCHING_FIXTURE, clickImage, engineLogLength, waitForEngineOp,
} from './helpers.js'
import { installOldApi } from './stubs/oldApi.js'

const SIZES = [
  { name: 'Mac', viewport: { width: 1440, height: 900 }, phone: false },
  { name: 'iPad', viewport: { width: 1024, height: 1366 }, phone: false },
  { name: 'iPhone', viewport: { width: 390, height: 844 }, phone: true },
]

async function openSettings(page) {
  await page.locator('[data-testid=settings-open]').click()
  await expect(page.locator('[data-testid=split-toggle]')).toBeVisible()
}

async function closeSettings(page, phone) {
  if (phone) await page.locator('[data-testid=analyzer-settings-sheet]').getByRole('button', { name: 'Done' }).first().click()
  else await page.locator('.settings-popover').getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('[data-testid=split-toggle]')).toBeHidden()
  // focus returns to the Settings button, where Enter would reopen the settings instead of detecting
  await page.evaluate(() => document.activeElement?.blur?.())
}

async function analyzeTouching(page, { separate = false, phone = false } = {}) {
  await uploadFixture(page, TOUCHING_FIXTURE)
  if (separate) {
    await openSettings(page)
    await page.locator('[data-testid=split-toggle]').check()
    await closeSettings(page, phone)
  }
  await setScaleAndArea(page)
  return detect(page)
}

/** Asserts the element is inside the visible viewport and not clipped by the sheet or card. */
async function expectReachable(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  await expect(locator).toBeVisible()
  await expect.poll(async () => {
    const b = await locator.boundingBox()
    const vh = page.viewportSize().height
    return !!b && b.y >= 0 && b.y + b.height <= vh
  }).toBe(true)
}

for (const size of SIZES) {
  test.describe(`separate touching particles @ ${size.name} ${size.viewport.width}px`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.phone })

    test('the checkbox is off by default and the help text is there', async ({ page }) => {
      await openAnalyzer(page)
      await uploadFixture(page)
      await openSettings(page)
      const box = page.locator('[data-testid=split-toggle]')
      await expect(box).not.toBeChecked()
      await expect(box).toBeEnabled()
      await expect(page.getByText('Splits clumps at narrow necks · a little slower')).toBeVisible()
      // the existing quick-mode help is reworded, the new checkbox has its own help
      const helps = await page.locator('.analyzer-sidebar button.help-tip').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
      expect(helps.some((h) => h.startsWith('Separate touching particles: Cuts clumps where particles only touch at a narrow neck'))).toBe(true)
      expect(helps.some((h) => h.startsWith('Quick clustering: Skips the brightness-based pass'))).toBe(true)
      // Advanced: the ellipsoid option exists
      await page.locator('details.advanced summary').click()
      await expect(page.locator('select option[value=ellipsoid]')).toHaveCount(1)
      expect(await page.locator('select option[value=ellipsoid]').evaluate((o) => o.disabled)).toBe(false)
    })

    test('defaults: shape line shown, no split note, nothing wider than the screen', async ({ page }) => {
      const errors = trackErrors(page)
      await openAnalyzer(page)
      await uploadFixture(page)
      await setScaleAndArea(page)
      await detect(page)
      const shape = page.locator('[data-testid=shape-line]')
      await expect(shape).toContainText(/Shape\s+\d\.\d\d : 1/)
      await expect(shape).toHaveAttribute('title', /Volume-weighted median length-to-width ratio/)
      if (size.phone) {
        await expectReachable(page, shape) // reached by scrolling the sheet
        await expect(shape).toContainText(/· 80% \d\.\d\d–\d\.\d\d/)
      } else {
        await expect(shape).toBeVisible()
        await expect(shape).toContainText(/length to width · 80% between \d\.\d\d and \d\.\d\d/)
        // sits between the tiles and the fines note
        const order = await page.evaluate(() => {
          const card = document.querySelector('[data-testid=results-card]')
          const y = (sel) => card.querySelector(sel)?.getBoundingClientRect().top ?? null
          return { tiles: y('.stat-tiles'), shape: y('[data-testid=shape-line]'), fines: y('[data-testid=fines-note]') }
        })
        expect(order.shape).toBeGreaterThan(order.tiles)
        if (order.fines != null) expect(order.shape).toBeLessThan(order.fines)
      }
      await expect(page.locator('[data-testid=split-note]')).toHaveCount(0)
      expect(await horizontalOverflow(page)).toBe(0)
      expect(errors).toEqual([])
    })

    test('separation on: the split note appears after detect and says what was cut', async ({ page }) => {
      const errors = trackErrors(page)
      await openAnalyzer(page)
      const plain = await (async () => {
        await analyzeTouching(page, { phone: size.phone })
        return page.locator('.results-count').first().innerText()
      })()
      const off = Number(plain.replace(/[^0-9]/g, ''))
      await page.locator('[data-testid=split-note]').waitFor({ state: 'detached' })

      // second run on the same photo, separation on
      await openSettings(page)
      await page.locator('[data-testid=split-toggle]').check()
      await closeSettings(page, size.phone)
      await detect(page)
      const note = page.locator('[data-testid=split-note]')
      if (size.phone) await expectReachable(page, note)
      else await expect(note).toBeVisible()
      if (size.phone) await expect(note).toContainText(/Separated \d+ clumps → \d+ particles · Dv90 before [\d,]+ µm/)
      else await expect(note).toContainText(/Separated \d+ touching clumps into \d+ particles\. Dv90 before separating: [\d,]+ µm\./)
      const on = Number((await page.locator('.results-count').first().innerText()).replace(/[^0-9]/g, ''))
      expect(on).toBeGreaterThan(off)
      // the extra measurements
      await page.locator('details.card-details summary').click()
      await expect(page.locator('.metric', { hasText: 'Aspect ratio' })).toBeVisible()
      await expect(page.locator('.metric', { hasText: 'Dv90 unseparated' })).toContainText('at detection')
      // a clean-up does not change the note (analysis-time values)
      const text = await note.innerText()
      await page.keyboard.press('5')
      await page.keyboard.press('Escape')
      expect(await note.innerText()).toBe(text)
      expect(await horizontalOverflow(page)).toBe(0)
      expect(errors).toEqual([])
    })

    test('Diagnostics: empty state first, then the checks after an analysis', async ({ page }) => {
      const errors = trackErrors(page)
      await openHarness(page)
      await gotoWorkspace(page, 'diagnostics')
      if (size.phone) {
        await expect(page.locator('[data-testid=diag-open-checks]')).toContainText('Analyze a photo to see them')
        await page.locator('[data-testid=diag-open-checks]').click()
        await expect(page.locator('[data-testid=diag-photo-checks]')).toContainText('From your latest analysis on this device. Not saved.')
        await expect(page.locator('[data-testid=diag-photo-checks]')).toContainText('Analyze a photo to see these checks.')
        await page.locator('[data-testid=diag-sheet]').getByRole('button', { name: 'Back' }).click()
      } else {
        const card = page.locator('[data-testid=diag-photo-checks]')
        await expect(card).toContainText('Photo analysis checks')
        await expect(card).toContainText('From your latest analysis on this device. Not saved.')
        await expect(card.locator('[data-testid=diag-checks-empty]')).toHaveText('Analyze a photo to see these checks.')
      }

      // separation off
      await gotoWorkspace(page, 'analyzer')
      await analyzeTouching(page, { phone: size.phone })
      await gotoWorkspace(page, 'diagnostics')
      if (size.phone) {
        await expect(page.locator('[data-testid=diag-open-checks]')).toContainText(/Shape \d\.\d\d : 1 · separation off/)
        await page.locator('[data-testid=diag-open-checks]').click()
      }
      const checks = page.locator('[data-testid=diag-photo-checks]')
      await expect(checks).toContainText(/Typically\s+\d\.\d\d : 1 \(length to width\); 80% of the volume is between \d\.\d\d and \d\.\d\d\./)
      await expect(checks).toContainText(/From [\d,]+ particles of at least 20 px\./)
      await expect(checks.locator('[data-testid=diag-shape-range]')).toBeVisible()
      await expect(checks).toContainText('round 1.0')
      await expect(checks).toContainText('3.0 elongated')
      await expect(checks.locator('[data-testid=diag-split-off]')).toContainText('Turn on Separate touching particles in the Analyzer settings and detect again to compare Dv90 with and without it.')
      await expect(checks.locator('[data-testid=diag-split-table]')).toHaveCount(0)
      expect(await horizontalOverflow(page)).toBe(0)
      // "Open Analyzer" goes to the analyzer
      await checks.locator('[data-testid=diag-open-analyzer]').click()
      await expect(page.locator('.analyzer-app')).toBeVisible()

      // separation on
      await openSettings(page)
      await page.locator('[data-testid=split-toggle]').check()
      await closeSettings(page, size.phone)
      await detect(page)
      await gotoWorkspace(page, 'diagnostics')
      if (size.phone) {
        await expect(page.locator('[data-testid=diag-open-checks]')).toContainText(/Dv90 −[\d.]+% separated/)
        await page.locator('[data-testid=diag-open-checks]').click()
      }
      const on = page.locator('[data-testid=diag-photo-checks]')
      const table = on.locator('[data-testid=diag-split-table]')
      await expect(table).toBeVisible()
      if (size.phone) {
        await expect(table).toContainText(/Particles\s*[\d,]+ → [\d,]+/)
        await expect(table).toContainText(/Dv90\s*[\d,]+ → [\d,]+ µm\s*−[\d.]+%/)
      } else {
        await expect(table).toContainText('Not separated')
        await expect(table).toContainText('Separated')
        await expect(table.locator('tr', { hasText: 'Dv90' })).toContainText(/−[\d.]+%/)
      }
      await expect(on).toContainText('Separation lowers Dv90 when clumps are counted as one large particle. Points saved to the grinder curve while it is on are marked.')
      expect(await horizontalOverflow(page)).toBe(0)
      expect(errors).toEqual([])
    })
  })
}

test.describe('Photo analysis checks are in memory only', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('nothing is persisted: a reload empties the card and storage has no copy', async ({ page }) => {
    await openAnalyzer(page, '?nocalib=1')
    await analyzeTouching(page)
    await gotoWorkspace(page, 'diagnostics')
    await expect(page.locator('[data-testid=diag-shape-range]')).toBeVisible()
    const keys = await page.evaluate(() => Object.keys(localStorage))
    expect(keys.filter((k) => /analysis|photo|latest|shape|split/i.test(k))).toEqual([])
    await page.reload()
    await gotoWorkspace(page, 'diagnostics')
    await expect(page.locator('[data-testid=diag-checks-empty]')).toBeVisible()
  })
})

test.describe('Photo analysis checks follow the current photo and clean-up', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a new upload empties the Diagnostics checks until the new photo is analyzed', async ({ page }) => {
    const errors = trackErrors(page)
    await openAnalyzer(page, '?nocalib=1')
    await analyzeTouching(page)
    await gotoWorkspace(page, 'diagnostics')
    await expect(page.locator('[data-testid=diag-shape-range]')).toBeVisible()

    await gotoWorkspace(page, 'analyzer')
    await uploadFixture(page, TOUCHING_FIXTURE)
    await expect(page.locator('[data-testid=results-card-empty]')).toBeVisible()
    await gotoWorkspace(page, 'diagnostics')
    await expect(page.locator('[data-testid=diag-checks-empty]')).toBeVisible()
    await expect(page.locator('[data-testid=diag-shape-range]')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('after an erase the unseparated Dv90 is labelled "at detection, before clean-up"', async ({ page }) => {
    const errors = trackErrors(page)
    await openAnalyzer(page, '?nocalib=1')
    await uploadFixture(page, TOUCHING_FIXTURE)
    await openSettings(page)
    await page.locator('[data-testid=split-toggle]').check()
    await closeSettings(page, false)
    await setScaleAndArea(page)
    await detect(page)

    const note = page.locator('[data-testid=split-note]')
    await page.locator('details.card-details summary').click()
    const metric = page.locator('.metric', { hasText: 'Dv90 unseparated' })
    await expect(note).toContainText(/Dv90 before separating: [\d,]+ µm\./)
    await expect(metric).toContainText('at detection')
    await expect(metric).not.toContainText('before clean-up')

    // erase the disc at the centre of the first grid cell
    await page.keyboard.press('5')
    await clickImage(page, 110, 150)
    const from = await engineLogLength(page)
    await page.keyboard.press('Enter')
    await waitForEngineOp(page, 'erase', from)

    await expect(note).toContainText(/Dv90 before separating \(at detection, before clean-up\): [\d,]+ µm\./)
    await expect(metric).toContainText('at detection, before clean-up')

    await gotoWorkspace(page, 'diagnostics')
    await expect(page.locator('[data-testid=diag-photo-checks]')).toContainText('Figures are from detection, before clean-up.')
    expect(errors).toEqual([])
  })
})

test.describe('busy label while a split is running', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('shows "Separating touching particles…" during the split phase and not otherwise', async ({ page }) => {
    // Hold the worker's replies after the split phase back for a moment, so the label is on screen long
    // enough to observe (the fixture is tiny, the real split takes milliseconds).
    await page.addInitScript(() => {
      const Orig = window.Worker
      window.Worker = class extends Orig {
        constructor(...args) {
          super(...args)
          let handler = null
          let holdUntil = 0
          let chain = Promise.resolve()
          Object.defineProperty(this, 'onmessage', {
            configurable: true,
            get: () => handler,
            set: (h) => { handler = h },
          })
          this.addEventListener('message', (event) => {
            const d = event.data
            const hold = holdUntil // what applies to this message (the split start itself is not held)
            if (d && d.type === 'progress' && d.phase === 'split' && d.fraction < 1) holdUntil = performance.now() + 900
            const deliver = () => { if (handler) handler(event) }
            chain = chain.then(() => {
              const wait = hold - performance.now()
              return wait > 0 ? new Promise((r) => setTimeout(r, wait)).then(deliver) : deliver()
            })
          })
        }
      }
    })
    await page.addInitScript(() => {
      window.__busyLabels = []
      const seen = new Set()
      const record = () => {
        const el = document.querySelector('.busy-title')
        const text = el ? el.textContent : null
        if (text && !seen.has(text)) { seen.add(text); window.__busyLabels.push(text) }
      }
      new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true })
    })
    const errors = trackErrors(page)
    await openAnalyzer(page)
    await uploadFixture(page, TOUCHING_FIXTURE)

    // off: the label never changes
    await setScaleAndArea(page)
    await detect(page)
    const offLabels = await page.evaluate(() => window.__busyLabels.slice())
    expect(offLabels.join('|')).toContain('Detecting particles…')
    expect(offLabels.join('|')).not.toContain('Separating')

    // on: the label appears, and the busy card still says Detecting afterwards
    await page.evaluate(() => { window.__busyLabels.length = 0 })
    await openSettings(page)
    await page.locator('[data-testid=split-toggle]').check()
    await closeSettings(page, false)
    const run = page.keyboard.press('Enter')
    await expect(page.locator('.busy-title')).toHaveText('Separating touching particles…', { timeout: 30_000 })
    await expect(page.locator('[role=progressbar]')).toHaveAttribute('aria-label', 'Separating touching particles…')
    await expect(page.locator('.step[data-step=threshold] .spinner')).toBeVisible() // the Threshold step shows it is detecting
    await run
    await expect(page.locator('[data-testid=split-note]')).toBeVisible({ timeout: 30_000 })
    const onLabels = await page.evaluate(() => window.__busyLabels.slice())
    expect(onLabels).toContain('Separating touching particles…')
    expect(errors).toEqual([])
  })
})

test.describe('Grinder: "separated" chip', () => {
  for (const size of SIZES) {
    test(`a point saved with separation on is tagged and can be excluded @ ${size.name}`, async ({ page }) => {
      await page.setViewportSize(size.viewport)
      const errors = trackErrors(page)
      await openHarness(page, '?calib=1')
      await gotoWorkspace(page, 'analyzer')
      await analyzeTouching(page, { separate: true, phone: size.phone })
      const chip = page.locator('[data-testid=grind-picker-micro-E]')
      if (await chip.isVisible().catch(() => false)) await chip.click()
      else await page.locator('[data-testid=grind-picker-macro-inc]').click()
      await expect(page.locator('[data-testid=grind-picker-value]')).toHaveText('10E')
      const save = page.locator('[data-testid=save-calibration]')
      await save.scrollIntoViewIfNeeded()
      await save.click()
      await expect(page.getByText(/Calibration point saved/)).toBeVisible()

      // stored as an additive field, old seeded runs untouched
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('espressoLab.calibrationRuns.v1')))
      expect(stored.filter((r) => r.separated === true)).toHaveLength(1)
      expect(stored.filter((r) => !('separated' in r))).toHaveLength(4)

      await gotoWorkspace(page, 'grinder')
      if (size.phone) await page.locator('[data-testid=cal-open-points]').click() // the points list is a sheet
      else await showAllPoints(page)
      const chips = page.locator('[data-testid=cal-separated]')
      await expect(chips.first()).toBeVisible()
      await expect(chips.first()).toHaveText('separated')
      const row = page.locator('[data-testid=cal-point-row]').filter({ has: page.locator('[data-testid=cal-separated]') }).first()
      const state = size.phone ? row.locator('[data-excluded]') : row // on the phone the flag is on the inner row
      await expect(state).toHaveAttribute('data-excluded', 'false')
      await row.locator('[data-testid=cal-exclude]').click()
      await expect(state).toHaveAttribute('data-excluded', 'true')
      expect(await horizontalOverflow(page)).toBe(0)
      expect(errors).toEqual([])
    })
  }

  test('runs without the tag show no chip', async ({ page }) => {
    await openHarness(page, '?calib=1', '#/grinder')
    await expect(page.locator('[data-testid=grinder-page]')).toBeVisible()
    await showAllPoints(page)
    await expect(page.locator('[data-testid=cal-separated]')).toHaveCount(0)
  })
})

test.describe('?engine=cloud has no separation options', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the checkbox and the ellipsoid option are disabled with a hint', async ({ page }) => {
    await openHarness(page, '?engine=cloud')
    await gotoWorkspace(page, 'analyzer')
    await page.locator('[data-testid=settings-open]').click()
    const box = page.locator('[data-testid=split-toggle]')
    await expect(box).toBeDisabled()
    await expect(box).not.toBeChecked()
    await expect(page.locator('[data-testid=split-cloud-hint]')).toHaveText('On-device analysis only')
    await page.locator('details.advanced summary').click()
    expect(await page.locator('select option[value=ellipsoid]').evaluate((o) => o.disabled)).toBe(true)
  })

  test('the /analyze request carries none of the new options, even if they were set', async ({ page }) => {
    const api = await installOldApi(page)
    await openAnalyzer(page, '?engine=cloud')
    await uploadFixture(page)
    await setScaleAndArea(page)
    await detect(page)
    const analyze = api.calls.find((c) => c.path === '/analyze')
    expect(analyze).toBeTruthy()
    const body = typeof analyze.body === 'string' ? JSON.parse(analyze.body) : analyze.body
    expect('split_touching' in body).toBe(false)
    expect('split_neck_ratio' in body).toBe(false)
    expect(body.volume_model).toBe('legacy')
    // and the old server's result shows no shape line
    await expect(page.locator('[data-testid=shape-line]')).toHaveCount(0)
    await expect(page.locator('[data-testid=split-note]')).toHaveCount(0)
  })
})
