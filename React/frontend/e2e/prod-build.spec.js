// Production-build smoke test: the analyzer worker chunk must load from the GitHub Pages base path.
//
// `vite build` with VITE_GITHUB_PAGES_BASE=/espresso-dash/ (the real vite.config.js, the harness page as
// entry because the real entry needs Firebase auth), served by `vite preview`, then a detection on the
// fixture photo. Checks that the built analysis Web Worker was started from /espresso-dash/assets/, that
// detection finishes, and that no /api request was made.
import { test, expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gotoWorkspace, uploadFixture, setScale, trackErrors } from './helpers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const vite = path.join(frontend, 'node_modules', 'vite', 'bin', 'vite.js')
const config = path.join(here, 'vite.smoke.config.js')
const BASE = '/espresso-dash/'
const PORT = Number(process.env.E2E_PREVIEW_PORT || 4179)

const env = {
  ...process.env,
  NODE_ENV: 'production',
  VITE_GITHUB_PAGES_BASE: BASE,
  VITE_FIREBASE_API_KEY: 'e2e-dummy',
  VITE_FIREBASE_AUTH_DOMAIN: 'e2e.example.com',
  VITE_FIREBASE_PROJECT_ID: 'e2e-dummy',
  VITE_FIREBASE_APP_ID: 'e2e-dummy',
}

let outDir
let preview

test.describe('production build under /espresso-dash/', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'espresso-smoke-'))
    execFileSync(process.execPath, [vite, 'build', '--config', config], {
      cwd: frontend, env: { ...env, E2E_SMOKE_OUT: outDir }, stdio: 'pipe', timeout: 200_000,
    })
    preview = spawn(process.execPath, [vite, 'preview', '--config', config, '--port', String(PORT), '--strictPort'], {
      cwd: frontend, env: { ...env, E2E_SMOKE_OUT: outDir }, stdio: 'pipe',
    })
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        const res = await fetch(`http://localhost:${PORT}${BASE}e2e/harness/index.html`)
        if (res.ok) break
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('vite preview did not start')
      await new Promise((r) => setTimeout(r, 250))
    }
  })

  test.afterAll(() => {
    if (preview?.pid) { try { process.kill(preview.pid) } catch { /* already gone */ } }
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true })
  })

  test('the built worker loads and detects with no /api requests', async ({ page }) => {
    const errors = trackErrors(page)
    const apiCalls = []
    page.on('request', (r) => { if (new URL(r.url()).pathname.includes('/api/')) apiCalls.push(r.url()) })
    const workers = []
    page.on('worker', (w) => workers.push(w.url()))
    const failed = []
    page.on('response', (r) => { if (r.status() >= 400 && r.url().includes(BASE)) failed.push(`${r.status()} ${r.url()}`) })

    await page.route('**/firestore.googleapis.com/**', (r) => r.abort())
    await page.goto(`http://localhost:${PORT}${BASE}e2e/harness/index.html`)
    await gotoWorkspace(page, 'analyzer')
    await uploadFixture(page)
    await setScale(page)
    await page.keyboard.press('Enter')
    await expect(page.locator('.stat-hero-value')).toContainText(/\d/, { timeout: 60_000 })
    await expect(page.locator('.results-count').first()).toContainText(/\d/)

    expect(workers.length).toBeGreaterThan(0)
    for (const url of workers) expect(new URL(url).pathname).toMatch(/^\/espresso-dash\/assets\/.+\.js$/)
    expect(failed).toEqual([])
    expect(apiCalls).toEqual([])
    expect(errors).toEqual([])
  })
})
