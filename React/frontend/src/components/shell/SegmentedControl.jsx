import { useRef } from 'react'

/**
 * Apple-style segmented control. role="tablist" renders tabs (aria-selected),
 * role="radiogroup" renders radios (aria-checked). `trailing` is extra content
 * placed inside the pill after the items (for example a link segment).
 */
export default function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
  itemClassName = '',
  testIdPrefix = '',
  role = 'tablist',
  className = '',
  trailing = null,
  testId,
}) {
  const refs = useRef({})
  const itemRole = role === 'radiogroup' ? 'radio' : 'tab'

  const move = (event, index) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    let next = null
    if (event.key in keys) next = (index + keys[event.key] + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    if (next === null) return
    event.preventDefault()
    const option = options[next]
    onChange(option.id)
    refs.current[option.id]?.focus()
  }

  return (
    <div className={`el-seg ${className}`.trim()} data-testid={testId}>
      <div className="el-seg-items" role={role} aria-label={ariaLabel}>
        {options.map((option, index) => {
          const active = option.id === value
          const ariaState = itemRole === 'radio' ? { 'aria-checked': active } : { 'aria-selected': active }
          return (
            <button
              key={option.id}
              ref={(node) => { refs.current[option.id] = node }}
              type="button"
              role={itemRole}
              {...ariaState}
              tabIndex={active ? 0 : -1}
              data-testid={testIdPrefix ? `${testIdPrefix}${option.id}` : undefined}
              className={`el-seg-item ${itemClassName} ${active ? 'active' : ''}`.trim()}
              onClick={() => onChange(option.id)}
              onKeyDown={(event) => move(event, index)}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      {trailing}
    </div>
  )
}

export { SegmentedControl }
