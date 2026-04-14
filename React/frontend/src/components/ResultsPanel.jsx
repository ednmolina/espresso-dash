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
              <span>
                Mean: <strong>{histogramStats.mean?.toFixed(3)}</strong>
                <span className="asym-err">
                  <span className="asym-upper">+{histogramStats.mean_upper?.toFixed(3)}</span>
                  <span className="asym-lower">−{histogramStats.mean_lower?.toFixed(3)}</span>
                </span> mm
              </span>
              <span>
                Median: <strong>{histogramStats.median?.toFixed(3)}</strong>
                <span className="asym-err">
                  <span className="asym-upper">+{histogramStats.median_upper?.toFixed(3)}</span>
                  <span className="asym-lower">−{histogramStats.median_lower?.toFixed(3)}</span>
                </span> mm
              </span>
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
