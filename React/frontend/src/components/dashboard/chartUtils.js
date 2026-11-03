import { useLayoutEffect, useRef, useState } from 'react'

export const TILE_SIZE = 256

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

export function average(values, fallback) {
  const finite = values.filter((value) => Number.isFinite(value))
  if (!finite.length) return fallback
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return Number(value).toFixed(digits)
}

export function formatPercent(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(Number(value) * 100).toFixed(digits)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-05-01" -> "May 1" (no timezone shifts: parsed by hand). */
export function formatShortDate(value) {
  if (typeof value !== 'string') return value ?? ''
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return value
  return `${MONTHS[Number(match[2]) - 1] ?? ''} ${Number(match[3])}`
}

export function formatLongDate(value) {
  if (typeof value !== 'string') return ''
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return value
  return `${MONTHS[Number(match[2]) - 1] ?? ''} ${Number(match[3])}, ${match[1]}`
}

/** Round-number ticks (1/2/5 x 10^k steps) inside [min, max]; labels share one decimal count. */
export function niceTicks(min, max, count = 5, { integer = false } = {}) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return [{ value: min, label: String(min) }]
  }
  const rawStep = (max - min) / Math.max(count - 1, 1)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  let step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
  if (integer) step = Math.max(1, Math.round(step))
  const decimals = integer ? 0 : Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
  const first = Math.ceil(min / step - 1e-9) * step
  const ticks = []
  for (let value = first; value <= max + step * 1e-9; value += step) {
    const rounded = Number(value.toFixed(decimals + 2))
    ticks.push({ value: rounded, label: (Object.is(rounded, -0) ? 0 : rounded).toFixed(decimals) })
  }
  return ticks
}

export function paddedExtent(values) {
  if (!values.length) return [0, 1]
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [min - 1, max + 1]
  const padding = (max - min) * 0.1
  return [min - padding, max + padding]
}

export function clampExtentAroundAnchor(min, max, fullMin, fullMax, factor, anchor, edge = 'min', minSpan = 0.5) {
  const span = Math.max((max - min) * factor, minSpan)
  let nextMin = anchor - ((anchor - min) / (max - min || 1)) * span
  let nextMax = nextMin + span
  if (nextMin < fullMin) {
    nextMin = fullMin
    nextMax = nextMin + span
  }
  if (nextMax > fullMax) {
    nextMax = fullMax
    nextMin = nextMax - span
  }
  if (span >= (fullMax - fullMin)) {
    nextMin = fullMin
    nextMax = fullMax
  }
  return edge === 'max' ? nextMax : nextMin
}

export function clampRange(value, span, min, max, edge = 'min', minSpan = 0.5) {
  const safeSpan = Math.max(span, minSpan)
  let nextMin = edge === 'max' ? value - safeSpan : value
  let nextMax = nextMin + safeSpan
  if (nextMin < min) {
    nextMin = min
    nextMax = nextMin + safeSpan
  }
  if (nextMax > max) {
    nextMax = max
    nextMin = nextMax - safeSpan
  }
  return edge === 'max' ? nextMax : nextMin
}

export function buildTooltipState(event, payload) {
  return {
    ...payload,
    viewportX: event.clientX + 12,
    viewportY: event.clientY - 12,
  }
}

/** Measured content width of an element (ResizeObserver). Height is derived by callers. */
export function useElementWidth(ref) {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const update = (next) => setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : Math.round(next)))
    update(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return width
}

export function chartHeight(width) {
  return Math.round(clamp(width * 0.55, 220, 340))
}

export function useNonPassiveWheel(targetRef, handler) {
  const handlerRef = useRef(handler)
  useLayoutEffect(() => {
    handlerRef.current = handler
  })
  useLayoutEffect(() => {
    const target = targetRef.current
    if (!target) return undefined
    const listener = (event) => handlerRef.current(event)
    target.addEventListener('wheel', listener, { passive: false })
    return () => target.removeEventListener('wheel', listener)
  }, [targetRef])
}

export function wrapLongitude(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180
}

export function lngLatToWorld(lng, lat, zoom) {
  const scale = TILE_SIZE * (2 ** zoom)
  const sinLat = Math.sin((clamp(lat, -85, 85) * Math.PI) / 180)
  return {
    x: ((wrapLongitude(lng) + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  }
}

export function worldToLngLat(x, y, zoom) {
  const scale = TILE_SIZE * (2 ** zoom)
  const lng = (x / scale) * 360 - 180
  const n = Math.PI - (2 * Math.PI * y) / scale
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lng: wrapLongitude(lng), lat }
}

export function getVisibleTiles(topLeft, width, height, zoom) {
  const tileZoom = Math.max(0, Math.floor(zoom))
  const scaleFactor = 2 ** (zoom - tileZoom)
  const tilesPerSide = 2 ** tileZoom
  const tileTopLeft = { x: topLeft.x / scaleFactor, y: topLeft.y / scaleFactor }
  const scaledTileSize = TILE_SIZE * scaleFactor
  const minX = Math.floor(tileTopLeft.x / TILE_SIZE)
  const maxX = Math.floor((tileTopLeft.x + width / scaleFactor) / TILE_SIZE)
  const minY = Math.floor(tileTopLeft.y / TILE_SIZE)
  const maxY = Math.floor((tileTopLeft.y + height / scaleFactor) / TILE_SIZE)
  const tiles = []

  for (let tileX = minX; tileX <= maxX; tileX += 1) {
    for (let tileY = minY; tileY <= maxY; tileY += 1) {
      if (tileY < 0 || tileY >= tilesPerSide) continue
      const wrappedX = ((tileX % tilesPerSide) + tilesPerSide) % tilesPerSide
      tiles.push({
        // unwrapped tileX in the key: at low zoom the world repeats and wrapped keys collide
        key: `${tileZoom}-${tileX}-${tileY}`,
        x: wrappedX,
        y: tileY,
        z: tileZoom,
        left: (tileX * TILE_SIZE - tileTopLeft.x) * scaleFactor,
        top: (tileY * TILE_SIZE - tileTopLeft.y) * scaleFactor,
        size: scaledTileSize,
      })
    }
  }
  return tiles
}
