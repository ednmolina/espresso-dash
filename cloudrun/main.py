"""
FastAPI backend for Coffee Grind Size Analyzer — Cloud Run edition.

Local dev:  LOCAL_DEV=true uvicorn main:app --reload
Cloud Run:  started via Procfile; GCS_BUCKET and ALLOWED_EMAIL are set as env vars.
"""
from __future__ import annotations

import base64
import io
import os
import pickle
import threading
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Optional

# Keep Matplotlib off unwritable home directories.
MPL_DIR = Path("/tmp/espresso-mpl")
MPL_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(MPL_DIR))
# numba caches compiled kernels next to the source by default; Cloud Run's
# source directory is read-only, so keep the cache in /tmp instead.
os.environ.setdefault("NUMBA_CACHE_DIR", "/tmp/espresso-numba")

import matplotlib
import numpy as np
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps
from pydantic import BaseModel

matplotlib.use("Agg")

from coffeegrindsize_core import (
    AnalysisSettings,
    HistogramSettings,
    ParticleDataset,
    REFERENCE_OBJECTS_MM,
    analyze_image,
    cluster_center_mask,
    cluster_outline_mask,
    clusters_within_radius,
    filter_dataset_by_cluster_ids,
    plot_histogram,
    summarize_dataset,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_LOCAL_DEV = os.environ.get("LOCAL_DEV", "").lower() == "true"
_ALLOWED_EMAIL = os.environ.get("ALLOWED_EMAIL", "ednmolina@gmail.com")
_GCS_BUCKET_NAME = os.environ.get("GCS_BUCKET")

# ---------------------------------------------------------------------------
# Firebase Admin (token verification) — skipped in local dev
# ---------------------------------------------------------------------------

_firebase_app = None

def _get_firebase_app():
    global _firebase_app
    if _firebase_app is None:
        import firebase_admin
        _firebase_app = firebase_admin.initialize_app()
    return _firebase_app


def _verify_token(authorization: Optional[str]) -> None:
    """Raise HTTP 401 if the Firebase ID token is missing or invalid."""
    if _LOCAL_DEV:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization token.")
    token = authorization[len("Bearer "):]
    try:
        from firebase_admin import auth as firebase_auth
        decoded = firebase_auth.verify_id_token(token, app=_get_firebase_app())
        email = decoded.get("email", "")
        if email != _ALLOWED_EMAIL:
            raise HTTPException(status_code=403, detail="Access denied.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")


# ---------------------------------------------------------------------------
# Cloud Storage state (falls back to in-memory for local dev)
# ---------------------------------------------------------------------------

_gcs_bucket = None
if _GCS_BUCKET_NAME:
    from google.cloud import storage as _gcs_lib
    _gcs_bucket = _gcs_lib.Client().bucket(_GCS_BUCKET_NAME)


class _LRU:
    """Small thread-safe LRU so repeat requests on a warm instance skip GCS."""

    def __init__(self, capacity: int):
        self.capacity = capacity
        self._data: OrderedDict[str, object] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str):
        with self._lock:
            if key not in self._data:
                return None
            self._data.move_to_end(key)
            return self._data[key]

    def put(self, key: str, value: object) -> None:
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self.capacity:
                self._data.popitem(last=False)


# In local dev these caches are the only storage, so make them roomier.
_image_cache = _LRU(4 if _gcs_bucket is not None else 32)
_result_cache = _LRU(8 if _gcs_bucket is not None else 64)


def _decode_image(data: bytes) -> Image.Image:
    # Apply EXIF orientation so the analysed pixels match what browsers display.
    return ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")


def _gcs_download(path: str) -> Optional[bytes]:
    from google.api_core.exceptions import NotFound

    try:
        return _gcs_bucket.blob(path).download_as_bytes()
    except NotFound:
        return None


def _store_image(image_id: str, raw: bytes, image: Image.Image) -> None:
    # Keep the original upload bytes: no slow PNG re-encode, and no quality loss.
    _image_cache.put(image_id, image)
    if _gcs_bucket is not None:
        _gcs_bucket.blob(f"tmp/images/{image_id}.bin").upload_from_string(
            raw, content_type="application/octet-stream"
        )


def _load_image(image_id: str) -> Optional[Image.Image]:
    image = _image_cache.get(image_id)
    if image is not None or _gcs_bucket is None:
        return image
    raw = _gcs_download(f"tmp/images/{image_id}.bin")
    if raw is None:
        return None
    image = _decode_image(raw)
    _image_cache.put(image_id, image)
    return image


class StoredResult:
    """What later requests need from an analysis: particles and image size.

    The full AnalysisResult also holds several full-resolution image arrays;
    pickling those to GCS was ~100 MB per analysis on a phone photo.
    """

    def __init__(self, dataset: ParticleDataset, shape: tuple[int, int], background_median: float):
        self.dataset = dataset
        self.shape = shape
        self.background_median = background_median


def _store_result(image_id: str, result: StoredResult) -> None:
    _result_cache.put(image_id, result)
    if _gcs_bucket is not None:
        _gcs_bucket.blob(f"tmp/results/{image_id}.pkl").upload_from_string(
            pickle.dumps(result, protocol=pickle.HIGHEST_PROTOCOL)
        )


def _load_result(image_id: str) -> Optional[StoredResult]:
    result = _result_cache.get(image_id)
    if result is not None or _gcs_bucket is None:
        return result
    raw = _gcs_download(f"tmp/results/{image_id}.pkl")
    if raw is None:
        return None
    result = pickle.loads(raw)
    if not isinstance(result, StoredResult):  # legacy pickles held AnalysisResult
        result = StoredResult(result.dataset, result.source_rgb.shape[:2], result.background_median)
    _result_cache.put(image_id, result)
    return result


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Coffee Grind Size Analyzer API")


@app.on_event("startup")
def _warm_up() -> None:
    """Compile (or load cached) numba kernels before the first real request."""
    def run():
        try:
            rng = np.random.default_rng(0)
            arr = np.full((64, 64, 3), 230, dtype=np.uint8)
            arr[20:30, 20:28] = rng.integers(40, 90, size=(10, 8, 3))
            image = Image.fromarray(arr)
            analyze_image(image, AnalysisSettings(pixel_scale=10.0))
            analyze_image(image, AnalysisSettings(pixel_scale=10.0, quick_mode=True))
            cluster_outline_mask((4, 4), [])
        except Exception:  # warm-up is best effort
            pass

    threading.Thread(target=run, daemon=True).start()


_cors_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://ednmolina.github.io",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pil_to_b64(image: Image.Image, fmt: str = "PNG", **save_kwargs) -> str:
    buf = io.BytesIO()
    image.save(buf, format=fmt, **save_kwargs)
    return base64.b64encode(buf.getvalue()).decode()


def _mask_layer_b64(mask: np.ndarray, color: tuple[int, int, int], extra: Optional[tuple[np.ndarray, tuple[int, int, int]]] = None) -> str:
    """Encode a boolean mask as a transparent palette PNG for drawing over the photo.

    Mostly-transparent palette PNGs are tiny and fast to encode compared with
    re-encoding the whole photo with the overlay burned in.
    """
    indexed = mask.astype(np.uint8)
    palette = [0, 0, 0, *color]
    if extra is not None:
        indexed[extra[0]] = 2
        palette += list(extra[1])
    layer = Image.fromarray(indexed, mode="L").convert("P")
    layer.putpalette(palette + [0, 0, 0] * (256 - len(palette) // 3))
    return _pil_to_b64(layer, "PNG", transparency=0, compress_level=1)


def _cluster_layer_b64(shape: tuple[int, int], dataset: ParticleDataset) -> str:
    return _mask_layer_b64(
        cluster_outline_mask(shape, dataset.clusters),
        (255, 59, 48),
        extra=(cluster_center_mask(shape, dataset.clusters), (80, 160, 255)),
    )


def _particles_payload(dataset: ParticleDataset) -> list[dict]:
    return dataset.to_frame().reset_index().rename(columns={"index": "ID"}).to_dict(orient="records")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class AnalyzeRequest(BaseModel):
    image_id: str
    threshold_percent: float = 58.8
    reference_threshold: float = 0.4
    max_cost: float = 0.35
    max_cluster_axis: float = 100.0
    min_surface: float = 5.0
    min_roundness: float = 0.0
    quick_mode: bool = False
    analysis_scale_pct: int = 100
    reference_points: Optional[list[list[float]]] = None
    reference_physical_mm: Optional[float] = None
    polygon_points: Optional[list[list[float]]] = None


class EraseRequest(BaseModel):
    image_id: str
    erase_points: list[list[float]]
    erase_radius_px: float = 20.0
    already_removed_ids: list[int] = []


class HistogramRequest(BaseModel):
    image_id: str
    removed_cluster_ids: list[int] = []
    x_metric: str = "diameter"
    weight_mode: str = "number"
    x_log: bool = True
    bins: Optional[int] = None
    include_png: bool = True


class RunRef(BaseModel):
    image_id: str
    removed_cluster_ids: list[int] = []
    label: str = ""


class HistogramCompareRequest(BaseModel):
    runs: list[RunRef]
    x_metric: str = "diameter"
    weight_mode: str = "number"
    x_log: bool = True
    bins: Optional[int] = None
    include_png: bool = True


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/upload")
async def upload_image(
    file: UploadFile = File(...),
    include_preview: bool = False,
    authorization: Optional[str] = Header(None),
):
    _verify_token(authorization)
    data = await file.read()
    try:
        image = _decode_image(data)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    image_id = str(uuid.uuid4())
    _store_image(image_id, data, image)

    payload = {
        "image_id": image_id,
        "width": image.width,
        "height": image.height,
        "reference_objects": {k: v for k, v in REFERENCE_OBJECTS_MM.items() if v is not None},
    }
    # The browser normally shows the file it already has; a preview is only
    # needed when it cannot decode the format itself.
    if include_preview:
        payload["image_b64"] = _pil_to_b64(image, "JPEG", quality=90)
        payload["image_mime"] = "image/jpeg"
    return payload


@app.get("/preview/{image_id}")
def preview_image(image_id: str, authorization: Optional[str] = Header(None)):
    _verify_token(authorization)
    image = _load_image(image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found. Upload first.")
    return {"image_b64": _pil_to_b64(image, "JPEG", quality=90), "image_mime": "image/jpeg"}


@app.post("/analyze")
def analyze(
    req: AnalyzeRequest,
    authorization: Optional[str] = Header(None),
):
    _verify_token(authorization)
    image = _load_image(req.image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found. Upload first.")

    scale = req.analysis_scale_pct / 100.0
    w, h = image.size
    analysis_image = image.resize(
        (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
        resample=Image.Resampling.LANCZOS,
    )

    pixel_scale = None
    if (
        req.reference_points
        and len(req.reference_points) == 2
        and req.reference_physical_mm
        and req.reference_physical_mm > 0
    ):
        (x1, y1), (x2, y2) = req.reference_points
        px_length = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
        pixel_scale = (px_length / req.reference_physical_mm) * scale

    analysis_polygon = None
    if req.polygon_points and len(req.polygon_points) >= 3:
        analysis_polygon = [(x * scale, y * scale) for x, y in req.polygon_points]

    settings = AnalysisSettings(
        threshold_percent=req.threshold_percent,
        reference_threshold=req.reference_threshold,
        max_cluster_axis=req.max_cluster_axis,
        min_surface=req.min_surface,
        min_roundness=req.min_roundness,
        max_cost=req.max_cost,
        quick_mode=req.quick_mode,
        analysis_polygon=analysis_polygon,
        pixel_scale=pixel_scale,
    )

    try:
        result = analyze_image(analysis_image, settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    dataset = result.dataset
    shape = result.blue_channel.shape
    stored = StoredResult(dataset, shape, result.background_median)
    # "latest" result for erase/histogram, plus a frozen copy that saved runs
    # can refer to even after the same image is re-analysed.
    analysis_id = f"{req.image_id}.{uuid.uuid4().hex[:12]}"
    _store_result(req.image_id, stored)
    _store_result(analysis_id, stored)

    summary = None
    if dataset.nclusters > 0 and dataset.pixel_scale is not None:
        summary = summarize_dataset(dataset)

    # Overlays are transparent layers drawn on top of the photo in the browser.
    return {
        "threshold_layer_b64": _mask_layer_b64(result.threshold_mask, (255, 59, 48)),
        "cluster_layer_b64": _cluster_layer_b64(shape, dataset),
        "background_median": result.background_median,
        "nclusters": dataset.nclusters,
        "pixel_scale": dataset.pixel_scale,
        "summary": summary,
        "particles": _particles_payload(dataset),
        "analysis_scale": scale,
        "analysis_id": analysis_id,
    }


@app.post("/erase")
def erase(
    req: EraseRequest,
    authorization: Optional[str] = Header(None),
):
    _verify_token(authorization)
    result = _load_result(req.image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No analysis found for this image.")

    already = set(req.already_removed_ids)
    dataset = filter_dataset_by_cluster_ids(result.dataset, already)
    erase_pts = [tuple(p) for p in req.erase_points]
    ids_to_remove = clusters_within_radius(dataset, erase_pts, req.erase_radius_px)

    all_removed = already | ids_to_remove
    filtered = filter_dataset_by_cluster_ids(result.dataset, all_removed)

    summary = None
    if filtered.nclusters > 0 and filtered.pixel_scale is not None:
        summary = summarize_dataset(filtered)

    return {
        "removed_ids": sorted(all_removed),
        "nclusters": filtered.nclusters,
        "cluster_layer_b64": _cluster_layer_b64(result.shape, filtered),
        "summary": summary,
        "particles": _particles_payload(filtered),
    }


def _unit_for_metric(metric: str, values: np.ndarray):
    """Return (scale, display_unit, latex_unit, axis_label) based on data range."""
    max_val = float(np.max(np.abs(values)))
    if metric == "diameter":
        if max_val >= 1.0:
            return 1.0,   "mm",         r"\mathrm{mm}",          "Particle Diameter (mm)"
        elif max_val >= 1e-3:
            return 1e3,   r"$\mu$m",    r"\mu\mathrm{m}",        r"Particle Diameter ($\mu$m)"
        else:
            return 1e6,   "nm",         r"\mathrm{nm}",          "Particle Diameter (nm)"
    elif metric == "surface":
        if max_val >= 1.0:
            return 1.0,   "mm²",        r"\mathrm{mm}^2",        "Particle Surface (mm²)"
        else:
            return 1e6,   r"$\mu$m²",   r"\mu\mathrm{m}^2",      r"Particle Surface ($\mu$m²)"
    elif metric == "volume":
        if max_val >= 1.0:
            return 1.0,   "mm³",        r"\mathrm{mm}^3",        "Particle Volume (mm³)"
        else:
            return 1e9,   r"$\mu$m³",   r"\mu\mathrm{m}^3",      r"Particle Volume ($\mu$m³)"
    else:  # extraction_yield — already in %
        return 1.0, "%", r"\%", "Extraction Yield (%)"


def _distribution_stats(values: np.ndarray) -> dict:
    mean_val = float(np.mean(values))
    median_val = float(np.median(values))
    p16, p25, p75, p84 = (float(v) for v in np.percentile(values, (16, 25, 75, 84)))
    return {
        "mean": mean_val, "mean_upper": p84 - mean_val, "mean_lower": mean_val - p16,
        "median": median_val, "median_upper": p75 - median_val, "median_lower": median_val - p25,
        "p16": p16, "p25": p25, "p75": p75, "p84": p84,
    }


def _add_stats_lines(
    ax, stats: dict, x_log: bool,
    color: str = "#2c7bb6",
    scale: float = 1.0,
    latex_unit: str = r"\mathrm{mm}",
) -> None:
    """Add mean/median lines with LaTeX superscript/subscript asymmetric errors."""
    s = scale

    def label(name: str, val: float, upper: float, lower: float) -> str:
        return (
            name + r": $" + f"{val*s:.3f}"
            + r"^{+" + f"{abs(upper*s):.3f}" + r"}"
            + r"_{-" + f"{abs(lower*s):.3f}" + r"}"
            + r"\," + latex_unit + r"$"
        )

    ax.axvline(stats["mean"], color=color, linestyle="--", linewidth=1.8,
               label=label("Mean", stats["mean"], stats["mean_upper"], stats["mean_lower"]))
    ax.axvline(stats["p16"], color=color, linestyle="-", linewidth=0.8, alpha=0.5)
    ax.axvline(stats["p84"], color=color, linestyle="-", linewidth=0.8, alpha=0.5)

    ax.axvline(stats["median"], color="#d7191c", linestyle=":", linewidth=1.8,
               label=label("Median", stats["median"], stats["median_upper"], stats["median_lower"]))
    ax.axvline(stats["p25"], color="#d7191c", linestyle="-", linewidth=0.8, alpha=0.5)
    ax.axvline(stats["p75"], color="#d7191c", linestyle="-", linewidth=0.8, alpha=0.5)

    if not x_log:
        ax.axvspan(stats["p16"], stats["p84"], alpha=0.09, color=color)
        ax.axvspan(stats["p25"], stats["p75"], alpha=0.09, color="#d7191c")

    ax.legend(fontsize=8)


def _histogram_series(datasets: list[ParticleDataset], settings: HistogramSettings) -> dict:
    """Bin edges and per-run weight fractions, so the browser can draw the chart."""
    from coffeegrindsize_core import metric_values, plotting
    from coffeegrindsize_core.analysis import metric_weights

    values = [metric_values(ds, settings.x_metric) for ds in datasets]
    weights = [metric_weights(ds, settings.weight_mode) for ds in datasets]
    xmin = float(min(np.nanmin(v) for v in values))
    xmax = float(max(np.nanmax(v) for v in values))
    if settings.x_metric == "extraction_yield":
        xmin, xmax = min(xmin, 20.0), max(xmax, 30.0)
    if xmax <= xmin:
        xmax = xmin * 1.01 + 1e-9
    edges = plotting._build_bins(xmin=xmin, xmax=xmax, x_log=settings.x_log, bins=settings.bins)
    series = []
    for ds, v, w in zip(datasets, values, weights):
        counts, _ = np.histogram(v, bins=edges, weights=w / np.nansum(w))
        series.append({"label": ds.label, "fractions": counts.tolist()})
    return {"edges": edges.tolist(), "series": series, "x_log": settings.x_log}


def _figure_to_b64(figure) -> str:
    import matplotlib.pyplot as plt

    buf = io.BytesIO()
    figure.savefig(buf, format="png", bbox_inches="tight")
    plt.close(figure)
    return base64.b64encode(buf.getvalue()).decode()


@app.post("/histogram")
def histogram(
    req: HistogramRequest,
    authorization: Optional[str] = Header(None),
):
    from matplotlib.ticker import FuncFormatter
    from coffeegrindsize_core import metric_values as _metric_values

    _verify_token(authorization)
    result = _load_result(req.image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No analysis found for this image.")

    dataset = filter_dataset_by_cluster_ids(result.dataset, set(req.removed_cluster_ids))
    if dataset.nclusters == 0 or dataset.pixel_scale is None:
        raise HTTPException(status_code=400, detail="No particles or no pixel scale set.")

    settings = HistogramSettings(
        x_metric=req.x_metric, weight_mode=req.weight_mode,
        x_log=req.x_log, bins=req.bins,
    )
    values = _metric_values(dataset, req.x_metric)
    scale, display_unit, latex_unit, axis_label = _unit_for_metric(req.x_metric, values)
    stats = _distribution_stats(values)

    histogram_b64 = None
    if req.include_png:
        figure, _ = plot_histogram([dataset], settings)
        ax = figure.axes[0]
        ax.set_xlabel(axis_label)
        if scale != 1.0:
            ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{x * scale:.3g}"))
        _add_stats_lines(ax, stats, req.x_log, scale=scale, latex_unit=latex_unit)
        histogram_b64 = _figure_to_b64(figure)

    return {
        "histogram_b64": histogram_b64,
        "series": _histogram_series([dataset], settings),
        "unit": display_unit,
        "scale": scale,
        "axis_label": axis_label,
        **stats,
    }


@app.post("/histogram/compare")
def histogram_compare(
    req: HistogramCompareRequest,
    authorization: Optional[str] = Header(None),
):
    from matplotlib.ticker import FuncFormatter
    from coffeegrindsize_core import metric_values as _metric_values

    _verify_token(authorization)
    datasets = []
    for run in req.runs:
        result = _load_result(run.image_id)
        if result is None:
            raise HTTPException(status_code=404, detail=f"No analysis found for image {run.image_id}.")
        ds = filter_dataset_by_cluster_ids(result.dataset, set(run.removed_cluster_ids))
        if ds.nclusters == 0 or ds.pixel_scale is None:
            raise HTTPException(status_code=400, detail=f"Run '{run.label}' has no particles or no scale.")
        ds.label = run.label or f"Run {len(datasets) + 1}"
        datasets.append(ds)
    if not datasets:
        raise HTTPException(status_code=400, detail="No runs to compare.")

    settings = HistogramSettings(
        x_metric=req.x_metric, weight_mode=req.weight_mode,
        x_log=req.x_log, bins=req.bins,
    )
    # Determine unit from first dataset
    first_values = _metric_values(datasets[0], req.x_metric)
    scale, display_unit, latex_unit, axis_label = _unit_for_metric(req.x_metric, first_values)

    per_run_stats = [
        {"label": ds.label, **_distribution_stats(_metric_values(ds, req.x_metric))} for ds in datasets
    ]

    histogram_b64 = None
    if req.include_png:
        figure, _ = plot_histogram(datasets, settings)
        ax = figure.axes[0]
        ax.set_xlabel(axis_label)
        if scale != 1.0:
            ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{x * scale:.3g}"))
        colors = ["#2c7bb6", "#2f7d4a", "#9c5a14"]
        for stats, color in zip(per_run_stats, colors):
            _add_stats_lines(ax, stats, req.x_log, color=color, scale=scale, latex_unit=latex_unit)
        histogram_b64 = _figure_to_b64(figure)

    all_means = [s["mean"] for s in per_run_stats]
    all_medians = [s["median"] for s in per_run_stats]
    combined = {
        "mean_of_means": float(np.mean(all_means)),
        "median_of_medians": float(np.median(all_medians)),
        "std_of_means": float(np.std(all_means)),
    }

    return {
        "histogram_b64": histogram_b64,
        "series": _histogram_series(datasets, settings),
        "unit": display_unit,
        "scale": scale,
        "axis_label": axis_label,
        "per_run": per_run_stats,
        "combined": combined,
    }
