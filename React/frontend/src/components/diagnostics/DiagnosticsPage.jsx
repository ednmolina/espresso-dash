import { useMemo, useState } from 'react'
import { dataCoverage, LIMITS } from '../../forecastModel'
import { indexToSetting } from '../../grindCalibration'
import { useNav } from '../../navigation'
import { useShots } from '../../shotsStore'
import { useLatestAnalysis } from '../../analysisSession'
import { checksSubtitle, photoChecksModel } from '../../photoChecks'
import { um as fmtUm } from '../../analyzerUtils'
import { useForecastModel, useGrindCalibration } from '../../useModels'
import { formatShortDate } from '../dashboard/chartUtils'
import {
  ChartLegend, ErrorTimeChart, FitResidualChart, Meter, PredActualChart, RatingCalChart,
} from '../pages/pageCharts'
import { InsetGroup, ListRow, PageHeader, PagedRow, Sheet, useBreakpoint } from '../shell'
import '../pages/pages.css'

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const pct0 = (v) => (finite(v) ? `${Math.round(v * 100)}%` : '—')
const f1 = (v) => (finite(v) ? v.toFixed(1) : '—')
const f2 = (v) => (finite(v) ? v.toFixed(2) : '—')

const MEASURED_COPY = [
  'For each past shot, the forecast is rebuilt from only the shots logged before it (an expanding window), then compared with what actually happened. Nothing from the future is used, so the numbers show how the forecast would really have done.',
  'The baseline is simple: always guess the average of the shots before it. A useful forecast has to beat that.',
  'Which inputs the forecast uses is chosen from this same history, so the numbers can be slightly optimistic. They are an honest guide, not a guarantee.',
]

/* ------------------------------ pieces ------------------------------ */

function Tile({ testId, label, value, unit, hint, rows }) {
  return (
    <div className="el-card el-diag-tile" data-testid={testId}>
      <p className="el-tile-label">{label}</p>
      <p className="el-diag-big">{value}{unit ? <small>{unit}</small> : null}</p>
      <p className="el-tile-sub">{hint}</p>
      <div className="el-diag-rows">
        {rows.map((r) => (
          <div className="el-diag-row" key={r.label}>
            <span className="el-diag-row-label">{r.label}</span>
            <Meter value={r.meter} max={r.max} tone={r.tone} label={`${r.label}: ${r.text}`} />
            <b className="el-diag-row-value">{r.text}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

function Callout({ tone = 'warn', children, testId }) {
  return (
    <div className={`el-callout is-${tone}`} data-testid={testId}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" />
      </svg>
      <div>{children}</div>
    </div>
  )
}

function CoverageRow({ label, value, total, extra = 0, detail }) {
  return (
    <div className="el-cov-row">
      <div className="el-cov-top">
        <span>{label}</span>
        <span className="muted">{detail ?? `${value} of ${total}`}</span>
      </div>
      <Meter value={value} extra={extra} max={total || 1} label={`${label}: ${detail ?? `${value} of ${total}`}`} />
    </div>
  )
}

/* ------------------------- photo analysis checks ------------------------- */

const SHAPE_AXIS_MIN = 1
const SHAPE_AXIS_MAX = 3
const shapePct = (v) => `${Math.max(0, Math.min(100, ((v - SHAPE_AXIS_MIN) / (SHAPE_AXIS_MAX - SHAPE_AXIS_MIN)) * 100))}%`

const countText = (v) => (finite(v) ? Math.round(v).toLocaleString() : '—')
const umText = (mm) => (finite(mm) ? `${fmtUm(mm)} µm` : '—')

function ShapeRange({ shape }) {
  const hasBand = shape.arP10 != null && shape.arP90 != null
  const lo = hasBand ? Math.max(SHAPE_AXIS_MIN, shape.arP10) : null
  const hi = hasBand ? Math.min(SHAPE_AXIS_MAX, shape.arP90) : null
  const label = `Length-to-width ratio from ${SHAPE_AXIS_MIN.toFixed(1)} (round) to ${SHAPE_AXIS_MAX.toFixed(1)} (elongated): median ${shape.arMedian.toFixed(2)}${hasBand ? `, 80% between ${shape.arP10.toFixed(2)} and ${shape.arP90.toFixed(2)}` : ''}`
  return (
    <div className="el-range-wrap">
      <div className="el-range" role="img" aria-label={label} data-testid="diag-shape-range">
        {hasBand ? <i className="el-range-band" style={{ left: shapePct(lo), width: `${parseFloat(shapePct(hi)) - parseFloat(shapePct(lo))}%` }} /> : null}
        <i className="el-range-tick" style={{ left: shapePct(shape.arMedian) }} />
        <b className="el-range-med" style={{ left: shapePct(shape.arMedian) }}>{shape.arMedian.toFixed(2)}</b>
      </div>
      <div className="el-range-axis" aria-hidden="true"><span>round 1.0</span><span>3.0 elongated</span></div>
    </div>
  )
}

function ChecksShape({ model, phone }) {
  const { shape } = model
  return (
    <div className="el-pcheck" data-testid="diag-shape">
      <h3 className="el-pcheck-title">Particle shape</h3>
      {shape ? (
        <>
          <p className="el-pcheck-text">
            Typically <b>{shape.arMedian.toFixed(2)} : 1</b> (length to width)
            {shape.arP10 != null && shape.arP90 != null ? `; 80% of the volume is between ${shape.arP10.toFixed(2)} and ${shape.arP90.toFixed(2)}` : ''}.
          </p>
          <ShapeRange shape={shape} />
          {shape.n != null ? <p className={`el-pcheck-foot muted${phone ? '' : ' is-spaced'}`}>From {shape.n.toLocaleString()} particles of at least {model.minPx} px.</p> : null}
        </>
      ) : (
        <p className="el-pcheck-text muted">Not enough particles of at least {model.minPx} px to measure their shape in this photo.</p>
      )}
    </div>
  )
}

function ChecksSplit({ model, phone, onOpenAnalyzer }) {
  const { table } = model
  if (!table) {
    return (
      <div className="el-pcheck" data-testid="diag-split-off">
        <h3 className="el-pcheck-title">Touching particles</h3>
        <p className="el-pcheck-text">
          Turn on <b>Separate touching particles</b> in the Analyzer settings and detect again to compare Dv90 with and without it.
        </p>
        <button type="button" className="el-link-btn" onClick={onOpenAnalyzer} data-testid="diag-open-analyzer">Open Analyzer</button>
      </div>
    )
  }
  const change = table.change
  const dv90After = change ? (
    <span className={`el-pcheck-change${change.lower ? ' is-good' : ''}`}>{change.text}</span>
  ) : null
  return (
    <div className="el-pcheck" data-testid="diag-split-on">
      <h3 className="el-pcheck-title">Touching particles</h3>
      {phone ? (
        <>
          <p className="el-pcheck-sub muted">Not separated → separated</p>
          <div className="el-pcheck-rows" data-testid="diag-split-table">
            <div className="el-pcheck-row"><span>Particles</span><span>{countText(table.particles[0])} → {countText(table.particles[1])}</span></div>
            <div className="el-pcheck-row"><span>Dv50</span><span>{umText(table.dv50[0])} → {umText(table.dv50[1])}</span></div>
            <div className="el-pcheck-row"><span>Dv90</span><span>{fmtUmOnly(table.dv90[0])} → {umText(table.dv90[1])} {dv90After}</span></div>
          </div>
        </>
      ) : (
        <table className="el-pcheck-table" data-testid="diag-split-table">
          <thead><tr><th scope="col"><span className="el-sr-only">Measure</span></th><th scope="col" className="num">Not separated</th><th scope="col" className="num">Separated</th></tr></thead>
          <tbody>
            <tr><th scope="row">Particles</th><td className="num">{countText(table.particles[0])}</td><td className="num">{countText(table.particles[1])}</td></tr>
            <tr><th scope="row">Dv50</th><td className="num">{umText(table.dv50[0])}</td><td className="num">{umText(table.dv50[1])}</td></tr>
            <tr><th scope="row">Dv90</th><td className="num">{umText(table.dv90[0])}</td><td className="num">{umText(table.dv90[1])} {dv90After}</td></tr>
          </tbody>
        </table>
      )}
      <p className="el-pcheck-foot muted">Separation lowers Dv90 when clumps are counted as one large particle. Points saved to the grinder curve while it is on are marked.</p>
    </div>
  )
}

/** "823" without the unit, for the phone's "823 → 792 µm" form. */
const fmtUmOnly = (mm) => (finite(mm) ? fmtUm(mm) : '—')

/* ------------------------------ page ------------------------------ */

export default function DiagnosticsPage() {
  const { shots } = useShots()
  const { go } = useNav()
  const phone = useBreakpoint() === 'phone'
  const cal = useGrindCalibration(shots)
  const model = useForecastModel(shots, cal.mean)
  const coverage = useMemo(() => dataCoverage(shots || [], { calibration: { mean: cal.mean } }), [shots, cal.mean])
  const [infoOpen, setInfoOpen] = useState(false)
  const [sheet, setSheet] = useState(null)
  const [showDates, setShowDates] = useState(false)
  const latest = useLatestAnalysis()
  const checks = useMemo(() => photoChecksModel(latest), [latest])
  const openAnalyzer = () => { setSheet(null); go('analyzer') }

  const bt = model?.backtest ?? null
  const withExtraction = coverage.withExtraction ?? model?.n ?? 0
  const available = Boolean(model?.available)
  const rating = bt?.rating ?? null

  const beats = bt ? bt.model.mae < bt.baseline.mae : false
  const halfImproving = bt && finite(bt.firstHalfMae) && finite(bt.lastHalfMae) && bt.lastHalfMae < bt.firstHalfMae
  const within = bt ? Math.round(bt.model.within1 * bt.evaluated) : 0
  const bestBin = rating?.calibration?.length ? rating.calibration.reduce((a, b) => (b.count > a.count ? b : a)) : null

  const emptyText = !available
    ? model?.reason || 'Log 8 shots with extraction to unlock forecasts.'
    : `Accuracy is measured once there are ${LIMITS.BACKTEST_MIN_TRAIN + LIMITS.MIN_EVAL} shots with extraction (${withExtraction} so far).`

  const kicker = bt
    ? `Forecast accuracy · tested on ${bt.evaluated} of ${withExtraction} shots`
    : 'Forecast accuracy'

  /* ---- headline ---- */
  const headline = bt ? (
    <section className="el-card el-headline" data-testid="diag-headline" aria-label="Summary">
      <span className={`el-headline-icon ${beats ? 'is-good' : 'is-warn'}`} aria-hidden="true">{beats ? '✓' : '!'}</span>
      <div>
        <h2>{beats ? 'The forecast beats guessing your average' : "The forecast doesn't beat guessing your average yet"}</h2>
        <p>
          Each of {bt.evaluated} past shots was predicted using only the shots before it. It missed by {f1(bt.model.mae)} pts on average.
          Always guessing your average would miss by {f1(bt.baseline.mae)} pts
          {beats ? `, so the forecast cuts the error by ${Math.round(bt.improvementPct)}%.` : ', so the forecast does not cut the error yet. More logged shots should help.'}
        </p>
      </div>
    </section>
  ) : (
    <section className="el-card" data-testid="diag-empty">
      <p className="el-empty-title">Accuracy is not measured yet.</p>
      <p className="muted">{emptyText}</p>
    </section>
  )

  /* ---- tiles ---- */
  const tiles = bt ? [
    <Tile
      key="mae"
      testId="diag-mae"
      label="Typical miss (MAE)"
      value={f1(bt.model.mae)}
      unit=" pts"
      hint="Lower is better"
      rows={[
        { label: 'Forecast', meter: bt.model.mae, max: Math.max(bt.model.mae, bt.baseline.mae) * 1.2, text: `${f1(bt.model.mae)} pts`, tone: 'accent' },
        { label: 'Always your average', meter: bt.baseline.mae, max: Math.max(bt.model.mae, bt.baseline.mae) * 1.2, text: `${f1(bt.baseline.mae)} pts`, tone: 'grey' },
      ]}
    />,
    <Tile
      key="r2"
      testId="diag-r2"
      label="Variation explained (R²)"
      value={f2(bt.model.r2)}
      hint="Higher is better"
      rows={[
        { label: 'Forecast', meter: Math.max(0, bt.model.r2 ?? 0), max: 1, text: f2(bt.model.r2), tone: 'accent' },
        { label: 'Always your average', meter: Math.max(0, bt.baseline.r2 ?? 0), max: 1, text: f2(bt.baseline.r2), tone: 'grey' },
      ]}
    />,
    <Tile
      key="within"
      testId="diag-within"
      label="Within ±1 pt of actual"
      value={Math.round(bt.model.within1 * 100)}
      unit="%"
      hint={`${within} of ${bt.evaluated} shots`}
      rows={[
        { label: 'Forecast', meter: bt.model.within1, max: 1, text: pct0(bt.model.within1), tone: 'accent' },
        { label: 'Always your average', meter: bt.baseline.within1, max: 1, text: pct0(bt.baseline.within1), tone: 'grey' },
      ]}
    />,
  ] : null

  /* ---- chart bodies ---- */
  const scatterBody = bt ? (
    <>
      <PredActualChart points={bt.points} testId="diag-scatter-chart" />
      <ChartLegend items={[
        { label: 'Within ±1 pt', type: 'dot', cls: 'el-pt-photo' },
        { label: 'Missed by more', type: 'ring', cls: 'el-pt-miss' },
        { label: '±1 pt band', type: 'band', cls: 'el-band' },
        { label: 'Perfect', type: 'dash', cls: 'el-diagonal' },
      ]}
      />
      <p className="el-footnote">{within} of {bt.evaluated} forecasts landed inside the band. Each dot is one past shot, predicted only from the shots before it.</p>
    </>
  ) : <p className="muted">{emptyText}</p>

  const errorsBody = bt ? (
    <>
      <ErrorTimeChart points={bt.points} baselineMae={bt.baseline.mae} firstHalfMae={bt.firstHalfMae} lastHalfMae={bt.lastHalfMae} halfSize={bt.halfSize} />
      <ChartLegend items={[
        { label: 'Miss per shot', type: 'band', cls: 'el-bar' },
        { label: `Average, first ${bt.halfSize}`, type: 'line', cls: 'el-avg-first' },
        { label: `Average, last ${bt.halfSize}`, type: 'line', cls: 'el-avg-last' },
        { label: 'Your average', type: 'dash', cls: 'el-baseline' },
      ]}
      />
      <p className="el-footnote">
        {halfImproving ? 'Improving as you log more' : 'Not improving yet'}: first {bt.halfSize} shots missed by {f2(bt.firstHalfMae)} pts, last {bt.halfSize} by {f2(bt.lastHalfMae)} pts.
      </p>
    </>
  ) : <p className="muted">{emptyText}</p>

  const ratingBody = rating && rating.calibration?.length ? (
    <>
      <RatingCalChart bins={rating.calibration} />
      <ChartLegend items={[
        { label: 'Bigger dot = more shots', type: 'dot', cls: 'el-pt-great' },
        { label: 'Perfect', type: 'dash', cls: 'el-diagonal' },
      ]}
      />
      <p className="el-footnote">
        {bestBin ? `When it said about ${Math.round(bestBin.predicted * 100)}% Great, ${Math.round(bestBin.observed * 100)}% came true (${Math.round(bestBin.observed * bestBin.count)} of ${bestBin.count}). ` : ''}
        Balanced accuracy on rating calls: {pct0(rating.balancedAccuracy)}.
      </p>
    </>
  ) : <p className="muted">{bt ? 'Rating calls need more rated shots to be checked.' : emptyText}</p>

  const features = model?.features ?? []
  const inputs = features.filter((f) => f.reason !== 'not_an_input')
  const notInputs = features.filter((f) => f.reason === 'not_an_input')
  const phFeature = features.find((f) => f.key === 'ph')
  const ranked = inputs.filter((f) => f.used && finite(f.importance)).sort((a, b) => b.importance - a.importance)
  const importanceBody = (
    <>
      {ranked.length ? (
        <div className="el-bars">
          {ranked.map((f) => (
            <div className="el-bar-row" key={f.key}>
              <span>{f.label}</span>
              <Meter value={f.importance} max={1} label={`${f.label}: ${pct0(f.importance)} of the forecast`} />
              <b>{pct0(f.importance)}</b>
            </div>
          ))}
        </div>
      ) : <p className="muted">{available ? 'Shares appear once the forecast has been tested.' : emptyText}</p>}
      <ul className="el-feature-list">
        {inputs.map((f) => (
          <li key={f.key}>
            <b>{f.label}</b>
            <span className={`el-feature-state is-${f.reason}`}>{f.used ? 'used' : f.reason === 'too_few' ? 'too few shots' : f.reason === 'no_gain' ? 'no gain' : f.reason}</span>
            <small>{f.detail}</small>
          </li>
        ))}
        {notInputs.map((f) => (
          <li key={f.key}>
            <b>{f.label}</b>
            <span className="el-feature-state is-not_an_input">not an input</span>
            <small>measured during the shot, not a forecast input</small>
          </li>
        ))}
      </ul>
      {phFeature && phFeature.reason === 'too_few' ? (
        <Callout tone="warn"><b>{phFeature.detail}.</b> pH is used only on shots where you entered it.</Callout>
      ) : null}
    </>
  )

  const total = coverage.total || 0
  const coverageBody = (
    <>
      <div className="el-cov">
        <CoverageRow label="Shots with pH" value={coverage.ph.count} total={total} />
        <CoverageRow
          label="Grind size (µm)"
          value={coverage.grindMeasured}
          extra={coverage.grindEstimated}
          total={total}
          detail={`${coverage.grindMeasured} measured · ${coverage.grindEstimated} est.`}
        />
        <CoverageRow label="TDS" value={coverage.tds} total={total} />
        <CoverageRow label="Dose and yield" value={coverage.doseYield} total={total} />
      </div>
      <div data-testid="diag-ph52">
        {coverage.ph52.count > 0 ? (
          <Callout tone="warn">
            <b>{coverage.ph52.count} {coverage.ph52.count === 1 ? 'shot has' : 'shots have'} pH exactly 5.2.</b>{' '}
            That was the old default, so some may not be real readings. They are not changed automatically.
            <button type="button" className="el-link-btn is-inline" aria-expanded={showDates} onClick={() => setShowDates((v) => !v)}>
              {showDates ? 'Hide dates' : 'Show dates'}
            </button>
            {showDates ? (
              <ul className="el-date-list">
                {coverage.ph52.dates.map((d, i) => <li key={`${d}-${i}`}>{formatShortDate(d) || d}</li>)}
              </ul>
            ) : null}
          </Callout>
        ) : (
          <p className="muted el-footnote">No shots have pH exactly 5.2.</p>
        )}
      </div>
      <button type="button" className="el-link-btn" onClick={() => go('shots', { tab: 'log' })}>Review shots in the log ›</button>
    </>
  )

  const fitModel = cal.mean
  const fitRange = fitModel?.kind === 'curve' && finite(fitModel.xMin) ? `${indexToSetting(fitModel.xMin)}–${indexToSetting(fitModel.xMax)}` : '—'
  const fitScatter = fitModel?.kind === 'curve' && finite(fitModel.scatterPct) ? `±${fitModel.scatterPct.toFixed(0)}%` : '—'
  const fitBody = (
    <>
      <div className="el-fit-stats">
        <div><span>Points in the fit</span><b>{fitModel?.n ?? 0}</b></div>
        <div><span>Typical scatter</span><b>{fitScatter}</b></div>
        <div><span>Settings covered</span><b>{fitRange}</b></div>
      </div>
      {fitModel?.kind === 'curve' ? (
        <>
          <FitResidualChart points={cal.points.filter((p) => p.metric === 'mean')} model={fitModel} />
          <ChartLegend items={[
            { label: 'Point vs curve', type: 'dot', cls: 'el-pt-photo' },
            { label: `±${fitModel.scatterPct.toFixed(0)}% band`, type: 'band', cls: 'el-band' },
          ]}
          />
        </>
      ) : <p className="muted">{(fitModel?.n ?? 0) === 0 ? 'No calibration points yet.' : `Need 3 points on 2 settings for a curve (${fitModel.n} so far).`}</p>}
      <button type="button" className="el-link-btn" onClick={() => go('grinder')}>Open Grinder ›</button>
    </>
  )

  /* ------------------------------ phone ------------------------------ */
  if (phone) {
    const rows = [
      { id: 'scatter', title: 'Predicted vs actual', sub: bt ? `${within} of ${bt.evaluated} within ±1 pt` : 'Not measured yet', body: scatterBody, testId: 'diag-scatter' },
      { id: 'errors', title: 'Error over time', sub: bt ? `${halfImproving ? 'Improving' : 'Not improving yet'}: ${f2(bt.firstHalfMae)} to ${f2(bt.lastHalfMae)} pts` : 'Not measured yet', body: errorsBody, testId: 'diag-error-time' },
      { id: 'rating', title: 'Rating calibration', sub: bestBin ? `Said ${Math.round(bestBin.predicted * 100)}% Great, ${Math.round(bestBin.observed * 100)}% came true` : 'Not measured yet', body: ratingBody, testId: 'diag-rating-cal' },
      { id: 'inputs', title: 'Which inputs matter', sub: ranked[0] ? `${ranked[0].label} matters most` : 'No tested inputs yet', body: importanceBody, testId: 'diag-importance' },
      { id: 'coverage', title: 'Data coverage', sub: coverage.ph52.count ? `${coverage.ph52.count} shots may have a default pH` : `pH on ${coverage.ph.count} of ${total} shots`, body: coverageBody, testId: 'diag-coverage' },
      { id: 'fit', title: 'Grinder calibration fit', sub: `${fitModel?.n ?? 0} points · ${fitScatter} scatter`, body: fitBody, testId: 'diag-grinder-fit' },
      { id: 'checks', title: 'Photo analysis checks', sub: checksSubtitle(checks), body: null, testId: 'diag-photo-checks', plain: true },
    ]
    const open = rows.find((r) => r.id === sheet)
    return (
      <div className="el-page el-diagnostics" data-testid="diagnostics-page">
        <PageHeader kicker={bt ? `Tested on ${bt.evaluated} of ${withExtraction} shots` : 'Forecast accuracy'} title="Diagnostics" />
        {bt ? (
          <p className="el-headline-line" data-testid="diag-headline">
            <span className={`el-headline-icon is-small ${beats ? 'is-good' : 'is-warn'}`} aria-hidden="true">{beats ? '✓' : '!'}</span>
            {beats ? 'Beats' : "Doesn't beat"} guessing your average: {f1(bt.model.mae)} vs {f1(bt.baseline.mae)} pts
          </p>
        ) : (
          <div className="el-empty" data-testid="diag-empty"><p className="el-empty-title">Accuracy is not measured yet.</p><p>{emptyText}</p></div>
        )}
        {tiles ? <PagedRow ariaLabel="Accuracy summary" testId="diag-tiles">{tiles}</PagedRow> : null}
        <InsetGroup>
          {rows.map((r) => (
            <ListRow key={r.id} title={r.title} subtitle={r.sub} onClick={() => setSheet(r.id)} testId={`diag-open-${r.id}`} />
          ))}
          <ListRow title="How this is measured" onClick={() => setSheet('info')} testId="diag-open-info" />
        </InsetGroup>
        <Sheet
          open={Boolean(open)}
          onClose={() => setSheet(null)}
          title={open?.title ?? ''}
          leftAction={{ label: 'Back', onClick: () => setSheet(null) }}
          initialDetent="large"
          testId="diag-sheet"
        >
          {open && open.id === 'checks' ? (
            <div className="el-checks-sheet" data-testid={open.testId}>
              <p className="muted el-checks-lead">From your latest analysis on this device. Not saved.</p>
              {checks ? (
                <>
                  <div className="el-card"><ChecksShape model={checks} phone /></div>
                  <div className="el-card"><ChecksSplit model={checks} phone onOpenAnalyzer={openAnalyzer} /></div>
                </>
              ) : <div className="el-card"><p className="el-pcheck-text">Analyze a photo to see these checks.</p></div>}
            </div>
          ) : open ? <div className="el-card el-in-sheet" data-testid={open.testId}>{open.body}</div> : null}
        </Sheet>
        <Sheet
          open={sheet === 'info'}
          onClose={() => setSheet(null)}
          title="How this is measured"
          leftAction={{ label: 'Back', onClick: () => setSheet(null) }}
          testId="diag-info-sheet"
        >
          <div className="el-sheet-note">{MEASURED_COPY.map((t) => <p key={t}>{t}</p>)}</div>
        </Sheet>
      </div>
    )
  }

  /* ------------------------- desktop and tablet ------------------------- */
  return (
    <div className="el-page el-diagnostics" data-testid="diagnostics-page">
      <PageHeader
        kicker={kicker}
        title="Diagnostics"
        actions={(
          <button type="button" className="el-btn-tinted" aria-expanded={infoOpen} onClick={() => setInfoOpen((v) => !v)} data-testid="diag-how">
            How this is measured
          </button>
        )}
      />
      {infoOpen ? (
        <section className="el-card el-measured" aria-label="How this is measured">
          {MEASURED_COPY.map((t) => <p key={t}>{t}</p>)}
        </section>
      ) : null}
      {headline}
      {tiles ? <div className="el-diag-tiles">{tiles}</div> : null}
      {bt ? (
        <div className="el-diag-grid">
          <section className="el-card" data-testid="diag-scatter"><h2>Predicted vs actual</h2><p className="muted el-card-lead">One dot per past shot.</p>{scatterBody}</section>
          <section className="el-card" data-testid="diag-error-time"><h2>Error over time</h2><p className="muted el-card-lead">How far each forecast missed, by shot.</p>{errorsBody}</section>
          <section className="el-card" data-testid="diag-rating-cal"><h2>Rating calibration</h2><p className="muted el-card-lead">Did &quot;70% Great&quot; come true about 70% of the time?</p>{ratingBody}</section>
        </div>
      ) : null}
      <div className="el-diag-grid">
        <section className="el-card" data-testid="diag-importance"><h2>Which inputs matter</h2><p className="muted el-card-lead">Share of the forecast that each input explains.</p>{importanceBody}</section>
        <section className="el-card" data-testid="diag-coverage"><h2>Data coverage</h2><p className="muted el-card-lead">What the forecast has to work with.</p>{coverageBody}</section>
        <section className="el-card" data-testid="diag-grinder-fit"><h2>Grinder calibration fit</h2><p className="muted el-card-lead">How closely the setting-to-size curve matches your points.</p>{fitBody}</section>
      </div>
      <section className="el-card el-checks" data-testid="diag-photo-checks">
        <h2>Photo analysis checks</h2>
        <p className="muted el-card-lead">From your latest analysis on this device. Not saved.</p>
        {checks ? (
          <div className="el-checks-cols">
            <ChecksShape model={checks} />
            <ChecksSplit model={checks} onOpenAnalyzer={openAnalyzer} />
          </div>
        ) : <p className="el-pcheck-text" data-testid="diag-checks-empty">Analyze a photo to see these checks.</p>}
      </section>
    </div>
  )
}
