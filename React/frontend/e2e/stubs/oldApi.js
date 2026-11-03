// Stub for the OLD analyzer backend (main @ e299811): same endpoints and response shapes, but
// - /analyze has no dv10/dv50/dv90, no analysis_id and no *_layer_b64 (only opaque *_overlay_b64),
// - /histogram returns a matplotlib PNG (no series/edges),
// - /preview/* and /health do not exist (404).
// The frontend must work against it, and must never call /preview or /health.
import { readFileSync } from 'node:fs'
import { FIXTURE, GRID } from '../helpers.js'

const PNG_B64 = readFileSync(FIXTURE).toString('base64')

const PARTICLES = GRID.ys.flatMap((y, row) =>
  GRID.xs.map((x, col) => ({
    ID: row * GRID.xs.length + col,
    surface: 150 + col * 3,
    roundness: 0.9,
    short_axis: 6.5,
    long_axis: 8.5,
    volume: 1500,
    xmean: x,
    ymean: y,
  })),
)

function summaryFor(particles) {
  return {
    cluster_count: particles.length,
    diameter_mean_mm: 0.512,
    diameter_std_mm: 0.121,
    surface_mean_mm2: 0.31,
    surface_std_mm2: 0.09,
    surface_quality: 3.4,
    average_extraction_yield_pct: 19.4,
    extraction_yield_std_pct: 2.1,
    average_efficiency_pct: 62.0,
  }
}

const HIST_STATS = {
  mean: 512, mean_upper: 531, mean_lower: 493,
  median: 498, median_upper: 515, median_lower: 481,
}

/**
 * Routes every `/api/*` request of `page` to the old-backend stub.
 * Returns `{ calls }`: every request made, as `{ method, path, body }` (path without the `/api` prefix),
 * so tests can assert that `/preview` and `/health` were never requested.
 */
export async function installOldApi(page, { mismatch = false } = {}) {
  const calls = []
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request()
      const path = new URL(req.url()).pathname.replace(/^\/api/, '')
      let body = null
      try {
        body = req.postDataJSON()
      } catch {
        body = null // multipart upload
      }
      calls.push({ method: req.method(), path, body })

      if (req.method() === 'POST' && path === '/upload') {
        return json(route, {
          image_id: 'old-image-1',
          width: mismatch ? 801 : 800,
          height: 600,
          image_b64: PNG_B64,
          reference_objects: { 'US Quarter': 24.26, 'US Dime': 17.91 },
        })
      }
      if (req.method() === 'POST' && path === '/analyze') {
        return json(route, {
          threshold_overlay_b64: PNG_B64,
          cluster_overlay_b64: PNG_B64,
          background_median: 0.92,
          nclusters: PARTICLES.length,
          pixel_scale: 8.25,
          analysis_scale: 1,
          summary: summaryFor(PARTICLES),
          particles: PARTICLES,
        })
      }
      if (req.method() === 'POST' && path === '/erase') {
        const already = body?.already_removed_ids ?? []
        const next = PARTICLES.find((p) => !already.includes(p.ID))
        const removed = next ? [...already, next.ID] : already
        const left = PARTICLES.filter((p) => !removed.includes(p.ID))
        return json(route, {
          removed_ids: removed,
          nclusters: left.length,
          cluster_overlay_b64: PNG_B64,
          summary: left.length ? summaryFor(left) : null,
          particles: left,
        })
      }
      if (req.method() === 'POST' && path === '/histogram') {
        return json(route, { histogram_b64: PNG_B64, unit: '$\\mu$m', scale: 1000, ...HIST_STATS })
      }
      if (req.method() === 'POST' && path === '/histogram/compare') {
        const runs = body?.runs ?? [{}, {}]
        return json(route, {
          histogram_b64: PNG_B64,
          per_run: runs.map((r, i) => ({ label: r.label || `Run ${i + 1}`, ...HIST_STATS })),
          combined: { mean_of_means: 512, median_of_medians: 498, std_of_means: 0 },
        })
      }
      // /preview/*, /health and anything else did not exist on the old backend
      return json(route, { detail: 'Not Found' }, 404)
    },
  )
  return { calls }
}
