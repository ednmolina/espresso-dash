// E2E harness: renders the signed-in Workspace with a fake user and a seeded
// dashboard cache, so tests need neither Firebase credentials nor network access.
// Served only by the Vite dev server (/e2e/harness/index.html); `vite build`
// uses index.html as its single entry, so this never ships.
//
// Query params (put them before the hash route: /e2e/harness/index.html?calib=1#/grinder):
//   ?empty=1    skips seeding the shot cache
//   ?calib=1    seeds espressoLab.calibrationRuns.v1 with 4 analyzer runs (9A, 10E, 11C, 12A; 11C excluded)
//   ?nocalib=1  clears the calibration runs and excluded-shot keys
// Seeded shots: 16 have an Avg Grind (every 3rd, on the curve 300*exp(0.012*index) um) and 12 have a pH
// (every 4th; the first two are exactly 5.2, the old default; the rest 5.3-5.6).
import React from 'react'
import ReactDOM from 'react-dom/client'
import { Workspace } from '../../src/App.jsx'
import '../../src/App.css'

const roasters = ['Onyx', 'Sey', 'Heart', 'Proud Mary', 'Tim Wendelboe']
const regions = [
  ['Ethiopia', 'Africa', 9, 38.7],
  ['Kenya', 'Africa', -0.3, 36.8],
  ['Colombia', 'South America', 4.5, -75.6],
  ['Panama', 'North America', 8.8, -82.4],
  ['Yunnan', 'Asia', 25, 101],
]

const MICRO = 'ABCDEFGHI'
const settingIndex = (macro, microIdx) => (macro - 1) * 9 + microIdx
const curveUm = (index) => Math.round(300 * Math.exp(0.012 * index))

const shots = Array.from({ length: 48 }, (_, i) => {
  const r = regions[i % 5]
  const d = new Date(2026, 4, 1 + i * 3)
  const macro = 8 + (i % 6)
  const microIdx = i % 9
  const shot = {
    id: `s${i}`,
    date: d.toISOString().slice(0, 10),
    roaster: roasters[i % 5],
    region: r[0],
    continent: r[1],
    lat: r[2],
    long: r[3],
    variety: ['Gesha', 'SL28', 'Caturra', 'Bourbon'][i % 4],
    processingTechnique: ['Washed', 'Natural', 'Honey'][i % 3],
    elevation: 1600 + (i % 7) * 100,
    roast: ['Light', 'Medium-Light'][i % 2],
    grindSetting: `${macro}${MICRO[microIdx]}`,
    dose: 18,
    yieldGrams: 36 + (i % 9) - 3,
    time: 26 + (i % 11),
    brix: 9.5 + ((i * 7) % 30) / 10,
    tempC: 22,
    rating: ['Bad', 'Good', 'Great'][(i * 5) % 3],
    notes: 'stone fruit, cocoa',
  }
  if (i % 3 === 0) shot.avgGrind = String(curveUm(settingIndex(macro, microIdx)))
  if (i % 4 === 0) shot.ph = i < 8 ? 5.2 : Number((5.3 + ((i / 4) % 4) * 0.1).toFixed(1))
  return shot
})

const CALIB_KEY = 'espressoLab.calibrationRuns.v1'
const EXCLUDED_KEY = 'espressoLab.calibrationExcludedShots.v1'
const calibRuns = [[9, 0, false], [10, 4, false], [11, 2, true], [12, 0, false]].map(([macro, microIdx, excluded], n) => {
  const index = settingIndex(macro, microIdx)
  const mean = curveUm(index)
  return {
    id: `e2e-run-${n + 1}`,
    grindSetting: `${macro}${MICRO[microIdx]}`,
    score: macro * 10 + microIdx,
    index,
    dv10_um: Math.round(mean * 0.55),
    dv50_um: Math.round(mean * 0.93),
    dv90_um: Math.round(mean * 1.6),
    mean_um: mean,
    n_particles: 400 + n * 10,
    coffee: 'E2E coffee',
    createdAt: new Date(2026, 5, 1 + n).toISOString(),
    excluded,
    apiShape: 'new',
  }
})

try {
  const params = new URLSearchParams(window.location.search)
  if (params.has('empty')) {
    localStorage.removeItem('espresso_dash_cached_shots_v1')
  } else {
    localStorage.setItem(
      'espresso_dash_cached_shots_v1',
      JSON.stringify({ shots, lastSyncedAt: new Date().toISOString() }),
    )
  }
  if (params.has('calib')) {
    localStorage.setItem(CALIB_KEY, JSON.stringify(calibRuns))
  } else if (params.has('nocalib')) {
    localStorage.removeItem(CALIB_KEY)
    localStorage.removeItem(EXCLUDED_KEY)
  }
} catch {
  // storage unavailable: the app falls back to Firestore, which tests block
}

const user = { email: 'demo@example.com', getIdToken: async () => 'e2e-token' }

ReactDOM.createRoot(document.getElementById('root')).render(
  <Workspace user={user} onLogout={() => {}} />,
)
