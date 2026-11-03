"""
FastAPI backend for Coffee Grind Size Analyzer - Cloud Run edition.

Local dev:  LOCAL_DEV=true uvicorn main:app --reload
Cloud Run:  deployed as a container (cloudrun/Dockerfile). Required env: GCS_BUCKET, ALLOWED_EMAILS
            (comma separated; ALLOWED_EMAIL is still read for compatibility).
Optional env: CORS_ORIGINS, MAX_UPLOAD_BYTES, MAX_PIXELS, MAX_ANALYSIS_PIXELS,
              ANALYZE_CONCURRENCY, APP_VERSION.
"""
from __future__ import annotations

import base64
import contextlib
import contextvars
import dataclasses
import io
import json
import math
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

# Keep Matplotlib off unwritable home directories.
MPL_DIR = Path("/tmp/espresso-mpl")
MPL_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(MPL_DIR))
# numba caches compiled kernels next to the source by default; Cloud Run's
# source directory is read-only, so keep the cache in /tmp instead.
os.environ.setdefault("NUMBA_CACHE_DIR", "/tmp/espresso-numba")

import matplotlib
import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, Path as ApiPath, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field

matplotlib.use("Agg")

import coffeegrindsize_core as _core
from coffeegrindsize_core import (
    AnalysisSettings,
    Cluster,
    HistogramSettings,
    ParticleDataset,
    REFERENCE_OBJECTS_MM,
    analyze_image,
    cluster_center_mask,
    cluster_outline_mask,
    clusters_within_radius,
    filter_dataset_by_cluster_ids,
    metric_values,
    plot_histogram,
    summarize_dataset,
)
from coffeegrindsize_core.analysis import metric_weights, _weighted_percentiles

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_LOCAL_DEV = os.environ.get("LOCAL_DEV", "").lower() == "true"


def _split_env(*names: str) -> list[str]:
    out: list[str] = []
    for name in names:
        out += [p.strip() for p in os.environ.get(name, "").split(",") if p.strip()]
    return out


_ALLOWED_EMAILS = {e.lower() for e in _split_env("ALLOWED_EMAILS", "ALLOWED_EMAIL")}
_GCS_BUCKET_NAME = os.environ.get("GCS_BUCKET")
_CORS_ORIGINS = _split_env("CORS_ORIGINS") or [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://ednmolina.github.io",
]
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES") or 25 * 1024 * 1024)
MAX_PIXELS = int(float(os.environ.get("MAX_PIXELS") or 40e6))
MAX_ANALYSIS_PIXELS = int(float(os.environ.get("MAX_ANALYSIS_PIXELS") or 16e6))
APP_VERSION = os.environ.get("APP_VERSION") or os.environ.get("K_REVISION") or "dev"
_ANALYZE_SEM = threading.BoundedSemaphore(int(os.environ.get("ANALYZE_CONCURRENCY") or 1))

_UUID4 = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
_IMAGE_ID_RE = rf"^{_UUID4}$"
_RESULT_ID_RE = rf"^{_UUID4}(\.[0-9a-f]{{12}})?$"
ImageId = Annotated[str, Field(pattern=_IMAGE_ID_RE)]
ResultId = Annotated[str, Field(pattern=_RESULT_ID_RE)]


def _check_config() -> None:
    if not _LOCAL_DEV and not _ALLOWED_EMAILS:
        raise RuntimeError("ALLOWED_EMAILS must be set (comma separated) unless LOCAL_DEV=true.")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

_firebase_app = None


def _get_firebase_app():
    global _firebase_app
    if _firebase_app is None:
        import firebase_admin
        _firebase_app = firebase_admin.initialize_app()
    return _firebase_app


def _verify_token(authorization: Optional[str]) -> None:
    """Raise HTTP 401/403 if the Firebase ID token is missing, invalid or not allowed."""
    if _LOCAL_DEV:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization token.")
    token = authorization[len("Bearer "):]
    try:
        from firebase_admin import auth as firebase_auth
        decoded = firebase_auth.verify_id_token(token, app=_get_firebase_app())
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")
    email = str(decoded.get("email", "")).lower()
    if not decoded.get("email_verified") or not email or email not in _ALLOWED_EMAILS:
        raise HTTPException(status_code=403, detail="Access denied.")


def _auth(authorization: Optional[str] = Header(None)) -> None:
    _verify_token(authorization)


# ---------------------------------------------------------------------------
# Per-request timings (Server-Timing header + structured log line)
# ---------------------------------------------------------------------------

_CTX: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("request_ctx", default=None)


@contextlib.contextmanager
def _phase(name: str):
    start = time.perf_counter()
    try:
        yield
    finally:
        ctx = _CTX.get()
        if ctx is not None:
            ctx["t"][name] = ctx["t"].get(name, 0.0) + (time.perf_counter() - start) * 1000.0


def _note(**kw) -> None:
    ctx = _CTX.get()
    if ctx is not None:
        ctx["meta"].update(kw)


# ---------------------------------------------------------------------------
# JSON sanitising
# ---------------------------------------------------------------------------

def _finite(obj: Any) -> Any:
    """Recursively replace NaN/inf with None and numpy scalars with Python ones."""
    if isinstance(obj, dict):
        return {k: _finite(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_finite(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return _finite(obj.tolist())
    if isinstance(obj, np.generic):
        obj = obj.item()
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def _sig6(a: np.ndarray) -> np.ndarray:
    a = np.asarray(a, dtype=float)
    out = a.copy()
    ok = np.isfinite(a) & (a != 0)
    mag = np.floor(np.log10(np.abs(a[ok])))
    f = 10.0 ** (5 - mag)
    out[ok] = np.round(a[ok] * f) / f
    return out


# ---------------------------------------------------------------------------
# Cloud Storage state (falls back to in-memory for local dev)
# ---------------------------------------------------------------------------

_gcs_bucket = None
if _GCS_BUCKET_NAME:
    from google.cloud import storage as _gcs_lib
    _gcs_bucket = _gcs_lib.Client().bucket(_GCS_BUCKET_NAME)

_io_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="gcs")


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


class _TooLarge(Exception):
    pass


def _decode_image(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        if img.width * img.height > MAX_PIXELS:
            raise _TooLarge(f"Image is too large ({img.width}x{img.height}); limit is {MAX_PIXELS / 1e6:.0f} megapixels.")
        # Apply EXIF orientation so the analysed pixels match what browsers display.
        return ImageOps.exif_transpose(img).convert("RGB")
    except Image.DecompressionBombError as exc:
        raise _TooLarge("Image is too large.") from exc


def _gcs_download(path: str) -> Optional[bytes]:
    try:
        return _gcs_bucket.blob(path).download_as_bytes()
    except Exception as exc:
        if type(exc).__name__ == "NotFound":
            return None
        raise


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
    """What later requests need from an analysis: particles and image size."""

    def __init__(
        self,
        dataset: ParticleDataset,
        shape: tuple[int, int],
        background_median: float,
        analysis_scale: float = 1.0,
        min_surface: float = 5.0,
    ):
        self.dataset = dataset
        self.shape = shape
        self.background_median = background_median
        self.analysis_scale = analysis_scale
        self.min_surface = min_surface


_CORE_CLUSTER_FIELDS = {
    "cluster_id", "surface", "roundness", "short_axis", "long_axis", "volume",
    "xmean", "ymean", "x_pixels", "y_pixels",
}
# Extra scalar per-cluster fields added by the core model (stored generically).
_EXTRA_CLUSTER_FIELDS = [
    f.name for f in dataclasses.fields(Cluster)
    if f.name not in _CORE_CLUSTER_FIELDS and f.type in ("float", "int", "bool", float, int, bool)
]


def _serialize_result(result: StoredResult) -> bytes:
    cl = result.dataset.clusters
    n = len(cl)
    offsets = np.zeros(n + 1, dtype=np.int64)
    if n:
        offsets[1:] = np.cumsum([len(c.x_pixels) for c in cl])
    cat = lambda attr: (  # noqa: E731
        np.concatenate([np.asarray(getattr(c, attr), dtype=np.int32) for c in cl])
        if n else np.zeros(0, dtype=np.int32)
    )
    meta = {
        "shape": [int(result.shape[0]), int(result.shape[1])],
        "background_median": float(result.background_median),
        "pixel_scale": result.dataset.pixel_scale,
        "analysis_scale": float(result.analysis_scale),
        "min_surface": float(result.min_surface),
        "dataset_meta": _finite(dict(getattr(result.dataset, "meta", None) or {})),
        "version": 1,
    }
    arrays = {
        "cluster_id": np.array([c.cluster_id for c in cl], dtype=np.int64),
        "surface": np.array([c.surface for c in cl], dtype=float),
        "roundness": np.array([c.roundness for c in cl], dtype=float),
        "short_axis": np.array([c.short_axis for c in cl], dtype=float),
        "long_axis": np.array([c.long_axis for c in cl], dtype=float),
        "volume": np.array([c.volume for c in cl], dtype=float),
        "xmean": np.array([c.xmean for c in cl], dtype=float),
        "ymean": np.array([c.ymean for c in cl], dtype=float),
        "px_offsets": offsets,
        "x_pixels": cat("x_pixels"),
        "y_pixels": cat("y_pixels"),
        "meta": np.frombuffer(json.dumps(meta).encode("utf-8"), dtype=np.uint8),
    }
    for name in _EXTRA_CLUSTER_FIELDS:
        arrays[f"cx_{name}"] = np.array([getattr(c, name) for c in cl], dtype=float)
    buf = io.BytesIO()
    np.savez(buf, **arrays)
    return buf.getvalue()


def _deserialize_result(raw: bytes) -> StoredResult:
    with np.load(io.BytesIO(raw), allow_pickle=False) as z:
        meta = json.loads(bytes(z["meta"].tobytes()).decode("utf-8"))
        off = z["px_offsets"]
        xs, ys = z["x_pixels"], z["y_pixels"]
        extras = {name: z[f"cx_{name}"] for name in _EXTRA_CLUSTER_FIELDS if f"cx_{name}" in z.files}
        cols = {k: z[k] for k in ("cluster_id", "surface", "roundness", "short_axis", "long_axis", "volume", "xmean", "ymean")}
    clusters = []
    for i in range(len(cols["cluster_id"])):
        kw = {k: (int(v[i]) if k == "cluster_id" else float(v[i])) for k, v in cols.items()}
        for name, arr in extras.items():
            kw[name] = float(arr[i])
        clusters.append(Cluster(x_pixels=xs[off[i]:off[i + 1]], y_pixels=ys[off[i]:off[i + 1]], **kw))
    dataset = ParticleDataset(clusters=clusters, pixel_scale=meta.get("pixel_scale"))
    if meta.get("dataset_meta") and hasattr(dataset, "meta"):
        dataset.meta = dict(meta["dataset_meta"])
    return StoredResult(
        dataset, tuple(meta["shape"]), meta["background_median"],
        meta.get("analysis_scale", 1.0), meta.get("min_surface", 5.0),
    )


def _store_result(keys: list[str], result: StoredResult) -> None:
    for k in keys:
        _result_cache.put(k, result)
    if _gcs_bucket is not None:
        raw = _serialize_result(result)

        def up(k: str) -> None:
            _gcs_bucket.blob(f"tmp/results/{k}.npz").upload_from_string(raw, content_type="application/octet-stream")

        for f in [_io_pool.submit(up, k) for k in keys]:
            f.result()


def _load_result(result_id: str) -> Optional[StoredResult]:
    result = _result_cache.get(result_id)
    if result is not None or _gcs_bucket is None:
        return result
    raw = _gcs_download(f"tmp/results/{result_id}.npz")
    if raw is None:
        return None
    result = _deserialize_result(raw)
    _result_cache.put(result_id, result)
    return result


# ---------------------------------------------------------------------------
# Warm-up / app
# ---------------------------------------------------------------------------

def warm_up_kernels() -> float:
    """Compile (or load cached) numba kernels. Safe at Docker build time. Returns seconds."""
    start = time.perf_counter()
    fn = getattr(_core, "warm_up", None)
    try:
        if callable(fn):
            fn()
        else:
            rng = np.random.default_rng(0)
            arr = np.full((64, 64, 3), 230, dtype=np.uint8)
            arr[20:30, 20:28] = rng.integers(40, 90, size=(10, 8, 3))
            image = Image.fromarray(arr)
            poly = [(2.0, 2.0), (60.0, 2.0), (60.0, 60.0), (2.0, 60.0)]
            analyze_image(image, AnalysisSettings(pixel_scale=10.0))
            analyze_image(image, AnalysisSettings(pixel_scale=10.0, quick_mode=True))
            analyze_image(image, AnalysisSettings(pixel_scale=10.0, analysis_polygon=poly))
            cluster_outline_mask((4, 4), [])
    except Exception:  # warm-up is best effort
        pass
    return time.perf_counter() - start


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI):
    _check_config()
    app.state.warm = False

    def run():
        warm_up_kernels()
        app.state.warm = True

    threading.Thread(target=run, daemon=True, name="warm-up").start()
    yield


app = FastAPI(title="Coffee Grind Size Analyzer API", lifespan=_lifespan)
app.state.warm = False


@app.middleware("http")
async def _timing_middleware(request: Request, call_next):
    rid = uuid.uuid4().hex[:16]
    ctx = {"t": {}, "meta": {}}
    token = _CTX.set(ctx)
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as exc:  # unhandled -> JSON 500 that still carries our headers
        print(json.dumps({"severity": "ERROR", "path": request.url.path, "error": type(exc).__name__, "request_id": rid}), flush=True)
        response = JSONResponse({"detail": "Internal server error."}, status_code=500)
    finally:
        _CTX.reset(token)
    total = (time.perf_counter() - start) * 1000.0
    parts = [f"{k};dur={v:.1f}" for k, v in ctx["t"].items()] + [f"total;dur={total:.1f}"]
    response.headers["Server-Timing"] = ", ".join(parts)
    response.headers["X-Request-Id"] = rid
    print(json.dumps({
        "severity": "INFO" if response.status_code < 500 else "ERROR",
        "request_id": rid, "method": request.method, "path": request.url.path,
        "status": response.status_code,
        "timings_ms": {k: round(v, 1) for k, v in ctx["t"].items()} | {"total": round(total, 1)},
        **ctx["meta"],
    }), flush=True)
    return response


app.add_middleware(GZipMiddleware, minimum_size=2048, compresslevel=5)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Server-Timing", "X-Request-Id"],
)


@app.exception_handler(ValueError)
async def _value_error_handler(request: Request, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError):
    errors = [
        {"loc": list(e.get("loc", [])), "msg": str(e.get("msg", "")), "type": str(e.get("type", ""))}
        for e in exc.errors()
    ]
    return JSONResponse({"detail": errors}, status_code=422)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pil_to_b64(image: Image.Image, fmt: str = "PNG", **save_kwargs) -> str:
    buf = io.BytesIO()
    image.save(buf, format=fmt, **save_kwargs)
    return base64.b64encode(buf.getvalue()).decode()


def _mask_layer_b64(mask: np.ndarray, color: tuple[int, int, int], extra: Optional[tuple[np.ndarray, tuple[int, int, int]]] = None) -> str:
    """Encode a boolean mask as a transparent palette PNG for drawing over the photo."""
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


def _particles_payload(dataset: ParticleDataset) -> dict:
    cl = dataset.clusters
    return {
        "id": [int(c.cluster_id) for c in cl],
        "surface": _finite(_sig6(dataset.surfaces)),
        "roundness": _finite(_sig6(dataset.roundness)),
        "short_axis": _finite(_sig6(dataset.short_axes)),
        "long_axis": _finite(_sig6(dataset.long_axes)),
        "volume": _finite(_sig6(dataset.volumes)),
    }


def _summary_or_none(dataset: ParticleDataset) -> Optional[dict]:
    if dataset.nclusters > 0 and dataset.pixel_scale is not None:
        try:
            return _finite(summarize_dataset(dataset))
        except ValueError:
            return None
    return None


@contextlib.contextmanager
def _analysis_slot():
    if not _ANALYZE_SEM.acquire(timeout=60):
        raise HTTPException(status_code=503, detail="Server busy, retry shortly.", headers={"Retry-After": "5"})
    try:
        yield
    finally:
        _ANALYZE_SEM.release()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

_Point = tuple[float, float]


class _Req(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)


class AnalyzeRequest(_Req):
    image_id: ImageId
    threshold_percent: float = Field(58.8, ge=1, le=100)
    reference_threshold: float = Field(0.4, ge=0, le=1)
    max_cost: float = Field(0.35, ge=0)
    max_cluster_axis: float = Field(100.0, ge=1, le=200)
    min_surface: float = Field(5.0, ge=0)
    min_roundness: float = Field(0.0, ge=0, le=1)
    quick_mode: bool = False
    analysis_scale_pct: int = Field(100, ge=10, le=100)
    reference_points: Optional[Annotated[list[_Point], Field(max_length=2)]] = None
    reference_physical_mm: Optional[float] = Field(None, gt=0, le=1000)
    polygon_points: Optional[Annotated[list[_Point], Field(max_length=2000)]] = None
    # Measurement-model settings: None = use the core default.
    background_model: Optional[Literal["global", "poly4"]] = None
    threshold_mode: Optional[Literal["fixed", "half_contrast"]] = None
    edge_correction: Optional[bool] = None
    axis_method: Optional[Literal["max_radius", "moments"]] = None
    volume_model: Optional[Literal["legacy", "spheroid"]] = None
    min_diameter_um: Optional[float] = Field(None, ge=0, le=100000)
    click_sigma_px: Optional[float] = Field(None, ge=0, le=100)


_MODEL_FIELDS = (
    "background_model", "threshold_mode", "edge_correction", "axis_method",
    "volume_model", "min_diameter_um", "click_sigma_px",
)


class EraseRequest(_Req):
    image_id: ResultId
    erase_points: Annotated[list[_Point], Field(min_length=1, max_length=2000)]
    erase_radius_px: float = Field(20.0, gt=0, le=5000)
    already_removed_ids: Annotated[list[int], Field(max_length=200000)] = []


Metric = Literal["diameter", "surface", "volume", "extraction_yield"]
WeightMode = Literal["number", "surface", "mass", "available_mass", "extracted_mass"]


class HistogramRequest(_Req):
    image_id: ResultId
    removed_cluster_ids: Annotated[list[int], Field(max_length=200000)] = []
    x_metric: Metric = "diameter"
    weight_mode: WeightMode = "number"
    x_log: bool = True
    bins: Optional[int] = Field(None, ge=2, le=500)
    include_png: bool = True
    min_diameter_um: Optional[float] = Field(None, ge=0, le=100000)


class RunRef(_Req):
    image_id: ResultId
    removed_cluster_ids: Annotated[list[int], Field(max_length=200000)] = []
    label: str = Field("", max_length=60)


class HistogramCompareRequest(_Req):
    runs: Annotated[list[RunRef], Field(min_length=1, max_length=6)]
    x_metric: Metric = "diameter"
    weight_mode: WeightMode = "number"
    x_log: bool = True
    bins: Optional[int] = Field(None, ge=2, le=500)
    include_png: bool = True
    min_diameter_um: Optional[float] = Field(None, ge=0, le=100000)


class Particles(BaseModel):
    id: list[int]
    surface: list[Optional[float]]
    roundness: list[Optional[float]]
    short_axis: list[Optional[float]]
    long_axis: list[Optional[float]]
    volume: list[Optional[float]]


class UploadResponse(BaseModel):
    image_id: str
    width: int
    height: int
    reference_objects: dict[str, float]
    image_b64: Optional[str] = None
    image_mime: Optional[str] = None


class AnalyzeResponse(BaseModel):
    threshold_layer_b64: str
    cluster_layer_b64: str
    background_median: Optional[float]
    nclusters: int
    pixel_scale: Optional[float]
    summary: Optional[dict[str, Any]]
    particles: Particles
    analysis_scale: float
    analysis_id: str
    width: int
    height: int


class EraseResponse(BaseModel):
    removed_ids: list[int]
    nclusters: int
    cluster_layer_b64: str
    summary: Optional[dict[str, Any]]


class HistogramResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    histogram_b64: Optional[str]
    series: dict[str, Any]
    unit: str
    scale: float
    axis_label: str


class CompareResponse(BaseModel):
    histogram_b64: Optional[str]
    series: dict[str, Any]
    unit: str
    scale: float
    axis_label: str
    per_run: list[dict[str, Any]]
    combined: dict[str, Any]
    min_diameter_um_applied: Optional[float] = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "warm": bool(getattr(app.state, "warm", False)), "version": APP_VERSION}


@app.post("/upload", response_model=UploadResponse, response_model_exclude_none=True)
def upload_image(
    file: UploadFile = File(...),
    include_preview: bool = False,
    _: None = Depends(_auth),
):
    with _phase("load"):
        data = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"File too large; limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
        try:
            image = _decode_image(data)
        except _TooLarge as exc:
            raise HTTPException(status_code=413, detail=str(exc))
        except Exception:
            raise HTTPException(status_code=400, detail="Could not decode image.")

    image_id = str(uuid.uuid4())
    with _phase("store"):
        _store_image(image_id, data, image)
    _note(width=image.width, height=image.height)

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
def preview_image(image_id: str = ApiPath(..., pattern=_IMAGE_ID_RE), _: None = Depends(_auth)):
    with _phase("load"):
        image = _load_image(image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found. Upload first.")
    return {"image_b64": _pil_to_b64(image, "JPEG", quality=90), "image_mime": "image/jpeg"}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest, _: None = Depends(_auth)):
    with _phase("load"):
        image = _load_image(req.image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found. Upload first.")

    w, h = image.size
    scale = req.analysis_scale_pct / 100.0
    if w * h * scale * scale > MAX_ANALYSIS_PIXELS:  # auto-cap huge photos
        scale = math.sqrt(MAX_ANALYSIS_PIXELS / (w * h))

    pixel_scale = None
    px_length = None
    if req.reference_points is not None and len(req.reference_points) == 2 and req.reference_physical_mm:
        (x1, y1), (x2, y2) = req.reference_points
        px_length = math.hypot(x2 - x1, y2 - y1)
        if px_length < 2:
            raise HTTPException(status_code=400, detail="Reference points are too close together (need at least 2 px).")
        pixel_scale = (px_length / req.reference_physical_mm) * scale

    analysis_polygon = None
    if req.polygon_points and len(req.polygon_points) >= 3:
        analysis_polygon = [(x * scale, y * scale) for x, y in req.polygon_points]

    kwargs: dict[str, Any] = dict(
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
    for name in _MODEL_FIELDS:
        if getattr(req, name) is not None:
            kwargs[name] = getattr(req, name)
    if px_length is not None:
        kwargs["reference_px_length"] = px_length * scale
    allowed = {f.name for f in dataclasses.fields(AnalysisSettings)}
    settings = AnalysisSettings(**{k: v for k, v in kwargs.items() if k in allowed})

    with _analysis_slot():
        with _phase("analyze"):
            if scale < 1.0:
                analysis_image = image.resize(
                    (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                    resample=Image.Resampling.LANCZOS,
                )
            else:
                analysis_image = image
            result = analyze_image(analysis_image, settings)
        dataset = result.dataset
        shape = tuple(int(s) for s in result.blue_channel.shape)
        with _phase("encode"):
            threshold_layer = _mask_layer_b64(result.threshold_mask, (255, 59, 48))
            cluster_layer = _cluster_layer_b64(shape, dataset)
        background_median = float(result.background_median)
        del result, analysis_image

    stored = StoredResult(dataset, shape, background_median, scale, req.min_surface)
    # "latest" result for erase/histogram, plus a frozen copy that saved runs
    # can refer to even after the same image is re-analysed.
    analysis_id = f"{req.image_id}.{uuid.uuid4().hex[:12]}"
    with _phase("store"):
        _store_result([req.image_id, analysis_id], stored)

    _note(nclusters=dataset.nclusters, width=shape[1], height=shape[0])
    return _finite({
        "threshold_layer_b64": threshold_layer,
        "cluster_layer_b64": cluster_layer,
        "background_median": background_median,
        "nclusters": dataset.nclusters,
        "pixel_scale": dataset.pixel_scale,
        "summary": _summary_or_none(dataset),
        "particles": _particles_payload(dataset),
        "analysis_scale": scale,
        "analysis_id": analysis_id,
        "width": shape[1],
        "height": shape[0],
    })


@app.post("/erase", response_model=EraseResponse)
def erase(req: EraseRequest, _: None = Depends(_auth)):
    with _phase("load"):
        result = _load_result(req.image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No analysis found for this image.")

    s = result.analysis_scale
    already = set(req.already_removed_ids)
    dataset = filter_dataset_by_cluster_ids(result.dataset, already)
    # Clicks arrive as full-image [x=col, y=row]; Cluster.xmean is the ROW and
    # ymean the COLUMN, in analysis pixels.
    erase_pts = [(y * s, x * s) for x, y in req.erase_points]
    with _phase("analyze"):
        ids_to_remove = clusters_within_radius(dataset, erase_pts, req.erase_radius_px * s)

    all_removed = already | ids_to_remove
    filtered = filter_dataset_by_cluster_ids(result.dataset, all_removed)
    with _phase("encode"):
        layer = _cluster_layer_b64(result.shape, filtered)
    _note(nclusters=filtered.nclusters, width=result.shape[1], height=result.shape[0])
    return _finite({
        "removed_ids": sorted(all_removed),
        "nclusters": filtered.nclusters,
        "cluster_layer_b64": layer,
        "summary": _summary_or_none(filtered),
    })


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
    else:  # extraction_yield - already in %
        return 1.0, "%", r"\%", "Extraction Yield (%)"


def _distribution_stats(values: np.ndarray, weights: Optional[np.ndarray] = None) -> dict:
    """Mean/median and spread percentiles, optionally weighted (weight_mode).

    Keys ``*_upper``/``*_lower`` are kept for compatibility; ``*_spread_*`` are
    the same numbers under their honest name (P16-P84 / P25-P75 spread, not errors).
    """
    try:
        from coffeegrindsize_core.stats import distribution_stats as helper
        return helper(values, weights)
    except ImportError:
        pass
    values = np.asarray(values, dtype=float)
    w = None
    if weights is not None:
        w = np.nan_to_num(np.asarray(weights, dtype=float), nan=0.0, posinf=0.0, neginf=0.0).clip(min=0.0)
        if not np.any(w > 0) or np.all(w == w[0]):
            w = None
    if w is None:
        mean_val = float(np.mean(values))
        median_val = float(np.median(values))
        p16, p25, p75, p84 = (float(v) for v in np.percentile(values, (16, 25, 75, 84)))
    else:
        mean_val = float(np.sum(values * w) / np.sum(w))
        p16, p25, median_val, p75, p84 = _weighted_percentiles(values, w, (16, 25, 50, 75, 84))
    return {
        "mean": mean_val, "mean_upper": p84 - mean_val, "mean_lower": mean_val - p16,
        "median": median_val, "median_upper": p75 - median_val, "median_lower": median_val - p25,
        "mean_spread_upper": p84 - mean_val, "mean_spread_lower": mean_val - p16,
        "median_spread_upper": p75 - median_val, "median_spread_lower": median_val - p25,
        "p16": p16, "p25": p25, "p75": p75, "p84": p84,
    }


def _add_stats_lines(
    ax, stats: dict, x_log: bool,
    color: str = "#2c7bb6",
    scale: float = 1.0,
    latex_unit: str = r"\mathrm{mm}",
) -> None:
    """Add mean/median lines with LaTeX superscript/subscript asymmetric spreads."""
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


def _value_range(values: list[np.ndarray], metric: str) -> tuple[float, float]:
    xmin = float(min(np.nanmin(v) for v in values))
    xmax = float(max(np.nanmax(v) for v in values))
    if metric == "extraction_yield":
        xmin, xmax = min(xmin, 20.0), max(xmax, 30.0)
    if xmax <= xmin:  # single particle / identical sizes
        xmin, xmax = xmin * 0.95, xmax * 1.05 + 1e-9
    return xmin, xmax


def _histogram_series(datasets: list[ParticleDataset], settings: HistogramSettings) -> dict:
    """Bin edges and per-run weight fractions, so the browser can draw the chart."""
    from coffeegrindsize_core import plotting

    values = [metric_values(ds, settings.x_metric) for ds in datasets]
    weights = [metric_weights(ds, settings.weight_mode) for ds in datasets]
    xmin, xmax = _value_range(values, settings.x_metric)
    edges = plotting._build_bins(xmin=xmin, xmax=xmax, x_log=settings.x_log, bins=settings.bins)
    series = []
    for ds, v, w in zip(datasets, values, weights):
        total = np.nansum(w)
        counts, _ = np.histogram(v, bins=edges, weights=w / total if total else w)
        series.append({"label": ds.label, "fractions": counts.tolist()})
    return {"edges": edges.tolist(), "series": series, "x_log": settings.x_log}


_MPL_LOCK = threading.Lock()


def _render_png(datasets: list[ParticleDataset], settings: HistogramSettings, axis_label: str,
                scale: float, entries: list[tuple[dict, str]], latex_unit: str) -> str:
    """Render the histogram PNG; matplotlib's pyplot state is not thread safe."""
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter

    with _MPL_LOCK:
        figure, _ = plot_histogram(datasets, settings)
        try:
            ax = figure.axes[0]
            ax.set_xlabel(axis_label)
            if scale != 1.0:
                ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{x * scale:.3g}"))
            for stats, color in entries:
                _add_stats_lines(ax, stats, settings.x_log, color=color, scale=scale, latex_unit=latex_unit)
            buf = io.BytesIO()
            figure.savefig(buf, format="png", bbox_inches="tight")
        finally:
            plt.close(figure)
    return base64.b64encode(buf.getvalue()).decode()


def _min_diameter_filter(ds: ParticleDataset, cutoff_um: Optional[float]) -> ParticleDataset:
    if not cutoff_um or ds.nclusters == 0 or ds.pixel_scale is None:
        return ds
    core_filter = getattr(_core, "filter_by_min_diameter", None)
    if callable(core_filter):
        return core_filter(ds, ds.pixel_scale, cutoff_um)
    diam_um = metric_values(ds, "diameter") * 1000.0
    keep = [c for c, d in zip(ds.clusters, diam_um) if d >= cutoff_um]
    out = ParticleDataset(clusters=keep, pixel_scale=ds.pixel_scale, label=ds.label)
    if hasattr(ds, "meta"):
        out.meta = dict(ds.meta)
    return out


def _stored_min_diameter(result: StoredResult) -> Optional[float]:
    return (getattr(result.dataset, "meta", None) or {}).get("min_diameter_um")


def _detection_limit_um(result: StoredResult) -> Optional[float]:
    ps = result.dataset.pixel_scale
    if not ps or ps <= 0:
        return None
    return 2000.0 * math.sqrt(max(result.min_surface, 0.0) / math.pi) / ps


def _histogram_settings(req, datasets: list[ParticleDataset]) -> HistogramSettings:
    s = HistogramSettings(x_metric=req.x_metric, weight_mode=req.weight_mode, x_log=req.x_log, bins=req.bins)
    values = [metric_values(ds, req.x_metric) for ds in datasets]
    s.xmin, s.xmax = _value_range(values, req.x_metric)
    return s


@app.post("/histogram", response_model=HistogramResponse)
def histogram(req: HistogramRequest, _: None = Depends(_auth)):
    with _phase("load"):
        result = _load_result(req.image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No analysis found for this image.")

    dataset = filter_dataset_by_cluster_ids(result.dataset, set(req.removed_cluster_ids))
    if dataset.nclusters == 0 or dataset.pixel_scale is None:
        raise HTTPException(status_code=400, detail="No particles or no pixel scale set.")
    cutoff = req.min_diameter_um if req.min_diameter_um is not None else _stored_min_diameter(result)
    dataset = _min_diameter_filter(dataset, cutoff)
    if dataset.nclusters == 0:
        raise HTTPException(status_code=400, detail="No particles above the minimum diameter.")

    settings = _histogram_settings(req, [dataset])
    values = metric_values(dataset, req.x_metric)
    weights = metric_weights(dataset, req.weight_mode)
    scale, display_unit, latex_unit, axis_label = _unit_for_metric(req.x_metric, values)
    stats = _distribution_stats(values, weights)

    histogram_b64 = None
    if req.include_png:
        with _phase("encode"):
            histogram_b64 = _render_png([dataset], settings, axis_label, scale, [(stats, "#2c7bb6")], latex_unit)
    _note(nclusters=dataset.nclusters)

    return _finite({
        "histogram_b64": histogram_b64,
        "series": _histogram_series([dataset], settings),
        "unit": display_unit,
        "scale": scale,
        "axis_label": axis_label,
        **stats,
    })


@app.post("/histogram/compare", response_model=CompareResponse)
def histogram_compare(req: HistogramCompareRequest, _: None = Depends(_auth)):
    stored = []
    with _phase("load"):
        for run in req.runs:
            result = _load_result(run.image_id)
            if result is None:
                raise HTTPException(status_code=404, detail=f"No analysis found for image {run.image_id}.")
            stored.append(result)

    # Common size cutoff so runs are compared above the coarsest detection limit.
    cutoff = None
    if len(stored) > 1:
        common = getattr(_core, "common_min_diameter_um", None)
        if callable(common):
            cutoff = common([r.dataset for r in stored], [r.dataset.pixel_scale for r in stored])
        else:
            limits = [x for x in (_detection_limit_um(r) for r in stored) if x is not None]
            if limits:
                cutoff = max(limits)
    explicit = req.min_diameter_um
    if explicit is None:
        explicit = max([m for m in (_stored_min_diameter(r) for r in stored) if m] or [0.0])
    if explicit:
        cutoff = max(cutoff or 0.0, explicit)

    datasets = []
    for run, result in zip(req.runs, stored):
        ds = filter_dataset_by_cluster_ids(result.dataset, set(run.removed_cluster_ids))
        if ds.nclusters == 0 or ds.pixel_scale is None:
            raise HTTPException(status_code=400, detail=f"Run '{run.label}' has no particles or no scale.")
        ds = _min_diameter_filter(ds, cutoff)
        if ds.nclusters == 0:
            raise HTTPException(status_code=400, detail=f"Run '{run.label}' has no particles above the minimum diameter.")
        ds.label = run.label or f"Run {len(datasets) + 1}"
        datasets.append(ds)

    settings = _histogram_settings(req, datasets)
    first_values = metric_values(datasets[0], req.x_metric)
    scale, display_unit, latex_unit, axis_label = _unit_for_metric(req.x_metric, first_values)

    per_run_stats = [
        {"label": ds.label, **_distribution_stats(metric_values(ds, req.x_metric), metric_weights(ds, req.weight_mode))}
        for ds in datasets
    ]

    histogram_b64 = None
    if req.include_png:
        colors = ["#2c7bb6", "#2f7d4a", "#9c5a14", "#7b3294", "#008837", "#e66101"]
        with _phase("encode"):
            histogram_b64 = _render_png(datasets, settings, axis_label, scale, list(zip(per_run_stats, colors)), latex_unit)

    all_means = [s["mean"] for s in per_run_stats]
    all_medians = [s["median"] for s in per_run_stats]
    combined = {
        "mean_of_means": float(np.mean(all_means)),
        "median_of_medians": float(np.median(all_medians)),
        "std_of_means": float(np.std(all_means)),
    }

    return _finite({
        "histogram_b64": histogram_b64,
        "series": _histogram_series(datasets, settings),
        "unit": display_unit,
        "scale": scale,
        "axis_label": axis_label,
        "per_run": per_run_stats,
        "combined": combined,
        "min_diameter_um_applied": cutoff,
    })
