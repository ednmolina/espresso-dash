import { useMemo, useRef, useState } from 'react'
import { exportJson, importJson, setRunExcluded, setShotExcluded } from '../../calibrationStore'
import { indexToSetting } from '../../grindCalibration'
import { useNav } from '../../navigation'
import { useShots } from '../../shotsStore'
import { useGrindCalibration } from '../../useModels'
import { formatShortDate } from '../dashboard/chartUtils'
import GrindSettingPicker from '../pages/GrindSettingPicker'
import { CalibrationChart, ChartLegend } from '../pages/pageCharts'
import { InsetGroup, ListRow, PageHeader, Sheet, SwipeRow, useBreakpoint } from '../shell'
import '../pages/pages.css'

const round = (v) => Math.round(v)
const finite = (v) => typeof v === 'number' && Number.isFinite(v)

function pointRef(point) {
  if (point.id.startsWith('shot:')) return { kind: 'shot', id: point.id.slice(5) }
  return { kind: 'run', id: point.id.replace(/^run:/, '').replace(/:(mean|dv50)$/, '') }
}

function setExcluded(point, excluded) {
  const ref = pointRef(point)
  return ref.kind === 'shot' ? setShotExcluded(ref.id, excluded) : setRunExcluded(ref.id, excluded)
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function rangeLabel(model) {
  if (!model || model.kind !== 'curve' || !finite(model.xMin)) return null
  return { from: indexToSetting(model.xMin), to: indexToSetting(model.xMax) }
}

/* ---------------------------- converter ---------------------------- */

function SettingToSize({ cal, metric, model, setting, setSetting, tone }) {
  const est = cal.estimate(setting, metric)
  const note = !est
    ? 'Add calibration points to estimate sizes.'
    : est.kind === 'median'
      ? `Need 3 points for a curve (${model.n} so far). Showing the median size.`
      : est.extrapolated
        ? 'Outside your calibrated settings, so the range is wider.'
        : null
  return (
    <div className="el-conv-block">
      <GrindSettingPicker
        value={setting}
        onChange={setSetting}
        layout="macro-micro"
        tone={tone}
        label="Grind setting used"
        testId="converter-picker"
      />
      <div className="el-conv-result" aria-live="polite">
        <p className="el-conv-big" data-testid="converter-um">
          {est ? <>≈ {round(est.um)}<small> µm</small></> : <>—<small> µm</small></>}
        </p>
        <p className="el-conv-sub">
          {est && est.kind === 'curve' ? `${setting}, likely ${round(est.low)}–${round(est.high)} µm` : est ? `${setting}, median of your points` : 'No size estimate yet'}
        </p>
      </div>
      {note ? <p className={`el-conv-note${est && est.extrapolated ? ' is-warn' : ''}`}>{note}</p> : null}
    </div>
  )
}

function SizeToSetting({ cal, metric, model, um, setUm }) {
  const value = um
  const res = finite(value) && value > 0 ? cal.toSetting(value, metric) : null
  const back = res ? cal.estimate(res.setting, metric) : null
  const step = (d) => setUm(Math.max(10, round((finite(value) ? value : 400) + d)))
  const note = model.kind !== 'curve'
    ? `Need 3 points for a curve (${model.n} so far).`
    : res && res.extrapolated
      ? 'Outside your calibrated settings, so this is an extrapolation.'
      : null
  return (
    <div className="el-conv-block">
      <label className="el-field-label" htmlFor="converter-um-input">Particle size (µm)</label>
      <div className="el-um-stepper">
        <button type="button" className="el-picker-step" aria-label="Smaller by 10 micrometres" onClick={() => step(-10)}>−</button>
        <input
          id="converter-um-input"
          className="el-um-input"
          type="number"
          inputMode="numeric"
          min="20"
          step="10"
          value={finite(value) ? value : ''}
          onChange={(e) => setUm(e.target.value === '' ? null : Number(e.target.value))}
          data-testid="converter-um-input"
        />
        <button type="button" className="el-picker-step" aria-label="Larger by 10 micrometres" onClick={() => step(10)}>+</button>
      </div>
      <div className="el-conv-result" aria-live="polite">
        <p className="el-conv-label">Closest setting</p>
        <p className="el-conv-big" data-testid="converter-setting">{res ? res.setting : '—'}</p>
        <p className="el-conv-sub">{back ? `That setting is ≈ ${round(back.um)} µm` : 'Enter a size to find a setting'}</p>
      </div>
      {note ? <p className={`el-conv-note${res && res.extrapolated ? ' is-warn' : ''}`}>{note}</p> : null}
    </div>
  )
}

/* ------------------------------ tables ------------------------------ */

function sourceLabel(p) { return p.source === 'photo' ? 'Analyzer photo' : 'Shot log' }

/** "separated" tag for photo points saved while "Separate touching particles" was on. */
function SeparatedChip() {
  return <span className="el-chip-tag" data-testid="cal-separated">separated</span>
}

function PointsTable({ points, outliers }) {
  const [all, setAll] = useState(false)
  const rows = useMemo(
    () => [...points].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.x - a.x),
    [points],
  )
  const limit = 12
  const shown = all ? rows : rows.slice(0, limit)
  return (
    <>
      <div className="el-table-scroll">
        <table className="el-table" data-testid="cal-points">
          <thead>
            <tr>
              <th>Source</th><th>Date</th><th>Coffee</th><th>Setting</th>
              <th className="num">Size (µm)</th><th className="num">Weight</th><th className="num">Fit</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} data-testid="cal-point-row" data-excluded={p.excluded ? 'true' : 'false'} className={p.excluded ? 'is-excluded' : ''}>
                <td>{sourceLabel(p)}{p.separated ? <SeparatedChip /> : null}</td>
                <td className="muted">{p.date ? formatShortDate(p.date) : '—'}</td>
                <td>{p.coffee || '—'}</td>
                <td><b>{p.setting}</b>{outliers.has(p.id) && !p.excluded ? <span className="el-badge">outlier</span> : null}</td>
                <td className="num">{round(p.um)}</td>
                <td className="num muted">{p.weight}</td>
                <td className="num">
                  <button type="button" className="el-pill-btn" data-testid="cal-exclude" onClick={() => setExcluded(p, !p.excluded)}>
                    {p.excluded ? 'Include' : 'Exclude'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit ? (
        <button type="button" className="el-link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${rows.length} points`}
        </button>
      ) : null}
    </>
  )
}

function PointsList({ points, outliers }) {
  const rows = [...points].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.x - a.x)
  return (
    <div className="el-inset-body" data-testid="cal-points">
      {rows.map((p) => (
        <SwipeRow
          key={p.id}
          testId="cal-point-row"
          actions={[{ label: p.excluded ? 'Include' : 'Exclude', tone: 'default', onAction: () => setExcluded(p, !p.excluded) }]}
        >
          <div className={`el-point-row${p.excluded ? ' is-excluded' : ''}`} data-excluded={p.excluded ? 'true' : 'false'}>
            <span className={`el-point-mark ${p.excluded ? 'is-ex' : p.source === 'photo' ? 'is-photo' : 'is-shot'}`} aria-hidden="true" />
            <div className="el-point-main">
              <div className="el-point-top">
                <span><b>{p.setting} · {round(p.um)} µm</b>{p.separated ? <SeparatedChip /> : null}</span>
                <span className="muted">{p.date ? formatShortDate(p.date) : ''}</span>
              </div>
              <div className="el-point-sub">
                {sourceLabel(p)}{p.coffee ? ` · ${p.coffee}` : ''} · weight {p.weight}
                {outliers.has(p.id) && !p.excluded ? <span className="el-badge">outlier</span> : null}
              </div>
            </div>
            <button type="button" className="el-pill-btn" data-testid="cal-exclude" onClick={() => setExcluded(p, !p.excluded)}>
              {p.excluded ? 'Include' : 'Exclude'}
            </button>
          </div>
        </SwipeRow>
      ))}
    </div>
  )
}

/* --------------------------- import / export --------------------------- */

function ImportExport({ compact = false }) {
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)
  const onExport = () => {
    const stamp = new Date().toISOString().slice(0, 10)
    downloadText(`espresso-calibration-${stamp}.json`, exportJson())
    setMessage('Exported. Keep the file somewhere safe.')
  }
  const onFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const res = importJson(text)
      setMessage(res.error ? `Import failed: ${res.error}` : `Added ${res.added}, ${res.duplicates} duplicates, ${res.invalid} invalid`)
    } catch (err) {
      setMessage(`Import failed: ${err?.message || 'could not read the file'}`)
    }
  }
  return (
    <div className={`el-io${compact ? ' is-compact' : ''}`}>
      <p>Calibration points from analyzer photos are kept in this browser only. Export a copy so you can restore it on another device or after clearing site data.</p>
      <div className="el-io-actions">
        <button type="button" className="el-btn-primary" data-testid="cal-export" onClick={onExport}>Export JSON</button>
        <label className="el-btn-tinted">
          Import JSON…
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="el-file-input"
            data-testid="cal-import"
            onChange={onFile}
          />
        </label>
      </div>
      <p className="el-io-status" role="status" data-testid="cal-io-status">{message}</p>
      <p className="el-io-foot">Past-shot points are computed from your shot log, so they are not part of the file.</p>
    </div>
  )
}

/* ------------------------------ metric ------------------------------ */

function MetricSwitch({ metric, setMetric, dv50Ready }) {
  return (
    <div className="el-mini-seg" role="radiogroup" aria-label="Curve metric" data-testid="cal-metric">
      {[['mean', 'Mean'], ['dv50', 'Dv50']].map(([id, label]) => {
        const disabled = id === 'dv50' && !dv50Ready
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={metric === id}
            aria-disabled={disabled}
            disabled={disabled}
            className={metric === id ? 'active' : ''}
            onClick={() => setMetric(id)}
            data-testid={`cal-metric-${id}`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------- page ------------------------------- */

export default function GrinderPage() {
  const { shots } = useShots()
  const { go } = useNav()
  const breakpoint = useBreakpoint()
  const phone = breakpoint === 'phone'
  const cal = useGrindCalibration(shots)
  const [metricChoice, setMetric] = useState('mean')
  const metric = metricChoice === 'dv50' && cal.dv50 ? 'dv50' : 'mean'
  const model = metric === 'dv50' ? cal.dv50 : cal.mean
  const photoCount = cal.points.filter((p) => p.metric === 'mean' && p.source === 'photo' && !p.excluded).length
  const dv50Photos = cal.points.filter((p) => p.metric === 'dv50' && !p.excluded).length

  const points = useMemo(() => cal.points.filter((p) => p.metric === metric), [cal.points, metric])
  const outliers = useMemo(() => new Set(model?.outlierIds ?? []), [model])
  const range = rangeLabel(model)
  const empty = (model?.n ?? 0) === 0 && points.length === 0

  const defaultSetting = range ? indexToSetting(Math.round((model.xMin + model.xMax) / 2)) : '10E'
  const [settingState, setSetting] = useState(null)
  const setting = settingState ?? defaultSetting
  const defaultUm = cal.estimate(setting, metric)?.um
  const [umState, setUm] = useState(undefined)
  const um = umState === undefined ? (finite(defaultUm) ? round(defaultUm) : 400) : umState

  const [mode, setMode] = useState('toSize')
  const [sheet, setSheet] = useState(null)
  const swap = () => {
    if (mode === 'toSize') {
      const est = cal.estimate(setting, metric)
      if (est && finite(est.um)) setUm(round(est.um))
      setMode('toSetting')
    } else {
      const res = finite(um) && um > 0 ? cal.toSetting(um, metric) : null
      if (res) setSetting(res.setting)
      setMode('toSize')
    }
  }

  const activeCount = model?.n ?? 0
  const scatter = model?.kind === 'curve' && finite(model.scatterPct) ? `±${model.scatterPct.toFixed(0)}%` : '—'
  const footnote = metric === 'dv50'
    ? 'Curve fitted on Dv50 (median diameter) from analyzer photos only.'
    : 'Curve fitted on mean diameter. Photo runs contribute their mean size; shot-log points count at half weight.'

  const legend = [
    points.some((p) => p.source === 'photo' && !p.excluded) && { label: 'Analyzer photo', type: 'dot', cls: 'el-pt-photo' },
    points.some((p) => p.source === 'shot' && !p.excluded) && { label: 'Past shot log', type: 'diamond', cls: 'el-pt-shot' },
    points.some((p) => p.excluded) && { label: 'Excluded', type: 'ring', cls: 'el-pt-excluded' },
    model && model.kind !== 'none' && { label: model.kind === 'curve' ? 'Fitted curve' : 'Median size', type: model.kind === 'curve' ? 'line' : 'dash', cls: 'el-curve-swatch' },
    model && model.kind === 'curve' && { label: 'Likely range', type: 'band', cls: 'el-band' },
  ].filter(Boolean)

  const emptyCard = (
    <div className="el-empty" data-testid="cal-empty">
      <p className="el-empty-title">No calibration points yet.</p>
      <p>Tag an analyzer photo with the setting you used, or log Avg Grind with a shot.</p>
      <button type="button" className="el-btn-tinted" onClick={() => go('analyzer')}>Open Analyzer</button>
    </div>
  )

  const chart = empty ? emptyCard : (
    <>
      <CalibrationChart points={points} model={model} height={phone ? 150 : 380} compact={phone} />
      <ChartLegend items={legend} />
      {!phone ? <p className="el-footnote">{footnote}</p> : null}
    </>
  )

  /* ------------------------------ phone ------------------------------ */
  if (phone) {
    const fitRows = [
      ['Typical scatter', scatter],
      ['Points in the fit', String(activeCount)],
      ['Settings covered', range ? `${range.from} to ${range.to}` : '—'],
      ['Outliers', String(outliers.size)],
      ['Monotonic limit applied', model?.constrained ? 'Yes' : 'No'],
    ]
    return (
      <div className="el-page el-grinder" data-testid="grinder-page">
        <PageHeader
          kicker="Setting format 1–31 + A–I"
          title="Grinder"
          phoneAction={{ label: 'Add a calibration point from a photo', onClick: () => go('analyzer') }}
        />
        <section className="el-card el-converter" aria-label="Converter">
          <div className="el-conv-head">
            <h2>{mode === 'toSize' ? 'Setting to size' : 'Size to setting'}</h2>
            <button
              type="button"
              className="el-icon-btn"
              data-testid="converter-swap"
              aria-label={mode === 'toSize' ? 'Switch to size to setting' : 'Switch to setting to size'}
              onClick={swap}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 20V5M4 9l4-4 4 4M16 4v15M12 15l4 4 4-4" />
              </svg>
            </button>
          </div>
          {mode === 'toSize'
            ? <SettingToSize cal={cal} metric={metric} model={model} setting={setting} setSetting={setSetting} tone="light" />
            : <SizeToSetting cal={cal} metric={metric} model={model} um={um} setUm={setUm} />}
        </section>
        <section className="el-card el-chart-card" aria-label="Setting versus particle size">
          <div className="el-card-head">
            <h2>Setting vs particle size</h2>
            <span className="muted">{activeCount} points in the fit</span>
          </div>
          {chart}
        </section>
        <InsetGroup>
          <ListRow
            title={`Calibration points (${activeCount})`}
            detail={`${photoCount} photos · ${model?.nShot ?? 0} shots`}
            onClick={() => setSheet('points')}
            testId="cal-open-points"
          />
          <ListRow title="Fit quality" detail={`${scatter} scatter`} onClick={() => setSheet('fit')} testId="cal-open-fit" />
          <ListRow title="Import / Export" detail="Stored in this browser" onClick={() => setSheet('io')} testId="cal-open-io" />
        </InsetGroup>

        <Sheet
          open={sheet === 'points'}
          onClose={() => setSheet(null)}
          title="Calibration points"
          leftAction={{ label: 'Back', onClick: () => setSheet(null) }}
          initialDetent="large"
          testId="cal-points-sheet"
        >
          <p className="el-sheet-note" tabIndex={-1} data-autofocus>Exclude a point to leave it out of the fit. Nothing is deleted.</p>
          {points.length ? <PointsList points={points} outliers={outliers} /> : emptyCard}
        </Sheet>
        <Sheet
          open={sheet === 'fit'}
          onClose={() => setSheet(null)}
          title="Fit quality"
          leftAction={{ label: 'Back', onClick: () => setSheet(null) }}
          testId="cal-fit-sheet"
        >
          <div className="el-inset-body">
            {fitRows.map(([k, v]) => (
              <div className="el-kv" key={k}><span>{k}</span><b>{v}</b></div>
            ))}
          </div>
          <p className="el-sheet-note">{footnote} The likely range widens outside the calibrated settings.</p>
        </Sheet>
        <Sheet
          open={sheet === 'io'}
          onClose={() => setSheet(null)}
          title="Import / Export"
          leftAction={{ label: 'Back', onClick: () => setSheet(null) }}
          testId="cal-io-sheet"
        >
          <ImportExport compact />
        </Sheet>
      </div>
    )
  }

  /* ------------------------- desktop and tablet ------------------------- */
  const tiles = (
    <div className="el-tiles" data-testid="cal-tiles">
      <div className="el-tile">
        <span className="el-tile-label">Calibration points</span>
        <span className="el-tile-value">{activeCount}</span>
        <span className="el-tile-sub">{photoCount} photos · {model?.nShot ?? 0} shot log</span>
      </div>
      <div className="el-tile">
        <span className="el-tile-label">Typical scatter</span>
        <span className="el-tile-value">{scatter}</span>
        <span className="el-tile-sub">Around the fitted curve</span>
      </div>
      <div className="el-tile">
        <span className="el-tile-label">Settings covered</span>
        <span className="el-tile-value">{range ? `${range.from}–${range.to}` : '—'}</span>
        <span className="el-tile-sub">Outside this the range widens</span>
      </div>
      <div className="el-tile">
        <span className="el-tile-label">Curve metric</span>
        <MetricSwitch metric={metric} setMetric={setMetric} dv50Ready={Boolean(cal.dv50)} />
        <span className="el-tile-sub">
          {cal.dv50 ? 'Dv50 is the median particle diameter.' : `Dv50 curve unlocks at 3 photos (${dv50Photos} so far)`}
        </span>
      </div>
    </div>
  )

  return (
    <div className="el-page el-grinder" data-testid="grinder-page">
      <PageHeader
        kicker="Learns from your shot log and analyzer photos"
        title="Grinder"
        actions={<span className="el-chip">Setting format 1–31 + A–I</span>}
      />
      {tiles}
      <div className="el-grinder-main">
        <section className="el-card el-chart-card" aria-label="Setting versus particle size">
          <div className="el-card-head">
            <h2>Setting vs particle size</h2>
            <span className="muted">{activeCount} points in the fit</span>
          </div>
          {chart}
        </section>
        <section className="el-card el-converter" aria-label="Converter">
          <h2>Converter</h2>
          <p className="muted el-card-lead">Works both ways from the fitted curve.</p>
          <div className="el-conv-cols">
            <div>
              <h3 className="el-sub-head">Setting to size</h3>
              <SettingToSize cal={cal} metric={metric} model={model} setting={setting} setSetting={setSetting} tone="light" />
            </div>
            <div>
              <h3 className="el-sub-head">Size to setting</h3>
              <SizeToSetting cal={cal} metric={metric} model={model} um={um} setUm={setUm} />
            </div>
          </div>
        </section>
      </div>
      {!empty ? (
        <section className="el-card" aria-label="Calibration points">
          <div className="el-card-head">
            <h2>Calibration points</h2>
            <span className="muted">Exclude a point to leave it out of the fit. Nothing is deleted.</span>
          </div>
          <PointsTable points={points} outliers={outliers} />
        </section>
      ) : null}
      <section className="el-card" aria-label="Import and export">
        <div className="el-card-head"><h2>Back up and restore</h2></div>
        <ImportExport />
      </section>
    </div>
  )
}
