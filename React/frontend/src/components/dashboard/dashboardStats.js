// Pure helpers for the Shots overview (no React, no Firebase).
import { TARGET_EXTRACTION_HIGH, TARGET_EXTRACTION_LOW } from '../../dashboardData'
import { coffeeLabel } from '../../forecastModel'
import { parseGrindUm } from '../../grindCalibration'

export const RANGE_OPTIONS = [
  { id: '7d', label: '7D', days: 7 },
  { id: '30d', label: '30D', days: 30 },
  { id: 'all', label: 'All', days: null },
]

const DAY_MS = 86_400_000
const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

export function dateMs(value) {
  const match = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})/) : null
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null
}

/** The shot with the latest date (ties: the later createdAt, then the later position). */
export function latestShotOf(shots) {
  let best = null
  ;(shots || []).forEach((shot, index) => {
    if (!shot?.date) return
    if (!best) { best = { shot, index }; return }
    const a = `${shot.date}|${shot.createdAt ?? ''}`
    const b = `${best.shot.date}|${best.shot.createdAt ?? ''}`
    if (a > b || (a === b && index > best.index)) best = { shot, index }
  })
  return best?.shot ?? null
}

/** Shots dated in (anchor - days, anchor]; `days === null` means everything up to the anchor. */
export function shotsInWindow(shots, anchorDate, days, offsetDays = 0) {
  const anchor = dateMs(anchorDate)
  if (anchor === null) return []
  const end = anchor - offsetDays * DAY_MS
  const start = days === null ? -Infinity : end - days * DAY_MS
  return (shots || []).filter((shot) => {
    const t = dateMs(shot.date)
    return t !== null && t > start && t <= end
  })
}

function mean(values) {
  const finite = values.filter(isNum)
  return finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : null
}

function median(values) {
  const sorted = values.filter(isNum).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function overviewKpis(shots, rangeId, runs = []) {
  const range = RANGE_OPTIONS.find((item) => item.id === rangeId) ?? RANGE_OPTIONS[1]
  const latest = latestShotOf(shots)
  const anchor = latest?.date ?? null
  const inWindow = anchor ? shotsInWindow(shots, anchor, range.days) : []
  const previous = anchor && range.days !== null ? shotsInWindow(shots, anchor, range.days, range.days) : []

  const extractions = inWindow.map((shot) => shot.extraction).filter(isNum)
  const prevExtractions = previous.map((shot) => shot.extraction).filter(isNum)
  const avg = mean(extractions)
  const prevAvg = prevExtractions.length >= 3 ? mean(prevExtractions) : null
  const inTarget = extractions.filter((v) => v >= TARGET_EXTRACTION_LOW && v <= TARGET_EXTRACTION_HIGH).length

  const dv50 = (runs || []).filter((run) => !run.excluded && isNum(run.dv50_um)).map((run) => run.dv50_um)

  return {
    anchor,
    windowCount: inWindow.length,
    avgExtraction: avg,
    delta: avg !== null && prevAvg !== null ? avg - prevAvg : null,
    rangeLabel: range.days === null ? 'all time' : `previous ${range.days} days`,
    inTargetPct: extractions.length ? (inTarget / extractions.length) * 100 : null,
    greatCount: inWindow.filter((shot) => shot.rating === 2).length,
    medianDv50: median(dv50),
    dv50Count: dv50.length,
  }
}

/** Measured grind (µm) text, or an estimate from the calibration curve when it is blank. */
export function grindDisplay(shot, estimate) {
  const measured = parseGrindUm(shot?.avgGrind)
  if (measured) return { um: measured.um, estimated: false }
  if (!shot?.grindSetting || typeof estimate !== 'function') return null
  const size = estimate(shot.grindSetting)
  return size && size.kind === 'curve' && isNum(size.um) ? { um: size.um, estimated: true } : null
}

export function shotCoffee(shot) {
  return coffeeLabel(shot)
}

export function phCount(shots) {
  return (shots || []).filter((shot) => isNum(shot.ph)).length
}
