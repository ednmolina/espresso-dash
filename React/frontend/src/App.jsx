import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { auth, provider } from './firebase'
import DashboardSkeleton from './components/dashboard/DashboardSkeleton'
import { NavContext, WORKSPACES, formatHash, parseHash } from './navigation'
import './components/shell/shell.css'

const AnalyzerApp = lazy(() => import('./components/AnalyzerApp'))
const DashboardApp = lazy(() => import('./components/dashboard/DashboardApp'))
const GrinderPage = lazy(() => import('./components/grinder/GrinderPage'))
const ForecastPage = lazy(() => import('./components/forecast/ForecastPage'))
const DiagnosticsPage = lazy(() => import('./components/diagnostics/DiagnosticsPage'))

const TAB_ICONS = {
  shots: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6V9z" /><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17" /><path d="M8 3c0 1.5 1.5 1.5 1.5 3M12 3c0 1.5 1.5 1.5 1.5 3" /></svg>
  ),
  analyzer: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
  ),
  grinder: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg>
  ),
  forecast: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17l5-5 4 3 8-8" /><path d="M15 7h5v5" /></svg>
  ),
  diagnostics: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>
  ),
}

const WORKSPACE_FALLBACKS = {
  shots: <DashboardSkeleton />,
  analyzer: <div className="workspace-loading">Loading particle analyzer…</div>,
  grinder: <div className="workspace-loading">Loading grinder…</div>,
  forecast: <div className="workspace-loading">Loading forecast…</div>,
  diagnostics: <div className="workspace-loading">Loading diagnostics…</div>,
}

const ALLOWED_EMAIL = (import.meta.env.VITE_ALLOWED_EMAIL || '').trim().toLowerCase()

export default function App() {
  const [authState, setAuthState] = useState({
    status: 'loading',
    user: null,
    error: '',
  })

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setAuthState({ status: 'signed_out', user: null, error: '' })
        return
      }

      const email = (user.email || '').trim().toLowerCase()
      if (!email || email !== ALLOWED_EMAIL) {
        await signOut(auth).catch(() => {})
        setAuthState({
          status: 'signed_out',
          user: null,
          error: `Access is restricted to ${ALLOWED_EMAIL || 'the configured account'}.`,
        })
        return
      }

      setAuthState({ status: 'authenticated', user, error: '' })
    })

    return () => unsubscribe()
  }, [])

  const handleGoogleLogin = async () => {
    setAuthState((prev) => ({ ...prev, status: 'loading', error: '' }))
    try {
      const result = await signInWithPopup(auth, provider)
      const email = (result.user.email || '').trim().toLowerCase()
      if (!email || email !== ALLOWED_EMAIL) {
        await signOut(auth).catch(() => {})
        setAuthState({
          status: 'signed_out',
          user: null,
          error: `Access is restricted to ${ALLOWED_EMAIL || 'the configured account'}.`,
        })
      }
    } catch (error) {
      setAuthState({
        status: 'signed_out',
        user: null,
        error: error?.message || 'Google sign-in failed.',
      })
    }
  }

  const handleLogout = async () => {
    await signOut(auth).catch(() => {})
    setAuthState({ status: 'signed_out', user: null, error: '' })
  }

  if (authState.status === 'loading') {
    return (
      <main className="auth-gate-shell">
        <section className="auth-gate-card">
          <div className="workspace-brand"><BrandMark /><span>Espresso Lab</span></div>
          <h1>Checking access</h1>
          <p className="auth-gate-copy"><span className="auth-spinner" aria-hidden="true" />Authenticating with Firebase.</p>
        </section>
      </main>
    )
  }

  if (authState.status !== 'authenticated') {
    return (
      <main className="auth-gate-shell">
        <section className="auth-gate-card">
          <div className="workspace-brand"><BrandMark /><span>Espresso Lab</span></div>
          <h1>Sign in</h1>
          <p className="auth-gate-copy">Your espresso journal and grind analyzer, in one private workspace. Access is restricted to the configured Google account.</p>
          {authState.error && <div className="auth-gate-error">{authState.error}</div>}
          <button className="dashboard-primary-button auth-gate-button" type="button" onClick={handleGoogleLogin}>
            Continue with Google
          </button>
        </section>
      </main>
    )
  }

  return <Workspace user={authState.user} onLogout={handleLogout} />
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6V9z" />
      <path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17" />
      <path d="M8 3c0 1.5 1.5 1.5 1.5 3M12 3c0 1.5 1.5 1.5 1.5 3" />
    </svg>
  )
}

function readRoute() {
  if (typeof window === 'undefined') return { workspace: 'shots', tab: 'overview' }
  return parseHash(window.location.hash)
}

export function Workspace({ user, onLogout }) {
  const [route, setRoute] = useState(readRoute)
  const [params, setParams] = useState({})
  const [shotsTab, setShotsTab] = useState(() => readRoute().tab ?? 'overview')
  const [visited, setVisited] = useState(() => ({ [readRoute().workspace]: true }))
  const workspace = route.workspace

  const applyRoute = useCallback((next) => {
    setRoute({ workspace: next.workspace, tab: next.tab })
    if (next.workspace === 'shots' && next.tab) setShotsTab(next.tab)
    setVisited((prev) => (prev[next.workspace] ? prev : { ...prev, [next.workspace]: true }))
  }, [])

  // back/forward and hand-edited hashes
  useEffect(() => {
    const onChange = () => {
      applyRoute(parseHash(window.location.hash))
      setParams({})
    }
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
      window.removeEventListener('popstate', onChange)
    }
  }, [applyRoute])

  const go = useCallback((nextWorkspace, { tab, params: nextParams } = {}) => {
    const ws = WORKSPACES.some((item) => item.id === nextWorkspace) ? nextWorkspace : 'shots'
    const nextTab = ws === 'shots' ? (tab ?? shotsTab) : null
    const hash = formatHash({ workspace: ws, tab: nextTab })
    if (window.location.hash !== hash) {
      try {
        window.history.pushState(null, '', hash)
      } catch {
        // history unavailable (sandboxed frame): the in-memory route still works
      }
    }
    setParams(nextParams ?? {})
    applyRoute({ workspace: ws, tab: nextTab })
    if (ws !== workspace) window.scrollTo?.(0, 0)
  }, [applyRoute, shotsTab, workspace])

  const nav = useMemo(() => ({ workspace, shotsTab, params, go }), [workspace, shotsTab, params, go])

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const panelRefs = useRef({})

  useEffect(() => {
    if (!menuOpen) return undefined
    const onPointer = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Hidden panels stay mounted (state is kept) but must not be focusable.
  useEffect(() => {
    WORKSPACES.forEach((item) => {
      const node = panelRefs.current[item.id]
      if (!node) return
      if (item.id !== workspace) node.setAttribute('inert', '')
      else node.removeAttribute('inert')
    })
  }, [workspace, visited])

  const initial = (user?.email?.[0] ?? '?').toUpperCase()

  const renderPanel = (id) => {
    switch (id) {
      case 'shots': return <DashboardApp />
      case 'analyzer': return <AnalyzerApp user={user} />
      case 'grinder': return <GrinderPage />
      case 'forecast': return <ForecastPage />
      default: return <DiagnosticsPage />
    }
  }

  return (
    <NavContext.Provider value={nav}>
      <div className={`workspace-shell workspace-${workspace}`}>
        <header className="workspace-header">
          <div className="workspace-header-inner">
            <div className="workspace-brand">
              <BrandMark />
              <span>Espresso Lab</span>
            </div>
            <nav className="workspace-switcher" aria-label="Workspaces">
              {WORKSPACES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="workspace-switch"
                  data-testid={`nav-${item.id}`}
                  aria-current={workspace === item.id ? 'page' : undefined}
                  onClick={() => go(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="workspace-header-actions">
              <div className="workspace-user-chip workspace-user-chip-static" title={user?.email}>{initial}</div>
              <button className="workspace-logout" type="button" onClick={onLogout} data-testid="logout">
                Log out
              </button>
              <div className="workspace-user-menu" ref={menuRef}>
                <button
                  type="button"
                  className="workspace-user-chip-button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="Account menu"
                  onClick={() => setMenuOpen((prev) => !prev)}
                  data-testid="user-menu-button"
                >
                  <span className="workspace-user-chip">{initial}</span>
                </button>
                {menuOpen && (
                  <div className="workspace-user-popover" role="menu">
                    <div className="workspace-user-email">{user?.email}</div>
                    <button type="button" role="menuitem" onClick={onLogout} data-testid="logout-menu">Log out</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="workspace-body">
          {WORKSPACES.map((item) => (
            visited[item.id] && (
              <section
                key={item.id}
                ref={(node) => { panelRefs.current[item.id] = node }}
                className={`workspace-panel ${workspace === item.id ? 'active' : 'hidden'}`}
                aria-hidden={workspace !== item.id}
              >
                <Suspense fallback={WORKSPACE_FALLBACKS[item.id]}>
                  {renderPanel(item.id)}
                </Suspense>
              </section>
            )
          ))}
        </main>

        <nav className="app-tabbar" aria-label="Main" data-testid="app-tabbar">
          {WORKSPACES.map((item) => (
            <button
              key={item.id}
              type="button"
              className="app-tabbar-item"
              data-testid={`tabbar-${item.id}`}
              aria-current={workspace === item.id ? 'page' : undefined}
              onClick={() => go(item.id)}
            >
              {TAB_ICONS[item.id]}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </NavContext.Provider>
  )
}
