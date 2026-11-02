import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  fetchShotsFromServer,
  getDashboardMeta,
  loadShotsData,
  readCachedShots,
  updateShotCellInFirestore,
} from '../../dashboardData'
import DashboardSkeleton from './DashboardSkeleton'
import { BarChart, GeoScatterPlot, LineChart, ScatterChart } from './charts'
import { formatLongDate, formatNumber, formatPercent, formatShortDate } from './chartUtils'
import { AutocompleteInput, ChipSelect, DataTable, Field, MetricCard, Panel } from './ui'

const TAB_OPTIONS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'origins', label: 'Coffee Origins' },
  { id: 'experiment', label: 'Experiment' },
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
    ph: latest.ph ?? 5.2,
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
    ph: defaults?.ph ?? 5.2,
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

function syncLabel(syncState, shotsState) {
  if (syncState === 'syncing') return 'Syncing…'
  if (syncState === 'live') return 'Live · synced'
  if (syncState === 'offline') {
    const when = shotsState?.lastSyncedAt ? new Date(shotsState.lastSyncedAt) : null
    const date = when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : null
    return date ? `Offline · cached ${date}` : 'Offline · cached'
  }
  return 'Sync failed'
}

export default function DashboardApp() {
  const [initial] = useState(() => readCachedShots())
  const [initialForms] = useState(() => (initial ? formsFromShots(initial.shots) : null))
  const [shotsState, setShotsState] = useState(initial)
  const [syncState, setSyncState] = useState('syncing')
  const [activeTab, setActiveTab] = useState('dashboard')
  const [shotForm, setShotForm] = useState(() => initialForms?.shot ?? buildShotForm(null))
  const [experimentForm, setExperimentForm] = useState(() => initialForms?.experiment ?? buildExperimentForm(null))
  const [originsFilters, setOriginsFilters] = useState(EMPTY_FILTERS)
  const [carryForward, setCarryForward] = useState(true)
  const [carryShot, setCarryShot] = useState(true)
  const [savingShot, setSavingShot] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [hiddenRatings, setHiddenRatings] = useState(() => new Set())
  const [hiddenContinents, setHiddenContinents] = useState(() => new Set())
  const hasData = useRef(Boolean(initial))
  const alive = useRef(true)
  const meta = getDashboardMeta()

  const shots = shotsState?.shots
  const dashboard = useMemo(() => (shots ? buildDashboardPayload(shots) : null), [shots])
  const origins = useMemo(() => (shots ? buildOriginsPayload(shots, originsFilters) : null), [shots, originsFilters])
  const experiment = useMemo(() => (shots ? buildExperimentPayload(shots, experimentForm) : null), [shots, experimentForm])
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

  // Stale-while-revalidate: paint the cached snapshot instantly, then ask the server.
  const revalidate = useCallback(async () => {
    setSyncState('syncing')
    setLoadError('')
    try {
      const next = await fetchShotsFromServer({ timeoutMs: 6000 })
      if (!alive.current) return
      const firstLoad = !hasData.current
      hasData.current = true
      setShotsState(next)
      setSyncState('live')
      if (firstLoad) {
        const forms = formsFromShots(next.shots)
        setShotForm(forms.shot)
        setExperimentForm(forms.experiment)
      }
    } catch (err) {
      if (!alive.current) return
      if (hasData.current) {
        setSyncState('offline')
      } else {
        setSyncState('error')
        setLoadError(err.message || 'Unable to reach Firestore.')
      }
    }
  }, [])

  useEffect(() => {
    alive.current = true
    revalidate()
    return () => { alive.current = false }
  }, [revalidate])

  const preview = (() => {
    const { adjustedTemp, factor } = calculateAdjustmentFactor(Number(shotForm.temp_c || 0))
    const tds = calculateTds(Number(shotForm.brix || 0), factor)
    const extraction = calculateExtraction(tds, Number(shotForm.yield_grams || 0), Number(shotForm.dose || 0))
    return { adjustedTemp, factor, tds, extraction }
  })()
  const previewInRange = preview.extraction >= TARGET_EXTRACTION_LOW && preview.extraction <= TARGET_EXTRACTION_HIGH

  const refreshShots = async ({ message = '', resetShotForm = false, resetExperimentForm = false } = {}) => {
    const next = await loadShotsData()
    hasData.current = true
    setShotsState(next)
    setSyncState(next.source === 'firebase' ? 'live' : 'offline')
    if (resetShotForm || resetExperimentForm) {
      const forms = formsFromShots(next.shots)
      if (resetShotForm) setShotForm(forms.shot)
      if (resetExperimentForm) setExperimentForm(forms.experiment)
    }
    if (message) setNotice(message)
  }

  const handleAddShot = async (event) => {
    event.preventDefault()
    if (syncState !== 'live') {
      setError('Offline mode is using cached data. Reconnect to Firebase before saving.')
      return
    }
    setSavingShot(true)
    setError('')
    try {
      await addShotToFirestore({ shots: shotsState?.shots ?? [], carryForward, carryShot, fields: shotForm })
      await refreshShots({ message: 'Row added to Firestore.', resetShotForm: true, resetExperimentForm: true })
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
    const rows = shotsState?.shots ?? []
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
      setError('Offline mode is using cached data. Reconnect to Firebase before editing.')
      throw new Error('offline')
    }
    setError('')
    try {
      await updateShotCellInFirestore({ shots: shotsState?.shots ?? [], rowId, column, value })
      await refreshShots({ message: `Updated ${column} in Firestore.` })
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  if (!shotsState) {
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

  const metrics = dashboard?.metrics ?? {}
  const avgExtraction = metrics.average_extraction
  const extractionInRange = Number.isFinite(avgExtraction) && avgExtraction >= TARGET_EXTRACTION_LOW && avgExtraction <= TARGET_EXTRACTION_HIGH
  const avgRating = metrics.average_rating
  const ratingLabel = Number.isFinite(avgRating) ? RATING_LABELS[clampIndex(Math.round(avgRating))] : '—'

  const setShot = (key) => (event) => setShotForm((prev) => ({ ...prev, [key]: event.target.value }))
  const setSim = (key) => (event) => setExperimentForm((prev) => ({ ...prev, [key]: event.target.value }))
  const continentSeries = (origins?.continent_order ?? []).map((name) => ({
    key: name,
    label: name,
    color: origins.continent_colors[name],
    hollow: name === 'Other',
  }))

  return (
    <div className="dashboard-app" data-testid="dashboard-app">
      <header className="dashboard-hero">
        <div className="dashboard-hero-text">
          <div className="dashboard-kicker-row">
            <p className="dashboard-kicker">Espresso journal</p>
            <span className="dashboard-sync-pill" data-sync-state={syncState} data-testid="sync-pill" role="status">
              <span className="status-dot" aria-hidden="true" />
              {syncLabel(syncState, shotsState)}
            </span>
          </div>
          <h1>Shot dashboard</h1>
          <p className="dashboard-caption">Log a shot; the grind recommendation updates as you type.</p>
        </div>
        <div className="dashboard-hero-actions">
          <button type="button" className="dashboard-secondary-button" onClick={handleRefreshData} disabled={syncState === 'syncing'} data-testid="refresh-data">
            {syncState === 'syncing' ? 'Syncing…' : 'Refresh data'}
          </button>
          <button type="button" className="dashboard-secondary-button" onClick={handleDownloadCsv} disabled={!shotsState?.shots?.length}>
            Download CSV
          </button>
        </div>
      </header>

      {notice && <div className="dashboard-notice" role="status">{notice}</div>}
      {error && <div className="dashboard-error-banner" role="alert">{error}</div>}

      <section className="dashboard-metrics-row" data-testid="metrics-row">
        <MetricCard
          testId="metric-shots"
          label="Shots Logged"
          value={metrics.shots_logged ?? 0}
          sub={metrics.last_shot_date ? `last ${formatShortDate(metrics.last_shot_date)}` : 'no shots yet'}
        />
        <MetricCard testId="metric-tds" label="Average TDS" value={formatNumber(metrics.average_tds)} sub="% dissolved solids" />
        <MetricCard
          testId="metric-extraction"
          label="Average Extraction"
          value={formatNumber(avgExtraction)}
          sub={`target ${TARGET_EXTRACTION_LOW}–${TARGET_EXTRACTION_HIGH}%`}
          subTone={Number.isFinite(avgExtraction) ? (extractionInRange ? 'good' : 'bad') : undefined}
        />
        <MetricCard
          testId="metric-rating"
          label="Average Rating"
          value={ratingLabel}
          sub={`${formatNumber(avgRating)} / 2`}
        />
      </section>

      <nav className="dashboard-tabbar" role="tablist" aria-label="Dashboard sections" data-testid="tabbar">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            data-testid={`tab-${tab.id}`}
            className={`dashboard-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'dashboard' && (
        <section className="dashboard-tab-panel" role="tabpanel">
          <Panel title="Add historical shot" testId="panel-add-shot">
            <form className="dashboard-form" onSubmit={handleAddShot} data-testid="shot-form">
              <div className="dashboard-inline-toggles">
                <label className="dashboard-toggle">
                  <input type="checkbox" checked={carryForward} onChange={(event) => setCarryForward(event.target.checked)} />
                  <span>Carry forward previous values</span>
                </label>
                <label className="dashboard-toggle">
                  <input type="checkbox" checked={carryShot} onChange={(event) => setCarryShot(event.target.checked)} />
                  <span>Carry forward previous pull settings</span>
                </label>
              </div>

              <fieldset className="dashboard-fieldset">
                <legend>Coffee</legend>
                <div className="dashboard-fieldset-grid">
                  <Field label="Roaster"><AutocompleteInput scope="shot" field="roaster" value={shotForm.roaster} options={fieldOptions.roaster} onChange={setShot('roaster')} /></Field>
                  <Field label="Region"><AutocompleteInput scope="shot" field="region" value={shotForm.region} options={fieldOptions.region} onChange={setShot('region')} /></Field>
                  <Field label="Continent"><AutocompleteInput scope="shot" field="continent" value={shotForm.continent} options={fieldOptions.continent} onChange={setShot('continent')} /></Field>
                  <Field label="Variety"><AutocompleteInput scope="shot" field="variety" value={shotForm.variety} options={fieldOptions.variety} onChange={setShot('variety')} /></Field>
                  <Field label="Processing Technique"><AutocompleteInput scope="shot" field="processing_technique" value={shotForm.processing_technique} options={fieldOptions.processing_technique} onChange={setShot('processing_technique')} /></Field>
                  <Field label="Roast"><AutocompleteInput scope="shot" field="roast" value={shotForm.roast} options={fieldOptions.roast} onChange={setShot('roast')} /></Field>
                </div>
                <details className="dashboard-details" data-testid="origin-coords">
                  <summary>Origin coordinates</summary>
                  <div className="dashboard-fieldset-grid">
                    <Field label="Lat"><input value={shotForm.latitude} onChange={setShot('latitude')} /></Field>
                    <Field label="Long"><input value={shotForm.longitude} onChange={setShot('longitude')} /></Field>
                    <Field label="Elevation"><AutocompleteInput scope="shot" field="elevation" value={shotForm.elevation} options={fieldOptions.elevation} onChange={setShot('elevation')} /></Field>
                  </div>
                </details>
              </fieldset>

              <fieldset className="dashboard-fieldset">
                <legend>Recipe</legend>
                <div className="dashboard-fieldset-grid">
                  <Field label="Date"><input type="date" value={shotForm.entry_date} onChange={setShot('entry_date')} /></Field>
                  <Field label="Dose (g)"><input type="number" step="0.1" value={shotForm.dose} onChange={setShot('dose')} /></Field>
                  <Field label="Output / Yield (g)"><input type="number" step="0.1" value={shotForm.yield_grams} onChange={setShot('yield_grams')} /></Field>
                  <Field label="Time (s)"><input type="number" step="1" value={shotForm.shot_time} onChange={setShot('shot_time')} /></Field>
                  <Field label="Grind Macro">
                    <select value={shotForm.grind_macro} onChange={setShot('grind_macro')}>
                      {meta.macro_options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </Field>
                  <Field label="Grind Micro">
                    <select value={shotForm.grind_micro} onChange={setShot('grind_micro')}>
                      {meta.micro_options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </Field>
                  <Field label="Grind Size (µm)"><AutocompleteInput scope="shot" field="avg_grind" value={shotForm.avg_grind} options={fieldOptions.avg_grind} onChange={setShot('avg_grind')} /></Field>
                </div>
              </fieldset>

              <fieldset className="dashboard-fieldset">
                <legend>Measurement</legend>
                <div className="dashboard-fieldset-grid">
                  <Field label="Temperature (C)"><input type="number" step="0.1" value={shotForm.temp_c} onChange={setShot('temp_c')} /></Field>
                  <Field label="Brix"><input type="number" step="0.1" value={shotForm.brix} onChange={setShot('brix')} /></Field>
                  <Field label="pH"><input type="number" step="0.01" value={shotForm.ph} onChange={setShot('ph')} /></Field>
                  <Field label="TDS"><input value={formatNumber(preview.tds)} disabled /></Field>
                </div>
              </fieldset>

              <fieldset className="dashboard-fieldset">
                <legend>Result</legend>
                <div className="dashboard-fieldset-grid">
                  <div className="dashboard-field">
                    <span id="rating-label">Rating</span>
                    <div className="dashboard-segmented" role="radiogroup" aria-labelledby="rating-label" data-testid="rating-segmented">
                      {meta.rating_labels.map((label) => (
                        <label key={label} className={shotForm.rating_label === label ? 'checked' : ''}>
                          <input type="radio" name="rating_label" value={label} checked={shotForm.rating_label === label} onChange={setShot('rating_label')} />
                          <i className="dashboard-dot" style={{ background: RATING_COLORS[label] }} aria-hidden="true" />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <Field label="Notes" wide>
                    <textarea rows="3" value={shotForm.notes} onChange={setShot('notes')} />
                  </Field>
                </div>
              </fieldset>

              <div className="dashboard-preview-strip" data-testid="preview-strip">
                <div className={`dashboard-preview-main ${previewInRange ? 'in-range' : 'out-range'}`}>
                  <span>Extraction</span>
                  <strong data-testid="preview-extraction">{formatNumber(preview.extraction)}%</strong>
                  <em>{previewInRange ? 'in target window' : `outside ${TARGET_LABEL.replace('Target ', '')}`}</em>
                </div>
                <div className="dashboard-preview-stat"><span>TDS</span><strong>{formatNumber(preview.tds)}</strong></div>
                <div className="dashboard-preview-stat"><span>Adj factor</span><strong>{formatNumber(preview.factor, 4)}</strong></div>
                <div className="dashboard-preview-stat"><span>Adj temp</span><strong>{formatNumber(preview.adjustedTemp, 1)}°C</strong></div>
              </div>

              <div className="dashboard-form-footer">
                <div className="dashboard-recommendation-card" data-testid="recommendation">
                  <p className="dashboard-card-label">Recommended Grind Setting</p>
                  <h3>{recommendation?.label ?? '—'}</h3>
                  <p>{recommendation?.detail ?? 'No recommendation yet.'}</p>
                </div>
                <div className="dashboard-form-submit">
                  <button className="dashboard-primary-button" type="submit" disabled={savingShot} data-testid="add-shot">
                    {savingShot ? 'Saving…' : 'Add row'}
                  </button>
                </div>
              </div>
            </form>
          </Panel>

          <div className="dashboard-grid">
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
            <Panel title="Extraction Over Time" testId="panel-trend">
              <LineChart
                testId="line-trend"
                data={dashboard?.charts?.trend_points ?? []}
                xKey="Date"
                yKey="Extraction"
                tickFormat={formatShortDate}
                xLabel="Date"
                yLabel="Extraction (%)"
                rolling
                band={TARGET_BAND}
                bandLabel={TARGET_LABEL}
                tooltip={(row) => [
                  `${formatLongDate(row.Date)} · ${row.Roaster ?? '—'}`,
                  `Extraction ${formatNumber(row.Extraction)}% · TDS ${formatNumber(row.TDS)}% · ${row['Rating Label']}`,
                ]}
              />
            </Panel>
          </div>

          <Panel title="Shot Log" testId="panel-shot-log">
            <DataTable testId="table-shot-log" rows={dashboard?.shot_log ?? []} editable onUpdateCell={handleCellUpdate} />
          </Panel>
        </section>
      )}

      {activeTab === 'origins' && (
        <section className="dashboard-tab-panel" role="tabpanel">
          <Panel title="Coffee Origins" subtitle="Filter by roaster, region, variety, and continent." testId="panel-origins-filters">
            <div className="dashboard-filter-toolbar">
              <ChipSelect label="Roaster" options={origins?.options?.roasters ?? []} counts={filterCounts.roasters} value={originsFilters.selected_roasters} onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_roasters: value }))} />
              <ChipSelect label="Region" options={origins?.options?.regions ?? []} counts={filterCounts.regions} value={originsFilters.selected_regions} onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_regions: value }))} />
              <ChipSelect label="Variety" options={origins?.options?.varieties ?? []} counts={filterCounts.varieties} value={originsFilters.selected_varieties} onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_varieties: value }))} />
              <ChipSelect label="Continent" options={origins?.options?.continents ?? []} counts={filterCounts.continents} value={originsFilters.selected_continents} onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_continents: value }))} />
            </div>
            <div className="dashboard-inline-toggles">
              <label className="dashboard-toggle">
                <input
                  type="checkbox"
                  checked={originsFilters.show_unknown_continent}
                  onChange={(event) => setOriginsFilters((prev) => ({ ...prev, show_unknown_continent: event.target.checked }))}
                />
                <span>Show null/unknown continent values</span>
              </label>
              <button type="button" className="dashboard-secondary-button" onClick={() => setOriginsFilters(EMPTY_FILTERS)}>
                Reset filters
              </button>
            </div>
          </Panel>

          <div className="dashboard-grid">
            <Panel title="Origin Coordinates" testId="panel-map">
              <GeoScatterPlot points={origins?.map_points ?? []} series={continentSeries} hidden={hiddenContinents} onToggle={toggleInSet(setHiddenContinents)} />
            </Panel>
            <Panel title="Extraction vs. TDS by Continent" testId="panel-continent-scatter">
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
          </div>

          <Panel title="Filtered Origins Log" testId="panel-origins-log">
            <DataTable testId="table-origins-log" rows={origins?.table_rows ?? []} totalCount={shotsState?.shots?.length} editable onUpdateCell={handleCellUpdate} />
          </Panel>
        </section>
      )}

      {activeTab === 'experiment' && (
        <section className="dashboard-tab-panel" role="tabpanel">
          <Panel
            title="Experiment"
            subtitle="Directional estimates from your logged shot history; treat them as suggestions, not ground truth."
            testId="panel-experiment"
          >
            {!experiment?.available && <div className="dashboard-empty-state">{experiment?.message ?? 'Experiment data unavailable.'}</div>}
            {experiment?.available && (
              <>
                <section className="dashboard-metrics-row" data-testid="model-metrics">
                  <MetricCard label="Model Rows" value={experiment.metrics.rows} />
                  <MetricCard label="Extraction R²" value={formatNumber(experiment.metrics.extraction_r2)} />
                  <MetricCard label="Extraction MAE" value={formatNumber(experiment.metrics.extraction_mae)} />
                  <MetricCard label="Rating Balanced Acc." value={formatNumber(experiment.metrics.rating_balanced_accuracy)} />
                </section>

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
                    <Field label="Sim pH"><input type="number" step="0.01" value={experimentForm.ph} onChange={setSim('ph')} /></Field>
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
                <Panel title="Current Shot Model Read" testId="panel-prediction">
                  <div className="dashboard-prediction-card">
                    <p className="dashboard-card-label">Predicted extraction</p>
                    <h3>{formatNumber(experiment.prediction.extraction)}%</h3>
                    <p>Predicted cup rating: {experiment.prediction.predicted_rating_label}</p>
                    <p>
                      Great probability {formatPercent(experiment.prediction.great_probability)} · Good probability {formatPercent(experiment.prediction.good_probability)}
                    </p>
                  </div>
                </Panel>
                <Panel title="Quality Read" testId="panel-quality">
                  <div className="dashboard-quality-grid">
                    <MetricCard label="Target Window" value={experiment.prediction.within_target ? 'Inside' : 'Outside'} />
                    <MetricCard label="Distance From 20%" value={formatNumber(experiment.prediction.distance_from_target_center)} />
                    <MetricCard label="Setup Familiarity" value={experiment.prediction.novelty_flag ? 'Unusual' : 'In Family'} />
                    <MetricCard label="Novelty Score" value={formatNumber(experiment.prediction.novelty_score)} />
                  </div>
                </Panel>
              </div>

              <div className="dashboard-grid">
                <Panel title="Grind Sweep Simulator" testId="panel-sweep">
                  <LineChart
                    testId="line-sweep"
                    data={experiment.grind_sweep ?? []}
                    xKey="Grind Score"
                    tickKey="Grind Setting"
                    yKey="Predicted Extraction"
                    xLabel="Grind setting"
                    yLabel="Predicted extraction (%)"
                    band={experiment.target_window}
                    bandLabel={TARGET_LABEL}
                    tooltip={(row) => [
                      `${row['Grind Setting']} · score ${row['Grind Score']}`,
                      `Predicted ${formatNumber(row['Predicted Extraction'])}% · Great ${formatPercent(row['Great Probability'])}`,
                    ]}
                  />
                </Panel>
                <Panel title="Top Grind Candidates" testId="panel-candidates">
                  <DataTable rows={experiment.best_candidates ?? []} />
                </Panel>
              </div>

              <div className="dashboard-grid">
                <Panel title="Closest Successful Historical Shots" testId="panel-similar">
                  <DataTable rows={experiment.similar_successes ?? []} />
                </Panel>
                <Panel title="Target Window Leaders" testId="panel-leaders">
                  <BarChart data={experiment.target_leaders ?? []} />
                </Panel>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}

function clampIndex(value) {
  return Math.min(Math.max(value, 0), RATING_LABELS.length - 1)
}
