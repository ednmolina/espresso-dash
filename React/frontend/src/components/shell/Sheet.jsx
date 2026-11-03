import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import useBreakpoint from './useBreakpoint'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const stack = []
const CLOSE_MS = 420

function prefersReducedMotion() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

/**
 * Modal sheet. <=640px: bottom sheet with detents (medium 60vh, large nearly full).
 * Wider: a centred card (max-width 560px). Esc or the scrim closes; focus moves in and is restored.
 */
export default function Sheet({
  open,
  onClose,
  title,
  leftAction,
  rightAction,
  detents = ['medium', 'large'],
  initialDetent = 'medium',
  testId,
  children,
}) {
  const phone = useBreakpoint() === 'phone'
  const titleId = useId()
  const panelRef = useRef(null)
  const restoreRef = useRef(null)
  const dragRef = useRef(null)
  const idRef = useRef({})
  const [present, setPresent] = useState(open)
  const [shown, setShown] = useState(false)
  const [detent, setDetent] = useState(initialDetent)
  const [dragY, setDragY] = useState(0)

  // mount / unmount with an exit animation
  useEffect(() => {
    if (open) {
      setPresent(true)
      setDetent(initialDetent)
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(frame)
    }
    setShown(false)
    const timer = setTimeout(() => setPresent(false), prefersReducedMotion() ? 160 : CLOSE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // focus handling and scroll lock while open
  useEffect(() => {
    if (!open || !present) return undefined
    restoreRef.current = document.activeElement
    const panel = panelRef.current
    const first = panel?.querySelector('[data-autofocus]') ?? panel?.querySelector('.el-sheet-body input, .el-sheet-body select, .el-sheet-body textarea, .el-sheet-body button')
    ;(first ?? panel)?.focus({ preventScroll: true })
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    stack.push(idRef.current)
    return () => {
      document.body.style.overflow = overflow
      const at = stack.indexOf(idRef.current)
      if (at >= 0) stack.splice(at, 1)
      const target = restoreRef.current
      if (target && typeof target.focus === 'function' && document.contains(target)) target.focus({ preventScroll: true })
    }
  }, [open, present])

  const onKeyDown = useCallback((event) => {
    if (stack[stack.length - 1] !== idRef.current) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose?.()
      return
    }
    if (event.key !== 'Tab') return
    const nodes = [...(panelRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((node) => node.offsetParent !== null || node === document.activeElement)
    if (!nodes.length) return
    const firstNode = nodes[0]
    const lastNode = nodes[nodes.length - 1]
    if (event.shiftKey && (document.activeElement === firstNode || document.activeElement === panelRef.current)) {
      event.preventDefault()
      lastNode.focus()
    } else if (!event.shiftKey && document.activeElement === lastNode) {
      event.preventDefault()
      firstNode.focus()
    }
  }, [onClose])

  useEffect(() => {
    if (!open) return undefined
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onKeyDown])

  const stepDown = () => {
    const at = detents.indexOf(detent)
    if (at > 0) setDetent(detents[at - 1])
    else onClose?.()
  }
  const stepUp = () => {
    const at = detents.indexOf(detent)
    if (at >= 0 && at < detents.length - 1) setDetent(detents[at + 1])
  }

  const onPointerDown = (event) => {
    if (!phone || (event.pointerType === 'mouse' && event.button !== 0)) return
    const onGrab = event.currentTarget.classList.contains('el-sheet-grab')
    if (!onGrab && event.target.closest?.('button')) return
    dragRef.current = { startY: event.clientY, startTime: event.timeStamp, moved: false, onGrab }
    if (onGrab) event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag) return
    const dy = event.clientY - drag.startY
    if (Math.abs(dy) > 4) drag.moved = true
    setDragY(Math.max(dy, -60))
  }
  const onPointerUp = (event) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    const dy = event.clientY - drag.startY
    const velocity = dy / Math.max(event.timeStamp - drag.startTime, 1)
    setDragY(0)
    if (dy > 80 || (dy > 24 && velocity > 0.6)) stepDown()
    else if (dy < -40 || (dy < -16 && velocity < -0.6)) stepUp()
    else if (!drag.moved && drag.onGrab) {
      // a tap on the grab handle toggles the detent
      if (detents.length > 1) setDetent(detent === detents[detents.length - 1] ? detents[0] : detents[detents.length - 1])
    }
  }

  if (!present) return null

  const left = leftAction ? (
    <button type="button" className="el-sheet-action" onClick={leftAction.onClick ?? onClose}>{leftAction.label}</button>
  ) : null
  const right = rightAction ? (
    <button
      type={rightAction.form ? 'submit' : 'button'}
      form={rightAction.form}
      className={`el-sheet-action primary ${rightAction.tone ?? ''}`.trim()}
      onClick={rightAction.onClick}
      disabled={rightAction.disabled}
      data-testid={rightAction.testId}
    >
      {rightAction.label}
    </button>
  ) : null

  return createPortal(
    <div className={`el-sheet ${shown ? 'is-open' : ''}`} data-testid={testId ? `${testId}-root` : undefined}>
      <div className="el-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="el-sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-detent={phone ? detent : 'card'}
        data-testid={testId}
        style={phone && dragY ? { transform: `translateY(${Math.max(dragY, 0)}px)`, transition: 'none' } : undefined}
      >
        {phone && (
          <div
            className="el-sheet-grab"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { dragRef.current = null; setDragY(0) }}
          >
            <span className="el-sheet-handle" aria-hidden="true" />
          </div>
        )}
        <div
          className="el-sheet-bar"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { dragRef.current = null; setDragY(0) }}
        >
          <div className="el-sheet-bar-side">{left}</div>
          <h2 className="el-sheet-title" id={titleId}>{title}</h2>
          <div className="el-sheet-bar-side right">{right}</div>
        </div>
        <div className="el-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export { Sheet }
