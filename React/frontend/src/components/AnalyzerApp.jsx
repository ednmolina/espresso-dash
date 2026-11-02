import { useState, useCallback, useEffect, useRef } from 'react'
import ImageCanvas from './ImageCanvas'
import Sidebar from './Sidebar'
import ResultsPanel from './ResultsPanel'
import HistogramChart, { SERIES_COLORS } from './HistogramChart'
import { API, DEFAULT_SETTINGS, REFERENCE_OBJECTS, settingsPayload } from '../constants'
import {
  errorMessage, filterParticles, particlesToCsv,
  isNum, um, cleanUnit, formatSigma, sig,
} from '../analyzerUtils'
import '../analyzer.css'

const STEPS = [
  { id: 'reference', n: '1', label: 'Scale', key: '1', color: 'var(--step-scale)' },
  { id: 'polygon', n: '2', label: 'Region', key: '2', color: 'var(--step-region)' },
  { id: 'detect', n: '3', label: 'Detect', key: '↵' },
  { id: 'erase', n: '4', label: 'Clean up', key: '4', color: 'var(--step-clean)' },
]

const SHORTCUTS = [
  ['1', 'Scale: click both edges of the coin'],
  ['2', 'Region: outline the grounds'],
  ['Enter', 'Detect particles (or remove marked clusters)'],
  ['4', 'Clean up: mark stray clusters'],
  ['V / Space', 'View mode: drag to pan'],
  ['Z / Backspace', 'Undo last point'],
  ['Esc', 'Clear points in this step / close this panel'],
  ['+  −  0', 'Zoom in, zoom out, fit to window'],
  ['Shift 1', 'Zoom to 100%'],
  ['[  ]', 'Smaller / larger eraser brush'],
  ['Arrow keys', 'Pan (when the photo is focused)'],
  ['?', 'Show or hide this sheet'],
]

function isInteractiveTarget(target) {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)
  )
}

function UploadActions({ onUpload, large = false }) {
  return (
    <div className={`upload-actions ${large ? 'large' : ''}`}>
      <label className={`upload-btn ${large ? 'large primary' : ''}`}>
        Choose image
        <input type="file" accept="image/*" onChange={onUpload} hidden />
      </label>
      <label className={`upload-btn upload-btn-secondary ${large ? 'large' : ''}`}>
        Take photo
        <input type="file" accept="image/*" capture="environment" onChange={onUpload} hidden />
      </label>
    </div>
  )
}

async function authHeaders(user) {
  if (!user) return {}
  try {
    const token = await user.getIdToken()
    return { Authorization: `Bearer ${token}` }
  } catch {
    return {}
  }
}

/** fetch + JSON with the server's error detail surfaced as the thrown message. */
async function apiRequest(user, path, { json, form, method = 'POST' } = {}) {
  const headers = { ...await authHeaders(user) }
  if (json) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : form,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    throw new Error(errorMessage(data, res.status))
  }
  return data
}

/** Natural size of an image the browser can decode itself, or null. */
function probeImage(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = src
  })
}

function downloadDataUrl(href, filename) {
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.click()
}

export default function AnalyzerApp({ user }) {
  const [imageId, setImageId] = useState(null)
  const [imageSrc, setImageSrc] = useState(null)
  const [imageWidth, setImageWidth] = useState(0)
  const [imageHeight, setImageHeight] = useState(0)
  const [mode, setMode] = useState('reference')
  const [referencePoints, setReferencePoints] = useState([])
  const [referencePreset, setReferencePreset] = useState('US Quarter')
  const [referencePhysicalMm, setReferencePhysicalMm] = useState(24.26)
  const [polygonPoints, setPolygonPoints] = useState([])
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [analysisResult, setAnalysisResult] = useState(null)
  const [overlayMode, setOverlayMode] = useState('clusters')
  const [removedIds, setRemovedIds] = useState([])
  const [erasePoints, setErasePoints] = useState([])
  const [eraseRadius, setEraseRadius] = useState(20)
  const [histogram, setHistogram] = useState(null)
  const [histogramLoading, setHistogramLoading] = useState(false)
  const [savedRuns, setSavedRuns] = useState([])
  const [compare, setCompare] = useState(null)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [status, setStatus] = useState({ text: '', tone: 'info' })
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('Working…')
  const [elapsed, setElapsed] = useState(0)
  const [kbdOpen, setKbdOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const objectUrlRef = useRef(null)
  const histSeq = useRef(0)
  const downloadRef = useRef(null)
  const kbdRef = useRef(null)

  const say = (text, tone = 'info') => setStatus({ text, tone })

  let layerB64 = null
  if (analysisResult) {
    if (overlayMode === 'threshold') layerB64 = analysisResult.threshold_layer_b64
    else if (overlayMode === 'clusters') layerB64 = analysisResult.cluster_layer_b64
  }

  let pixelScale = null
  if (referencePoints.length === 2 && referencePhysicalMm > 0) {
    const dx = referencePoints[1].x - referencePoints[0].x
    const dy = referencePoints[1].y - referencePoints[0].y
    pixelScale = Math.sqrt(dx * dx + dy * dy) / referencePhysicalMm
  }

  const stepDone = {
    reference: pixelScale != null,
    polygon: polygonPoints.length >= 3,
    detect: analysisResult != null,
    erase: removedIds.length > 0,
  }

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  // Elapsed-seconds counter for the busy card.
  useEffect(() => {
    if (!busy) { setElapsed(0); return undefined }
    const t0 = performance.now()
    const id = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100)
    return () => clearInterval(id)
  }, [busy])

  const startBusy = (label) => { setBusyLabel(label); setBusy(true) }

  const handleUpload = async (e) => {
    const input = e.target
    const file = input.files[0]
    if (!file) return
    input.value = ''

    startBusy('Uploading…')
    say('Uploading…')

    const form = new FormData()
    form.append('file', file)

    try {
      // Show the local file straight away instead of downloading it back from
      // the server. The server applies EXIF rotation exactly like browsers do;
      // if the sizes disagree (or the browser can't decode the format), fall
      // back to the server's rendering so clicks map to the analysed pixels.
      const localUrl = URL.createObjectURL(file)
      const [data, local] = await Promise.all([
        apiRequest(user, '/upload', { form }),
        probeImage(localUrl),
      ])
      let src = localUrl
      if (!local || local.width !== data.width || local.height !== data.height) {
        URL.revokeObjectURL(localUrl)
        const preview = await apiRequest(user, `/preview/${data.image_id}`, { method: 'GET' })
        src = `data:${preview.image_mime};base64,${preview.image_b64}`
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = src.startsWith('blob:') ? src : null

      histSeq.current += 1
      setImageId(data.image_id)
      setImageSrc(src)
      setImageWidth(data.width)
      setImageHeight(data.height)
      setReferencePoints([])
      setPolygonPoints([])
      setErasePoints([])
      setAnalysisResult(null)
      setRemovedIds([])
      setHistogram(null)
      setHistogramLoading(false)
      setMode('reference')
      say('Click one edge of your reference coin to set the scale.')
    } catch (err) {
      say(`Upload failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const handlePointAdded = useCallback((x, y) => {
    if (mode === 'reference') {
      setReferencePoints((prev) => {
        const next = [...prev, { x, y }]
        return next.length > 2 ? next.slice(-1) : next
      })
    } else if (mode === 'polygon') {
      setPolygonPoints((prev) => [...prev, { x, y }])
    } else if (mode === 'erase') {
      setErasePoints((prev) => [...prev, { x, y }])
    }
  }, [mode])

  // Keep the status line in step with the scale clicks.
  useEffect(() => {
    if (mode !== 'reference') return
    if (referencePoints.length === 1) say('Now the opposite edge of the coin.')
    else if (referencePoints.length === 2 && pixelScale) say(`Scale set: ${pixelScale.toFixed(1)} px/mm`, 'success')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referencePoints.length])

  const handlePresetChange = (name) => {
    setReferencePreset(name)
    if (REFERENCE_OBJECTS[name]) setReferencePhysicalMm(REFERENCE_OBJECTS[name])
  }

  const undoActivePoints = useCallback(() => {
    if (mode === 'reference' && referencePoints.length) {
      setReferencePoints((prev) => prev.slice(0, -1))
      return
    }
    if (mode === 'polygon' && polygonPoints.length) {
      setPolygonPoints((prev) => prev.slice(0, -1))
      return
    }
    if (mode === 'erase' && erasePoints.length) {
      setErasePoints((prev) => prev.slice(0, -1))
    }
  }, [mode, referencePoints.length, polygonPoints.length, erasePoints.length])

  const clearActivePoints = useCallback(() => {
    if (mode === 'reference' && referencePoints.length) {
      setReferencePoints([])
      return
    }
    if (mode === 'polygon' && polygonPoints.length) {
      setPolygonPoints([])
      return
    }
    if (mode === 'erase' && erasePoints.length) {
      setErasePoints([])
    }
  }, [mode, referencePoints.length, polygonPoints.length, erasePoints.length])

  /** Histogram for the current analysis; fetched automatically after detect/erase. */
  const loadHistogram = useCallback(async (ids) => {
    if (!imageId) return
    const seq = ++histSeq.current
    setHistogramLoading(true)
    try {
      const data = await apiRequest(user, '/histogram', {
        json: { image_id: imageId, removed_cluster_ids: ids, include_png: false },
      })
      if (seq === histSeq.current) setHistogram(data)
    } catch (err) {
      if (seq === histSeq.current) say(`Histogram failed: ${err.message}`, 'error')
    } finally {
      if (seq === histSeq.current) setHistogramLoading(false)
    }
  }, [imageId, user])

  const canDetect = referencePoints.length === 2

  const runAnalysis = useCallback(async () => {
    if (!imageId || busy) return
    if (!canDetect) { say('Set the scale first: click both edges of the coin.', 'error'); return }
    startBusy('Detecting particles…')
    say('Detecting particles…')
    const started = performance.now()

    try {
      const data = await apiRequest(user, '/analyze', {
        json: {
          image_id: imageId,
          ...settingsPayload(settings),
          reference_points: referencePoints.map((point) => [point.x, point.y]),
          reference_physical_mm: referencePhysicalMm,
          polygon_points: polygonPoints.map((point) => [point.x, point.y]),
        },
      })
      setAnalysisResult(data)
      setRemovedIds([])
      setErasePoints([])
      setHistogram(null)
      setOverlayMode('clusters')
      setMode('erase')
      setDownloadsOpen(false)
      const secs = ((performance.now() - started) / 1000).toFixed(1)
      say(`${(data.nclusters ?? 0).toLocaleString()} particles detected in ${secs}s. Click stray clusters to remove them.`, 'success')
      if (data.summary) loadHistogram([])
    } catch (err) {
      say(`Detection failed: ${err.message}. Try lowering Threshold or Analysis resolution.`, 'error')
    } finally {
      setBusy(false)
    }
  }, [imageId, busy, canDetect, settings, referencePoints, referencePhysicalMm, polygonPoints, user, loadHistogram])

  const applyErase = useCallback(async () => {
    if (!imageId || !erasePoints.length) return
    startBusy('Removing clusters…')
    say('Removing clusters…')

    try {
      const data = await apiRequest(user, '/erase', {
        json: {
          image_id: imageId,
          erase_points: erasePoints.map((point) => [point.x, point.y]),
          erase_radius_px: eraseRadius,
          already_removed_ids: removedIds,
        },
      })
      const gone = data.removed_ids ?? removedIds
      setAnalysisResult((prev) => ({
        ...prev,
        cluster_layer_b64: data.cluster_layer_b64 ?? prev.cluster_layer_b64,
        nclusters: data.nclusters ?? prev.nclusters,
        summary: data.summary ?? prev.summary,
        // newer servers omit particles: filter the local copy instead
        particles: data.particles ?? filterParticles(prev.particles, gone),
      }))
      setRemovedIds(gone)
      setErasePoints([])
      setHistogram(null)
      const added = gone.length - removedIds.length
      say(added > 0 ? `${added} cluster${added === 1 ? '' : 's'} removed (${gone.length} in total).` : 'No clusters under the brush.', added > 0 ? 'success' : 'info')
      if ((data.summary ?? analysisResult?.summary)) loadHistogram(gone)
    } catch (err) {
      say(`Erase failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [imageId, erasePoints, eraseRadius, removedIds, user, loadHistogram, analysisResult])

  const saveRun = () => {
    if (!analysisResult || !imageId) return
    if (savedRuns.length >= 3) return
    const label = `Run ${savedRuns.length + 1}`
    setSavedRuns((prev) => [...prev, {
      label,
      // frozen server-side copy of this analysis (falls back for older servers)
      imageId: analysisResult.analysis_id ?? imageId,
      removedIds: [...removedIds],
      summary: analysisResult.summary,
    }])
    setCompare(null)
    say(`${label} saved.`, 'success')
  }

  const compareBody = (includePng) => ({
    runs: savedRuns.map((r) => ({ image_id: r.imageId, removed_cluster_ids: r.removedIds, label: r.label })),
    include_png: includePng,
  })

  const fetchCompareHistogram = async () => {
    if (savedRuns.length < 2) return
    startBusy('Comparing runs…')
    try {
      setCompare(await apiRequest(user, '/histogram/compare', { json: compareBody(false) }))
    } catch (err) {
      say(`Compare failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const downloadCsv = () => {
    setDownloadsOpen(false)
    const csv = particlesToCsv(analysisResult?.particles, removedIds)
    if (!csv) { say('No particles to export.', 'error'); return }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    downloadDataUrl(url, 'particle-analysis.csv')
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // The PNG chart is rendered server-side only when someone asks for the file.
  const downloadHistogram = async () => {
    startBusy('Rendering chart…')
    try {
      const data = await apiRequest(user, '/histogram', {
        json: { image_id: imageId, removed_cluster_ids: removedIds, include_png: true },
      })
      downloadDataUrl(`data:image/png;base64,${data.histogram_b64}`, 'particle-histogram.png')
    } catch (err) {
      say(`Download failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
      setDownloadsOpen(false)
    }
  }

  const downloadCompare = async () => {
    startBusy('Rendering chart…')
    try {
      const data = await apiRequest(user, '/histogram/compare', { json: compareBody(true) })
      downloadDataUrl(`data:image/png;base64,${data.histogram_b64}`, 'run-comparison.png')
    } catch (err) {
      say(`Download failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const clearRuns = () => {
    setSavedRuns([])
    setCompare(null)
  }

  // Download menu: close on outside click and Esc.
  useEffect(() => {
    if (!downloadsOpen) return undefined
    const onDown = (e) => { if (downloadRef.current && !downloadRef.current.contains(e.target)) setDownloadsOpen(false) }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setDownloadsOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    downloadRef.current?.querySelector('[role=menuitem]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [downloadsOpen])

  useEffect(() => { if (kbdOpen) kbdRef.current?.focus() }, [kbdOpen])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || isInteractiveTarget(event.target)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const key = event.key.toLowerCase()

      if (event.key === '?') {
        event.preventDefault()
        setKbdOpen((v) => !v)
        return
      }
      if (kbdOpen) {
        if (key === 'escape') { event.preventDefault(); setKbdOpen(false) }
        return
      }
      if (busy) return

      if (key === '1' && !event.shiftKey) {
        event.preventDefault()
        setMode('reference')
        return
      }

      if (key === '2') {
        event.preventDefault()
        setMode('polygon')
        return
      }

      if (key === '4' && analysisResult) {
        event.preventDefault()
        setMode('erase')
        return
      }

      if (key === 'v' || event.code === 'Space') {
        event.preventDefault()
        setMode('view')
        return
      }

      if (key === 'backspace' || key === 'z') {
        event.preventDefault()
        undoActivePoints()
        return
      }

      if (key === 'escape') {
        event.preventDefault()
        clearActivePoints()
        return
      }

      if (key === 'enter') {
        event.preventDefault()
        if (mode === 'erase' && analysisResult && erasePoints.length) {
          applyErase()
          return
        }
        runAnalysis()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    analysisResult,
    applyErase,
    busy,
    clearActivePoints,
    erasePoints.length,
    kbdOpen,
    mode,
    runAnalysis,
    undoActivePoints,
  ])

  const activeColor = STEPS.find((s) => s.id === mode)?.color ?? '#8a7c6e'
  // Present the combined stats in µm even when the server's axis unit is mm.
  const rawUnit = cleanUnit(compare?.unit ?? 'mm')
  const unit = rawUnit
  const cscale = compare?.scale ?? 1
  const toUm = rawUnit === 'mm' ? 1000 : 1
  const runLabel = mode === 'erase' && analysisResult ? 'Re-run' : 'Detect particles ⏎'
  const detectDisabled = busy || !canDetect
  const detectTitle = !canDetect ? 'Set the scale first' : 'Run particle detection (Enter)'
  const overlayOptions = ['original', 'threshold', 'clusters']
  const regionClosed = polygonPoints.length >= 3

  const onOverlayKey = (e) => {
    const i = overlayOptions.indexOf(overlayMode)
    let next = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = overlayOptions[(i + 1) % 3]
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = overlayOptions[(i + 2) % 3]
    if (next) {
      e.preventDefault()
      setOverlayMode(next)
      e.currentTarget.querySelector(`[data-value=${next}]`)?.focus()
    }
  }

  return (
    <div className={`analyzer-app ${imageSrc ? 'has-image' : ''} ${settingsOpen ? 'settings-open' : ''}`}>
      <Sidebar
        settings={settings}
        onSettingsChange={setSettings}
        referencePreset={referencePreset}
        onPresetChange={handlePresetChange}
        referencePhysicalMm={referencePhysicalMm}
        onPhysicalMmChange={setReferencePhysicalMm}
        open={settingsOpen}
        onToggle={() => setSettingsOpen((v) => !v)}
      />

      <main className="analyzer-main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>Grind analyzer</h1>
            <p>Measure particle size from a photo of grounds on white paper.</p>
          </div>
          {imageSrc && <UploadActions onUpload={handleUpload} />}
        </header>

        {imageSrc && (
          <div className="toolbar">
            <ol className="stepper">
              {STEPS.map((step) => {
                const isCurrent = mode === step.id
                const isDone = !isCurrent && stepDone[step.id]
                const isDisabled = !isCurrent && !isDone && step.id === 'erase' && !analysisResult
                const detectBlocked = step.id === 'detect' && !canDetect
                const onClick = step.id === 'detect' ? runAnalysis : () => setMode(step.id)
                const disabled = busy || (step.id === 'erase' && !analysisResult) || detectBlocked
                let title = `Shortcut: ${step.key}`
                if (step.id === 'erase' && !analysisResult) title = 'Run detection first'
                else if (detectBlocked) title = 'Set the scale first'
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      className={`step ${isCurrent ? 'current' : ''} ${isDone ? 'done' : ''} ${(isDisabled || (disabled && !isCurrent && !isDone)) ? 'is-disabled' : ''}`}
                      style={step.color ? { '--step-color': step.color } : undefined}
                      aria-current={isCurrent ? 'step' : undefined}
                      onClick={onClick}
                      disabled={disabled}
                      title={title}
                    >
                      <span className="step-n" aria-hidden="true">{isDone ? '✓' : step.n}</span>
                      <span className="step-label">{step.label}</span>
                      {step.id === 'detect' && busy && busyLabel.startsWith('Detecting') && <span className="spinner" aria-hidden="true" />}
                    </button>
                  </li>
                )
              })}
            </ol>

            <div className="toolbar-context" style={{ '--mode-color': activeColor }}>
              {mode === 'reference' && (
                <>
                  <span className="toolbar-hint">
                    {referencePoints.length === 0 && 'Click one edge of the coin'}
                    {referencePoints.length === 1 && 'Now the opposite edge'}
                    {referencePoints.length === 2 && <>Scale set: <strong>{pixelScale?.toFixed(1)}</strong> px/mm</>}
                  </span>
                  <button className="ghost" onClick={undoActivePoints} disabled={!referencePoints.length}>Undo</button>
                  <button className="ghost" onClick={clearActivePoints} disabled={!referencePoints.length}>Clear</button>
                </>
              )}

              {mode === 'polygon' && (
                <>
                  <span className="toolbar-hint">
                    {!regionClosed
                      ? 'Optional: outline the grounds (3+ points) or skip to Detect'
                      : `${polygonPoints.length}-point region · click the first point to close`}
                  </span>
                  <button className="ghost" onClick={undoActivePoints} disabled={!polygonPoints.length}>Undo</button>
                  <button className="ghost" onClick={clearActivePoints} disabled={!polygonPoints.length}>Clear</button>
                </>
              )}

              {mode === 'erase' && analysisResult && (
                <>
                  <span className="toolbar-hint hint-erase">
                    {erasePoints.length ? `${erasePoints.length} marked` : 'Click stray clusters to mark them · [ ] brush size'}
                  </span>
                  <label className="toolbar-inline-field">
                    Brush
                    <input
                      type="number"
                      min={2}
                      max={500}
                      step={1}
                      value={eraseRadius}
                      onChange={(event) => setEraseRadius(Math.max(2, Math.min(500, parseInt(event.target.value, 10) || 2)))}
                    />
                    px
                  </label>
                  <button
                    onClick={applyErase}
                    disabled={!erasePoints.length || busy}
                    className="btn-primary"
                    title={erasePoints.length ? 'Remove the marked clusters (Enter)' : 'Click particles to mark them'}
                  >
                    Remove{erasePoints.length ? ` (${erasePoints.length})` : ''}
                  </button>
                  <button className="ghost" onClick={clearActivePoints} disabled={!erasePoints.length}>Clear</button>
                </>
              )}

              {mode === 'view' && <span className="toolbar-hint">Drag to pan · scroll or pinch to zoom</span>}
            </div>

            <button
              type="button"
              className="btn-primary toolbar-primary"
              onClick={runAnalysis}
              disabled={detectDisabled}
              title={detectTitle}
            >
              {busy && busyLabel.startsWith('Detecting') ? 'Detecting…' : runLabel}
            </button>
          </div>
        )}

        <div className="canvas-area" aria-busy={busy ? 'true' : 'false'}>
          {imageSrc ? (
            <ImageCanvas
              imageSrc={imageSrc}
              imageWidth={imageWidth}
              imageHeight={imageHeight}
              mode={mode}
              referencePoints={referencePoints}
              polygonPoints={polygonPoints}
              erasePoints={erasePoints}
              eraseRadius={eraseRadius}
              onPointAdded={handlePointAdded}
              layerB64={layerB64}
              pixelScale={pixelScale}
              referenceMm={referencePhysicalMm}
              onEraseRadiusChange={setEraseRadius}
              onPolygonClose={() => say(`Region closed with ${polygonPoints.length} points.`, 'success')}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-illustration" aria-hidden="true">
                {Array.from({ length: 18 }).map((_, i) => <span key={i} style={{ '--i': i }} />)}
              </div>
              <h2>Start with a photo of your grounds</h2>
              <p>
                Spread a pinch of coffee thinly on white paper, place a coin beside it, and shoot straight down in even light.
              </p>
              <UploadActions onUpload={handleUpload} large />
            </div>
          )}

          {imageSrc && analysisResult && (
            <div
              className="canvas-hud hud-top-left overlay-btns"
              role="radiogroup"
              aria-label="Overlay"
              onKeyDown={onOverlayKey}
            >
              {overlayOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  data-value={value}
                  aria-checked={overlayMode === value}
                  tabIndex={overlayMode === value ? 0 : -1}
                  className={overlayMode === value ? 'active' : ''}
                  onClick={() => setOverlayMode(value)}
                >
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          )}

          {busy && imageSrc && (
            <div className="canvas-scrim">
              <div className="busy-card" role="status">
                <div className="busy-title"><span className="spinner" aria-hidden="true" />{busyLabel}</div>
                <div className="busy-bar" aria-hidden="true"><i /></div>
                <div className="busy-elapsed">{elapsed.toFixed(1)} s</div>
              </div>
            </div>
          )}

          {kbdOpen && (
            <div className="kbd-backdrop" onClick={() => setKbdOpen(false)}>
              <div
                className="kbd-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Keyboard shortcuts"
                tabIndex={-1}
                ref={kbdRef}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="kbd-head">
                  <h2>Keyboard shortcuts</h2>
                  <button type="button" className="ghost small" onClick={() => setKbdOpen(false)} aria-label="Close shortcuts">Esc</button>
                </div>
                <dl>
                  {SHORTCUTS.map(([k, d]) => (
                    <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </div>

        <div className="status-row">
          {status.text ? (
            <div
              className={`status status-${status.tone}`}
              role={status.tone === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              <i className="status-dot" aria-hidden="true" />
              <span className="status-text">{status.text}</span>
              {status.tone === 'error' && (
                <button type="button" className="ghost small status-dismiss" aria-label="Dismiss message" onClick={() => say('')}>Dismiss</button>
              )}
            </div>
          ) : <div className="status status-empty" aria-live="polite" />}
          <button type="button" className="ghost small kbd-open" onClick={() => setKbdOpen(true)}>? Shortcuts</button>
        </div>
      </main>

      {imageSrc && (
        <aside className="results-column" aria-label="Results">
          {!analysisResult && (
            <div className="results-empty">
              <h3>No results yet</h3>
              <ul className="checklist">
                <li className={stepDone.reference ? 'done' : ''}><span aria-hidden="true">{stepDone.reference ? '☑' : '☐'}</span> Scale set</li>
                <li className={stepDone.polygon ? 'done' : ''}><span aria-hidden="true">{stepDone.polygon ? '☑' : '☐'}</span> Region (optional)</li>
                <li><span aria-hidden="true">☐</span> Detect</li>
              </ul>
              <button className="btn-primary btn-large" onClick={runAnalysis} disabled={detectDisabled} title={detectTitle}>
                {busy && busyLabel.startsWith('Detecting') ? 'Running…' : 'Run particle detection'}
              </button>
            </div>
          )}

          <ResultsPanel result={analysisResult} histogram={histogram} histogramLoading={histogramLoading} />

          {analysisResult && (
            <div className="results-actions">
              <button onClick={saveRun} disabled={busy || savedRuns.length >= 3}>Save run ({savedRuns.length}/3)</button>
              <div className={`download-menu ${downloadsOpen ? 'open' : ''}`} ref={downloadRef}>
                <button type="button" onClick={() => setDownloadsOpen((prev) => !prev)} aria-expanded={downloadsOpen} aria-haspopup="menu">
                  Download ▾
                </button>
                {downloadsOpen && (
                  <div className="download-menu-panel" role="menu">
                    <button type="button" role="menuitem" onClick={downloadCsv}>Particles (CSV)</button>
                    <button type="button" role="menuitem" onClick={downloadHistogram} disabled={!analysisResult.summary || busy}>Histogram (PNG)</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {savedRuns.length > 0 && (
            <section className="results-section saved-runs-panel">
              <div className="results-heading">
                <h3>Saved runs</h3>
                <button className="ghost small" onClick={clearRuns} disabled={busy}>Clear</button>
              </div>
              <table className="saved-runs-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Particles</th>
                    <th>Dv50 µm</th>
                    <th>Fines</th>
                    <th>Mean µm</th>
                  </tr>
                </thead>
                <tbody>
                  {savedRuns.map((run, i) => (
                    <tr key={run.label}>
                      <td><i className="run-swatch" style={{ background: SERIES_COLORS[i] }} />{run.label}</td>
                      <td>{isNum(run.summary?.cluster_count) ? run.summary.cluster_count.toLocaleString() : '—'}</td>
                      <td>{um(run.summary?.dv50_mm)}</td>
                      <td>
                        {run.summary?.fines_measurable === false ? 'n/a'
                          : isNum(run.summary?.fines_volume_pct) ? `${run.summary.fines_volume_pct.toFixed(1)}%` : '—'}
                      </td>
                      <td>{um(run.summary?.diameter_mean_mm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {savedRuns.length >= 2 && !compare && (
                <button className="btn-primary" onClick={fetchCompareHistogram} disabled={busy}>Compare runs</button>
              )}
              {compare && (
                <div className="histogram">
                  <HistogramChart data={compare.series} stats={compare.per_run} scale={cscale} unit={unit} />
                  {compare.combined && (
                    <div className="compare-summary">
                      <div><span>Mean of means</span><strong><b>{isNum(compare.combined.mean_of_means) ? sig(compare.combined.mean_of_means * cscale * toUm) : '—'}</b> {toUm === 1000 ? 'µm' : unit}</strong></div>
                      <div><span>Median of medians</span><strong><b>{isNum(compare.combined.median_of_medians) ? sig(compare.combined.median_of_medians * cscale * toUm) : '—'}</b> {toUm === 1000 ? 'µm' : unit}</strong></div>
                      <div><span>Run-to-run σ</span><strong>{formatSigma(isNum(compare.combined.std_of_means) ? compare.combined.std_of_means * cscale * toUm : null, toUm === 1000 ? 'µm' : unit)}</strong></div>
                    </div>
                  )}
                  {isNum(compare.min_diameter_um_applied) && (
                    <p className="results-note">Common cutoff applied to every run: {Math.round(compare.min_diameter_um_applied)} µm (largest detection limit).</p>
                  )}
                  <button className="ghost small" onClick={downloadCompare} disabled={busy}>Download comparison (PNG)</button>
                </div>
              )}
            </section>
          )}
        </aside>
      )}
    </div>
  )
}
