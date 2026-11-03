// Parity tests for background.js against numpy (expected values generated with the venv python;
// the generating script is reproduced at the bottom of this file as a comment).
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { flattenBlue, halfContrastPercent } from '../background.js'
import { mulberry32 } from '../prng.js'

// Deterministic synthetic image shared with the Python generator (same mulberry32 stream).
function makeImage(rows, cols, seed) {
  const u = mulberry32(seed)
  const img = new Float64Array(rows * cols)
  for (let i = 0; i < rows; i++) {
    const r = i / rows
    for (let j = 0; j < cols; j++) {
      const c = j / cols
      const illum = ((170.0 + 60.0 * c) - (40.0 * r) * r) + (25.0 * c) * r
      img[i * cols + j] = illum
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) img[i * cols + j] += Math.floor(u() * 14) - 7
  }
  const nb = Math.max(8, Math.floor((rows * cols) / 4000))
  for (let b = 0; b < nb; b++) {
    const cy = Math.trunc(u() * rows)
    const cx = Math.trunc(u() * cols)
    const rad = 3 + Math.trunc(u() * 6)
    for (let y = Math.max(0, cy - rad); y < Math.min(rows, cy + rad + 1); y++) {
      for (let x = Math.max(0, cx - rad); x < Math.min(cols, cx + rad + 1); x++) {
        if ((y - cy) ** 2 + (x - cx) ** 2 <= rad * rad) img[y * cols + x] -= 90 + Math.floor(u() * 10)
      }
    }
  }
  const out = new Uint8Array(rows * cols)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.max(0, Math.floor(img[i])))
  return out
}

function ellipseMask(rows, cols) {
  const m = new Uint8Array(rows * cols)
  const cy = rows / 2
  const cx = cols / 2
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      m[y * cols + x] = (((y - cy) / (rows * 0.45)) ** 2 + ((x - cx) / (cols * 0.45)) ** 2 <= 1.0) ? 1 : 0
    }
  }
  return m
}

const sha = a => createHash('sha256').update(a).digest('hex')

describe('flattenBlue', () => {
  for (const [name, c] of Object.entries(E.flat)) {
    if (name === 'dark') continue
    const run = () => {
      const img = makeImage(c.rows, c.cols, c.seed)
      const mask = c.poly ? ellipseMask(c.rows, c.cols) : null
      return { img, mask }
    }
    it(`${name}: matches the Python image generator input`, () => {
      const { img } = run()
      expect(img.length).toBe(c.rows * c.cols)
    })
    if (!c.applied) {
      it(`${name}: too few valid samples returns the input unchanged`, () => {
        const { img, mask } = run()
        const r = flattenBlue(img, c.rows, c.cols, mask, c.pct)
        expect(r.info).toEqual({ applied: false })
        expect(r.blue).toBe(img)
      })
      continue
    }
    it(`${name}: bit-exact with the Python coefficients (coefOverride)`, () => {
      const { img, mask } = run()
      const r = flattenBlue(img, c.rows, c.cols, mask, c.pct, { coefOverride: Float64Array.from(c.coef) })
      expect(r.info.applied).toBe(true)
      expect(r.info.reference_level).toBe(c.ref)
      expect(r.info.n_fit_points).toBe(c.n_fit)
      expect(sha(r.blue)).toBe(c.sha)
    })
    it(`${name}: own solve is within 1e-8 of numpy and reproduces the pixels`, () => {
      const { img, mask } = run()
      const ov = flattenBlue(img, c.rows, c.cols, mask, c.pct, { coefOverride: Float64Array.from(c.coef) })
      const r = flattenBlue(img, c.rows, c.cols, mask, c.pct)
      expect(r.info.applied).toBe(true)
      expect(r.info.n_fit_points).toBe(c.n_fit)
      let cmax = 0
      for (const v of c.coef) cmax = Math.max(cmax, Math.abs(v))
      let worst = 0
      c.coef.forEach((v, i) => { worst = Math.max(worst, Math.abs(r.info.coef[i] - v) / cmax) })
      expect(worst).toBeLessThan(1e-8)
      expect(Math.abs(r.info.reference_level - c.ref)).toBeLessThan(1e-3)
      let diff = 0
      let maxd = 0
      for (let i = 0; i < r.blue.length; i++) {
        const d = Math.abs(r.blue[i] - ov.blue[i])
        if (d) diff++
        if (d > maxd) maxd = d
      }
      expect(maxd).toBeLessThanOrEqual(1)
      expect(diff / r.blue.length).toBeLessThan(1e-4)
    })
  }
  it('flat image with no dark pixels is handled', () => {
    const img = new Uint8Array(120 * 160).fill(20)
    for (let r = 0; r < 120; r += 7) for (let c = 0; c < 160; c += 5) img[r * 160 + c] = 200
    const r = flattenBlue(img, 120, 160, null, 58.8)
    expect(r.info.applied).toBe(E.flat.dark.applied)
  })
})

describe('halfContrastPercent', () => {
  const big = makeImage(1100, 1003, 14)
  const clusters = (n, seed) => {
    const u = mulberry32(seed)
    const rowsArr = []
    const colsArr = []
    const start = new Int32Array(n)
    const len = new Int32Array(n)
    for (let k = 0; k < n; k++) {
      const r = Math.trunc(u() * 1100)
      const c0 = Math.trunc(u() * (1003 - 400))
      const ln = 100 + Math.trunc(u() * 300)
      start[k] = rowsArr.length
      len[k] = ln
      for (let j = 0; j < ln; j++) { rowsArr.push(r); colsArr.push(c0 + j) }
    }
    return { n, px_start: start, px_len: len, px_row: Int32Array.from(rowsArr), px_col: Int32Array.from(colsArr) }
  }
  for (const [name, c] of Object.entries(E.hc)) {
    it(`${name}`, () => {
      const [pct, info] = halfContrastPercent(big, 1003, clusters(c.n, c.seed), c.bg, c.fb)
      expect(pct).toBe(c.pct)
      expect(info).toEqual(c.info)
    })
  }
})

// ---- expected values (numpy 2.x, cloudrun/coffeegrindsize_core/background.py) ----
const E = {"flat":{"plain":{"rows":203,"cols":311,"seed":11,"poly":false,"pct":58.8,"applied":true,"sha":"61bb0b7325c37ce0219d752a3812053fe4bb80004a5b508ba325063e2854496d","ref":192.49612426757812,"n_fit":3679,"coef":[195.36610490612773,-13.769127023071976,-10.516474372033636,0.4166191842786491,0.7609823670122653,36.97344253390606,6.075515921532888,-0.312881537030495,0.029023950411943205,-0.41319382546715455,-0.3080811987011439,0.1831698591459441,-1.1936494972731793,0.20209450281890007,0.2648236012069257],"sum":11963289},"poly":{"rows":203,"cols":311,"seed":12,"poly":true,"pct":58.8,"applied":true,"sha":"03618c98ab08c4b0091caec7c8c2bab35ea80ba8b6eac40f87b96dff0bdee2b2","ref":193.1209259033203,"n_fit":2302,"coef":[195.13227857768518,-13.34732545909408,-10.217147563775725,-0.26280785535165363,-0.30438485647019686,37.51167039279656,7.300731087360335,-1.493697767697706,-0.35486045607688854,0.7490663053717174,-1.624914670681168,-1.453931489861796,-1.7669479862792388,-4.125285603627806,-0.8592977294813503],"sum":12077166},"small":{"rows":97,"cols":61,"seed":13,"poly":false,"pct":70.0,"applied":false,"sha":"7ed811842461b3034db8f8ffca0cc8c75aaa915915275a12d92aed0685b451e6"},"big":{"rows":1100,"cols":1003,"seed":14,"poly":false,"pct":58.8,"applied":true,"sha":"a600ac52286d8277576ef5145a60cf6e7b3603563bd61c53b790ee87ee61d210","ref":192.62643432617188,"n_fit":59655,"coef":[195.3116743208531,-13.699578826640979,-10.115088751145555,-0.08312388114363063,-0.03775066391596438,36.09120470087835,6.341702375214906,0.05271661977098527,-0.30723343173455764,-0.2798832496014626,-0.10152532283210661,0.14255628479694804,0.27252298322165436,0.09772466805614467,0.2708902744504874],"sum":209879498},"dark":{"applied":true}},"hc":{"many":{"n":900,"seed":5,"bg":190.0,"fb":58.8,"pct":80.0,"info":{"n_contrast_clusters":755,"contrast_particle_intensity":172.0}},"some":{"n":60,"seed":6,"bg":185.5,"fb":58.8,"pct":80.0,"info":{"n_contrast_clusters":53,"contrast_particle_intensity":169.0}},"few":{"n":5,"seed":7,"bg":190.0,"fb":61.0,"pct":61.0,"info":{"n_contrast_clusters":4,"contrast_particle_intensity":null}},"bg0":{"n":60,"seed":6,"bg":0.0,"fb":61.0,"pct":61.0,"info":{"n_contrast_clusters":53,"contrast_particle_intensity":null}},"lowbg":{"n":60,"seed":8,"bg":40.0,"fb":58.8,"pct":80.0,"info":{"n_contrast_clusters":47,"contrast_particle_intensity":174.0}},"mid1":{"n":900,"seed":5,"bg":400.0,"fb":58.8,"pct":71.5,"info":{"n_contrast_clusters":755,"contrast_particle_intensity":172.0}},"mid2":{"n":60,"seed":6,"bg":300.0,"fb":58.8,"pct":78.16666666666667,"info":{"n_contrast_clusters":53,"contrast_particle_intensity":169.0}},"mid3":{"n":60,"seed":8,"bg":1000.0,"fb":58.8,"pct":58.7,"info":{"n_contrast_clusters":47,"contrast_particle_intensity":174.0}},"lo":{"n":60,"seed":8,"bg":100000.0,"fb":58.8,"pct":50.087,"info":{"n_contrast_clusters":47,"contrast_particle_intensity":174.0}}}}

/* Generating scripts (python venv; run with PYTHONDONTWRITEBYTECODE=1):
--- pyrng.py ---
import numpy as np
M = 0xFFFFFFFF
def imul(a, b):
    return (a * b) & M
def mulberry32(seed):
    a = seed & M
    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & M
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t = t ^ ((t + imul(t ^ (t >> 7), t | 61)) & M)
        return ((t ^ (t >> 14)) & M) / 4294967296.0
    return nxt
def rand_array(seed, n):
    u = mulberry32(seed)
    return np.array([u() for _ in range(n)])

--- gen_bg.py ---
# Generates expected values for background.test.js (flatten_blue + half_contrast_percent).
import sys, json, hashlib
sys.dont_write_bytecode = True
sys.path.insert(0, '/home/user/espresso-dash/cloudrun')
import numpy as np
from pyrng import mulberry32
from coffeegrindsize_core import background as bg

def make_image(rows, cols, seed):
    u = mulberry32(seed)
    r = np.arange(rows)[:, None] / rows
    c = np.arange(cols)[None, :] / cols
    illum = 170.0 + 60.0 * c - 40.0 * r * r + 25.0 * c * r
    noise = np.empty((rows, cols))
    for i in range(rows):
        for j in range(cols):
            noise[i, j] = np.floor(u() * 14) - 7
    img = illum + noise
    # dark blobs
    nb = max(8, rows * cols // 4000)
    for _ in range(nb):
        cy = int(u() * rows); cx = int(u() * cols); rad = 3 + int(u() * 6)
        for y in range(max(0, cy - rad), min(rows, cy + rad + 1)):
            for x in range(max(0, cx - rad), min(cols, cx + rad + 1)):
                if (y - cy) ** 2 + (x - cx) ** 2 <= rad * rad:
                    img[y, x] -= 90 + np.floor(u() * 10)
    return np.clip(np.floor(img), 0, 255).astype(np.uint8)

def polygon(rows, cols):
    # elliptical mask: integer-safe formula
    y = np.arange(rows)[:, None]; x = np.arange(cols)[None, :]
    cy, cx = rows / 2, cols / 2
    return (((y - cy) / (rows * 0.45)) ** 2 + ((x - cx) / (cols * 0.45)) ** 2 <= 1.0)

captured = []
orig_solve = np.linalg.solve
def spy(a, b):
    r = orig_solve(a, b); captured.append(r.copy()); return r
np.linalg.solve = spy

def run(img, mask, pct):
    captured.clear()
    out, info = bg.flatten_blue(img, mask, pct)
    d = {'applied': bool(info['applied']), 'sha': hashlib.sha256(out.tobytes()).hexdigest()}
    if info['applied']:
        d['ref'] = info['reference_level']; d['n_fit'] = info['n_fit_points']; d['coef'] = captured[-1].tolist()
        d['sum'] = int(out.astype(np.int64).sum())
    return d

cases = {}
for name, (rows, cols, seed, poly, pct) in {
    'plain': (203, 311, 11, False, 58.8),
    'poly': (203, 311, 12, True, 58.8),
    'small': (97, 61, 13, False, 70.0),
    'big': (1100, 1003, 14, False, 58.8),
}.items():
    img = make_image(rows, cols, seed)
    mask = polygon(rows, cols) if poly else None
    cases[name] = {'rows': rows, 'cols': cols, 'seed': seed, 'poly': poly, 'pct': pct, **run(img, mask, pct)}
# degenerate: nearly all dark -> unchanged
img = np.full((120, 160), 20, np.uint8); img[::7, ::5] = 200
cases['dark'] = {'applied': run(img, None, 58.8)['applied']}
json.dump(cases, open('bg_expected.json', 'w'))
print({k: (v['applied'], v.get('n_fit')) for k, v in cases.items()})

# ---- half_contrast_percent ----
from types import SimpleNamespace
def make_clusters(rows, cols, n, seed):
    u = mulberry32(seed); cl = []
    for k in range(n):
        r = int(u() * rows); c0 = int(u() * (cols - 400)); ln = 100 + int(u() * 300)
        cl.append(SimpleNamespace(x_pixels=np.full(ln, r), y_pixels=np.arange(c0, c0 + ln)))
    return cl
img = make_image(1100, 1003, 14)
hc = {}
for name, (n, seed, bgv, fb) in {'many': (900, 5, 190.0, 58.8), 'some': (60, 6, 185.5, 58.8), 'few': (5, 7, 190.0, 61.0), 'bg0': (60, 6, 0.0, 61.0), 'lowbg': (60, 8, 40.0, 58.8), 'mid1': (900, 5, 400.0, 58.8), 'mid2': (60, 6, 300.0, 58.8), 'mid3': (60, 8, 1000.0, 58.8), 'lo': (60, 8, 100000.0, 58.8)}.items():
    cl = make_clusters(1100, 1003, n, seed)
    pct, info = bg.half_contrast_percent(img, cl, bgv, fb)
    hc[name] = {'n': n, 'seed': seed, 'bg': bgv, 'fb': fb, 'pct': pct, 'info': info}
json.dump({'flat': cases, 'hc': hc}, open('bg_expected.json', 'w'))
print({k: (v['pct'], v['info']) for k, v in hc.items()})
*/
