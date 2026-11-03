import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  average,
  buildTooltipState,
  chartHeight,
  clamp,
  clampExtentAroundAnchor,
  clampRange,
  formatPercent,
  getVisibleTiles,
  lngLatToWorld,
  niceTicks,
  paddedExtent,
  useElementWidth,
  useNonPassiveWheel,
  worldToLngLat,
  wrapLongitude,
} from './chartUtils'
import { PanelActionsContext } from './ui'

const MARGIN = { top: 18, right: 18, bottom: 44, left: 52 }

/* ---- shared pieces --------------------------------------------------- */

export function ChartTooltip({ hovered }) {
  const lines = Array.isArray(hovered.lines) ? hovered.lines : [hovered.content]
  const flip = hovered.viewportX > window.innerWidth * 0.6
  return createPortal(
    <div
      className={`dashboard-chart-tooltip ${flip ? 'flip' : ''}`}
      data-testid="chart-tooltip"
      style={{ left: `${hovered.viewportX}px`, top: `${hovered.viewportY}px` }}
    >
      <div className="dashboard-chart-tooltip-title">{lines[0]}</div>
      {lines[1] && <div className="dashboard-chart-tooltip-detail">{lines[1]}</div>}
    </div>,
    document.body,
  )
}

function ChartControls({ onZoomIn, onZoomOut, onReset, zoomed }) {
  const slot = useContext(PanelActionsContext)
  const node = (
    <div className="dashboard-chart-controls" data-testid="chart-controls" role="group" aria-label="Chart zoom">
      <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 7h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      {zoomed && (
        <button type="button" onClick={onReset} aria-label="Reset zoom" title="Reset zoom" data-testid="chart-reset">
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 7a4.5 4.5 0 1 0 1.5-3.3M2.5 2.2v2.6h2.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
    </div>
  )
  return slot ? createPortal(node, slot) : node
}

/** One legend for every series: toggle buttons with a swatch, fixed order. */
export function LegendToggles({ items, hidden, onToggle, testId }) {
  return (
    <div className="dashboard-legend" data-testid={testId} role="group" aria-label="Series">
      {items.map((item) => {
        const pressed = !hidden.has(item.key)
        return (
          <button
            key={item.key}
            type="button"
            className="dashboard-legend-toggle"
            aria-pressed={pressed}
            data-testid={`legend-${item.key}`}
            onClick={() => onToggle(item.key)}
          >
            <span
              className={`dashboard-legend-swatch ${item.hollow ? 'hollow' : ''}`}
              style={item.hollow ? { borderColor: item.color } : { background: item.color }}
            />
            <span className="dashboard-legend-text">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function StaticLegend({ items }) {
  return (
    <div className="dashboard-legend static" data-testid="chart-legend-static">
      {items.map((item) => (
        <span key={item.label} className="dashboard-legend-item">
          <span className={`dashboard-legend-line ${item.faint ? 'faint' : ''}`} style={{ background: item.color, height: item.height }} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

function ChartAxes({ width, height, margin, xTicks, yTicks, scaleX, scaleY, xLabel, yLabel }) {
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const baseY = margin.top + plotHeight
  return (
    <g className="dashboard-axes">
      {yTicks.map((tick) => (
        <line key={`g-${tick.label}`} x1={margin.left} x2={margin.left + plotWidth} y1={scaleY(tick.value)} y2={scaleY(tick.value)} className="dashboard-grid-line" />
      ))}
      <line x1={margin.left} x2={margin.left + plotWidth} y1={baseY} y2={baseY} className="dashboard-axis-line" />
      <line x1={margin.left} x2={margin.left} y1={margin.top} y2={baseY} className="dashboard-axis-line" />
      {xTicks.map((tick) => (
        <g key={`x-${tick.label}-${tick.value}`}>
          <line x1={scaleX(tick.value)} x2={scaleX(tick.value)} y1={baseY} y2={baseY + 4} className="dashboard-axis-line" />
          <text x={scaleX(tick.value)} y={baseY + 17} textAnchor="middle" className="dashboard-axis-text" data-axis="x">{tick.label}</text>
        </g>
      ))}
      {yTicks.map((tick) => (
        <g key={`y-${tick.label}`}>
          <line x1={margin.left - 4} x2={margin.left} y1={scaleY(tick.value)} y2={scaleY(tick.value)} className="dashboard-axis-line" />
          <text x={margin.left - 8} y={scaleY(tick.value) + 4} textAnchor="end" className="dashboard-axis-text" data-axis="y">{tick.label}</text>
        </g>
      ))}
      <text x={margin.left + plotWidth / 2} y={height - 5} textAnchor="middle" className="dashboard-axis-label">{xLabel}</text>
      <text x={12} y={margin.top + plotHeight / 2} transform={`rotate(-90 12 ${margin.top + plotHeight / 2})`} textAnchor="middle" className="dashboard-axis-label">{yLabel}</text>
    </g>
  )
}

function TargetBand({ band, scaleX, scaleY, orientation, margin, plotWidth, plotHeight, view, label }) {
  if (!band) return null
  let rect
  if (orientation === 'x') {
    const x1 = scaleX(clamp(band.low, view.minX, view.maxX))
    const x2 = scaleX(clamp(band.high, view.minX, view.maxX))
    if (x2 - x1 < 1) return null
    rect = { x: x1, y: margin.top, width: x2 - x1, height: plotHeight }
  } else {
    const y1 = scaleY(clamp(band.high, view.minY, view.maxY))
    const y2 = scaleY(clamp(band.low, view.minY, view.maxY))
    if (y2 - y1 < 1) return null
    rect = { x: margin.left, y: y1, width: plotWidth, height: y2 - y1 }
  }
  return (
    <g>
      <rect {...rect} className="dashboard-target-band" data-testid="target-band" />
      <text x={rect.x + 6} y={Math.max(rect.y, margin.top) + 13} className="dashboard-band-label">{label}</text>
    </g>
  )
}

/* ---- zoomable cartesian chart state ---------------------------------- */

function useZoomView({ full, plotWidth, plotHeight, shellRef, anchorFromEvent, minSpanX: minSpanXOption, resetKey }) {
  const minSpanX = minSpanXOption ?? (full.maxX - full.minX) / 10
  const minSpanY = (full.maxY - full.minY) / 10
  const [view, setView] = useState(null)
  const dragRef = useRef(null)
  const current = view ?? full
  const currentRef = useRef(current)
  currentRef.current = current

  useEffect(() => { setView(null) }, [resetKey])

  const zoom = (factor, anchor) => {
    const base = currentRef.current
    const a = anchor ?? { x: (base.minX + base.maxX) / 2, y: (base.minY + base.maxY) / 2 }
    const next = {
      minX: clampExtentAroundAnchor(base.minX, base.maxX, full.minX, full.maxX, factor, a.x, 'min', minSpanX),
      maxX: clampExtentAroundAnchor(base.minX, base.maxX, full.minX, full.maxX, factor, a.x, 'max', minSpanX),
      minY: clampExtentAroundAnchor(base.minY, base.maxY, full.minY, full.maxY, factor, a.y, 'min', minSpanY),
      maxY: clampExtentAroundAnchor(base.minY, base.maxY, full.minY, full.maxY, factor, a.y, 'max', minSpanY),
    }
    const isFull = next.minX === full.minX && next.maxX === full.maxX && next.minY === full.minY && next.maxY === full.maxY
    setView(isFull ? null : next)
  }

  useNonPassiveWheel(shellRef, (event) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = shellRef.current.getBoundingClientRect()
    const base = currentRef.current
    const relX = clamp((event.clientX - rect.left - MARGIN.left) / plotWidth, 0, 1)
    const relY = clamp((event.clientY - rect.top - MARGIN.top) / plotHeight, 0, 1)
    zoom(event.deltaY < 0 ? 0.92 : 1.08, {
      x: base.minX + relX * (base.maxX - base.minX),
      y: base.maxY - relY * (base.maxY - base.minY),
    })
  })

  const onMouseDown = () => {
    if (!view) return
    dragRef.current = { view: currentRef.current }
  }

  useEffect(() => {
    const handleMove = (event) => {
      const drag = dragRef.current
      if (!drag) return
      const base = drag.view
      const xSpan = base.maxX - base.minX
      const ySpan = base.maxY - base.minY
      const xDelta = (event.movementX / plotWidth) * xSpan
      const yDelta = (event.movementY / plotHeight) * ySpan
      const next = {
        minX: clampRange(base.minX - xDelta, xSpan, full.minX, full.maxX, 'min', minSpanX),
        maxX: clampRange(base.maxX - xDelta, xSpan, full.minX, full.maxX, 'max', minSpanX),
        minY: clampRange(base.minY + yDelta, ySpan, full.minY, full.maxY, 'min', minSpanY),
        maxY: clampRange(base.maxY + yDelta, ySpan, full.minY, full.maxY, 'max', minSpanY),
      }
      drag.view = next
      setView(next)
    }
    const handleUp = () => { dragRef.current = null }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [full.minX, full.maxX, full.minY, full.maxY, plotWidth, plotHeight, minSpanX, minSpanY])

  return { view: current, zoomed: view !== null, zoom, reset: () => setView(null), onMouseDown }
}

const EMPTY = <div className="dashboard-empty-state">No chart data yet.</div>

/* ---- scatter --------------------------------------------------------- */

export function ScatterChart(props) {
  if (!props.data.length) return EMPTY
  return <ScatterChartInner {...props} />
}

function ScatterChartInner({
  data, xKey, yKey, colorKey, series, hidden, onToggle, xLabel, yLabel, band, bandLabel, tooltip, testId,
}) {
  const [hovered, setHovered] = useState(null)
  const shellRef = useRef(null)
  const width = useElementWidth(shellRef)
  const height = chartHeight(width)
  const plotWidth = width - MARGIN.left - MARGIN.right
  const plotHeight = height - MARGIN.top - MARGIN.bottom

  const full = useMemo(() => {
    const [minX, maxX] = paddedExtent(data.map((row) => Number(row[xKey])).filter(Number.isFinite))
    const [minY, maxY] = paddedExtent(data.map((row) => Number(row[yKey])).filter(Number.isFinite))
    return { minX, maxX, minY, maxY }
  }, [data, xKey, yKey])

  const { view, zoomed, zoom, reset, onMouseDown } = useZoomView({
    full, plotWidth, plotHeight, shellRef, resetKey: data.length,
  })

  const scaleX = (v) => MARGIN.left + ((v - view.minX) / (view.maxX - view.minX || 1)) * plotWidth
  const scaleY = (v) => MARGIN.top + plotHeight - ((v - view.minY) / (view.maxY - view.minY || 1)) * plotHeight
  const seriesByKey = useMemo(() => Object.fromEntries(series.map((item) => [item.key, item])), [series])

  const points = useMemo(() => {
    const visible = data
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !hidden.has(row[colorKey]))
    // hollow ("Other") series draws last so it never hides a coloured point
    return [...visible.filter(({ row }) => !seriesByKey[row[colorKey]]?.hollow), ...visible.filter(({ row }) => seriesByKey[row[colorKey]]?.hollow)]
  }, [data, hidden, colorKey, seriesByKey])

  const xTicks = width ? niceTicks(view.minX, view.maxX, plotWidth < 300 ? 4 : 6) : []
  const yTicks = width ? niceTicks(view.minY, view.maxY, 5) : []

  return (
    <div className="dashboard-chart-block" data-testid={testId}>
      {series.length > 1 && <LegendToggles items={series} hidden={hidden} onToggle={onToggle} testId={`${testId}-legend`} />}
      <div ref={shellRef} className="dashboard-chart-shell" onMouseLeave={() => setHovered(null)} onMouseDown={onMouseDown}>
        <ChartControls onZoomIn={() => zoom(0.92)} onZoomOut={() => zoom(1.08)} onReset={reset} zoomed={zoomed} />
        {width > 0 && (
          <svg className="dashboard-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
            <ChartAxes width={width} height={height} margin={MARGIN} xTicks={xTicks} yTicks={yTicks} scaleX={scaleX} scaleY={scaleY} xLabel={xLabel} yLabel={yLabel} />
            <TargetBand band={band} orientation="x" scaleX={scaleX} scaleY={scaleY} margin={MARGIN} plotWidth={plotWidth} plotHeight={plotHeight} view={view} label={bandLabel} />
            {hovered && (
              <g className="dashboard-hover-layer">
                <line x1={scaleX(Number(hovered.row[xKey]))} x2={scaleX(Number(hovered.row[xKey]))} y1={MARGIN.top} y2={MARGIN.top + plotHeight} className="dashboard-chart-hover-line" />
                <line x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={scaleY(Number(hovered.row[yKey]))} y2={scaleY(Number(hovered.row[yKey]))} className="dashboard-chart-hover-line" />
              </g>
            )}
            {points.map(({ row, index }) => {
              const xValue = Number(row[xKey])
              const yValue = Number(row[yKey])
              if (xValue < view.minX || xValue > view.maxX || yValue < view.minY || yValue > view.maxY) return null
              const item = seriesByKey[row[colorKey]]
              const color = item?.color ?? '#a3968a'
              const isActive = hovered?.index === index
              const show = (event) => setHovered(buildTooltipState(event, { row, index, lines: tooltip(row) }))
              return (
                <circle
                  key={index}
                  cx={scaleX(xValue)}
                  cy={scaleY(yValue)}
                  r={isActive ? 6 : 4}
                  fill={item?.hollow ? 'var(--surface)' : color}
                  stroke={item?.hollow ? color : 'var(--surface)'}
                  strokeWidth={item?.hollow ? 1.5 : 1}
                  opacity={0.85}
                  className="dashboard-chart-point"
                  data-series={row[colorKey]}
                  onMouseEnter={show}
                  onMouseMove={show}
                />
              )
            })}
          </svg>
        )}
        {hovered && <ChartTooltip hovered={hovered} />}
      </div>
    </div>
  )
}

/* ---- line ------------------------------------------------------------ */

export function LineChart(props) {
  if (!props.data.length) return EMPTY
  return <LineChartInner {...props} />
}

function rollingMean(values, windowSize) {
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - windowSize + 1), index + 1).filter(Number.isFinite)
    return index < 2 || !slice.length ? null : slice.reduce((a, b) => a + b, 0) / slice.length
  })
}

function LineChartInner({ data, xKey, yKey, xLabel, yLabel, tickKey, tickFormat, tooltip, rolling = false, band, bandLabel, testId, height: fixedHeight }) {
  const [hovered, setHovered] = useState(null)
  const shellRef = useRef(null)
  const width = useElementWidth(shellRef)
  const height = fixedHeight ?? chartHeight(width)
  const plotWidth = width - MARGIN.left - MARGIN.right
  const plotHeight = height - MARGIN.top - MARGIN.bottom

  const full = useMemo(() => {
    const [minY, maxY] = paddedExtent(data.map((row) => Number(row[yKey])).filter(Number.isFinite))
    return { minX: 0, maxX: Math.max(data.length - 1, 1), minY, maxY }
  }, [data, yKey])

  const { view, zoomed, zoom, reset, onMouseDown } = useZoomView({
    full, plotWidth, plotHeight, shellRef, minSpanX: 2, resetKey: data.length,
  })
  const scaleX = (v) => MARGIN.left + ((v - view.minX) / (view.maxX - view.minX || 1)) * plotWidth
  const scaleY = (v) => MARGIN.top + plotHeight - ((v - view.minY) / (view.maxY - view.minY || 1)) * plotHeight

  const yValues = data.map((row) => Number(row[yKey]))
  const means = rolling ? rollingMean(yValues, 7) : []
  const toPath = (values) => values
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) => Number.isFinite(value) && index >= Math.floor(view.minX) - 1 && index <= Math.ceil(view.maxX) + 1)
    .map(({ value, index }, i) => `${i === 0 ? 'M' : 'L'}${scaleX(index).toFixed(1)} ${scaleY(value).toFixed(1)}`)
    .join(' ')

  const labelAt = (index) => {
    const row = data[clamp(Math.round(index), 0, data.length - 1)]
    const raw = row?.[tickKey ?? xKey]
    return tickFormat ? tickFormat(raw) : String(raw ?? '')
  }
  const xTicks = width
    ? niceTicks(view.minX, view.maxX, plotWidth < 300 ? 4 : 6, { integer: true }).map((tick) => ({ value: tick.value, label: labelAt(tick.value) }))
    : []
  const yTicks = width ? niceTicks(view.minY, view.maxY, 5) : []

  const hitPoints = data
    .map((row, index) => ({ row, index }))
    .filter(({ index, row }) => index >= view.minX && index <= view.maxX && Number(row[yKey]) >= view.minY && Number(row[yKey]) <= view.maxY)

  return (
    <div className="dashboard-chart-block" data-testid={testId}>
      {rolling && (
        <StaticLegend items={[
          { label: 'Shot', color: 'var(--faint)', height: 1.5, faint: true },
          { label: '7-shot average', color: 'var(--el-shotlog)', height: 2.5 },
        ]}
        />
      )}
      <div ref={shellRef} className="dashboard-chart-shell" onMouseLeave={() => setHovered(null)} onMouseDown={onMouseDown}>
        <ChartControls onZoomIn={() => zoom(0.92)} onZoomOut={() => zoom(1.08)} onReset={reset} zoomed={zoomed} />
        {width > 0 && (
          <svg className="dashboard-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
            <ChartAxes width={width} height={height} margin={MARGIN} xTicks={xTicks} yTicks={yTicks} scaleX={scaleX} scaleY={scaleY} xLabel={xLabel} yLabel={yLabel} />
            <TargetBand band={band} orientation="y" scaleX={scaleX} scaleY={scaleY} margin={MARGIN} plotWidth={plotWidth} plotHeight={plotHeight} view={view} label={bandLabel} />
            {hovered && (
              <line x1={scaleX(hovered.index)} x2={scaleX(hovered.index)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} className="dashboard-chart-hover-line" />
            )}
            {rolling ? (
              <>
                <path d={toPath(yValues)} className="dashboard-line-raw" />
                <path d={toPath(means)} className="dashboard-line-path" />
              </>
            ) : (
              <path d={toPath(yValues)} className="dashboard-line-path" />
            )}
            {hitPoints.map(({ row, index }) => {
              const isActive = hovered?.index === index
              const show = (event) => setHovered(buildTooltipState(event, { row, index, lines: tooltip(row) }))
              return (
                <circle
                  key={index}
                  cx={scaleX(index)}
                  cy={scaleY(Number(row[yKey]))}
                  r={rolling ? (isActive ? 5 : 8) : (isActive ? 5.5 : 4)}
                  className={`dashboard-chart-point ${rolling ? 'hit' : 'dot'} ${isActive ? 'active' : ''}`}
                  onMouseEnter={show}
                  onMouseMove={show}
                />
              )
            })}
          </svg>
        )}
        {hovered && <ChartTooltip hovered={hovered} />}
      </div>
    </div>
  )
}

/* ---- bars (HTML rows, no clipped labels) ----------------------------- */

export function BarChart({ data }) {
  const [hovered, setHovered] = useState(null)
  if (!data.length) {
    return <div className="dashboard-empty-state">Not enough repeated coffees to rank target-window leaders yet.</div>
  }
  return (
    <div className="dashboard-bar-list" data-testid="bar-chart" onMouseLeave={() => setHovered(null)}>
      {data.map((row, index) => {
        const label = row['Coffee Label']
        const rate = Number(row.target_hit_rate) || 0
        const show = (event) => setHovered(buildTooltipState(event, {
          index,
          lines: [label, `Hit rate ${formatPercent(rate)} · avg rating ${Number(row.avg_rating ?? 0).toFixed(2)} / 2`],
        }))
        return (
          <div key={label} className="dashboard-bar-row" onMouseEnter={show} onMouseMove={show}>
            <span className="dashboard-bar-label" title={label}>{label}</span>
            <span className="dashboard-bar-track"><span className="dashboard-bar-fill" style={{ width: `${Math.max(rate * 100, 1)}%` }} /></span>
            <span className="dashboard-bar-value">{formatPercent(rate)}</span>
          </div>
        )
      })}
      {hovered && <ChartTooltip hovered={hovered} />}
    </div>
  )
}

/* ---- map -------------------------------------------------------------- */

export function GeoScatterPlot({ points, series, hidden, onToggle }) {
  if (!points.length) {
    return <div className="dashboard-empty-state">Add latitude and longitude to map coffee origins.</div>
  }
  return <GeoScatterPlotInner points={points} series={series} hidden={hidden} onToggle={onToggle} />
}

function GeoScatterPlotInner({ points, series, hidden, onToggle }) {
  const [hovered, setHovered] = useState(null)
  const [view, setView] = useState({ centerLat: 12, centerLng: 0, zoom: 1 })
  const shellRef = useRef(null)
  const dragRef = useRef(null)
  const measured = useElementWidth(shellRef)
  const width = Math.max(measured, 1)
  const height = measured < 480 ? 300 : 360
  const centerWorld = lngLatToWorld(view.centerLng, view.centerLat, view.zoom)
  const topLeft = { x: centerWorld.x - width / 2, y: centerWorld.y - height / 2 }
  const tiles = getVisibleTiles(topLeft, width, height, view.zoom)
  const colors = useMemo(() => Object.fromEntries(series.map((item) => [item.key, item])), [series])

  const home = () => ({
    centerLat: average(points.map((point) => Number(point.lat)), 12),
    centerLng: average(points.map((point) => Number(point.long)), 0),
    zoom: 1,
  })
  useEffect(() => { setView(home()) }, [points]) // eslint-disable-line react-hooks/exhaustive-deps

  const zoomMap = (delta, anchorPoint = { x: width / 2, y: height / 2 }) => {
    setView((prev) => {
      const nextZoom = clamp(prev.zoom + delta, 1, 6)
      const before = lngLatToWorld(prev.centerLng, prev.centerLat, prev.zoom)
      const anchorWorldX = before.x - width / 2 + anchorPoint.x
      const anchorWorldY = before.y - height / 2 + anchorPoint.y
      const scale = 2 ** (nextZoom - prev.zoom)
      const nextCenter = worldToLngLat(
        anchorWorldX * scale - anchorPoint.x + width / 2,
        anchorWorldY * scale - anchorPoint.y + height / 2,
        nextZoom,
      )
      return { centerLng: nextCenter.lng, centerLat: clamp(nextCenter.lat, -85, 85), zoom: nextZoom }
    })
  }

  useNonPassiveWheel(shellRef, (event) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = shellRef.current.getBoundingClientRect()
    const zoomDelta = clamp(-event.deltaY * 0.00275, -0.35, 0.35)
    if (zoomDelta) zoomMap(zoomDelta, { x: event.clientX - rect.left, y: event.clientY - rect.top })
  })

  useEffect(() => {
    const handleMove = (event) => {
      if (!dragRef.current) return
      const drag = dragRef.current
      const startWorld = lngLatToWorld(drag.view.centerLng, drag.view.centerLat, drag.view.zoom)
      const next = worldToLngLat(startWorld.x - (event.clientX - drag.startX), startWorld.y - (event.clientY - drag.startY), drag.view.zoom)
      setView({ centerLng: wrapLongitude(next.lng), centerLat: clamp(next.lat, -85, 85), zoom: drag.view.zoom })
    }
    const handleUp = () => { dragRef.current = null }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  const visiblePoints = points.filter((point) => !hidden.has(point.continent))
  const zoomed = view.zoom !== 1

  return (
    <div className="dashboard-chart-block" data-testid="origins-map">
      {series.length > 1 && <LegendToggles items={series} hidden={hidden} onToggle={onToggle} testId="map-legend" />}
      <div ref={shellRef} className="dashboard-chart-shell">
        <ChartControls onZoomIn={() => zoomMap(0.6)} onZoomOut={() => zoomMap(-0.6)} onReset={() => setView(home())} zoomed={zoomed} />
        <div
          className="dashboard-map-shell"
          style={{ height: `${height}px` }}
          onMouseLeave={() => setHovered(null)}
          onMouseDown={(event) => { dragRef.current = { startX: event.clientX, startY: event.clientY, view } }}
        >
          <div className="dashboard-map-tiles" style={{ width: `${width}px`, height: `${height}px` }}>
            {measured > 0 && tiles.map((tile) => (
              <img
                key={tile.key}
                src={`https://tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`}
                alt=""
                className="dashboard-map-tile"
                draggable="false"
                onError={(event) => { event.currentTarget.style.visibility = 'hidden' }}
                style={{ left: `${tile.left}px`, top: `${tile.top}px`, width: `${tile.size}px`, height: `${tile.size}px` }}
              />
            ))}
            {visiblePoints.map((point, index) => {
              const world = lngLatToWorld(Number(point.long), Number(point.lat), view.zoom)
              const x = world.x - topLeft.x
              const y = world.y - topLeft.y
              if (x < -20 || x > width + 20 || y < -20 || y > height + 20) return null
              const item = colors[point.continent]
              const show = (event) => setHovered(buildTooltipState(event, {
                index,
                lines: [`${point.roaster ?? '—'} · ${point.region ?? '—'}`, `${point.continent_name ?? point.continent} · ${point.date}`],
              }))
              return (
                <button
                  key={`${index}-${point.lat}-${point.long}-${point.date}`}
                  type="button"
                  aria-label={`${point.roaster ?? ''} ${point.region ?? ''}`}
                  className={`dashboard-map-marker ${item?.hollow ? 'hollow' : ''} ${hovered?.index === index ? 'active' : ''}`}
                  style={{ left: `${x}px`, top: `${y}px`, '--marker': item?.color ?? '#a3968a' }}
                  onMouseEnter={show}
                  onMouseMove={show}
                />
              )
            })}
          </div>
          <div className="dashboard-map-attribution">Map data © OpenStreetMap contributors</div>
        </div>
        {hovered && <ChartTooltip hovered={hovered} />}
      </div>
    </div>
  )
}
