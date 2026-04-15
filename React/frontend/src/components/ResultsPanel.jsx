export default function ResultsPanel({ result, histogramB64, histogramStats }) {
  if (!result) return null

  const { nclusters, background_median, summary } = result

  return (
    <div className="results-panel">
      <h3>Results</h3>
      <div className="metrics">
        <Metric label="Particles" value={nclusters} />
        <Metric label="Background median" value={background_median?.toFixed(1)} />
        {summary && (
          <>
            <Metric label="Mean diameter" value={`${summary.diameter_mean_mm?.toFixed(2)} mm`} />
            <Metric label="Std dev" value={`${summary.diameter_std_mm?.toFixed(2)} mm`} />
            <Metric label="Surface quality" value={summary.surface_quality?.toFixed(2)} />
            <Metric label="Efficiency" value={`${summary.average_efficiency_pct?.toFixed(1)}%`} />
          </>
        )}
      </div>

      {histogramB64 && (
        <div className="histogram">
          <h4>Histogram</h4>
          <img className="histogram-image" src={`data:image/png;base64,${histogramB64}`} alt="Histogram" />
          {histogramStats && (
            <div className="histogram-stats">
              {[
                { label: 'Mean', val: histogramStats.mean, upper: histogramStats.mean_upper, lower: histogramStats.mean_lower },
                { label: 'Median', val: histogramStats.median, upper: histogramStats.median_upper, lower: histogramStats.median_lower },
              ].map(({ label, val, upper, lower }) => {
                const s = histogramStats.scale ?? 1
                const rawUnit = histogramStats.unit ?? 'mm'
                const u = rawUnit.replace(/\$\\mu\$/g, 'μ')
                return (
                  <div key={label} className="histogram-stat-row">
                    <span className="stat-label">{label}:</span>
                    <span className="stat-value">{(val * s).toFixed(3)}</span>
                    <span className="asym-err">
                      <span className="asym-upper">+{(upper * s).toFixed(3)}</span>
                      <span className="asym-lower">−{(lower * s).toFixed(3)}</span>
                    </span>
                    <span className="stat-unit">{u}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value ?? '—'}</span>
    </div>
  )
}
