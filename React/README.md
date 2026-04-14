# Coffee Grind Size Analyzer — React App

Full interactive canvas experience: scroll to zoom, drag to pan, click to place points — no page refresh ever.

## Structure

```
React/
  backend/   FastAPI — wraps the existing coffeegrindsize_core Python library
  frontend/  Vite + React — all UI and canvas interaction
```

## Run it

### 1. Backend

```bash
cd React/backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 2. Frontend (separate terminal)

```bash
cd React/frontend
npm install
npm run dev
```

Open http://localhost:5173

---

## How the canvas works

`ImageCanvas.jsx` draws everything on a single `<canvas>` element:

- **Scroll wheel / trackpad pinch** → zoom toward cursor
- **Click + drag** → pan (as long as you move more than 3px before releasing)
- **Click (no drag)** → place a point in the current mode
- **Fit button** (top-right of canvas) → resets zoom to fit the image

All coordinate math converts between canvas pixels and original-image pixels using the current zoom and pan offset, so placed points are always accurate regardless of zoom level.

## Workflow

1. Upload an image
2. **Mode: 1 · Reference** — click 2 points on a reference object (coin, ruler). Select the preset or type the physical size in mm on the sidebar.
3. **Mode: 2 · Region** — click polygon boundary points around the area you want to analyze. Leave empty to analyze the full image.
4. Click **3 · Run Particle Detection**
5. **Mode: 4 · Erase** — click near bad clusters, set the erase radius, press **Apply Erase**
6. Click **Show Histogram** for the particle size distribution
