import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { REFERENCE_OBJECTS } from '../constants'

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

export default function Sidebar({ settings, onSettingsChange, referencePreset, onPresetChange, referencePhysicalMm, onPhysicalMmChange }) {
  const set = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : parseFloat(e.target.value)
    onSettingsChange({ ...settings, [key]: val })
  }

  return (
    <aside className="analyzer-sidebar">
      <h3>Analysis Settings</h3>

      <label>
        <span className="label-row">
          <span>Threshold (%)</span>
          <HelpTip
            label="Threshold"
            text="Higher values detect fewer, darker pixels. Lower values include more of the image and can merge nearby grounds."
          />
        </span>
        <input type="range" min={1} max={100} step={0.1} value={settings.threshold_percent} onChange={set('threshold_percent')} />
        <span>{settings.threshold_percent.toFixed(1)}</span>
      </label>

      <label>
        <span className="label-row">
          <span>Reference Threshold</span>
          <HelpTip
            label="Reference Threshold"
            text="Controls how the reference object edge is detected. Raise it if the coin or ruler edge is noisy; lower it if the edge is missed."
          />
        </span>
        <input type="range" min={0} max={1} step={0.01} value={settings.reference_threshold} onChange={set('reference_threshold')} />
        <span>{settings.reference_threshold.toFixed(2)}</span>
      </label>

      <label>
        <span className="label-row">
          <span>Cluster Breakup Cost</span>
          <HelpTip
            label="Cluster Breakup Cost"
            text="Lower values split touching particles more aggressively. Higher values keep borderline clusters together."
          />
        </span>
        <input type="range" min={0.01} max={1} step={0.01} value={settings.max_cost} onChange={set('max_cost')} />
        <span>{settings.max_cost.toFixed(2)}</span>
      </label>

      <label>
        <span className="label-row">
          <span>Max Cluster Axis (px)</span>
          <HelpTip
            label="Max Cluster Axis"
            text="Upper size limit for a single detected particle before it is treated as suspiciously large."
          />
        </span>
        <input type="number" min={1} step={1} value={settings.max_cluster_axis} onChange={set('max_cluster_axis')} />
      </label>

      <label>
        <span className="label-row">
          <span>Min Surface (px²)</span>
          <HelpTip
            label="Min Surface"
            text="Filters out tiny specks and sensor noise. Increase it if dust is being counted as particles."
          />
        </span>
        <input type="number" min={1} step={1} value={settings.min_surface} onChange={set('min_surface')} />
      </label>

      <label>
        <span className="label-row">
          <span>Min Roundness</span>
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
          <span>Quick clustering</span>
          <HelpTip
            label="Quick clustering"
            text="Faster, rougher clustering. Useful for iteration; disable it when you want the most careful breakup pass."
          />
        </span>
      </label>

      <label>
        <span className="label-row">
          <span>Analysis Resolution</span>
          <HelpTip
            label="Analysis Resolution"
            text="Lower resolutions run much faster but reduce particle detail. Start at 50 to 75 percent for large photos, then rerun at 100 percent for final results."
          />
        </span>
        <select value={settings.analysis_scale_pct} onChange={(e) => onSettingsChange({ ...settings, analysis_scale_pct: parseInt(e.target.value) })}>
          {[100, 75, 50, 33, 25].map(v => <option key={v} value={v}>{v}%</option>)}
        </select>
      </label>

      <hr />
      <h3>Reference Object</h3>

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
    </aside>
  )
}
