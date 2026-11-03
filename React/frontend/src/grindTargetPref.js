// Which extraction the grind suggestion aims for: 'fixed' (20%) or 'best' (average of the
// Great shots). Saved on this device and shared between the Forecast and Shots pages.
import { useSyncExternalStore } from 'react'

export const GRIND_TARGET_KEY = 'espressoLab.grindTarget.v1'
export const GRIND_TARGET_MODES = ['fixed', 'best']

const listeners = new Set()
let current = null

function read() {
  try {
    const v = window.localStorage.getItem(GRIND_TARGET_KEY)
    return GRIND_TARGET_MODES.includes(v) ? v : 'fixed'
  } catch {
    return 'fixed'
  }
}

export function getGrindTargetMode() {
  if (current === null) current = read()
  return current
}

export function setGrindTargetMode(mode) {
  const next = GRIND_TARGET_MODES.includes(mode) ? mode : 'fixed'
  current = next
  try { window.localStorage.setItem(GRIND_TARGET_KEY, next) } catch { /* storage unavailable: keep it for this tab */ }
  listeners.forEach((fn) => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  const onStorage = (e) => {
    if (e.key === GRIND_TARGET_KEY || e.key === null) { current = read(); fn() }
  }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage) }
}

/** [mode, setMode]; re-renders every component using it when the mode changes. */
export function useGrindTargetMode() {
  const mode = useSyncExternalStore(subscribe, getGrindTargetMode, () => 'fixed')
  return [mode, setGrindTargetMode]
}

/** Test helper: forget the cached value so the next read hits storage again. */
export function resetGrindTargetModeCache() { current = null }

const pct1 = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}%`

/** One line saying what the suggestion aims for and why. `t` is the result of targetFor. */
export function targetLine(t) {
  if (!t || t.source === 'fixed') return 'Aiming for 20%.'
  if (t.source === 'coffee') {
    return `Target ${pct1(t.target)} · average of your ${t.n} Great shots of ${t.coffeeLabel || 'this coffee'}`
  }
  if (t.source === 'all') {
    return `Not enough Great shots of this coffee — using all your Great shots (${t.n}). Target ${pct1(t.target)}`
  }
  return 'Not enough Great shots yet — using 20%'
}
