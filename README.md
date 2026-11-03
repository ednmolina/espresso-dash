# Espresso Lab

A private espresso workspace in one React app with two tabs:

- **Shots** (dashboard): log espresso shots, review extraction/TDS/rating trends, explore coffee origins on a map, and run experiment comparisons against past shots. Data lives in Firestore with a local cache fallback; the shot table can be exported as CSV.
- **Grind Analyzer**: measure the particle size distribution of ground coffee from a photo. Upload a picture of grounds on white paper, click the two edges of a reference coin for scale, optionally outline the region to analyze, run detection, erase stray clusters, and read off Dv10/50/90, span, histograms and a per-particle CSV. Up to three runs can be saved and compared.

Access is restricted to an allow-list of Google accounts.

## Architecture

```
Browser: React SPA (Vite) on GitHub Pages
   |  Firebase Auth (Google sign-in) -> ID token
   |  Firestore: shot log (reads/writes straight from the browser)
   |  HTTPS + "Authorization: Bearer <ID token>"
   v
Cloud Run: FastAPI (cloudrun/main.py) -> coffeegrindsize_core (numpy + numba)
   v
Cloud Storage: uploaded images and analysis results under tmp/ (auto-deleted after 2 days)
```

- The SPA signs the user in with Firebase Auth and checks the e-mail against `VITE_ALLOWED_EMAIL`.
- Every API call carries the Firebase ID token. The backend verifies it with `firebase-admin` and only accepts verified e-mails listed in `ALLOWED_EMAILS` (comma separated).
- `LOCAL_DEV=true` disables token checks and stores results on local disk instead of GCS. Never set it in production.

## Repository layout

| Path | What it is |
| --- | --- |
| `React/frontend/` | Vite + React app (dashboard and analyzer), `e2e/` Playwright tests |
| `cloudrun/main.py` | FastAPI service (upload, analyze, erase, histogram, compare, `/health`) |
| `cloudrun/coffeegrindsize_core/` | Analysis library (numba kernels, measurement model, plotting). The only copy in the repo |
| `cloudrun/Dockerfile`, `requirements.txt`, `.python-version` | Container image and pinned dependencies (Python 3.12) |
| `cloudrun/gcs-lifecycle.json` | Bucket lifecycle rule for temporary objects |
| `tests/` | Python tests (`pytest`), including parity tests against the original algorithm |
| `.github/workflows/` | `tests.yml` (pytest, build, e2e) and `deploy-pages.yml` (GitHub Pages) |
| `streamlit_app.py`, `requirements.txt` (root) | Legacy Streamlit prototype. It does not use `cloudrun/` and is kept for reference only |
| `React/README.md`, `React/HANDOFF.md` | Frontend notes and architecture hand-off |

## Local development

Backend (Python 3.12 recommended):

```bash
cd cloudrun
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
LOCAL_DEV=true uvicorn main:app --reload --port 8000
```

Frontend:

```bash
cd React/frontend
cp .env.example .env.local     # fill in the VITE_FIREBASE_* values for the real dashboard
npm ci
npm run dev                    # http://localhost:5173
```

The dev server proxies `/api/*` to `http://localhost:8000` (change with `VITE_API_PROXY_TARGET`). The first analysis after a cold start compiles the numba kernels (about 5-9 s); the backend warms them in a background thread at startup and `GET /health` reports `"warm": true` when done.

## Performance notes

- The detection loop (flood fill, nearest-dark search, edge rejection, polygon mask) is compiled with numba, roughly 30x faster than the original pure Python.
- Measured on the dev container (4 cores, defaults, warm cache): 1.1 MP photo about 0.15 s, 4.3 MP about 0.6 s, 6.75 MP about 1.2 s (quick mode about 0.4-0.8 s). End-to-end `/analyze` for a 2400x1800 photo was 1.3-1.6 s before the kernel rewrite and the response also carries two overlay PNGs and the particle table (gzip-compressed). Numbers vary with machine load.
- Cold compile is about 5-6 s (up to 9 s on a busy machine); loading the cache takes about 0.4 s. The Docker build runs `main.warm_up_kernels()` so the compiled cache ships in the image.
- `NUMBA_CPU_NAME=generic` makes the cache portable across CPU models with no measurable slowdown, which matters because Cloud Run builds and runs on different hardware.
- Peak memory for a 12 MP image is about 550 MB, so the service is deployed with 2 GiB. The backend caps the analysis image at 16 MP (`MAX_ANALYSIS_PIXELS`) and rejects uploads over 25 MB / 40 MP.
- If numba cannot be imported the kernels fall back to plain Python, which is functionally identical but dozens of times slower; `requirements.txt` pins numba so the deployed image never takes that path.
- Pathological images (dense, textured clumps) used to take 30-45 s; the nearest-dark and path searches are now bounded and take about 2 s.

## Modeling notes

The pipeline follows the original `coffeegrindsize` algorithm step for step: blue channel, threshold, grow clusters from the darkest pixel, a break-up step that splits touching particles using edge brightness, then per-particle surface, long axis, short axis, roundness and volume. `AnalysisSettings.legacy()` reproduces the original behaviour exactly, and the parity tests compare against a vendored copy of it. The one deliberate difference is that all sorts are stable, so ties resolve the same way on every CPU (about 0.5 % of clusters differ from the unstable original).

Reported diameter is the area-equivalent diameter, `2*sqrt(long*short)`, which equals `2*sqrt(surface/pi)`. On synthetic sharp, dark, isolated particles of 6 px or more it is within about 1 % of the true value; particles of 3 px are biased low (about 2 %) and 2 px particles are never detected.

Model options (`AnalysisSettings`, also accepted by `/analyze`; defaults are the improved model):

| Option | Default | Meaning |
| --- | --- | --- |
| `background_model` | `poly4` | Divide out a degree-4 polynomial illumination field before thresholding. `global` = original. Under strong vignetting this removes a bias of up to ~28 points in measured size between centre and corners; with uniform lighting it changes nothing |
| `threshold_mode` | `half_contrast` | Threshold halfway between the background and the typical intensity of large particles (clamped to 50-80 %; falls back to `threshold_percent` when fewer than 10 large clusters exist). `fixed` = original |
| `edge_correction` | `true` | Miles-Lantuejoul weights for particles cut off by the image or region border. Statistics only, particle counts are unchanged. Matters for small regions (Dv90 bias about -4 % for a 15x15 mm region) |
| `axis_method` | `max_radius` | Long axis from the farthest pixel (original) or from image moments (`moments`) |
| `volume_model` | `legacy` | `legacy` volume formula or `spheroid` volume from the fitted axes |
| `min_diameter_um` | none | Ignore particles smaller than this in summary and histograms |
| `click_sigma_px` | 2.0 | Assumed error of each reference click, used for the scale uncertainty |

What the summary contains (`summarize_dataset`):

- Dv10/50/90 and span use equivalent-sphere volume `(pi/6)*d^3` as weight, plus 95 % bootstrap confidence intervals (`dv_ci95`, 200 resamples, fixed seed). With about 300 particles Dv90 has roughly 20 % relative spread; with 1000 it is about 4 %. The interval only covers sampling noise, not systematic bias.
- Geometric mean and geometric standard deviation (number- and volume-weighted) and the volume mode.
- `detection_limit_um` (smallest diameter that can pass `min_surface` at the current scale) and `reliable_limit_um` (6 px). When the detection limit is 100 um or more, `fines_volume_pct` is `null` and `fines_measurable` is `false`: fines below the limit are invisible, so the number would be misleading. At 20 px/mm the limit is about 126 um.
- `diameter_scale_unc_pct` and `volume_scale_unc_pct`: uncertainty from clicking the reference object, e.g. 0.59 % in diameter for a 480 px coin.
- `average_extraction_yield_pct`, `average_efficiency_pct` and `surface_quality` come from the Gagne extraction heuristic. They are uncalibrated model outputs, not measurements, and are labelled as such (`model_notes`). The efficiency is weighted by volume.

Known limits (heuristics, not guarantees):

- Resolution matters: at 5 px/mm a true Dv50 of 727 um read 844 um; at 10 px/mm 731 um; at 20 px/mm and above within 1 %. Use at least 10 px/mm, ideally 20.
- Touching particles are rarely split when their profile is flat, and a merged pair reads about 41 % too large in diameter and 2.8x in volume. Spread grounds thinly.
- Blur and low contrast shrink the detected area of small particles; `half_contrast` thresholding reduces but does not remove this.
- The `poly4`/`half_contrast`/`edge_correction` defaults were chosen on synthetic ground-truth images, not on a labelled set of real photos.

## Testing

```bash
pip install -r requirements-dev.txt
pytest                      # fast suite (default)
pytest -m ""                # everything, including slow cases
cd React/frontend && npm ci
PYTHON=$(which python) npm run test:e2e   # Playwright; starts the backend (8000) and Vite (5173)
```

Playwright needs a Chromium install (`npx playwright install chromium`, or point `PLAYWRIGHT_BROWSERS_PATH` at an existing one). The e2e tests use `React/frontend/e2e/harness/`, a dev-only page that renders the signed-in app with a fake user and seeded shot data, so no Firebase project is needed. It is not part of the production build. CI (`.github/workflows/tests.yml`) runs pytest, the production build with dummy Firebase values, and the e2e suite.

## Deployment

### Frontend: GitHub Pages

`.github/workflows/deploy-pages.yml` builds and deploys on pushes to `main` that touch `React/frontend/**`. Repository secrets:

`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_ALLOWED_EMAIL`, `VITE_API_BASE` (the Cloud Run URL, without trailing slash).

Add the Pages host (`<user>.github.io`) to Firebase Auth authorized domains, and the Pages origin to the backend's `CORS_ORIGINS`.

### Backend: Cloud Run

```bash
gcloud run deploy espresso-api --source cloudrun --region <region> \
  --cpu 2 --memory 2Gi --concurrency 4 --timeout 120 --cpu-boost \
  --min-instances 0 --max-instances 3 \
  --set-env-vars GCS_BUCKET=<bucket>,ALLOWED_EMAILS=<you@example.com>,CORS_ORIGINS=https://<user>.github.io
```

`--source` builds `cloudrun/Dockerfile` (Python 3.12, pinned requirements, numba cache precompiled, non-root user). Analyses are serialised per instance (`ANALYZE_CONCURRENCY`, default 1) and overload returns 503 with `Retry-After`. Other environment variables: `MAX_UPLOAD_BYTES`, `MAX_PIXELS`, `MAX_ANALYSIS_PIXELS`, `APP_VERSION`.

Give the Cloud Run service account read/write access to the bucket and expire temporary objects:

```bash
gsutil lifecycle set cloudrun/gcs-lifecycle.json gs://<bucket>
```
