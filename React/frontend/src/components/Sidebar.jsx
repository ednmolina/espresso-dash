import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { REFERENCE_OBJECTS, DEFAULT_SETTINGS, LEGACY_SETTINGS, MEASUREMENT_KEYS } from '../constants'

const fillStyle = (value, min, max) => ({ '--fill': `${Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))}%` })

function HelpTip({ text, label }) {
  const buttonRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  const updatePosition = () => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const tooltipWidth = 240
    const tooltipHeight = 92
    const left = Math.min(
      Math.max(rect.right - tooltipWidth, 12),
      window.innerWidth - tooltipWidth - 12,
    )
    const preferredTop = rect.bottom + 8
    const top = preferredTop + tooltipHeight > window.innerHeight - 12
      ? rect.top - tooltipHeight - 8
      : preferredTop
    setPosition({ top, left })
  }

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const handleWindowChange = () => updatePosition()
    window.addEventListener('resize', handleWindowChange)
    window.addEventListener('scroll', handleWindowChange, true)
    return () => {
      window.removeEventListener('resize', handleWindowChange)
      window.removeEventListener('scroll', handleWindowChange, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="help-tip"
        aria-label={`${label}: ${text}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {open && createPortal(
        <div
          className="help-tip-portal"
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`,
          }}
          role="tooltip"
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * Analyzer settings. Rendered inside a popover (desktop/tablet) or a Sheet (phone);
 * `onClose` adds a Done button, `showTitle={false}` drops the heading when the host supplies one.
 */
export default function Sidebar({ settings, onSettingsChange, referencePreset, onPresetChange, referencePhysicalMm, onPhysicalMmChange, onClose, showTitle = true }) {
  const set = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : parseFloat(e.target.value)
    onSettingsChange({ ...settings, [key]: val })
  }
  const setStr = (key) => (e) => onSettingsChange({ ...settings, [key]: e.target.value })
  const isLegacy = MEASUREMENT_KEYS.every((k) => settings[k] === LEGACY_SETTINGS[k])
  const toggleLegacy = (e) => {
    const patch = {}
    for (const k of MEASUREMENT_KEYS) patch[k] = e.target.checked ? LEGACY_SETTINGS[k] : DEFAULT_SETTINGS[k]
    // keep a user-entered diameter cutoff either way
    patch.min_diameter_um = settings.min_diameter_um
    onSettingsChange({ ...settings, ...patch })
  }

  return (
    <div className="analyzer-sidebar" aria-label="Analyzer settings">
      <div className="sidebar-body" id="analyzer-settings-body">
      {showTitle && (
        <div className="sidebar-title">
          <h2>Settings</h2>
          <p>Defaults work for most photos.</p>
        </div>
      )}
      <h3>Detection</h3>

      <label>
        <span className="label-row">
          <span>Threshold (%)</span>
          <HelpTip
            label="Threshold"
            text="Higher values detect fewer, darker pixels. Lower values include more of the image and can merge nearby grounds."
          />
        </span>
        <input type="range" style={fillStyle(settings.threshold_percent, 1, 100)} min={1} max={100} step={0.1} value={settings.threshold_percent} onChange={set('threshold_percent')} />
        <output className="range-value">{settings.threshold_percent.toFixed(1)}</output>
      </label>

      <label>
        <span className="label-row">
          <span>Reference threshold</span>
          <HelpTip
            label="Reference Threshold"
            text="Used when splitting touching particles: how dark a pixel must be (between a particle's darkest pixel and the background) to anchor a particle. Lower values split clumps more readily."
          />
        </span>
        <input type="range" style={fillStyle(settings.reference_threshold, 0, 1)} min={0} max={1} step={0.01} value={settings.reference_threshold} onChange={set('reference_threshold')} />
        <output className="range-value">{settings.reference_threshold.toFixed(2)}</output>
      </label>

      <h3>Breakup &amp; filters</h3>
      <label>
        <span className="label-row">
          <span>Breakup cost</span>
          <HelpTip
            label="Cluster Breakup Cost"
            text="Lower values split touching particles more aggressively. Higher values keep borderline clusters together."
          />
        </span>
        <input type="range" style={fillStyle(settings.max_cost, 0.01, 1)} min={0.01} max={1} step={0.01} value={settings.max_cost} onChange={set('max_cost')} />
        <output className="range-value">{settings.max_cost.toFixed(2)}</output>
      </label>

      <label>
        <span className="label-row">
          <span>Max particle radius (px)</span>
          <HelpTip
            label="Max Cluster Axis"
            text="Upper size limit for a single detected particle before it is treated as suspiciously large."
          />
        </span>
        <input type="number" min={1} step={1} value={settings.max_cluster_axis} onChange={set('max_cluster_axis')} />
      </label>

      <label>
        <span className="label-row">
          <span>Min area (px²)</span>
          <HelpTip
            label="Min Surface"
            text="Filters out tiny specks and sensor noise. Increase it if dust is being counted as particles."
          />
        </span>
        <input type="number" min={1} step={1} value={settings.min_surface} onChange={set('min_surface')} />
      </label>

      <label>
        <span className="label-row">
          <span>Min roundness</span>
          <HelpTip
            label="Min Roundness"
            text="Rejects long, irregular shapes. Leave near zero unless scratches or background artifacts are getting through."
          />
        </span>
        <input type="number" min={0} max={1} step={0.01} value={settings.min_roundness} onChange={set('min_roundness')} />
      </label>

      <label className="checkbox">
        <input type="checkbox" checked={settings.quick_mode} onChange={set('quick_mode')} />
        <span className="label-row">
          <span>Quick mode (skip breakup)</span>
          <HelpTip
            label="Quick clustering"
            text="Skips the pass that splits touching particles. Faster, but clumps are counted as one large particle."
          />
        </span>
      </label>

      <label>
        <span className="label-row">
          <span>Analysis resolution</span>
          <HelpTip
            label="Analysis Resolution"
            text="Lower resolutions run much faster but reduce particle detail. Start at 50 to 75 percent for large photos, then rerun at 100 percent for final results."
          />
        </span>
        <select value={settings.analysis_scale_pct} onChange={(e) => onSettingsChange({ ...settings, analysis_scale_pct: parseInt(e.target.value) })}>
          {[100, 75, 50, 33, 25].map(v => <option key={v} value={v}>{v}%</option>)}
        </select>
      </label>


      <details className="advanced">
        <summary>Advanced / measurement model</summary>
        <div className="advanced-body">
          <label className="checkbox legacy-toggle">
            <input type="checkbox" checked={isLegacy} onChange={toggleLegacy} />
            <span className="label-row">
              <span>Legacy (original algorithm)</span>
              <HelpTip
                label="Legacy preset"
                text="Reproduces the original analyzer: global threshold, fixed threshold level, no edge correction. Use it to compare with earlier results."
              />
            </span>
          </label>

          <label>
            <span className="label-row">
              <span>Background model</span>
              <HelpTip label="Background model" text="Flatten uneven lighting before thresholding. 'poly4' fits a smooth 4th-order surface to the paper; 'global' assumes even light." />
            </span>
            <select value={settings.background_model} onChange={setStr('background_model')}>
              <option value="poly4">Flatten lighting (poly4)</option>
              <option value="global">Global (none)</option>
            </select>
          </label>

          <label>
            <span className="label-row">
              <span>Threshold mode</span>
              <HelpTip label="Threshold mode" text="'Half contrast' puts the edge midway between paper and particle brightness, which sizes pale or blurry grounds more accurately. 'Fixed' uses the Threshold (%) slider as is." />
            </span>
            <select value={settings.threshold_mode} onChange={setStr('threshold_mode')}>
              <option value="half_contrast">Half contrast (adaptive)</option>
              <option value="fixed">Fixed (slider value)</option>
            </select>
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={!!settings.edge_correction} onChange={set('edge_correction')} />
            <span className="label-row">
              <span>Edge correction</span>
              <HelpTip label="Edge correction" text="Weights statistics to compensate for large particles being cut off at the image or region border." />
            </span>
          </label>

          <label>
            <span className="label-row">
              <span>Axis method</span>
              <HelpTip label="Axis method" text="How particle axes are measured. Max radius is the original method; moments is based on the shape's second moments." />
            </span>
            <select value={settings.axis_method} onChange={setStr('axis_method')}>
              <option value="max_radius">Max radius</option>
              <option value="moments">Moments</option>
            </select>
          </label>

          <label>
            <span className="label-row">
              <span>Volume model</span>
              <HelpTip label="Volume model" text="Shape assumption used to turn area into volume for the volume-weighted statistics." />
            </span>
            <select value={settings.volume_model} onChange={setStr('volume_model')}>
              <option value="legacy">Legacy</option>
              <option value="spheroid">Spheroid</option>
            </select>
          </label>

          <label>
            <span className="label-row">
              <span>Min diameter (µm)</span>
              <HelpTip label="Min diameter" text="Ignore particles smaller than this in the statistics. Leave empty to use everything above the detection limit." />
            </span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder="none"
              value={settings.min_diameter_um ?? ''}
              onChange={(e) => onSettingsChange({ ...settings, min_diameter_um: e.target.value === '' ? null : parseFloat(e.target.value) })}
            />
          </label>
        </div>
      </details>

      <h3>Reference object</h3>

      <label>
        <span className="label-row">
          <span>Preset</span>
          <HelpTip
            label="Reference preset"
            text="Pick the real object you clicked on in the image so the app can convert pixels into millimeters."
          />
        </span>
        <select value={referencePreset} onChange={(e) => onPresetChange(e.target.value)}>
          {Object.entries(REFERENCE_OBJECTS).map(([name, mm]) => (
            <option key={name} value={name}>{name} ({mm} mm)</option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>

      <label>
        <span className="label-row">
          <span>Physical size (mm)</span>
          <HelpTip
            label="Physical size"
            text="Use this when your reference object is custom. This should match the true diameter or width between the two clicked points."
          />
        </span>
        <input
          type="number"
          min={0.01}
          step={0.01}
          value={referencePhysicalMm}
          onChange={(e) => onPhysicalMmChange(parseFloat(e.target.value))}
        />
      </label>
      {onClose && (
        <button type="button" className="btn-primary sidebar-done" onClick={onClose}>Done</button>
      )}
      </div>
    </div>
  )
}
