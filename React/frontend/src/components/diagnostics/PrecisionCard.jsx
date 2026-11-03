import { useMemo, useSyncExternalStore } from 'react'
import { listChecks, setExcluded, subscribe } from '../../repeatStore'
import { checkFromRuns, formatPct, pooledPrecision } from '../../precision'
import { useLatestAnalysis } from '../../analysisSession'
import { normalizeSummary } from '../../analyzerCompat'
import { formatShortDate } from '../dashboard/chartUtils'
import '../pages/pages.css'
import './precision.css'

// "Measurement precision": how much Dv10/Dv50/Dv90 move between photos of the same sample, pooled over
// the repeat checks saved from the Analyzer. Everything is read from this device (repeatStore); nothing
// is sent anywhere.

const AXIS = 0.15 // dot strip spans -15% .. +15% around each check's own average
const MAX_ROWS = 8
const METRIC_LABELS = [['dv10', 'Dv10'], ['dv50', 'Dv50'], ['dv90', 'Dv90']]
const EMPTY_TEXT = 'Save a repeat check in the Analyzer (2+ photos of the same sample) to see this.'
const NOT_ENOUGH_TEXT = 'Not enough yet: a first estimate needs 3 or more photos across your repeat checks. Save another in the Analyzer.'

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const ALL_EXCLUDED_TEXT = 'Every repeat check is excluded. Include one below to see the precision again.'
const pctText = (p) => `±${formatPct(p.onePhotoPct)}%`

/** All saved repeat checks (excluded ones included), re-rendering when any is added, changed or excluded. */
export function useAllChecks() {
  return useSyncExternalStore(subscribe, listChecks, listChecks)
}

/** Local calendar date of an ISO timestamp, as "Nov 2". */
function dateLabel(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return formatShortDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
}

function precisionModel(checks) {
  const pooled = pooledPrecision(checks)
  const any = METRIC_LABELS.some(([key]) => pooled[key])
  const ref = pooled.dv50 ?? METRIC_LABELS.map(([key]) => pooled[key]).find(Boolean) ?? null
  const rows = checks
    .map((c) => {
      const stats = checkFromRuns(c.runs).dv50
      if (!stats) return null
      const dots = c.runs.map((r) => r.dv50_um).filter(finite).map((v) => v / stats.mean - 1)
      return { id: c.id, grind: c.grindSetting, date: dateLabel(c.createdAt), at: c.createdAt, dots }
    })
    .filter(Boolean)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return { pooled, any, ref, rows }
}

/** One-line summary for the phone list row, e.g. "Dv50 ±7% per photo · 4 checks". `all` is the saved checks (useAllChecks). */
export function precisionSubtitle(all = listChecks()) {
  if (all.length === 0) return 'No repeat checks yet'
  const checks = all.filter((c) => !c.excluded)
  if (checks.length === 0) return 'All checks excluded'
  const { pooled } = precisionModel(checks)
  if (!pooled.dv50) return `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} · not enough yet`
  return `Dv50 ${pctText(pooled.dv50)} per photo · ${pooled.dv50.checks} ${pooled.dv50.checks === 1 ? 'check' : 'checks'}`
}

/** Every saved check, newest first, for the include/exclude list. */
function listRows(all) {
  return [...all]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((c) => ({
      id: c.id,
      grind: c.grindSetting,
      date: dateLabel(c.createdAt),
      photos: c.runs.length,
      cv: checkFromRuns(c.runs).dv50?.cv ?? null,
      excluded: c.excluded,
    }))
}

function ChecksList({ rows }) {
  return (
    <ul className="el-prec-list" data-testid="diag-precision-list">
      {rows.map((r) => {
        const name = `${r.grind || 'No setting'}${r.date ? `, ${r.date}` : ''}`
        return (
          <li
            key={r.id}
            className={`el-prec-check${r.excluded ? ' is-excluded' : ''}`}
            data-testid="diag-precision-check"
            data-excluded={r.excluded ? 'true' : 'false'}
          >
            <div className="el-prec-check-main">
              <span className="el-prec-check-top">
                <strong>{r.grind || 'No setting'}</strong>{r.date ? <span className="muted"> · {r.date}</span> : null}
                {r.excluded ? <span className="el-badge" data-testid="diag-precision-excluded">Excluded</span> : null}
              </span>
              <span className="el-prec-check-sub muted">
                {r.photos} photos{r.cv !== null ? ` · Dv50 CV ${(r.cv * 100).toFixed(1)}%` : ''}
              </span>
            </div>
            <button
              type="button"
              className="el-pill-btn"
              data-testid="diag-precision-exclude"
              aria-label={`${r.excluded ? 'Include' : 'Exclude'} the ${name} check`}
              onClick={() => setExcluded(r.id, !r.excluded)}
            >
              {r.excluded ? 'Include' : 'Exclude'}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

const leftPct = (rel) => `${50 + (Math.max(-AXIS, Math.min(AXIS, rel)) / AXIS) * 50}%`

function DotStrip({ rows, bandPct }) {
  const shown = rows.slice(0, MAX_ROWS)
  const band = Math.min(AXIS, bandPct / 100)
  const all = shown.flatMap((r) => r.dots)
  const lo = all.length ? Math.min(...all) : 0
  const hi = all.length ? Math.max(...all) : 0
  const signed = (v) => `${v < 0 ? 'minus' : 'plus'} ${formatPct(Math.abs(v * 100))}`
  const label = `Dv50 of each photo compared with the average of its repeat check, for ${shown.length} ${shown.length === 1 ? 'check' : 'checks'}`
    + ` at ${shown.map((r) => r.grind || 'no setting').join(', ')}.`
    + ` Photos fall between ${signed(lo)} and ${signed(hi)} percent; the shaded band is plus or minus ${formatPct(bandPct)} percent`
  return (
    <div className="el-prec-strip" role="img" aria-label={label} data-testid="diag-precision-strip">
      {shown.map((r) => (
        <div className="el-prec-strip-row" key={r.id}>
          <span className="el-prec-strip-label"><strong>{r.grind || 'No setting'}</strong>{r.date ? <span className="muted"> · {r.date}</span> : null}</span>
          <div className="el-prec-track" aria-hidden="true">
            <i className="el-prec-band" style={{ left: leftPct(-band), width: `${band * (100 / AXIS)}%` }} />
            <i className="el-prec-mid" />
            <i className="el-prec-axis" />
            {r.dots.map((rel, i) => <i className="el-prec-dot" key={i} style={{ left: leftPct(rel) }} />)}
          </div>
        </div>
      ))}
      <div className="el-prec-strip-row el-prec-scale" aria-hidden="true">
        <span />
        <div><span>−15%</span><span>check average</span><span>+15%</span></div>
      </div>
    </div>
  )
}

/** Compares the pooled Dv50 one-photo figure with the latest analysis's in-photo 95% CI, when there is one. */
function inPhotoNote(latest, dv50) {
  if (!latest || !dv50) return null
  const s = normalizeSummary(latest.summary)
  if (!s.ci50 || !finite(s.dv50) || s.dv50 <= 0) return null
  const inPhoto = ((s.ci50[1] - s.ci50[0]) / 2 / s.dv50) * 100
  if (!finite(inPhoto) || inPhoto < 0) return null
  const shown = Math.max(1, Math.round(inPhoto))
  return {
    pct: shown,
    larger: dv50.onePhotoPct > inPhoto,
  }
}

export default function PrecisionCard({ phone = false }) {
  const all = useAllChecks()
  const checks = useMemo(() => all.filter((c) => !c.excluded), [all])
  const listed = useMemo(() => listRows(all), [all])
  const latest = useLatestAnalysis()
  const model = useMemo(() => precisionModel(checks), [checks])
  const { pooled, any, ref, rows } = model
  const note = inPhotoNote(latest, pooled.dv50)
  const rootClass = `el-prec${phone ? ' is-phone' : ' el-card'}`

  const head = (
    <>
      {phone ? null : <h2>Measurement precision</h2>}
      <p className="el-prec-lead muted">How much results move between photos of the same sample. Saved on this device.</p>
    </>
  )

  const Panel = phone ? 'div' : 'section'
  if (!any) {
    return (
      <section className={rootClass} data-testid="diag-precision" aria-label="Measurement precision">
        {head}
        <p className="el-prec-empty" data-testid="diag-precision-empty">
          {all.length === 0 ? EMPTY_TEXT : checks.length === 0 ? ALL_EXCLUDED_TEXT : NOT_ENOUGH_TEXT}
        </p>
        {listed.length > 0 ? (
          <Panel className={phone ? 'el-card el-prec-panel' : 'el-prec-panel'}>
            <h3 className="el-prec-title">Repeat checks</h3>
            <ChecksList rows={listed} />
          </Panel>
        ) : null}
      </section>
    )
  }

  return (
    <section className={rootClass} data-testid="diag-precision" aria-label="Measurement precision">
      {head}
      <Panel className={phone ? 'el-card el-prec-panel' : 'el-prec-panel'}>
        <div className="el-prec-stats">
          {METRIC_LABELS.map(([key, label]) => (
            <div className="el-prec-stat" key={key}>
              <p className="el-prec-stat-label muted">{label}</p>
              <p className="el-prec-stat-value" data-testid={`diag-precision-${key}`}>
                {pooled[key] ? pctText(pooled[key]) : '—'}
              </p>
            </div>
          ))}
        </div>
        <p className="el-prec-foot muted" data-testid="diag-precision-foot">
          One photo, 95% · From {ref.checks} repeat {ref.checks === 1 ? 'check' : 'checks'} · {ref.photos} photos
        </p>
      </Panel>

      {rows.length > 0 && pooled.dv50 ? (
        <Panel className={phone ? 'el-card el-prec-panel' : 'el-prec-panel'}>
          <h3 className="el-prec-title">Each repeat check</h3>
          <p className="el-prec-sub muted">One dot per photo: its Dv50 against that check’s average</p>
          <DotStrip rows={rows} bandPct={pooled.dv50.onePhotoPct} />
        </Panel>
      ) : null}

      <Panel className={phone ? 'el-card el-prec-panel' : 'el-prec-panel'}>
        <h3 className="el-prec-title">Repeat checks</h3>
        <p className="el-prec-sub muted">Exclude a check to leave it out of the numbers above. Nothing is deleted.</p>
        <ChecksList rows={listed} />
      </Panel>

      {note ? (
        <div className="el-callout is-info el-prec-note" data-testid="diag-precision-note">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" />
          </svg>
          <span>
            Your in-photo 95% range is <strong>±{note.pct}%</strong>
            {note.larger
              ? '; photo-to-photo spread is larger, so placement and lighting matter more than particle count.'
              : '; the spread between photos is no larger than that.'}
          </span>
        </div>
      ) : null}
    </section>
  )
}
