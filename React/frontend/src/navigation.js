import { createContext, useContext } from 'react'

export const WORKSPACES = [
  { id: 'shots', label: 'Shots' },
  { id: 'analyzer', label: 'Analyzer' },
  { id: 'grinder', label: 'Grinder' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'diagnostics', label: 'Diagnostics' },
]

export const SHOTS_TABS = ['overview', 'origins', 'log', 'experiments']

const WORKSPACE_IDS = WORKSPACES.map((item) => item.id)

/** '#/shots/log' -> {workspace:'shots', tab:'log'}; unknown -> {workspace:'shots', tab:'overview'}. */
export function parseHash(hash) {
  const text = String(hash ?? '').replace(/^#\/?/, '').split('?')[0]
  const [workspace, tab] = text.split('/').map((part) => part.trim().toLowerCase())
  if (!WORKSPACE_IDS.includes(workspace)) return { workspace: 'shots', tab: 'overview' }
  if (workspace === 'shots') return { workspace, tab: SHOTS_TABS.includes(tab) ? tab : 'overview' }
  return { workspace, tab: null }
}

/** {workspace:'shots', tab:'log'} -> '#/shots/log'; {workspace:'grinder'} -> '#/grinder'. */
export function formatHash({ workspace, tab } = {}) {
  const safe = WORKSPACE_IDS.includes(workspace) ? workspace : 'shots'
  if (safe === 'shots') return `#/shots/${SHOTS_TABS.includes(tab) ? tab : 'overview'}`
  return `#/${safe}`
}

const DEFAULT_NAV = {
  workspace: 'shots',
  shotsTab: 'overview',
  params: {},
  go() {},
}

export const NavContext = createContext(DEFAULT_NAV)

/** -> { workspace, shotsTab, params, go(workspace, {tab?, params?}={}) } */
export function useNav() {
  return useContext(NavContext)
}
