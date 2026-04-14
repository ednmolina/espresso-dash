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
 *   overlayB64      – optional base64 PNG to show instead of the original image
 */
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
  overlayB64,
}) {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const overlayImgRef = useRef(null)

  // Viewport state: zoom level and pan offset (canvas pixels)
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 })
  const [, forceRedraw] = useState(0)

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
    const W = canvas.width
    const H = canvas.height

    ctx.clearRect(0, 0, W, H)
    ctx.save()
    ctx.translate(panX, panY)
    ctx.scale(zoom, zoom)

    // Draw image (overlay takes priority if provided)
    const img = overlayImgRef.current || imgRef.current
    if (img && img.complete) {
      ctx.drawImage(img, 0, 0, imageWidth, imageHeight)
    }

    ctx.restore()

    // Draw overlays in canvas space (so points stay crisp at any zoom)
    _drawReferencePoints(ctx)
    _drawPolygon(ctx)
    _drawErasePoints(ctx)
  }, [imageWidth, imageHeight, referencePoints, polygonPoints, erasePoints, eraseRadius, mode])

  function _drawReferencePoints(ctx) {
    if (!referencePoints.length) return
    const pts = referencePoints.map(({ x, y }) => imageToCanvas(x, y))

    if (pts.length === 2) {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      ctx.lineTo(pts[1].x, pts[1].y)
      ctx.strokeStyle = '#e63946'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    pts.forEach(({ x, y }, i) => {
      ctx.beginPath()
      ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = '#ffb000'
      ctx.fill()
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.fillStyle = '#fff'
      ctx.font = 'bold 10px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(i + 1, x, y)
    })
  }

  function _drawPolygon(ctx) {
    if (!polygonPoints.length) return
    const pts = polygonPoints.map(({ x, y }) => imageToCanvas(x, y))

    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    pts.slice(1).forEach(({ x, y }) => ctx.lineTo(x, y))
    if (pts.length >= 3) ctx.closePath()
    ctx.strokeStyle = '#2a9d8f'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 3])
    ctx.stroke()
    ctx.setLineDash([])

    pts.forEach(({ x, y }) => {
      ctx.beginPath()
      ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = '#2a9d8f'
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

  // -------------------------------------------------------------------------
  // Fit image to canvas on first load
  // -------------------------------------------------------------------------

  const fitToCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageWidth || !imageHeight) return
    const scaleX = canvas.width / imageWidth
    const scaleY = canvas.height / imageHeight
    const zoom = Math.min(scaleX, scaleY, 1) // never upscale by default
    const panX = (canvas.width - imageWidth * zoom) / 2
    const panY = (canvas.height - imageHeight * zoom) / 2
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
    if (!overlayB64) {
      overlayImgRef.current = null
      forceRedraw(n => n + 1)
      return
    }
    const img = new Image()
    img.onload = () => {
      overlayImgRef.current = img
      forceRedraw(n => n + 1)
    }
    img.src = `data:image/png;base64,${overlayB64}`
  }, [overlayB64])

  // Redraw whenever anything changes
  useEffect(() => { draw() })

  // -------------------------------------------------------------------------
  // Resize canvas to fill its container
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const rect = canvas.parentElement.getBoundingClientRect()
      canvas.width = rect.width
      canvas.height = rect.height
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

  const onPointerMove = useCallback((event) => {
    if (!pointersRef.current.has(event.pointerId)) return
    const point = getCanvasPoint(event)
    if (!point) return

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
  }, [getCanvasPoint, getTrackedPointers, updatePinchView])

  const finishPointer = useCallback((event) => {
    const point = pointersRef.current.get(event.pointerId)
    const gesture = gestureRef.current

    pointersRef.current.delete(event.pointerId)

    if (gesture.type === 'single' && point && !gesture.moved && mode !== 'view') {
      const { x, y } = canvasToImage(point.x, point.y)
      const ix = Math.max(0, Math.min(imageWidth, x))
      const iy = Math.max(0, Math.min(imageHeight, y))
      onPointAdded?.(ix, iy)
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
  }, [beginPinchGesture, beginSinglePointerGesture, canvasToImage, getTrackedPointers, imageHeight, imageWidth, mode, onPointAdded])

  // -------------------------------------------------------------------------
  // Cursor style
  // -------------------------------------------------------------------------

  const cursor = mode === 'view' ? 'grab' : 'crosshair'

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', cursor, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
      />
      <button
        onClick={fitToCanvas}
        title="Reset zoom to fit"
        style={{
          position: 'absolute', top: 8, right: 8,
          padding: '4px 8px', fontSize: 12,
          background: 'rgba(0,0,0,0.55)', color: '#fff',
          border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Fit
      </button>
    </div>
  )
}
