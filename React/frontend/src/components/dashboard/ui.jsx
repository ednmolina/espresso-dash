import { createContext, useEffect, useRef, useState } from 'react'
import { RATING_COLORS } from '../../dashboardData'

export const PanelActionsContext = createContext(null)

export function Panel({ title, subtitle, children, testId }) {
  const [actionsEl, setActionsEl] = useState(null)
  return (
    <section className="dashboard-panel" data-testid={testId}>
      <div className="dashboard-panel-header">
        <div className="dashboard-panel-heading">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="dashboard-panel-actions" ref={setActionsEl} />
      </div>
      <PanelActionsContext.Provider value={actionsEl}>
        <div className="dashboard-panel-body">{children}</div>
      </PanelActionsContext.Provider>
    </section>
  )
}

export function MetricCard({ label, value, sub, subTone, testId }) {
  return (
    <div className="dashboard-metric-card" data-testid={testId}>
      <span className="dashboard-metric-label">{label}</span>
      <strong className="dashboard-metric-value">{value}</strong>
      {sub !== undefined && sub !== null && (
        <span className="dashboard-metric-sub">
          {subTone && <i className={`dashboard-dot tone-${subTone}`} aria-hidden="true" />}
          {sub}
        </span>
      )}
    </div>
  )
}

export function Field({ label, children, wide = false }) {
  return (
    <label className={`dashboard-field ${wide ? 'wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}

export function AutocompleteInput({ scope, field, options = [], ...props }) {
  const listId = `${scope}-${field}-suggestions`
  const hasOptions = options.length > 0
  return (
    <>
      <input {...props} list={hasOptions ? listId : undefined} autoComplete="on" />
      {hasOptions && (
        <datalist id={listId}>
          {options.map((option) => <option key={option} value={option} />)}
        </datalist>
      )}
    </>
  )
}

/** Multiselect: a button that opens a checkbox list with per-option shot counts. */
export function ChipSelect({ label, options, counts = {}, value, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (option) => {
    onChange(value.includes(option) ? value.filter((item) => item !== option) : [...value, option])
  }

  return (
    <div className="dashboard-chip-select" ref={rootRef} data-testid={`filter-${label.toLowerCase()}`}>
      <span className="dashboard-chip-select-label">{label}</span>
      <button
        type="button"
        className="dashboard-chip-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{value.length ? `${value.length} selected` : `All ${label.toLowerCase().replace(/y$/, 'ie')}s`}</span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {value.length > 0 && (
        <div className="dashboard-chip-select-chips">
          {value.map((item) => (
            <button key={item} type="button" className="dashboard-chip-removable" onClick={() => toggle(item)} aria-label={`Remove ${item}`}>
              {item}<span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="dashboard-chip-select-pop" role="listbox" aria-multiselectable="true">
          {options.length === 0 && <div className="dashboard-chip-select-empty">No options</div>}
          {options.map((option) => (
            <label key={option} className="dashboard-chip-select-option">
              <input type="checkbox" checked={value.includes(option)} onChange={() => toggle(option)} />
              <span className="dashboard-chip-select-name">{option}</span>
              <span className="dashboard-chip-select-count">{counts[option] ?? 0}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function renderCell(value, column) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') {
    if (/Probability$/.test(column)) return `${(value * 100).toFixed(0)}%`
    return Number.isInteger(value) ? value : value.toFixed(2)
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return value
}

export function DataTable({ rows, editable = false, onUpdateCell = null, totalCount = null, testId }) {
  const [editingCell, setEditingCell] = useState(null)
  const [draftValue, setDraftValue] = useState('')
  const [pendingCell, setPendingCell] = useState(null)

  if (!rows.length) {
    return (
      <div className="dashboard-empty-state">
        No rows to display.
        {totalCount ? ` (0 of ${totalCount})` : ''}
      </div>
    )
  }

  const columns = Object.keys(rows[0]).filter((column) => column !== '__row_id')
  const numericColumns = new Set(columns.filter((column) => rows.every((row) => row[column] === null || row[column] === undefined || typeof row[column] === 'number')))

  const beginEdit = (rowId, column, value) => {
    if (!editable || !onUpdateCell || pendingCell) return
    setEditingCell({ rowId, column })
    setDraftValue(value === null || value === undefined ? '' : String(value))
  }
  const cancelEdit = () => {
    setEditingCell(null)
    setDraftValue('')
  }
  const commitEdit = async () => {
    if (!editingCell || !onUpdateCell || pendingCell) return
    const { rowId, column } = editingCell
    setPendingCell(`${rowId}:${column}`)
    try {
      await onUpdateCell(rowId, column, draftValue)
      cancelEdit()
    } catch {
      // the parent surfaces the error banner; keep the editor open
    } finally {
      setPendingCell(null)
    }
  }

  return (
    <div className="dashboard-table-wrap" data-testid={testId}>
      <div className="dashboard-table-scroll">
        <table className="dashboard-table">
          <thead>
            <tr>
              {columns.map((column, ci) => (
                <th key={column} className={`${numericColumns.has(column) ? 'num' : ''} ${ci === 0 ? 'sticky-col' : ''}`}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const rowId = row.__row_id ?? index
              return (
                <tr key={`${rowId}-${index}`}>
                  {columns.map((column, ci) => {
                    const cellKey = `${rowId}:${column}`
                    const isEditing = editingCell?.rowId === rowId && editingCell?.column === column
                    const isPending = pendingCell === cellKey
                    const classes = [
                      numericColumns.has(column) ? 'num' : '',
                      ci === 0 ? 'sticky-col' : '',
                      column === 'Notes' ? 'notes' : '',
                      editable ? 'dashboard-table-cell-editable' : '',
                    ].filter(Boolean).join(' ')
                    const text = renderCell(row[column], column)
                    return (
                      <td
                        key={column}
                        className={classes || undefined}
                        title={column === 'Notes' && row[column] ? String(row[column]) : undefined}
                        onClick={() => beginEdit(rowId, column, row[column])}
                      >
                        {isEditing ? (
                          <input
                            className="dashboard-table-input"
                            value={draftValue}
                            disabled={isPending}
                            autoFocus
                            onChange={(event) => setDraftValue(event.target.value)}
                            onBlur={() => { void commitEdit() }}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void commitEdit()
                              } else if (event.key === 'Escape') {
                                event.preventDefault()
                                cancelEdit()
                              }
                            }}
                          />
                        ) : column === 'Rating Label' && RATING_COLORS[row[column]] ? (
                          <span className={isPending ? 'dashboard-table-cell-pending' : undefined}>
                            <i className="dashboard-dot" style={{ background: RATING_COLORS[row[column]] }} aria-hidden="true" />
                            {text}
                          </span>
                        ) : (
                          <span className={isPending ? 'dashboard-table-cell-pending' : undefined}>{text}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="dashboard-table-footer">
        Showing {rows.length} of {totalCount ?? rows.length}
      </div>
    </div>
  )
}
