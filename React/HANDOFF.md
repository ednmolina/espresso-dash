# Developer Handoff — Coffee Grind Size Analyzer

---

## What this app is

A tool for measuring the particle size distribution of ground coffee from a photo. The idea is simple: spread grounds on a white background next to a reference object (like a coin), take a photo from above, and let the app detect individual particles and measure their sizes. The output is histograms and summary stats — mean diameter, distribution width, fines vs. boulders — so you can objectively compare grinders or grind settings.

This matters because grinder settings are not comparable across machines. Two grinders at "medium" can produce wildly different results. This gives a measurable, repeatable way to evaluate them.

---

## How the analysis works (the science layer)

All the science lives in `coffeegrindsize_core/` (Python). You do not need to touch this — it is well-tested and correct.

The pipeline:
1. Reads the image, extracts the **blue channel** (brown coffee is dark in blue, white background is bright — high contrast)
2. **Thresholds** the blue channel to separate coffee from background
3. **Clusters** neighboring dark pixels into candidate particles
4. Runs a **breakup step** that tries to split touching particles by looking at brightness changes at edges (the main source of error is two grounds touching and being counted as one)
5. For each detected particle it estimates: surface area, long axis, short axis, roundness, approximate volume
6. Uses the **pixel scale** (pixels per mm, derived from the reference object) to convert pixel measurements to real units
7. Builds histograms — number vs. diameter, surface vs. surface, mass vs. volume, extraction-yield distributions

Key file: `coffeegrindsize_core/analysis.py` — `analyze_image()` is the main entry point.

---

## Codebase map

```
coffeegrindsize.py          Original Tkinter desktop app (ignore this)
streamlit_app.py            Streamlit web app (functional but has UX issues — being replaced)
coffeegrindsize_core/
  analysis.py               Core image analysis — DO NOT MODIFY without testing
  plotting.py               Histogram generation via matplotlib
  __init__.py               Public API exports

React/
  README.md                 How to run the app
  HANDOFF.md                This file
  backend/
    main.py                 FastAPI — thin wrapper around coffeegrindsize_core
    requirements.txt
  frontend/
    src/
      main.jsx              React entry point
      App.jsx               Main component — owns all state and API calls
      App.css               Dark theme layout
      constants.js          Reference object presets, default analysis settings
      components/
        ImageCanvas.jsx     The canvas — zoom, pan, click to place points
        Sidebar.jsx         Analysis settings sliders
        ResultsPanel.jsx    Metrics + histogram display
```

---

## Architecture

```
Browser (React)
    │  scroll/drag/click → no server call
    │  "Run Analysis" → POST /api/analyze
    │  "Apply Erase" → POST /api/erase
    │  "Show Histogram" → POST /api/histogram
    ▼
FastAPI (port 8000)
    │  wraps coffeegrindsize_core
    │  stores uploaded images in memory (dict, good enough for local use)
    ▼
coffeegrindsize_core (pure Python)
    │  returns numpy arrays + particle data
```

The Vite dev server proxies `/api/*` → `localhost:8000`, so the frontend just calls `/api/upload`, `/api/analyze`, etc.

---

## What is working today

- **ImageCanvas.jsx** — scroll-to-zoom (toward cursor), drag-to-pan, click-to-place-points. Coordinate math is correct: placed points are stored in original-image pixel coordinates regardless of zoom level. This is the core UX win over the Streamlit version.
- **Mode system** — reference / polygon / erase / view modes switch what a click does
- **Backend endpoints** — upload, analyze, erase, histogram all work
- **Reference point measurement** — placing 2 points computes pixel length → px/mm scale
- **Polygon region** — if 3+ points, analysis is cropped to that polygon
- **Erase clusters** — click near bad detections, apply removes them
- **Results panel** — shows particle count, mean diameter, std dev, quality, efficiency
- **Histogram** — generated server-side and returned as base64 PNG

---

## What needs to be built / fixed

Roughly in priority order.

### 1. Particle data table (medium effort)

The `/analyze` endpoint already returns `particles` — an array of per-particle records (surface, diameter, roundness, etc.). There is currently no table in the UI. Add a scrollable table below the results panel, or in a drawer/tab. Should be sortable. Add a **Download CSV** button (just build a blob from the data and trigger a download — no backend call needed).

### 2. Histogram controls (small effort)

The histogram endpoint accepts `x_metric`, `weight_mode`, `x_log`, and `bins` but the frontend always sends the defaults. Add controls (dropdowns + checkbox) so the user can choose:
- X axis: Particle Diameter / Surface / Volume / Extraction Yield
- Y weighting: Fraction of Particles / Surface / Mass / Available Mass / Extracted Mass
- Log X axis on/off

These go in the results area or sidebar. When the user changes any of them, re-fetch the histogram.

### 3. Undo for polygon and reference points (small effort)

There is already an "Undo" button concept in the toolbar for polygon mode. Wire it up properly so pressing it removes the last point. Also add keyboard shortcut: `Backspace` or `Z` to undo last point while in polygon/reference mode.

### 4. Keyboard shortcuts (small effort)

Makes the workflow much faster:
- `1` → reference mode
- `2` → polygon mode
- `4` → erase mode
- `V` or `Space` → view/pan mode
- `Backspace` → undo last point
- `Escape` → clear current mode's pending points
- `Enter` → run analysis (or apply erase, depending on mode)

Add these in `App.jsx` with a `useEffect` + `keydown` listener.

### 5. Better loading / error states (small effort)

- Show a spinner or overlay on the canvas while analysis is running (it can take several seconds on large images)
- Error messages should be visible and dismissable, not just the small status bar text
- If the backend is unreachable, show a clear message rather than a silent failure

### 6. Visual polish on the canvas (medium effort)

Things that would make the canvas feel more finished:

- **Crosshair cursor** when in click mode, **grab/grabbing** cursor in view mode (partially done)
- **Hover highlight** on the last-placed point so the user knows they can undo it
- **Closing line preview** for polygon — as the user moves the mouse, draw a faint line from the last polygon point to the cursor, so they can see where the next click will go
- **Reference line label** — show the computed pixel length next to the line between the 2 reference points
- **Point numbers** on reference points (1, 2) — already done in ImageCanvas, keep it
- Touch support (for iPad) — replace mouse events with pointer events

### 7. Backend: switch from in-memory to temp files (small effort)

Currently `_images` and `_results` are plain Python dicts. This means:
- Data is lost on server restart
- Multiple users/tabs would share state by accident
- Large images use a lot of RAM

For a local single-user tool this is fine. If it ever needs to run as a shared service, switch to storing images as temp files keyed by UUID, and use a proper task queue (e.g. Celery) for the analysis.

### 8. Comparison mode (medium effort)

The Streamlit version allows uploading a second CSV to overlay a second dataset on the histogram. The backend `plot_histogram` already supports multiple datasets. Add a second file input for a comparison CSV, send it with the histogram request, overlay both distributions on the chart.

### 9. Manual pixel scale override (small effort)

Some users know their camera's pixel scale already (from previous calibration). Add a text input that, if filled, overrides the reference-point-derived scale. Already supported by the backend — just needs a frontend input and to pass `pixel_scale_override` in the analyze request.

---

## Known issues / gotchas

- **Image upload sends full base64** — for a 12MP photo this is ~16 MB of JSON. It works, but the initial upload is slow. Better approach: POST the file as multipart (already done correctly with FormData), but have the backend return only the image ID and dimensions. Load the image for display via a `/image/{id}` GET endpoint that streams the file. This cuts the initial response size.

- **Erase radius is in original-image pixels** — the erase radius slider value is in original-image pixel space, same as the stored cluster coordinates. The visual radius circle drawn on the canvas is already converted to canvas pixels correctly in `ImageCanvas.jsx`. Just make sure the value passed to `/erase` matches.

- **Analysis scale** — the backend scales the image down (e.g. to 50%) before analysis for speed, then scales the pixel coordinates back up. The pixel scale passed to the core is already adjusted for this. The particle coordinates in the returned data are in the **analysis-resolution** space, not original image space. If you ever try to draw particle centers on the canvas you will need to multiply by `1 / analysis_scale`. The `analysis_scale` is returned in the `/analyze` response.

- **`coffeegrindsize_core` must be importable** — the backend adds the repo root to `sys.path`. This works when you run `uvicorn` from `React/backend/`. If you move the backend, update the `sys.path.insert` line in `main.py`.

---

## Running the app

```bash
# Terminal 1 — Python backend
cd React/backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Terminal 2 — React frontend
cd React/frontend
npm install
npm run dev
# → open http://localhost:5173
```

---

## Suggested first task for a new developer

Get familiar with the codebase by adding keyboard shortcuts (`1`, `2`, `4`, `V` to switch modes, `Backspace` to undo). It only touches `App.jsx`, is self-contained, and will immediately make the app feel more polished.
