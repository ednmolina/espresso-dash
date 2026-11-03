# Espresso Lab - React frontend

This folder holds the React app (`frontend/`). The API it talks to is the FastAPI service in `../cloudrun/`; setup, architecture, deployment and testing are documented in the [root README](../README.md).

```bash
cd frontend
cp .env.example .env.local
npm ci
npm run dev            # http://localhost:5173, /api proxied to localhost:8000
npm run build          # production bundle in dist/
npm run test:e2e       # Playwright, see root README
```

## Analyzer canvas

`ImageCanvas.jsx` draws everything on one `<canvas>`:

- scroll wheel or pinch zooms toward the cursor; drag pans (a click that moves more than a few pixels is a pan, not a point)
- a click places a point for the current mode; all points are stored in original-image pixels regardless of zoom
- keyboard: `1` scale, `2` region, `4` clean up, `Enter` detect / apply erase, `Z` or Backspace undo, `Esc` clear, `V` or Space view

## Workflow

1. Upload a photo.
2. **Scale**: click two edges of a reference object (default US quarter, 24.26 mm) or choose another preset.
3. **Region** (optional): outline the area to analyze; leave empty for the whole image.
4. **Detect**.
5. **Clean up**: click stray clusters and apply to remove them.
6. Read the results, save runs (up to 3) and compare them, or download the CSV/histogram.
