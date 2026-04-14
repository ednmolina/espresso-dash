import { Suspense, lazy, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { auth, provider } from './firebase'

const AnalyzerApp = lazy(() => import('./components/AnalyzerApp'))
const DashboardApp = lazy(() => import('./components/dashboard/DashboardApp'))

const WORKSPACES = [
  { id: 'dashboard', label: 'Espresso Dashboard', blurb: 'Logging, trends, origins, and experiment views.' },
  { id: 'analyzer', label: 'Particle Analyzer', blurb: 'Image-based coffee particle size workflow.' },
]

const ALLOWED_EMAIL = (import.meta.env.VITE_ALLOWED_EMAIL || '').trim().toLowerCase()

export default function App() {
  const [workspace, setWorkspace] = useState('dashboard')
  const [visited, setVisited] = useState({ dashboard: true, analyzer: false })
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

  const handleWorkspaceChange = (nextWorkspace) => {
    setWorkspace(nextWorkspace)
    setVisited((prev) => (prev[nextWorkspace] ? prev : { ...prev, [nextWorkspace]: true }))
  }

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
          <p className="workspace-kicker">Espresso Lab</p>
          <h1>Checking Access</h1>
          <p className="auth-gate-copy">Authenticating with Firebase.</p>
        </section>
      </main>
    )
  }

  if (authState.status !== 'authenticated') {
    return (
      <main className="auth-gate-shell">
        <section className="auth-gate-card">
          <p className="workspace-kicker">Espresso Lab</p>
          <h1>Sign In</h1>
          <p className="auth-gate-copy">Access is restricted to the configured Google account.</p>
          {authState.error && <div className="auth-gate-error">{authState.error}</div>}
          <button className="dashboard-primary-button auth-gate-button" type="button" onClick={handleGoogleLogin}>
            Continue With Google
          </button>
        </section>
      </main>
    )
  }

  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="workspace-kicker">Espresso Lab</p>
          <h1>React workspace</h1>
        </div>
        <div className="workspace-header-actions">
          <div className="workspace-user-chip">
            {authState.user?.email}
          </div>
          <nav className="workspace-switcher" aria-label="Workspace switcher">
            {WORKSPACES.map((item) => (
              <button
                key={item.id}
                className={`workspace-switch ${workspace === item.id ? 'active' : ''}`}
                onClick={() => handleWorkspaceChange(item.id)}
                title={item.blurb}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <button className="workspace-logout" type="button" onClick={handleLogout}>
            Log Out
          </button>
        </div>
      </header>

      <main className="workspace-body">
        {visited.dashboard && (
          <section className={`workspace-panel ${workspace === 'dashboard' ? 'active' : 'hidden'}`} aria-hidden={workspace !== 'dashboard'}>
            <Suspense fallback={<div className="workspace-loading">Loading espresso dashboard...</div>}>
              <DashboardApp />
            </Suspense>
          </section>
        )}
        {visited.analyzer && (
          <section className={`workspace-panel ${workspace === 'analyzer' ? 'active' : 'hidden'}`} aria-hidden={workspace !== 'analyzer'}>
            <Suspense fallback={<div className="workspace-loading">Loading particle analyzer...</div>}>
              <AnalyzerApp />
            </Suspense>
          </section>
        )}
      </main>
    </div>
  )
}
