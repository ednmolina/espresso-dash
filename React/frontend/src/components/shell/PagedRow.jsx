import { Children, useCallback, useEffect, useRef, useState } from 'react'

/** Horizontal scroll-snap row (one page per child) with previous/next buttons and page dots. */
export default function PagedRow({ ariaLabel, testId, children }) {
  const items = Children.toArray(children)
  const trackRef = useRef(null)
  const [page, setPage] = useState(0)

  const onScroll = useCallback(() => {
    const node = trackRef.current
    if (!node || !node.clientWidth) return
    setPage(Math.max(0, Math.min(items.length - 1, Math.round(node.scrollLeft / node.clientWidth))))
  }, [items.length])

  useEffect(() => { onScroll() }, [onScroll])

  const goTo = (index) => {
    const node = trackRef.current
    if (!node) return
    const target = Math.max(0, Math.min(items.length - 1, index))
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    node.scrollTo({ left: target * node.clientWidth, behavior: reduce ? 'auto' : 'smooth' })
    setPage(target)
  }

  return (
    <div className="el-paged" data-testid={testId}>
      <div
        ref={trackRef}
        className="el-paged-track"
        role="group"
        aria-roledescription="carousel"
        aria-label={ariaLabel}
        onScroll={onScroll}
      >
        {items.map((child, index) => (
          <div
            className="el-paged-item"
            key={child.key ?? index}
            role="group"
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${items.length}`}
          >
            {child}
          </div>
        ))}
      </div>
      {items.length > 1 && (
        <div className="el-paged-dots">
          <button type="button" className="el-paged-arrow" aria-label="Previous card" disabled={page === 0} onClick={() => goTo(page - 1)}>
            <svg width="9" height="15" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 1L1 7l6 6" /></svg>
          </button>
          {items.map((child, index) => (
            <button
              key={child.key ?? index}
              type="button"
              className="el-paged-dot"
              aria-label={`Card ${index + 1} of ${items.length}`}
              aria-current={index === page ? 'true' : undefined}
              onClick={() => goTo(index)}
            >
              <span />
            </button>
          ))}
          <button type="button" className="el-paged-arrow" aria-label="Next card" disabled={page === items.length - 1} onClick={() => goTo(page + 1)}>
            <svg width="9" height="15" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 1l6 6-6 6" /></svg>
          </button>
        </div>
      )}
    </div>
  )
}

export { PagedRow }
