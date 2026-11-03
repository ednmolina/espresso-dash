import { useRef } from 'react'

const MIN = 1
const MAX = 100
const STEP = 0.1
const NUDGE = 0.5

export const round1 = (v) => Math.round(v * 10) / 10
const clamp = (v) => Math.max(MIN, Math.min(MAX, v))

/**
 * The Threshold step's control: big value, Auto/Manual chip, a wide slider with round -/+ buttons.
 *
 * Presentational: the parent owns the settings and the detection.
 *   mode       'auto' | 'manual'  (what the chip says; Auto follows the value the engine chose)
 *   value      the percent to show (the engine's value in Auto, the chosen one in Manual)
 *   particles  count from the latest result, or null
 *   updating   a detection is running for the value just chosen
 *   onChange   (value, kind) with kind 'drag' (slider moving: preview it), 'release' (the pointer
 *              lifted: detect now) or 'step' (keyboard, -/+: apply, then detect after a short pause)
 *   onAuto     back to the automatic threshold
 */
export default function ThresholdControl({ mode, value, particles, updating = false, disabled = false, onChange, onAuto }) {
  const dragging = useRef(false)
  const shown = round1(clamp(Number.isFinite(value) ? value : 50))
  const isAuto = mode === 'auto'

  const fill = { '--fill': `${((shown - MIN) / (MAX - MIN)) * 100}%` }

  const onSlider = (e) => {
    const v = round1(clamp(parseFloat(e.target.value)))
    if (Number.isNaN(v) || v === shown) return
    onChange(v, dragging.current ? 'drag' : 'step')
  }
  const endDrag = (e) => {
    if (!dragging.current) return
    dragging.current = false
    onChange(round1(clamp(parseFloat(e.currentTarget.value))), 'release')
  }
  const nudge = (dir) => {
    const v = round1(clamp(shown + dir * NUDGE))
    if (v !== shown) onChange(v, 'step')
  }

  return (
    <div className="thr" role="group" aria-label="Threshold" data-testid="threshold-control" data-mode={mode}>
      <div className="thr-head">
        <span className="thr-label">Threshold</span>
        <button
          type="button"
          className="thr-auto"
          data-testid="threshold-auto"
          onClick={onAuto}
          disabled={isAuto || disabled}
          aria-label="Reset to the automatic threshold"
          title="Back to the automatic threshold"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
          </svg>
          Auto
        </button>
      </div>

      <div className="thr-value-row">
        <output className="thr-value" data-testid="threshold-value" aria-live="off">{shown.toFixed(1)}%</output>
        <span className={`thr-chip ${isAuto ? 'is-auto' : 'is-manual'}`} data-testid="threshold-chip">{isAuto ? 'Auto' : 'Manual'}</span>
      </div>

      <div className="thr-slider-row">
        <button type="button" className="thr-step" aria-label="Lower the threshold" onClick={() => nudge(-1)} disabled={disabled || shown <= MIN}>−</button>
        <input
          type="range"
          className="thr-range"
          data-testid="threshold-slider"
          aria-label="Threshold percent"
          aria-valuetext={`${shown.toFixed(1)} percent, ${isAuto ? 'automatic' : 'manual'}`}
          min={MIN}
          max={MAX}
          step={STEP}
          value={shown}
          style={fill}
          disabled={disabled}
          onPointerDown={() => { dragging.current = true }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onChange={onSlider}
        />
        <button type="button" className="thr-step" aria-label="Raise the threshold" onClick={() => nudge(1)} disabled={disabled || shown >= MAX}>+</button>
      </div>

      <p className="thr-caption">
        <span><b className="thr-red">Red</b> = counted as coffee · </span>
        <span className="thr-count" data-testid="threshold-count" aria-live="polite">
          {updating ? 'updating…' : particles == null ? '—' : `${particles.toLocaleString()} particle${particles === 1 ? '' : 's'}`}
        </span>
      </p>
      <p className="thr-caption thr-sub">Moving the slider switches Auto to Manual</p>
    </div>
  )
}
