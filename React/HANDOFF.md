# Developer handoff - Espresso Lab

Start with the [root README](../README.md) for setup, deployment and testing. This file explains how the pieces fit together and where to look when changing them.

## What the app is

A private workspace with two tabs behind Google sign-in (single allow-listed e-mail):

1. **Shots**: an espresso log (Firestore) with metrics, charts, an origins map and an experiment simulator.
2. **Grind Analyzer**: particle size distribution of ground coffee from a photo. Grounds are spread on white paper next to a coin; the app detects particles, converts pixels to millimetres with the coin and reports Dv10/50/90, span and histograms so that grinders and settings can be compared objectively.

## Architecture

```
Browser (React SPA, GitHub Pages)
  |- Firebase Auth: Google sign-in, ID token
  |- Firestore: shots (read/write from the browser; localStorage cache fallback)
  |- /api/* (VITE_API_BASE in production) with Bearer ID token
        v
Cloud Run: FastAPI  cloudrun/main.py
  |- /upload /analyze /erase /histogram /histogram/compare /preview /health
  |- coffeegrindsize_core (cloudrun/coffeegrindsize_core): numpy + numba
        v
Cloud Storage: images and results under tmp/ (2-day lifecycle)
```

There is a single copy of `coffeegrindsize_core`, inside `cloudrun/` (the Docker build context). The old `React/backend` and the repo-root copy were removed.

## Code map

```
React/frontend/src/
  main.jsx, App.jsx            Auth gate, workspace shell and tab switcher
  firebase.js, firestore.js    Firebase app/auth, and Firestore (kept separate so Firestore loads lazily)
  dashboardData.js             Shot loading, caching, derived metrics
  components/dashboard/        Shot dashboard
  components/AnalyzerApp.jsx   Analyzer state machine and API calls
  components/ImageCanvas.jsx   Zoom/pan canvas, point placement, overlays
  components/Sidebar.jsx       Detection settings
  components/ResultsPanel.jsx  Summary metrics, histogram stats
  components/HistogramChart.jsx
  constants.js                 Reference presets, default settings, API base
React/frontend/e2e/            Playwright specs, harness page, fixture image
cloudrun/main.py               HTTP layer: auth, validation, storage, response shaping
cloudrun/coffeegrindsize_core/
  analysis.py                  analyze_image, AnalysisSettings, summarize_dataset
  _kernels.py                  numba kernels (+ warm_up)
  background.py, stats.py      illumination flattening; weighted/bootstrap statistics
  plotting.py                  server-side histogram PNGs
tests/                         pytest (core parity, model, API)
```

## Analysis pipeline

1. Blue channel (brown grounds are dark in blue, white paper is bright).
2. Optional illumination flattening (`background_model=poly4`), then threshold (`half_contrast` by default).
3. Grow a cluster from each dark pixel, split touching particles in the break-up step, reject clusters touching the border or outside the region.
4. Per particle: surface, long/short axis, roundness, volume; `pixel_scale` converts to mm.
5. `summarize_dataset` builds the statistics; `metric_values` / `metric_weights` feed histograms.

Details of the model options, their measured effect and the known limits are in the README "Modeling notes". Extraction yield and efficiency are a heuristic, not a measurement.

## API conventions

- Errors are `{"detail": "<string>"}` (422 keeps FastAPI's list form); 413 too large, 503 busy.
- Non-finite numbers are always `null`.
- `/analyze` returns particles as columns (`{id: [], surface: [], ...}`) in analysis pixels, plus `analysis_scale` when the image was downscaled. `/erase` takes points and radius in full-image pixels (x = column, y = row) and returns `removed_ids`; the browser filters its particle columns locally.
- `analysis_id` freezes a run so saved runs can be compared after later edits to the live analysis.

## Gotchas

- Set `LOCAL_DEV=true` only locally; it skips authentication.
- The numba cache must be writable by the runtime user (`NUMBA_CACHE_DIR`); the Dockerfile bakes it into the image.
- Changing `_kernels.py` invalidates the cache; the first request afterwards pays the compile cost locally.
- The Vite base path is `/espresso-dash/` only for production builds (`VITE_GITHUB_PAGES_BASE`).
- The e2e harness (`e2e/harness/`) is served by the dev server only and is not part of `vite build`.

## Ideas not yet built

- Breakup of touching particles by watershed; area estimation from sub-pixel coverage.
- Calibration of the extraction heuristic against measured TDS.
