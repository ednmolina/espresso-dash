import { useRef, useEffect, useCallback, useState } from 'react'

const POINT_RADIUS = 6
const MIN_ZOOM = 0.1
const MAX_ZOOM = 20
const ZOOM_SPEED = 0.001
const PINCH_MIN_DISTANCE = 8

/**
 * ImageCanvas
 *
 * Props:
 *   imageSrc        – base64 data URL of the image to display
 *   imageWidth      – original image width in pixels
 *   imageHeight     – original image height in pixels
 *   mode            – 'reference' | 'polygon' | 'erase' | 'view'
 *   referencePoints – [{x, y}, ...] in original image coords (max 2)
 *   polygonPoints   – [{x, y}, ...] in original image coords
 *   erasePoints     – [{x, y}, ...] in original image coords
 *   eraseRadius     – radius in original image pixels
 *   onPointAdded    – (x, y) => void  called with original-image coords on click
 *   layerB64        – optional transparent base64 PNG drawn over the image
 *   layerImage      – optional CanvasImageSource (ImageBitmap/canvas) drawn like layerB64;
 *                     the on-device engine passes this instead of a string
 *   pixelScale      – px per mm once the coin is measured (for the guide label)
 *   referenceMm     – physical size of the reference object
 *   onEraseRadiusChange – (r) => void  ([ and ] keys)
 *   onPolygonClose  – () => void  user clicked the first region point to close
 */

// Canvas drawing needs real colour strings (not CSS variables).
const COLORS = { scale: '#e5484d', region: '#2fa89a', clean: '#f08c2e' }
const HUD_FLASH_MS = 1200
export default function ImageCanvas({
  imageSrc,
  imageWidth,
  imageHeight,
  mode = 'view',
  referencePoints = [],
  polygonPoints = [],
  erasePoints = [],
  eraseRadius = 20,
  onPointAdded,
  layerB64,
  layerImage = null,
  pixelScale = null,
  referenceMm = 0,
  onEraseRadiusChange,
  onPolygonClose,
}) {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const overlayImgRef = useRef(null)

  // Viewport state: zoom level and pan offset (canvas pixels)
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 })
  // Canvas size in CSS pixels; the backing store is scaled by devicePixelRatio.
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 })
  const [, forceRedraw] = useState(0)
  const [zoomPct, setZoomPct] = useState(100)
  const [brushFlash, setBrushFlash] = useState(false)
  const hoverRef = useRef(null) // pointer position in canvas px, or null
  const fitZoomRef = useRef(1)
  const rafRef = useRef(0)
  const flashTimerRef = useRef(0)

  // Pointer gesture state
  const pointersRef = useRef(new Map())
  const gestureRef = useRef({ type: 'idle', moved: false })

  // -------------------------------------------------------------------------
  // Coordinate helpers
  // -------------------------------------------------------------------------

  /** Canvas pixel → original image pixel */
  const canvasToImage = useCallback((cx, cy) => {
    const { zoom, panX, panY } = viewRef.current
    return { x: (cx - panX) / zoom, y: (cy - panY) / zoom }
  }, [])

  /** Original image pixel → canvas pixel */
  const imageToCanvas = useCallback((ix, iy) => {
    const { zoom, panX, panY } = viewRef.current
    return { x: ix * zoom + panX, y: iy * zoom + panY }
  }, [])

  const zoomAroundPoint = useCallback((anchorX, anchorY, factor) => {
    const { zoom, panX, panY } = viewRef.current
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
    const newPanX = anchorX - (anchorX - panX) * (newZoom / zoom)
    const newPanY = anchorY - (anchorY - panY) * (newZoom / zoom)
    viewRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY }
    forceRedraw(n => n + 1)
  }, [])

  const zoomAboutCentre = useCallback((factor) => {
    const { width: W, height: H } = sizeRef.current
    zoomAroundPoint(W / 2, H / 2, factor)
  }, [zoomAroundPoint])

  const setZoomOneToOne = useCallback(() => {
    const { width: W, height: H } = sizeRef.current
    const { zoom } = viewRef.current
    zoomAroundPoint(W / 2, H / 2, 1 / zoom)
  }, [zoomAroundPoint])

  const updatePinchView = useCallback((center, anchorImage, zoom) => {
    viewRef.current = {
      zoom,
      panX: center.x - anchorImage.x * zoom,
      panY: center.y - anchorImage.y * zoom,
    }
    forceRedraw(n => n + 1)
  }, [])

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const { zoom, panX, panY } = viewRef.current
    const { width: W, height: H, dpr } = sizeRef.current

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.save()
    ctx.translate(panX, panY)
    ctx.scale(zoom, zoom)

    const img = imgRef.current
    if (img && img.complete) {
      ctx.imageSmoothingEnabled = zoom < 1
      ctx.drawImage(img, 0, 0, imageWidth, imageHeight)
    }
    // Overlay layer: keep its pixels crisp when zoomed in.
    const layer = overlayImgRef.current
    // <img> has `complete`; ImageBitmap and <canvas> are ready as soon as they exist.
    if (layer && layer.complete !== false) {
      ctx.imageSmoothingEnabled = false
      try {
        ctx.drawImage(layer, 0, 0, imageWidth, imageHeight)
      } catch {
        // a closed ImageBitmap (replaced result): skip until the new layer is set
      }
    }

    ctx.restore()

    // Draw overlays in canvas space (so points stay crisp at any zoom)
    _drawPolygon(ctx)
    _drawReferencePoints(ctx)
    _drawErasePoints(ctx)
    _drawBrushPreview(ctx)
  }, [imageWidth, imageHeight, referencePoints, polygonPoints, erasePoints, eraseRadius, mode, pixelScale, referenceMm])

  function _coinGuide(ctx, p1, p2, live) {
    const cx = (p1.x + p2.x) / 2
    const cy = (p1.y + p2.y) / 2
    const r = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2
    if (r < 2) return
    ctx.save()
    ctx.strokeStyle = COLORS.scale
    ctx.lineWidth = 1.5
    ctx.setLineDash(live ? [6, 4] : [])
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.lineWidth = live ? 1 : 2
    ctx.globalAlpha = live ? 0.6 : 1
    ctx.stroke()
    ctx.restore()

    if (!live && pixelScale) {
      const text = `${referenceMm} mm · ${pixelScale.toFixed(1)} px/mm`
      ctx.save()
      ctx.font = '600 12px Inter, sans-serif'
      const w = ctx.measureText(text).width + 16
      ctx.fillStyle = 'rgba(18,14,11,0.85)'
      ctx.strokeStyle = COLORS.scale
      ctx.lineWidth = 1
      const ly = w < r * 2 - 28 ? cy : cy + r + 18
      ctx.beginPath()
      ctx.roundRect(cx - w / 2, ly - 11, w, 22, 11)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#f1e8de'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, cx, ly + 0.5)
      ctx.restore()
    }
  }

  function _drawReferencePoints(ctx) {
    if (!referencePoints.length) return
    const pts = referencePoints.map(({ x, y }) => imageToCanvas(x, y))

    if (pts.length === 2) {
      _coinGuide(ctx, pts[0], pts[1], false)
    } else if (pts.length === 1 && mode === 'reference' && hoverRef.current) {
      _coinGuide(ctx, pts[0], hoverRef.current, true)
    }

    pts.forEach(({ x, y }, i) => {
      ctx.beginPath()
      ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = '#ffb000'
      ctx.fill()
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.fillStyle = '#111'
      ctx.font = 'bold 10px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(i + 1, x, y + 0.5)
    })
  }

  function _drawPolygon(ctx) {
    if (!polygonPoints.length) return
    const pts = polygonPoints.map(({ x, y }) => imageToCanvas(x, y))
    const editing = mode === 'polygon'
    const hover = editing ? hoverRef.current : null

    if (pts.length >= 3) {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      pts.slice(1).forEach(({ x, y }) => ctx.lineTo(x, y))
      ctx.closePath()
      ctx.fillStyle = 'rgba(47, 168, 154, 0.08)'
      ctx.fill()
    }

    ctx.strokeStyle = COLORS.region
    ctx.lineWidth = 2
    ctx.setLineDash([6, 3])
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    pts.slice(1).forEach(({ x, y }) => ctx.lineTo(x, y))
    if (pts.length >= 3 && !editing) ctx.closePath()
    ctx.stroke()

    if (editing) {
      const last = pts[pts.length - 1]
      ctx.globalAlpha = 0.4
      if (hover) {
        ctx.beginPath()
        ctx.moveTo(last.x, last.y)
        ctx.lineTo(hover.x, hover.y)
        ctx.stroke()
      }
      if (pts.length >= 3) {
        ctx.beginPath()
        ctx.moveTo(hover ? hover.x : last.x, hover ? hover.y : last.y)
        ctx.lineTo(pts[0].x, pts[0].y)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    ctx.setLineDash([])

    pts.forEach(({ x, y }, i) => {
      ctx.beginPath()
      ctx.arc(x, y, i === 0 && editing && pts.length >= 3 ? POINT_RADIUS + 2 : POINT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = COLORS.region
      ctx.fill()
      ctx.strokeStyle = '#083d3a'
      ctx.lineWidth = 1.5
      ctx.stroke()
    })
  }

  function _drawErasePoints(ctx) {
    if (!erasePoints.length) return
    const { zoom } = viewRef.current
    const radiusCanvas = eraseRadius * zoom

    erasePoints.forEach(({ x, y }) => {
      const c = imageToCanvas(x, y)
      ctx.beginPath()
      ctx.arc(c.x, c.y, radiusCanvas, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 140, 0, 0.15)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255, 140, 0, 0.8)'
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(c.x, c.y, POINT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = '#ff8c00'
      ctx.fill()
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 1.5
      ctx.stroke()
    })
  }

  function _drawBrushPreview(ctx) {
    const hover = hoverRef.current
    if (mode !== 'erase' || !hover) return
    const r = eraseRadius * viewRef.current.zoom
    ctx.save()
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.beginPath()
    ctx.arc(hover.x, hover.y, r + 0.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = 1
    ctx.strokeStyle = '#fff'
    ctx.beginPath()
    ctx.arc(hover.x, hover.y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // -------------------------------------------------------------------------
  // Fit image to canvas on first load
  // -------------------------------------------------------------------------

  const fitToCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageWidth || !imageHeight) return
    const { width: W, height: H } = sizeRef.current
    const scaleX = W / imageWidth
    const scaleY = H / imageHeight
    const zoom = Math.min(scaleX, scaleY, 1) // never upscale by default
    const panX = (W - imageWidth * zoom) / 2
    const panY = (H - imageHeight * zoom) / 2
    fitZoomRef.current = zoom
    viewRef.current = { zoom, panX, panY }
    forceRedraw(n => n + 1)
  }, [imageWidth, imageHeight])

  // -------------------------------------------------------------------------
  // Load images
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!imageSrc) return
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      fitToCanvas()
    }
    img.src = imageSrc
  }, [imageSrc, fitToCanvas])

  useEffect(() => {
    if (layerImage) {
      overlayImgRef.current = layerImage
      forceRedraw(n => n + 1)
      return
    }
    if (!layerB64) {
      overlayImgRef.current = null
      forceRedraw(n => n + 1)
      return
    }
    const img = new Image()
    img.onload = () => {
      overlayImgRef.current = img
      forceRedraw(n => n + 1)
    }
    img.src = `data:image/png;base64,${layerB64}`
  }, [layerB64, layerImage])

  // Redraw whenever anything changes
  useEffect(() => {
    draw()
    const pct = Math.round(viewRef.current.zoom * 100)
    setZoomPct((prev) => (prev === pct ? prev : pct))
  })

  // -------------------------------------------------------------------------
  // Resize canvas to fill its container
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const rect = canvas.parentElement.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { width: rect.width, height: rect.height, dpr }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      fitToCanvas()
    })
    ro.observe(canvas.parentElement)
    return () => ro.disconnect()
  }, [fitToCanvas])

  // -------------------------------------------------------------------------
  // Wheel — zoom toward cursor
  // -------------------------------------------------------------------------

  const onWheel = useCallback((e) => {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    const delta = e.deltaY * ZOOM_SPEED
    const factor = Math.exp(-delta)  // smooth multiplicative zoom
    zoomAroundPoint(mouseX, mouseY, factor)
  }, [zoomAroundPoint])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // -------------------------------------------------------------------------
  // Pointer gestures — drag to pan, tap to place point, pinch to zoom
  // -------------------------------------------------------------------------

  const getCanvasPoint = useCallback((event) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }, [])

  const getTrackedPointers = useCallback(() => Array.from(pointersRef.current.values()), [])

  const beginSinglePointerGesture = useCallback((point) => {
    gestureRef.current = {
      type: 'single',
      startX: point.x,
      startY: point.y,
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
      moved: false,
    }
  }, [])

  const beginPinchGesture = useCallback(() => {
    const [first, second] = getTrackedPointers()
    if (!first || !second) return

    const center = {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    }
    const distance = Math.hypot(second.x - first.x, second.y - first.y)

    gestureRef.current = {
      type: 'pinch',
      startDistance: Math.max(distance, PINCH_MIN_DISTANCE),
      startZoom: viewRef.current.zoom,
      anchorImage: canvasToImage(center.x, center.y),
      moved: true,
    }
  }, [canvasToImage, getTrackedPointers])

  const onPointerDown = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const canvas = canvasRef.current
    const point = getCanvasPoint(event)
    if (!canvas || !point) return

    canvas.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, point)

    if (pointersRef.current.size === 1) {
      beginSinglePointerGesture(point)
    } else if (pointersRef.current.size >= 2) {
      beginPinchGesture()
    }
  }, [beginPinchGesture, beginSinglePointerGesture, getCanvasPoint])

  const requestPreviewRedraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      forceRedraw(n => n + 1)
    })
  }, [])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const onPointerMove = useCallback((event) => {
    const point = getCanvasPoint(event)
    if (!point) return
    if (event.pointerType !== 'touch') {
      hoverRef.current = point
      if (mode === 'erase' || (mode === 'reference' && referencePoints.length === 1) || (mode === 'polygon' && polygonPoints.length)) {
        requestPreviewRedraw()
      }
    }
    if (!pointersRef.current.has(event.pointerId)) return

    pointersRef.current.set(event.pointerId, point)
    const gesture = gestureRef.current

    if (pointersRef.current.size >= 2) {
      const [first, second] = getTrackedPointers()
      if (!first || !second || gesture.type !== 'pinch') return

      const center = {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
      }
      const distance = Math.max(Math.hypot(second.x - first.x, second.y - first.y), PINCH_MIN_DISTANCE)
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, gesture.startZoom * (distance / gesture.startDistance)))

      updatePinchView(center, gesture.anchorImage, zoom)
      return
    }

    if (gesture.type !== 'single') return

    const dx = point.x - gesture.startX
    const dy = point.y - gesture.startY

    if (!gesture.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      gesture.moved = true
    }

    if (gesture.moved) {
      viewRef.current.panX = gesture.panX + dx
      viewRef.current.panY = gesture.panY + dy
      forceRedraw(n => n + 1)
    }
  }, [getCanvasPoint, getTrackedPointers, updatePinchView, mode, referencePoints.length, polygonPoints.length, requestPreviewRedraw])

  const finishPointer = useCallback((event) => {
    const point = pointersRef.current.get(event.pointerId)
    const gesture = gestureRef.current

    pointersRef.current.delete(event.pointerId)

    if (gesture.type === 'single' && point && !gesture.moved && mode !== 'view') {
      const { x, y } = canvasToImage(point.x, point.y)
      const ix = Math.max(0, Math.min(imageWidth, x))
      const iy = Math.max(0, Math.min(imageHeight, y))
      const first = polygonPoints[0]
      const nearFirst = mode === 'polygon' && polygonPoints.length >= 3 && first &&
        Math.hypot(imageToCanvas(first.x, first.y).x - point.x, imageToCanvas(first.x, first.y).y - point.y) < 10
      if (nearFirst) onPolygonClose?.()
      else onPointAdded?.(ix, iy)
    }

    if (pointersRef.current.size >= 2) {
      beginPinchGesture()
      return
    }

    if (pointersRef.current.size === 1) {
      const [remaining] = getTrackedPointers()
      beginSinglePointerGesture(remaining)
      return
    }

    gestureRef.current = { type: 'idle', moved: false }
  }, [beginPinchGesture, beginSinglePointerGesture, canvasToImage, imageToCanvas, getTrackedPointers, imageHeight, imageWidth, mode, onPointAdded, onPolygonClose, polygonPoints])

  // -------------------------------------------------------------------------
  // Cursor style
  // -------------------------------------------------------------------------

  const cursor = mode === 'view' ? 'grab' : mode === 'erase' ? 'none' : 'crosshair'

  // -------------------------------------------------------------------------
  // Keyboard: zoom, brush size, arrow-key panning
  // -------------------------------------------------------------------------

  const flashBrush = useCallback(() => {
    setBrushFlash(true)
    clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setBrushFlash(false), HUD_FLASH_MS)
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomAboutCentre(1.25) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAboutCentre(0.8) }
      else if (e.key === '0') { e.preventDefault(); fitToCanvas() }
      else if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); setZoomOneToOne() }
      else if ((e.key === '[' || e.key === ']') && onEraseRadiusChange) {
        e.preventDefault()
        onEraseRadiusChange(Math.max(2, Math.min(500, eraseRadius + (e.key === ']' ? 5 : -5))))
        flashBrush()
      } else if (e.target === canvasRef.current && e.key.startsWith('Arrow')) {
        e.preventDefault()
        const d = 40
        const v = viewRef.current
        if (e.key === 'ArrowLeft') v.panX += d
        if (e.key === 'ArrowRight') v.panX -= d
        if (e.key === 'ArrowUp') v.panY += d
        if (e.key === 'ArrowDown') v.panY -= d
        forceRedraw(n => n + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomAboutCentre, fitToCanvas, setZoomOneToOne, onEraseRadiusChange, eraseRadius, flashBrush])

  const modeLabel = {
    reference: 'Click the two edges of the reference coin',
    polygon: 'Click points to outline the grounds region',
    erase: 'Click stray clusters to mark them for removal',
    view: 'Pan and zoom the photo',
  }[mode]

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        role="img"
        tabIndex={0}
        aria-label={`Photo of grounds. ${modeLabel}. Arrow keys pan, plus and minus zoom.`}
        style={{ display: 'block', width: '100%', height: '100%', cursor, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => { hoverRef.current = null; requestPreviewRedraw() }}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
      />
      {brushFlash && mode === 'erase' && <div className="brush-flash" role="status">Brush {eraseRadius} px</div>}
      <div className="canvas-hud hud-zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomAboutCentre(0.8)}>−</button>
        <button type="button" className="hud-pct" title="Reset to fit (0)" onClick={fitToCanvas}>{zoomPct}%</button>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAboutCentre(1.25)}>+</button>
        <span className="hud-sep" aria-hidden="true" />
        <button type="button" className="hud-fit" title="Fit image (0)" onClick={fitToCanvas}>Fit</button>
        <button type="button" className="hud-one" title="Actual pixels (Shift+1)" onClick={setZoomOneToOne}>1:1</button>
      </div>
    </div>
  )
}
