import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { auth, provider } from './firebase'
import DashboardSkeleton from './components/dashboard/DashboardSkeleton'

const AnalyzerApp = lazy(() => import('./components/AnalyzerApp'))
const DashboardApp = lazy(() => import('./components/dashboard/DashboardApp'))

const WORKSPACES = [
  { id: 'dashboard', label: 'Shots', blurb: 'Logging, trends, origins, and experiment views.' },
  { id: 'analyzer', label: 'Grind Analyzer', blurb: 'Image-based coffee particle size workflow.' },
]

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
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <ellipse cx="16" cy="16" rx="10" ry="13" transform="rotate(35 16 16)" />
      <path d="M10.5 24.5c3.5-3 3-6.5 5.5-9s5.5-3 5.5-8" />
    </svg>
  )
}

export function Workspace({ user, onLogout }) {
  const [workspace, setWorkspace] = useState('dashboard')
  const [visited, setVisited] = useState({ dashboard: true, analyzer: false })

  const handleWorkspaceChange = (nextWorkspace) => {
    setWorkspace(nextWorkspace)
    setVisited((prev) => (prev[nextWorkspace] ? prev : { ...prev, [nextWorkspace]: true }))
  }

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const dashboardPanelRef = useRef(null)
  const analyzerPanelRef = useRef(null)

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
    const sync = (node, hidden) => {
      if (!node) return
      if (hidden) node.setAttribute('inert', '')
      else node.removeAttribute('inert')
    }
    sync(dashboardPanelRef.current, workspace !== 'dashboard')
    sync(analyzerPanelRef.current, workspace !== 'analyzer')
  }, [workspace, visited])

  const initial = (user?.email?.[0] ?? '?').toUpperCase()

  return (
    <div className={`workspace-shell workspace-${workspace}`}>
      <header className="workspace-header">
        <div className="workspace-brand">
          <BrandMark />
          <span>Espresso Lab</span>
        </div>
        <nav className="workspace-switcher" aria-label="Workspace switcher">
          {WORKSPACES.map((item) => (
            <button
              key={item.id}
              className={`workspace-switch ${workspace === item.id ? 'active' : ''}`}
              onClick={() => handleWorkspaceChange(item.id)}
              title={item.blurb}
              aria-pressed={workspace === item.id}
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
              className="workspace-user-chip workspace-user-chip-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Account menu"
              onClick={() => setMenuOpen((prev) => !prev)}
              data-testid="user-menu-button"
            >
              {initial}
            </button>
            {menuOpen && (
              <div className="workspace-user-popover" role="menu">
                <div className="workspace-user-email">{user?.email}</div>
                <button type="button" role="menuitem" onClick={onLogout} data-testid="logout-menu">Log out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="workspace-body">
        {visited.dashboard && (
          <section ref={dashboardPanelRef} className={`workspace-panel ${workspace === 'dashboard' ? 'active' : 'hidden'}`} aria-hidden={workspace !== 'dashboard'}>
            <Suspense fallback={<DashboardSkeleton />}>
              <DashboardApp />
            </Suspense>
          </section>
        )}
        {visited.analyzer && (
          <section ref={analyzerPanelRef} className={`workspace-panel ${workspace === 'analyzer' ? 'active' : 'hidden'}`} aria-hidden={workspace !== 'analyzer'}>
            <Suspense fallback={<div className="workspace-loading">Loading particle analyzer…</div>}>
              <AnalyzerApp user={user} />
            </Suspense>
          </section>
        )}
      </main>
    </div>
  )
}
