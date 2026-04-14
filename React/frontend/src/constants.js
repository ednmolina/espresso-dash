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
}

export const API = import.meta.env.VITE_API_BASE || '/api'
