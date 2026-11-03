// Opt-in timing of the touching-particle split on a 12 MP synthetic image (4000 x 3000, 6000 dark
// ellipses r = 4..22 px, as e2e/perf.spec.js draws).   SPLIT_PERF=1 npx vitest run split.perf
//
// It times splitTouching() alone against the whole analyze, and asserts the COMMON.md budget:
// the split phase plus the extra unsplit measurement stay well below +50% of the analyze time.
import { describe, expect, it } from 'vitest'
import { analyzeImageBlue, makeSettings } from '../detect.js'
import { splitTouching } from '../split.js'

function synth12() {
  const w = 4000
  const h = 3000
  const blue = new Uint8Array(w * h)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) blue[r * w + c] = Math.round(235 - 35 * Math.min(1, Math.hypot(c - w / 2, r - h / 2) / (w * 0.7)))
  }
  for (let i = 0; i < 6000; i++) {
    const rad = 4 + rnd() * 18
    const v = Math.round(30 + rnd() * 20)
    const cx = rnd() * w
    const cy = rnd() * h
    const e = 0.6 + rnd() * 0.4
    const th = rnd() * Math.PI
    const ct = Math.cos(th)
    const st = Math.sin(th)
    const R = Math.ceil(rad) + 1
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(h - 1, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(w - 1, Math.ceil(cx + R)); x++) {
        const X = x + 0.5 - cx
        const Y = y + 0.5 - cy
        const u = X * ct + Y * st
        const vv = -X * st + Y * ct
        if ((u / rad) ** 2 + (vv / (rad * e)) ** 2 <= 1) blue[y * w + x] = v
      }
    }
  }
  for (let i = 0; i < blue.length; i++) blue[i] = Math.max(0, Math.min(255, blue[i] + Math.round((rnd() - 0.5) * 6)))
  return { w, h, blue }
}

describe.skipIf(!process.env.SPLIT_PERF)('split performance (12 MP synthetic)', () => {
  it('splitTouching alone is a small fraction of the analyze time', () => {
    const { w, h, blue } = synth12()
    const settings = makeSettings({ pixel_scale: 100, reference_px_length: 1000 })
    const t0 = performance.now()
    const ds = analyzeImageBlue(Uint8Array.from(blue), h, w, settings).dataset
    const analyzeMs = performance.now() - t0
    splitTouching(ds, makeSettings({ ...settings, split_touching: true })) // warm-up
    const times = []
    let info
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      info = splitTouching(ds, makeSettings({ ...settings, split_touching: true })).info
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    const med = times[2]
    console.log(JSON.stringify({ analyze_ms: Math.round(analyzeMs), split_ms_median: +med.toFixed(1), pct: +(100 * med / analyzeMs).toFixed(1), ...info }))
    expect(info.clusters_split).toBeGreaterThan(0)
    expect(med).toBeLessThan(0.3 * analyzeMs)
  }, 120000)
})
