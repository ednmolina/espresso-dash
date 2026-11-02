// E2E harness: renders the signed-in Workspace with a fake user and a seeded
// dashboard cache, so tests need neither Firebase credentials nor network access.
// Served only by the Vite dev server (/e2e/harness/index.html); `vite build`
// uses index.html as its single entry, so this never ships.
//
// Query params: ?empty=1 skips seeding the shot cache.
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

const shots = Array.from({ length: 48 }, (_, i) => {
  const r = regions[i % 5]
  const d = new Date(2026, 4, 1 + i * 3)
  return {
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
    grindSetting: `${8 + (i % 6)}${'ABCDEFGHI'[i % 9]}`,
    dose: 18,
    yieldGrams: 36 + (i % 9) - 3,
    time: 26 + (i % 11),
    brix: 9.5 + ((i * 7) % 30) / 10,
    tempC: 22,
    rating: ['Bad', 'Good', 'Great'][(i * 5) % 3],
    notes: 'stone fruit, cocoa',
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
} catch {
  // storage unavailable: the app falls back to Firestore, which tests block
}

const user = { email: 'demo@example.com', getIdToken: async () => 'e2e-token' }

ReactDOM.createRoot(document.getElementById('root')).render(
  <Workspace user={user} onLogout={() => {}} />,
)
