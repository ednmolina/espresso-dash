import HistogramChart from './HistogramChart'

const sig = (v) => (v == null || Number.isNaN(v) ? '—' : String(+v.toPrecision(3)))
const um = (mm) => (mm == null || Number.isNaN(mm) ? '—' : Math.round(mm * 1000).toLocaleString())

export function ErrorStat({ label, value, upper, lower, unit }) {
  return (
    <div className="histogram-stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="asym-err">
        <span className="asym-upper">+{upper}</span>
        <span className="asym-lower">−{lower}</span>
      </span>
      <span className="stat-unit">{unit}</span>
    </div>
  )
}

export default function ResultsPanel({ result, histogram }) {
  if (!result) return null
  const { nclusters, summary } = result

  return (
    <section className="results-section">
      <div className="results-heading">
        <h3>Results</h3>
        <span className="results-count">{nclusters.toLocaleString()} particles</span>
      </div>

      {summary ? (
        <>
          <div className="stat-hero">
            <span className="stat-hero-label">Median size by volume · Dv50</span>
            <span className="stat-hero-value">{um(summary.dv50_mm)}<small>µm</small></span>
            <span className="stat-hero-sub">
              Dv10 {um(summary.dv10_mm)} · Dv90 {um(summary.dv90_mm)} µm · span {summary.span?.toFixed(2)}
            </span>
          </div>
          <div className="metrics">
            <Metric label="Fines < 100 µm" value={`${summary.fines_volume_pct?.toFixed(1)}%`} hint="Share of particle volume below 100 µm" />
            <Metric label="Mean (by mass)" value={`${um(summary.diameter_mean_mm)} µm`} hint={`± ${um(summary.diameter_std_mm)} µm`} />
            <Metric label="Mean (by count)" value={`${um(summary.diameter_number_mean_mm)} µm`} hint={`median ${um(summary.diameter_number_median_mm)} µm`} />
            <Metric label="Surface quality" value={summary.surface_quality?.toFixed(2)} hint="Mean / std of surface; higher = more uniform" />
            <Metric label="Est. extraction" value={`${summary.average_extraction_yield_pct?.toFixed(1)}%`} hint="Model estimate, not a measurement" />
            <Metric label="Efficiency" value={`${summary.average_efficiency_pct?.toFixed(1)}%`} hint="Mass within reach of the extraction depth" />
          </div>
        </>
      ) : (
        <p className="results-note">Set the reference scale (step 1) to get sizes in µm.</p>
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
            scale={histogram.scale ?? 1}
            unit={(histogram.unit ?? 'mm').replace(/\$\\mu\$/g, 'µ')}
          />
          <div className="histogram-stats">
            {[
              { label: 'Mean', val: histogram.mean, upper: histogram.mean_upper, lower: histogram.mean_lower },
              { label: 'Median', val: histogram.median, upper: histogram.median_upper, lower: histogram.median_lower },
            ].map(({ label, val, upper, lower }) => {
              const s = histogram.scale ?? 1
              return (
                <ErrorStat
                  key={label}
                  label={label}
                  value={sig(val * s)}
                  upper={sig(upper * s)}
                  lower={sig(lower * s)}
                  unit={(histogram.unit ?? 'mm').replace(/\$\\mu\$/g, 'µ')}
                />
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

function Metric({ label, value, hint }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value ?? '—'}</span>
      {hint && <span className="metric-hint">{hint}</span>}
    </div>
  )
}
