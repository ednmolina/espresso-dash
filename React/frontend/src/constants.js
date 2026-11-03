export const REFERENCE_OBJECTS = {
  'US Quarter': 24.26,
  'US Dime': 17.91,
  'US Nickel': 21.21,
  'US Penny': 19.05,
  'Euro 1': 23.25,
  'Euro 2': 25.75,
  'Euro 0.50': 24.25,
}

export const DEFAULT_SETTINGS = {
  threshold_percent: 58.8,
  reference_threshold: 0.4,
  max_cost: 0.35,
  max_cluster_axis: 100.0,
  min_surface: 5.0,
  min_roundness: 0.0,
  quick_mode: false,
  analysis_scale_pct: 100,
  // measurement model (advanced); defaults mirror AnalysisSettings on the server
  background_model: 'poly4',
  threshold_mode: 'half_contrast',
  edge_correction: true,
  axis_method: 'max_radius',
  volume_model: 'legacy',
  min_diameter_um: null,
}

/** Overrides that reproduce the original (pre-measurement-model) algorithm. */
export const LEGACY_SETTINGS = {
  background_model: 'global',
  threshold_mode: 'fixed',
  edge_correction: false,
  axis_method: 'max_radius',
  volume_model: 'legacy',
  min_diameter_um: null,
}

export const MEASUREMENT_KEYS = Object.keys(LEGACY_SETTINGS)

/** Request-body form of the settings: drop nulls so older servers never see them. */
export function settingsPayload(settings) {
  const out = {}
  for (const [k, v] of Object.entries(settings)) {
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) continue
    out[k] = v
  }
  return out
}

export const API = import.meta.env.VITE_API_BASE || '/api'
