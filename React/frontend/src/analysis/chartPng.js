// Histogram PNG for the "Download" buttons, drawn with the 2D canvas (the server used
// matplotlib). Input is the /histogram or /histogram/compare response shape:
//   { series: { edges, series: [{label, fractions}], x_log }, scale, unit, axis_label,
//     mean, median, ... }                         (single run)
//   { ..., per_run: [{label, mean, median, ...}] }  (compare)
// Returns base64 (no data: prefix), as histogram_b64 does.

const WIDTH = 1600
const HEIGHT = 960
const MARGIN = { top: 56, right: 56, bottom: 130, left: 150 }
const COLORS = ['#2c7bb6', '#2f7d4a', '#9c5a14', '#7b3294', '#008837', '#e66101']
const INK = '#222222'
const GRID = '#dddddd'

/** matplotlib mathtext ($\mu$m, $\mathrm{mm}^2$) -> plain text. */
export function plainLabel(text) {
  return String(text ?? '')
    .replace(/\$\\mu\$/g, 'µ')
    .replace(/\\mu/g, 'µ')
    .replace(/\\mathrm\{([^}]*)\}/g, '$1')
    .replace(/\^2/g, '²')
    .replace(/\$/g, '')
}

function niceTicks(min, max, count = 6) {
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
  return ticks.length >= 2 ? ticks : niceTicks(min, max, 4)
}

function fmtTick(v) {
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '')
  return String(+v.toPrecision(2))
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  throw new Error('No canvas available to draw the chart.')
}

function toBase64Png(canvas) {
  if (typeof canvas.toDataURL === 'function') return canvas.toDataURL('image/png').split(',')[1]
  throw new Error('Could not encode the chart.')
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * @param {object} data  the histogram / compare response
 * @returns {string} base64 PNG
 */
export function renderChartPng(data) {
  const series = data?.series
  const edges = series?.edges
  if (!Array.isArray(edges) || edges.length < 2 || !Array.isArray(series.series)) {
    throw new Error('Nothing to draw: the histogram has no bins.')
  }
  const scale = isNum(data.scale) && data.scale > 0 ? data.scale : 1
  const xLog = series.x_log !== false
  const xLabel = plainLabel(data.axis_label || `Particle diameter (${plainLabel(data.unit || 'mm')})`)
  const runs = series.series
  const entries = Array.isArray(data.per_run) && data.per_run.length
    ? data.per_run
    : [{ label: runs[0]?.label, mean: data.mean, median: data.median }]

  const canvas = makeCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  const px0 = MARGIN.left
  const px1 = WIDTH - MARGIN.right
  const py0 = MARGIN.top
  const py1 = HEIGHT - MARGIN.bottom
  const xmin = edges[0]
  const xmax = edges[edges.length - 1]
  const tx = xLog
    ? (v) => px0 + ((Math.log10(Math.max(v, xmin)) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin) || 1)) * (px1 - px0)
    : (v) => px0 + ((v - xmin) / (xmax - xmin || 1)) * (px1 - px0)

  let ymax = 0
  for (const s of runs) for (const f of s.fractions ?? []) if (isNum(f) && f > ymax) ymax = f
  ymax = (ymax || 1) * 1.08
  const ty = (v) => py1 - (v / ymax) * (py1 - py0)

  ctx.font = '26px sans-serif'
  ctx.textBaseline = 'middle'

  // grid + y axis
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1.5
  ctx.fillStyle = INK
  ctx.textAlign = 'right'
  for (const t of niceTicks(0, ymax, 6)) {
    const y = ty(t)
    ctx.beginPath()
    ctx.moveTo(px0, y)
    ctx.lineTo(px1, y)
    ctx.stroke()
    ctx.fillText(fmtTick(t), px0 - 14, y)
  }

  // x ticks
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const xt = (xLog ? logTicks(xmin, xmax) : niceTicks(xmin, xmax, 7))
  for (const t of xt) {
    const x = tx(t)
    ctx.strokeStyle = GRID
    ctx.beginPath()
    ctx.moveTo(x, py0)
    ctx.lineTo(x, py1)
    ctx.stroke()
    ctx.fillStyle = INK
    ctx.fillText(fmtTick(t * scale), x, py1 + 12)
  }

  // bars (filled, translucent) with a solid outline per run
  runs.forEach((s, k) => {
    const color = COLORS[k % COLORS.length]
    const fr = s.fractions ?? []
    ctx.fillStyle = `${color}${runs.length > 1 ? '55' : '99'}`
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    for (let i = 0; i < fr.length; i += 1) {
      if (!isNum(fr[i]) || fr[i] <= 0) continue
      const xa = tx(edges[i])
      const xb = tx(edges[i + 1])
      ctx.fillRect(xa, ty(fr[i]), Math.max(1, xb - xa), py1 - ty(fr[i]))
      if (runs.length > 1) {
        ctx.strokeRect(xa, ty(fr[i]), Math.max(1, xb - xa), py1 - ty(fr[i]))
      }
    }
  })

  // mean (solid) and median (dashed) lines
  entries.forEach((e, k) => {
    const color = COLORS[k % COLORS.length]
    for (const [key, dash] of [['mean', []], ['median', [14, 10]]]) {
      const v = e?.[key]
      if (!isNum(v) || v < xmin || v > xmax) continue
      ctx.strokeStyle = color
      ctx.lineWidth = 3
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.moveTo(tx(v), py0)
      ctx.lineTo(tx(v), py1)
      ctx.stroke()
    }
  })
  ctx.setLineDash([])

  // frame + labels
  ctx.strokeStyle = INK
  ctx.lineWidth = 2
  ctx.strokeRect(px0, py0, px1 - px0, py1 - py0)
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.font = '30px sans-serif'
  ctx.fillText(xLabel, (px0 + px1) / 2, py1 + 58)
  ctx.save()
  ctx.translate(46, (py0 + py1) / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textBaseline = 'middle'
  ctx.fillText('Fraction of particles', 0, 0)
  ctx.restore()

  // legend (top right inside the frame)
  ctx.font = '26px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const unitText = plainLabel(data.unit || '')
  let ly = py0 + 28
  entries.forEach((e, k) => {
    const color = COLORS[k % COLORS.length]
    const name = e?.label ? `${e.label}: ` : ''
    const parts = []
    if (isNum(e?.mean)) parts.push(`mean ${fmtTick(e.mean * scale)} ${unitText}`.trim())
    if (isNum(e?.median)) parts.push(`median ${fmtTick(e.median * scale)} ${unitText}`.trim())
    const text = `${name}${parts.join(', ')}`
    if (!text) return
    ctx.fillStyle = color
    ctx.fillRect(px1 - 560, ly - 9, 24, 18)
    ctx.fillStyle = INK
    ctx.fillText(text, px1 - 524, ly)
    ly += 38
  })

  return toBase64Png(canvas)
}
