import { useEffect, useMemo, useRef, useState } from 'react'

// Validated (dataviz validator): every pair is at least 15 dE apart for normal vision and each colour has
// >= 3:1 contrast on the light and the dark surface. Five overlaid lines cannot be told apart by hue alone
// for everyone (colour-blind viewers), so each run also has its own dash pattern, drawn in the chart, the
// legend and the saved-runs table. There are at most 5 runs (the Analyzer caps Save run at 5): colours and
// dashes are never reused. Run 1 is the filled bars, so its line style is "solid".
export const SERIES_COLORS = ['#c87533', '#3f87d4', '#5f9e52', '#c84b94', '#8a42c5']
export const SERIES_DASHES = [null, '8 4', '3 3', '10 3 2 3', '0.1 5']
const SERIES_FALLBACK = '#8e8e93'

export const seriesColor = (i) => SERIES_COLORS[i] ?? SERIES_FALLBACK
export const seriesDash = (i) => (i < SERIES_DASHES.length ? SERIES_DASHES[i] : '1 2') ?? undefined

/** A short line sample in a run's colour and dash pattern (legend, tooltip, saved-runs table). */
export function RunSwatch({ index }) {
  const dash = seriesDash(index)
  return (
    <svg className="run-swatch" width="24" height="8" viewBox="0 0 24 8" aria-hidden="true" focusable="false">
      <line
        x1="2" x2="22" y1="4" y2="4"
        stroke={seriesColor(index)}
        strokeWidth="2.5"
        strokeDasharray={dash}
        strokeLinecap={index === 4 ? 'round' : 'butt'}
      />
    </svg>
  )
}

const MARGIN = { top: 14, right: 16, bottom: 44, left: 48 }
// compact: no y axis, no axis titles, three x ticks (used in the results card)
const MARGIN_COMPACT = { top: 6, right: 8, bottom: 22, left: 8 }

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

function thin(ticks, count) {
  if (ticks.length <= count) return ticks
  const out = []
  for (let i = 0; i < count; i += 1) out.push(ticks[Math.round((i * (ticks.length - 1)) / (count - 1))])
  return out
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
 *  height – chart height in px (default 260)
 *  compact – 3 x ticks, no axis titles and no y axis (for the small card chart)
 *  tone    – 'light' (page surface) or 'dark' (glass card)
 *  markers – [{ value, label }] vertical reference lines in raw units (e.g. Dv10/Dv50/Dv90)
 */
export default function HistogramChart({
  data, stats = [], scale = 1, unit = 'mm', xLabel = 'Particle diameter', yLabel = 'Fraction of particles',
  height = 260, compact = false, tone = 'light', markers = [],
}) {
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(compact ? 300 : 560)
  const [hover, setHover] = useState(null)
  const HEIGHT = height
  const MARGINS = compact ? MARGIN_COMPACT : MARGIN

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const geom = useMemo(() => {
    if (!data?.edges?.length) return null
    const { edges, series, x_log: xLog } = data
    const innerW = width - MARGINS.left - MARGINS.right
    const innerH = HEIGHT - MARGINS.top - MARGINS.bottom
    const lo = edges[0]
    const hi = edges[edges.length - 1]
    const t = xLog ? (v) => Math.log10(v) : (v) => v
    const x = (v) => MARGINS.left + ((t(v) - t(lo)) / (t(hi) - t(lo))) * innerW
    const yMax = Math.max(1e-9, ...series.flatMap((s) => s.fractions.map((f) => f ?? 0))) * 1.08
    const yTicks = niceLinearTicks(0, yMax, 4)
    const yTop = Math.max(yMax, yTicks[yTicks.length - 1])
    const y = (v) => MARGINS.top + innerH - (v / yTop) * innerH
    let xTicks = (xLog ? logTicks(lo * scale, hi * scale) : niceLinearTicks(lo * scale, hi * scale, compact ? 3 : 6))
    if (compact) xTicks = thin(xTicks, 3)
    xTicks = xTicks.map((v) => v / scale)
    return { edges, series, xLog, x, y, innerW, innerH, yTicks, xTicks, baseY: MARGINS.top + innerH }
  }, [data, width, scale, HEIGHT, MARGINS, compact])

  if (!geom) return null
  const { edges, series, x, y, yTicks, xTicks, baseY } = geom
  const multi = series.length > 1

  const first = stats[0]
  const hasBand = first && Number.isFinite(first.p16) && Number.isFinite(first.p84)
  const mark = (markers || []).filter((m) => Number.isFinite(m?.value) && m.value >= edges[0] && m.value <= edges[edges.length - 1])
  const lastTick = xTicks[xTicks.length - 1]

  return (
    <div className={`histogram-chart tone-${tone} ${compact ? 'compact' : ''}`} ref={wrapRef}>
      {multi && (
        <div className="histogram-legend">
          {series.map((s, i) => (
            <span key={s.label} className="histogram-legend-item">
              <RunSwatch index={i} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg width={width} height={HEIGHT} role="img" aria-label={`${xLabel} histogram`} onMouseLeave={() => setHover(null)}>
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line className="hc-grid" x1={MARGINS.left} x2={width - MARGINS.right} y1={y(v)} y2={y(v)} />
            {!compact && (
              <text className="hc-tick" x={MARGINS.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {`${+(v * 100).toPrecision(3)}%`}
              </text>
            )}
          </g>
        ))}
        {xTicks.map((v) => (
          <text
            key={`x${v}`}
            className="hc-tick"
            x={x(v)}
            y={baseY + (compact ? 15 : 16)}
            textAnchor={compact ? (v === xTicks[0] ? 'start' : v === lastTick ? 'end' : 'middle') : 'middle'}
          >
            {fmt(v * scale)}
          </text>
        ))}
        <line className="hc-axis" x1={MARGINS.left} x2={width - MARGINS.right} y1={baseY} y2={baseY} />

        {/* the 16th–84th percentile spread of the first series (descriptive, not an error bar) */}
        {hasBand && (
          <rect className="hc-band" x={x(first.p16)} width={Math.max(0, x(first.p84) - x(first.p16))} y={MARGINS.top} height={baseY - MARGINS.top} />
        )}

        {series.map((s, si) => {
          const color = seriesColor(si)
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
                  className={`hc-bar ${multi ? '' : 'hc-bar-main'} ${hover?.bin === bi ? 'hover' : ''}`}
                  fill={multi ? color : undefined}
                  d={`M${x0},${baseY} V${baseY - h + r} Q${x0},${baseY - h} ${x0 + r},${baseY - h} H${x0 + w - r} Q${x0 + w},${baseY - h} ${x0 + w},${baseY - h + r} V${baseY} Z`}
                />
              )
            })
          }
          let d = `M${x(edges[0])},${baseY}`
          s.fractions.forEach((f, bi) => { d += ` V${y(f ?? 0)} H${x(edges[bi + 1])}` })
          d += ` V${baseY}`
          return (
            <path
              key={`s${si}`}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap={si === 4 ? 'round' : 'butt'}
              strokeDasharray={seriesDash(si)}
            />
          )
        })}

        {stats.map((st, si) => (
          <g key={`m${si}`}>
            {Number.isFinite(st.mean) && <line className="hc-mean" x1={x(st.mean)} x2={x(st.mean)} y1={MARGINS.top} y2={baseY} stroke={multi ? seriesColor(si) : undefined} />}
            {!multi && Number.isFinite(st.median) && <line className="hc-median" x1={x(st.median)} x2={x(st.median)} y1={MARGINS.top} y2={baseY} />}
          </g>
        ))}

        {mark.map((m, mi) => {
          const px = x(m.value)
          const anchor = px > width - MARGINS.right - 70 ? 'end' : 'start'
          return (
            <g key={`k${mi}`} className="hc-marker">
              <line x1={px} x2={px} y1={compact ? MARGINS.top : MARGINS.top + 12} y2={baseY} />
              {!compact && m.label && (
                <text className="hc-marker-label" x={px + (anchor === 'end' ? -5 : 5)} y={MARGINS.top + 8} textAnchor={anchor}>{m.label}</text>
              )}
            </g>
          )
        })}

        {/* hover hit targets: full-height column per bin */}
        {edges.slice(0, -1).map((e, bi) => (
          <rect
            key={`h${bi}`}
            x={x(e)}
            width={Math.max(1, x(edges[bi + 1]) - x(e))}
            y={MARGINS.top}
            height={baseY - MARGINS.top}
            fill="transparent"
            onMouseEnter={() => setHover({ bin: bi })}
          />
        ))}

        {!compact && (
          <>
            <text className="hc-label" x={MARGINS.left + geom.innerW / 2} y={HEIGHT - 6} textAnchor="middle">{`${xLabel} (${unit})`}</text>
            <text className="hc-label" transform={`translate(12 ${MARGINS.top + geom.innerH / 2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>
          </>
        )}
      </svg>

      {hover && (
        <div
          className="hc-tooltip"
          style={{ left: Math.min(Math.max(x((edges[hover.bin] + edges[hover.bin + 1]) / 2), 80), width - 80) }}
        >
          <strong>{fmt(edges[hover.bin] * scale)}–{fmt(edges[hover.bin + 1] * scale)} {unit}</strong>
          {series.map((s, si) => (
            <span key={s.label}>
              {multi && <RunSwatch index={si} />}
              {multi ? `${s.label}: ` : ''}{((s.fractions[hover.bin] ?? 0) * 100).toFixed(1)}%
            </span>
          ))}
        </div>
      )}

      {!compact && (
        <div className="histogram-key">
          <span><i className="key-mean" />Mean</span>
          {!multi && Number.isFinite(first?.median) && <span><i className="key-median" />Median</span>}
          {hasBand && <span><i className="key-band" />16th–84th percentile spread</span>}
        </div>
      )}
    </div>
  )
}
