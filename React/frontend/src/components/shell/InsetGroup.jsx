/** iOS-style inset grouped list container. */
export function InsetGroup({ header, footer, children, testId }) {
  return (
    <section className="el-inset" data-testid={testId}>
      {header ? <h3 className="el-inset-header">{header}</h3> : null}
      <div className="el-inset-body">{children}</div>
      {footer ? <p className="el-inset-footer">{footer}</p> : null}
    </section>
  )
}

const Chevron = () => (
  <svg className="el-chevron" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 1l6 6-6 6" />
  </svg>
)

/** A row inside an InsetGroup. Becomes a button when it has an onClick. */
export function ListRow({ title, subtitle, detail, chevron = true, onClick, testId, leading = null, className = '' }) {
  const content = (
    <>
      {leading}
      <span className="el-row-main">
        <span className="el-row-title">{title}</span>
        {subtitle ? <span className="el-row-sub">{subtitle}</span> : null}
      </span>
      {detail ? <span className="el-row-detail">{detail}</span> : null}
      {onClick && chevron ? <Chevron /> : null}
    </>
  )
  if (onClick) {
    return (
      <button type="button" className={`el-row ${className}`.trim()} onClick={onClick} data-testid={testId}>
        {content}
      </button>
    )
  }
  return <div className={`el-row ${className}`.trim()} data-testid={testId}>{content}</div>
}

export default InsetGroup
