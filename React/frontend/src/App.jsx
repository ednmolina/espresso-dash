import { Suspense, lazy, useState } from 'react'

const AnalyzerApp = lazy(() => import('./components/AnalyzerApp'))
const DashboardApp = lazy(() => import('./components/dashboard/DashboardApp'))

const WORKSPACES = [
  { id: 'dashboard', label: 'Espresso Dashboard', blurb: 'Logging, trends, origins, and experiment views.' },
  { id: 'analyzer', label: 'Particle Analyzer', blurb: 'Image-based coffee particle size workflow.' },
]

export default function App() {
  const [workspace, setWorkspace] = useState('dashboard')
  const [visited, setVisited] = useState({ dashboard: true, analyzer: false })

  const handleWorkspaceChange = (nextWorkspace) => {
    setWorkspace(nextWorkspace)
    setVisited((prev) => (prev[nextWorkspace] ? prev : { ...prev, [nextWorkspace]: true }))
  }

  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="workspace-kicker">Espresso Lab</p>
          <h1>React workspace</h1>
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
