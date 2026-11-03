#!/usr/bin/env node
// Guards the parts of the repo that the UI refresh must not touch: Firebase config and keys,
// the Firestore collection/cache constants, the frozen map code, and the backend.
// Plain Node 20, no dependencies. Run from anywhere inside the repo:
//   node React/frontend/scripts/check-protected.mjs
// BASE (the commit the protected files must equal) defaults to 3b5a924; override with
// PROTECTED_BASE. Exit code 0 = all good, 1 = at least one violation.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const BASE = process.env.PROTECTED_BASE || '3b5a924'
const MAIN = 'e299811'

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

let ROOT
try {
  ROOT = git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).trim()
} catch (err) {
  console.error('check-protected: not inside a git repository')
  process.exit(1)
}
const gitR = (args) => git(args, { cwd: ROOT })

const FE = 'React/frontend'
const failures = []
const infos = []
const fail = (rule, msg) => failures.push(`[${rule}] ${msg}`)
const info = (msg) => infos.push(`INFO ${msg}`)

function showAt(rev, file) {
  try {
    return gitR(['show', `${rev}:${file}`])
  } catch {
    return null
  }
}
function readWork(file) {
  const p = path.join(ROOT, file)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
const norm = (s) => s.replace(/\s+/g, ' ').trim()
// Layout-insensitive form (no whitespace, no trailing commas) for the comparison with main.
const squash = (s) => s.replace(/\s+/g, '').replace(/,([}\])])/g, '$1')

// The base commit must be reachable (CI needs fetch-depth: 0).
try {
  gitR(['cat-file', '-e', `${BASE}^{commit}`])
} catch {
  console.error(`check-protected: base commit ${BASE} is not available in this checkout (use fetch-depth: 0)`)
  process.exit(1)
}
const mainAvailable = (() => {
  try { gitR(['cat-file', '-e', `${MAIN}^{commit}`]); return true } catch { return false }
})()

/* ---------- 1. byte-identical protected files ---------- */
const PROTECTED_FILES = [
  `${FE}/src/firebase.js`,
  `${FE}/src/firestore.js`,
  '.github/workflows/deploy-pages.yml',
  `${FE}/.env.example`,
  `${FE}/vite.config.js`,
  `${FE}/.firebaserc`,
]
for (const f of PROTECTED_FILES) {
  const base = showAt(BASE, f)
  const work = readWork(f)
  if (base === null) { fail(1, `${f}: not present at ${BASE} (check the protected list)`); continue }
  if (work === null) fail(1, `${f}: deleted (must be identical to ${BASE})`)
  else if (work !== base) fail(1, `${f}: differs from ${BASE}`)
}

/* ---------- 2. frozen functions / regions ---------- */
/** Text of a top-level declaration: function up to the first "\n}\n", const up to end of line. */
function extractDecl(src, name) {
  const re = new RegExp(`^(?:export\\s+)?(?:(function)\\s+${name}\\s*\\(|(const)\\s+${name}\\b)`, 'm')
  const m = re.exec(src)
  if (!m) return null
  const start = m.index
  if (m[1]) {
    const end = src.indexOf('\n}\n', start)
    return src.slice(start, end === -1 ? src.length : end + 3)
  }
  const eol = src.indexOf('\n', start)
  return src.slice(start, eol === -1 ? src.length : eol)
}
function extractMapRegion(src) {
  const i = src.indexOf('/* ---- map')
  return i === -1 ? null : src.slice(i)
}

const CHART_UTILS = `${FE}/src/components/dashboard/chartUtils.js`
const CHARTS = `${FE}/src/components/dashboard/charts.jsx`
const FROZEN_UTILS = ['TILE_SIZE', 'clamp', 'average', 'buildTooltipState', 'useElementWidth', 'useNonPassiveWheel',
  'wrapLongitude', 'lngLatToWorld', 'worldToLngLat', 'getVisibleTiles']
const FROZEN_CHARTS = ['ChartTooltip', 'ChartControls', 'LegendToggles']

function compareDecls(file, names) {
  const base = showAt(BASE, file)
  const work = readWork(file)
  if (base === null) { fail(2, `${file}: not present at ${BASE}`); return }
  if (work === null) { fail(2, `${file}: file is missing`); return }
  for (const name of names) {
    const b = extractDecl(base, name)
    const w = extractDecl(work, name)
    if (b === null) { fail(2, `${file}: ${name} not found at ${BASE} (check script)`); continue }
    if (w === null) fail(2, `${file}: frozen ${name} is missing`)
    else if (norm(w) !== norm(b)) fail(2, `${file}: frozen ${name} differs from ${BASE}`)
  }
}
compareDecls(CHART_UTILS, FROZEN_UTILS)
compareDecls(CHARTS, FROZEN_CHARTS)
{
  const b = extractMapRegion(showAt(BASE, CHARTS) ?? '')
  const wSrc = readWork(CHARTS)
  const w = wSrc === null ? null : extractMapRegion(wSrc)
  if (b === null) fail(2, `${CHARTS}: "/* ---- map" marker not found at ${BASE} (check script)`)
  else if (w === null) fail(2, `${CHARTS}: the "/* ---- map" region is missing`)
  else if (norm(w) !== norm(b)) fail(2, `${CHARTS}: the map region (from "/* ---- map" to end of file) differs from ${BASE}`)
  if (wSrc !== null && !wSrc.includes('https://tile.openstreetmap.org/')) {
    fail(2, `${CHARTS}: OpenStreetMap tile URL (https://tile.openstreetmap.org/...) is gone`)
  }
}

/* ---------- 3. frozen CSS rules ---------- */
const APP_CSS = `${FE}/src/App.css`
/** All bodies of rules whose selector is exactly `selector` (not part of a list or a longer name). */
function cssRuleBodies(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|[}{;]|\\*/)\\s*${esc}\\s*\\{([^}]*)\\}`, 'g')
  const out = []
  let m
  while ((m = re.exec(css))) out.push(norm(m[1]).replace(/;$/, '').trim())
  return out
}
{
  const base = showAt(BASE, APP_CSS)
  const work = readWork(APP_CSS)
  if (base === null || work === null) {
    fail(3, `${APP_CSS}: cannot read (base ${base === null ? 'missing' : 'ok'}, work ${work === null ? 'missing' : 'ok'})`)
  } else {
    for (const sel of ['.dashboard-map-tiles', '.dashboard-map-tile']) {
      const bBodies = cssRuleBodies(base, sel)
      const wBodies = cssRuleBodies(work, sel)
      if (!bBodies.length) { fail(3, `${APP_CSS}: ${sel} rule not found at ${BASE} (check script)`); continue }
      for (const body of bBodies) {
        if (!wBodies.includes(body)) fail(3, `${APP_CSS}: rule body of ${sel} changed (expected "${body}")`)
      }
    }
    const markerOk = cssRuleBodies(work, '.dashboard-map-marker').some((b) => /transform:\s*translate\(\s*-50%\s*,\s*-50%\s*\)\s*(;|$)/.test(b))
    if (!markerOk) fail(3, `${APP_CSS}: .dashboard-map-marker lost "transform: translate(-50%, -50%)"`)
  }
}

/* ---------- 4. Firestore collection / cache constants ---------- */
const DASH_DATA = `${FE}/src/dashboardData.js`
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { if (name !== 'node_modules') walk(p, out) }
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const srcFiles = walk(path.join(ROOT, FE, 'src')).map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
{
  const src = readWork(DASH_DATA)
  if (src === null) fail(4, `${DASH_DATA}: file is missing`)
  else {
    const lines = src.split('\n').map((l) => l.trim())
    if (!lines.includes("const SHOTS_COLLECTION = 'shots'")) fail(4, `${DASH_DATA}: line "const SHOTS_COLLECTION = 'shots'" is missing`)
    if (!lines.includes("const CACHE_KEY = 'espresso_dash_cached_shots_v1'")) fail(4, `${DASH_DATA}: line "const CACHE_KEY = 'espresso_dash_cached_shots_v1'" is missing`)
  }
  for (const f of srcFiles) {
    if (/\/__tests__\/|\.test\.[jt]sx?$/.test(f)) continue
    const text = readWork(f)
    const re = /\b(collection|doc)\(\s*db\s*,\s*([^,)]*)/g
    let m
    while ((m = re.exec(text))) {
      if (m[2].trim() !== 'SHOTS_COLLECTION') {
        const line = text.slice(0, m.index).split('\n').length
        fail(4, `${f}:${line}: ${m[1]}(db, ${m[2].trim()}, ...) must use SHOTS_COLLECTION`)
      }
    }
  }
}

/* ---------- 5. firebase/* imports only in the allowed files ---------- */
{
  const allowed = new Set([
    `${FE}/src/firebase.js`, `${FE}/src/firestore.js`, `${FE}/src/dashboardData.js`, `${FE}/src/App.jsx`,
  ])
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]firebase(?:\/[^'"]*)?['"]/g
  for (const f of srcFiles) {
    if (allowed.has(f) || /\/__tests__\/|\.test\.[jt]sx?$/.test(f)) continue
    const text = readWork(f)
    let m
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length
      fail(5, `${f}:${line}: imports firebase outside firebase.js, firestore.js, dashboardData.js and App.jsx`)
    }
  }
}

/* ---------- 6. backend untouched ---------- */
{
  const paths = ['cloudrun', 'tests', 'pytest.ini', 'requirements-dev.txt']
  const diffNames = gitR(['diff', '--name-status', BASE, '--', ...paths]).trim()
  if (diffNames) fail(6, `backend files differ from ${BASE}:\n      ${diffNames.split('\n').join('\n      ')}`)
  const untracked = gitR(['ls-files', '--others', '--exclude-standard', '--', ...paths]).trim()
  if (untracked) fail(6, `untracked files in the backend:\n      ${untracked.split('\n').join('\n      ')}`)
}

/* ---------- 7. env files ---------- */
{
  const tracked = gitR(['ls-files', `${FE}/.env*`]).split('\n').map((s) => s.trim()).filter(Boolean)
  const extra = tracked.filter((f) => f !== `${FE}/.env.example`)
  if (extra.length) fail(7, `tracked env files (only .env.example may be tracked): ${extra.join(', ')}`)
  const staged = gitR(['diff', '--cached', '--name-only']).split('\n').filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example'))
  if (staged.length) fail(7, `staged env files: ${staged.join(', ')}`)
}

/* ---------- INFO: comparison with main ---------- */
if (!mainAvailable) {
  info(`${MAIN} (main) is not available in this checkout; skipping the comparison with main`)
} else {
  const mainDash = showAt(MAIN, `${FE}/src/components/dashboard/DashboardApp.jsx`)
  const curUtils = readWork(CHART_UTILS)
  if (mainDash === null || curUtils === null) {
    info(`projection maths: cannot compare (main DashboardApp.jsx ${mainDash === null ? 'missing' : 'ok'}, chartUtils.js ${curUtils === null ? 'missing' : 'ok'})`)
  } else {
    for (const name of ['TILE_SIZE', 'wrapLongitude', 'lngLatToWorld', 'worldToLngLat', 'getVisibleTiles']) {
      const a = extractDecl(mainDash, name)
      const b = extractDecl(curUtils, name)
      if (a === null || b === null) { info(`${name}: ${a === null ? 'not found in main' : 'not found in chartUtils.js'}`); continue }
      const unexport = (t) => t.replace(/^export\s+/, '')
      let na = squash(unexport(a))
      let nb = squash(unexport(b))
      if (name === 'getVisibleTiles') {
        // the one known addition: the unwrapped-tile `key:` line (and its comment)
        const stripKey = (s) => s.replace(/\/\/[^\n]*\n/g, '\n').replace(/\bkey:\s*`[^`]*`,/g, '')
        na = squash(stripKey(unexport(a)))
        nb = squash(stripKey(unexport(b)))
      }
      info(`${name}: ${na === nb ? 'equals main (whitespace-normalised)' : 'DIFFERS from main'}`)
    }
  }
  const known = []
  for (const f of PROTECTED_FILES) {
    const m = showAt(MAIN, f)
    const w = readWork(f)
    if (m === null) known.push(`${path.basename(f)} (new vs main)`)
    else if (w !== m) known.push(`${path.basename(f)} (differs from main)`)
  }
  info(`protected files that differ from main (expected: firebase.js, firestore.js, deploy-pages.yml): ${known.length ? known.join(', ') : 'none'}`)
}

/* ---------- report ---------- */
for (const l of infos) console.log(l)
if (failures.length) {
  console.error(`\ncheck-protected: ${failures.length} violation(s) against ${BASE}:`)
  for (const f of failures) console.error(`  FAIL ${f}`)
  process.exit(1)
}
console.log(`check-protected: OK (protected files match ${BASE})`)
