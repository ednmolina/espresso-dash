import { useState, useCallback, useEffect, useRef } from 'react'
import ImageCanvas from './ImageCanvas'
import Sidebar from './Sidebar'
import ResultsPanel from './ResultsPanel'
import HistogramChart, { SERIES_COLORS } from './HistogramChart'
import { API, DEFAULT_SETTINGS, REFERENCE_OBJECTS } from '../constants'
import '../analyzer.css'

const STEPS = [
  { id: 'reference', n: '1', label: 'Scale', key: '1', color: '#e5484d' },
  { id: 'polygon', n: '2', label: 'Region', key: '2', color: '#2fa89a' },
  { id: 'detect', n: '3', label: 'Detect', key: '↵' },
  { id: 'erase', n: '4', label: 'Clean up', key: '4', color: '#f08c2e' },
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
    const detail = data?.detail
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`)
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
  const [savedRuns, setSavedRuns] = useState([])
  const [compare, setCompare] = useState(null)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [status, setStatus] = useState({ text: '', tone: 'info' })
  const [busy, setBusy] = useState(false)
  const objectUrlRef = useRef(null)

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

  const handleUpload = async (e) => {
    const input = e.target
    const file = input.files[0]
    if (!file) return
    input.value = ''

    setBusy(true)
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
      setMode('reference')
      say('Click both edges of your reference coin to set the scale.')
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
    say('Detecting particles…')
    const started = performance.now()

    try {
      const data = await apiRequest(user, '/analyze', {
        json: {
          image_id: imageId,
          ...settings,
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
      say(`${data.nclusters.toLocaleString()} particles detected in ${secs}s. Click stray clusters to remove them.`, 'success')
    } catch (err) {
      say(`Analysis failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [imageId, settings, referencePoints, referencePhysicalMm, polygonPoints, user])

  const applyErase = useCallback(async () => {
    if (!imageId || !erasePoints.length) return
    setBusy(true)
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
      setAnalysisResult((prev) => ({
        ...prev,
        cluster_layer_b64: data.cluster_layer_b64,
        nclusters: data.nclusters,
        summary: data.summary,
        particles: data.particles,
      }))
      setRemovedIds(data.removed_ids)
      setErasePoints([])
      setHistogram(null)
      say(`${data.removed_ids.length} clusters removed.`, 'success')
    } catch (err) {
      say(`Erase failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [imageId, erasePoints, eraseRadius, removedIds, user])

  const fetchHistogram = async () => {
    if (!imageId) return
    setBusy(true)
    try {
      const data = await apiRequest(user, '/histogram', {
        json: { image_id: imageId, removed_cluster_ids: removedIds, include_png: false },
      })
      setHistogram(data)
    } catch (err) {
      say(`Histogram failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

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
      particles: analysisResult.particles,
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
    setBusy(true)
    try {
      setCompare(await apiRequest(user, '/histogram/compare', { json: compareBody(false) }))
    } catch (err) {
      say(`Compare failed: ${err.message}`, 'error')
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
    downloadDataUrl(url, 'particle-analysis.csv')
    URL.revokeObjectURL(url)
  }

  // The PNG chart is rendered server-side only when someone asks for the file.
  const downloadHistogram = async () => {
    setBusy(true)
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
    setBusy(true)
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
    setHistogram(null)
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

  const activeColor = STEPS.find((s) => s.id === mode)?.color ?? '#8a7c6e'
  const unit = (compare?.unit ?? 'mm').replace(/\$\\mu\$/g, 'µ')

  return (
    <div className={`analyzer-app ${imageSrc ? 'has-image' : ''}`}>
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
                const isActive = mode === step.id
                const onClick = step.id === 'detect' ? runAnalysis : () => setMode(step.id)
                const disabled = busy || (step.id === 'erase' && !analysisResult)
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      className={`step ${isActive ? 'active' : ''} ${stepDone[step.id] ? 'done' : ''} ${step.id === 'detect' ? 'step-run' : ''}`}
                      style={step.color ? { '--step-color': step.color } : undefined}
                      onClick={onClick}
                      disabled={disabled}
                      title={`Shortcut: ${step.key}`}
                    >
                      <span className="step-n">{stepDone[step.id] && !isActive ? '✓' : step.n}</span>
                      {step.id === 'detect' && busy ? 'Running…' : step.label}
                    </button>
                  </li>
                )
              })}
            </ol>

            <div className="toolbar-context" style={{ '--mode-color': activeColor }}>
              {mode === 'reference' && (
                <>
                  <span className="toolbar-hint">
                    {referencePoints.length < 2
                      ? `Click ${2 - referencePoints.length} edge${referencePoints.length === 1 ? '' : 's'} of the coin`
                      : <><strong>{pixelScale?.toFixed(2)}</strong> px/mm</>}
                  </span>
                  <button className="ghost" onClick={undoActivePoints} disabled={!referencePoints.length}>Undo</button>
                  <button className="ghost" onClick={clearActivePoints} disabled={!referencePoints.length}>Clear</button>
                </>
              )}

              {mode === 'polygon' && (
                <>
                  <span className="toolbar-hint">
                    {polygonPoints.length < 3 ? 'Optional: click around the grounds to limit the analysis' : `${polygonPoints.length}-point region`}
                  </span>
                  <button className="ghost" onClick={undoActivePoints} disabled={!polygonPoints.length}>Undo</button>
                  <button className="ghost" onClick={clearActivePoints} disabled={!polygonPoints.length}>Clear</button>
                </>
              )}

              {mode === 'erase' && analysisResult && (
                <>
                  <label className="toolbar-inline-field">
                    Brush
                    <input
                      type="number"
                      min={2}
                      max={500}
                      step={1}
                      value={eraseRadius}
                      onChange={(event) => setEraseRadius(parseInt(event.target.value, 10) || 2)}
                    />
                    px
                  </label>
                  <button onClick={applyErase} disabled={!erasePoints.length || busy} className="btn-primary">
                    Remove {erasePoints.length ? `(${erasePoints.length})` : ''}
                  </button>
                  <button className="ghost" onClick={clearActivePoints} disabled={!erasePoints.length}>Clear</button>
                  <button className="ghost" onClick={() => { setRemovedIds([]); setErasePoints([]); runAnalysis() }} disabled={busy}>Reset</button>
                </>
              )}

              {mode === 'view' && <span className="toolbar-hint">Drag to pan · scroll or pinch to zoom</span>}
            </div>

            {analysisResult && (
              <div className="overlay-btns" role="group" aria-label="Overlay">
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
              layerB64={layerB64}
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
          {busy && imageSrc && <div className="canvas-busy"><span className="spinner" />Working…</div>}
        </div>

        {status.text && <div className={`status status-${status.tone}`} role="status">{status.text}</div>}
      </main>

      {imageSrc && (
        <aside className="results-column">
          {!analysisResult && (
            <div className="results-empty">
              <h3>Results</h3>
              <p>Set the scale, optionally draw a region, then run detection. Your size statistics will appear here.</p>
              <button className="btn-primary btn-large" onClick={runAnalysis} disabled={busy}>
                {busy ? 'Running…' : 'Run particle detection'}
              </button>
            </div>
          )}

          <ResultsPanel result={analysisResult} histogram={histogram} />

          {analysisResult && (
            <div className="results-actions">
              {!histogram && (
                <button onClick={fetchHistogram} disabled={busy || !analysisResult.summary}>Show histogram</button>
              )}
              {savedRuns.length < 3 && (
                <button onClick={saveRun} disabled={busy}>Save run ({savedRuns.length}/3)</button>
              )}
              <div className={`download-menu ${downloadsOpen ? 'open' : ''}`}>
                <button type="button" onClick={() => setDownloadsOpen((prev) => !prev)} aria-expanded={downloadsOpen}>
                  Download ▾
                </button>
                {downloadsOpen && (
                  <div className="download-menu-panel">
                    <button type="button" onClick={downloadCsv}>Particles (CSV)</button>
                    <button type="button" onClick={downloadHistogram} disabled={!analysisResult.summary || busy}>Histogram (PNG)</button>
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
                      <td>{run.summary?.cluster_count?.toLocaleString() ?? '—'}</td>
                      <td>{run.summary?.dv50_mm != null ? Math.round(run.summary.dv50_mm * 1000) : '—'}</td>
                      <td>{run.summary?.fines_volume_pct != null ? `${run.summary.fines_volume_pct.toFixed(1)}%` : '—'}</td>
                      <td>{run.summary?.diameter_mean_mm != null ? Math.round(run.summary.diameter_mean_mm * 1000) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {savedRuns.length >= 2 && !compare && (
                <button onClick={fetchCompareHistogram} disabled={busy}>Compare runs</button>
              )}
              {compare && (
                <div className="histogram">
                  <HistogramChart data={compare.series} stats={compare.per_run} scale={compare.scale ?? 1} unit={unit} />
                  {compare.combined && (
                    <div className="compare-summary">
                      <div><span>Mean of means</span><strong>{+(compare.combined.mean_of_means * (compare.scale ?? 1)).toPrecision(3)} {unit}</strong></div>
                      <div><span>Median of medians</span><strong>{+(compare.combined.median_of_medians * (compare.scale ?? 1)).toPrecision(3)} {unit}</strong></div>
                      <div><span>Run-to-run σ</span><strong>±{+(compare.combined.std_of_means * (compare.scale ?? 1)).toPrecision(2)} {unit}</strong></div>
                    </div>
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
