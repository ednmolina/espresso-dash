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
import sys
import uuid
from pathlib import Path
from typing import Optional

# Keep Matplotlib off unwritable home directories.
MPL_DIR = Path("/tmp/espresso-mpl")
MPL_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(MPL_DIR))

import matplotlib
import numpy as np
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

matplotlib.use("Agg")

from coffeegrindsize_core import (
    AnalysisSettings,
    HistogramSettings,
    ParticleDataset,
    REFERENCE_OBJECTS_MM,
    analyze_image,
    clusters_within_radius,
    filter_dataset_by_cluster_ids,
    plot_histogram,
    render_cluster_overlay,
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

# Local dev in-memory fallback
_local_images: dict[str, Image.Image] = {}
_local_results: dict[str, object] = {}


def _store_image(image_id: str, image: Image.Image) -> None:
    if _gcs_bucket is not None:
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        _gcs_bucket.blob(f"tmp/images/{image_id}.png").upload_from_string(
            buf.getvalue(), content_type="image/png"
        )
    else:
        _local_images[image_id] = image


def _load_image(image_id: str) -> Optional[Image.Image]:
    if _gcs_bucket is not None:
        blob = _gcs_bucket.blob(f"tmp/images/{image_id}.png")
        if not blob.exists():
            return None
        return Image.open(io.BytesIO(blob.download_as_bytes())).convert("RGB")
    return _local_images.get(image_id)


def _store_result(image_id: str, result: object) -> None:
    if _gcs_bucket is not None:
        _gcs_bucket.blob(f"tmp/results/{image_id}.pkl").upload_from_string(
            pickle.dumps(result)
        )
    else:
        _local_results[image_id] = result


def _load_result(image_id: str) -> Optional[object]:
    if _gcs_bucket is not None:
        blob = _gcs_bucket.blob(f"tmp/results/{image_id}.pkl")
        if not blob.exists():
            return None
        return pickle.loads(blob.download_as_bytes())
    return _local_results.get(image_id)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Coffee Grind Size Analyzer API")

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

def _pil_to_b64(image: Image.Image, fmt: str = "PNG") -> str:
    buf = io.BytesIO()
    image.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


def _ndarray_to_b64(arr: np.ndarray) -> str:
    return _pil_to_b64(Image.fromarray(arr))


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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/upload")
async def upload_image(
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
):
    _verify_token(authorization)
    data = await file.read()
    try:
        image = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    image_id = str(uuid.uuid4())
    _store_image(image_id, image)

    return {
        "image_id": image_id,
        "width": image.width,
        "height": image.height,
        "image_b64": _pil_to_b64(image),
        "reference_objects": {k: v for k, v in REFERENCE_OBJECTS_MM.items() if v is not None},
    }


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

    result = analyze_image(analysis_image, settings)
    _store_result(req.image_id, result)

    dataset = result.dataset
    cluster_overlay = render_cluster_overlay(result.source_rgb, dataset)

    summary = None
    if dataset.nclusters > 0 and dataset.pixel_scale is not None:
        summary = summarize_dataset(dataset)

    return {
        "threshold_overlay_b64": _ndarray_to_b64(result.threshold_overlay),
        "cluster_overlay_b64": _ndarray_to_b64(cluster_overlay),
        "background_median": result.background_median,
        "nclusters": dataset.nclusters,
        "pixel_scale": dataset.pixel_scale,
        "summary": summary,
        "particles": dataset.to_frame().reset_index().rename(columns={"index": "ID"}).to_dict(orient="records"),
        "analysis_scale": scale,
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
    cluster_overlay = render_cluster_overlay(result.source_rgb, filtered)

    summary = None
    if filtered.nclusters > 0 and filtered.pixel_scale is not None:
        summary = summarize_dataset(filtered)

    return {
        "removed_ids": list(all_removed),
        "nclusters": filtered.nclusters,
        "cluster_overlay_b64": _ndarray_to_b64(cluster_overlay),
        "summary": summary,
        "particles": filtered.to_frame().reset_index().rename(columns={"index": "ID"}).to_dict(orient="records"),
    }


def _add_stats_lines(ax, values: np.ndarray, x_log: bool, color: str = "#2c7bb6") -> dict:
    """Add mean/median lines with asymmetric percentile errors. Returns stats dict."""
    mean_val   = float(np.mean(values))
    median_val = float(np.median(values))
    p16, p25, p75, p84 = (float(np.percentile(values, p)) for p in (16, 25, 75, 84))

    mean_upper   = p84 - mean_val
    mean_lower   = mean_val - p16
    median_upper = p75 - median_val
    median_lower = median_val - p25

    ax.axvline(mean_val, color=color, linestyle="--", linewidth=1.8,
               label=f"Mean: {mean_val:.3f} +{mean_upper:.3f}/−{mean_lower:.3f} mm")
    ax.axvline(p16, color=color, linestyle="-", linewidth=0.7, alpha=0.45)
    ax.axvline(p84, color=color, linestyle="-", linewidth=0.7, alpha=0.45)

    ax.axvline(median_val, color="#d7191c", linestyle=":", linewidth=1.8,
               label=f"Median: {median_val:.3f} +{median_upper:.3f}/−{median_lower:.3f} mm")
    ax.axvline(p25, color="#d7191c", linestyle="-", linewidth=0.7, alpha=0.45)
    ax.axvline(p75, color="#d7191c", linestyle="-", linewidth=0.7, alpha=0.45)

    if not x_log:
        ax.axvspan(p16, p84, alpha=0.10, color=color)
        ax.axvspan(p25, p75, alpha=0.10, color="#d7191c")

    ax.legend(fontsize=8)
    return {
        "mean": mean_val, "mean_upper": mean_upper, "mean_lower": mean_lower,
        "median": median_val, "median_upper": median_upper, "median_lower": median_lower,
    }


@app.post("/histogram")
def histogram(
    req: HistogramRequest,
    authorization: Optional[str] = Header(None),
):
    import matplotlib.pyplot as plt
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
    figure, _ = plot_histogram([dataset], settings)
    values = _metric_values(dataset, req.x_metric)
    stats = _add_stats_lines(figure.axes[0], values, req.x_log)

    buf = io.BytesIO()
    figure.savefig(buf, format="png", bbox_inches="tight")
    plt.close(figure)

    return {
        "histogram_b64": base64.b64encode(buf.getvalue()).decode(),
        **stats,
    }


@app.post("/histogram/compare")
def histogram_compare(
    req: HistogramCompareRequest,
    authorization: Optional[str] = Header(None),
):
    import matplotlib.pyplot as plt
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

    settings = HistogramSettings(
        x_metric=req.x_metric, weight_mode=req.weight_mode,
        x_log=req.x_log, bins=req.bins,
    )
    figure, _ = plot_histogram(datasets, settings)

    colors = ["#2c7bb6", "#2f7d4a", "#9c5a14"]
    per_run_stats = []
    for i, (ds, color) in enumerate(zip(datasets, colors)):
        values = _metric_values(ds, req.x_metric)
        stats = _add_stats_lines(figure.axes[0], values, req.x_log, color=color)
        per_run_stats.append({"label": ds.label, **stats})

    all_means = [s["mean"] for s in per_run_stats]
    all_medians = [s["median"] for s in per_run_stats]
    combined = {
        "mean_of_means": float(np.mean(all_means)),
        "median_of_medians": float(np.median(all_medians)),
        "std_of_means": float(np.std(all_means)),
    }

    buf = io.BytesIO()
    figure.savefig(buf, format="png", bbox_inches="tight")
    plt.close(figure)

    return {
        "histogram_b64": base64.b64encode(buf.getvalue()).decode(),
        "per_run": per_run_stats,
        "combined": combined,
    }
