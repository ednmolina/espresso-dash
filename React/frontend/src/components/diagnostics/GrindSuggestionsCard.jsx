import { Meter } from '../pages/pageCharts'
import '../pages/pages.css'

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const f1 = (v) => (finite(v) ? v.toFixed(1) : '—')
const MIN_FOLLOWED = 5

/** Row subtitle for the phone Diagnostics list. */
export function grindSuggestionsSubtitle(result) {
  if (!result || !result.followed) return 'Not measured yet'
  if (!result.enough) return `Too few shots yet (${result.followed.n}, needs ${MIN_FOLLOWED})`
  const { followed, notFollowed } = result
  return `Followed: ${f1(followed.medianAbsFromTarget)}% from target${notFollowed.n ? ` vs ${f1(notFollowed.medianAbsFromTarget)}%` : ''}`
}

/** The direction sentence, worded for what the data contains; `good` when most shots moved as expected. */
export function directionText(direction) {
  const { agree = 0, total = 0, finer, coarser } = direction || {}
  if (!total) return { good: null, text: 'No shot was ground 2 or more steps away from its suggestion, so there is no direction check yet.' }
  const good = agree / total >= 0.5
  const count = good ? `${agree} of ${total} shots, as expected` : `only ${agree} of ${total} shots`
  if (finer?.total && !coarser?.total) return { good, text: `Finer than suggested → higher extraction in ${count}.` }
  if (coarser?.total && !finer?.total) return { good, text: `Coarser than suggested → lower extraction in ${count}.` }
  return { good, text: `Finer or coarser than suggested → extraction moved the expected way (finer higher, coarser lower) in ${count}.` }
}

function Tile({ testId, title, group, tone }) {
  const within = group.withinPct
  return (
    <div className="el-gs-tile" data-testid={testId}>
      <p className="el-gs-tile-title">{title}</p>
      <p className="el-gs-tile-n">{group.n} {group.n === 1 ? 'shot' : 'shots'}</p>
      <p className="el-gs-big">{f1(group.medianAbsFromTarget)}{finite(group.medianAbsFromTarget) ? <small>%</small> : null}</p>
      <p className="el-gs-sub">median from target</p>
      <Meter value={finite(within) ? within : 0} max={100} tone={tone} label={`${title}: ${finite(within) ? Math.round(within) : 0}% within ±1%`} />
      <p className="el-gs-within"><b>{finite(within) ? Math.round(within) : '—'}%</b> within ±1%</p>
    </div>
  )
}

/**
 * Grind suggestions: each past shot replayed against the suggestion the app would have made
 * from earlier shots only. `result` comes from replaySuggestions; `phone` drops the card
 * heading because the sheet already has a title.
 */
export default function GrindSuggestionsCard({ result, mode = 'fixed', phone = false }) {
  const lead = 'Each past shot replayed: what would the app have suggested from earlier shots only?'
  const head = phone ? null : <h2>Grind suggestions</h2>
  const followedN = result?.followed?.n ?? 0

  if (!result?.enough) {
    const none = !result || result.evaluated === 0
    return (
      <section className={phone ? 'el-card el-in-sheet' : 'el-card'} data-testid="diag-grind-suggestions-empty" aria-label="Grind suggestions">
        {head}
        <p className="muted el-card-lead">{lead}</p>
        <p className="el-pcheck-text">
          {none
            ? 'No replay yet: it needs a forecast that has learned a grind effect, and shots with a grind setting.'
            : `Too few shots that followed a suggestion yet (${followedN}, needs ${MIN_FOLLOWED}).`}
        </p>
      </section>
    )
  }

  const dir = directionText(result.direction)
  const targetWord = mode === 'best' ? 'the average of your Great shots so far' : '20%'
  return (
    <section className={phone ? 'el-card el-in-sheet' : 'el-card'} data-testid="diag-grind-suggestions" aria-label="Grind suggestions">
      {head}
      <p className="muted el-card-lead">{lead}</p>
      <div className="el-gs-tiles">
        <Tile testId="diag-gs-followed" title="Followed (±1 step)" group={result.followed} tone="accent" />
        <Tile testId="diag-gs-not-followed" title="Didn't follow" group={result.notFollowed} tone="grey" />
      </div>
      <p className="el-gs-direction" data-testid="diag-gs-direction">
        {dir.good === null ? null : (
          <span className={`el-headline-icon ${dir.good ? 'is-good' : 'is-warn'}`} aria-hidden="true">{dir.good ? '✓' : '!'}</span>
        )}
        <span>{dir.text}</span>
      </p>
      <p className="el-footnote el-gs-foot">
        Distance from target is how far the shot&apos;s extraction landed from the target in use at the time ({targetWord}).{' '}
        {result.evaluated} shots with a grind setting.
      </p>
    </section>
  )
}
