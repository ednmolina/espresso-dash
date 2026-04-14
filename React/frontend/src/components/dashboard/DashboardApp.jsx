import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  addShotToFirestore,
  buildDashboardPayload,
  buildExperimentPayload,
  buildOriginsPayload,
  buildRecommendationPayload,
  getDashboardMeta,
  loadShotsData,
  updateShotCellInFirestore,
} from '../../dashboardData'

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

const TILE_SIZE = 256

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

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return Number(value).toFixed(digits)
}

function formatPercent(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(Number(value) * 100).toFixed(digits)}%`
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

function suggestionListId(scope, field) {
  return `${scope}-${field}-suggestions`
}

export default function DashboardApp() {
  const [shotsState, setShotsState] = useState(null)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [shotForm, setShotForm] = useState(buildShotForm(null))
  const [experimentForm, setExperimentForm] = useState(buildExperimentForm(null))
  const [originsFilters, setOriginsFilters] = useState(EMPTY_FILTERS)
  const [carryForward, setCarryForward] = useState(true)
  const [carryShot, setCarryShot] = useState(true)
  const [booting, setBooting] = useState(true)
  const [savingShot, setSavingShot] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const meta = getDashboardMeta()
  const [ratingVisibility, setRatingVisibility] = useState({
    Bad: true,
    Good: true,
    Great: true,
  })

  const dashboard = shotsState ? buildDashboardPayload(shotsState.shots) : null
  const fieldOptions = dashboard?.field_options ?? {}
  const recommendation = shotsState
    ? buildRecommendationPayload(shotsState.shots, {
      roaster: shotForm.roaster,
      region: shotForm.region,
      variety: shotForm.variety,
      processing_technique: shotForm.processing_technique,
      roast: shotForm.roast,
      continent: shotForm.continent,
    })
    : null
  const origins = shotsState ? buildOriginsPayload(shotsState.shots, originsFilters) : null
  const experiment = shotsState ? buildExperimentPayload(shotsState.shots, experimentForm) : null

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      setBooting(true)
      setError('')
      try {
        const nextShotsState = await loadShotsData()
        if (cancelled) return
        const nextDashboard = buildDashboardPayload(nextShotsState.shots)
        const nextExperiment = buildExperimentPayload(nextShotsState.shots, {})
        setShotsState(nextShotsState)
        setShotForm(buildShotForm(nextDashboard.defaults))
        setExperimentForm(buildExperimentForm(nextExperiment.defaults))
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
        }
      } finally {
        if (!cancelled) {
          setBooting(false)
        }
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  const preview = (() => {
    const { adjustedTemp, factor } = calculateAdjustmentFactor(Number(shotForm.temp_c || 0))
    const tds = calculateTds(Number(shotForm.brix || 0), factor)
    const extraction = calculateExtraction(tds, Number(shotForm.yield_grams || 0), Number(shotForm.dose || 0))
    return { adjustedTemp, factor, tds, extraction }
  })()

  const filteredScatterPoints = (dashboard?.charts?.scatter_points ?? []).filter((row) => ratingVisibility[row['Rating Label']] ?? true)
  const filteredTrendPoints = (dashboard?.charts?.trend_points ?? []).filter((row) => ratingVisibility[row['Rating Label']] ?? true)

  const refreshShots = async ({ message = '', resetShotForm = false, resetExperimentForm = false } = {}) => {
    const nextShotsState = await loadShotsData()
    const nextDashboard = buildDashboardPayload(nextShotsState.shots)
    const nextExperiment = buildExperimentPayload(nextShotsState.shots, {})
    setShotsState(nextShotsState)
    if (resetShotForm) {
      setShotForm(buildShotForm(nextDashboard.defaults))
    }
    if (resetExperimentForm) {
      setExperimentForm(buildExperimentForm(nextExperiment.defaults))
    }
    if (message) {
      setNotice(message)
    }
  }

  const handleAddShot = async (event) => {
    event.preventDefault()
    if (shotsState?.source !== 'firebase') {
      setError('Offline mode is using cached data. Reconnect to Firebase before saving.')
      return
    }
    setSavingShot(true)
    setError('')
    try {
      await addShotToFirestore({
        shots: shotsState?.shots ?? [],
        carryForward,
        carryShot,
        fields: shotForm,
      })
      await refreshShots({
        message: 'Row added to Firestore.',
        resetShotForm: true,
        resetExperimentForm: true,
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingShot(false)
    }
  }

  const handleRefreshData = async () => {
    setRefreshing(true)
    setError('')
    try {
      await refreshShots({ message: 'Reloaded dashboard data.' })
    } catch (err) {
      setError(err.message)
    } finally {
      setRefreshing(false)
    }
  }

  const handleCellUpdate = async (rowId, column, value) => {
    if (shotsState?.source !== 'firebase') {
      setError('Offline mode is using cached data. Reconnect to Firebase before editing.')
      return
    }
    setError('')
    await updateShotCellInFirestore({
      shots: shotsState?.shots ?? [],
      rowId,
      column,
      value,
    })
    await refreshShots({ message: `Updated ${column} in Firestore.` })
  }

  if (booting) {
    return <div className="dashboard-loading">Loading espresso dashboard...</div>
  }

  if (error && !dashboard) {
    return <div className="dashboard-loading dashboard-error">{error}</div>
  }

  return (
    <div className="dashboard-app">
      <header className="dashboard-hero">
        <div>
          <p className="dashboard-kicker">Espresso Analysis</p>
          <h1>Shot dashboard in React</h1>
          <p className="dashboard-caption">
            Firestore is the live data source. When it is unavailable, the dashboard falls back to the last cached snapshot in localStorage.
          </p>
          <div className={`dashboard-file-chip ${shotsState?.source === 'cache' ? 'warning' : ''}`}>
            {shotsState?.source === 'cache'
              ? `⚠️ Offline — showing cached data${shotsState?.lastSyncedAt ? ` from ${new Date(shotsState.lastSyncedAt).toLocaleString()}` : ''}`
              : 'Live: Firebase'}
          </div>
        </div>
        <div className="dashboard-hero-actions">
          <button className="dashboard-secondary-button" onClick={handleRefreshData} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh Data'}
          </button>
        </div>
      </header>

      {notice && <div className="dashboard-notice">{notice}</div>}
      {error && <div className="dashboard-error-banner">{error}</div>}

      <section className="dashboard-metrics-row">
        <MetricCard label="Shots Logged" value={dashboard?.metrics?.shots_logged ?? 0} />
        <MetricCard label="Average TDS" value={formatNumber(dashboard?.metrics?.average_tds)} />
        <MetricCard label="Average Extraction" value={formatNumber(dashboard?.metrics?.average_extraction)} />
        <MetricCard label="Average Rating" value={formatNumber(dashboard?.metrics?.average_rating)} />
      </section>

      <nav className="dashboard-tabbar">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.id}
            className={`dashboard-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'dashboard' && (
        <section className="dashboard-tab-panel">
          <div className="dashboard-grid dashboard-grid-wide">
            <Panel title="Add historical shot" subtitle="Ported from the Streamlit form, including carry-forward behavior and live grind recommendations.">
              <form className="dashboard-form" onSubmit={handleAddShot}>
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

                <div className="dashboard-form-columns">
                  <div className="dashboard-form-column">
                    <Field label="Date">
                      <input type="date" value={shotForm.entry_date} onChange={(event) => setShotForm((prev) => ({ ...prev, entry_date: event.target.value }))} />
                    </Field>
                    <Field label="Roaster">
                      <AutocompleteInput scope="shot" field="roaster" value={shotForm.roaster} options={fieldOptions.roaster} onChange={(event) => setShotForm((prev) => ({ ...prev, roaster: event.target.value }))} />
                    </Field>
                    <Field label="Region">
                      <AutocompleteInput scope="shot" field="region" value={shotForm.region} options={fieldOptions.region} onChange={(event) => setShotForm((prev) => ({ ...prev, region: event.target.value }))} />
                    </Field>
                    <Field label="Continent">
                      <AutocompleteInput scope="shot" field="continent" value={shotForm.continent} options={fieldOptions.continent} onChange={(event) => setShotForm((prev) => ({ ...prev, continent: event.target.value }))} />
                    </Field>
                    <Field label="Temperature (C)">
                      <input type="number" step="0.1" value={shotForm.temp_c} onChange={(event) => setShotForm((prev) => ({ ...prev, temp_c: event.target.value }))} />
                    </Field>
                    <Field label="Brix">
                      <input type="number" step="0.1" value={shotForm.brix} onChange={(event) => setShotForm((prev) => ({ ...prev, brix: event.target.value }))} />
                    </Field>
                    <Field label="pH">
                      <input type="number" step="0.01" value={shotForm.ph} onChange={(event) => setShotForm((prev) => ({ ...prev, ph: event.target.value }))} />
                    </Field>
                    <Field label="TDS">
                      <input value={formatNumber(preview.tds)} disabled />
                    </Field>
                  </div>

                  <div className="dashboard-form-column">
                    <Field label="Dose (g)">
                      <input type="number" step="0.1" value={shotForm.dose} onChange={(event) => setShotForm((prev) => ({ ...prev, dose: event.target.value }))} />
                    </Field>
                    <Field label="Output / Yield (g)">
                      <input type="number" step="0.1" value={shotForm.yield_grams} onChange={(event) => setShotForm((prev) => ({ ...prev, yield_grams: event.target.value }))} />
                    </Field>
                    <Field label="Time (s)">
                      <input type="number" step="1" value={shotForm.shot_time} onChange={(event) => setShotForm((prev) => ({ ...prev, shot_time: event.target.value }))} />
                    </Field>
                    <Field label="Grind Size (µm)">
                      <AutocompleteInput scope="shot" field="avg_grind" value={shotForm.avg_grind} options={fieldOptions.avg_grind} onChange={(event) => setShotForm((prev) => ({ ...prev, avg_grind: event.target.value }))} />
                    </Field>
                    <div className="dashboard-inline-grid">
                      <Field label="Grind Macro">
                        <select value={shotForm.grind_macro} onChange={(event) => setShotForm((prev) => ({ ...prev, grind_macro: event.target.value }))}>
                          {(meta?.macro_options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </Field>
                      <Field label="Grind Micro">
                        <select value={shotForm.grind_micro} onChange={(event) => setShotForm((prev) => ({ ...prev, grind_micro: event.target.value }))}>
                          {(meta?.micro_options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </Field>
                    </div>
                    <Field label="Lat">
                      <input value={shotForm.latitude} onChange={(event) => setShotForm((prev) => ({ ...prev, latitude: event.target.value }))} />
                    </Field>
                    <Field label="Long">
                      <input value={shotForm.longitude} onChange={(event) => setShotForm((prev) => ({ ...prev, longitude: event.target.value }))} />
                    </Field>
                    <Field label="Elevation">
                      <AutocompleteInput scope="shot" field="elevation" value={shotForm.elevation} options={fieldOptions.elevation} onChange={(event) => setShotForm((prev) => ({ ...prev, elevation: event.target.value }))} />
                    </Field>
                  </div>

                  <div className="dashboard-form-column">
                    <Field label="Variety">
                      <AutocompleteInput scope="shot" field="variety" value={shotForm.variety} options={fieldOptions.variety} onChange={(event) => setShotForm((prev) => ({ ...prev, variety: event.target.value }))} />
                    </Field>
                    <Field label="Processing Technique">
                      <AutocompleteInput scope="shot" field="processing_technique" value={shotForm.processing_technique} options={fieldOptions.processing_technique} onChange={(event) => setShotForm((prev) => ({ ...prev, processing_technique: event.target.value }))} />
                    </Field>
                    <Field label="Roast">
                      <AutocompleteInput scope="shot" field="roast" value={shotForm.roast} options={fieldOptions.roast} onChange={(event) => setShotForm((prev) => ({ ...prev, roast: event.target.value }))} />
                    </Field>
                    <Field label="Notes">
                      <textarea rows="4" value={shotForm.notes} onChange={(event) => setShotForm((prev) => ({ ...prev, notes: event.target.value }))} />
                    </Field>
                    <Field label="Rating">
                      <select value={shotForm.rating_label} onChange={(event) => setShotForm((prev) => ({ ...prev, rating_label: event.target.value }))}>
                        {(meta?.rating_labels ?? []).map((label) => <option key={label} value={label}>{label}</option>)}
                      </select>
                    </Field>
                  </div>
                </div>

                <div className="dashboard-form-actions">
                  <div className="dashboard-preview-card">
                    <div>Adj Temp: {formatNumber(preview.adjustedTemp)}</div>
                    <div>Adj Factor: {formatNumber(preview.factor, 4)}</div>
                    <div>Extraction: {formatNumber(preview.extraction)}</div>
                  </div>

                  <div className="dashboard-recommendation-card">
                    <p className="dashboard-card-label">Recommended Grind Setting</p>
                    <h3>{recommendation?.label ?? '—'}</h3>
                    <p>{recommendation?.detail ?? 'No recommendation yet.'}</p>
                  </div>

                  <div className="dashboard-form-submit">
                    <button className="dashboard-primary-button" type="submit" disabled={savingShot}>
                      {savingShot ? 'Saving...' : 'Add row'}
                    </button>
                  </div>
                </div>
              </form>
            </Panel>
          </div>

          <div className="dashboard-grid">
            <Panel title="TDS vs. Extraction">
              <div className="dashboard-chart-filter-row">
                {['Bad', 'Good', 'Great'].map((label) => (
                  <button
                    key={label}
                    type="button"
                    className={`dashboard-chip ${ratingVisibility[label] ? 'active' : ''}`}
                    onClick={() => setRatingVisibility((prev) => ({ ...prev, [label]: !prev[label] }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <ScatterChart
                data={filteredScatterPoints}
                xKey="Extraction"
                yKey="TDS"
                colorKey="Rating Label"
                colorMap={dashboard?.rating_colors ?? {}}
                verticals={[18, 22]}
                horizontals={[1.2, 1.45]}
                xLabel="Extraction"
                yLabel="TDS"
                tooltip={(row) => `${row.Date} • ${row.Roaster} • ${row.Region} • ${row['Grind Setting']} • TDS ${formatNumber(row.TDS)} • Extraction ${formatNumber(row.Extraction)}`}
              />
            </Panel>
            <Panel title="Extraction Over Time">
              <LineChart
                data={filteredTrendPoints}
                xKey="Date"
                yKey="Extraction"
                yLabel="Extraction"
                tooltip={(row) => `${row.Date} • ${row.Roaster} • Extraction ${formatNumber(row.Extraction)} • TDS ${formatNumber(row.TDS)}`}
              />
            </Panel>
          </div>

          <Panel title="Shot Log">
            <DataTable rows={dashboard?.shot_log ?? []} editable onUpdateCell={handleCellUpdate} />
          </Panel>
        </section>
      )}

      {activeTab === 'origins' && (
        <section className="dashboard-tab-panel">
          <Panel title="Coffee Origins" subtitle="Coordinate plot, extraction/TDS clustering, and the filtered log table.">
            <div className="dashboard-filter-toolbar">
              <FilterField
                label="Roaster"
                options={origins?.options?.roasters ?? []}
                value={originsFilters.selected_roasters}
                onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_roasters: value }))}
              />
              <FilterField
                label="Region"
                options={origins?.options?.regions ?? []}
                value={originsFilters.selected_regions}
                onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_regions: value }))}
              />
              <FilterField
                label="Variety"
                options={origins?.options?.varieties ?? []}
                value={originsFilters.selected_varieties}
                onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_varieties: value }))}
              />
              <FilterField
                label="Continent"
                options={origins?.options?.continents ?? []}
                value={originsFilters.selected_continents}
                onChange={(value) => setOriginsFilters((prev) => ({ ...prev, selected_continents: value }))}
              />
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
              <button className="dashboard-secondary-button" onClick={() => setOriginsFilters(EMPTY_FILTERS)}>
                Reset Filters
              </button>
            </div>
          </Panel>

          <div className="dashboard-grid">
            <Panel title="Origin Coordinates">
              <GeoScatterPlot points={origins?.map_points ?? []} />
            </Panel>
            <Panel title="Extraction vs. TDS by Continent">
              <ScatterChart
                data={origins?.chart_points ?? []}
                xKey="Extraction"
                yKey="TDS"
                colorKey="Continent Display"
                colorMap={origins?.continent_colors ?? {}}
                xLabel="Extraction"
                yLabel="TDS"
                tooltip={(row) => `${row.Roaster} • ${row['Continent Display']} • ${row.Region} • ${row.Date}`}
              />
            </Panel>
          </div>

          <Panel title="Filtered Origins Log">
            <DataTable rows={origins?.table_rows ?? []} editable onUpdateCell={handleCellUpdate} />
          </Panel>
        </section>
      )}

      {activeTab === 'experiment' && (
        <section className="dashboard-tab-panel">
          <Panel title="Experiment" subtitle="Machine-learning experiments use the logged shot history to estimate extraction, rating, and grind tradeoffs. Treat these as directional suggestions, not ground truth.">
            {!experiment?.available && <div className="dashboard-empty-state">{experiment?.message ?? 'Experiment data unavailable.'}</div>}

            {experiment?.available && (
              <>
                <section className="dashboard-metrics-row">
                  <MetricCard label="Model Rows" value={experiment.metrics.rows} />
                  <MetricCard label="Extraction R²" value={formatNumber(experiment.metrics.extraction_r2)} />
                  <MetricCard label="Extraction MAE" value={formatNumber(experiment.metrics.extraction_mae)} />
                  <MetricCard label="Rating Balanced Acc." value={formatNumber(experiment.metrics.rating_balanced_accuracy)} />
                </section>

                <div className="dashboard-form-columns">
                  <div className="dashboard-form-column">
                    <Field label="Sim Roaster">
                      <AutocompleteInput scope="experiment" field="roaster" value={experimentForm.roaster} options={fieldOptions.roaster} onChange={(event) => setExperimentForm((prev) => ({ ...prev, roaster: event.target.value }))} />
                    </Field>
                    <Field label="Sim Region">
                      <AutocompleteInput scope="experiment" field="region" value={experimentForm.region} options={fieldOptions.region} onChange={(event) => setExperimentForm((prev) => ({ ...prev, region: event.target.value }))} />
                    </Field>
                    <Field label="Sim Continent">
                      <AutocompleteInput scope="experiment" field="continent" value={experimentForm.continent} options={fieldOptions.continent} onChange={(event) => setExperimentForm((prev) => ({ ...prev, continent: event.target.value }))} />
                    </Field>
                    <Field label="Sim Temperature (C)">
                      <input type="number" step="0.1" value={experimentForm.temp_c} onChange={(event) => setExperimentForm((prev) => ({ ...prev, temp_c: event.target.value }))} />
                    </Field>
                    <Field label="Sim Brix">
                      <input type="number" step="0.1" value={experimentForm.brix} onChange={(event) => setExperimentForm((prev) => ({ ...prev, brix: event.target.value }))} />
                    </Field>
                    <Field label="Sim pH">
                      <input type="number" step="0.01" value={experimentForm.ph} onChange={(event) => setExperimentForm((prev) => ({ ...prev, ph: event.target.value }))} />
                    </Field>
                  </div>

                  <div className="dashboard-form-column">
                    <Field label="Sim Variety">
                      <AutocompleteInput scope="experiment" field="variety" value={experimentForm.variety} options={fieldOptions.variety} onChange={(event) => setExperimentForm((prev) => ({ ...prev, variety: event.target.value }))} />
                    </Field>
                    <Field label="Sim Processing Technique">
                      <AutocompleteInput scope="experiment" field="processing_technique" value={experimentForm.processing_technique} options={fieldOptions.processing_technique} onChange={(event) => setExperimentForm((prev) => ({ ...prev, processing_technique: event.target.value }))} />
                    </Field>
                    <Field label="Sim Roast">
                      <AutocompleteInput scope="experiment" field="roast" value={experimentForm.roast} options={fieldOptions.roast} onChange={(event) => setExperimentForm((prev) => ({ ...prev, roast: event.target.value }))} />
                    </Field>
                    <Field label="Sim Dose (g)">
                      <input type="number" step="0.1" value={experimentForm.dose} onChange={(event) => setExperimentForm((prev) => ({ ...prev, dose: event.target.value }))} />
                    </Field>
                    <Field label="Sim Yield (g)">
                      <input type="number" step="0.1" value={experimentForm.yield_grams} onChange={(event) => setExperimentForm((prev) => ({ ...prev, yield_grams: event.target.value }))} />
                    </Field>
                  </div>

                  <div className="dashboard-form-column">
                    <Field label="Sim Time (s)">
                      <input type="number" step="1" value={experimentForm.shot_time} onChange={(event) => setExperimentForm((prev) => ({ ...prev, shot_time: event.target.value }))} />
                    </Field>
                    <Field label="Sim Avg Grind (µm)">
                      <AutocompleteInput scope="experiment" field="avg_grind" value={experimentForm.avg_grind} options={fieldOptions.avg_grind} onChange={(event) => setExperimentForm((prev) => ({ ...prev, avg_grind: event.target.value }))} />
                    </Field>
                    <Field label="Sim Grind Setting">
                      <AutocompleteInput scope="experiment" field="grind_setting" value={experimentForm.grind_setting} options={fieldOptions.grind_setting} onChange={(event) => setExperimentForm((prev) => ({ ...prev, grind_setting: event.target.value }))} />
                    </Field>
                  </div>
                </div>

                <div className="dashboard-grid">
                  <Panel title="Current Shot Model Read">
                    <div className="dashboard-prediction-card">
                      <p className="dashboard-card-label">Predicted extraction</p>
                      <h2>{formatNumber(experiment.prediction.extraction)}%</h2>
                      <p>Predicted cup rating: {experiment.prediction.predicted_rating_label}</p>
                      <p>
                        Great probability {formatPercent(experiment.prediction.great_probability)} • Good probability {formatPercent(experiment.prediction.good_probability)}
                      </p>
                    </div>
                  </Panel>
                  <Panel title="Quality Read">
                    <div className="dashboard-quality-grid">
                      <MetricCard label="Target Window" value={experiment.prediction.within_target ? 'Inside' : 'Outside'} />
                      <MetricCard label="Distance From 20%" value={formatNumber(experiment.prediction.distance_from_target_center)} />
                      <MetricCard label="Setup Familiarity" value={experiment.prediction.novelty_flag ? 'Unusual' : 'In Family'} />
                      <MetricCard label="Novelty Score" value={formatNumber(experiment.prediction.novelty_score)} />
                    </div>
                  </Panel>
                </div>

                <div className="dashboard-grid">
                  <Panel title="Grind Sweep Simulator">
                    <LineChart
                      data={experiment.grind_sweep ?? []}
                      xKey="Grind Score"
                      yKey="Predicted Extraction"
                      yLabel="Predicted Extraction (%)"
                      colorByProbability
                      targetWindow={experiment.target_window}
                      tooltip={(row) => `${row['Grind Setting']} • ${formatNumber(row['Predicted Extraction'])}% • Great ${formatPercent(row['Great Probability'])}`}
                    />
                  </Panel>
                  <Panel title="Top Grind Candidates">
                    <DataTable rows={experiment.best_candidates ?? []} />
                  </Panel>
                </div>

                <div className="dashboard-grid">
                  <Panel title="Closest Successful Historical Shots">
                    <DataTable rows={experiment.similar_successes ?? []} />
                  </Panel>
                  <Panel title="Target Window Leaders">
                    <BarChart data={experiment.target_leaders ?? []} />
                  </Panel>
                </div>
              </>
            )}
          </Panel>
        </section>
      )}
    </div>
  )
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="dashboard-panel">
      <div className="dashboard-panel-header">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="dashboard-panel-body">
        {children}
      </div>
    </section>
  )
}

function MetricCard({ label, value }) {
  return (
    <div className="dashboard-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="dashboard-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function AutocompleteInput({ scope, field, options = [], ...props }) {
  const listId = suggestionListId(scope, field)
  const hasOptions = options.length > 0

  return (
    <>
      <input {...props} list={hasOptions ? listId : undefined} autoComplete="on" />
      {hasOptions && (
        <datalist id={listId}>
          {options.map((option) => <option key={option} value={option} />)}
        </datalist>
      )}
    </>
  )
}

function FilterField({ label, options, value, onChange }) {
  return (
    <label className="dashboard-field dashboard-filter-field">
      <span>{label}</span>
      <select
        multiple
        value={value}
        onChange={(event) => {
          const selected = Array.from(event.target.selectedOptions).map((option) => option.value)
          onChange(selected)
        }}
      >
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  )
}

function DataTable({ rows, editable = false, onUpdateCell = null }) {
  if (!rows.length) {
    return <div className="dashboard-empty-state">No rows to display.</div>
  }

  const [editingCell, setEditingCell] = useState(null)
  const [draftValue, setDraftValue] = useState('')
  const [pendingCell, setPendingCell] = useState(null)
  const columns = Object.keys(rows[0]).filter((column) => column !== '__row_id')
  const columnWidths = columns.map((column) => getColumnWidth(column, rows))

  const beginEdit = (rowId, column, value) => {
    if (!editable || !onUpdateCell || pendingCell) return
    setEditingCell({ rowId, column })
    setDraftValue(value === null || value === undefined ? '' : String(value))
  }

  const cancelEdit = () => {
    setEditingCell(null)
    setDraftValue('')
  }

  const commitEdit = async () => {
    if (!editingCell || !onUpdateCell || pendingCell) return
    const { rowId, column } = editingCell
    const pendingKey = `${rowId}:${column}`
    setPendingCell(pendingKey)
    try {
      await onUpdateCell(rowId, column, draftValue)
      cancelEdit()
    } finally {
      setPendingCell(null)
    }
  }

  return (
    <div className="dashboard-table-wrap">
      <div className="dashboard-table-scroll">
        <table className="dashboard-table">
          <colgroup>
            {columnWidths.map((width, index) => <col key={`${columns[index]}-col`} style={{ width }} />)}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${index}-${columns[0]}-${row[columns[0]]}`}>
                {columns.map((column) => {
                  const rowId = row.__row_id ?? index
                  const cellKey = `${rowId}:${column}`
                  const isEditing = editingCell?.rowId === rowId && editingCell?.column === column
                  const isPending = pendingCell === cellKey
                  return (
                    <td
                      key={column}
                      className={editable ? 'dashboard-table-cell-editable' : undefined}
                      onClick={() => beginEdit(rowId, column, row[column])}
                    >
                      {isEditing ? (
                        <input
                          className="dashboard-table-input"
                          value={draftValue}
                          disabled={isPending}
                          autoFocus
                          onChange={(event) => setDraftValue(event.target.value)}
                          onBlur={() => {
                            void commitEdit()
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void commitEdit()
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelEdit()
                            }
                          }}
                        />
                      ) : (
                        <span className={isPending ? 'dashboard-table-cell-pending' : undefined}>
                          {renderCell(row[column])}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function renderCell(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : value.toFixed(2)
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return value
}

function ScatterChart({ data, xKey, yKey, colorKey, colorMap, xLabel, yLabel, verticals = [], horizontals = [], tooltip }) {
  if (!data.length) {
    return <div className="dashboard-empty-state">No chart data yet.</div>
  }

  const [hovered, setHovered] = useState(null)
  const [view, setView] = useState(null)
  const shellRef = useRef(null)
  const dragRef = useRef(null)
  const width = 640
  const height = 320
  const margin = { top: 18, right: 18, bottom: 42, left: 52 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom

  const xValues = data.map((row) => Number(row[xKey])).filter((value) => !Number.isNaN(value))
  const yValues = data.map((row) => Number(row[yKey])).filter((value) => !Number.isNaN(value))
  const [fullMinX, fullMaxX] = paddedExtent(xValues)
  const [fullMinY, fullMaxY] = paddedExtent(yValues)
  const currentView = view ?? { minX: fullMinX, maxX: fullMaxX, minY: fullMinY, maxY: fullMaxY }
  const scaleX = (value) => margin.left + ((value - currentView.minX) / (currentView.maxX - currentView.minX || 1)) * plotWidth
  const scaleY = (value) => margin.top + plotHeight - ((value - currentView.minY) / (currentView.maxY - currentView.minY || 1)) * plotHeight
  const legendItems = Array.from(new Set(data.map((row) => row[colorKey]).filter(Boolean)))
  const hoveredKey = hovered ? `${hovered.index}-${hovered.row[xKey]}-${hovered.row[yKey]}` : null

  useEffect(() => {
    setView({ minX: fullMinX, maxX: fullMaxX, minY: fullMinY, maxY: fullMaxY })
  }, [fullMinX, fullMaxX, fullMinY, fullMaxY, data.length])

  const zoomChart = (factor, anchor = { x: (currentView.minX + currentView.maxX) / 2, y: (currentView.minY + currentView.maxY) / 2 }) => {
    setView((prev) => {
      const base = prev ?? { minX: fullMinX, maxX: fullMaxX, minY: fullMinY, maxY: fullMaxY }
      return {
        minX: clampExtentAroundAnchor(base.minX, base.maxX, fullMinX, fullMaxX, factor, anchor.x),
        maxX: clampExtentAroundAnchor(base.minX, base.maxX, fullMinX, fullMaxX, factor, anchor.x, 'max'),
        minY: clampExtentAroundAnchor(base.minY, base.maxY, fullMinY, fullMaxY, factor, anchor.y),
        maxY: clampExtentAroundAnchor(base.minY, base.maxY, fullMinY, fullMaxY, factor, anchor.y, 'max'),
      }
    })
  }

  const resetZoom = () => setView({ minX: fullMinX, maxX: fullMaxX, minY: fullMinY, maxY: fullMaxY })

  const handleWheel = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const relX = clamp((event.clientX - rect.left - margin.left) / plotWidth, 0, 1)
    const relY = clamp((event.clientY - rect.top - margin.top) / plotHeight, 0, 1)
    const anchorX = currentView.minX + relX * (currentView.maxX - currentView.minX)
    const anchorY = currentView.maxY - relY * (currentView.maxY - currentView.minY)
    zoomChart(event.deltaY < 0 ? 0.92 : 1.08, { x: anchorX, y: anchorY })
  }

  useNonPassiveWheel(shellRef, handleWheel)

  const handlePointerDown = (event) => {
    if (currentView.minX === fullMinX && currentView.maxX === fullMaxX && currentView.minY === fullMinY && currentView.maxY === fullMaxY) {
      return
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      view: currentView,
    }
  }

  useEffect(() => {
    const handleMove = (event) => {
      if (!dragRef.current) return
      const dx = event.clientX - dragRef.current.startX
      const dy = event.clientY - dragRef.current.startY
      const xSpan = dragRef.current.view.maxX - dragRef.current.view.minX
      const ySpan = dragRef.current.view.maxY - dragRef.current.view.minY
      const xDelta = (dx / plotWidth) * xSpan
      const yDelta = (dy / plotHeight) * ySpan
      setView({
        minX: clampRange(dragRef.current.view.minX - xDelta, xSpan, fullMinX, fullMaxX),
        maxX: clampRange(dragRef.current.view.maxX - xDelta, xSpan, fullMinX, fullMaxX, 'max'),
        minY: clampRange(dragRef.current.view.minY + yDelta, ySpan, fullMinY, fullMaxY),
        maxY: clampRange(dragRef.current.view.maxY + yDelta, ySpan, fullMinY, fullMaxY, 'max'),
      })
    }
    const handleUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [plotHeight, plotWidth, fullMaxX, fullMaxY, fullMinX, fullMinY])

  return (
    <div ref={shellRef} className="dashboard-chart-shell" onMouseLeave={() => setHovered(null)} onMouseDown={handlePointerDown}>
      {legendItems.length > 1 && <ChartLegend items={legendItems} colorMap={colorMap} />}
      <ChartControls onZoomIn={() => zoomChart(0.92)} onZoomOut={() => zoomChart(1.08)} onReset={resetZoom} />
      <svg className="dashboard-chart" viewBox={`0 0 ${width} ${height}`}>
        <ChartAxes width={width} height={height} margin={margin} minX={currentView.minX} maxX={currentView.maxX} minY={currentView.minY} maxY={currentView.maxY} xLabel={xLabel} yLabel={yLabel} />
        {verticals.map((value) => (
          value >= currentView.minX && value <= currentView.maxX
            ? <line key={`v-${value}`} x1={scaleX(value)} x2={scaleX(value)} y1={margin.top} y2={margin.top + plotHeight} className="dashboard-chart-rule" />
            : null
        ))}
        {horizontals.map((value) => (
          value >= currentView.minY && value <= currentView.maxY
            ? <line key={`h-${value}`} x1={margin.left} x2={margin.left + plotWidth} y1={scaleY(value)} y2={scaleY(value)} className="dashboard-chart-rule" />
            : null
        ))}
        {hovered && (
          <g className="dashboard-hover-layer">
            <line x1={scaleX(Number(hovered.row[xKey]))} x2={scaleX(Number(hovered.row[xKey]))} y1={margin.top} y2={margin.top + plotHeight} className="dashboard-chart-hover-line" />
            <line x1={margin.left} x2={margin.left + plotWidth} y1={scaleY(Number(hovered.row[yKey]))} y2={scaleY(Number(hovered.row[yKey]))} className="dashboard-chart-hover-line" />
          </g>
        )}
        {data.map((row, index) => {
          const key = `${index}-${row[xKey]}-${row[yKey]}`
          const isActive = key === hoveredKey
          const xValue = Number(row[xKey])
          const yValue = Number(row[yKey])
          if (xValue < currentView.minX || xValue > currentView.maxX || yValue < currentView.minY || yValue > currentView.maxY) {
            return null
          }
          return (
            <circle
              key={key}
              cx={scaleX(xValue)}
              cy={scaleY(yValue)}
              r={isActive ? '7.5' : '5.5'}
              fill={colorMap?.[row[colorKey]] ?? '#8f9b74'}
              opacity={row[colorKey] === 'Unknown' ? (isActive ? 0.7 : 0.35) : (isActive ? 1 : 0.88)}
              className="dashboard-chart-point"
              onMouseEnter={(event) => setHovered(buildTooltipState(event, { row, index, content: tooltip ? tooltip(row) : `${row[xKey]}, ${row[yKey]}` }))}
              onMouseMove={(event) => setHovered(buildTooltipState(event, { row, index, content: tooltip ? tooltip(row) : `${row[xKey]}, ${row[yKey]}` }))}
            />
          )
        })}
      </svg>
      {hovered && <ChartTooltip hovered={hovered} />}
    </div>
  )
}

function LineChart({ data, xKey, yKey, yLabel, tooltip, colorByProbability = false, targetWindow = null }) {
  if (!data.length) {
    return <div className="dashboard-empty-state">No chart data yet.</div>
  }

  const [hovered, setHovered] = useState(null)
  const [view, setView] = useState(null)
  const shellRef = useRef(null)
  const dragRef = useRef(null)
  const width = 640
  const height = 320
  const margin = { top: 18, right: 18, bottom: 42, left: 52 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const yValues = data.map((row) => Number(row[yKey])).filter((value) => !Number.isNaN(value))
  const [fullMinY, fullMaxY] = paddedExtent(yValues)
  const fullMinX = 0
  const fullMaxX = Math.max(data.length - 1, 1)
  const currentView = view ?? { minX: fullMinX, maxX: fullMaxX, minY: fullMinY, maxY: fullMaxY }
  const visibleData = data
    .map((row, index) => ({ row, index }))
    .filter(({ index, row }) => index >= currentView.minX && index <= currentView.maxX && Number(row[yKey]) >= currentView.minY && Number(row[yKey]) <= currentView.maxY)
  const scaleX = (index) => margin.left + ((index - currentView.minX) / (currentView.maxX - currentView.minX || 1)) * plotWidth
  const scaleY = (value) => margin.top + plotHeight - ((value - currentView.minY) / (currentView.maxY - currentView.minY || 1)) * plotHeight
  const path = visibleData.map(({ row, index }, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${scaleX(index)} ${scaleY(Number(row[yKey]))}`).join(' ')

  useEffect(() => {
    setView({ minX: fullMinX, maxX: fullMaxX, minY: fullMinY, maxY: fullMaxY })
  }, [fullMinX, fullMaxX, fullMinY, fullMaxY, data.length])

  const zoomChart = (factor, anchor = { x: (currentView.minX + currentView.maxX) / 2, y: (currentView.minY + currentView.maxY) / 2 }) => {
    setView((prev) => {
      const base = prev ?? { minX: fullMinX, maxX: fullMaxX, minY: fullMinY, maxY: fullMaxY }
      return {
        minX: clampExtentAroundAnchor(base.minX, base.maxX, fullMinX, fullMaxX, factor, anchor.x, 'min', 2),
        maxX: clampExtentAroundAnchor(base.minX, base.maxX, fullMinX, fullMaxX, factor, anchor.x, 'max', 2),
        minY: clampExtentAroundAnchor(base.minY, base.maxY, fullMinY, fullMaxY, factor, anchor.y),
        maxY: clampExtentAroundAnchor(base.minY, base.maxY, fullMinY, fullMaxY, factor, anchor.y, 'max'),
      }
    })
  }

  const resetZoom = () => setView({ minX: fullMinX, maxX: fullMaxX, minY: fullMinY, maxY: fullMaxY })

  const handleWheel = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const relX = clamp((event.clientX - rect.left - margin.left) / plotWidth, 0, 1)
    const relY = clamp((event.clientY - rect.top - margin.top) / plotHeight, 0, 1)
    const anchorX = currentView.minX + relX * (currentView.maxX - currentView.minX)
    const anchorY = currentView.maxY - relY * (currentView.maxY - currentView.minY)
    zoomChart(event.deltaY < 0 ? 0.92 : 1.08, { x: anchorX, y: anchorY })
  }

  useNonPassiveWheel(shellRef, handleWheel)

  const handlePointerDown = () => {
    if (currentView.minX === fullMinX && currentView.maxX === fullMaxX && currentView.minY === fullMinY && currentView.maxY === fullMaxY) {
      return
    }
    dragRef.current = { view: currentView }
  }

  useEffect(() => {
    const handleMove = (event) => {
      if (!dragRef.current) return
      const dx = event.movementX
      const dy = event.movementY
      const xSpan = dragRef.current.view.maxX - dragRef.current.view.minX
      const ySpan = dragRef.current.view.maxY - dragRef.current.view.minY
      const xDelta = (dx / plotWidth) * xSpan
      const yDelta = (dy / plotHeight) * ySpan
      const nextView = {
        minX: clampRange(currentView.minX - xDelta, xSpan, fullMinX, fullMaxX, 'min', 2),
        maxX: clampRange(currentView.maxX - xDelta, xSpan, fullMinX, fullMaxX, 'max', 2),
        minY: clampRange(currentView.minY + yDelta, ySpan, fullMinY, fullMaxY),
        maxY: clampRange(currentView.maxY + yDelta, ySpan, fullMinY, fullMaxY, 'max'),
      }
      dragRef.current.view = nextView
      setView(nextView)
    }
    const handleUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [currentView, fullMaxX, fullMaxY, fullMinX, fullMinY, plotHeight, plotWidth])

  return (
    <div ref={shellRef} className="dashboard-chart-shell" onMouseLeave={() => setHovered(null)} onMouseDown={handlePointerDown}>
      <ChartControls onZoomIn={() => zoomChart(0.92)} onZoomOut={() => zoomChart(1.08)} onReset={resetZoom} />
      <svg className="dashboard-chart" viewBox={`0 0 ${width} ${height}`}>
        <ChartAxes
          width={width}
          height={height}
          margin={margin}
          minX={currentView.minX}
          maxX={currentView.maxX}
          minY={currentView.minY}
          maxY={currentView.maxY}
          xLabel={xKey}
          yLabel={yLabel}
          xTicks={4}
          xTickFormatter={(value) => formatLineTick(data, value, xKey)}
        />
        {targetWindow && (
          <>
            {targetWindow.low >= currentView.minY && targetWindow.low <= currentView.maxY && (
              <line x1={margin.left} x2={margin.left + plotWidth} y1={scaleY(targetWindow.low)} y2={scaleY(targetWindow.low)} className="dashboard-chart-rule" />
            )}
            {targetWindow.high >= currentView.minY && targetWindow.high <= currentView.maxY && (
              <line x1={margin.left} x2={margin.left + plotWidth} y1={scaleY(targetWindow.high)} y2={scaleY(targetWindow.high)} className="dashboard-chart-rule" />
            )}
          </>
        )}
        {hovered && (
          <line x1={scaleX(hovered.index)} x2={scaleX(hovered.index)} y1={margin.top} y2={margin.top + plotHeight} className="dashboard-chart-hover-line" />
        )}
        <path d={path} className="dashboard-line-path" />
        {visibleData.map(({ row, index }) => {
          const fill = colorByProbability
            ? interpolateColor('#d8c6a0', '#bb4c2f', Number(row['Great Probability']) || 0)
            : '#3d6c58'
          const isActive = hovered?.index === index
          return (
            <circle
              key={`${index}-${row[xKey]}`}
              cx={scaleX(index)}
              cy={scaleY(Number(row[yKey]))}
              r={isActive ? '6.5' : '4.5'}
              fill={fill}
              className="dashboard-chart-point"
              onMouseEnter={(event) => setHovered(buildTooltipState(event, { row, index, content: tooltip ? tooltip(row) : `${row[xKey]} • ${row[yKey]}` }))}
              onMouseMove={(event) => setHovered(buildTooltipState(event, { row, index, content: tooltip ? tooltip(row) : `${row[xKey]} • ${row[yKey]}` }))}
            />
          )
        })}
      </svg>
      {hovered && <ChartTooltip hovered={hovered} />}
    </div>
  )
}

function GeoScatterPlot({ points }) {
  if (!points.length) {
    return <div className="dashboard-empty-state">Add latitude and longitude to map coffee origins.</div>
  }

  const [hovered, setHovered] = useState(null)
  const [view, setView] = useState({ centerLat: 12, centerLng: 0, zoom: 1 })
  const [mapSize, setMapSize] = useState({ width: 640, height: 320 })
  const shellRef = useRef(null)
  const dragRef = useRef(null)
  const width = mapSize.width
  const height = mapSize.height
  const centerWorld = lngLatToWorld(view.centerLng, view.centerLat, view.zoom)
  const topLeft = { x: centerWorld.x - width / 2, y: centerWorld.y - height / 2 }
  const tiles = getVisibleTiles(topLeft, width, height, view.zoom)

  useEffect(() => {
    const nextCenter = {
      centerLat: average(points.map((point) => Number(point.lat)), 12),
      centerLng: average(points.map((point) => Number(point.long)), 0),
      zoom: 1,
    }
    setView(nextCenter)
  }, [points])

  useEffect(() => {
    if (!shellRef.current) return undefined
    const observer = new ResizeObserver(([entry]) => {
      setMapSize({
        width: Math.max(320, Math.round(entry.contentRect.width)),
        height: 360,
      })
    })
    observer.observe(shellRef.current)
    return () => observer.disconnect()
  }, [])

  const zoomMap = (delta, anchorPoint = { x: width / 2, y: height / 2 }) => {
    setView((prev) => {
      const nextZoom = clamp(prev.zoom + delta, 1, 6)
      const before = lngLatToWorld(prev.centerLng, prev.centerLat, prev.zoom)
      const anchorWorldX = before.x - width / 2 + anchorPoint.x
      const anchorWorldY = before.y - height / 2 + anchorPoint.y
      const scale = 2 ** (nextZoom - prev.zoom)
      const nextCenterWorld = {
        x: anchorWorldX * scale - anchorPoint.x + width / 2,
        y: anchorWorldY * scale - anchorPoint.y + height / 2,
      }
      const nextCenter = worldToLngLat(nextCenterWorld.x, nextCenterWorld.y, nextZoom)
      return {
        centerLng: nextCenter.lng,
        centerLat: clamp(nextCenter.lat, -85, 85),
        zoom: nextZoom,
      }
    })
  }

  const resetMap = () => setView({
    centerLat: average(points.map((point) => Number(point.lat)), 12),
    centerLng: average(points.map((point) => Number(point.long)), 0),
    zoom: 1,
  })

  const handleWheel = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const zoomDelta = clamp(-event.deltaY * 0.00275, -0.35, 0.35)
    if (!zoomDelta) return
    zoomMap(zoomDelta, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })
  }

  useNonPassiveWheel(shellRef, handleWheel)

  const handlePointerDown = (event) => {
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      view,
    }
  }

  useEffect(() => {
    const handleMove = (event) => {
      if (!dragRef.current) return
      const dx = event.clientX - dragRef.current.startX
      const dy = event.clientY - dragRef.current.startY
      const startWorld = lngLatToWorld(dragRef.current.view.centerLng, dragRef.current.view.centerLat, dragRef.current.view.zoom)
      const nextCenter = worldToLngLat(startWorld.x - dx, startWorld.y - dy, dragRef.current.view.zoom)
      setView({
        centerLng: wrapLongitude(nextCenter.lng),
        centerLat: clamp(nextCenter.lat, -85, 85),
        zoom: dragRef.current.view.zoom,
      })
    }
    const handleUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  return (
    <div ref={shellRef} className="dashboard-chart-shell">
      <ChartControls onZoomIn={() => zoomMap(0.6)} onZoomOut={() => zoomMap(-0.6)} onReset={resetMap} />
      <div className="dashboard-map-shell" onMouseLeave={() => setHovered(null)} onMouseDown={handlePointerDown}>
        <div className="dashboard-map-tiles" style={{ width: `${width}px`, height: `${height}px` }}>
          {tiles.map((tile) => (
            <img
              key={`${tile.z}-${tile.x}-${tile.y}`}
              src={`https://tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`}
              alt=""
              className="dashboard-map-tile"
              draggable="false"
              style={{
                left: `${tile.left}px`,
                top: `${tile.top}px`,
                width: `${tile.size}px`,
                height: `${tile.size}px`,
              }}
            />
          ))}
          {points.map((point, index) => {
            const world = lngLatToWorld(Number(point.long), Number(point.lat), view.zoom)
            const x = world.x - topLeft.x
            const y = world.y - topLeft.y
            const isActive = hovered?.index === index
            if (x < -20 || x > width + 20 || y < -20 || y > height + 20) return null
            return (
              <button
                key={`${index}-${point.lat}-${point.long}`}
                type="button"
                className={`dashboard-map-marker ${isActive ? 'active' : ''}`}
                style={{ left: `${x}px`, top: `${y}px` }}
                onMouseEnter={(event) => setHovered(buildTooltipState(event, { point, index, content: `${point.roaster} • ${point.region} • ${point.continent} • ${point.date}` }))}
                onMouseMove={(event) => setHovered(buildTooltipState(event, { point, index, content: `${point.roaster} • ${point.region} • ${point.continent} • ${point.date}` }))}
              />
            )
          })}
        </div>
        <div className="dashboard-map-attribution">Map data © OpenStreetMap contributors</div>
      </div>
      {hovered && <ChartTooltip hovered={hovered} />}
    </div>
  )
}

function BarChart({ data }) {
  if (!data.length) {
    return <div className="dashboard-empty-state">Not enough repeated coffees to rank target-window leaders yet.</div>
  }

  const [hovered, setHovered] = useState(null)
  const width = 640
  const height = 320
  const margin = { top: 20, right: 20, bottom: 30, left: 180 }
  const plotWidth = width - margin.left - margin.right
  const rowHeight = (height - margin.top - margin.bottom) / data.length
  const maxValue = Math.max(...data.map((row) => Number(row.target_hit_rate) || 0), 0.01)

  return (
    <div className="dashboard-chart-shell" onMouseLeave={() => setHovered(null)}>
      <svg className="dashboard-chart" viewBox={`0 0 ${width} ${height}`}>
        <line x1={margin.left} x2={margin.left + plotWidth} y1={height - margin.bottom} y2={height - margin.bottom} className="dashboard-axis-line" />
        {data.map((row, index) => {
          const y = margin.top + index * rowHeight
          const barWidth = ((Number(row.target_hit_rate) || 0) / maxValue) * plotWidth
          const isActive = hovered?.index === index
          return (
            <g key={row['Coffee Label']}>
              <text x={margin.left - 10} y={y + rowHeight * 0.62} textAnchor="end" className="dashboard-axis-text">{row['Coffee Label']}</text>
              <rect
                x={margin.left}
                y={y + 5}
                width={barWidth}
                height={Math.max(rowHeight - 10, 8)}
                fill={interpolateColor('#efddb7', '#bb4c2f', Number(row.avg_rating || 0) / 2)}
                rx="6"
                opacity={isActive ? 1 : 0.88}
                className="dashboard-chart-bar"
                onMouseEnter={(event) => setHovered(buildTooltipState(event, { row, index, content: `${row['Coffee Label']} • Hit rate ${formatPercent(row.target_hit_rate)} • Avg rating ${formatNumber(row.avg_rating)}` }))}
                onMouseMove={(event) => setHovered(buildTooltipState(event, { row, index, content: `${row['Coffee Label']} • Hit rate ${formatPercent(row.target_hit_rate)} • Avg rating ${formatNumber(row.avg_rating)}` }))}
              />
              <text x={margin.left + barWidth + 8} y={y + rowHeight * 0.62} className="dashboard-axis-text">{formatPercent(row.target_hit_rate)}</text>
            </g>
          )
        })}
      </svg>
      {hovered && <ChartTooltip hovered={hovered} />}
    </div>
  )
}

function ChartLegend({ items, colorMap = {} }) {
  return (
    <div className="dashboard-chart-legend">
      {items.map((item) => (
        <span key={item} className="dashboard-chart-legend-item">
          <span className="dashboard-chart-legend-swatch" style={{ background: colorMap?.[item] ?? '#8f9b74' }} />
          {item}
        </span>
      ))}
    </div>
  )
}

function ChartTooltip({ hovered }) {
  return createPortal(
    <div
      className="dashboard-chart-tooltip"
      style={{
        left: `${hovered.viewportX}px`,
        top: `${hovered.viewportY}px`,
      }}
    >
      {hovered.content}
    </div>,
    document.body,
  )
}

function ChartControls({ onZoomIn, onZoomOut, onReset }) {
  return (
    <div className="dashboard-chart-controls">
      <button type="button" onClick={onZoomIn}>Zoom In</button>
      <button type="button" onClick={onZoomOut}>Zoom Out</button>
      <button type="button" onClick={onReset}>Reset</button>
    </div>
  )
}

function ChartAxes({ width, height, margin, minX, maxX, minY, maxY, xLabel, yLabel, xTicks = 5, yTicks = 5, xTickFormatter, yTickFormatter }) {
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  return (
    <>
      <line x1={margin.left} x2={margin.left + plotWidth} y1={height - margin.bottom} y2={height - margin.bottom} className="dashboard-axis-line" />
      <line x1={margin.left} x2={margin.left} y1={margin.top} y2={margin.top + plotHeight} className="dashboard-axis-line" />
      {Array.from({ length: xTicks }).map((_, index) => {
        const ratio = index / Math.max(xTicks - 1, 1)
        const x = margin.left + ratio * plotWidth
        const value = minX + ratio * (maxX - minX)
        return (
          <g key={`x-${index}`}>
            <line x1={x} x2={x} y1={height - margin.bottom} y2={height - margin.bottom + 5} className="dashboard-axis-line" />
            <text x={x} y={height - margin.bottom + 18} textAnchor="middle" className="dashboard-axis-text">{xTickFormatter ? xTickFormatter(value) : shortNumber(value)}</text>
          </g>
        )
      })}
      {Array.from({ length: yTicks }).map((_, index) => {
        const ratio = index / Math.max(yTicks - 1, 1)
        const y = margin.top + plotHeight - ratio * plotHeight
        const value = minY + ratio * (maxY - minY)
        return (
          <g key={`y-${index}`}>
            <line x1={margin.left - 5} x2={margin.left} y1={y} y2={y} className="dashboard-axis-line" />
            <text x={margin.left - 8} y={y + 4} textAnchor="end" className="dashboard-axis-text">{yTickFormatter ? yTickFormatter(value) : shortNumber(value)}</text>
          </g>
        )
      })}
      <text x={margin.left + plotWidth / 2} y={height - 4} textAnchor="middle" className="dashboard-axis-label">{xLabel}</text>
      <text x={10} y={margin.top + plotHeight / 2} transform={`rotate(-90 10 ${margin.top + plotHeight / 2})`} textAnchor="middle" className="dashboard-axis-label">{yLabel}</text>
    </>
  )
}

function useNonPassiveWheel(targetRef, handler) {
  const handlerRef = useRef(handler)

  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    const target = targetRef.current
    if (!target) return undefined
    const listener = (event) => handlerRef.current(event)
    target.addEventListener('wheel', listener, { passive: false })
    return () => target.removeEventListener('wheel', listener)
  }, [targetRef])
}

function paddedExtent(values) {
  if (!values.length) return [0, 1]
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [min - 1, max + 1]
  const padding = (max - min) * 0.1
  return [min - padding, max + padding]
}

function buildTooltipState(event, payload) {
  return {
    ...payload,
    viewportX: event.clientX + 12,
    viewportY: event.clientY - 12,
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function clampExtentAroundAnchor(min, max, fullMin, fullMax, factor, anchor, edge = 'min', minSpan = 0.5) {
  const span = Math.max((max - min) * factor, minSpan)
  let nextMin = anchor - ((anchor - min) / (max - min || 1)) * span
  let nextMax = nextMin + span
  if (nextMin < fullMin) {
    nextMin = fullMin
    nextMax = nextMin + span
  }
  if (nextMax > fullMax) {
    nextMax = fullMax
    nextMin = nextMax - span
  }
  if (span >= (fullMax - fullMin)) {
    nextMin = fullMin
    nextMax = fullMax
  }
  return edge === 'max' ? nextMax : nextMin
}

function clampRange(value, span, min, max, edge = 'min', minSpan = 0.5) {
  const safeSpan = Math.max(span, minSpan)
  let nextMin = edge === 'max' ? value - safeSpan : value
  let nextMax = nextMin + safeSpan
  if (nextMin < min) {
    nextMin = min
    nextMax = nextMin + safeSpan
  }
  if (nextMax > max) {
    nextMax = max
    nextMin = nextMax - safeSpan
  }
  return edge === 'max' ? nextMax : nextMin
}

function getColumnWidth(column, rows) {
  const samples = rows.slice(0, 24).map((row) => renderCell(row[column]))
  const maxContentLength = Math.max(
    column.length,
    ...samples.map((value) => String(value ?? '').length),
  )
  const numericLike = samples.every((value) => /^[-\d.—%/. ]+$/.test(String(value)))
  const minWidth = numericLike ? 110 : 140
  const idealWidth = maxContentLength * (numericLike ? 8.5 : 9.5) + 28
  return `${clamp(idealWidth, minWidth, 260)}px`
}

function formatLineTick(data, rawIndex, xKey) {
  const safeIndex = clamp(Math.round(rawIndex), 0, Math.max(data.length - 1, 0))
  const value = data[safeIndex]?.[xKey]
  if (typeof value === 'string' && value.includes('-')) {
    return value.slice(5)
  }
  return value ?? shortNumber(rawIndex)
}

function average(values, fallback) {
  const finite = values.filter((value) => Number.isFinite(value))
  if (!finite.length) return fallback
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function wrapLongitude(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180
}

function lngLatToWorld(lng, lat, zoom) {
  const scale = TILE_SIZE * (2 ** zoom)
  const sinLat = Math.sin((clamp(lat, -85, 85) * Math.PI) / 180)
  return {
    x: ((wrapLongitude(lng) + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  }
}

function worldToLngLat(x, y, zoom) {
  const scale = TILE_SIZE * (2 ** zoom)
  const lng = (x / scale) * 360 - 180
  const n = Math.PI - (2 * Math.PI * y) / scale
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lng: wrapLongitude(lng), lat }
}

function getVisibleTiles(topLeft, width, height, zoom) {
  const tileZoom = Math.max(0, Math.floor(zoom))
  const scaleFactor = 2 ** (zoom - tileZoom)
  const tilesPerSide = 2 ** tileZoom
  const tileTopLeft = {
    x: topLeft.x / scaleFactor,
    y: topLeft.y / scaleFactor,
  }
  const scaledTileSize = TILE_SIZE * scaleFactor
  const minX = Math.floor(tileTopLeft.x / TILE_SIZE)
  const maxX = Math.floor((tileTopLeft.x + width / scaleFactor) / TILE_SIZE)
  const minY = Math.floor(tileTopLeft.y / TILE_SIZE)
  const maxY = Math.floor((tileTopLeft.y + height / scaleFactor) / TILE_SIZE)
  const tiles = []

  for (let tileX = minX; tileX <= maxX; tileX += 1) {
    for (let tileY = minY; tileY <= maxY; tileY += 1) {
      if (tileY < 0 || tileY >= tilesPerSide) continue
      const wrappedX = ((tileX % tilesPerSide) + tilesPerSide) % tilesPerSide
      tiles.push({
        x: wrappedX,
        y: tileY,
        z: tileZoom,
        left: (tileX * TILE_SIZE - tileTopLeft.x) * scaleFactor,
        top: (tileY * TILE_SIZE - tileTopLeft.y) * scaleFactor,
        size: scaledTileSize,
      })
    }
  }
  return tiles
}

function shortNumber(value) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 100) return value.toFixed(0)
  if (Math.abs(value) >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function interpolateColor(startHex, endHex, ratio) {
  const clampRatio = Math.max(0, Math.min(1, ratio))
  const start = hexToRgb(startHex)
  const end = hexToRgb(endHex)
  const channel = (from, to) => Math.round(from + (to - from) * clampRatio)
  return `rgb(${channel(start.r, end.r)}, ${channel(start.g, end.g)}, ${channel(start.b, end.b)})`
}

function hexToRgb(hex) {
  const normalized = hex.replace('#', '')
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  }
}
