import HistogramChart from './HistogramChart'
import { um, sig, fixed, isNum, cleanUnit } from '../analyzerUtils'

const UNCAL = 'Uncalibrated model (Gagné heuristic), not a measurement'

/** [lo, hi] confidence interval (mm) -> "lo–hi" µm, tolerating values already in µm. */
function ciText(ci) {
  if (!Array.isArray(ci) || ci.length !== 2 || !ci.every(isNum)) return null
  const inUm = Math.max(...ci) > 50
  const f = (v) => Math.round(inUm ? v : v * 1000).toLocaleString()
  return `${f(ci[0])}–${f(ci[1])}`
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

export default function ResultsPanel({ result, histogram, histogramLoading }) {
  if (!result) return null
  const { nclusters, summary } = result
  const spanOk = isNum(summary?.span) && summary.span <= 1.4
  const dv50ci = ciText(summary?.dv_ci95?.dv50)
  const gm = summary?.geometric_mean_volume_mm
  const gsd = summary?.gsd_volume
  const finesMeasurable = summary?.fines_measurable !== false && isNum(summary?.fines_volume_pct)
  const limit = isNum(summary?.detection_limit_um) ? Math.round(summary.detection_limit_um) : null
  const unit = cleanUnit(histogram?.unit)
  const hs = histogram?.scale ?? 1

  return (
    <section className="results-section">
      <div className="results-heading">
        <h3>Results</h3>
        <span className="results-count">{(nclusters ?? 0).toLocaleString()} particles</span>
      </div>

      {summary ? (
        <>
          <div className="stat-hero">
            <span className="stat-hero-label">Median size by volume · Dv50</span>
            <span className="stat-hero-main">
              <span className="stat-hero-value">{um(summary.dv50_mm)}<small>µm</small></span>
              {isNum(summary.span) && (
                <span
                  className={`span-badge ${spanOk ? 'ok' : 'warn'}`}
                  title="Span = (Dv90 − Dv10) / Dv50. Lower is a more uniform grind."
                >
                  span {summary.span.toFixed(2)}
                </span>
              )}
            </span>
            {dv50ci && <span className="stat-hero-ci">95% CI {dv50ci} µm</span>}
            <span className="stat-hero-sub">
              Dv10 {um(summary.dv10_mm)} · Dv90 {um(summary.dv90_mm)} µm
            </span>
            {(isNum(gm) || isNum(gsd)) && (
              <span className="stat-hero-sub">
                {isNum(gm) && <>Geo. mean {um(gm)} µm</>}
                {isNum(gm) && isNum(gsd) && ' · '}
                {isNum(gsd) && <>GSD {gsd.toFixed(2)}</>}
              </span>
            )}
            {isNum(summary.diameter_scale_unc_pct) && (
              <span className="stat-hero-sub" title="Uncertainty from clicking the coin edges">
                Scale uncertainty ±{summary.diameter_scale_unc_pct.toFixed(2)}%
              </span>
            )}
          </div>
          <div className="metrics">
            {finesMeasurable ? (
              <Metric label="Fines < 100 µm" value={`${summary.fines_volume_pct.toFixed(1)}%`} hint="Share of particle volume below 100 µm" />
            ) : (
              <Metric
                label="Fines < 100 µm"
                value="n/a"
                hint={`Not measurable at this resolution${limit != null ? ` (limit ${limit} µm)` : ''}`}
                wrap
              />
            )}
            <Metric label="Mean (by mass)" value={isNum(summary.diameter_mean_mm) ? `${um(summary.diameter_mean_mm)} µm` : null} hint={isNum(summary.diameter_std_mm) ? `spread ± ${um(summary.diameter_std_mm)} µm` : null} />
            <Metric label="Mean (by count)" value={isNum(summary.diameter_number_mean_mm) ? `${um(summary.diameter_number_mean_mm)} µm` : null} hint={isNum(summary.diameter_number_median_mm) ? `median ${um(summary.diameter_number_median_mm)} µm` : null} />
            <Metric label="Surface quality" value={fixed(summary.surface_quality, 2)} hint="Uncalibrated model" title={`${UNCAL}. Mean / std of surface; higher = more uniform.`} />
            <Metric label="Est. extraction" value={isNum(summary.average_extraction_yield_pct) ? `${summary.average_extraction_yield_pct.toFixed(1)}%` : null} hint="Uncalibrated model" title={UNCAL} />
            <Metric label="Efficiency" value={isNum(summary.average_efficiency_pct) ? `${summary.average_efficiency_pct.toFixed(1)}%` : null} hint="Uncalibrated model" title={`${UNCAL}. Share of mass within reach of the extraction depth.`} />
          </div>
        </>
      ) : (
        <p className="results-note">Set the reference scale (step 1) to get sizes in µm.</p>
      )}

      {summary && !histogram && histogramLoading && (
        <div className="histogram-loading" role="status"><span className="spinner" />Loading size distribution…</div>
      )}

      {histogram && (
        <div className="histogram">
          <div className="results-heading">
            <h4>Size distribution</h4>
            <span className="results-count">by particle count</span>
          </div>
          <HistogramChart
            data={histogram.series}
            stats={[histogram]}
            scale={hs}
            unit={unit}
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
        </div>
      )}
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
