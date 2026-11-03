import { useRef, useState } from 'react'
import { MAX_INDEX, indexToSetting, settingToSize } from '../../grindCalibration'
import { RATING_COLORS } from '../../dashboardData'
import { clamp, niceTicks, useElementWidth } from '../dashboard/chartUtils'
import './pages.css'

/* All charts are inline SVG with class "el-chart"; every text is >= 11px and uses ink tokens
   (colour lives on the marks, never on the text). Each chart has a hover tooltip. */

const lin = (d0, d1, r0, r1) => {
  const span = d1 - d0 || 1
  return (v) => r0 + ((v - d0) / span) * (r1 - r0)
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/** Shared frame: measures its width, owns the tooltip state, renders the svg. */
function Frame({ height, margin, ariaLabel, testId, children, onLeave, tip, summary }) {
  const ref = useRef(null)
  const width = useElementWidth(ref)
  const w = Math.max(width, 0)
  const flip = tip && tip.x > w * 0.58
  return (
    <div className="el-chart-wrap" ref={ref} data-testid={testId} style={{ height }}>
      {w > 0 ? (
        <svg
          className="el-chart"
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          role="img"
          aria-label={ariaLabel}
          onPointerLeave={onLeave}
          onPointerCancel={onLeave}
        >
          {summary ? <desc>{summary}</desc> : null}
          {children(w, margin)}
        </svg>
      ) : null}
      {tip ? (
        <div className={`el-chart-tip${flip ? ' flip' : ''}`} style={{ left: tip.x, top: tip.y }} aria-hidden="true">
          <b>{tip.title}</b>
          {tip.detail ? <span>{tip.detail}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function YAxis({ ticks, y, left, right, format = (t) => t.label, unit }) {
  return (
    <g className="el-axis">
      {ticks.map((t) => (
        <g key={t.value}>
          <line className="el-grid" x1={left} x2={right} y1={y(t.value)} y2={y(t.value)} />
          <text x={left - 8} y={y(t.value)} textAnchor="end" dominantBaseline="central">{format(t)}</text>
        </g>
      ))}
      {unit ? <text className="el-axis-title" x={left} y={10} textAnchor="start">{unit}</text> : null}
    </g>
  )
}

export function ChartLegend({ items, testId }) {
  return (
    <ul className="el-legend" data-testid={testId}>
      {items.map((it) => (
        <li key={it.label}>
          <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true" className="el-legend-mark">
            {it.type === 'line' ? <line x1="1" x2="15" y1="6" y2="6" className={it.cls} strokeWidth="2" strokeLinecap="round" /> : null}
            {it.type === 'dash' ? <line x1="1" x2="15" y1="6" y2="6" className={it.cls} strokeWidth="2" strokeDasharray="3 3" /> : null}
            {it.type === 'band' ? <rect x="1" y="1" width="14" height="10" rx="2" className={it.cls} /> : null}
            {it.type === 'dot' ? <circle cx="8" cy="6" r="4.5" className={it.cls} /> : null}
            {it.type === 'ring' ? <circle cx="8" cy="6" r="4" className={it.cls} fill="none" strokeWidth="1.6" /> : null}
            {it.type === 'diamond' ? <path d="M8 1 L13 6 L8 11 L3 6 Z" className={it.cls} /> : null}
          </svg>
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  )
}

function xTicksForIndex(lo, hi, step = 27) {
  const out = []
  for (let i = Math.ceil(lo / step) * step; i <= hi; i += step) out.push(i)
  return out
}

/* ------------------------------------------------------------------ */
/* Grinder: setting vs particle size                                    */
/* ------------------------------------------------------------------ */

export function CalibrationChart({ points = [], model, height = 300, compact = false, testId = 'cal-chart', metricLabel = 'Mean' }) {
  const [tip, setTip] = useState(null)
  const [hoverX, setHoverX] = useState(null)
  const m = compact ? { l: 40, r: 10, t: 10, b: 28 } : { l: 52, r: 14, t: 14, b: 40 }

  const xs = points.map((p) => p.x).filter(finite)
  const curve = model && (model.kind === 'curve' || model.kind === 'median') ? model : null
  let lo = xs.length ? Math.min(...xs) - 18 : 0
  let hi = xs.length ? Math.max(...xs) + 18 : MAX_INDEX
  if (curve && finite(curve.xMin)) {
    lo = Math.min(lo, curve.xMin - 9)
    hi = Math.max(hi, curve.xMax + 9)
  }
  lo = Math.max(0, Math.floor(lo))
  hi = Math.min(MAX_INDEX, Math.ceil(hi))
  if (hi - lo < 36) hi = Math.min(MAX_INDEX, lo + 36)

  const samples = []
  if (curve) {
    const steps = 80
    for (let i = 0; i <= steps; i += 1) {
      const x = lo + ((hi - lo) * i) / steps
      const s = estimateFromModel(model, x)
      if (s) samples.push({ x, ...s })
    }
  }
  const ys = [
    ...points.map((p) => p.um),
    ...samples.flatMap((s) => [s.low, s.high]),
  ].filter(finite)
  const yMin0 = ys.length ? Math.min(...ys) : 200
  const yMax0 = ys.length ? Math.max(...ys) : 1000
  const pad = (yMax0 - yMin0) * 0.08 || 50
  const ticks = niceTicks(Math.max(0, yMin0 - pad), yMax0 + pad, compact ? 4 : 5, { integer: true })
  const yLo = Math.min(ticks[0]?.value ?? 0, Math.max(0, yMin0 - pad))
  const yHi = Math.max(ticks[ticks.length - 1]?.value ?? 1, yMax0 + pad)

  const onMove = (e, rect, w) => {
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const x = lin(m.l, w - m.r, lo, hi)
    const sx = lin(lo, hi, m.l, w - m.r)
    const sy = lin(yLo, yHi, height - m.b, m.t)
    let best = null
    let bestD = 18
    for (const p of points) {
      const d = Math.hypot(sx(p.x) - px, sy(p.um) - py)
      if (d < bestD) { best = p; bestD = d }
    }
    if (best) {
      setHoverX(best.x)
      setTip({
        x: sx(best.x),
        y: sy(best.um),
        title: `${best.setting} · ${Math.round(best.um)} µm`,
        detail: `${best.source === 'photo' ? 'Analyzer photo' : 'Shot log'}${best.coffee ? ` · ${best.coffee}` : ''}${best.excluded ? ' · excluded' : ''}`,
      })
      return
    }
    if (px < m.l || px > w - m.r || !samples.length) { setTip(null); setHoverX(null); return }
    const xv = clamp(x(px), lo, hi)
    const s = estimateFromModel(model, xv)
    setHoverX(xv)
    if (s) {
      setTip({
        x: px,
        y: Math.max(sy(s.um), m.t + 6),
        title: `${indexToSetting(xv)} · ≈ ${Math.round(s.um)} µm`,
        detail: finite(s.low) && finite(s.high)
          ? `likely ${Math.round(s.low)}–${Math.round(s.high)} µm${s.extrapolated ? ' · outside your settings' : ''}`
          : 'median of your points',
      })
    }
  }

  const leave = () => { setTip(null); setHoverX(null) }

  return (
    <Frame
      height={height}
      margin={m}
      testId={testId}
      ariaLabel={`Grind setting versus particle size, ${points.length} points`}
      tip={tip}
      onLeave={leave}
    >
      {(w) => {
        const sx = lin(lo, hi, m.l, w - m.r)
        const sy = lin(yLo, yHi, height - m.b, m.t)
        const upper = samples.map((s) => `${sx(s.x).toFixed(1)},${sy(s.high).toFixed(1)}`)
        const lower = samples.map((s) => `${sx(s.x).toFixed(1)},${sy(s.low).toFixed(1)}`).reverse()
        const line = samples.map((s, i) => `${i ? 'L' : 'M'}${sx(s.x).toFixed(1)},${sy(s.um).toFixed(1)}`).join(' ')
        const xt = xTicksForIndex(lo, hi, compact ? 54 : 27)
        const showRange = model && model.kind === 'curve' && finite(model.xMin) && model.xMax > model.xMin
        return (
          <>
            <YAxis ticks={ticks} y={sy} left={m.l} right={w - m.r} unit={compact ? undefined : 'µm'} />
            <g className="el-axis">
              {xt.map((i) => (
                <text key={i} x={sx(i)} y={height - m.b + 16} textAnchor="middle">{indexToSetting(i)}</text>
              ))}
              {!compact ? (
                <text className="el-axis-title" x={(m.l + w - m.r) / 2} y={height - 4} textAnchor="middle">Grind setting, finer to coarser</text>
              ) : null}
            </g>
            {showRange ? (
              <g>
                <rect className="el-range" x={sx(model.xMin)} y={m.t} width={Math.max(0, sx(model.xMax) - sx(model.xMin))} height={height - m.b - m.t} />
                {!compact ? <text className="el-axis" x={sx(model.xMin) + 6} y={m.t + 12}>Calibrated range</text> : null}
              </g>
            ) : null}
            {samples.length > 1 && model.kind === 'curve' ? <polygon className="el-band" points={[...upper, ...lower].join(' ')} /> : null}
            {samples.length > 1 ? <path className={model.kind === 'curve' ? 'el-curve' : 'el-curve is-dashed'} d={line} /> : null}
            {hoverX != null ? <line className="el-hover-line" x1={sx(hoverX)} x2={sx(hoverX)} y1={m.t} y2={height - m.b} /> : null}
            {points.map((p) => {
              const cx = sx(p.x)
              const cy = sy(p.um)
              if (p.excluded) return <circle key={p.id} className="el-pt-excluded" cx={cx} cy={cy} r={4.5} />
              if (p.source === 'photo') return <circle key={p.id} className="el-pt-photo" cx={cx} cy={cy} r={5.5} />
              return <path key={p.id} className="el-pt-shot" d={`M${cx},${cy - 6} L${cx + 6},${cy} L${cx},${cy + 6} L${cx - 6},${cy} Z`} />
            })}
            <rect
              x={0}
              y={0}
              width={w}
              height={height}
              fill="transparent"
              onPointerMove={(e) => onMove(e, e.currentTarget.getBoundingClientRect(), w)}
            />
          </>
        )
      }}
    </Frame>
  )
}

function estimateFromModel(model, x) {
  try { return model ? settingToSize(model, x) : null } catch { return null }
}

/* ------------------------------------------------------------------ */
/* Forecast: extraction across grind settings                          */
/* ------------------------------------------------------------------ */

export function SweepChart({ sweep = [], currentIndex = null, height = 260, compact = false, testId = 'forecast-curve', target = [18, 22] }) {
  const [tip, setTip] = useState(null)
  const [hoverI, setHoverI] = useState(null)
  const m = compact ? { l: 40, r: 10, t: 10, b: 26 } : { l: 48, r: 14, t: 12, b: 30 }
  const rows = sweep.filter((r) => finite(r.extraction))
  const xLo = rows.length ? rows[0].index : 0
  const xHi = rows.length ? rows[rows.length - 1].index : 1
  const all = [...rows.flatMap((r) => [r.extraction, r.low, r.high]).filter(finite), target[0], target[1]]
  const yLo = Math.floor(Math.min(...all) - 0.5)
  const yHi = Math.ceil(Math.max(...all) + 0.5)
  const ticks = niceTicks(yLo, yHi, 7, { integer: true })

  const move = (e, rect, w) => {
    const sx = lin(xLo, xHi, m.l, w - m.r)
    const sy = lin(yLo, yHi, height - m.b, m.t)
    const px = e.clientX - rect.left
    let best = null
    let bd = Infinity
    rows.forEach((r, i) => {
      const d = Math.abs(sx(r.index) - px)
      if (d < bd) { best = { r, i }; bd = d }
    })
    if (!best) return
    const r = best.r
    setHoverI(best.i)
    setTip({
      x: sx(r.index),
      y: sy(r.extraction),
      title: `${r.setting}${finite(r.um) ? ` · ≈ ${Math.round(r.um)} µm (est.)` : ''}`,
      detail: `${r.extraction.toFixed(1)}%${finite(r.low) && finite(r.high) ? ` (likely ${r.low.toFixed(1)}–${r.high.toFixed(1)}%)` : ''}`,
    })
  }
  const leave = () => { setTip(null); setHoverI(null) }

  return (
    <Frame height={height} margin={m} testId={testId} ariaLabel="Expected extraction across grind settings" tip={tip} onLeave={leave}>
      {(w) => {
        const sx = lin(xLo, xHi, m.l, w - m.r)
        const sy = lin(yLo, yHi, height - m.b, m.t)
        const hasBand = rows.length > 1 && rows.every((r) => finite(r.low) && finite(r.high))
        const line = rows.map((r, i) => `${i ? 'L' : 'M'}${sx(r.index).toFixed(1)},${sy(r.extraction).toFixed(1)}`).join(' ')
        const band = hasBand
          ? [...rows.map((r) => `${sx(r.index).toFixed(1)},${sy(r.high).toFixed(1)}`), ...rows.map((r) => `${sx(r.index).toFixed(1)},${sy(r.low).toFixed(1)}`).reverse()].join(' ')
          : null
        const cur = finite(currentIndex) ? rows.reduce((a, r) => (Math.abs(r.index - currentIndex) < Math.abs((a?.index ?? 1e9) - currentIndex) ? r : a), null) : null
        return (
          <>
            <YAxis ticks={ticks} y={sy} left={m.l} right={w - m.r} format={(t) => `${t.label}%`} />
            <rect className="el-target" x={m.l} width={w - m.l - m.r} y={sy(target[1])} height={Math.max(0, sy(target[0]) - sy(target[1]))} />
            <g className="el-axis">
              <text x={m.l} y={height - 6} textAnchor="start">{rows[0]?.setting ?? ''} finer</text>
              <text x={w - m.r} y={height - 6} textAnchor="end">{rows[rows.length - 1]?.setting ?? ''} coarser</text>
            </g>
            {band ? <polygon className="el-band is-accent" points={band} /> : null}
            {rows.length > 1 ? <path className="el-curve is-accent" d={line} /> : null}
            {cur ? (
              <g>
                <line className="el-marker-line" x1={sx(cur.index)} x2={sx(cur.index)} y1={m.t} y2={height - m.b} />
                <circle className="el-marker-dot" cx={sx(cur.index)} cy={sy(cur.extraction)} r={5.5} />
              </g>
            ) : null}
            {hoverI != null && rows[hoverI] ? (
              <g>
                <line className="el-hover-line" x1={sx(rows[hoverI].index)} x2={sx(rows[hoverI].index)} y1={m.t} y2={height - m.b} />
                <circle className="el-hover-dot" cx={sx(rows[hoverI].index)} cy={sy(rows[hoverI].extraction)} r={4} />
              </g>
            ) : null}
            <rect x={0} y={0} width={w} height={height} fill="transparent" onPointerMove={(e) => move(e, e.currentTarget.getBoundingClientRect(), w)} />
          </>
        )
      }}
    </Frame>
  )
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                          */
/* ------------------------------------------------------------------ */

export function PredActualChart({ points = [], height = 240, testId = 'diag-scatter-chart', within = 1 }) {
  const [tip, setTip] = useState(null)
  const m = { l: 36, r: 12, t: 10, b: 36 }
  const vals = points.flatMap((p) => [p.predicted, p.actual]).filter(finite)
  const lo = vals.length ? Math.min(...vals) - 1 : 17
  const hi = vals.length ? Math.max(...vals) + 1 : 23
  const d0 = Math.floor(lo)
  const d1 = Math.ceil(hi)
  const ticks = niceTicks(d0, d1, 4, { integer: true })
  const leave = () => setTip(null)
  return (
    <Frame height={height} margin={m} testId={testId} ariaLabel="Predicted versus actual extraction, one dot per past shot" tip={tip} onLeave={leave}>
      {(w) => {
        const sx = lin(d0, d1, m.l, w - m.r)
        const sy = lin(d0, d1, height - m.b, m.t)
        const band = `${sx(d0)},${sy(d0 + within)} ${sx(d1 - within)},${sy(d1)} ${sx(d1)},${sy(d1)} ${sx(d1)},${sy(d1 - within)} ${sx(d0 + within)},${sy(d0)} ${sx(d0)},${sy(d0)}`
        return (
          <>
            <YAxis ticks={ticks} y={sy} left={m.l} right={w - m.r} format={(t) => t.label} />
            <g className="el-axis">
              {ticks.map((t) => <text key={t.value} x={sx(t.value)} y={height - m.b + 15} textAnchor="middle">{t.label}</text>)}
              <text className="el-axis-title" x={(m.l + w - m.r) / 2} y={height - 3} textAnchor="middle">Predicted extraction (%)</text>
            </g>
            <polygon className="el-band" points={band} />
            <line className="el-diagonal" x1={sx(d0)} y1={sy(d0)} x2={sx(d1)} y2={sy(d1)} />
            {points.map((p) => {
              const hit = Math.abs(p.actual - p.predicted) <= within
              return (
                <g key={p.id}>
                  <circle className={hit ? 'el-pt-photo' : 'el-pt-miss'} cx={sx(p.predicted)} cy={sy(p.actual)} r={4.5} />
                  <circle
                    cx={sx(p.predicted)}
                    cy={sy(p.actual)}
                    r={12}
                    fill="transparent"
                    onPointerEnter={() => setTip({ x: sx(p.predicted), y: sy(p.actual), title: p.date, detail: `Predicted ${p.predicted.toFixed(1)}% · actual ${p.actual.toFixed(1)}%` })}
                  />
                </g>
              )
            })}
          </>
        )
      }}
    </Frame>
  )
}

export function ErrorTimeChart({ points = [], baselineMae, firstHalfMae, lastHalfMae, halfSize = 0, height = 220, testId = 'diag-error-time-chart' }) {
  const [tip, setTip] = useState(null)
  const m = { l: 40, r: 10, t: 10, b: 30 }
  const maxErr = Math.max(...points.map((p) => p.absError).filter(finite), baselineMae || 0, 0.5)
  const yHi = maxErr * 1.1
  const ticks = niceTicks(0, yHi, 4)
  return (
    <Frame height={height} margin={m} testId={testId} ariaLabel="Absolute forecast error for each past shot" tip={tip} onLeave={() => setTip(null)}>
      {(w) => {
        const n = Math.max(points.length, 1)
        const step = (w - m.l - m.r) / n
        const bw = Math.max(1.5, Math.min(14, step - 2))
        const sy = lin(0, yHi, height - m.b, m.t)
        const bx = (i) => m.l + step * i + step / 2
        return (
          <>
            <YAxis ticks={ticks} y={sy} left={m.l} right={w - m.r} format={(t) => `${t.label}%`} />
            <g className="el-axis">
              {points.length ? <text x={bx(0)} y={height - m.b + 15} textAnchor="start">Shot {points[0].order + 1}</text> : null}
              {points.length > 2 ? <text x={bx(Math.floor(n / 2))} y={height - m.b + 15} textAnchor="middle">Shot {points[Math.floor(n / 2)].order + 1}</text> : null}
              {points.length > 1 ? <text x={bx(n - 1)} y={height - m.b + 15} textAnchor="end">Shot {points[n - 1].order + 1}</text> : null}
            </g>
            {points.map((p, i) => {
              const h = Math.max(0, height - m.b - sy(p.absError))
              return (
                <g key={p.id}>
                  <rect className="el-bar" x={bx(i) - bw / 2} y={height - m.b - h} width={bw} height={h} rx={Math.min(3, bw / 2)} />
                  <rect
                    x={bx(i) - step / 2}
                    y={m.t}
                    width={step}
                    height={height - m.b - m.t}
                    fill="transparent"
                    onPointerEnter={() => setTip({ x: bx(i), y: sy(p.absError), title: `Shot ${p.order + 1} · ${p.date}`, detail: `Missed by ${p.absError.toFixed(2)}%` })}
                  />
                </g>
              )
            })}
            {finite(baselineMae) ? <line className="el-baseline" x1={m.l} x2={w - m.r} y1={sy(baselineMae)} y2={sy(baselineMae)} /> : null}
            {finite(firstHalfMae) && halfSize > 0 ? <line className="el-avg-first" x1={bx(0) - step / 2} x2={bx(halfSize - 1) + step / 2} y1={sy(firstHalfMae)} y2={sy(firstHalfMae)} /> : null}
            {finite(lastHalfMae) && halfSize > 0 ? <line className="el-avg-last" x1={bx(n - halfSize) - step / 2} x2={bx(n - 1) + step / 2} y1={sy(lastHalfMae)} y2={sy(lastHalfMae)} /> : null}
          </>
        )
      }}
    </Frame>
  )
}

export function RatingCalChart({ bins = [], height = 240, testId = 'diag-rating-cal-chart' }) {
  const [tip, setTip] = useState(null)
  const m = { l: 36, r: 14, t: 10, b: 38 }
  const ticks = [0, 25, 50, 75, 100].map((v) => ({ value: v, label: String(v) }))
  const maxCount = Math.max(...bins.map((b) => b.count), 1)
  return (
    <Frame height={height} margin={m} testId={testId} ariaLabel="Rating calibration: said chance of Great versus how often Great came true" tip={tip} onLeave={() => setTip(null)}>
      {(w) => {
        const sx = lin(0, 100, m.l, w - m.r)
        const sy = lin(0, 100, height - m.b, m.t)
        const pts = bins.map((b) => ({ ...b, px: sx(b.predicted * 100), py: sy(b.observed * 100) }))
        return (
          <>
            <YAxis ticks={ticks} y={sy} left={m.l} right={w - m.r} />
            <g className="el-axis">
              {ticks.map((t) => <text key={t.value} x={sx(t.value)} y={height - m.b + 15} textAnchor="middle">{t.label}</text>)}
              <text className="el-axis-title" x={(m.l + w - m.r) / 2} y={height - 3} textAnchor="middle">Said: chance of Great (%)</text>
            </g>
            <line className="el-diagonal" x1={sx(0)} y1={sy(0)} x2={sx(100)} y2={sy(100)} />
            {pts.length > 1 ? <path className="el-curve is-great" d={pts.map((p, i) => `${i ? 'L' : 'M'}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(' ')} /> : null}
            {pts.map((p) => (
              <g key={`${p.lo}-${p.hi}`}>
                <circle className="el-pt-great" cx={p.px} cy={p.py} r={4 + 6 * Math.sqrt(p.count / maxCount)} />
                <circle
                  cx={p.px}
                  cy={p.py}
                  r={14}
                  fill="transparent"
                  onPointerEnter={() => setTip({
                    x: p.px,
                    y: p.py,
                    title: `Said ${Math.round(p.predicted * 100)}% Great`,
                    detail: `${Math.round(p.observed * 100)}% came true (${Math.round(p.observed * p.count)} of ${p.count})`,
                  })}
                />
              </g>
            ))}
          </>
        )
      }}
    </Frame>
  )
}

/** Grinder fit residuals: each point's % deviation from the fitted curve. */
export function FitResidualChart({ points = [], model, height = 160, testId = 'diag-grinder-chart' }) {
  const [tip, setTip] = useState(null)
  const m = { l: 40, r: 10, t: 8, b: 28 }
  const rows = points
    .map((p) => {
      const est = estimateFromModel(model, p.x)
      return est && finite(est.um) ? { ...p, pct: (p.um / est.um - 1) * 100 } : null
    })
    .filter(Boolean)
  const scatter = finite(model?.scatterPct) ? model.scatterPct : 0
  const maxAbs = Math.max(10, scatter, ...rows.map((r) => Math.abs(r.pct)))
  const lim = Math.ceil(maxAbs / 5) * 5
  const xs = rows.map((r) => r.x)
  const lo = xs.length ? Math.min(...xs) - 4 : 0
  const hi = xs.length ? Math.max(...xs) + 4 : 36
  const ticks = [-lim, 0, lim].map((v) => ({ value: v, label: `${v > 0 ? '+' : ''}${v}%` }))
  return (
    <Frame height={height} margin={m} testId={testId} ariaLabel="Each calibration point's distance from the fitted curve" tip={tip} onLeave={() => setTip(null)}>
      {(w) => {
        const sx = lin(lo, hi, m.l, w - m.r)
        const sy = lin(-lim, lim, height - m.b, m.t)
        const xt = xTicksForIndex(lo, hi, hi - lo <= 54 ? 9 : hi - lo <= 108 ? 18 : 27)
        return (
          <>
            <YAxis ticks={ticks} y={sy} left={m.l} right={w - m.r} />
            <g className="el-axis">
              {xt.map((i) => <text key={i} x={sx(i)} y={height - m.b + 15} textAnchor="middle">{indexToSetting(i)}</text>)}
            </g>
            {scatter > 0 ? <rect className="el-band" x={m.l} width={w - m.l - m.r} y={sy(scatter)} height={Math.max(0, sy(-scatter) - sy(scatter))} /> : null}
            <line className="el-zero" x1={m.l} x2={w - m.r} y1={sy(0)} y2={sy(0)} />
            {rows.map((r) => (
              <g key={r.id}>
                <circle className={r.excluded ? 'el-pt-excluded' : 'el-pt-photo'} cx={sx(r.x)} cy={sy(clamp(r.pct, -lim, lim))} r={4.5} />
                <circle
                  cx={sx(r.x)}
                  cy={sy(clamp(r.pct, -lim, lim))}
                  r={12}
                  fill="transparent"
                  onPointerEnter={() => setTip({ x: sx(r.x), y: sy(clamp(r.pct, -lim, lim)), title: `${r.setting} · ${Math.round(r.um)} µm`, detail: `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}% vs curve` })}
                />
              </g>
            ))}
          </>
        )
      }}
    </Frame>
  )
}

/* ------------------------------------------------------------------ */
/* Small HTML marks                                                     */
/* ------------------------------------------------------------------ */

/** Stacked Bad / Good / Great bar with 2px gaps. probs = {bad, good, great} in 0..1 */
export function OddsBar({ probs, testId }) {
  if (!probs) return null
  const segs = [
    { k: 'bad', label: 'Bad', v: probs.bad, color: RATING_COLORS.Bad },
    { k: 'good', label: 'Good', v: probs.good, color: RATING_COLORS.Good },
    { k: 'great', label: 'Great', v: probs.great, color: RATING_COLORS.Great },
  ]
  return (
    <div className="el-odds" data-testid={testId}>
      <div className="el-odds-bar" aria-hidden="true">
        {segs.map((s) => (s.v > 0.004 ? <i key={s.k} style={{ flexGrow: s.v, background: s.color }} /> : null))}
      </div>
      <p className="el-odds-text">
        {segs.map((s) => (
          <span key={s.k}><span className="el-dot" style={{ background: s.color }} aria-hidden="true" />{s.label} {Math.round(s.v * 100)}%</span>
        ))}
      </p>
    </div>
  )
}

/** Horizontal meter: value / max, optional second (lighter) segment. */
export function Meter({ value, max = 1, extra = 0, tone = 'accent', label }) {
  const pct = (v) => `${clamp((v / (max || 1)) * 100, 0, 100)}%`
  return (
    <div className="el-meter" role="img" aria-label={label}>
      <i className={`el-meter-fill is-${tone}`} style={{ width: pct(value) }} />
      {extra > 0 ? <i className="el-meter-fill is-soft" style={{ left: pct(value), width: pct(extra) }} /> : null}
    </div>
  )
}
