import { useEffect, useMemo, useRef, useState } from 'react'
import {
  RATING_COLORS,
  RATING_LABELS,
  TARGET_EXTRACTION_HIGH,
  TARGET_EXTRACTION_LOW,
  addShotToFirestore,
  buildDashboardPayload,
  buildExperimentPayload,
  buildOriginsPayload,
  buildRecommendationPayload,
  getDashboardMeta,
  parsePhInput,
  updateShotCellInFirestore,
} from '../../dashboardData'
import { coffeeKey, coffeeLabel, forecast, suggestGrind } from '../../forecastModel'
import { useNav } from '../../navigation'
import { useShots } from '../../shotsStore'
import { useForecastModel, useGrindCalibration } from '../../useModels'
import { InsetGroup, ListRow, PageHeader, PagedRow, SegmentedControl, Sheet, SwipeRow, useBreakpoint } from '../shell'
import DashboardSkeleton from './DashboardSkeleton'
import { LogShotSheet, PH_HINT, ShotDetailSheet } from './ShotSheets'
import { BarChart, GeoScatterPlot, LineChart, ScatterChart } from './charts'
import { formatLongDate, formatNumber, formatPercent, formatShortDate } from './chartUtils'
import {
  RANGE_OPTIONS,
  dateMs,
  grindDisplay,
  latestShotOf,
  overviewKpis,
  phCount,
} from './dashboardStats'
import { AutocompleteInput, ChipSelect, DataTable, Field, MetricCard, Panel } from './ui'

const TAB_OPTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'origins', label: 'Origins' },
  { id: 'log', label: 'Log' },
  { id: 'experiments', label: 'Experiments' },
]

const EMPTY_FILTERS = {
  selected_roasters: [],
  selected_regions: [],
  selected_varieties: [],
  selected_continents: [],
  show_unknown_continent: true,
}

const TARGET_LABEL = `Target ${TARGET_EXTRACTION_LOW}–${TARGET_EXTRACTION_HIGH}%`
const TARGET_BAND = { low: TARGET_EXTRACTION_LOW, high: TARGET_EXTRACTION_HIGH }
const RATING_SERIES = RATING_LABELS.map((label) => ({ key: label, label, color: RATING_COLORS[label] }))
const OFFLINE_SAVE = 'Offline mode is using cached data. Reconnect to Firebase before saving.'
const OFFLINE_EDIT = 'Offline mode is using cached data. Reconnect to Firebase before editing.'

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
  if (!dose) return 0
  return tds * (yieldGrams / dose)
}

function buildShotForm(defaults) {
  const latest = defaults?.latest_values ?? {}
  return {
    entry_date: defaults?.entry_date ?? new Date().toISOString().slice(0, 10),
    roaster: latest.roaster ?? '',
    region: latest.region ?? '',
    continent: latest.continent ?? '',
    temp_c: latest.temp_c ?? 28,
    brix: latest.brix ?? 10,
    ph: latest.ph ?? '',
    dose: latest.dose ?? 18,
    yield_grams: latest.yield_grams ?? 36,
    shot_time: latest.shot_time ?? 30,
    avg_grind: latest.avg_grind ?? '',
    grind_macro: latest.grind_macro ?? '10',
    grind_micro: latest.grind_micro ?? 'E',
    latitude: latest.latitude ?? '',
    longitude: latest.longitude ?? '',
    elevation: latest.elevation ?? '',
    variety: latest.variety ?? '',
    processing_technique: latest.processing_technique ?? '',
    roast: latest.roast ?? '',
    notes: latest.notes ?? '',
    rating_label: latest.rating_label ?? 'Good',
  }
}

function buildExperimentForm(defaults) {
  return {
    roaster: defaults?.roaster ?? '',
    region: defaults?.region ?? '',
    continent: defaults?.continent ?? '',
    variety: defaults?.variety ?? '',
    processing_technique: defaults?.processing_technique ?? '',
    roast: defaults?.roast ?? '',
    temp_c: defaults?.temp_c ?? 28,
    brix: defaults?.brix ?? 10,
    ph: defaults?.ph ?? '',
    dose: defaults?.dose ?? 18,
    yield_grams: defaults?.yield_grams ?? 36,
    shot_time: defaults?.shot_time ?? 30,
    avg_grind: defaults?.avg_grind ?? '',
    grind_setting: defaults?.grind_setting ?? '10E',
  }
}

function formsFromShots(shots) {
  return {
    shot: buildShotForm(buildDashboardPayload(shots).defaults),
    experiment: buildExperimentForm(buildExperimentPayload(shots, {}).defaults),
  }
}

function toggleInSet(setter) {
  return (key) => setter((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
}

function countBy(shots, field) {
  const counts = {}
  shots.forEach((shot) => {
    if (shot[field]) counts[shot[field]] = (counts[shot[field]] || 0) + 1
  })
  return counts
}

function syncLabel(syncState, lastSyncedAt) {
  if (syncState === 'syncing') return 'Syncing…'
  if (syncState === 'live') return 'Live · synced'
  if (syncState === 'offline') {
    const when = lastSyncedAt ? new Date(lastSyncedAt) : null
    const date = when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : null
    return date ? `Offline · cached ${date}` : 'Offline · cached'
  }
  return 'Sync failed'
}

function RatingBadge({ label }) {
  return (
    <span className="dashboard-rating">
      <i className="dashboard-dot" style={{ background: RATING_COLORS[label] }} aria-hidden="true" />
      {label}
    </span>
  )
}

function SyncPill({ syncState, lastSyncedAt }) {
  return (
    <span className="dashboard-sync-pill" data-sync-state={syncState} data-testid="sync-pill" role="status">
      <span className="status-dot" aria-hidden="true" />
      <span className="label">{syncLabel(syncState, lastSyncedAt)}</span>
    </span>
  )
}

const RefreshIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
  </svg>
)

export default function DashboardApp() {
  const { go, shotsTab: activeTab } = useNav()
  const store = useShots()
  const { shots, syncState, lastSyncedAt, loadError, revalidate, reload } = store
  const breakpoint = useBreakpoint()
  const phone = breakpoint === 'phone'
  const meta = getDashboardMeta()

  const [shotForm, setShotForm] = useState(() => (store.shots ? formsFromShots(store.shots).shot : buildShotForm(null)))
  const [experimentForm, setExperimentForm] = useState(() => (store.shots ? formsFromShots(store.shots).experiment : buildExperimentForm(null)))
  const formsReady = useRef(Boolean(store.shots))
  const [originsFilters, setOriginsFilters] = useState(EMPTY_FILTERS)
  const [carryForward, setCarryForward] = useState(true)
  const [carryShot, setCarryShot] = useState(true)
  const [savingShot, setSavingShot] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [detailId, setDetailId] = useState(null)
  const [range, setRange] = useState('30d')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [hiddenRatings, setHiddenRatings] = useState(() => new Set())
  const [hiddenContinents, setHiddenContinents] = useState(() => new Set())

  // First data after an empty start: seed the form defaults from the latest shot.
  useEffect(() => {
    if (shots && !formsReady.current) {
      formsReady.current = true
      const forms = formsFromShots(shots)
      setShotForm(forms.shot)
      setExperimentForm(forms.experiment)
    }
  }, [shots])

  const cal = useGrindCalibration(shots)
  const model = useForecastModel(shots, cal.mean)
  const { estimate } = cal

  const dashboard = useMemo(() => (shots ? buildDashboardPayload(shots) : null), [shots])
  const origins = useMemo(() => (shots ? buildOriginsPayload(shots, originsFilters) : null), [shots, originsFilters])
  const experiment = useMemo(
    () => (shots ? buildExperimentPayload(shots, experimentForm, { calibration: { mean: cal.mean } }) : null),
    [shots, experimentForm, cal.mean],
  )
  const recommendation = useMemo(() => (shots
    ? buildRecommendationPayload(shots, {
      roaster: shotForm.roaster,
      region: shotForm.region,
      variety: shotForm.variety,
      processing_technique: shotForm.processing_technique,
      roast: shotForm.roast,
      continent: shotForm.continent,
    })
    : null), [shots, shotForm.roaster, shotForm.region, shotForm.variety, shotForm.processing_technique, shotForm.roast, shotForm.continent])
  const fieldOptions = dashboard?.field_options ?? {}
  const filterCounts = useMemo(() => ({
    roasters: countBy(shots ?? [], 'roaster'),
    regions: countBy(shots ?? [], 'region'),
    varieties: countBy(shots ?? [], 'variety'),
    continents: countBy(shots ?? [], 'continent'),
  }), [shots])

  const kpis = useMemo(() => overviewKpis(shots ?? [], range, cal.runs), [shots, range, cal.runs])
  const latest = useMemo(() => latestShotOf(shots), [shots])

  // Next-shot forecast: the latest shot's coffee, setting, dose and yield. No pH is assumed.
  const next = useMemo(() => {
    if (!latest || !model) return null
    const planned = {
      coffee: coffeeKey(latest),
      grindSetting: latest.grindSetting,
      dose: latest.dose,
      yieldGrams: latest.yieldGrams,
    }
    const result = forecast(model, planned)
    const suggestion = suggestGrind(model, planned, 20)
    const size = suggestion ? estimate(suggestion.setting) : null
    return {
      planned,
      result,
      suggestion,
      suggestionUm: size && size.kind === 'curve' ? size.um : null,
    }
  }, [latest, model, estimate])

  const preview = (() => {
    const { adjustedTemp, factor } = calculateAdjustmentFactor(Number(shotForm.temp_c || 0))
    const tds = calculateTds(Number(shotForm.brix || 0), factor)
    const extraction = calculateExtraction(tds, Number(shotForm.yield_grams || 0), Number(shotForm.dose || 0))
    return { adjustedTemp, factor, tds, extraction }
  })()
  const previewInRange = preview.extraction >= TARGET_EXTRACTION_LOW && preview.extraction <= TARGET_EXTRACTION_HIGH

  const handleAddShot = async (event) => {
    event.preventDefault()
    if (parsePhInput(shotForm.ph).error) return
    if (syncState !== 'live') {
      setError(OFFLINE_SAVE)
      return
    }
    setSavingShot(true)
    setError('')
    try {
      await addShotToFirestore({ shots: shots ?? [], carryForward, carryShot, fields: shotForm })
      const refreshed = await reload()
      const forms = formsFromShots(refreshed.shots)
      setShotForm(forms.shot)
      setExperimentForm(forms.experiment)
      setNotice('Row added to Firestore.')
      setLogOpen(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingShot(false)
    }
  }

  const handleRefreshData = async () => {
    setError('')
    setNotice('')
    await revalidate()
  }

  const handleDownloadCsv = () => {
    const rows = shots ?? []
    if (!rows.length) return
    const columns = [
      'date', 'roaster', 'region', 'continent', 'variety', 'processingTechnique',
      'elevation', 'roast', 'spray', 'avgGrind', 'grindSetting', 'dose',
      'yieldGrams', 'time', 'tempC', 'brix', 'ph', 'tds', 'extraction', 'rating', 'notes',
    ]
    const body = rows.map((shot) =>
      columns.map((col) => {
        const val = shot[col] ?? ''
        return typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))
          ? `"${val.replace(/"/g, '""')}"`
          : val
      }).join(','))
    const blob = new Blob([[columns.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `espresso-shots-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleCellUpdate = async (rowId, column, value) => {
    if (syncState !== 'live') {
      setError(OFFLINE_EDIT)
      throw new Error('offline')
    }
    setError('')
    try {
      await updateShotCellInFirestore({ shots: shots ?? [], rowId, column, value })
      await reload()
      setNotice(`Updated ${column} in Firestore.`)
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  if (!shots) {
    if (loadError) {
      return (
        <div className="dashboard-app">
          <div className="dashboard-error" role="alert" data-testid="dashboard-error">
            <h2>Couldn’t load your shots</h2>
            <p>{loadError}. Check your connection and try again.</p>
            <button type="button" className="dashboard-primary-button" onClick={revalidate}>Retry</button>
          </div>
        </div>
      )
    }
    return <DashboardSkeleton />
  }

  const setShot = (key) => (event) => setShotForm((prev) => ({ ...prev, [key]: event.target.value }))
  const setSim = (key) => (event) => setExperimentForm((prev) => ({ ...prev, [key]: event.target.value }))
  const continentSeries = (origins?.continent_order ?? []).map((name) => ({
    key: name,
    label: name,
    color: origins.continent_colors[name],
    hollow: name === 'Other',
  }))

  const lastDate = latest?.date ? formatShortDate(latest.date) : null
  const shotsById = new Map(shots.map((shot) => [shot.id, shot]))
  const detailShot = detailId ? shotsById.get(detailId) ?? null : null
  const activeFilterCount = originsFilters.selected_roasters.length + originsFilters.selected_regions.length
    + originsFilters.selected_varieties.length + originsFilters.selected_continents.length
    + (originsFilters.show_unknown_continent ? 0 : 1)

  const openLog = () => { setError(''); setLogOpen(true) }

  /* ---- shared fragments ------------------------------------------------ */

  const phNote = (
    <p className="dashboard-note">
      <span data-testid="ph-coverage">Shots with pH: {phCount(shots)} of {shots.length}</span>
      . {PH_HINT}
    </p>
  )

  const rangeControl = (
    <SegmentedControl
      options={RANGE_OPTIONS.map(({ id, label }) => ({ id, label }))}
      value={range}
      onChange={setRange}
      ariaLabel="Range"
      role="radiogroup"
      testIdPrefix="trend-range-"
      testId="trend-range"
    />
  )

  const trendRows = (dashboard?.charts?.trend_points ?? []).filter((row) => {
    if (range === 'all' || !kpis.anchor) return true
    const days = RANGE_OPTIONS.find((item) => item.id === range)?.days ?? 30
    const t = dateMs(row.Date)
    return t !== null && t > dateMs(kpis.anchor) - days * 86_400_000
  })

  const trendChart = (
    <LineChart
      testId="line-trend"
      data={trendRows}
      xKey="Date"
      yKey="Extraction"
      tickFormat={formatShortDate}
      xLabel={phone ? '' : 'Date'}
      yLabel={phone ? '' : 'Extraction (%)'}
      rolling={!phone}
      height={phone ? 120 : undefined}
      band={TARGET_BAND}
      bandLabel={phone ? '' : TARGET_LABEL}
      tooltip={(row) => [
        `${formatLongDate(row.Date)} · ${row.Roaster ?? '—'}`,
        `Extraction ${formatNumber(row.Extraction)}% · TDS ${formatNumber(row.TDS)}% · ${row['Rating Label']}`,
      ]}
    />
  )

  const kpiCards = [
    <MetricCard
      key="avg"
      testId="metric-extraction"
      label="Average extraction"
      value={kpis.avgExtraction === null ? '—' : formatNumber(kpis.avgExtraction, 1)}
      unit={kpis.avgExtraction === null ? undefined : '%'}
      sub={kpis.delta === null
        ? (kpis.windowCount ? `${kpis.windowCount} shots in range` : 'No shots in range')
        : `${kpis.delta >= 0 ? '▲' : '▼'} ${Math.abs(kpis.delta).toFixed(1)} vs ${kpis.rangeLabel}`}
      subTone={kpis.delta !== null && kpis.delta >= 0 ? 'good' : undefined}
    />,
    <MetricCard
      key="window"
      testId="metric-window"
      label={`In ${TARGET_EXTRACTION_LOW}–${TARGET_EXTRACTION_HIGH}% window`}
      value={kpis.inTargetPct === null ? '—' : kpis.inTargetPct.toFixed(0)}
      unit={kpis.inTargetPct === null ? undefined : '%'}
      bar={kpis.inTargetPct ?? undefined}
      sub="No extraction data in range"
    />,
    <MetricCard
      key="great"
      testId="metric-great"
      label="Rated Great"
      value={kpis.greatCount}
      unit={` of ${kpis.windowCount}`}
      sub={range === 'all' ? 'All shots' : `Last ${RANGE_OPTIONS.find((item) => item.id === range)?.days} days`}
    />,
    <MetricCard
      key="dv50"
      testId="metric-dv50"
      label="Median grind (Dv50)"
      value={kpis.medianDv50 === null ? '—' : Math.round(kpis.medianDv50)}
      unit={kpis.medianDv50 === null ? undefined : ' µm'}
      sub={kpis.medianDv50 === null ? 'No analyzed photos yet' : `From ${kpis.dv50Count} analyzed photo${kpis.dv50Count === 1 ? '' : 's'}`}
    />,
  ]

  const recent = dashboard?.shot_log?.slice(0, phone ? 3 : 5) ?? []

  const ratingLabelOf = (shot) => RATING_LABELS[shot.rating] ?? 'Bad'

  /* ---- next shot forecast --------------------------------------------- */

  const fc = next?.result ?? null
  const reason = model?.available ? 'Forecast unavailable for the latest shot.' : (model?.reason ?? '')
  const grindUmText = fc?.grindUm ? ` (≈ ${Math.round(fc.grindUm.um)} µm)` : ''
  const planNext = () => go('forecast', { params: { coffee: next?.planned.coffee, grindSetting: next?.planned.grindSetting } })
  const rangeText = fc && fc.low !== null && fc.high !== null
    ? `${formatNumber(fc.low, 1)}–${formatNumber(fc.high, 1)}%`
    : null
  const suggestionText = next?.suggestion
    ? `${next.suggestion.setting}${next.suggestionUm ? ` · ≈ ${Math.round(next.suggestionUm)} µm` : ''}`
    : null

  const forecastCard = !latest ? null : phone ? (
    <button type="button" className="dashboard-forecast-compact" onClick={planNext} data-testid="next-shot-forecast" aria-label="Next-shot forecast. Open Forecast">
      <div className="top">
        <span>Next shot · {coffeeLabel(latest)}{latest.dose ? `, ${latest.dose} g in` : ''}</span>
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="#A1A1A6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 1l6 6-6 6" /></svg>
      </div>
      {fc ? (
        <div className="row">
          <p className="big">{formatNumber(fc.extraction, 1)}<small>%</small></p>
          <div className="side">
            <div>{rangeText ? <>Likely <strong>{rangeText}</strong></> : 'Range after 13 shots'}</div>
            {suggestionText && <div>Suggested grind <strong>{suggestionText}</strong></div>}
          </div>
        </div>
      ) : <p className="reason">{reason}</p>}
    </button>
  ) : (
    <aside className="dashboard-forecast-card" data-testid="next-shot-forecast" aria-label="Next-shot forecast">
      <p className="kicker">Next-shot forecast</p>
      {fc ? (
        <>
          <p className="for">For {coffeeLabel(latest)} at grind {latest.grindSetting}{grindUmText}{latest.dose ? `, ${latest.dose} g in` : ''}</p>
          <p className="big">{formatNumber(fc.extraction, 1)}<small>%</small></p>
          <p className="range">
            {rangeText ? <>Likely range <strong>{rangeText}</strong></> : 'Likely range appears once 13 shots are logged'}
            {fc.coffeeShots ? ` · based on ${fc.coffeeShots} shot${fc.coffeeShots === 1 ? '' : 's'} of this coffee` : ''}
          </p>
          {suggestionText && <p className="range">Suggested grind <strong>{suggestionText}</strong></p>}
        </>
      ) : <p className="reason">{reason}</p>}
      <button type="button" className="dashboard-forecast-cta" onClick={planNext}>Plan next shot</button>
    </aside>
  )

  /* ---- overview -------------------------------------------------------- */

  const recentTable = (
    <div className="dashboard-table-wrap" data-testid="recent-shots">
      <div className="dashboard-table-scroll">
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Coffee</th>
              <th className="num">Setting</th>
              <th className="num">Avg grind</th>
              <th className="num">pH</th>
              <th className="num">Extraction</th>
              <th>Rating</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((row) => {
              const shot = shotsById.get(row.__row_id)
              if (!shot) return null
              const grind = grindDisplay(shot, estimate)
              return (
                <tr key={shot.id}>
                  <td className="muted">{formatShortDate(shot.date)}</td>
                  <td>{coffeeLabel(shot)}</td>
                  <td className="num">{shot.grindSetting || '—'}</td>
                  <td className="num">
                    {grind
                      ? (grind.estimated
                        ? <span className="muted">≈ {Math.round(grind.um)} µm<span className="est">est.</span></span>
                        : `${Math.round(grind.um)} µm`)
                      : <span className="muted">–</span>}
                  </td>
                  <td className="num">{Number.isFinite(shot.ph) ? shot.ph : <span className="muted" aria-label="not measured">–</span>}</td>
                  <td className="num">{Number.isFinite(shot.extraction) ? `${formatNumber(shot.extraction, 1)}%` : '—'}</td>
                  <td><RatingBadge label={ratingLabelOf(shot)} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )

  const shotRowContent = (shot) => (
    <div className="dashboard-shot-row">
      <span className="main">
        <strong>{coffeeLabel(shot)}</strong>
        <span>{formatShortDate(shot.date)}{shot.grindSetting ? ` · ${shot.grindSetting}` : ''}</span>
      </span>
      <span className="end">
        <span>{Number.isFinite(shot.extraction) ? `${formatNumber(shot.extraction, 1)}%` : '—'}</span>
        <RatingBadge label={ratingLabelOf(shot)} />
      </span>
    </div>
  )

  const overviewPhone = (
    <section className="dashboard-tab-panel compact" role="tabpanel" aria-label="Overview" data-testid="panel-overview">
      {forecastCard}
      <PagedRow ariaLabel="Key figures" testId="metrics-row">{kpiCards}</PagedRow>
      <Panel title="Extraction" actions={rangeControl} testId="panel-trend">{trendChart}</Panel>
      <section aria-label="Recent shots" data-testid="recent-shots">
        <div className="dashboard-section-head">
          <h2>Recent shots</h2>
          <span className="dashboard-note dashboard-section-meta" data-testid="ph-coverage">Shots with pH: {phCount(shots)} of {shots.length}</span>
          <button type="button" className="link" onClick={() => go('shots', { tab: 'log' })}>See all</button>
        </div>
        <InsetGroup>
          {recent.map((row) => {
            const shot = shotsById.get(row.__row_id)
            return shot ? (
              <ListRow
                key={shot.id}
                onClick={() => setDetailId(shot.id)}
                title={coffeeLabel(shot)}
                subtitle={`${formatShortDate(shot.date)}${shot.grindSetting ? ` · ${shot.grindSetting}` : ''}`}
                detail={(
                  <>
                    <strong className="dashboard-row-ext">{Number.isFinite(shot.extraction) ? `${formatNumber(shot.extraction, 1)}%` : '—'}</strong>
                    <RatingBadge label={ratingLabelOf(shot)} />
                  </>
                )}
              />
            ) : null
          })}
        </InsetGroup>
      </section>
    </section>
  )

  const overviewWide = (
    <section className="dashboard-tab-panel" role="tabpanel" aria-label="Overview" data-testid="panel-overview">
      <section className="dashboard-metrics-row" data-testid="metrics-row" aria-label="Key figures">{kpiCards}</section>
      <Panel title="Extraction over time" actions={rangeControl} testId="panel-trend">{trendChart}</Panel>
      <div className="dashboard-split">
        <Panel
          title="Recent shots"
          testId="panel-recent"
          actions={<button type="button" className="link" onClick={() => go('shots', { tab: 'log' })}>See all</button>}
        >
          {recentTable}
          {phNote}
        </Panel>
        {forecastCard}
      </div>
      <Panel title="TDS vs. Extraction" testId="panel-scatter">
        <ScatterChart
          testId="scatter-rating"
          data={dashboard?.charts?.scatter_points ?? []}
          xKey="Extraction"
          yKey="TDS"
          colorKey="Rating Label"
          series={RATING_SERIES}
          hidden={hiddenRatings}
          onToggle={toggleInSet(setHiddenRatings)}
          band={TARGET_BAND}
          bandLabel={TARGET_LABEL}
          xLabel="Extraction (%)"
          yLabel="TDS (%)"
          tooltip={(row) => [
            `${formatLongDate(row.Date)} · ${row.Roaster ?? '—'}`,
            `Extraction ${formatNumber(row.Extraction)}% · TDS ${formatNumber(row.TDS)}% · ${row['Grind Setting'] ?? '—'}`,
          ]}
        />
      </Panel>
    </section>
  )

  /* ---- origins --------------------------------------------------------- */

  const filterControls = (
    <>
      <ChipSelect label="Roaster" options={origins?.options?.roasters ?? []} counts={filterCounts.roasters} value={originsFilters.selected_roasters} onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_roasters: value }))} />
      <ChipSelect label="Region" options={origins?.options?.regions ?? []} counts={filterCounts.regions} value={originsFilters.selected_regions} onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_regions: value }))} />
      <ChipSelect label="Variety" options={origins?.options?.varieties ?? []} counts={filterCounts.varieties} value={originsFilters.selected_varieties} onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_varieties: value }))} />
      <ChipSelect label="Continent" options={origins?.options?.continents ?? []} counts={filterCounts.continents} value={originsFilters.selected_continents} onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_continents: value }))} />
    </>
  )

  const unknownSwitch = (
    <button
      type="button"
      role="switch"
      aria-checked={originsFilters.show_unknown_continent}
      className="dashboard-switch"
      onClick={() => setOriginsFilters((prev) => ({ ...prev, show_unknown_continent: !prev.show_unknown_continent }))}
    >
      <span className="dashboard-switch-track" aria-hidden="true" />
      Show unknown continent
    </button>
  )

  const resetButton = (
    <button type="button" className="dashboard-secondary-button" onClick={() => setOriginsFilters(EMPTY_FILTERS)}>
      Reset filters
    </button>
  )

  const mapPanel = (
    <Panel title="Origin coordinates" testId="panel-map" className="dashboard-panel-map">
      <GeoScatterPlot points={origins?.map_points ?? []} series={continentSeries} hidden={hiddenContinents} onToggle={toggleInSet(setHiddenContinents)} />
    </Panel>
  )

  const filtersPanel = (
    <section className="dashboard-panel dashboard-filters-panel" aria-label="Filters" data-testid="panel-origins-filters">
      <div className="dashboard-filter-toolbar">{filterControls}</div>
      <div className="dashboard-filter-row">
        {unknownSwitch}
        {resetButton}
      </div>
    </section>
  )

  const continentPanel = (
    <Panel title="Extraction vs. TDS by continent" testId="panel-continent-scatter">
      <ScatterChart
        testId="scatter-continent"
        data={origins?.chart_points ?? []}
        xKey="Extraction"
        yKey="TDS"
        colorKey="Continent Display"
        series={continentSeries}
        hidden={hiddenContinents}
        onToggle={toggleInSet(setHiddenContinents)}
        band={TARGET_BAND}
        bandLabel={TARGET_LABEL}
        xLabel="Extraction (%)"
        yLabel="TDS (%)"
        tooltip={(row) => [
          `${row.Roaster ?? '—'} · ${row.Region ?? '—'}`,
          `${row.Continent} · ${formatLongDate(row.Date)} · Extraction ${formatNumber(row.Extraction)}%`,
        ]}
      />
    </Panel>
  )

  const originRows = origins?.table_rows ?? []
  const originsView = (
    <section className="dashboard-tab-panel" role="tabpanel" aria-label="Origins" data-testid="panel-origins">
      {phone ? (
        <>
          <button type="button" className="dashboard-filters-button" onClick={() => setFiltersOpen(true)} data-testid="origins-filters-open">
            <span>Filters</span>
            <span className="dashboard-filters-count">{activeFilterCount ? `${activeFilterCount} active` : 'All'}</span>
          </button>
          {mapPanel}
          <section aria-label="Origins log" data-testid="panel-origins-log">
            <div className="dashboard-section-head"><h2>Origins log</h2><span className="dashboard-note">{originRows.length} of {shots.length}</span></div>
            {originRows.length ? (
              <InsetGroup>
                {originRows.slice(0, 20).map((row) => (
                  <ListRow
                    key={row.__row_id}
                    onClick={() => setDetailId(row.__row_id)}
                    title={[row.Roaster, row.Region].filter(Boolean).join(' · ') || 'Unknown coffee'}
                    subtitle={`${[row.Continent, row.Variety].filter(Boolean).join(' · ') || '—'} · ${formatShortDate(row.Date)}`}
                    detail={(
                      <>
                        <strong className="dashboard-row-ext">{Number.isFinite(row.Extraction) ? `${formatNumber(row.Extraction, 1)}%` : '—'}</strong>
                        <RatingBadge label={row['Rating Label']} />
                      </>
                    )}
                  />
                ))}
              </InsetGroup>
            ) : <div className="dashboard-empty-state">No shots match these filters.</div>}
          </section>
          <Sheet
            open={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            title="Filters"
            initialDetent="large"
            leftAction={{ label: 'Reset', onClick: () => setOriginsFilters(EMPTY_FILTERS) }}
            rightAction={{ label: 'Done', onClick: () => setFiltersOpen(false) }}
            testId="origins-filters-sheet"
          >
            <div className="dashboard-form-card dashboard-filter-sheet">
              {filterControls}
              {unknownSwitch}
            </div>
          </Sheet>
        </>
      ) : (
        <>
          {breakpoint === 'tablet' ? <>{mapPanel}{filtersPanel}</> : <>{filtersPanel}{mapPanel}</>}
          {continentPanel}
          <Panel title="Filtered origins log" testId="panel-origins-log">
            <DataTable testId="table-origins-log" rows={originRows} totalCount={shots.length} editable onUpdateCell={handleCellUpdate} />
          </Panel>
        </>
      )}
    </section>
  )

  /* ---- log ------------------------------------------------------------- */

  const logRowsWithEstimate = (dashboard?.shot_log ?? []).map((row) => {
    const out = {}
    Object.keys(row).forEach((key) => {
      out[key] = row[key]
      if (key === 'Avg Grind') {
        const shot = shotsById.get(row.__row_id)
        const grind = shot && !row['Avg Grind'] ? grindDisplay(shot, estimate) : null
        out['Est. grind (µm)'] = grind?.estimated ? `≈ ${Math.round(grind.um)}` : null
      }
    })
    return out
  })

  const logView = (
    <section className="dashboard-tab-panel" role="tabpanel" aria-label="Log" data-testid="panel-log">
      {phone ? (
        <section aria-label="Shot log">
          <div className="dashboard-section-head">
            <h2>All shots · {shots.length}</h2>
            <span className="dashboard-note" data-testid="ph-coverage">pH on {phCount(shots)} of {shots.length}</span>
          </div>
          <div className="el-inset-body" data-testid="table-shot-log">
            {(dashboard?.shot_log ?? []).map((row) => {
              const shot = shotsById.get(row.__row_id)
              if (!shot) return null
              return (
                <SwipeRowLazy
                  key={shot.id}
                  shot={shot}
                  onTap={() => setDetailId(shot.id)}
                  onEdit={() => setDetailId(shot.id)}
                >
                  {shotRowContent(shot)}
                </SwipeRowLazy>
              )
            })}
          </div>
          <p className="dashboard-note dashboard-note-tight">Tap a shot to see it, or swipe left to edit it. {PH_HINT}</p>
        </section>
      ) : (
        <Panel title="Shot log" testId="panel-shot-log">
          {phNote}
          <DataTable
            testId="table-shot-log"
            rows={logRowsWithEstimate}
            editable
            onUpdateCell={handleCellUpdate}
            readOnlyColumns={['Est. grind (µm)']}
          />
        </Panel>
      )}
    </section>
  )

  /* ---- experiments ----------------------------------------------------- */

  const backtest = experiment?.metrics?.backtest ?? null
  const experimentsView = (
    <section className="dashboard-tab-panel" role="tabpanel" aria-label="Experiments" data-testid="panel-experiments">
      <Panel
        title="Experiments"
        subtitle="Directional estimates from your logged shot history; treat them as suggestions, not ground truth."
        testId="panel-experiment"
      >
        {!experiment?.available && <div className="dashboard-empty-state">{experiment?.message ?? 'Experiment data unavailable.'}</div>}
        {experiment?.available && (
          <>
            <section className="dashboard-metrics-row" data-testid="model-metrics">
              <MetricCard label="Model rows" value={experiment.metrics.rows} />
              <MetricCard label="Typical miss (MAE)" value={backtest ? formatNumber(backtest.mae) : '—'} unit={backtest ? ' pts' : undefined} />
              <MetricCard label="Always your average" value={backtest ? formatNumber(backtest.baselineMae) : '—'} unit={backtest ? ' pts' : undefined} />
              <MetricCard label="Within ±1%" value={backtest ? formatPercent(backtest.within1) : '—'} />
            </section>
            <p className="dashboard-note">
              {backtest ? null : <>Accuracy is measured once you have 13 shots. </>}
              <button type="button" className="link" onClick={() => go('diagnostics')}>How this is measured ›</button>
            </p>

            <details className="dashboard-sim-inputs" data-testid="sim-inputs">
              <summary>Simulation inputs</summary>
              <div className="dashboard-fieldset-grid">
                <Field label="Sim Roaster"><AutocompleteInput scope="experiment" field="roaster" value={experimentForm.roaster} options={fieldOptions.roaster} onChange={setSim('roaster')} /></Field>
                <Field label="Sim Region"><AutocompleteInput scope="experiment" field="region" value={experimentForm.region} options={fieldOptions.region} onChange={setSim('region')} /></Field>
                <Field label="Sim Continent"><AutocompleteInput scope="experiment" field="continent" value={experimentForm.continent} options={fieldOptions.continent} onChange={setSim('continent')} /></Field>
                <Field label="Sim Variety"><AutocompleteInput scope="experiment" field="variety" value={experimentForm.variety} options={fieldOptions.variety} onChange={setSim('variety')} /></Field>
                <Field label="Sim Processing Technique"><AutocompleteInput scope="experiment" field="processing_technique" value={experimentForm.processing_technique} options={fieldOptions.processing_technique} onChange={setSim('processing_technique')} /></Field>
                <Field label="Sim Roast"><AutocompleteInput scope="experiment" field="roast" value={experimentForm.roast} options={fieldOptions.roast} onChange={setSim('roast')} /></Field>
                <Field label="Sim Temperature (C)"><input type="number" step="0.1" value={experimentForm.temp_c} onChange={setSim('temp_c')} /></Field>
                <Field label="Sim Brix"><input type="number" step="0.1" value={experimentForm.brix} onChange={setSim('brix')} /></Field>
                <Field label="Sim pH (optional)"><input type="number" step="0.01" min="3.5" max="8" placeholder="e.g. 5.4" value={experimentForm.ph} onChange={setSim('ph')} /></Field>
                <Field label="Sim Dose (g)"><input type="number" step="0.1" value={experimentForm.dose} onChange={setSim('dose')} /></Field>
                <Field label="Sim Yield (g)"><input type="number" step="0.1" value={experimentForm.yield_grams} onChange={setSim('yield_grams')} /></Field>
                <Field label="Sim Time (s)"><input type="number" step="1" value={experimentForm.shot_time} onChange={setSim('shot_time')} /></Field>
                <Field label="Sim Avg Grind (µm)"><AutocompleteInput scope="experiment" field="avg_grind" value={experimentForm.avg_grind} options={fieldOptions.avg_grind} onChange={setSim('avg_grind')} /></Field>
                <Field label="Sim Grind Setting"><AutocompleteInput scope="experiment" field="grind_setting" value={experimentForm.grind_setting} options={fieldOptions.grind_setting} onChange={setSim('grind_setting')} /></Field>
              </div>
            </details>
          </>
        )}
      </Panel>

      {experiment?.available && (
        <>
          <div className="dashboard-grid">
            <Panel title="Current shot model read" testId="panel-prediction">
              <div className="dashboard-prediction-card">
                <p className="dashboard-card-label">Predicted extraction</p>
                <h3>{formatNumber(experiment.prediction.extraction)}%</h3>
                {experiment.prediction.low != null && experiment.prediction.high != null && (
                  <p>Likely range {formatNumber(experiment.prediction.low, 1)}–{formatNumber(experiment.prediction.high, 1)}%</p>
                )}
                <p>Predicted cup rating: {experiment.prediction.predicted_rating_label}</p>
                <p>
                  Great probability {formatPercent(experiment.prediction.great_probability)} · Good probability {formatPercent(experiment.prediction.good_probability)}
                </p>
              </div>
            </Panel>
            <Panel title="Quality read" testId="panel-quality">
              <div className="dashboard-quality-grid">
                <MetricCard label="Target window" value={experiment.prediction.within_target ? 'Inside' : 'Outside'} />
                <MetricCard label="Distance from 20%" value={formatNumber(experiment.prediction.distance_from_target_center)} />
                <MetricCard label="Setup familiarity" value={experiment.prediction.novelty_flag ? 'Unusual' : 'In family'} />
                <MetricCard label="Novelty score" value={formatNumber(experiment.prediction.novelty_score)} />
              </div>
            </Panel>
          </div>

          <div className="dashboard-grid">
            <Panel title="Grind sweep simulator" testId="panel-sweep">
              <LineChart
                testId="line-sweep"
                data={experiment.grind_sweep ?? []}
                xKey="Grind Index"
                tickKey="Grind Setting"
                yKey="Predicted Extraction"
                xLabel="Grind setting"
                yLabel="Predicted extraction (%)"
                band={experiment.target_window}
                bandLabel={TARGET_LABEL}
                tooltip={(row) => [
                  `${row['Grind Setting']}${row['Grind µm (est.)'] != null ? ` · ≈ ${row['Grind µm (est.)']} µm (est.)` : ''}`,
                  `Predicted ${formatNumber(row['Predicted Extraction'])}% · Great ${formatPercent(row['Great Probability'])}`,
                ]}
              />
            </Panel>
            <Panel title="Top grind candidates" testId="panel-candidates">
              <DataTable rows={experiment.best_candidates ?? []} />
            </Panel>
          </div>

          <div className="dashboard-grid">
            <Panel title="Closest successful historical shots" testId="panel-similar">
              <DataTable rows={experiment.similar_successes ?? []} />
            </Panel>
            <Panel title="Target window leaders" testId="panel-leaders">
              <BarChart data={experiment.target_leaders ?? []} />
            </Panel>
          </div>
        </>
      )}
    </section>
  )

  const kicker = (
    <>
      <span data-testid="shots-count">{shots.length} shots logged{lastDate ? ` · last ${lastDate}` : ''}</span>
      <SyncPill syncState={syncState} lastSyncedAt={lastSyncedAt} />
      {phone && (
        <button type="button" className="dashboard-icon-button" onClick={handleRefreshData} disabled={syncState === 'syncing'} data-testid="refresh-data" aria-label="Refresh data">
          <RefreshIcon />
        </button>
      )}
    </>
  )

  return (
    <div className="dashboard-app" data-testid="dashboard-app">
      <PageHeader
        testId="shots-header"
        kicker={kicker}
        title="Shots"
        phoneAction={{ label: 'Log a shot', onClick: openLog, testId: 'log-shot-open' }}
        actions={(
          <>
            <button type="button" className="dashboard-secondary-button" onClick={handleRefreshData} disabled={syncState === 'syncing'} data-testid="refresh-data">
              {syncState === 'syncing' ? 'Syncing…' : 'Refresh'}
            </button>
            <button type="button" className="dashboard-secondary-button" onClick={handleDownloadCsv} disabled={!shots.length}>
              Export CSV
            </button>
            <button type="button" className="dashboard-primary-button" onClick={openLog} data-testid="log-shot-open">
              Log a shot
            </button>
          </>
        )}
      />

      {notice && <div className="dashboard-notice" role="status">{notice}</div>}
      {error && !logOpen && <div className="dashboard-error-banner" role="alert">{error}</div>}

      <SegmentedControl
        className="dashboard-tabbar"
        testId="tabbar"
        options={TAB_OPTIONS}
        value={activeTab}
        onChange={(id) => go('shots', { tab: id })}
        ariaLabel="Shots views"
        itemClassName="dashboard-tab"
        testIdPrefix="tab-"
        trailing={phone ? null : (
          <button type="button" className="dashboard-tab-link" onClick={() => go('diagnostics')}>Diagnostics</button>
        )}
      />

      {activeTab === 'overview' && (phone ? overviewPhone : overviewWide)}
      {activeTab === 'origins' && originsView}
      {activeTab === 'log' && logView}
      {activeTab === 'experiments' && experimentsView}

      <LogShotSheet
        open={logOpen}
        onClose={() => setLogOpen(false)}
        shotForm={shotForm}
        setShot={setShot}
        fieldOptions={fieldOptions}
        meta={meta}
        preview={preview}
        previewInRange={previewInRange}
        recommendation={recommendation}
        carryForward={carryForward}
        setCarryForward={setCarryForward}
        carryShot={carryShot}
        setCarryShot={setCarryShot}
        onSubmit={handleAddShot}
        saving={savingShot}
        error={error}
      />
      {phone && (
        <ShotDetailSheet
          shot={detailShot}
          onClose={() => setDetailId(null)}
          syncState={syncState}
          shots={shots}
          reload={reload}
          estimate={estimate}
        />
      )}
    </div>
  )
}

/** A phone log row: swipe left (or hover/focus) for the Edit action. */
function SwipeRowLazy({ shot, onTap, onEdit, children }) {
  return (
    <SwipeRow
      testId={`log-row-${shot.id}`}
      onTap={onTap}
      actions={[{ label: 'Edit', tone: 'default', onAction: onEdit }]}
    >
      {children}
    </SwipeRow>
  )
}
