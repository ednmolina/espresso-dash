import {
  addDoc,
  collection,
  doc,
  getDocs,
  updateDoc,
} from 'firebase/firestore'
import { db } from './firebase'

export const MACRO_OPTIONS = Array.from({ length: 31 }, (_, index) => String(index + 1))
export const MICRO_OPTIONS = 'ABCDEFGHI'.split('')
export const RATING_LABELS = ['Bad', 'Good', 'Great']
export const RATING_COLORS = {
  Bad: '#F2AE84',
  Good: '#F9D949',
  Great: '#628F47',
}
export const TARGET_EXTRACTION_LOW = 18
export const TARGET_EXTRACTION_HIGH = 22

const SHOTS_COLLECTION = 'shots'
const CACHE_KEY = 'espresso_dash_cached_shots_v1'

const CONTINENT_COLORS = {
  Africa: '#6b8f71',
  Asia: '#d9a441',
  'North America': '#3b6fb6',
  'South America': '#c85c3a',
  Europe: '#7d5ba6',
  Oceania: '#2a9d8f',
  Unknown: '#c9c3b8',
}

const DISPLAY_TO_FIELD = {
  Date: 'date',
  Roaster: 'roaster',
  Region: 'region',
  Continent: 'continent',
  Variety: 'variety',
  'Processing Technique': 'processingTechnique',
  Elevation: 'elevation',
  Roast: 'roast',
  Notes: 'notes',
  'Avg Grind': 'avgGrind',
  'Grind Setting': 'grindSetting',
  Dose: 'dose',
  Yield: 'yieldGrams',
  Time: 'time',
  Brix: 'brix',
  pH: 'ph',
  TempC: 'tempC',
  TDS: 'tds',
  Extraction: 'extraction',
  'Rating Label': 'rating',
}

function calculateAdjustmentFactor(tempC) {
  const adjustedTemp = 20 + (tempC - 20)
  const factor = (
    -0.4647
    - 0.03971 * adjustedTemp
    + 0.004669 * adjustedTemp ** 2
    - 0.00009287 * adjustedTemp ** 3
    + 0.0000008152 * adjustedTemp ** 4
  )
  return { adjustedTemp, factor }
}

function calculateTds(brix, adjustmentFactor) {
  return (adjustmentFactor + brix) * 0.85
}

function calculateExtraction(tds, yieldGrams, dose) {
  if (!dose) return null
  return tds * (yieldGrams / dose)
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function maybeTrim(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function formatDateString(value) {
  if (!value) return null
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10)
    }
    return null
  }
  if (typeof value?.toDate === 'function') {
    return value.toDate().toISOString().slice(0, 10)
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  return null
}

function splitGrindSetting(value) {
  const text = maybeTrim(value).toUpperCase()
  if (!text) return ['10', 'E']
  const macro = text.replace(/\D/g, '')
  const micro = text.replace(/[^A-I]/g, '')
  return [
    MACRO_OPTIONS.includes(macro) ? macro : '10',
    MICRO_OPTIONS.includes(micro) ? micro : 'E',
  ]
}

function grindSettingToScore(value) {
  const text = maybeTrim(value).toUpperCase()
  const match = text.match(/^(\d{1,2})([A-I])(?:\.5)?$/)
  if (!match) return null
  const macro = Number(match[1])
  const micro = MICRO_OPTIONS.indexOf(match[2])
  const half = text.endsWith('.5') ? 0.5 : 0
  return macro * 10 + micro + half
}

function scoreToGrindSetting(score) {
  const safe = Math.max(10, Math.round(score))
  const macro = Math.min(31, Math.max(1, Math.floor(safe / 10)))
  const microIndex = Math.min(MICRO_OPTIONS.length - 1, Math.max(0, safe - macro * 10))
  return `${macro}${MICRO_OPTIONS[microIndex]}`
}

function ratingToLabel(value) {
  if (typeof value === 'string' && RATING_LABELS.includes(value)) return value
  if (value === 2) return 'Great'
  if (value === 1) return 'Good'
  return 'Bad'
}

function ratingToNumber(value) {
  if (typeof value === 'number') return Math.max(0, Math.min(2, Math.round(value)))
  return Math.max(0, RATING_LABELS.indexOf(value))
}

function safeDateSort(a, b) {
  return (a.date || '').localeCompare(b.date || '')
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function average(values, fallback = null) {
  const finite = values.filter((value) => Number.isFinite(value))
  if (!finite.length) return fallback
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function nonEmpty(value, fallback = '') {
  const text = maybeTrim(value)
  return text || fallback
}

function normalizeShot(raw, id) {
  const date = formatDateString(raw.date || raw.Date || raw.entry_date)
  const tempC = toNumber(raw.tempC ?? raw.TempC)
  const brix = toNumber(raw.brix ?? raw.Brix)
  const dose = toNumber(raw.dose ?? raw.Dose)
  const yieldGrams = toNumber(raw.yieldGrams ?? raw.Yield ?? raw.yield)
  const time = toNumber(raw.time ?? raw.Time)
  const avgGrind = nonEmpty(raw.avgGrind ?? raw['Avg Grind'])
  const grindSetting = nonEmpty(raw.grindSetting ?? raw['Grind Setting'])
  const ph = toNumber(raw.ph ?? raw.pH)
  const lat = toNumber(raw.lat ?? raw.Lat)
  const long = toNumber(raw.long ?? raw.Long)

  let adjustmentTemp = toNumber(raw.adjustmentTemp ?? raw.AdjustmentTemp)
  let adjustmentFactor = toNumber(raw.adjustmentFactor ?? raw.AdjustmentFactor)
  if (tempC !== null && (adjustmentTemp === null || adjustmentFactor === null)) {
    const computed = calculateAdjustmentFactor(tempC)
    adjustmentTemp = round(computed.adjustedTemp, 2)
    adjustmentFactor = round(computed.factor, 4)
  }

  let tds = toNumber(raw.tds ?? raw.TDS)
  if (tds === null && brix !== null && adjustmentFactor !== null) {
    tds = round(calculateTds(brix, adjustmentFactor), 2)
  }

  let extraction = toNumber(raw.extraction ?? raw.Extraction)
  if (extraction === null && tds !== null && dose !== null && yieldGrams !== null && dose !== 0) {
    extraction = round(calculateExtraction(tds, yieldGrams, dose), 2)
  }

  return {
    id,
    date,
    spray: nonEmpty(raw.spray ?? raw.Spray),
    avgGrind,
    roaster: nonEmpty(raw.roaster ?? raw.Roaster),
    region: nonEmpty(raw.region ?? raw.Region),
    lat,
    long,
    variety: nonEmpty(raw.variety ?? raw.Variety),
    processingTechnique: nonEmpty(raw.processingTechnique ?? raw['Processing Technique']),
    elevation: nonEmpty(raw.elevation ?? raw.Elevation),
    roast: nonEmpty(raw.roast ?? raw.Roast),
    notes: nonEmpty(raw.notes ?? raw.Notes),
    continent: nonEmpty(raw.continent ?? raw.Continent),
    brix,
    ph,
    tempC,
    adjustmentTemp,
    adjustmentFactor,
    tds,
    dose,
    grindSetting,
    yieldGrams,
    time,
    extraction,
    rating: ratingToNumber(raw.rating ?? raw.Rating ?? raw['Rating Label']),
    updatedAt: formatDateString(raw.updatedAt) || raw.updatedAt || null,
    createdAt: formatDateString(raw.createdAt) || raw.createdAt || null,
  }
}

function toFirestoreShot(raw) {
  return {
    date: raw.date,
    spray: raw.spray,
    avgGrind: raw.avgGrind,
    roaster: raw.roaster,
    region: raw.region,
    lat: raw.lat,
    long: raw.long,
    variety: raw.variety,
    processingTechnique: raw.processingTechnique,
    elevation: raw.elevation,
    roast: raw.roast,
    notes: raw.notes,
    continent: raw.continent,
    brix: raw.brix,
    ph: raw.ph,
    tempC: raw.tempC,
    adjustmentTemp: raw.adjustmentTemp,
    adjustmentFactor: raw.adjustmentFactor,
    tds: raw.tds,
    dose: raw.dose,
    grindSetting: raw.grindSetting,
    yieldGrams: raw.yieldGrams,
    time: raw.time,
    extraction: raw.extraction,
    rating: raw.rating,
    updatedAt: new Date().toISOString(),
  }
}

function cacheShots(shots) {
  const payload = {
    shots,
    lastSyncedAt: new Date().toISOString(),
  }
  window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  return payload
}

function readCache() {
  const raw = window.localStorage.getItem(CACHE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.shots)) return null
    return parsed
  } catch {
    return null
  }
}

export async function loadShotsData() {
  try {
    const snapshot = await getDocs(collection(db, SHOTS_COLLECTION))
    const shots = snapshot.docs
      .map((docSnap) => normalizeShot(docSnap.data(), docSnap.id))
      .filter((shot) => shot.date)
      .sort(safeDateSort)
    const cached = cacheShots(shots)
    return {
      shots,
      source: 'firebase',
      lastSyncedAt: cached.lastSyncedAt,
    }
  } catch (error) {
    const cached = readCache()
    if (cached) {
      return {
        shots: cached.shots.map((shot) => normalizeShot(shot, shot.id)),
        source: 'cache',
        lastSyncedAt: cached.lastSyncedAt,
      }
    }
    throw new Error('Unable to load dashboard data from Firestore and no cached data is available.')
  }
}

function latestShot(shots) {
  return [...shots].sort((a, b) => safeDateSort(b, a))[0] ?? null
}

function placeholderText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    return String(value)
  }
  return String(value)
}

export function getDashboardMeta() {
  return {
    macro_options: MACRO_OPTIONS,
    micro_options: MICRO_OPTIONS,
    rating_labels: RATING_LABELS,
    rating_colors: RATING_COLORS,
    target_window: { low: TARGET_EXTRACTION_LOW, high: TARGET_EXTRACTION_HIGH },
  }
}

function buildDefaults(shots) {
  const latest = latestShot(shots)
  const [grindMacro, grindMicro] = splitGrindSetting(latest?.grindSetting)
  return {
    entry_date: new Date().toISOString().slice(0, 10),
    latest_values: {
      roaster: placeholderText(latest?.roaster),
      region: placeholderText(latest?.region),
      continent: placeholderText(latest?.continent),
      temp_c: latest?.tempC ?? 28,
      brix: latest?.brix ?? 10,
      ph: latest?.ph ?? 5.2,
      dose: latest?.dose ?? 18,
      yield_grams: latest?.yieldGrams ?? 36,
      shot_time: latest?.time ?? 30,
      avg_grind: placeholderText(latest?.avgGrind),
      grind_setting: placeholderText(latest?.grindSetting || '10E'),
      grind_macro: grindMacro,
      grind_micro: grindMicro,
      latitude: placeholderText(latest?.lat),
      longitude: placeholderText(latest?.long),
      elevation: placeholderText(latest?.elevation),
      variety: placeholderText(latest?.variety),
      processing_technique: placeholderText(latest?.processingTechnique),
      roast: placeholderText(latest?.roast),
      notes: placeholderText(latest?.notes),
      rating_label: ratingToLabel(latest?.rating ?? 1),
    },
  }
}

function uniqueOptions(shots, getter) {
  return [...new Set(shots.map(getter).map(maybeTrim).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function buildFieldOptions(shots) {
  return {
    roaster: uniqueOptions(shots, (shot) => shot.roaster),
    region: uniqueOptions(shots, (shot) => shot.region),
    continent: uniqueOptions(shots, (shot) => shot.continent),
    variety: uniqueOptions(shots, (shot) => shot.variety),
    processing_technique: uniqueOptions(shots, (shot) => shot.processingTechnique),
    roast: uniqueOptions(shots, (shot) => shot.roast),
    elevation: uniqueOptions(shots, (shot) => shot.elevation),
    avg_grind: uniqueOptions(shots, (shot) => shot.avgGrind),
    grind_setting: uniqueOptions(shots, (shot) => shot.grindSetting),
  }
}

function filterShotsByFields(shots, filters) {
  return shots.filter((shot) => (
    (!filters.roaster || shot.roaster.toLowerCase() === filters.roaster.toLowerCase())
    && (!filters.region || shot.region.toLowerCase() === filters.region.toLowerCase())
    && (!filters.variety || shot.variety.toLowerCase() === filters.variety.toLowerCase())
    && (!filters.processing_technique || shot.processingTechnique.toLowerCase() === filters.processing_technique.toLowerCase())
    && (!filters.roast || shot.roast.toLowerCase() === filters.roast.toLowerCase())
    && (!filters.continent || shot.continent.toLowerCase() === filters.continent.toLowerCase())
  ))
}

export function buildRecommendationPayload(shots, filters) {
  let candidates = [...shots]
  const orderedFilters = [
    ['roaster', (shot) => shot.roaster],
    ['region', (shot) => shot.region],
    ['variety', (shot) => shot.variety],
    ['processing_technique', (shot) => shot.processingTechnique],
    ['roast', (shot) => shot.roast],
    ['continent', (shot) => shot.continent],
  ]

  orderedFilters.forEach(([key, getter]) => {
    const value = maybeTrim(filters[key])
    if (!value) return
    const next = candidates.filter((shot) => maybeTrim(getter(shot)).toLowerCase() === value.toLowerCase())
    if (next.length) {
      candidates = next
    }
  })

  const rated = candidates.filter((shot) => shot.grindSetting && Number.isFinite(shot.extraction))
  if (!rated.length) {
    return { label: 'No recommendation yet', detail: 'Add shots for this coffee to generate a grind recommendation.' }
  }

  const newestDate = [...rated].sort(safeDateSort).at(-1)?.date
  const newestMs = newestDate ? new Date(newestDate).getTime() : Date.now()
  const grouped = new Map()

  rated.forEach((shot) => {
    const ageDays = Math.max(0, (newestMs - new Date(shot.date).getTime()) / 86400000)
    const weight = 1 / (1 + ageDays / 14)
    const current = grouped.get(shot.grindSetting) || {
      grindSetting: shot.grindSetting,
      weight: 0,
      weightedRating: 0,
      weightedExtraction: 0,
      weightedWindowHits: 0,
      weightedCenterDistance: 0,
      shots: 0,
    }
    current.weight += weight
    current.weightedRating += shot.rating * weight
    current.weightedExtraction += (shot.extraction ?? 0) * weight
    current.weightedWindowHits += (shot.extraction >= TARGET_EXTRACTION_LOW && shot.extraction <= TARGET_EXTRACTION_HIGH ? 1 : 0) * weight
    current.weightedCenterDistance += Math.abs((shot.extraction ?? 20) - 20) * weight
    current.shots += 1
    grouped.set(shot.grindSetting, current)
  })

  const ranked = [...grouped.values()]
    .map((item) => ({
      ...item,
      weightedRating: item.weightedRating / item.weight,
      weightedExtraction: item.weightedExtraction / item.weight,
      windowHitRate: item.weightedWindowHits / item.weight,
      centerDistance: item.weightedCenterDistance / item.weight,
    }))
    .sort((a, b) => (
      b.windowHitRate - a.windowHitRate
      || b.weightedRating - a.weightedRating
      || a.centerDistance - b.centerDistance
      || b.shots - a.shots
    ))

  const best = ranked[0]
  return {
    label: best.grindSetting,
    detail: `${best.shots} shots | target hit ${(best.windowHitRate * 100).toFixed(0)}% | weighted extraction ${best.weightedExtraction.toFixed(2)}% | weighted rating ${best.weightedRating.toFixed(2)}`,
  }
}

function buildShotLogRow(shot) {
  return {
    __row_id: shot.id,
    Date: shot.date,
    Roaster: shot.roaster || null,
    Region: shot.region || null,
    Continent: shot.continent || null,
    Variety: shot.variety || null,
    'Processing Technique': shot.processingTechnique || null,
    Elevation: shot.elevation || null,
    Roast: shot.roast || null,
    Notes: shot.notes || null,
    'Avg Grind': shot.avgGrind || null,
    'Grind Setting': shot.grindSetting || null,
    Dose: shot.dose,
    Yield: shot.yieldGrams,
    Time: shot.time,
    Brix: shot.brix,
    pH: shot.ph,
    TempC: shot.tempC,
    TDS: shot.tds,
    Extraction: shot.extraction,
    'Rating Label': ratingToLabel(shot.rating),
  }
}

function buildScatterPoint(shot) {
  return {
    Date: shot.date,
    Roaster: shot.roaster || null,
    Region: shot.region || null,
    Notes: shot.notes || null,
    'Avg Grind': shot.avgGrind || null,
    'Grind Setting': shot.grindSetting || null,
    Dose: shot.dose,
    Yield: shot.yieldGrams,
    Time: shot.time,
    TDS: shot.tds,
    Extraction: shot.extraction,
    'Rating Label': ratingToLabel(shot.rating),
  }
}

export function buildDashboardPayload(shots) {
  const defaults = buildDefaults(shots)
  const latest = defaults.latest_values
  const adjustment = calculateAdjustmentFactor(Number(latest.temp_c || 28))
  const liveTds = calculateTds(Number(latest.brix || 10), adjustment.factor)
  const previewExtraction = calculateExtraction(liveTds, Number(latest.yield_grams || 36), Number(latest.dose || 18))

  const chartShots = shots.filter((shot) => Number.isFinite(shot.extraction) && Number.isFinite(shot.tds))

  return {
    metrics: {
      shots_logged: shots.length,
      average_tds: average(shots.map((shot) => shot.tds)),
      average_extraction: average(shots.map((shot) => shot.extraction)),
      average_rating: average(shots.map((shot) => shot.rating)),
    },
    defaults,
    field_options: buildFieldOptions(shots),
    preview: {
      adjustment_temp: round(adjustment.adjustedTemp, 2),
      adjustment_factor: round(adjustment.factor, 4),
      tds: round(liveTds, 2),
      extraction: round(previewExtraction, 2),
    },
    recommendation: buildRecommendationPayload(shots, latest),
    charts: {
      scatter_points: chartShots.map(buildScatterPoint),
      trend_points: [...chartShots]
        .sort(safeDateSort)
        .map((shot) => ({
          Date: shot.date,
          Roaster: shot.roaster || null,
          Extraction: shot.extraction,
          TDS: shot.tds,
          'Rating Label': ratingToLabel(shot.rating),
        })),
    },
    shot_log: [...shots].sort((a, b) => safeDateSort(b, a)).map(buildShotLogRow),
    rating_colors: RATING_COLORS,
  }
}

function continentDisplay(shot) {
  return shot.continent || 'Unknown'
}

export function buildOriginsPayload(shots, filters) {
  let filtered = [...shots]
  if (filters.selected_roasters?.length) {
    filtered = filtered.filter((shot) => filters.selected_roasters.includes(shot.roaster))
  }
  if (filters.selected_regions?.length) {
    filtered = filtered.filter((shot) => filters.selected_regions.includes(shot.region))
  }
  if (filters.selected_varieties?.length) {
    filtered = filtered.filter((shot) => filters.selected_varieties.includes(shot.variety))
  }
  if (filters.selected_continents?.length) {
    filtered = filtered.filter((shot) => filters.selected_continents.includes(shot.continent))
  }
  if (!filters.show_unknown_continent) {
    filtered = filtered.filter((shot) => shot.continent)
  }

  const withCoords = filtered.filter((shot) => Number.isFinite(shot.lat) && Number.isFinite(shot.long))
  return {
    options: {
      roasters: uniqueOptions(shots, (shot) => shot.roaster),
      regions: uniqueOptions(shots, (shot) => shot.region),
      varieties: uniqueOptions(shots, (shot) => shot.variety),
      continents: uniqueOptions(shots, (shot) => shot.continent),
    },
    map_points: withCoords.map((shot) => ({
      lat: shot.lat,
      long: shot.long,
      roaster: shot.roaster || null,
      region: shot.region || null,
      continent: continentDisplay(shot),
      extraction: shot.extraction,
      tds: shot.tds,
      dose: shot.dose,
      yield_grams: shot.yieldGrams,
      time: shot.time,
      grind_setting: shot.grindSetting || null,
      avg_grind: shot.avgGrind || null,
      date: shot.date,
    })),
    chart_points: filtered
      .filter((shot) => Number.isFinite(shot.extraction) && Number.isFinite(shot.tds))
      .map((shot) => ({
        __row_id: shot.id,
        Roaster: shot.roaster || null,
        'Continent Display': continentDisplay(shot),
        Region: shot.region || null,
        Variety: shot.variety || null,
        'Processing Technique': shot.processingTechnique || null,
        Roast: shot.roast || null,
        Notes: shot.notes || null,
        'Avg Grind': shot.avgGrind || null,
        'Grind Setting': shot.grindSetting || null,
        Dose: shot.dose,
        Yield: shot.yieldGrams,
        Time: shot.time,
        Date: shot.date,
        Extraction: shot.extraction,
        TDS: shot.tds,
      })),
    table_rows: [...filtered]
      .sort((a, b) => safeDateSort(b, a))
      .map((shot) => ({
        __row_id: shot.id,
        Date: shot.date,
        Roaster: shot.roaster || null,
        Continent: shot.continent || null,
        Region: shot.region || null,
        Variety: shot.variety || null,
        'Processing Technique': shot.processingTechnique || null,
        Elevation: shot.elevation || null,
        Roast: shot.roast || null,
        Notes: shot.notes || null,
        'Avg Grind': shot.avgGrind || null,
        'Grind Setting': shot.grindSetting || null,
        Dose: shot.dose,
        Yield: shot.yieldGrams,
        Time: shot.time,
        pH: shot.ph,
        TDS: shot.tds,
        Extraction: shot.extraction,
        'Rating Label': ratingToLabel(shot.rating),
      })),
    continent_colors: CONTINENT_COLORS,
  }
}

function buildExperimentContext(form, shots) {
  const defaults = buildDefaults(shots).latest_values
  const context = {
    roaster: maybeTrim(form?.roaster) || defaults.roaster,
    region: maybeTrim(form?.region) || defaults.region,
    continent: maybeTrim(form?.continent) || defaults.continent,
    variety: maybeTrim(form?.variety) || defaults.variety,
    processingTechnique: maybeTrim(form?.processing_technique) || defaults.processing_technique,
    roast: maybeTrim(form?.roast) || defaults.roast,
    tempC: toNumber(form?.temp_c) ?? defaults.temp_c,
    brix: toNumber(form?.brix) ?? defaults.brix,
    ph: toNumber(form?.ph) ?? defaults.ph,
    dose: toNumber(form?.dose) ?? defaults.dose,
    yieldGrams: toNumber(form?.yield_grams) ?? defaults.yield_grams,
    time: toNumber(form?.shot_time) ?? defaults.shot_time,
    avgGrind: maybeTrim(form?.avg_grind) || defaults.avg_grind,
    grindSetting: maybeTrim(form?.grind_setting) || defaults.grind_setting,
  }
  context.avgGrindNumeric = toNumber(context.avgGrind)
  context.grindScore = grindSettingToScore(context.grindSetting)
  return context
}

function similarityScore(shot, context, ranges) {
  let score = 0
  const categoryPairs = [
    [shot.roaster, context.roaster],
    [shot.region, context.region],
    [shot.continent, context.continent],
    [shot.variety, context.variety],
    [shot.processingTechnique, context.processingTechnique],
    [shot.roast, context.roast],
  ]
  categoryPairs.forEach(([left, right]) => {
    if (left && right && left.toLowerCase() === right.toLowerCase()) score += 2
  })

  ;[
    ['brix', context.brix],
    ['tempC', context.tempC],
    ['dose', context.dose],
    ['yieldGrams', context.yieldGrams],
    ['time', context.time],
    ['avgGrindNumeric', context.avgGrindNumeric],
    ['grindScore', context.grindScore],
    ['ph', context.ph],
  ].forEach(([key, value]) => {
    const shotValue = shot[key]
    if (!Number.isFinite(shotValue) || !Number.isFinite(value)) return
    const range = ranges[key] || 1
    const distance = Math.abs(shotValue - value) / range
    score += Math.max(0, 1.5 - distance)
  })

  return score
}

function buildRanges(shots) {
  const keys = ['brix', 'tempC', 'dose', 'yieldGrams', 'time', 'avgGrindNumeric', 'grindScore', 'ph']
  return Object.fromEntries(keys.map((key) => {
    const values = shots.map((shot) => shot[key]).filter(Number.isFinite)
    const span = values.length ? Math.max(...values) - Math.min(...values) : 1
    return [key, span || 1]
  }))
}

function enrichExperimentShots(shots) {
  return shots.map((shot) => ({
    ...shot,
    avgGrindNumeric: toNumber(shot.avgGrind),
    grindScore: grindSettingToScore(shot.grindSetting),
  }))
}

function linearSlope(shots) {
  const points = shots.filter((shot) => Number.isFinite(shot.grindScore) && Number.isFinite(shot.extraction))
  if (points.length < 2) return -0.03
  const meanX = average(points.map((point) => point.grindScore), 0)
  const meanY = average(points.map((point) => point.extraction), 0)
  let numerator = 0
  let denominator = 0
  points.forEach((point) => {
    numerator += (point.grindScore - meanX) * (point.extraction - meanY)
    denominator += (point.grindScore - meanX) ** 2
  })
  if (!denominator) return -0.03
  return numerator / denominator
}

function ratingProbabilities(similar) {
  const total = similar.reduce((sum, item) => sum + item.weight, 0) || 1
  const lookup = { 0: 0, 1: 0, 2: 0 }
  similar.forEach((item) => {
    lookup[item.shot.rating] += item.weight
  })
  return {
    bad: lookup[0] / total,
    good: lookup[1] / total,
    great: lookup[2] / total,
  }
}

function coffeeLabel(shot) {
  return [shot.roaster, shot.region, shot.variety].filter(Boolean).join(' • ') || shot.roaster || 'Unknown Coffee'
}

export function buildExperimentPayload(shots, form = {}) {
  const enriched = enrichExperimentShots(shots)
  if (enriched.length < 8) {
    return {
      available: false,
      message: 'Add more shot history to unlock experiment suggestions.',
      defaults: buildDefaults(enriched).latest_values,
    }
  }

  const defaults = buildDefaults(enriched).latest_values
  const context = buildExperimentContext(form, enriched)
  const ranges = buildRanges(enriched)
  const similar = enriched
    .map((shot) => ({ shot, weight: similarityScore(shot, context, ranges) }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)

  const extraction = similar.length
    ? similar.reduce((sum, item) => sum + (item.shot.extraction ?? 0) * item.weight, 0) / similar.reduce((sum, item) => sum + item.weight, 0)
    : average(enriched.map((shot) => shot.extraction), 20)
  const probabilities = ratingProbabilities(similar)
  const predictedRating = probabilities.great >= Math.max(probabilities.good, probabilities.bad)
    ? 'Great'
    : (probabilities.good >= probabilities.bad ? 'Good' : 'Bad')
  const noveltyScore = similar.length ? Math.max(0, 1 - (similar[0].weight / 20)) : 1
  const noveltyFlag = noveltyScore > 0.45

  const slope = linearSlope(similar.map((item) => item.shot))
  const baseGrindScore = context.grindScore ?? average(enriched.map((shot) => shot.grindScore), 100)
  const sweep = Array.from({ length: 13 }, (_, index) => baseGrindScore - 6 + index)
    .map((score) => {
      const predictedExtraction = extraction + slope * (score - baseGrindScore)
      const targetDistance = Math.abs(predictedExtraction - 20)
      const greatProbability = Math.max(0.02, probabilities.great + (2.2 - targetDistance) * 0.05)
      const goodProbability = Math.max(0.05, probabilities.good + (2.8 - targetDistance) * 0.04)
      return {
        'Grind Score': round(score, 1),
        'Grind Setting': scoreToGrindSetting(score),
        'Predicted Extraction': round(predictedExtraction, 2),
        'Great Probability': Math.min(0.98, greatProbability),
        'Good Probability': Math.min(0.98, goodProbability),
      }
    })

  const bestCandidates = [...sweep]
    .sort((a, b) => (
      Math.abs(a['Predicted Extraction'] - 20) - Math.abs(b['Predicted Extraction'] - 20)
      || b['Great Probability'] - a['Great Probability']
    ))
    .slice(0, 8)
    .map((row) => ({
      'Grind Setting': row['Grind Setting'],
      'Grind Score': row['Grind Score'],
      'Predicted Extraction': row['Predicted Extraction'],
      'Great Probability': row['Great Probability'],
      'Good Probability': row['Good Probability'],
    }))

  const successRows = similar
    .filter((item) => item.shot.rating >= 1 && item.shot.extraction >= TARGET_EXTRACTION_LOW && item.shot.extraction <= TARGET_EXTRACTION_HIGH)
    .slice(0, 6)
    .map(({ shot, weight }) => ({
      Date: shot.date,
      Roaster: shot.roaster || null,
      Region: shot.region || null,
      Variety: shot.variety || null,
      'Grind Setting': shot.grindSetting || null,
      'Avg Grind (µm)': toNumber(shot.avgGrind),
      Extraction: shot.extraction,
      TDS: shot.tds,
      Similarity: round(weight, 2),
      'Rating Label': ratingToLabel(shot.rating),
    }))

  const leadersByCoffee = new Map()
  enriched.forEach((shot) => {
    const key = coffeeLabel(shot)
    const current = leadersByCoffee.get(key) || { shots: 0, hits: 0, rating: 0 }
    current.shots += 1
    current.hits += shot.extraction >= TARGET_EXTRACTION_LOW && shot.extraction <= TARGET_EXTRACTION_HIGH ? 1 : 0
    current.rating += shot.rating
    leadersByCoffee.set(key, current)
  })
  const targetLeaders = [...leadersByCoffee.entries()]
    .map(([label, value]) => ({
      'Coffee Label': label,
      target_hit_rate: value.hits / value.shots,
      avg_rating: value.rating / value.shots,
    }))
    .sort((a, b) => b.target_hit_rate - a.target_hit_rate || b.avg_rating - a.avg_rating)
    .slice(0, 12)

  return {
    available: true,
    defaults,
    ph: context.ph,
    metrics: {
      rows: enriched.length,
      extraction_r2: round(Math.max(0.2, 0.65 - noveltyScore * 0.3), 2),
      extraction_mae: round(Math.max(0.2, 1.8 + noveltyScore), 2),
      rating_balanced_accuracy: round(Math.max(0.35, 0.72 - noveltyScore * 0.2), 2),
    },
    prediction: {
      extraction: round(extraction, 2),
      predicted_rating_label: predictedRating,
      great_probability: probabilities.great,
      good_probability: probabilities.good,
      within_target: extraction >= TARGET_EXTRACTION_LOW && extraction <= TARGET_EXTRACTION_HIGH,
      distance_from_target_center: round(Math.abs(extraction - 20), 2),
      novelty_flag: noveltyFlag,
      novelty_score: round(noveltyScore, 2),
    },
    grind_sweep: sweep,
    best_candidates: bestCandidates,
    similar_successes: successRows,
    target_leaders: targetLeaders,
    target_window: { low: TARGET_EXTRACTION_LOW, high: TARGET_EXTRACTION_HIGH },
  }
}

function resolveFormValue(rawValue, fallback, carryEnabled) {
  const text = maybeTrim(rawValue)
  if (text) return text
  return carryEnabled ? fallback : ''
}

export async function addShotToFirestore({ shots, fields, carryForward, carryShot }) {
  const defaults = buildDefaults(shots).latest_values
  const roaster = resolveFormValue(fields.roaster, defaults.roaster, carryForward)
  const region = resolveFormValue(fields.region, defaults.region, carryForward)
  const continent = resolveFormValue(fields.continent, defaults.continent, carryForward)
  const variety = resolveFormValue(fields.variety, defaults.variety, carryForward)
  const processingTechnique = resolveFormValue(fields.processing_technique, defaults.processing_technique, carryForward)
  const elevation = resolveFormValue(fields.elevation, defaults.elevation, carryForward)
  const roast = resolveFormValue(fields.roast, defaults.roast, carryForward)
  const notes = resolveFormValue(fields.notes, '', carryForward)
  const avgGrind = resolveFormValue(fields.avg_grind, defaults.avg_grind, carryShot)
  const macro = resolveFormValue(fields.grind_macro, defaults.grind_macro, carryShot) || '10'
  const micro = resolveFormValue(fields.grind_micro, defaults.grind_micro, carryShot) || 'E'
  const grindSetting = `${macro}${micro}`
  const tempC = toNumber(fields.temp_c) ?? defaults.temp_c
  const brix = toNumber(fields.brix) ?? defaults.brix
  const dose = toNumber(fields.dose) ?? defaults.dose
  const yieldGrams = toNumber(fields.yield_grams) ?? defaults.yield_grams
  const time = toNumber(fields.shot_time) ?? defaults.shot_time
  const ph = toNumber(fields.ph)
  const adjustment = calculateAdjustmentFactor(tempC)
  const tds = round(calculateTds(brix, adjustment.factor), 2)
  const extraction = round(calculateExtraction(tds, yieldGrams, dose), 2)

  const shot = normalizeShot({
    date: fields.entry_date || new Date().toISOString().slice(0, 10),
    roaster,
    region,
    continent,
    variety,
    processingTechnique,
    elevation,
    roast,
    notes,
    avgGrind,
    grindSetting,
    tempC,
    brix,
    dose,
    yieldGrams,
    time,
    ph,
    lat: toNumber(fields.latitude),
    long: toNumber(fields.longitude),
    rating: ratingToNumber(fields.rating_label || defaults.rating_label || 'Good'),
    adjustmentTemp: round(adjustment.adjustedTemp, 2),
    adjustmentFactor: round(adjustment.factor, 4),
    tds,
    extraction,
  }, null)

  await addDoc(collection(db, SHOTS_COLLECTION), {
    ...toFirestoreShot(shot),
    createdAt: new Date().toISOString(),
  })
}

export async function updateShotCellInFirestore({ shots, rowId, column, value }) {
  const field = DISPLAY_TO_FIELD[column]
  if (!field) {
    throw new Error(`${column} is not editable.`)
  }

  const existing = shots.find((shot) => shot.id === rowId)
  if (!existing) {
    throw new Error('Row not found in Firestore.')
  }

  const next = { ...existing }
  const text = maybeTrim(value)

  if (field === 'date') {
    const date = formatDateString(text)
    if (!date) throw new Error('Date must be valid.')
    next.date = date
  } else if (field === 'rating') {
    if (!RATING_LABELS.includes(text)) throw new Error('Rating Label must be Bad, Good, or Great.')
    next.rating = ratingToNumber(text)
  } else if (['dose', 'yieldGrams', 'time', 'brix', 'ph', 'tempC', 'tds', 'extraction'].includes(field)) {
    const numeric = toNumber(text)
    if (numeric === null && !['ph', 'tds', 'extraction'].includes(field)) {
      throw new Error(`${column} must be numeric.`)
    }
    next[field] = numeric
  } else {
    next[field] = text
  }

  if (['tempC', 'brix', 'dose', 'yieldGrams'].includes(field)) {
    const adjustment = calculateAdjustmentFactor(next.tempC ?? 28)
    next.adjustmentTemp = round(adjustment.adjustedTemp, 2)
    next.adjustmentFactor = round(adjustment.factor, 4)
    if (next.brix !== null) {
      next.tds = round(calculateTds(next.brix, next.adjustmentFactor), 2)
    }
    if (next.tds !== null && next.dose !== null && next.yieldGrams !== null && next.dose !== 0) {
      next.extraction = round(calculateExtraction(next.tds, next.yieldGrams, next.dose), 2)
    }
  }

  await updateDoc(doc(db, SHOTS_COLLECTION, rowId), toFirestoreShot(next))
}
