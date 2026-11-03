import HistogramChart from './HistogramChart'
import { um, sig, fixed, isNum, cleanUnit } from '../analyzerUtils'
import { histogramKind, normalizeShape, normalizeSplit, normalizeSummary } from '../analyzerCompat'

const UNCAL = 'Uncalibrated model (Gagné heuristic), not a measurement'

/** [lo, hi] mm -> "lo–hi" µm. */
function ciText(ci) {
  if (!Array.isArray(ci) || ci.length !== 2 || !ci.every(isNum)) return null
  const f = (v) => Math.round(v * 1000).toLocaleString()
  return `${f(ci[0])}–${f(ci[1])}`
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="note-icon">
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" />
    </svg>
  )
}

function EllipseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="note-icon shape-icon">
      <ellipse cx="12" cy="12" rx="9.5" ry="6" transform="rotate(-30 12 12)" />
    </svg>
  )
}

const SHAPE_TIP = 'Volume-weighted median length-to-width ratio of particles of at least 20 px. 1 : 1 is round.'

const ratio = (v) => v.toFixed(2)

/** "Shape 1.32 : 1  length to width · 80% between 1.08 and 1.75" (shorter on the phone sheet). */
function ShapeLine({ shape, phone }) {
  const hasRange = shape.arP10 != null && shape.arP90 != null
  let rest = ''
  if (phone) rest = hasRange ? ` · 80% ${ratio(shape.arP10)}–${ratio(shape.arP90)}` : ''
  else rest = ` length to width${hasRange ? ` · 80% between ${ratio(shape.arP10)} and ${ratio(shape.arP90)}` : ''}`
  return (
    <p className="card-note shape-line" data-testid="shape-line" title={SHAPE_TIP}>
      <EllipseIcon />
      <span>
        <span className="shape-label">Shape</span>{'\u00a0 '}
        <span className="shape-value">{ratio(shape.arMedian)} : 1</span>
        {rest}
      </span>
    </p>
  )
}

/** Shown only when "Separate touching particles" was on for this analysis. */
function SplitNote({ split, phone }) {
  let text
  if (split.clustersSplit > 0) {
    const before = split.before?.dv90 != null ? split.before.dv90 : null
    if (phone) {
      text = (
        <>
          Separated {split.clustersSplit.toLocaleString()} clumps → {split.pieces.toLocaleString()} particles
          {before != null && <> · <span className="nowrap">Dv90 before {um(before)} µm</span></>}
        </>
      )
    } else {
      text = `Separated ${split.clustersSplit.toLocaleString()} touching clumps into ${split.pieces.toLocaleString()} particles.${before != null ? ` Dv90 before separating: ${um(before)} µm.` : ''}`
    }
  } else {
    text = 'Separate touching particles is on; no touching clumps were found.'
  }
  return (
    <p className="card-note" data-testid="split-note">
      <InfoIcon />
      <span>{text}</span>
    </p>
  )
}

export function SpreadStat({ label, value, upper, lower, unit }) {
  return (
    <div className="histogram-stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-unit">{unit}</span>
      {upper !== '—' && lower !== '—' && (
        <span className="asym-err" title="Spread: 16th to 84th percentile of the distribution, not a measurement error">
          <span className="asym-upper">+{upper}</span>
          <span className="asym-lower">−{lower}</span>
        </span>
      )}
    </div>
  )
}

/** Dv10/Dv50/Dv90 reference lines for a volume-weighted histogram (raw mm, same unit as the bin edges). */
export function dvMarkers(summary, withLabels) {
  if (!summary || summary.legacy) return []
  return [
    ['Dv10', summary.dv10],
    ['Dv50', summary.dv50],
    ['Dv90', summary.dv90],
  ]
    .filter(([, v]) => isNum(v))
    .map(([name, v]) => ({ value: v, label: withLabels ? `${name} · ${um(v)}` : name }))
}

/** Stats shown as lines on the chart; with Dv markers the median line would only duplicate Dv50. */
function chartStats(histogram, markers) {
  if (!histogram) return []
  if (markers.length) return [{ mean: histogram.mean, p16: histogram.p16, p84: histogram.p84 }]
  return [histogram]
}

/** Headline for the collapsed card / pill: the Dv50, or the mean for a legacy summary. */
export function headlineOf(rawSummary) {
  const s = normalizeSummary(rawSummary)
  if (!rawSummary) return null
  if (!s.legacy) return { label: 'Dv50', mm: s.dv50 }
  if (s.meanMm != null) return { label: 'Mean', mm: s.meanMm }
  return null
}

/** The body of the glass results card (and of the phone sheet). */
export default function ResultsPanel({
  result, histogram, histogramLoading, weight = 'mass', expanded = false, onToggleExpand, phone = false,
}) {
  if (!result) return null
  const { nclusters, summary: rawSummary } = result
  const summary = normalizeSummary(rawSummary)
  const kind = histogramKind(histogram)
  const count = (nclusters ?? 0).toLocaleString()

  if (!rawSummary) {
    return (
      <div className="results-body">
        <p className="card-note">Set the reference scale (step 1) to get sizes in µm.</p>
        <p className="card-note"><span className="results-count">{count} particles</span></p>
      </div>
    )
  }

  const legacy = summary.legacy
  const heroMm = legacy ? summary.meanMm : summary.dv50
  const ci = legacy ? null : ciText(summary.ci50)
  const withDv = weight === 'mass' && !legacy
  const markers = withDv ? dvMarkers(summary, false) : []
  const limit = summary.limitUm != null ? Math.round(summary.limitUm) : null
  const raw = rawSummary
  const span = isNum(raw.span) ? raw.span : null
  const gm = raw.geometric_mean_volume_mm
  const scaleUnc = raw.diameter_scale_unc_pct
  const shape = normalizeShape(result.shape_summary)
  const split = normalizeSplit(result.split_info)
  const shapeNotes = (shape || split) ? (
    <>
      {shape && <ShapeLine shape={shape} phone={phone} />}
      {split && <SplitNote split={split} phone={phone} />}
    </>
  ) : null

  return (
    <div className="results-body">
      <div className="stat-hero">
        <span className="stat-hero-label">{legacy ? 'Mean size (by mass)' : 'Median size by volume · Dv50'}</span>
        <span className="stat-hero-main">
          <span className="stat-hero-value">{um(heroMm)}<small>µm</small></span>
        </span>
        {ci && <span className="stat-hero-ci">95% confidence {ci} µm</span>}
        {legacy && summary.stdMm != null && (
          <span className="stat-hero-ci">spread ± {um(summary.stdMm)} µm</span>
        )}
      </div>

      <div className="stat-tiles">
        {!legacy && (
          <div className="stat-tile">
            <span className="tile-label">Dv10 · fines side</span>
            <span className="tile-value">{um(summary.dv10)} µm</span>
          </div>
        )}
        {!legacy && (
          <div className="stat-tile">
            <span className="tile-label">Dv90 · boulders</span>
            <span className="tile-value">{um(summary.dv90)} µm</span>
          </div>
        )}
        <div className="stat-tile">
          <span className="tile-label">Detected</span>
          <span className="tile-value"><span className="results-count">{count}<span className="count-word"> particles</span></span></span>
        </div>
        {!legacy && (
          <div className="stat-tile">
            <span className="tile-label">Spread (GSD)</span>
            <span className="tile-value">{isNum(summary.gsd) ? summary.gsd.toFixed(2) : '—'}</span>
          </div>
        )}
      </div>

      {!phone && shapeNotes}

      {!legacy && (
        <p className="card-note" data-testid="fines-note">
          <InfoIcon />
          <span>
            {summary.finesMeasurable
              ? `Fines under 100 µm: ${summary.finesPct.toFixed(1)}% of the volume.`
              : `Fines under ${limit != null ? `${limit} µm` : 'the detection limit'} can't be resolved in this photo, so they aren't counted.`}
          </span>
        </p>
      )}

      {kind === 'series' && (
        <div className="card-chart">
          <HistogramChart
            data={histogram.series}
            stats={markers.length ? [] : chartStats(histogram, markers)}
            scale={histogram.scale ?? 1}
            unit={cleanUnit(histogram.unit)}
            height={90}
            compact
            tone="dark"
            markers={markers}
          />
        </div>
      )}
      {kind !== 'series' && rawSummary && !histogram && histogramLoading && (
        <div className="histogram-loading" role="status"><span className="spinner" />Loading size distribution…</div>
      )}

      {phone && shapeNotes}

      <button
        type="button"
        className="card-button"
        data-testid="histogram-expand"
        aria-expanded={expanded}
        onClick={onToggleExpand}
        disabled={!histogram && !histogramLoading}
      >
        {expanded ? 'Collapse distribution' : 'Expand distribution'}
      </button>

      <details className="card-details">
        <summary>More measurements</summary>
        <div className="metrics">
          {!legacy && (summary.finesMeasurable ? (
            <Metric label="Fines < 100 µm" value={`${summary.finesPct.toFixed(1)}%`} hint="Share of particle volume below 100 µm" />
          ) : (
            <Metric
              label="Fines < 100 µm"
              value="n/a"
              hint={`Not measurable at this resolution${limit != null ? ` (limit ${limit} µm)` : ''}`}
              wrap
            />
          ))}
          {!legacy && <Metric label="Span" value={span != null ? span.toFixed(2) : null} hint="(Dv90 − Dv10) / Dv50" />}
          {!legacy && isNum(gm) && <Metric label="Geo. mean" value={`${um(gm)} µm`} hint="By volume" />}
          <Metric label="Mean (by mass)" value={isNum(raw.diameter_mean_mm) ? `${um(raw.diameter_mean_mm)} µm` : null} hint={isNum(raw.diameter_std_mm) ? `spread ± ${um(raw.diameter_std_mm)} µm` : null} />
          {!legacy && (
            <Metric label="Mean (by count)" value={isNum(raw.diameter_number_mean_mm) ? `${um(raw.diameter_number_mean_mm)} µm` : null} hint={isNum(raw.diameter_number_median_mm) ? `median ${um(raw.diameter_number_median_mm)} µm` : null} />
          )}
          {!legacy && isNum(scaleUnc) && (
            <Metric label="Scale uncertainty" value={`±${scaleUnc.toFixed(2)}%`} hint="From clicking the coin edges" />
          )}
          {shape && (
            <Metric
              label="Aspect ratio"
              value={ratio(shape.arMedian)}
              hint={shape.arP10 != null && shape.arP90 != null ? `10–90%: ${ratio(shape.arP10)}–${ratio(shape.arP90)}` : null}
              title={SHAPE_TIP}
            />
          )}
          {split && split.before?.dv90 != null && (
            <Metric label="Dv90 unseparated" value={`${um(split.before.dv90)} µm`} hint="at detection" />
          )}
          <Metric label="Surface quality" value={fixed(raw.surface_quality, 2)} hint="Uncalibrated model" title={`${UNCAL}. Mean / std of surface; higher = more uniform.`} />
          <Metric label="Est. extraction" value={isNum(raw.average_extraction_yield_pct) ? `${raw.average_extraction_yield_pct.toFixed(1)}%` : null} hint="Uncalibrated model" title={UNCAL} />
          <Metric label="Efficiency" value={isNum(raw.average_efficiency_pct) ? `${raw.average_efficiency_pct.toFixed(1)}%` : null} hint="Uncalibrated model" title={`${UNCAL}. Share of mass within reach of the extraction depth.`} />
        </div>
      </details>
    </div>
  )
}

/** The wide distribution section (below the photo on desktop, inside the sheet on phone). */
export function DistributionPanel({ histogram, loading, summary: rawSummary, weight, onWeightChange, tone = 'light', pngAlt = 'Size distribution' }) {
  const kind = histogramKind(histogram)
  const summary = normalizeSummary(rawSummary)
  const unit = cleanUnit(histogram?.unit)
  const hs = histogram?.scale ?? 1
  const withDv = weight === 'mass' && !summary.legacy
  const markers = withDv ? dvMarkers(summary, true) : []

  return (
    <section className={`distribution-panel tone-${tone}`} data-testid="histogram-full" aria-label="Size distribution">
      <div className="distribution-head">
        <div>
          <h2>Size distribution</h2>
          <span className="results-note">{weight === 'mass' ? 'by volume' : 'by particle count'}</span>
        </div>
        {kind !== 'png' && (
          <div className="weight-toggle" role="group" aria-label="Weighting">
            <button type="button" aria-pressed={weight === 'mass'} onClick={() => onWeightChange?.('mass')}>By volume</button>
            <button type="button" aria-pressed={weight === 'number'} onClick={() => onWeightChange?.('number')}>By count</button>
          </div>
        )}
      </div>

      {!histogram && loading && (
        <div className="histogram-loading" role="status"><span className="spinner" />Loading size distribution…</div>
      )}

      {kind === 'series' && (
        <>
          <HistogramChart
            data={histogram.series}
            stats={chartStats(histogram, markers)}
            scale={hs}
            unit={unit}
            height={220}
            tone={tone}
            markers={markers}
          />
          <div className="histogram-stats">
            {[
              { label: 'Mean', val: histogram.mean, upper: histogram.mean_spread_upper ?? histogram.mean_upper, lower: histogram.mean_spread_lower ?? histogram.mean_lower },
              { label: 'Median', val: histogram.median, upper: histogram.median_spread_upper ?? histogram.median_upper, lower: histogram.median_spread_lower ?? histogram.median_lower },
            ].map(({ label, val, upper, lower }) => (
              <SpreadStat
                key={label}
                label={label}
                value={isNum(val) ? sig(val * hs) : '—'}
                upper={isNum(upper) ? sig(upper * hs) : '—'}
                lower={isNum(lower) ? sig(lower * hs) : '—'}
                unit={unit}
              />
            ))}
          </div>
        </>
      )}

      {kind === 'png' && (
        <img className="histogram-png" alt={pngAlt} src={`data:image/png;base64,${histogram.histogram_b64}`} />
      )}

      {kind === 'none' && histogram && <p className="results-note">No size distribution is available for this result.</p>}
    </section>
  )
}

function Metric({ label, value, hint, title, wrap }) {
  return (
    <div className="metric" title={title ?? hint ?? undefined}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value ?? '—'}</span>
      {hint && <span className={`metric-hint ${wrap ? 'wrap' : ''}`} title={hint}>{hint}</span>}
    </div>
  )
}
