import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import ImageCanvas from './ImageCanvas'
import Sidebar from './Sidebar'
import ResultsPanel, { DistributionPanel, headlineOf } from './ResultsPanel'
import HistogramChart, { SERIES_COLORS } from './HistogramChart'
import GrindSettingPicker from './pages/GrindSettingPicker'
import { Sheet, useBreakpoint } from './shell'
import { DEFAULT_SETTINGS, REFERENCE_OBJECTS, settingsPayload } from '../constants'
import { createAnalyzerClient, disposeLocalEngine } from '../analysis/analyzerClient'
import {
  particlesToCsv,
  isNum, um, cleanUnit, formatSigma, sig,
} from '../analyzerUtils'
import { histogramKind, layerOf, mergeErase, normalizeSummary, previewSrc } from '../analyzerCompat'
import { useShots } from '../shotsStore'
import { useGrindCalibration } from '../useModels'
import { addRun, runFromSummary } from '../calibrationStore'
import { parseSetting } from '../grindCalibration'
import { useNav } from '../navigation'
import '../analyzer.css'

const HIDDEN_KEY = 'espressoLab.analyzer.resultsHidden.v1'

function readHidden() {
  try {
    const v = window.localStorage.getItem(HIDDEN_KEY)
    return v === 'true' || v === '1'
  } catch {
    return false
  }
}

function writeHidden(hidden) {
  try {
    window.localStorage.setItem(HIDDEN_KEY, String(hidden))
  } catch {
    // storage unavailable: the card just forgets its state on reload
  }
}

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
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.tagName === 'INPUT') return !['checkbox', 'radio', 'range'].includes(target.type)
  return ['TEXTAREA', 'SELECT'].includes(target.tagName)
}

function UploadActions({ onUpload, large = false, disabled = false }) {
  return (
    <div className={`upload-actions ${large ? 'large' : ''}`}>
      <label className={`upload-btn ${large ? 'large primary' : ''}`} aria-disabled={disabled || undefined}>
        Choose image
        <input type="file" accept="image/*" onChange={onUpload} disabled={disabled} hidden />
      </label>
      <label className={`upload-btn upload-btn-secondary ${large ? 'large' : ''}`} aria-disabled={disabled || undefined}>
        Take photo
        <input type="file" accept="image/*" capture="environment" onChange={onUpload} disabled={disabled} hidden />
      </label>
    </div>
  )
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

function ChevronIcon({ up = false }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={up ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function SlidersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" />
    </svg>
  )
}

function RulerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="note-icon">
      <path d="M3 17L17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" />
    </svg>
  )
}

// Where each phase of the on-device engine sits on the busy card's progress bar.
const PHASE_RANGE = {
  decode: [0, 1],
  resize: [0, 0.1],
  flatten: [0.1, 0.2],
  prelim: [0.2, 0.4],
  detect: [0.4, 0.85],
  measure: [0.85, 0.93],
  layers: [0.93, 1],
}

const isImageLayer = (l) => l != null && typeof l === 'object' && typeof l.close === 'function'

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
  const [histWeight, setHistWeight] = useState('mass')
  const [histExpanded, setHistExpanded] = useState(false)
  const [savedRuns, setSavedRuns] = useState([])
  const [compare, setCompare] = useState(null)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [status, setStatus] = useState({ text: '', tone: 'info' })
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('Working…')
  const [elapsed, setElapsed] = useState(0)
  const [progress, setProgress] = useState(0)
  const phaseRanges = useRef(PHASE_RANGE) // progress ranges of the current busy period
  const uploadSeq = useRef(0) // newest upload; older completions are ignored
  const cancelLostRuns = useRef(false) // the last cancel dropped the engine's stored analyses
  const [kbdOpen, setKbdOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [grindSetting, setGrindSetting] = useState('')
  const [calSavedFor, setCalSavedFor] = useState(null)
  const [resultsHidden, setResultsHidden] = useState(readHidden)
  const [sheetDetent, setSheetDetent] = useState('half') // phone: 'half' | 'full' while the results are shown
  const [dragH, setDragH] = useState(null)
  const objectUrlRef = useRef(null)
  const histSeq = useRef(0)
  const downloadRef = useRef(null)
  const kbdRef = useRef(null)
  const rootRef = useRef(null)
  const settingsWrapRef = useRef(null)
  const settingsButtonRef = useRef(null)
  const cardRef = useRef(null)
  const dragRef = useRef(null)
  const layerRefs = useRef(new Set())

  // One swap point: the on-device engine by default, Cloud Run with ?engine=cloud.
  const userRef = useRef(user)
  userRef.current = user
  const client = useMemo(() => createAnalyzerClient({ getUser: () => userRef.current }), [])
  const isLocal = client.mode === 'local'

  const isPhone = useBreakpoint() === 'phone'
  const { go } = useNav()
  const { shots } = useShots()
  const calibration = useGrindCalibration(shots)

  const say = (text, tone = 'info') => setStatus({ text, tone })

  const layer = overlayMode === 'original' ? null : layerOf(analysisResult, overlayMode)
  const layerB64 = typeof layer === 'string' ? layer : null
  const layerImage = layer != null && typeof layer !== 'string' ? layer : null
  const summary = analysisResult?.summary ?? null
  const nsum = normalizeSummary(summary)

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

  useEffect(() => { writeHidden(resultsHidden) }, [resultsHidden])

  // Progress from the on-device engine, as one monotonic 0..1 value per busy period.
  useEffect(() => client.onProgress(({ phase, fraction }) => {
    const [lo, hi] = phaseRanges.current[phase] ?? [0, 1]
    const v = lo + (hi - lo) * Math.max(0, Math.min(1, fraction ?? 0))
    setProgress((prev) => Math.max(prev, v))
  }), [client])

  // Leaving the analyzer frees the worker, the decoded photo and the stored results.
  useEffect(() => () => { if (isLocal) disposeLocalEngine() }, [isLocal])

  // Replaced ImageBitmap layers are closed (not those the new result still uses).
  useEffect(() => {
    const current = new Set()
    for (const key of ['threshold_layer', 'cluster_layer']) {
      const l = analysisResult?.[key]
      if (isImageLayer(l)) current.add(l)
    }
    for (const old of layerRefs.current) {
      if (!current.has(old)) { try { old.close() } catch { /* already closed */ } }
    }
    layerRefs.current = current
  }, [analysisResult])
  useEffect(() => () => {
    for (const l of layerRefs.current) { try { l.close() } catch { /* already closed */ } }
    layerRefs.current = new Set()
  }, [])

  // On a phone the analyzer fills the screen between the top bar and the tab bar.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return undefined
    if (!isPhone) {
      el.style.removeProperty('--analyzer-top')
      return undefined
    }
    const update = () => {
      const top = el.getBoundingClientRect().top + window.scrollY
      el.style.setProperty('--analyzer-top', `${Math.max(0, Math.round(top))}px`)
    }
    update()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    ro?.observe(document.documentElement)
    ro?.observe(el)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [isPhone])

  // Elapsed-seconds counter for the busy card.
  useEffect(() => {
    if (!busy) { setElapsed(0); return undefined }
    const t0 = performance.now()
    const id = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100)
    return () => clearInterval(id)
  }, [busy])

  const startBusy = (label) => {
    // Detecting may first re-decode the photo (after a cancel), so decode only fills the
    // first tenth of the bar there instead of running it to 100% before detection starts.
    cancelLostRuns.current = false
    phaseRanges.current = label.startsWith('Detecting') ? { ...PHASE_RANGE, decode: [0, 0.1] } : PHASE_RANGE
    setBusyLabel(label); setProgress(0); setBusy(true)
  }

  // Cancel terminates the on-device worker, and the analyses stored in it die with it.
  const cancelBusy = () => {
    const lost = client.cancel()
    if (lost && savedRuns.length > 0) {
      cancelLostRuns.current = true
      setSavedRuns([])
      setCompare(null)
    }
  }
  // Status text for a cancelled operation; says so when the saved runs went with it.
  const sayCancelled = (text) => {
    if (cancelLostRuns.current) {
      cancelLostRuns.current = false
      say('Cancelled — saved runs were cleared; re-run to compare.')
    } else say(text)
  }
  const wasCancelled = (err) => err?.status === 499
  // After a cancel the on-device results are gone; say what to do instead of a bare 404.
  const withHint = (err) => (isLocal && err?.status === 404 ? `${err.message} Run detection again.` : err.message)

  const handleUpload = async (e) => {
    const input = e.target
    const file = input.files[0]
    if (!file) return
    input.value = ''
    if (busy) return // uploads are serialised against running operations
    const seq = ++uploadSeq.current

    const loadingText = isLocal ? 'Loading photo…' : 'Uploading…'
    startBusy(loadingText)
    say(loadingText)

    const form = new FormData()
    form.append('file', file)

    try {
      // Show the local file straight away instead of downloading it back from
      // the server. The server applies EXIF rotation exactly like browsers do;
      // if the sizes disagree (or the browser can't decode the format), fall
      // back to the server's rendering so clicks map to the analysed pixels.
      // Older servers already return the image in the upload response, so
      // /preview is only called when that is missing.
      const localUrl = URL.createObjectURL(file)
      const probe = probeImage(localUrl)
      const [data, local] = await Promise.all([
        // `expect`: the on-device engine compares its decode with what the browser shows
        // (EXIF rotation) and redoes the decode when they disagree; the cloud path ignores it.
        client.request('/upload', { form, expect: probe }),
        probe,
      ])
      let src = localUrl
      if (!local || local.width !== data.width || local.height !== data.height) {
        URL.revokeObjectURL(localUrl)
        src = previewSrc(data)
        if (!src) {
          const preview = await client.request(`/preview/${data.image_id}`, { method: 'GET' })
          src = `data:${preview.image_mime};base64,${preview.image_b64}`
        }
      }
      if (seq !== uploadSeq.current) {
        // a newer upload started while this one was decoding: keep the newer photo
        if (src.startsWith('blob:')) URL.revokeObjectURL(src)
        return
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
      setHistExpanded(false)
      setMode('reference')
      say('Click one edge of your reference coin to set the scale.')
    } catch (err) {
      if (seq !== uploadSeq.current) return
      if (wasCancelled(err)) sayCancelled('Cancelled.')
      else say(`${isLocal ? 'Could not load the photo' : 'Upload failed'}: ${err.message}`, 'error')
    } finally {
      if (seq === uploadSeq.current) setBusy(false)
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
  const loadHistogram = useCallback(async (ids, weight) => {
    if (!imageId) return
    const seq = ++histSeq.current
    setHistogramLoading(true)
    try {
      const data = await client.request('/histogram', {
        json: { image_id: imageId, removed_cluster_ids: ids, include_png: false, weight_mode: weight },
      })
      if (seq === histSeq.current) setHistogram(data)
    } catch (err) {
      if (seq === histSeq.current) say(`Histogram failed: ${withHint(err)}`, 'error')
    } finally {
      if (seq === histSeq.current) setHistogramLoading(false)
    }
  }, [imageId, client, isLocal])

  const changeWeight = (weight) => {
    if (weight === histWeight) return
    setHistWeight(weight)
    if (analysisResult?.summary) loadHistogram(removedIds, weight)
  }

  const canDetect = referencePoints.length === 2

  const runAnalysis = useCallback(async () => {
    if (!imageId || busy) return
    if (!canDetect) { say('Set the scale first: click both edges of the coin.', 'error'); return }
    startBusy('Detecting particles…')
    say('Detecting particles…')
    const started = performance.now()

    try {
      const data = await client.request('/analyze', {
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
      setHistExpanded(false)
      setOverlayMode('clusters')
      setMode('erase')
      setDownloadsOpen(false)
      const secs = ((performance.now() - started) / 1000).toFixed(1)
      say(`${(data.nclusters ?? 0).toLocaleString()} particles detected in ${secs}s. Click stray clusters to remove them.`, 'success')
      if (data.summary) loadHistogram([], histWeight)
    } catch (err) {
      if (wasCancelled(err)) sayCancelled('Detection cancelled.')
      else say(`Detection failed: ${err.message}. Try lowering Threshold or Analysis resolution.`, 'error')
    } finally {
      setBusy(false)
    }
  }, [imageId, busy, canDetect, settings, referencePoints, referencePhysicalMm, polygonPoints, client, loadHistogram, histWeight])

  const applyErase = useCallback(async () => {
    if (!imageId || !erasePoints.length) return
    startBusy('Removing clusters…')
    say('Removing clusters…')

    try {
      const data = await client.request('/erase', {
        json: {
          image_id: imageId,
          erase_points: erasePoints.map((point) => [point.x, point.y]),
          erase_radius_px: eraseRadius,
          already_removed_ids: removedIds,
        },
      })
      const gone = data.removed_ids ?? removedIds
      // newer servers send a transparent layer and no particles, older ones an opaque composite
      setAnalysisResult((prev) => mergeErase(prev, data, gone))
      setRemovedIds(gone)
      setErasePoints([])
      setHistogram(null)
      const added = gone.length - removedIds.length
      say(added > 0 ? `${added} cluster${added === 1 ? '' : 's'} removed (${gone.length} in total).` : 'No clusters under the brush.', added > 0 ? 'success' : 'info')
      if ((data.summary ?? analysisResult?.summary)) loadHistogram(gone, histWeight)
    } catch (err) {
      if (wasCancelled(err)) sayCancelled('Cancelled.')
      else say(`Erase failed: ${withHint(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [imageId, erasePoints, eraseRadius, removedIds, client, isLocal, loadHistogram, analysisResult, histWeight])

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

  const parsedSetting = parseSetting(grindSetting)
  const calibrationDone = calSavedFor != null && calSavedFor === summary
  const canSaveCalibration = Boolean(summary && parsedSetting && !calibrationDone && !busy)
  const calibrationTitle = !summary
    ? 'Run detection first'
    : !parsedSetting
      ? 'Pick the setting you used'
      : calibrationDone
        ? 'Already saved for this result'
        : undefined

  const saveCalibration = () => {
    if (!canSaveCalibration) return
    const partial = runFromSummary(summary, { grindSetting: parsedSetting.label, nclusters: analysisResult?.nclusters })
    if (!partial) { say('This result has no size to add to the grinder curve.', 'error'); return }
    const res = addRun(partial)
    if (!res?.ok) { say(`Could not save the calibration point${res?.error ? `: ${res.error}` : ''}.`, 'error'); return }
    setCalSavedFor(summary)
    const size = isNum(partial.mean_um)
      ? `${Math.round(partial.mean_um).toLocaleString()} µm mean`
      : `${Math.round(partial.dv50_um).toLocaleString()} µm Dv50`
    say(
      `Calibration point saved (${parsedSetting.label} · ${size}).${res.persisted === false ? " It could not be stored in this browser, so it will be gone after a reload." : ''}`,
      res.persisted === false ? 'info' : 'success',
    )
  }

  const compareBody = (includePng) => ({
    runs: savedRuns.map((r) => ({ image_id: r.imageId, removed_cluster_ids: r.removedIds, label: r.label })),
    include_png: includePng,
  })

  const fetchCompareHistogram = async () => {
    if (savedRuns.length < 2) return
    startBusy('Comparing runs…')
    try {
      setCompare(await client.request('/histogram/compare', { json: compareBody(false) }))
    } catch (err) {
      if (wasCancelled(err)) sayCancelled('Cancelled.')
      else say(`Compare failed: ${withHint(err)}`, 'error')
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
      const data = await client.request('/histogram', {
        json: { image_id: imageId, removed_cluster_ids: removedIds, include_png: true, weight_mode: histWeight },
      })
      downloadDataUrl(`data:image/png;base64,${data.histogram_b64}`, 'particle-histogram.png')
    } catch (err) {
      if (wasCancelled(err)) sayCancelled('Cancelled.')
      else say(`Download failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
      setDownloadsOpen(false)
    }
  }

  const downloadCompare = async () => {
    startBusy('Rendering chart…')
    try {
      const data = await client.request('/histogram/compare', { json: compareBody(true) })
      downloadDataUrl(`data:image/png;base64,${data.histogram_b64}`, 'run-comparison.png')
    } catch (err) {
      if (wasCancelled(err)) sayCancelled('Cancelled.')
      else say(`Download failed: ${err.message}`, 'error')
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

  // Settings popover (desktop/tablet): close on outside click and Esc.
  const closeSettings = useCallback((restoreFocus = true) => {
    setSettingsOpen(false)
    if (restoreFocus) settingsButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!settingsOpen || isPhone) return undefined
    const onDown = (e) => {
      if (settingsWrapRef.current && !settingsWrapRef.current.contains(e.target) && !e.target.closest?.('.help-tip-portal')) {
        setSettingsOpen(false)
      }
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeSettings() }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [settingsOpen, isPhone, closeSettings])

  useEffect(() => { if (kbdOpen) kbdRef.current?.focus() }, [kbdOpen])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || isInteractiveTarget(event.target)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      // A focused button keeps its native Enter/Space activation.
      if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON' &&
          (event.key === 'Enter' || event.code === 'Space')) return
      // While the settings are open, keys belong to them.
      if (settingsOpen) return

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
    settingsOpen,
    undoActivePoints,
  ])

  // ---- results card / phone sheet --------------------------------------------------------
  const hasResults = Boolean(analysisResult)
  const detent = resultsHidden ? 'pill' : sheetDetent
  const headline = headlineOf(summary)

  const showResults = () => { setResultsHidden(false) }
  const hideResults = () => { setResultsHidden(true) }
  const sheetStepDown = () => {
    if (resultsHidden) return
    if (sheetDetent === 'full') setSheetDetent('half')
    else setResultsHidden(true)
  }
  const sheetStepUp = () => {
    if (resultsHidden) { setResultsHidden(false); setSheetDetent('half') } else setSheetDetent('full')
  }
  const sheetTap = () => {
    if (resultsHidden) { setResultsHidden(false); setSheetDetent('half') } else setSheetDetent((d) => (d === 'half' ? 'full' : 'half'))
  }

  const onHandleDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const card = cardRef.current
    if (!card) return
    dragRef.current = { startY: e.clientY, startH: card.offsetHeight, t: e.timeStamp, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onHandleMove = (e) => {
    const d = dragRef.current
    const card = cardRef.current
    if (!d || !card) return
    const dy = e.clientY - d.startY
    if (Math.abs(dy) > 4) d.moved = true
    if (d.moved) {
      const maxH = (card.parentElement?.clientHeight ?? 600) - 56
      setDragH(Math.max(64, Math.min(maxH, d.startH - dy)))
    }
  }
  const onHandleUp = (e) => {
    const d = dragRef.current
    dragRef.current = null
    setDragH(null)
    if (!d) return
    const dy = e.clientY - d.startY
    const velocity = dy / Math.max(e.timeStamp - d.t, 1)
    if (dy > 60 || (dy > 24 && velocity > 0.6)) sheetStepDown()
    else if (dy < -60 || (dy < -24 && velocity < -0.6)) sheetStepUp()
    else if (!d.moved) sheetTap()
  }
  const onHandleKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sheetStepDown() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sheetStepUp() }
  }

  const activeColor = STEPS.find((s) => s.id === mode)?.color ?? 'var(--el-text-2)'
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

  // ---- calibration row -------------------------------------------------------------------
  const estimate = parsedSetting ? calibration.estimate(parsedSetting.label) : null
  let estimateText
  if (!parsedSetting) estimateText = 'Pick the setting you used'
  else if (!estimate || !isNum(estimate.um)) estimateText = 'No grinder curve yet'
  else {
    estimateText = `${parsedSetting.label} ≈ ${Math.round(estimate.um).toLocaleString()} µm`
    if (estimate.kind === 'curve' && isNum(estimate.low) && isNum(estimate.high)) {
      estimateText += ` · likely ${Math.round(estimate.low).toLocaleString()}–${Math.round(estimate.high).toLocaleString()} µm`
    } else if (estimate.kind !== 'curve') {
      estimateText += ' · typical of your points, no curve yet'
    }
  }
  let matchText = null
  if (estimate?.kind === 'curve' && isNum(estimate.low) && isNum(estimate.high) && nsum.meanMm != null) {
    const measured = Math.round(nsum.meanMm * 1000)
    const inside = measured >= estimate.low && measured <= estimate.high
    matchText = inside
      ? `This photo measured ${measured.toLocaleString()} µm, inside the likely range.`
      : `This photo measured ${measured.toLocaleString()} µm, outside the likely range. Saving will pull the curve toward it.`
  }

  const calibrationRow = analysisResult ? (
    <section className="calibration-row" aria-label="Grinder calibration">
      <div className="cal-main">
        <GrindSettingPicker
          value={grindSetting}
          onChange={(next) => setGrindSetting(next)}
          layout="macro-micro"
          tone={isPhone ? 'dark' : 'light'}
          allowEmpty
          testId="grind-picker"
          label="Grind setting used"
        />
        <div className="cal-estimate">
          <RulerIcon />
          <div className="cal-estimate-text">
            <span className="cal-estimate-main" data-testid="grind-estimate" aria-live="polite">{estimateText}</span>
            <span className="cal-estimate-sub">
              {matchText && <>{matchText} </>}
              <button type="button" className="link-button" data-testid="see-calibration" onClick={() => go('grinder')}>See calibration</button>
            </span>
          </div>
        </div>
      </div>
      <div className="cal-save">
        <button
          type="button"
          className="btn-primary"
          data-testid="save-calibration"
          onClick={saveCalibration}
          disabled={!canSaveCalibration}
          title={calibrationTitle}
        >
          Save calibration point
        </button>
        <span className="cal-note">Adds a point to the Grinder curve. Stored in this browser.</span>
      </div>
    </section>
  ) : null

  const distribution = analysisResult && histExpanded ? (
    <DistributionPanel
      histogram={histogram}
      loading={histogramLoading}
      summary={summary}
      weight={histWeight}
      onWeightChange={changeWeight}
      tone={isPhone ? 'dark' : 'light'}
    />
  ) : null

  const runsPanel = analysisResult ? (
    <section className="runs-panel" aria-label="Runs">
      <div className="results-actions">
        <button type="button" onClick={saveRun} disabled={busy || savedRuns.length >= 3}>Save run ({savedRuns.length}/3)</button>
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

      {savedRuns.length > 0 && (
        <section className="results-section saved-runs-panel">
          <div className="results-heading">
            <h3>Saved runs</h3>
            <button type="button" className="ghost small" onClick={clearRuns} disabled={busy}>Clear</button>
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
            <button type="button" className="btn-primary" onClick={fetchCompareHistogram} disabled={busy}>Compare runs</button>
          )}
          {compare && (
            <div className="histogram">
              {histogramKind(compare) === 'png' ? (
                <img className="histogram-png" alt="Size distribution of the saved runs" src={`data:image/png;base64,${compare.histogram_b64}`} />
              ) : (
                <HistogramChart data={compare.series} stats={compare.per_run} scale={cscale} unit={unit} tone={isPhone ? 'dark' : 'light'} />
              )}
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
              <button type="button" className="ghost small" onClick={downloadCompare} disabled={busy}>Download comparison (PNG)</button>
            </div>
          )}
        </section>
      )}
    </section>
  ) : null

  const resultsBody = (
    <ResultsPanel
      result={analysisResult}
      histogram={histogram}
      histogramLoading={histogramLoading}
      weight={histWeight}
      expanded={histExpanded}
      onToggleExpand={() => {
        if (isPhone && !histExpanded) setSheetDetent('full')
        setHistExpanded((v) => !v)
      }}
    />
  )

  const emptyCard = (
    <aside className="results-column results-card is-empty" aria-label="Results" data-testid="results-card-empty">
      <div className="results-empty">
        <h3>No results yet</h3>
        <ul className="checklist">
          <li className={stepDone.reference ? 'done' : ''}><span aria-hidden="true">{stepDone.reference ? '☑' : '☐'}</span> Scale set</li>
          <li className={stepDone.polygon ? 'done' : ''}><span aria-hidden="true">{stepDone.polygon ? '☑' : '☐'}</span> Region (optional)</li>
          <li><span aria-hidden="true">☐</span> Detect</li>
        </ul>
        <button type="button" className="btn-primary btn-large" onClick={runAnalysis} disabled={detectDisabled} title={detectTitle}>
          {busy && busyLabel.startsWith('Detecting') ? 'Running…' : 'Run particle detection'}
        </button>
      </div>
    </aside>
  )

  const headlineText = headline ? `${headline.label} ${um(headline.mm)} µm` : 'Results'

  const desktopCard = hasResults && !isPhone ? (
    <>
      <aside
        ref={cardRef}
        className={`results-column results-card ${resultsHidden ? 'is-hidden' : ''}`}
        aria-label="Results"
        aria-hidden={resultsHidden ? 'true' : undefined}
        data-testid="results-card"
      >
        <div className="card-top">
          <button
            type="button"
            className="card-toggle"
            data-testid="results-toggle"
            aria-expanded={!resultsHidden}
            aria-label="Hide results"
            onClick={hideResults}
            tabIndex={resultsHidden ? -1 : 0}
          >
            Hide
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 8h8v8" /><path d="M16 8L6 18" /></svg>
          </button>
        </div>
        {resultsBody}
      </aside>
      <button
        type="button"
        className={`results-pill ${resultsHidden ? 'is-shown' : ''}`}
        data-testid="results-pill"
        aria-expanded={!resultsHidden}
        aria-label={`Show results, ${headline ? `${headline.label} ${um(headline.mm)} micrometres` : 'summary'}`}
        onClick={showResults}
        tabIndex={resultsHidden ? 0 : -1}
      >
        <span className="pill-text"><span className="pill-label">{headline?.label ?? 'Results'}</span> {headline ? `${um(headline.mm)} µm` : ''}</span>
        <ChevronIcon />
      </button>
    </>
  ) : null

  const phoneSheet = hasResults && isPhone ? (
    <aside
      ref={cardRef}
      className={`results-column results-card is-sheet ${dragH != null ? 'is-dragging' : ''}`}
      aria-label="Results"
      data-testid="results-card"
      data-detent={detent}
      style={dragH != null ? { height: `${dragH}px` } : undefined}
    >
      <button
        type="button"
        className="sheet-handle"
        data-testid="results-handle"
        aria-label="Resize results"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={() => { dragRef.current = null; setDragH(null) }}
        onKeyDown={onHandleKey}
        onClick={(e) => { if (e.detail === 0) sheetTap() }}
      >
        <span aria-hidden="true" />
      </button>
      <div className="sheet-head">
        {detent === 'pill' ? (
          <button type="button" className="sheet-headline" data-testid="results-pill" onClick={showResults} aria-label={`Show results, ${headlineText}`}>
            <span className="pill-label">{headline?.label ?? 'Results'}</span> {headline ? `${um(headline.mm)} µm` : ''}
          </button>
        ) : (
          <h3 className="card-title">Results</h3>
        )}
        <button
          type="button"
          className="card-toggle"
          data-testid="results-toggle"
          aria-expanded={!resultsHidden}
          aria-label={resultsHidden ? 'Show results' : 'Hide results'}
          onClick={() => (resultsHidden ? showResults() : hideResults())}
        >
          {resultsHidden ? 'Show' : 'Hide'}
          <span className={`toggle-chevron ${resultsHidden ? 'is-up' : ''}`}><ChevronIcon /></span>
        </button>
      </div>
      <div className="sheet-body">
        {resultsBody}
        {distribution}
        <div className="sheet-divider" />
        {calibrationRow}
        {runsPanel}
      </div>
    </aside>
  ) : null

  const settingsContent = (
    <Sidebar
      settings={settings}
      onSettingsChange={setSettings}
      referencePreset={referencePreset}
      onPresetChange={handlePresetChange}
      referencePhysicalMm={referencePhysicalMm}
      onPhysicalMmChange={setReferencePhysicalMm}
      onClose={isPhone ? undefined : () => closeSettings()}
      showTitle={!isPhone}
    />
  )

  return (
    <div
      ref={rootRef}
      className={`analyzer-app ${imageSrc ? 'has-image' : ''} ${isPhone ? 'is-phone' : ''} ${analysisResult ? 'has-results' : ''}`}
      data-testid="analyzer-app"
    >
      <header className="analyzer-head">
        <h1>Grind Analyzer</h1>
        <div className="analyzer-head-actions">
          {imageSrc && !isPhone && <UploadActions onUpload={handleUpload} disabled={busy} />}
          <div className="settings-wrap" ref={settingsWrapRef}>
            <button
              type="button"
              ref={settingsButtonRef}
              className="settings-button"
              data-testid="settings-open"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <SlidersIcon /> Settings
            </button>
            {!isPhone && (
              <div
                className="settings-popover"
                role="dialog"
                aria-label="Analyzer settings"
                hidden={!settingsOpen}
              >
                {settingsContent}
              </div>
            )}
          </div>
        </div>
      </header>

      {isPhone && (
        <Sheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title="Settings"
          rightAction={{ label: 'Done', onClick: () => setSettingsOpen(false) }}
          detents={['medium', 'large']}
          initialDetent="large"
          testId="analyzer-settings-sheet"
        >
          <div className="settings-sheet-body">
            {imageSrc && (
              <div className="settings-photo">
                <span className="settings-photo-label">Photo</span>
                <UploadActions onUpload={handleUpload} disabled={busy} />
              </div>
            )}
            {settingsContent}
          </div>
        </Sheet>
      )}

      {imageSrc && (
        <div className="toolbar">
          <ol className="stepper" aria-label="Steps">
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
                <button type="button" className="ghost" onClick={undoActivePoints} disabled={!referencePoints.length}>Undo</button>
                <button type="button" className="ghost" onClick={clearActivePoints} disabled={!referencePoints.length}>Clear</button>
              </>
            )}

            {mode === 'polygon' && (
              <>
                <span className="toolbar-hint">
                  {!regionClosed
                    ? 'Optional: outline the grounds (3+ points) or skip to Detect'
                    : `${polygonPoints.length}-point region · click the first point to close`}
                </span>
                <button type="button" className="ghost" onClick={undoActivePoints} disabled={!polygonPoints.length}>Undo</button>
                <button type="button" className="ghost" onClick={clearActivePoints} disabled={!polygonPoints.length}>Clear</button>
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
                  type="button"
                  onClick={applyErase}
                  disabled={!erasePoints.length || busy}
                  className="btn-primary"
                  title={erasePoints.length ? 'Remove the marked clusters (Enter)' : 'Click particles to mark them'}
                >
                  Remove{erasePoints.length ? ` (${erasePoints.length})` : ''}
                </button>
                <button type="button" className="ghost" onClick={clearActivePoints} disabled={!erasePoints.length}>Clear</button>
              </>
            )}

            {mode === 'view' && <span className="toolbar-hint">Drag to pan · scroll or pinch to zoom</span>}
          </div>

          <button
            type="button"
            className={`btn-primary toolbar-primary ${analysisResult && mode === 'erase' ? 'is-rerun' : ''}`}
            onClick={runAnalysis}
            disabled={detectDisabled}
            title={detectTitle}
          >
            {busy && busyLabel.startsWith('Detecting') ? 'Detecting…' : runLabel}
          </button>
        </div>
      )}

      <div className={`canvas-area ${imageSrc ? '' : 'is-empty'}`} aria-busy={busy ? 'true' : 'false'}>
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
            layerImage={layerImage}
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
            <UploadActions onUpload={handleUpload} large disabled={busy} />
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

        {imageSrc && !analysisResult && !isPhone && emptyCard}
        {desktopCard}
        {phoneSheet}

        {busy && imageSrc && (
          <div className="canvas-scrim">
            <div className="busy-card" role="status">
              <div className="busy-title"><span className="spinner" aria-hidden="true" />{busyLabel}</div>
              {isLocal ? (
                <div
                  className="busy-progress"
                  role="progressbar"
                  aria-label={busyLabel}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress * 100)}
                >
                  <i style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              ) : (
                <div className="busy-bar" aria-hidden="true"><i /></div>
              )}
              <div className="busy-foot">
                <div className="busy-elapsed">{elapsed.toFixed(1)} s</div>
                {isLocal && <button type="button" className="ghost small busy-cancel" onClick={cancelBusy}>Cancel</button>}
              </div>
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

      {!isPhone && imageSrc && analysisResult && (
        <div className="analyzer-below">
          {calibrationRow}
          {distribution}
          {runsPanel}
        </div>
      )}
    </div>
  )
}
