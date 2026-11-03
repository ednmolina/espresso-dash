import { useId } from 'react'
import { MAX_INDEX, indexToSetting, parseSetting, settingToIndex } from '../../grindCalibration'
import { useBreakpoint } from '../shell'
import './pages.css'

const MICROS = 'ABCDEFGHI'.split('')
const DEFAULT_SETTING = '10E'

const Step = ({ dir, aria, onClick, disabled, id }) => (
  <button
    type="button"
    className="el-picker-step"
    aria-label={aria}
    onClick={onClick}
    disabled={disabled}
    data-testid={id}
  >
    {dir < 0 ? '−' : '+'}
  </button>
)

/**
 * Grind setting picker (macro 1-31 + micro A-I).
 *  layout "macro-micro": macro stepper + A-I chips (phone: two steppers)
 *  layout "stepper":     one -/+ over the whole index
 * The value is a string like "10E", or '' when allowEmpty and nothing is chosen yet.
 */
export default function GrindSettingPicker({
  value = '',
  onChange,
  layout = 'macro-micro',
  tone = 'light',
  label = 'Grind setting used',
  allowEmpty = false,
  testId = 'grind-picker',
  size = 'md',
}) {
  const labelId = useId()
  const phone = useBreakpoint() === 'phone'
  const parsed = parseSetting(value)
  const index = parsed ? settingToIndex(value) : null
  const empty = !parsed
  const shown = parsed ? parsed.label : allowEmpty ? 'Not set' : DEFAULT_SETTING

  const emit = (setting) => onChange?.(setting)
  const base = parsed ? parsed : parseSetting(DEFAULT_SETTING)

  const stepIndex = (delta) => {
    if (empty) return emit(DEFAULT_SETTING)
    const next = Math.min(MAX_INDEX, Math.max(0, Math.round(index) + delta))
    emit(indexToSetting(next))
  }
  const stepMacro = (delta) => {
    if (empty) return emit(DEFAULT_SETTING)
    const macro = Math.min(31, Math.max(1, base.macro + delta))
    emit(`${macro}${base.micro}`)
  }
  const stepMicro = (delta) => {
    if (empty) return emit(DEFAULT_SETTING)
    const micro = Math.min(8, Math.max(0, base.microIndex + delta))
    emit(`${base.macro}${MICROS[micro]}`)
  }
  const setMicro = (letter) => emit(`${base?.macro ?? 10}${letter}`)

  const cls = ['el-picker', `el-picker--${tone}`, `el-picker--${size}`, `el-picker--${layout}`].join(' ')
  const atMin = !empty && index <= 0
  const atMax = !empty && index >= MAX_INDEX

  return (
    <div className={cls} data-testid={testId} role="group" aria-labelledby={labelId}>
      <div className="el-picker-label">
        <span id={labelId}>{label}</span>
        <span className="el-picker-value" data-testid={`${testId}-value`} aria-live="polite">{shown}</span>
      </div>

      {layout === 'stepper' ? (
        <div className="el-picker-row">
          <Step dir={-1} aria="Finer" onClick={() => stepIndex(-1)} disabled={atMin} id={`${testId}-dec`} />
          <span className="el-picker-big" aria-hidden="true">{shown}</span>
          <Step dir={1} aria="Coarser" onClick={() => stepIndex(1)} disabled={atMax} id={`${testId}-inc`} />
        </div>
      ) : phone ? (
        <div className="el-picker-duo">
          <div className="el-picker-row" role="group" aria-label="Macro setting, 1 to 31">
            <Step dir={-1} aria="Macro finer" onClick={() => stepMacro(-1)} disabled={!empty && base.macro <= 1} id={`${testId}-macro-dec`} />
            <span className="el-picker-mid"><small>Macro 1–31</small><b data-testid={`${testId}-macro`}>{empty ? '—' : base.macro}</b></span>
            <Step dir={1} aria="Macro coarser" onClick={() => stepMacro(1)} disabled={!empty && base.macro >= 31} id={`${testId}-macro-inc`} />
          </div>
          <div className="el-picker-row" role="group" aria-label="Micro setting, A to I">
            <Step dir={-1} aria="Micro finer" onClick={() => stepMicro(-1)} disabled={!empty && base.microIndex <= 0} id={`${testId}-micro-dec`} />
            <span className="el-picker-mid"><small>Micro A–I</small><b data-testid={`${testId}-micro`}>{empty ? '—' : base.micro}</b></span>
            <Step dir={1} aria="Micro coarser" onClick={() => stepMicro(1)} disabled={!empty && base.microIndex >= 8} id={`${testId}-micro-inc`} />
          </div>
        </div>
      ) : (
        <>
          <div className="el-picker-row" role="group" aria-label="Macro setting, 1 to 31">
            <Step dir={-1} aria="Macro finer" onClick={() => stepMacro(-1)} disabled={!empty && base.macro <= 1} id={`${testId}-macro-dec`} />
            <span className="el-picker-big" data-testid={`${testId}-macro`}>{empty ? '—' : base.macro}</span>
            <Step dir={1} aria="Macro coarser" onClick={() => stepMacro(1)} disabled={!empty && base.macro >= 31} id={`${testId}-macro-inc`} />
          </div>
          <div className="el-picker-chips" role="radiogroup" aria-label="Micro setting, A to I">
            {MICROS.map((letter) => {
              const on = !empty && base.micro === letter
              return (
                <button
                  key={letter}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`el-picker-chip${on ? ' is-on' : ''}`}
                  onClick={() => setMicro(letter)}
                  data-testid={`${testId}-micro-${letter}`}
                >
                  {letter}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
