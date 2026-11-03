import { useEffect, useState } from 'react'
import {
  RATING_COLORS,
  RATING_LABELS,
  TARGET_EXTRACTION_HIGH,
  TARGET_EXTRACTION_LOW,
  parsePhInput,
  updateShotCellInFirestore,
} from '../../dashboardData'
import { coffeeLabel } from '../../forecastModel'
import { Sheet } from '../shell'
import { formatLongDate, formatNumber } from './chartUtils'
import { grindDisplay } from './dashboardStats'
import { AutocompleteInput, Field } from './ui'

const TARGET_LABEL = `${TARGET_EXTRACTION_LOW}–${TARGET_EXTRACTION_HIGH}%`
export const PH_HINT = 'A blank pH stays blank; it is never filled in with a default.'

/* ---- Log a shot --------------------------------------------------------- */

function Group({ title, children, htmlFor }) {
  return (
    <div className="dashboard-form-group">
      {htmlFor
        ? <label className="dashboard-form-group-title" htmlFor={htmlFor}>{title}</label>
        : <p className="dashboard-form-group-title">{title}</p>}
      <div className="dashboard-form-card">{children}</div>
    </div>
  )
}

export function LogShotSheet({
  open, onClose, shotForm, setShot, fieldOptions, meta, preview, previewInRange, recommendation,
  carryForward, setCarryForward, carryShot, setCarryShot, onSubmit, saving, error,
}) {
  const phCheck = parsePhInput(shotForm.ph)
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Log a shot"
      detents={['medium', 'large']}
      initialDetent="large"
      leftAction={{ label: 'Cancel' }}
      rightAction={{ label: saving ? 'Saving…' : 'Add', form: 'shot-form-el', disabled: saving || Boolean(phCheck.error) }}
      testId="log-shot-sheet"
    >
      <form id="shot-form-el" className="dashboard-form" onSubmit={onSubmit} noValidate data-testid="shot-form">
        {error && <div className="dashboard-error-banner" role="alert">{error}</div>}
        <div className="dashboard-inline-toggles">
          <label className="dashboard-toggle">
            <input type="checkbox" checked={carryForward} onChange={(event) => setCarryForward(event.target.checked)} />
            <span>Carry forward previous values</span>
          </label>
          <label className="dashboard-toggle">
            <input type="checkbox" checked={carryShot} onChange={(event) => setCarryShot(event.target.checked)} />
            <span>Carry forward previous pull settings</span>
          </label>
        </div>

        <Group title="Coffee">
          <div className="dashboard-fieldset-grid">
            <Field label="Roaster"><AutocompleteInput scope="shot" field="roaster" value={shotForm.roaster} options={fieldOptions.roaster} onChange={setShot('roaster')} /></Field>
            <Field label="Region"><AutocompleteInput scope="shot" field="region" value={shotForm.region} options={fieldOptions.region} onChange={setShot('region')} /></Field>
            <Field label="Continent"><AutocompleteInput scope="shot" field="continent" value={shotForm.continent} options={fieldOptions.continent} onChange={setShot('continent')} /></Field>
            <Field label="Variety"><AutocompleteInput scope="shot" field="variety" value={shotForm.variety} options={fieldOptions.variety} onChange={setShot('variety')} /></Field>
            <Field label="Processing Technique"><AutocompleteInput scope="shot" field="processing_technique" value={shotForm.processing_technique} options={fieldOptions.processing_technique} onChange={setShot('processing_technique')} /></Field>
            <Field label="Roast"><AutocompleteInput scope="shot" field="roast" value={shotForm.roast} options={fieldOptions.roast} onChange={setShot('roast')} /></Field>
          </div>
          <details className="dashboard-details" data-testid="origin-coords">
            <summary>Origin coordinates</summary>
            <div className="dashboard-fieldset-grid three">
              <Field label="Lat"><input inputMode="decimal" value={shotForm.latitude} onChange={setShot('latitude')} /></Field>
              <Field label="Long"><input inputMode="decimal" value={shotForm.longitude} onChange={setShot('longitude')} /></Field>
              <Field label="Elevation"><AutocompleteInput scope="shot" field="elevation" value={shotForm.elevation} options={fieldOptions.elevation} onChange={setShot('elevation')} /></Field>
            </div>
          </details>
        </Group>

        <Group title="Recipe">
          <div className="dashboard-fieldset-grid three">
            <Field label="Dose (g)"><input type="number" inputMode="decimal" step="0.1" value={shotForm.dose} onChange={setShot('dose')} /></Field>
            <Field label="Yield (g)"><input type="number" inputMode="decimal" step="0.1" value={shotForm.yield_grams} onChange={setShot('yield_grams')} /></Field>
            <Field label="Time (s)"><input type="number" inputMode="numeric" step="1" value={shotForm.shot_time} onChange={setShot('shot_time')} /></Field>
          </div>
          <div className="dashboard-fieldset-grid three">
            <Field label="Grind macro">
              <select value={shotForm.grind_macro} onChange={setShot('grind_macro')}>
                {meta.macro_options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </Field>
            <Field label="Grind micro">
              <select value={shotForm.grind_micro} onChange={setShot('grind_micro')}>
                {meta.micro_options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </Field>
            <Field label="Grind (µm)"><AutocompleteInput scope="shot" field="avg_grind" inputMode="decimal" value={shotForm.avg_grind} options={fieldOptions.avg_grind} onChange={setShot('avg_grind')} /></Field>
          </div>
          <Field label="Date"><input type="date" value={shotForm.entry_date} onChange={setShot('entry_date')} /></Field>
        </Group>

        <Group title="Measurement">
          <div className="dashboard-fieldset-grid three">
            <Field label="Temp (°C)"><input type="number" inputMode="decimal" step="0.1" value={shotForm.temp_c} onChange={setShot('temp_c')} /></Field>
            <Field label="Brix"><input type="number" inputMode="decimal" step="0.1" value={shotForm.brix} onChange={setShot('brix')} /></Field>
            <Field label="TDS (%)"><input value={formatNumber(preview.tds)} disabled /></Field>
          </div>
        </Group>

        <Group title="Result">
          <div className="dashboard-field">
            <span id="rating-label">Rating</span>
            <div className="dashboard-segmented" role="radiogroup" aria-labelledby="rating-label" data-testid="rating-segmented">
              {meta.rating_labels.map((label) => (
                <label key={label} className={shotForm.rating_label === label ? 'checked' : ''}>
                  <input type="radio" name="rating_label" value={label} checked={shotForm.rating_label === label} onChange={setShot('rating_label')} />
                  <i className="dashboard-dot" style={{ background: RATING_COLORS[label] }} aria-hidden="true" />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <Field label="Notes" wide><textarea rows="3" value={shotForm.notes} onChange={setShot('notes')} /></Field>
        </Group>

        <Group title="pH (optional)" htmlFor="shot-ph">
          <input
            id="shot-ph"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="3.5"
            max="8"
            placeholder="e.g. 5.4"
            value={shotForm.ph}
            onChange={setShot('ph')}
            data-testid="ph-input"
            aria-invalid={phCheck.error ? 'true' : undefined}
            aria-describedby={phCheck.error ? 'shot-ph-error' : 'shot-ph-hint'}
          />
          {phCheck.error ? (
            <p id="shot-ph-error" className="dashboard-field-error" role="alert" data-testid="ph-error">{phCheck.error}</p>
          ) : (
            <p id="shot-ph-hint" className="dashboard-field-hint">{PH_HINT}</p>
          )}
        </Group>

        <div className="dashboard-preview-strip" data-testid="preview-strip">
          <div className={`dashboard-preview-main ${previewInRange ? 'in-range' : 'out-range'}`}>
            <span>Extraction</span>
            <strong data-testid="preview-extraction">{formatNumber(preview.extraction)}%</strong>
            <em>{previewInRange ? 'in target window' : `outside ${TARGET_LABEL}`}</em>
          </div>
          <div className="dashboard-preview-stat"><span>TDS</span><strong>{formatNumber(preview.tds)}</strong></div>
          <div className="dashboard-preview-stat"><span>Adj factor</span><strong>{formatNumber(preview.factor, 4)}</strong></div>
          <div className="dashboard-preview-stat"><span>Adj temp</span><strong>{formatNumber(preview.adjustedTemp, 1)}°C</strong></div>
        </div>

        <div className="dashboard-form-footer">
          <div className="dashboard-recommendation-card" data-testid="recommendation">
            <p className="dashboard-card-label">Recommended grind setting</p>
            <h3>{recommendation?.label ?? '—'}</h3>
            <p>{recommendation?.detail ?? 'No recommendation yet.'}</p>
          </div>
          <div className="dashboard-form-submit">
            <button className="dashboard-primary-button" type="submit" disabled={saving || Boolean(phCheck.error)} data-testid="add-shot">
              {saving ? 'Saving…' : 'Add row'}
            </button>
          </div>
        </div>
      </form>
    </Sheet>
  )
}

/* ---- Shot detail / edit (phone) ----------------------------------------- */

const EDIT_FIELDS = [
  { col: 'Date', key: 'date', type: 'date' },
  { col: 'Roaster', key: 'roaster' },
  { col: 'Region', key: 'region' },
  { col: 'Variety', key: 'variety' },
  { col: 'Grind Setting', key: 'grindSetting' },
  { col: 'Avg Grind', key: 'avgGrind', label: 'Avg grind (µm)' },
  { col: 'Dose', key: 'dose', type: 'number', label: 'Dose (g)' },
  { col: 'Yield', key: 'yieldGrams', type: 'number', label: 'Yield (g)' },
  { col: 'Time', key: 'time', type: 'number', label: 'Time (s)' },
  { col: 'Brix', key: 'brix', type: 'number' },
  { col: 'TempC', key: 'tempC', type: 'number', label: 'Temp (°C)' },
  { col: 'pH', key: 'ph', type: 'ph' },
  { col: 'Rating Label', key: 'rating', type: 'rating', label: 'Rating' },
  { col: 'Notes', key: 'notes' },
]

const OFFLINE_EDIT = 'Offline mode is using cached data. Reconnect to Firebase before editing.'

function draftFor(shot) {
  const draft = {}
  EDIT_FIELDS.forEach(({ key, col, type }) => {
    const value = shot[key]
    draft[col] = type === 'rating'
      ? RATING_LABELS[value] ?? 'Good'
      : (value === null || value === undefined ? '' : String(value))
  })
  return draft
}

export function ShotDetailSheet({ shot, onClose, syncState, shots, reload, estimate }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lastShot, setLastShot] = useState(shot)
  const open = Boolean(shot)

  useEffect(() => { if (shot) setLastShot(shot) }, [shot])
  useEffect(() => { setEditing(false); setError('') }, [shot?.id])

  const view = shot ?? lastShot
  if (!view) return null

  const phCheck = parsePhInput(draft.pH)
  const grind = grindDisplay(view, estimate)

  const rows = [
    ['Date', formatLongDate(view.date)],
    ['Coffee', coffeeLabel(view)],
    ['Grind setting', view.grindSetting || '—'],
    ['Avg grind', grind ? `${grind.estimated ? '≈ ' : ''}${Math.round(grind.um)} µm${grind.estimated ? ' est.' : ''}` : '—'],
    ['pH', Number.isFinite(view.ph) ? String(view.ph) : 'not entered'],
    ['Dose → yield', `${view.dose ?? '—'} g → ${view.yieldGrams ?? '—'} g`],
    ['Time', view.time != null ? `${view.time} s` : '—'],
    ['TDS', view.tds != null ? `${formatNumber(view.tds)}%` : '—'],
    ['Extraction', view.extraction != null ? `${formatNumber(view.extraction)}%` : '—'],
    ['Rating', RATING_LABELS[view.rating] ?? '—'],
    ['Notes', view.notes || '—'],
  ]

  const save = async () => {
    if (phCheck.error) return
    if (syncState !== 'live') { setError(OFFLINE_EDIT); return }
    const original = draftFor(view)
    const changed = EDIT_FIELDS.filter(({ col }) => String(draft[col] ?? '') !== String(original[col] ?? ''))
    if (!changed.length) { setEditing(false); return }
    setBusy(true)
    setError('')
    try {
      let current = shots
      for (const { col } of changed) {
        await updateShotCellInFirestore({ shots: current, rowId: view.id, column: col, value: draft[col] })
        const next = await reload()
        if (next.source !== 'firebase') throw new Error('Saved, but the refreshed data could not be loaded.')
        current = next.shots
      }
      setEditing(false)
    } catch (err) {
      setError(err.message || 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const beginEdit = () => {
    if (syncState !== 'live') { setError(OFFLINE_EDIT); return }
    setDraft(draftFor(view))
    setError('')
    setEditing(true)
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={coffeeLabel(view)}
      initialDetent="large"
      detents={['medium', 'large']}
      leftAction={editing ? { label: 'Cancel', onClick: () => { setEditing(false); setError('') } } : { label: 'Back' }}
      rightAction={editing
        ? { label: busy ? 'Saving…' : 'Save', onClick: save, disabled: busy || Boolean(phCheck.error), testId: 'shot-detail-save' }
        : { label: 'Edit', onClick: beginEdit, testId: 'shot-detail-edit' }}
      testId="shot-detail"
    >
      {error && <div className="dashboard-error-banner" role="alert">{error}</div>}
      {!editing ? (
        <dl className="dashboard-detail-list">
          {rows.map(([key, value]) => (
            <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      ) : (
        <div className="dashboard-form-card">
          {EDIT_FIELDS.map((field) => {
            const label = field.label ?? field.col
            const id = `edit-${field.key}`
            let control
            if (field.type === 'rating') {
              control = (
                <select id={id} value={draft[field.col]} onChange={(event) => setDraft((prev) => ({ ...prev, [field.col]: event.target.value }))}>
                  {RATING_LABELS.map((item) => <option key={item}>{item}</option>)}
                </select>
              )
            } else if (field.type === 'ph') {
              control = (
                <input
                  id={id}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="3.5"
                  max="8"
                  placeholder="e.g. 5.4"
                  value={draft[field.col]}
                  data-testid="ph-input"
                  aria-invalid={phCheck.error ? 'true' : undefined}
                  onChange={(event) => setDraft((prev) => ({ ...prev, [field.col]: event.target.value }))}
                />
              )
            } else {
              control = (
                <input
                  id={id}
                  type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
                  inputMode={field.type === 'number' ? 'decimal' : undefined}
                  step={field.type === 'number' ? 'any' : undefined}
                  value={draft[field.col]}
                  onChange={(event) => setDraft((prev) => ({ ...prev, [field.col]: event.target.value }))}
                />
              )
            }
            return (
              <div className="dashboard-field" key={field.col}>
                <label htmlFor={id}><span>{field.type === 'ph' ? 'pH (optional)' : label}</span></label>
                {control}
                {field.type === 'ph' && (phCheck.error
                  ? <p className="dashboard-field-error" role="alert" data-testid="ph-error">{phCheck.error}</p>
                  : <p className="dashboard-field-hint">{PH_HINT}</p>)}
              </div>
            )
          })}
        </div>
      )}
    </Sheet>
  )
}
