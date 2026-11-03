import { useRef, useState } from 'react'

const ACTION_W = 84

/**
 * A list row with trailing actions. On touch, swiping left reveals them; with a
 * pointer or keyboard they are real buttons shown on hover or focus-within.
 */
export default function SwipeRow({ actions = [], onTap, testId, children }) {
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState(false)
  const dragRef = useRef(null)
  const full = actions.length * ACTION_W

  const onPointerDown = (event) => {
    if (event.pointerType !== 'touch' || !actions.length) return
    dragRef.current = { x: event.clientX, y: event.clientY, base: open ? -full : 0, active: false }
  }
  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.active) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return
      drag.active = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    setOffset(Math.max(-full, Math.min(0, drag.base + dx)))
  }
  const finish = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag?.active) return
    const shouldOpen = offset < -full / 2
    setOpen(shouldOpen)
    setOffset(0)
    drag.swiped = true
  }

  const activate = () => {
    if (open) { setOpen(false); return }
    onTap?.()
  }

  const translate = dragRef.current?.active ? offset : (open ? -full : 0)

  return (
    <div className={`el-swipe ${open ? 'is-open' : ''}`} data-testid={testId} style={{ '--el-swipe-w': `${full}px` }}>
      {actions.length > 0 && (
        <div className="el-swipe-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`el-swipe-action ${action.tone === 'destructive' ? 'destructive' : ''}`}
              style={{ width: ACTION_W }}
              onClick={() => { setOpen(false); action.onAction?.() }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <div
        className="el-swipe-content"
        style={{ transform: translate ? `translateX(${translate}px)` : undefined, transition: dragRef.current?.active ? 'none' : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        {onTap ? (
          <div
            className="el-swipe-tap"
            role="button"
            tabIndex={0}
            onClick={activate}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                activate()
              }
            }}
          >
            {children}
          </div>
        ) : children}
      </div>
    </div>
  )
}

export { SwipeRow }
