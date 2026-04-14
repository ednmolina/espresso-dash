"""
FastAPI backend for Coffee Grind Size Analyzer.
Wraps coffeegrindsize_core and exposes a JSON API for the React frontend.
"""
from __future__ import annotations

import base64
import io
import os
import sys
import uuid
from pathlib import Path
from typing import Optional

# Keep Matplotlib off unwritable home directories in local conda envs.
MPL_DIR = Path("/tmp/espresso-mpl")
MPL_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(MPL_DIR))

import matplotlib
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

# Force a headless backend so histogram requests stay inside the web app.
matplotlib.use("Agg")

# Allow importing coffeegrindsize_core from the parent directory
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

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
from espresso_dashboard import (
    MACRO_OPTIONS,
    MICRO_OPTIONS,
    RATING_COLORS,
    RATING_LABELS,
    TARGET_EXTRACTION_HIGH,
    TARGET_EXTRACTION_LOW,
    add_shot_from_payload,
    build_dashboard_payload,
    build_experiment_payload,
    build_origins_payload,
    build_recommendation_payload,
    reset_working_copy,
    update_shot_cell,
)

app = FastAPI(title="Coffee Grind Size Analyzer API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory stores (replace with proper storage for production)
_images: dict[str, Image.Image] = {}
_results: dict[str, object] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pil_to_b64(image: Image.Image, fmt: str = "PNG") -> str:
    buf = io.BytesIO()
    image.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


def _ndarray_to_b64(arr: np.ndarray) -> str:
    return _pil_to_b64(Image.fromarray(arr))


def _model_payload(model: BaseModel) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


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
    # Two points in original image coords: [[x1,y1],[x2,y2]]
    reference_points: Optional[list[list[float]]] = None
    reference_physical_mm: Optional[float] = None
    # Polygon in original image coords: [[x,y], ...]
    polygon_points: Optional[list[list[float]]] = None


class EraseRequest(BaseModel):
    image_id: str
    erase_points: list[list[float]]  # [[x,y], ...] in original image coords
    erase_radius_px: float = 20.0
    already_removed_ids: list[int] = []


class HistogramRequest(BaseModel):
    image_id: str
    removed_cluster_ids: list[int] = []
    x_metric: str = "diameter"
    weight_mode: str = "number"
    x_log: bool = True
    bins: Optional[int] = None


class RecommendationRequest(BaseModel):
    roaster: str = ""
    region: str = ""
    variety: str = ""
    processing_technique: str = ""
    roast: str = ""
    continent: str = ""


class AddShotRequest(BaseModel):
    carry_forward: bool = True
    carry_shot: bool = True
    fields: dict[str, object] = {}


class OriginsRequest(BaseModel):
    selected_roasters: list[str] = []
    selected_regions: list[str] = []
    selected_varieties: list[str] = []
    selected_continents: list[str] = []
    show_unknown_continent: bool = True


class ExperimentRequest(BaseModel):
    roaster: str = ""
    region: str = ""
    continent: str = ""
    variety: str = ""
    processing_technique: str = ""
    roast: str = ""
    temp_c: Optional[float] = None
    brix: Optional[float] = None
    ph: Optional[float] = None
    dose: Optional[float] = None
    yield_grams: Optional[float] = None
    shot_time: Optional[int] = None
    avg_grind: str = ""
    grind_setting: str = ""


class UpdateCellRequest(BaseModel):
    row_id: int
    column: str
    value: str = ""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    """Accept an image upload and return an image_id plus the image as base64."""
    data = await file.read()
    try:
        image = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    image_id = str(uuid.uuid4())
    _images[image_id] = image

    return {
        "image_id": image_id,
        "width": image.width,
        "height": image.height,
        "image_b64": _pil_to_b64(image),
        "reference_objects": {
            k: v for k, v in REFERENCE_OBJECTS_MM.items() if v is not None
        },
    }


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    """Run particle detection and return overlays + particle data."""
    image = _images.get(req.image_id)
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
    _results[req.image_id] = result

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
def erase(req: EraseRequest):
    """Given erase click points, return which cluster IDs fall within the radius."""
    result = _results.get(req.image_id)
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


@app.post("/histogram")
def histogram(req: HistogramRequest):
    """Return a histogram PNG as base64."""
    result = _results.get(req.image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No analysis found for this image.")

    dataset = filter_dataset_by_cluster_ids(result.dataset, set(req.removed_cluster_ids))
    if dataset.nclusters == 0 or dataset.pixel_scale is None:
        raise HTTPException(status_code=400, detail="No particles or no pixel scale set.")

    figure, _ = plot_histogram(
        [dataset],
        HistogramSettings(
            x_metric=req.x_metric,
            weight_mode=req.weight_mode,
            x_log=req.x_log,
            bins=req.bins,
        ),
    )
    buf = io.BytesIO()
    figure.savefig(buf, format="png", bbox_inches="tight")
    import matplotlib.pyplot as plt
    plt.close(figure)

    return {"histogram_b64": base64.b64encode(buf.getvalue()).decode()}


@app.get("/espresso/meta")
def espresso_meta():
    return {
        "macro_options": MACRO_OPTIONS,
        "micro_options": MICRO_OPTIONS,
        "rating_labels": list(RATING_LABELS.keys()),
        "rating_colors": RATING_COLORS,
        "target_window": {"low": TARGET_EXTRACTION_LOW, "high": TARGET_EXTRACTION_HIGH},
    }


@app.get("/espresso/dashboard")
def espresso_dashboard():
    return build_dashboard_payload()


@app.post("/espresso/recommendation")
def espresso_recommendation(req: RecommendationRequest):
    return build_recommendation_payload(_model_payload(req))


@app.post("/espresso/shots")
def espresso_add_shot(req: AddShotRequest):
    return add_shot_from_payload(_model_payload(req))


@app.post("/espresso/cell")
def espresso_update_cell(req: UpdateCellRequest):
    try:
        update_shot_cell(req.row_id, req.column, req.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return build_dashboard_payload()


@app.post("/espresso/reset")
def espresso_reset():
    reset_working_copy()
    return build_dashboard_payload()


@app.post("/espresso/origins")
def espresso_origins(req: OriginsRequest):
    return build_origins_payload(_model_payload(req))


@app.post("/espresso/experiment")
def espresso_experiment(req: ExperimentRequest):
    return build_experiment_payload(_model_payload(req))
