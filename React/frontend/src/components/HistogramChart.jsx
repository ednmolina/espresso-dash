import { useEffect, useMemo, useRef, useState } from 'react'

// Validated (dataviz validator) against the analyzer's dark surface.
export const SERIES_COLORS = ['#c87533', '#3f87d4', '#5f9e52']

const MARGIN = { top: 14, right: 16, bottom: 44, left: 48 }
const HEIGHT = 260

function niceLinearTicks(min, max, count = 5) {
  const span = max - min
  if (!(span > 0)) return [min]
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const norm = step0 / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const ticks = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toPrecision(12))
  return ticks
}

function logTicks(min, max) {
  const ticks = []
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e += 1) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e
      if (v >= min && v <= max) ticks.push(v)
    }
  }
  return ticks.length >= 2 ? ticks : niceLinearTicks(min, max, 4)
}

function fmt(v) {
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '')
  return String(+v.toPrecision(2))
}

/**
 * Histogram of particle sizes.
 *  data   – { edges: number[], series: [{ label, fractions: number[] }], x_log }
 *  stats  – per-series [{ mean, median, p16, p84 }] in the same raw units as edges
 *  scale  – multiplier from raw units to display units (e.g. 1000 for mm -> µm)
 */
export default function HistogramChart({ data, stats = [], scale = 1, unit = 'mm', xLabel = 'Particle diameter', yLabel = 'Fraction of particles' }) {
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(560)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const geom = useMemo(() => {
    if (!data?.edges?.length) return null
    const { edges, series, x_log: xLog } = data
    const innerW = width - MARGIN.left - MARGIN.right
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom
    const lo = edges[0]
    const hi = edges[edges.length - 1]
    const t = xLog ? (v) => Math.log10(v) : (v) => v
    const x = (v) => MARGIN.left + ((t(v) - t(lo)) / (t(hi) - t(lo))) * innerW
    const yMax = Math.max(1e-9, ...series.flatMap((s) => s.fractions.map((f) => f ?? 0))) * 1.08
    const yTicks = niceLinearTicks(0, yMax, 4)
    const yTop = Math.max(yMax, yTicks[yTicks.length - 1])
    const y = (v) => MARGIN.top + innerH - (v / yTop) * innerH
    const xTicks = (xLog ? logTicks(lo * scale, hi * scale) : niceLinearTicks(lo * scale, hi * scale, 6)).map((v) => v / scale)
    return { edges, series, xLog, x, y, innerW, innerH, yTicks, xTicks, baseY: MARGIN.top + innerH }
  }, [data, width, scale])

  if (!geom) return null
  const { edges, series, x, y, yTicks, xTicks, baseY } = geom
  const multi = series.length > 1

  return (
    <div className="histogram-chart" ref={wrapRef}>
      {multi && (
        <div className="histogram-legend">
          {series.map((s, i) => (
            <span key={s.label} className="histogram-legend-item">
              <span className={`histogram-legend-swatch ${i === 0 ? '' : 'line'}`} style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg width={width} height={HEIGHT} role="img" aria-label={`${xLabel} histogram`} onMouseLeave={() => setHover(null)}>
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line className="hc-grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(v)} y2={y(v)} />
            <text className="hc-tick" x={MARGIN.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {`${+(v * 100).toPrecision(3)}%`}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={`x${v}`} className="hc-tick" x={x(v)} y={baseY + 16} textAnchor="middle">{fmt(v * scale)}</text>
        ))}
        <line className="hc-axis" x1={MARGIN.left} x2={width - MARGIN.right} y1={baseY} y2={baseY} />

        {/* the 16th–84th percentile spread of the first series (descriptive, not an error bar) */}
        {stats[0] && Number.isFinite(stats[0].p16) && Number.isFinite(stats[0].p84) && (
          <rect className="hc-band" x={x(stats[0].p16)} width={Math.max(0, x(stats[0].p84) - x(stats[0].p16))} y={MARGIN.top} height={baseY - MARGIN.top} />
        )}

        {series.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length]
          if (si === 0) {
            return s.fractions.map((f, bi) => {
              if (!f) return null
              const x0 = x(edges[bi]) + 1
              const w = Math.max(1, x(edges[bi + 1]) - x(edges[bi]) - 2)
              const h = baseY - y(f)
              const r = Math.min(3, w / 2, h)
              return (
                <path
                  key={`b${bi}`}
                  className={`hc-bar ${hover?.bin === bi ? 'hover' : ''}`}
                  fill={color}
                  d={`M${x0},${baseY} V${baseY - h + r} Q${x0},${baseY - h} ${x0 + r},${baseY - h} H${x0 + w - r} Q${x0 + w},${baseY - h} ${x0 + w},${baseY - h + r} V${baseY} Z`}
                />
              )
            })
          }
          let d = `M${x(edges[0])},${baseY}`
          s.fractions.forEach((f, bi) => { d += ` V${y(f ?? 0)} H${x(edges[bi + 1])}` })
          d += ` V${baseY}`
          return <path key={`s${si}`} d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        })}

        {stats.map((st, si) => (
          <g key={`m${si}`}>
            {Number.isFinite(st.mean) && <line className="hc-mean" x1={x(st.mean)} x2={x(st.mean)} y1={MARGIN.top} y2={baseY} stroke={multi ? SERIES_COLORS[si] : undefined} />}
            {!multi && Number.isFinite(st.median) && <line className="hc-median" x1={x(st.median)} x2={x(st.median)} y1={MARGIN.top} y2={baseY} />}
          </g>
        ))}

        {/* hover hit targets: full-height column per bin */}
        {edges.slice(0, -1).map((e, bi) => (
          <rect
            key={`h${bi}`}
            x={x(e)}
            width={Math.max(1, x(edges[bi + 1]) - x(e))}
            y={MARGIN.top}
            height={baseY - MARGIN.top}
            fill="transparent"
            onMouseEnter={() => setHover({ bin: bi })}
          />
        ))}

        <text className="hc-label" x={MARGIN.left + geom.innerW / 2} y={HEIGHT - 6} textAnchor="middle">{`${xLabel} (${unit})`}</text>
        <text className="hc-label" transform={`translate(12 ${MARGIN.top + geom.innerH / 2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>
      </svg>

      {hover && (
        <div
          className="hc-tooltip"
          style={{ left: Math.min(Math.max(x((edges[hover.bin] + edges[hover.bin + 1]) / 2), 80), width - 80) }}
        >
          <strong>{fmt(edges[hover.bin] * scale)}–{fmt(edges[hover.bin + 1] * scale)} {unit}</strong>
          {series.map((s, si) => (
            <span key={s.label}>
              {multi && <i style={{ background: SERIES_COLORS[si] }} />}
              {multi ? `${s.label}: ` : ''}{((s.fractions[hover.bin] ?? 0) * 100).toFixed(1)}%
            </span>
          ))}
        </div>
      )}

      <div className="histogram-key">
        <span><i className="key-mean" />Mean</span>
        {!multi && <span><i className="key-median" />Median</span>}
        {stats[0] && Number.isFinite(stats[0].p16) && <span><i className="key-band" />16th–84th percentile spread</span>}
      </div>
    </div>
  )
}
