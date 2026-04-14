import { useState, useCallback, useEffect } from 'react'
import ImageCanvas from './ImageCanvas'
import Sidebar from './Sidebar'
import ResultsPanel from './ResultsPanel'
import { API, DEFAULT_SETTINGS, REFERENCE_OBJECTS } from '../constants'

const MODES = [
  { id: 'reference', label: '1 · Reference', color: '#e63946' },
  { id: 'polygon', label: '2 · Region', color: '#2a9d8f' },
  { id: 'erase', label: '4 · Erase', color: '#ff8c00' },
  { id: 'view', label: 'V · Pan / Zoom', color: '#555' },
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
      <label className={`upload-btn ${large ? 'large' : ''}`}>
        Choose Image
        <input type="file" accept="image/*" onChange={onUpload} hidden />
      </label>
      <label className={`upload-btn upload-btn-secondary ${large ? 'large' : ''}`}>
        Take Photo
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
  const [histogramB64, setHistogramB64] = useState(null)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  let overlayB64 = null
  if (analysisResult) {
    if (overlayMode === 'threshold') overlayB64 = analysisResult.threshold_overlay_b64
    else if (overlayMode === 'clusters') overlayB64 = analysisResult.cluster_overlay_b64
  }

  let pixelScale = null
  if (referencePoints.length === 2 && referencePhysicalMm > 0) {
    const dx = referencePoints[1].x - referencePoints[0].x
    const dy = referencePoints[1].y - referencePoints[0].y
    pixelScale = Math.sqrt(dx * dx + dy * dy) / referencePhysicalMm
  }

  const handleUpload = async (e) => {
    const input = e.target
    const file = input.files[0]
    if (!file) return
    input.value = ''

    setBusy(true)
    setStatus('Uploading...')

    const form = new FormData()
    form.append('file', file)

    try {
      const res = await fetch(`${API}/upload`, { method: 'POST', headers: await authHeaders(user), body: form })
      const data = await res.json()
      setImageId(data.image_id)
      setImageSrc(`data:image/png;base64,${data.image_b64}`)
      setImageWidth(data.width)
      setImageHeight(data.height)
      setReferencePoints([])
      setPolygonPoints([])
      setErasePoints([])
      setAnalysisResult(null)
      setRemovedIds([])
      setHistogramB64(null)
      setMode('reference')
      setStatus('Image loaded. Click two points on your reference object.')
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const handlePointAdded = useCallback((x, y) => {
    if (mode === 'reference') {
      setReferencePoints((prev) => {
        const next = [...prev, { x, y }]
        return next.length > 2 ? next.slice(-2) : next
      })
    } else if (mode === 'polygon') {
      setPolygonPoints((prev) => [...prev, { x, y }])
    } else if (mode === 'erase') {
      setErasePoints((prev) => [...prev, { x, y }])
    }
  }, [mode])

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

  const runAnalysis = useCallback(async () => {
    if (!imageId) return
    setBusy(true)
    setStatus('Analyzing...')

    try {
      const res = await fetch(`${API}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await authHeaders(user) },
        body: JSON.stringify({
          image_id: imageId,
          ...settings,
          reference_points: referencePoints.map((point) => [point.x, point.y]),
          reference_physical_mm: referencePhysicalMm,
          polygon_points: polygonPoints.map((point) => [point.x, point.y]),
        }),
      })
      const data = await res.json()
      setAnalysisResult(data)
      setRemovedIds([])
      setErasePoints([])
      setOverlayMode('clusters')
      setMode('erase')
      setDownloadsOpen(false)
      setStatus(`Done: ${data.nclusters} particles detected.`)
    } catch (err) {
      setStatus(`Analysis failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }, [imageId, settings, referencePoints, referencePhysicalMm, polygonPoints])

  const applyErase = useCallback(async () => {
    if (!imageId || !erasePoints.length) return
    setBusy(true)
    setStatus('Erasing...')

    try {
      const res = await fetch(`${API}/erase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await authHeaders(user) },
        body: JSON.stringify({
          image_id: imageId,
          erase_points: erasePoints.map((point) => [point.x, point.y]),
          erase_radius_px: eraseRadius,
          already_removed_ids: removedIds,
        }),
      })
      const data = await res.json()
      setAnalysisResult((prev) => ({
        ...prev,
        cluster_overlay_b64: data.cluster_overlay_b64,
        nclusters: data.nclusters,
        summary: data.summary,
        particles: data.particles,
      }))
      setRemovedIds(data.removed_ids)
      setErasePoints([])
      setStatus(`${data.removed_ids.length} clusters removed.`)
    } catch (err) {
      setStatus(`Erase failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }, [imageId, erasePoints, eraseRadius, removedIds])

  const fetchHistogram = async () => {
    if (!imageId) return
    setBusy(true)
    try {
      const res = await fetch(`${API}/histogram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await authHeaders(user) },
        body: JSON.stringify({ image_id: imageId, removed_cluster_ids: removedIds }),
      })
      const data = await res.json()
      setHistogramB64(data.histogram_b64)
    } catch (err) {
      setStatus(`Histogram failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const downloadCsv = () => {
    if (!analysisResult?.particles?.length) return
    const columns = Object.keys(analysisResult.particles[0])
    const csvRows = [
      columns.join(','),
      ...analysisResult.particles.map((row) => columns.map((column) => JSON.stringify(row[column] ?? '')).join(',')),
    ]
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'particle-analysis.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const downloadHistogram = () => {
    if (!histogramB64) return
    const link = document.createElement('a')
    link.href = `data:image/png;base64,${histogramB64}`
    link.download = 'particle-histogram.png'
    link.click()
  }

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || isInteractiveTarget(event.target) || busy) return

      const key = event.key.toLowerCase()

      if (key === '1') {
        event.preventDefault()
        setMode('reference')
        return
      }

      if (key === '2') {
        event.preventDefault()
        setMode('polygon')
        return
      }

      if (key === '4') {
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
    mode,
    runAnalysis,
    undoActivePoints,
  ])

  return (
    <div className="analyzer-app">
      <Sidebar
        settings={settings}
        onSettingsChange={setSettings}
        referencePreset={referencePreset}
        onPresetChange={handlePresetChange}
        referencePhysicalMm={referencePhysicalMm}
        onPhysicalMmChange={setReferencePhysicalMm}
      />

      <main className="analyzer-main">
        <header className="topbar">
          <h1>Coffee Grind Size Analyzer</h1>
          <UploadActions onUpload={handleUpload} />
        </header>

        {status && <div className="status">{busy ? 'Working... ' : ''}{status}</div>}

        {imageSrc && (
          <div className="toolbar">
            {MODES.map((item) => (
              <button
                key={item.id}
                className={`mode-btn ${mode === item.id ? 'active' : ''}`}
                style={{ '--mode-color': item.color }}
                onClick={() => setMode(item.id)}
              >
                {item.label}
              </button>
            ))}

            <div className="toolbar-sep" />

            {mode === 'reference' && (
              <>
                <span className="toolbar-hint">
                  {referencePoints.length < 2 ? `Click ${2 - referencePoints.length} more point(s)` : `OK ${pixelScale?.toFixed(2)} px/mm`}
                </span>
                <button onClick={undoActivePoints} disabled={!referencePoints.length}>Undo</button>
                <button onClick={clearActivePoints} disabled={!referencePoints.length}>Clear</button>
              </>
            )}

            {mode === 'polygon' && (
              <>
                <span className="toolbar-hint">{polygonPoints.length} point(s)</span>
                <button onClick={undoActivePoints} disabled={!polygonPoints.length}>Undo</button>
                <button onClick={clearActivePoints} disabled={!polygonPoints.length}>Clear</button>
              </>
            )}

            {mode === 'erase' && analysisResult && (
              <>
                <label className="toolbar-inline-field">
                  Radius
                  <input
                    type="number"
                    min={2}
                    max={500}
                    step={1}
                    value={eraseRadius}
                    onChange={(event) => setEraseRadius(parseInt(event.target.value, 10))}
                  />
                  px
                </label>
                <button onClick={applyErase} disabled={!erasePoints.length || busy} className="btn-primary">
                  Apply Erase
                </button>
                <button onClick={clearActivePoints} disabled={!erasePoints.length}>Clear</button>
                <button onClick={() => { setRemovedIds([]); setErasePoints([]); runAnalysis() }} disabled={busy}>Reset</button>
              </>
            )}

            <div className="toolbar-sep" />

            {analysisResult && (
              <div className="overlay-btns">
                {['original', 'threshold', 'clusters'].map((value) => (
                  <button key={value} className={overlayMode === value ? 'active' : ''} onClick={() => setOverlayMode(value)}>
                    {value.charAt(0).toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="canvas-area">
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
              overlayB64={overlayB64}
            />
          ) : (
            <div className="empty-state">
              <p>Upload an image to get started.</p>
              <UploadActions onUpload={handleUpload} large />
            </div>
          )}
        </div>

        {imageSrc && (
          <div className="action-bar">
            <button className="btn-primary btn-large" onClick={runAnalysis} disabled={busy}>
              {busy ? 'Running...' : '3 · Run Particle Detection'}
            </button>
            {analysisResult && (
              <button onClick={fetchHistogram} disabled={busy}>
                Show Histogram
              </button>
            )}
            {analysisResult && (
              <div className={`download-menu ${downloadsOpen ? 'open' : ''}`}>
                <button type="button" onClick={() => setDownloadsOpen((prev) => !prev)}>
                  Download
                </button>
                {downloadsOpen && (
                  <div className="download-menu-panel">
                    <button type="button" onClick={downloadCsv}>
                      Download CSV
                    </button>
                    <button type="button" onClick={downloadHistogram} disabled={!histogramB64}>
                      Download Current Chart
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <ResultsPanel result={analysisResult} histogramB64={histogramB64} />
      </main>
    </div>
  )
}
