import { useEffect, useRef, useState } from 'react'
import useBreakpoint from './useBreakpoint'

const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

/**
 * Large page title (48px desktop, 34px phone). On phone a compact sticky title
 * appears once the large title scrolls away, and `phoneAction` shows as a "+".
 */
export default function PageHeader({ kicker, title, actions, phoneAction, testId }) {
  const breakpoint = useBreakpoint()
  const phone = breakpoint === 'phone'
  const titleRef = useRef(null)
  const [titleVisible, setTitleVisible] = useState(true)

  useEffect(() => {
    const node = titleRef.current
    if (!phone || !node || typeof IntersectionObserver === 'undefined') {
      setTitleVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver(
      ([entry]) => setTitleVisible(entry.isIntersecting),
      { rootMargin: '-44px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [phone])

  const plus = phone && phoneAction ? (
    <button type="button" className="el-plus-button" aria-label={phoneAction.label} onClick={phoneAction.onClick} data-testid={phoneAction.testId}>
      <span><PlusIcon /></span>
    </button>
  ) : null

  return (
    <header className="el-page-header" data-testid={testId}>
      {phone && !titleVisible && (
        <div className="el-compact-bar" data-testid={testId ? `${testId}-compact` : undefined}>
          <span className="el-compact-bar-title">{title}</span>
          {phoneAction ? (
            <button type="button" className="el-plus-button" aria-label={phoneAction.label} onClick={phoneAction.onClick}>
              <span><PlusIcon /></span>
            </button>
          ) : null}
        </div>
      )}
      <div className="el-page-header-text">
        <div className="el-page-kicker-row">
          {kicker ? <div className="el-kicker">{kicker}</div> : <span />}
          {plus}
        </div>
        <h1 ref={titleRef} className="el-page-title">{title}</h1>
      </div>
      {!phone && actions ? <div className="el-page-actions">{actions}</div> : null}
    </header>
  )
}

export { PageHeader }
