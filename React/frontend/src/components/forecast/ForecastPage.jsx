import { useEffect, useMemo, useRef, useState } from 'react'
import { parsePhInput } from '../../dashboardData'
import { coffeeKey, forecast, listCoffees, suggestWithTarget, sweepGrind, targetFor } from '../../forecastModel'
import { parseSetting, settingToIndex } from '../../grindCalibration'
import { targetLine, useGrindTargetMode } from '../../grindTargetPref'
import { useNav } from '../../navigation'
import { useShots } from '../../shotsStore'
import { useForecastModel, useGrindCalibration } from '../../useModels'
import GrindSettingPicker from '../pages/GrindSettingPicker'
import { ChartLegend, OddsBar, SweepChart } from '../pages/pageCharts'
import { InsetGroup, ListRow, PageHeader, SegmentedControl, Sheet, useBreakpoint } from '../shell'
import '../pages/pages.css'

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const num = (text) => {
  if (text === null || text === undefined || String(text).trim() === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}
const fmt1 = (v) => (finite(v) ? v.toFixed(1) : '—')
const trimNum = (v) => (finite(Number(v)) && v !== '' && v !== null && v !== undefined ? String(Number(v)) : '')

const TARGET_OPTIONS = [
  { id: 'fixed', label: '20%' },
  { id: 'best', label: 'Best for this coffee' },
]

const PH_HINT = '3.5–8.0. Left blank, pH is ignored rather than guessed.'

function skippedText(model, item) {
  const feature = model?.features?.find((f) => f.key === item.key)
  const label = feature?.label ?? item.key
  if (item.reason === 'not_entered') return `${label} not entered — skipped`
  if (item.reason === 'too_few') return feature?.detail || `${label} skipped: too few shots have it`
  if (item.reason === 'no_gain') return `${label} left out: it did not improve the forecast`
  return `${label} skipped`
}

function intervalNote(model, keys) {
  const names = keys.map((key) => model?.features?.find((f) => f.key === key)?.label ?? key)
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
  return `${list} ${names.length > 1 ? 'were' : 'was'}n't entered`
}

function Stepper({ label, value, onChange, step, min = 0, suffix = 'g', testId }) {
  const n = num(value)
  const bump = (d) => onChange(String(Math.max(min, Math.round(((n ?? 0) + d) * 100) / 100)))
  return (
    <div className="el-step-field">
      <span className="el-step-label">{label}</span>
      <div className="el-step-row">
        <button type="button" className="el-picker-step" aria-label={`Less ${label.toLowerCase()}`} onClick={() => bump(-step)}>−</button>
        <input
          className="el-step-input"
          type="number"
          inputMode="decimal"
          step="any"
          min={min}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} (${suffix})`}
          data-testid={testId}
        />
        <button type="button" className="el-picker-step" aria-label={`More ${label.toLowerCase()}`} onClick={() => bump(step)}>+</button>
      </div>
    </div>
  )
}

export default function ForecastPage() {
  const { shots } = useShots()
  const { params, go } = useNav()
  const phone = useBreakpoint() === 'phone'
  const cal = useGrindCalibration(shots)
  const model = useForecastModel(shots, cal.mean)
  const coffees = useMemo(() => listCoffees(shots || []), [shots])

  const [coffee, setCoffee] = useState('')
  const [dose, setDose] = useState('')
  const [yieldG, setYieldG] = useState('')
  const [ph, setPh] = useState('')
  const [grind, setGrind] = useState('10E')
  const [note, setNote] = useState('')
  const [targetMode, setTargetMode] = useGrindTargetMode()
  const [sheet, setSheet] = useState(null)
  const appliedParams = useRef(null)

  const prefill = (key, grindOverride) => {
    const entry = coffees.find((c) => c.key === key)
    const last = entry?.last
    if (last) {
      setDose(trimNum(last.dose))
      setYieldG(trimNum(last.yieldGrams))
      const wanted = grindOverride ?? last.grindSetting
      if (parseSetting(wanted)) setGrind(parseSetting(wanted).label)
    } else if (grindOverride && parseSetting(grindOverride)) {
      setGrind(parseSetting(grindOverride).label)
    }
    setPh('')
    setNote('')
  }

  // Initial coffee, and a plan handed over from another page ("Plan next shot").
  useEffect(() => {
    if (!coffees.length) return
    if (params && params !== appliedParams.current && (params.coffee || params.grindSetting)) {
      appliedParams.current = params
      const key = coffees.some((c) => c.key === params.coffee) ? params.coffee : coffees[0].key
      setCoffee(key)
      prefill(key, params.grindSetting)
      return
    }
    if (!coffee) {
      setCoffee(coffees[0].key)
      prefill(coffees[0].key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coffees, params])

  const phCheck = parsePhInput(ph)
  const planned = useMemo(() => ({
    coffee,
    grindSetting: grind,
    dose: num(dose),
    yieldGrams: num(yieldG),
    ph: phCheck.error ? undefined : phCheck.value ?? undefined,
  }), [coffee, grind, dose, yieldG, phCheck.error, phCheck.value])

  const available = Boolean(model?.available)
  const fc = useMemo(() => (available ? forecast(model, planned) : null), [available, model, planned])
  const sweep = useMemo(() => (available ? sweepGrind(model, planned) : []), [available, model, planned])
  const grindEst = cal.estimate(grind)
  const currentIndex = settingToIndex(grind)
  const mae = model?.backtest?.model?.mae
  const coffeeEntry = coffees.find((c) => c.key === coffee)
  const coffeeLabelText = coffeeEntry?.label ?? 'No coffee yet'

  const target = useMemo(() => targetFor(shots || [], coffee, targetMode), [shots, coffee, targetMode])
  const targetText = targetLine(target, { phone })
  const onTargetMode = (mode) => { setTargetMode(mode); setNote('') }

  const onSuggest = () => {
    const { suggestion: s } = suggestWithTarget(model, shots || [], planned, targetMode)
    if (s && s.setting) {
      setGrind(s.setting)
      const um = cal.estimate(s.setting)?.um
      setNote(`Suggested ${s.setting}${finite(um) ? ` · ≈ ${Math.round(um)} µm` : ''} · expected ${fmt1(s.extraction)}%`)
      return
    }
    // The forecast has not learned an effect of grind yet, so fall back to what actually happened:
    // the shot of this coffee that landed closest to the target.
    const closest = (shots || [])
      .filter((x) => coffeeKey(x) === coffee && finite(x.extraction) && parseSetting(x.grindSetting))
      .sort((a, b) => Math.abs(a.extraction - target.target) - Math.abs(b.extraction - target.target))[0]
    if (closest) {
      const label = parseSetting(closest.grindSetting).label
      setGrind(label)
      setNote(`The forecast has not learned a grind effect yet. Your closest shot to ${fmt1(target.target)}% used ${label} (${fmt1(closest.extraction)}%).`)
    } else {
      setNote('No suggestion yet: log a shot of this coffee with its grind setting.')
    }
  }
  const setGrindManual = (s) => { setGrind(s); setNote('') }

  const rangeText = fc && finite(fc.low) && finite(fc.high) ? `Likely between ${fmt1(fc.low)}% and ${fmt1(fc.high)}%` : 'Range not measured yet'
  const skipped = fc?.featuresSkipped ?? []
  const footnote = (
    <>
      <p>
        Based on {fc?.coffeeShots ?? 0} shots of this coffee.{' '}
        {finite(mae)
          ? `Tested on your past shots, forecasts were off by ${mae.toFixed(1)} pts on average.`
          : 'Accuracy not measured yet.'}
      </p>
      {fc?.intervalReduced?.length ? (
        <p data-testid="forecast-range-note">
          Range is wider because {intervalNote(model, fc.intervalReduced)}.
        </p>
      ) : null}
      {skipped.length ? (
        <ul className="el-skipped" data-testid="forecast-skipped">
          {skipped.map((item) => <li key={item.key}>{skippedText(model, item)}</li>)}
        </ul>
      ) : null}
    </>
  )

  const emptyCard = (
    <div className="el-empty" data-testid="forecast-empty">
      <p className="el-empty-title">Forecasts are not ready yet.</p>
      <p>{model?.reason || 'Log 8 shots with extraction to unlock forecasts.'}</p>
      <button type="button" className="el-btn-tinted" onClick={() => go('shots', { tab: 'log' })}>Open the shot log</button>
    </div>
  )

  const hero = !available ? emptyCard : (
    <section className="el-hero" aria-label="Forecast">
      <div className="el-hero-main">
        <p className="el-hero-label">Expected extraction{phone ? ` · ${coffeeLabelText}` : ''}</p>
        <p className="el-hero-number" data-testid="forecast-extraction">{fc ? <>{fmt1(fc.extraction)}<small>%</small></> : '—'}</p>
        <p className="el-hero-range" data-testid="forecast-range">{rangeText}</p>
      </div>
      <div className="el-hero-odds">
        <p className="el-hero-label">How it&apos;ll probably taste</p>
        {fc ? <OddsBar probs={fc.probabilities} testId="forecast-odds" /> : null}
      </div>
    </section>
  )

  const legend = [
    { label: 'Expected', type: 'line', cls: 'el-curve-swatch is-accent' },
    { label: 'Likely range', type: 'band', cls: 'el-band is-accent' },
    { label: 'Target 18–22%', type: 'band', cls: 'el-target' },
  ]
  const curve = (h, compact) => (sweep.length > 1 ? (
    <>
      <SweepChart sweep={sweep} currentIndex={currentIndex} height={h} compact={compact} />
      <ChartLegend items={legend} />
    </>
  ) : <p className="muted">The curve appears once a forecast is available.</p>)

  const targetControl = (
    <SegmentedControl
      options={TARGET_OPTIONS}
      value={targetMode}
      onChange={onTargetMode}
      ariaLabel="Aim for"
      ariaLabelledBy={phone ? undefined : 'forecast-aim-label'}
      role="radiogroup"
      className="el-target-seg"
      testIdPrefix="forecast-target-"
      testId="forecast-target"
    />
  )

  const phField = (
    <div className="el-field">
      <label className="el-field-label" htmlFor="forecast-ph">pH (optional)</label>
      <input
        id="forecast-ph"
        className="el-input"
        type="text"
        inputMode="decimal"
        placeholder="e.g. 5.4"
        value={ph}
        onChange={(e) => setPh(e.target.value)}
        aria-invalid={Boolean(phCheck.error)}
        aria-describedby="forecast-ph-hint"
        data-testid="forecast-ph"
      />
      {phCheck.error ? <p className="el-field-error" role="alert" data-testid="forecast-ph-error">{phCheck.error}</p> : null}
      <p className="el-hint" id="forecast-ph-hint">{PH_HINT}</p>
    </div>
  )

  /* ------------------------------ phone ------------------------------ */
  if (phone) {
    const ratio = num(dose) && num(yieldG) ? (num(yieldG) / num(dose)).toFixed(1) : '—'
    return (
      <div className="el-page el-forecast" data-testid="forecast-page">
        <PageHeader kicker="Plan your next shot" title="Forecast" />
        {hero}
        <section className="el-card el-grind-card" aria-label="Grind setting">
          <div className="el-grind-head">
            <span>Grind setting</span>
            <span className="muted" data-testid="forecast-grind-um">{grindEst ? `≈ ${Math.round(grindEst.um)} µm (est.)` : 'no µm estimate yet'}</span>
          </div>
          <GrindSettingPicker value={grind} onChange={setGrindManual} layout="stepper" size="lg" label="Grind setting" testId="forecast-grind" />
          <div className="el-target-row">
            {targetControl}
            <button type="button" className="el-btn-tinted is-small" data-testid="forecast-suggest" onClick={onSuggest} disabled={!available}>
              Suggest
            </button>
          </div>
          <p className="el-hint" data-testid="forecast-target-line">{targetText}</p>
          {note ? <p className="el-suggest-note" role="status" data-testid="forecast-suggest-note">{note}</p> : null}
        </section>
        <InsetGroup>
          <ListRow title="Coffee" detail={coffeeLabelText} onClick={() => setSheet('coffee')} testId="forecast-coffee-row" />
          <ListRow title="Dose · Yield" detail={`${dose || '—'} g · ${yieldG || '—'} g`} onClick={() => setSheet('recipe')} testId="forecast-recipe-row" />
          <ListRow title="pH (optional)" detail={ph || 'Not entered'} onClick={() => setSheet('ph')} testId="forecast-ph-row" />
          <ListRow title="Show curve" detail={available ? 'Extraction by grind' : 'Not ready'} onClick={() => setSheet('curve')} testId="forecast-curve-row" />
          <ListRow
            title="Forecast accuracy"
            detail={finite(mae) ? `off by ${mae.toFixed(1)} pts on average` : 'Not measured yet'}
            onClick={() => go('diagnostics')}
            testId="forecast-accuracy-row"
          />
        </InsetGroup>

        <Sheet open={sheet === 'coffee'} onClose={() => setSheet(null)} title="Coffee" leftAction={{ label: 'Back', onClick: () => setSheet(null) }} testId="forecast-coffee-sheet">
          {coffees.length ? (
            <div className="el-inset-body">
              {coffees.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="el-pick-row"
                  aria-pressed={c.key === coffee}
                  onClick={() => { setCoffee(c.key); prefill(c.key); setSheet(null) }}
                >
                  <span><b>{c.label}</b><small>{c.shots} shots · last {c.lastDate || '—'}</small></span>
                  {c.key === coffee ? <span className="el-check" aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          ) : <p className="el-sheet-note">No coffees yet. Log a shot first.</p>}
        </Sheet>
        <Sheet open={sheet === 'recipe'} onClose={() => setSheet(null)} title="Dose · Yield" leftAction={{ label: 'Back', onClick: () => setSheet(null) }} rightAction={{ label: 'Done', onClick: () => setSheet(null) }} testId="forecast-recipe-sheet">
          <div className="el-inset-body el-pad">
            <Stepper label="Dose" value={dose} onChange={setDose} step={0.5} testId="forecast-dose" />
            <Stepper label="Yield" value={yieldG} onChange={setYieldG} step={1} testId="forecast-yield" />
            <div className="el-kv"><span>Ratio</span><b>1 : {ratio}</b></div>
          </div>
        </Sheet>
        <Sheet open={sheet === 'ph'} onClose={() => setSheet(null)} title="pH (optional)" leftAction={{ label: 'Back', onClick: () => setSheet(null) }} rightAction={{ label: 'Done', onClick: () => setSheet(null) }} testId="forecast-ph-sheet">
          <div className="el-inset-body el-pad">{phField}</div>
          <button type="button" className="el-link-btn" onClick={() => setPh('')}>Clear pH</button>
          <p className="el-sheet-note">The forecast uses pH only when you enter it. A blank pH is skipped, never guessed.</p>
        </Sheet>
        <Sheet open={sheet === 'curve'} onClose={() => setSheet(null)} title="Extraction by grind" leftAction={{ label: 'Back', onClick: () => setSheet(null) }} initialDetent="large" testId="forecast-curve-sheet">
          <div className="el-card el-in-sheet" data-testid="forecast-curve-card">{curve(240, true)}</div>
          <p className="el-sheet-note">The range widens away from grind settings you have tried. Marker: {grind}.</p>
          <div className="el-sheet-note">{footnote}</div>
        </Sheet>
      </div>
    )
  }

  /* ------------------------- desktop and tablet ------------------------- */
  return (
    <div className="el-page el-forecast" data-testid="forecast-page">
      <PageHeader kicker="Plan your next shot" title="Forecast" />
      <div className="el-forecast-grid">
        <section className="el-card el-forecast-inputs" aria-label="Planned shot">
          <div className="el-field">
            <label className="el-field-label" htmlFor="forecast-coffee">Coffee</label>
            <select
              id="forecast-coffee"
              className="el-input el-select"
              value={coffee}
              onChange={(e) => { setCoffee(e.target.value); prefill(e.target.value) }}
              data-testid="forecast-coffee"
              disabled={!coffees.length}
            >
              {!coffees.length ? <option value="">No coffees yet</option> : null}
              {coffees.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div className="el-field-pair">
            <div className="el-field">
              <label className="el-field-label" htmlFor="forecast-dose">Dose (g)</label>
              <input id="forecast-dose" className="el-input" type="number" inputMode="decimal" step="any" min="0" value={dose} onChange={(e) => setDose(e.target.value)} data-testid="forecast-dose" />
            </div>
            <div className="el-field">
              <label className="el-field-label" htmlFor="forecast-yield">Yield (g)</label>
              <input id="forecast-yield" className="el-input" type="number" inputMode="decimal" step="any" min="0" value={yieldG} onChange={(e) => setYieldG(e.target.value)} data-testid="forecast-yield" />
            </div>
          </div>
          {phField}
          <div className="el-field">
            <GrindSettingPicker value={grind} onChange={setGrindManual} layout="stepper" label="Grind setting" testId="forecast-grind" />
            <div className="el-grind-foot">
              <span className="muted">Finer ← → Coarser</span>
              <span className="muted" data-testid="forecast-grind-um">{grindEst ? `≈ ${Math.round(grindEst.um)} µm (est.)` : 'no µm estimate yet'}</span>
            </div>
          </div>
          <div className="el-field">
            <span className="el-field-label" id="forecast-aim-label">Aim for</span>
            {targetControl}
            <p className="el-hint" data-testid="forecast-target-line">{targetText}</p>
          </div>
          <button type="button" className="el-btn-tinted is-block" data-testid="forecast-suggest" onClick={onSuggest} disabled={!available}>
            Suggest grind
          </button>
          {note ? <p className="el-suggest-note" role="status" data-testid="forecast-suggest-note">{note}</p> : null}
        </section>
        <div className="el-forecast-side">
          {hero}
          {available ? (
            <section className="el-card" aria-label="Extraction across grind settings">
              <h2>Extraction across grind settings</h2>
              {curve(260, false)}
              <p className="el-footnote">The range widens away from grind settings you have tried.</p>
            </section>
          ) : null}
          {available ? (
          <section className="el-card el-note-card">
            <div>{footnote}</div>
            <button type="button" className="el-link-btn" onClick={() => go('diagnostics')}>How accurate is this? ›</button>
          </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
