// Helpers shared by the parity.*.test.js files. Not a test file itself.
//
// The fixtures are written by parity/export_js_fixtures.py (see the format notes in that file).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { legacySettings, makeSettings } from '../detect.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = path.join(here, '..', '__fixtures__')

/**
 * Relative tolerance for `edge_weight` in the exact tier. Exact (0) by default. Raise to 1e-12 only if
 * a failure is traced to Math.log2/Math.pow differing from glibc by an ulp, and say so here.
 */
export const EDGE_WEIGHT_RTOL = 0

const cache = new Map()

export function caseNames(prefix = '') {
  return fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json' && f.startsWith(prefix))
    .map((f) => f.slice(0, -5))
    .sort()
}

export function loadCase(name) {
  if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')))
  return cache.get(name)
}

/** base64(zlib) -> Uint8Array (own buffer). */
export function inflateBytes(b64z) {
  const buf = zlib.inflateSync(Buffer.from(b64z, 'base64'))
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

/** The blue channel of a core/api case (a fresh copy each call; the engine may keep it). */
export function inflateBlue(c) {
  const blue = inflateBytes(c.blue_b64z)
  if (blue.length !== c.width * c.height) throw new Error(`${c.name}: blue has ${blue.length} bytes, expected ${c.width * c.height}`)
  return blue
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a 32-bit over bytes. */
export function fnvBytes(bytes) {
  let h = FNV_OFFSET
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], FNV_PRIME) >>> 0
  return h >>> 0
}

/** FNV-1a 32-bit over values, each hashed as 4 little-endian bytes. */
export function fnvU32(values) {
  let h = FNV_OFFSET
  for (let i = 0; i < values.length; i++) {
    let v = values[i] >>> 0
    for (let k = 0; k < 4; k++) {
      h = Math.imul(h ^ (v & 255), FNV_PRIME) >>> 0
      v >>>= 8
    }
  }
  return h >>> 0
}

/** {count, hash}: hash = fnvU32 of the set linear indices, ascending. */
export function maskInfo(mask) {
  let h = FNV_OFFSET
  let count = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) continue
    count++
    let v = i
    for (let k = 0; k < 4; k++) {
      h = Math.imul(h ^ (v & 255), FNV_PRIME) >>> 0
      v >>>= 8
    }
  }
  return { count, hash: h >>> 0 }
}

/** {index_hash, n1, n2} of a (height*width) uint8 index image. */
export function layerInfo(index) {
  let n1 = 0
  let n2 = 0
  for (let i = 0; i < index.length; i++) {
    if (index[i] === 1) n1++
    else if (index[i] === 2) n2++
  }
  return { index_hash: fnvBytes(index), n1, n2 }
}

/** |a - b| <= atol + rtol * |b| (null only equals null; NaN never matches). */
export function approx(a, b, rtol = 1e-9, atol = 0) {
  if (a === null || b === null || a === undefined || b === undefined) return a === b || (a == null && b == null)
  if (a === b) return true
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= atol + rtol * Math.abs(b)
}

/** First index where the arrays differ under `eq`, or -1. */
export function firstMismatch(actual, expected, eq = (a, b) => a === b) {
  if (actual.length !== expected.length) return -2
  for (let i = 0; i < expected.length; i++) if (!eq(actual[i], expected[i])) return i
  return -1
}

/** Full settings for a core fixture: its overrides on top of the legacy or the modern (default) preset. */
export function settingsFor(c) {
  return c.preset === 'legacy' ? legacySettings(c.settings) : makeSettings(c.settings)
}

/** expect(ds columns) === fixture columns. One assertion per column, with the first bad index in the message. */
export function expectClusters(ds, cols, width, { edgeRtol = EDGE_WEIGHT_RTOL, label = '' } = {}) {
  expect(ds.n, `${label} cluster count`).toBe(cols.cluster_id.length)
  const exactCols = ['cluster_id', 'surface', 'roundness', 'short_axis', 'long_axis', 'volume', 'xmean', 'ymean']
  for (const name of exactCols) {
    const i = firstMismatch(ds[name], cols[name])
    expect(i, `${label} ${name} first mismatch at cluster ${i}: js=${ds[name][i]} py=${cols[name][i]}`).toBe(-1)
  }
  const ew = firstMismatch(ds.edge_weight, cols.edge_weight, edgeRtol === 0 ? undefined : (a, b) => approx(a, b, edgeRtol))
  expect(ew, `${label} edge_weight first mismatch at cluster ${ew}: js=${ds.edge_weight[ew]} py=${cols.edge_weight[ew]}`).toBe(-1)
  const nPx = firstMismatch(ds.px_len, cols.n_px)
  expect(nPx, `${label} n_px first mismatch at cluster ${nPx}`).toBe(-1)
  const hashes = new Array(ds.n)
  for (let i = 0; i < ds.n; i++) {
    const lin = new Int32Array(ds.px_len[i])
    const s = ds.px_start[i]
    for (let k = 0; k < lin.length; k++) lin[k] = ds.px_row[s + k] * width + ds.px_col[s + k]
    lin.sort()
    hashes[i] = fnvU32(lin)
  }
  const ph = firstMismatch(hashes, cols.px_hash)
  expect(ph, `${label} px_hash first mismatch at cluster ${ph}`).toBe(-1)
}

// ---------------------------------------------------------------- summary comparison

/** Summary keys whose value depends on the order numpy's unstable sort gives to equal diameters. */
const TIE_KEYS = new Set(['dv10_mm', 'dv50_mm', 'dv90_mm', 'diameter_number_median_mm', 'span'])
const VOLUME_MODE_RATIO = Math.pow(10, 1 / 40) * (1 + 1e-9)
/** How far Python's unstable-sort value may sit from the stable-sort value (sanity bound only). */
const TIE_SANITY_RTOL = 1e-3

/**
 * Compares a JS summary against the Python one key by key (see P4 spec).
 *
 * `tie` = the fixture's tie_sensitive object: {dv, number, stable?}. numpy's default argsort is unstable, so
 * when equal diameters carry unequal weights (edge correction) the percentile interpolation can differ
 * from any other tie order by more than 1e-6. The exporter therefore also records those keys computed with a
 * *stable* sort (what the JS port does): they must match at 1e-9, and Python's own value must lie within
 * 0.1% of them. Without `stable` (API replays, where the server dataset is not exposed) the tie keys get
 * `tie.loose` (default 1e-4).
 */
export function expectSummary(js, py, tie = { dv: false, number: false }, label = '') {
  if (py === null) {
    expect(js, `${label} summary`).toBeNull()
    return
  }
  expect(js, `${label} summary`).not.toBeNull()
  expect(Object.keys(js).sort(), `${label} summary keys`).toEqual(Object.keys(py).sort())
  const tied = tie.dv || tie.number
  for (const key of Object.keys(py)) {
    const a = js[key]
    const b = py[key]
    const where = `${label} summary.${key}: js=${JSON.stringify(a)} py=${JSON.stringify(b)}`
    if (key === 'dv_ci95') {
      expectCi(js, py, label)
    } else if (key === 'volume_mode_mm') {
      if (b === null || a === null) expect(a, where).toBe(b)
      else {
        const ratio = Math.max(a, b) / Math.min(a, b)
        expect(ratio <= VOLUME_MODE_RATIO, `${where} (ratio ${ratio})`).toBe(true)
      }
    } else if (typeof b === 'number') {
      expect(typeof a, where).toBe('number')
      if (tied && TIE_KEYS.has(key) && tie.stable) {
        const st = tie.stable[key]
        expect(approx(a, st, 1e-9, 1e-12), `${where} (stable-sort value ${st})`).toBe(true)
        expect(approx(b, st, TIE_SANITY_RTOL, 1e-12), `${where} (python vs stable ${st})`).toBe(true)
      } else if (tied && TIE_KEYS.has(key)) {
        expect(approx(a, b, tie.loose ?? 1e-4, 1e-12), where).toBe(true)
      } else {
        expect(approx(a, b, 1e-9, 1e-12), where).toBe(true)
      }
    } else {
      expect(a, where).toEqual(b)
    }
  }
}

/**
 * dv_ci95: within half the Python interval width (+0.1% of dv) and containing the point estimate.
 * numpy's Generator cannot be reproduced in JS, so the two bootstrap intervals are independent draws of the
 * same estimator. With fewer than 30 particles the 2.5/97.5 percentile of 200 resamples is itself very noisy
 * (e.g. 15 particles: Dv90 lower bound 1.43 vs 1.31), so the allowance there is the full Python width.
 */
function expectCi(js, py, label) {
  expect(Object.keys(js.dv_ci95).sort(), `${label} dv_ci95 keys`).toEqual(Object.keys(py.dv_ci95).sort())
  for (const q of ['dv10', 'dv50', 'dv90']) {
    const [pLo, pHi] = py.dv_ci95[q]
    const [jLo, jHi] = js.dv_ci95[q]
    const dv = js[`${q}_mm`]
    const tol = (js.cluster_count < 30 ? 1.0 : 0.5) * (pHi - pLo) + 1e-3 * dv
    const where = `${label} dv_ci95.${q}: js=[${jLo}, ${jHi}] py=[${pLo}, ${pHi}] dv=${dv}`
    expect(Math.abs(jLo - pLo) <= tol, where).toBe(true)
    expect(Math.abs(jHi - pHi) <= tol, where).toBe(true)
    expect(jLo <= dv && dv <= jHi, `${where} (point estimate outside the interval)`).toBe(true)
  }
}

/** Recursive comparison for plain response objects: numbers by rtol, everything else deep-equal. */
export function expectClose(js, py, { rtol = 1e-9, atol = 0, label = '', exactKeys = [] } = {}) {
  const walk = (a, b, where) => {
    if (typeof b === 'number') {
      expect(typeof a, where).toBe('number')
      expect(approx(a, b, rtol, atol), `${where}: js=${a} py=${b}`).toBe(true)
    } else if (Array.isArray(b)) {
      expect(Array.isArray(a), where).toBe(true)
      expect(a.length, `${where}.length`).toBe(b.length)
      b.forEach((v, i) => walk(a[i], v, `${where}[${i}]`))
    } else if (b && typeof b === 'object') {
      expect(a && typeof a === 'object', where).toBe(true)
      expect(Object.keys(a).sort(), `${where} keys`).toEqual(Object.keys(b).sort())
      for (const k of Object.keys(b)) {
        if (exactKeys.includes(k)) expect(a[k], `${where}.${k}`).toEqual(b[k])
        else walk(a[k], b[k], `${where}.${k}`)
      }
    } else {
      expect(a, where).toEqual(b)
    }
  }
  walk(js, py, label)
}
