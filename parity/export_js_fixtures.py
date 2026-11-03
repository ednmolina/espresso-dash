#!/usr/bin/env python
"""Export Python-core results as JSON fixtures for the on-device JS port.

    python parity/export_js_fixtures.py            # (re)write the fixtures + manifest
    python parity/export_js_fixtures.py --check    # fail if they drifted from the Python sources

Output: React/frontend/src/analysis/__fixtures__/{manifest.json, core_*.json, api_*.json, resize_*.json}

Lives in parity/ rather than tests/ because check-protected.mjs freezes tests/ (see COMMON.md).

Fixture formats (all consumed by React/frontend/src/analysis/__tests__/parity.*.test.js)
-----------------------------------------------------------------------------------------
Inputs carry only the blue channel (the core reads channel 2): ``blue_b64z`` =
base64(zlib.compress(blue.tobytes(), 9)) with ``height``/``width``.

Hash: FNV-1a 32-bit (h = 0x811c9dc5; per byte: h ^= b; h = imul(h, 0x01000193) >>> 0).
``fnv_bytes`` hashes uint8 data; ``fnv_u32`` hashes each value as 4 little-endian bytes.
A mask hash is fnv_u32 of the set linear indices (r * width + c), ascending.
A layer hash is fnv_bytes of the (height * width) uint8 index image (0 / 1 / 2).

core_*.json     {kind, preset: legacy|modern, settings: AnalysisSettings overrides, height, width,
                 blue_b64z, blue_hash, expected: {...}}   (see ``run_core`` for ``expected``)
api_*.json      {kind, height, width, blue_b64z, upload, steps: [...]}.  Each step replays one
                 endpoint; every ``image_id`` in a recorded request is the placeholder "$image"
                 (analyze) or "$step:K" (the analysis_id returned by step K).  Error steps carry
                 ``expect: {status, detail}``.
resize_*.json   {kind, src_width, src_height, width, height, scale, src_b64z, expected_b64z}

Caveat: zlib output can differ between zlib builds, so drift checks compare the *decompressed*
payloads (see ``canonical``), never the compressed text.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import pathlib
import sys
import zlib
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "cloudrun"))
sys.path.insert(0, str(ROOT))
os.environ["LOCAL_DEV"] = "true"
os.environ.pop("GCS_BUCKET", None)
os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / ".numba_cache"))

import numpy as np  # noqa: E402
from numba import njit  # noqa: E402
from PIL import Image  # noqa: E402

FIXTURE_DIR = ROOT / "React" / "frontend" / "src" / "analysis" / "__fixtures__"
BUDGET_BYTES = 3 * 1024 * 1024
REGEN_COMMAND = "python parity/export_js_fixtures.py"
# Cases that do not depend on the CPU's BLAS (no poly4 fit), so a byte-for-byte rebuild is a
# valid drift test anywhere.
STABLE_CASES = ["core_legacy_00", "core_legacy_07", "api_00", "resize_00"]


# ---------------------------------------------------------------------------
# hashing / encoding helpers
# ---------------------------------------------------------------------------

@njit(cache=False)
def _fnv_nb(data):
    h = np.uint64(0x811C9DC5)
    prime = np.uint64(0x01000193)
    mask = np.uint64(0xFFFFFFFF)
    for i in range(data.size):
        h = (h ^ np.uint64(data[i])) * prime & mask
    return h


def fnv_bytes(data) -> int:
    arr = np.ascontiguousarray(np.asarray(data, dtype=np.uint8)).ravel()
    return int(_fnv_nb(arr))


def fnv_u32(values) -> int:
    arr = np.ascontiguousarray(np.asarray(values).astype("<u4")).ravel()
    return int(_fnv_nb(arr.view(np.uint8)))


def mask_info(mask: np.ndarray) -> dict:
    idx = np.flatnonzero(np.asarray(mask).ravel())
    return {"count": int(idx.size), "hash": fnv_u32(idx)}


def b64z(data) -> str:
    raw = data if isinstance(data, (bytes, bytearray)) else np.ascontiguousarray(data).tobytes()
    return base64.b64encode(zlib.compress(bytes(raw), 9)).decode("ascii")


def unb64z(text: str) -> bytes:
    return zlib.decompress(base64.b64decode(text))


def clean(obj):
    """Numpy -> Python, non-finite -> None (floats keep full repr precision)."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return clean(obj.tolist())
    if isinstance(obj, np.generic):
        obj = obj.item()
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def dumps(obj) -> str:
    return json.dumps(clean(obj), allow_nan=False, separators=(",", ":")) + "\n"


def canonical(text: str) -> str:
    """JSON text with every ``*_b64z`` payload replaced by the sha256 of its inflated bytes."""
    def walk(o):
        if isinstance(o, dict):
            return {k: (hashlib.sha256(unb64z(v)).hexdigest() if k.endswith("_b64z") and isinstance(v, str) else walk(v))
                    for k, v in o.items()}
        if isinstance(o, list):
            return [walk(v) for v in o]
        return o
    return json.dumps(walk(json.loads(text)), sort_keys=True, separators=(",", ":"))


def source_sha256() -> str:
    files = sorted(
        [*(ROOT / "cloudrun" / "coffeegrindsize_core").glob("*.py"),
         ROOT / "cloudrun" / "main.py", ROOT / "tests" / "synth.py", ROOT / "tests" / "gt.py",
         pathlib.Path(__file__).resolve()],
        key=lambda p: p.relative_to(ROOT).as_posix(),
    )
    h = hashlib.sha256()
    for p in files:
        h.update(p.relative_to(ROOT).as_posix().encode() + b"\0")
        h.update(p.read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


# ---------------------------------------------------------------------------
# core cases
# ---------------------------------------------------------------------------

def _ties(values: np.ndarray, weights: np.ndarray) -> bool:
    """True if any equal values carry unequal weights (numpy's unstable sort may order them differently)."""
    uniq, inv, counts = np.unique(values, return_inverse=True, return_counts=True)
    hi = np.full(uniq.size, -np.inf)
    lo = np.full(uniq.size, np.inf)
    np.maximum.at(hi, inv, weights)
    np.minimum.at(lo, inv, weights)
    return bool(np.any((counts > 1) & (hi != lo)))


def _stable_percentiles(values, weights, percentiles):
    """coffeegrindsize_core.stats.weighted_percentiles with a *stable* sort (what the JS port does)."""
    order = np.argsort(values, kind="stable")
    sv = values[order]
    cum = np.cumsum(weights[order])
    pos = (cum - 0.5 * weights[order]) / cum[-1] * 100.0
    return [float(np.interp(p, pos, sv)) for p in percentiles]


def tie_flags(ds) -> dict:
    """Which summary keys depend on numpy's unstable argsort order of equal diameters.

    ``stable`` (only when a flag is set) holds those keys recomputed with a stable sort, which is the
    order the JS port uses; the JS test checks them tightly and the Python values loosely.
    """
    from coffeegrindsize_core import filter_by_min_diameter
    flags = {"dv": False, "number": False}
    if ds.nclusters == 0 or ds.pixel_scale is None:
        return flags
    scale = float(ds.pixel_scale)
    fds = filter_by_min_diameter(ds, scale, (ds.meta or {}).get("min_diameter_um"))
    if fds.nclusters == 0:
        return flags
    d = 2.0 * np.sqrt(fds.long_axes * fds.short_axes) / scale
    ew = fds.edge_weights
    vw = (np.pi / 6.0) * d ** 3 * ew
    flags["dv"] = _ties(d, vw)
    flags["number"] = _ties(d, ew)
    if flags["dv"] or flags["number"]:
        dv10, dv50, dv90 = _stable_percentiles(d, vw, (10.0, 50.0, 90.0))
        flags["stable"] = {
            "dv10_mm": dv10, "dv50_mm": dv50, "dv90_mm": dv90,
            "span": (dv90 - dv10) / dv50 if dv50 > 0 else None,
            "diameter_number_median_mm": _stable_percentiles(d, ew, (50.0,))[0],
        }
    return flags


def capture_flatten(blue, polygon_mask, pct):
    """Run flatten_blue and capture the final polynomial coefficients (not returned by the core)."""
    from coffeegrindsize_core import background
    captured = []
    real = np.linalg.solve

    def spy(a, b):
        out = real(a, b)
        captured.append(np.array(out, dtype=np.float64))
        return out

    with mock.patch.object(np.linalg, "solve", spy):
        out, info = background.flatten_blue(blue, polygon_mask, pct)
    coef = captured[-1] if info.get("applied") and captured else None
    return out, {
        "applied": bool(info.get("applied")),
        "coef": None if coef is None else coef.tolist(),
        "reference_level": info.get("reference_level"),
        "n_fit_points": info.get("n_fit_points"),
    }


def run_core(rgb: np.ndarray, preset: str, overrides: dict) -> dict:
    from coffeegrindsize_core import (AnalysisSettings, analyze_image, cluster_center_mask,
                                      cluster_outline_mask, summarize_dataset)
    from coffeegrindsize_core import analysis as an

    settings_kwargs = dict(overrides)
    if settings_kwargs.get("analysis_polygon") is not None:
        settings_kwargs["analysis_polygon"] = [tuple(p) for p in settings_kwargs["analysis_polygon"]]
    settings = AnalysisSettings.legacy(**settings_kwargs) if preset == "legacy" else AnalysisSettings(**settings_kwargs)
    res = analyze_image(Image.fromarray(rgb), settings)
    blue = np.ascontiguousarray(rgb[:, :, 2])
    h, w = blue.shape
    polygon_mask = an._build_polygon_mask(blue.shape, settings.analysis_polygon)

    if settings.background_model == "poly4":
        flat_blue, flatten = capture_flatten(blue, polygon_mask, settings.threshold_percent)
        assert np.array_equal(flat_blue, res.blue_channel), "flatten_blue is not reproducible"
    else:
        flatten = {"applied": False, "coef": None, "reference_level": None, "n_fit_points": None}
    flatten["blue_hash"] = fnv_bytes(res.blue_channel)

    ds = res.dataset
    cols = {k: [] for k in ("cluster_id", "surface", "roundness", "short_axis", "long_axis", "volume",
                            "xmean", "ymean", "edge_weight", "n_px", "px_hash")}
    px_all = []
    for c in ds.clusters:
        lin = np.sort(np.asarray(c.x_pixels, dtype=np.int64) * w + np.asarray(c.y_pixels, dtype=np.int64))
        cols["cluster_id"].append(int(c.cluster_id))
        for k in ("surface", "roundness", "short_axis", "long_axis", "volume", "xmean", "ymean", "edge_weight"):
            cols[k].append(float(getattr(c, k)))
        cols["n_px"].append(int(lin.size))
        cols["px_hash"].append(fnv_u32(lin))
        px_all.append(lin.astype("<i4"))

    index = cluster_outline_mask(blue.shape, ds.clusters).astype(np.uint8)
    index[cluster_center_mask(blue.shape, ds.clusters)] = 2
    cluster_layer = {"index_hash": fnv_bytes(index), "n1": int((index == 1).sum()), "n2": int((index == 2).sum())}

    summary = None
    if ds.nclusters > 0 and ds.pixel_scale is not None:
        try:
            summary = summarize_dataset(ds)
        except ValueError:
            summary = None

    expected = {
        "polygon_mask": None if polygon_mask is None else mask_info(polygon_mask),
        "flatten": flatten,
        "background_median": float(res.background_median),
        "threshold_percent_used": float(res.threshold_percent_used),
        "model_info": res.model_info,
        "threshold_mask": mask_info(res.threshold_mask),
        "clusters": cols,
        "cluster_layer": cluster_layer,
        "summary": summary,
        "tie_sensitive": tie_flags(ds),
    }
    if blue.size <= 64 * 1024:
        expected["px_b64z"] = b64z(np.concatenate(px_all) if px_all else np.zeros(0, "<i4"))
    return {
        "kind": "core", "preset": preset, "settings": settings_kwargs_json(overrides),
        "height": int(h), "width": int(w), "blue_b64z": b64z(blue), "blue_hash": fnv_bytes(blue),
        "expected": expected,
    }


def settings_kwargs_json(overrides: dict) -> dict:
    out = dict(overrides)
    if out.get("analysis_polygon") is not None:
        out["analysis_polygon"] = [[float(x), float(y)] for x, y in out["analysis_polygon"]]
    return out


LEGACY_POLY = {1, 3, 5, 8, 10, 13, 15}


def legacy_case(i: int) -> dict:
    from tests.synth import crisp_ellipses, soft_field
    seed = 1000 + i
    rng = np.random.default_rng(seed)
    w, h = int(rng.integers(80, 221)), int(rng.integers(80, 221))
    kind = int(rng.integers(0, 4))
    n = int(w * h / [400, 80, 40, 25][kind])
    if i == 15:  # crisp, well separated ellipses
        specs = []
        for r in range(3):
            for c in range(4):
                a = float(rng.uniform(4, 12))
                specs.append((25 + c * 55 + float(rng.uniform(-5, 5)), 30 + r * 55 + float(rng.uniform(-5, 5)),
                              a, a * float(rng.uniform(0.6, 1.0)), float(rng.uniform(0, np.pi))))
        pil, _ = crisp_ellipses(220, 180, specs, noise=2.0, seed=seed)
        w, h = 220, 180
        img = np.array(pil).astype(float)
    else:
        img = np.array(soft_field(w, h, n, seed=seed)).astype(float)
    if rng.random() < 0.25:
        img *= rng.uniform(0.4, 0.8)
    img = np.clip(img + rng.normal(0, rng.uniform(0, 8), img.shape), 0, 255).astype(np.uint8)
    ov = dict(
        threshold_percent=float(rng.uniform(40, 85)),
        reference_threshold=float(rng.uniform(0.05, 0.95)),
        max_cost=float(rng.uniform(0.05, 1.0)),
        smoothing_window=int(rng.integers(1, 6)),
        max_cluster_axis=float(rng.choice([10, 30, 60, 100])),
        min_surface=float(rng.choice([1, 3, 5, 10])),
        quick_mode=bool(rng.random() < 0.3),
    )
    poly = None
    if i in LEGACY_POLY:
        poly = [(float(rng.uniform(0, w * 0.3)), float(rng.uniform(0, h * 0.3))),
                (float(rng.uniform(w * 0.7, w)), float(rng.uniform(0, h * 0.3))),
                (float(rng.uniform(w * 0.6, w)), float(rng.uniform(h * 0.7, h))),
                (float(rng.uniform(0, w * 0.4)), float(rng.uniform(h * 0.6, h)))]
    if i == 0:  # cover every smoothing/quick combination at the extremes
        ov.update(quick_mode=False, smoothing_window=1, max_cluster_axis=100.0, min_surface=1.0)
    if i == 1:
        ov.update(quick_mode=True, smoothing_window=5)
    ov["analysis_polygon"] = poly
    ov["pixel_scale"] = None if i == 14 else 20.0
    if i in (2, 9):
        ov["min_roundness"] = 0.3
    if i in (4, 11):
        ov["axis_method"] = "moments"
    if i == 12:
        ov["volume_model"] = "spheroid"
    if i in (6, 13):  # 6: rectangle (no polygon); 13: polygon
        ov["edge_correction"] = True
    if i == 3:
        ov["reference_px_length"] = 400.0
        ov["click_sigma_px"] = 2.0
    if i == 7:
        ov["min_diameter_um"] = 150.0
    out = run_core(img, "legacy", ov)
    return out


MODERN = {
    # name: (W, H, n_particles, diameter range, polygon, overrides)
    0: dict(W=300, H=240, n=30, d=(14, 40)),
    1: dict(W=300, H=240, n=28, d=(6, 12), big=4, fallback=True),
    2: dict(W=480, H=360, n=60, d=(12, 40)),
    3: dict(W=360, H=280, n=36, d=(12, 40), poly=4),
    4: dict(W=420, H=320, n=48, d=(12, 40), poly=5, ps=25.0),
    5: dict(W=320, H=260, n=32, d=(14, 40), ov=dict(background_model="global"), ps=None),
    6: dict(W=340, H=260, n=34, d=(14, 40), ov=dict(threshold_mode="fixed")),
    7: dict(W=400, H=300, n=44, d=(12, 40), ov=dict(min_diameter_um=600.0, reference_px_length=250.0, axis_method="moments")),
}


def modern_case(i: int) -> dict:
    from tests import gt
    spec = MODERN[i]
    W, H = spec["W"], spec["H"]
    seed = 2000 + i
    rng = np.random.default_rng(seed)
    diams = list(rng.uniform(*spec["d"], size=spec["n"]))
    if spec.get("big"):
        diams += list(rng.uniform(30, 36, size=spec["big"]))
    parts = gt.place(W, H, diams, seed=seed, margin=6)
    rgb, _ = gt.render(W, H, parts, vignette=0.3, gradient=0.2, seed=seed)
    ov: dict = {"pixel_scale": spec.get("ps", 25.0)}
    ov.update(spec.get("ov", {}))
    if "poly" in spec:
        k = spec["poly"]
        base = [(0.10, 0.12), (0.90, 0.08), (0.93, 0.55), (0.80, 0.92), (0.12, 0.85)][:k] if k == 5 else \
               [(0.10, 0.12), (0.90, 0.08), (0.85, 0.90), (0.12, 0.85)]
        ov["analysis_polygon"] = [(round(W * x + float(rng.uniform(-3, 3)), 3), round(H * y + float(rng.uniform(-3, 3)), 3))
                                  for x, y in base]
    out = run_core(rgb, "modern", ov)
    n_contrast = out["expected"]["model_info"].get("n_contrast_clusters")
    if n_contrast is not None:
        assert (n_contrast < 10) == bool(spec.get("fallback")), f"modern_{i:02d}: n_contrast_clusters={n_contrast}"
    return out


# ---------------------------------------------------------------------------
# API cases (real FastAPI app through TestClient)
# ---------------------------------------------------------------------------

_client = None


def get_client():
    global _client
    if _client is None:
        from fastapi.testclient import TestClient
        import main  # cloudrun/main.py
        _client = TestClient(main.app)
        _client.__enter__()
    return _client


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def layer_summary(b64: str) -> dict:
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    assert img.mode == "P", img.mode
    idx = np.array(img, dtype=np.uint8)
    return {"index_hash": fnv_bytes(idx), "n1": int((idx == 1).sum()), "n2": int((idx == 2).sum())}


LEGACY_FIELDS = dict(background_model="global", threshold_mode="fixed", edge_correction=False,
                     axis_method="max_radius", volume_model="legacy")


def _record(client, steps, op, path, body, ref=None):
    """POST ``body`` (image_id already resolved); store the request with placeholders + cleaned response."""
    r = client.post(path, json=body)
    shown = dict(body)
    if "image_id" in shown:
        shown["image_id"] = f"$step:{ref}" if ref is not None else "$image"
    step = {"op": op, "body": shown}
    if r.status_code != 200:
        step["expect"] = {"status": r.status_code, "detail": r.json().get("detail")}
    else:
        step["response"] = r.json()
    steps.append(step)
    return r


def api_case(i: int) -> dict:
    from tests import gt
    from tests.synth import soft_field
    client = get_client()
    seed = 3000 + i
    if i == 0:
        W, H = 400, 300
        img = soft_field(W, H, 600, seed=seed)
        ref_pts, ref_mm = [[40, 40], [340, 40]], 15.0     # 20 px/mm
        poly = None
        scale_pct, model = 100, dict(LEGACY_FIELDS)
        extra = dict(max_cost=0.35)
    else:
        W, H = (500, 380) if i == 1 else (450, 340)
        rng = np.random.default_rng(seed)
        parts = gt.place(W, H, list(rng.uniform(12, 40, size=44)), seed=seed, margin=6)
        rgb, _ = gt.render(W, H, parts, vignette=0.3, gradient=0.2, seed=seed)
        img = Image.fromarray(rgb)
        ref_pts, ref_mm = [[40, 40], [340, 40]], 3.0      # 100 px/mm
        poly = [[0.1 * W, 0.1 * H], [0.9 * W, 0.12 * H], [0.88 * W, 0.9 * H], [0.12 * W, 0.85 * H]] if i == 1 else None
        scale_pct, model = (60 if i == 1 else 35), {}
        extra = {}

    png = png_bytes(img)
    up = client.post("/upload", files={"file": ("x.png", png, "image/png")})
    assert up.status_code == 200, up.text
    uj = up.json()
    image_id = uj["image_id"]
    blue = np.array(Image.open(io.BytesIO(png)).convert("RGB"))[:, :, 2]
    steps: list = []
    ids: dict = {}   # step index -> analysis_id

    def analyze(**kw):
        body = {"image_id": image_id, "analysis_scale_pct": scale_pct, "reference_points": ref_pts,
                "reference_physical_mm": ref_mm, **model, **extra, **kw}
        if poly:
            body["polygon_points"] = poly
        r = _record(client, steps, "analyze", "/analyze", body)
        if r.status_code == 200:
            ids[len(steps) - 1] = r.json()["analysis_id"]
        return len(steps) - 1

    def post(op, path, ref, **kw):
        body = {"image_id": ids[ref], **kw}
        return _record(client, steps, op, path, body, ref=ref)

    a0 = analyze()
    if i == 0:
        # error step: reference points closer than 2 px
        _record(client, steps, "analyze", "/analyze",
                {"image_id": image_id, "reference_points": [[0, 0], [1, 0]], "reference_physical_mm": 10})
    r = post("erase", "/erase", a0, erase_points=[[120, 90], [250, 160]], erase_radius_px=30.0)
    removed = r.json()["removed_ids"]
    assert removed, "erase removed nothing; pick other points"
    if i == 1:  # second erase carrying the earlier removals
        post("erase", "/erase", a0, erase_points=[[300, 200]], erase_radius_px=40.0, already_removed_ids=removed)
        removed = steps[-1]["response"]["removed_ids"]
    a1 = analyze(threshold_percent=70.0 if i == 0 else 62.0)

    hist_bodies = {
        0: [dict(weight_mode="number", x_log=True), dict(weight_mode="mass", x_log=False, bins=25),
            dict(weight_mode="number", x_log=True, removed_cluster_ids=removed)],
        1: [dict(weight_mode="mass", x_log=False, bins=25), dict(x_metric="volume", weight_mode="available_mass"),
            dict(weight_mode="number", x_log=True, removed_cluster_ids=removed)],
        2: [dict(weight_mode="surface", x_log=True, min_diameter_um=150),
            dict(x_metric="extraction_yield", weight_mode="extracted_mass", x_log=False),
            dict(x_metric="surface", weight_mode="number", x_log=True)],
    }[i]
    for hb in hist_bodies:
        post("histogram", "/histogram", a0, include_png=False, **hb)
    if i == 2:  # error step: nothing above a huge cutoff
        post("histogram", "/histogram", a0, include_png=False, min_diameter_um=100000)

    extras = [{}, dict(min_diameter_um=150, weight_mode="mass", x_log=False, bins=30)] if i == 2 else [{}]
    for rb in extras:
        runs = [{"image_id": ids[a0], "removed_cluster_ids": removed, "label": "Run A"},
                {"image_id": ids[a1], "removed_cluster_ids": [], "label": ""}]
        r = client.post("/histogram/compare", json={"runs": runs, "include_png": False, **rb})
        assert r.status_code == 200, r.text
        shown = [dict(run, image_id=f"$step:{ref}") for run, ref in zip(runs, (a0, a1))]
        steps.append({"op": "compare", "body": {"runs": shown, "include_png": False, **rb}, "response": r.json()})

    # --- normalise responses: drop PNG payloads / ids, hash the index layers ---
    for step in steps:
        resp = step.get("response")
        if not resp:
            continue
        resp.pop("histogram_b64", None)
        resp.pop("analysis_id", None)
        for key in ("threshold_layer_b64", "cluster_layer_b64"):
            if key in resp:
                resp[key[:-4]] = layer_summary(resp.pop(key))
    return {
        "kind": "api", "height": int(blue.shape[0]), "width": int(blue.shape[1]),
        "blue_b64z": b64z(blue), "blue_hash": fnv_bytes(blue),
        "upload": {"width": uj["width"], "height": uj["height"], "reference_objects": uj["reference_objects"]},
        "steps": steps,
    }


# ---------------------------------------------------------------------------
# resize cases
# ---------------------------------------------------------------------------

RESIZE = [(101, 77, 0.37), (640, 480, 0.5), (333, 251, 0.6), (200, 150, 0.93), (257, 129, 0.5), (640, 480, 0.93)]


def resize_case(i: int) -> dict:
    from tests.synth import crisp_ellipses, soft_field
    w, h, s = RESIZE[i]
    if w * h > 100_000:  # big sources: crisp, noiseless ellipses (hard edges, and they deflate well)
        rng = np.random.default_rng(4000 + i)
        specs = [(float(rng.uniform(0, w)), float(rng.uniform(0, h)), float(rng.uniform(3, 30)),
                  float(rng.uniform(3, 30)), float(rng.uniform(0, np.pi))) for _ in range(40)]
        rgb = np.array(crisp_ellipses(w, h, specs, ink=int(rng.integers(30, 90)), vignette=60.0)[0])
    else:
        rgb = np.array(soft_field(w, h, max(20, w * h // 60), seed=4000 + i))
    blue = np.ascontiguousarray(rgb[:, :, 2])
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))   # main.analyze rounding
    lanczos = Image.Resampling.LANCZOS
    out = np.array(Image.fromarray(blue, mode="L").resize((nw, nh), resample=lanczos))
    # main.py resizes the RGB image; channels are independent so blue alone is identical
    assert np.array_equal(np.array(Image.fromarray(rgb).resize((nw, nh), resample=lanczos))[:, :, 2], out)
    return {"kind": "resize", "src_width": w, "src_height": h, "width": nw, "height": nh, "scale": s,
            "src_b64z": b64z(blue), "expected_b64z": b64z(out)}


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------

def case_names() -> list[str]:
    return ([f"core_legacy_{i:02d}" for i in range(16)] + [f"core_modern_{i:02d}" for i in range(8)]
            + [f"api_{i:02d}" for i in range(3)] + [f"resize_{i:02d}" for i in range(len(RESIZE))])


def build_case(name: str) -> str:
    kind, _, rest = name.partition("_")
    if name.startswith("core_legacy_"):
        payload = legacy_case(int(name[-2:]))
    elif name.startswith("core_modern_"):
        payload = modern_case(int(name[-2:]))
    elif name.startswith("api_"):
        payload = api_case(int(name[-2:]))
    elif name.startswith("resize_"):
        payload = resize_case(int(name[-2:]))
    else:
        raise KeyError(name)
    return dumps({"name": name, **payload})


def write_all() -> None:
    import numba
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for old in FIXTURE_DIR.glob("*.json"):
        old.unlink()
    shas, total = {}, 0
    for name in case_names():
        text = build_case(name)
        (FIXTURE_DIR / f"{name}.json").write_text(text, encoding="utf-8", newline="\n")
        shas[name] = hashlib.sha256(text.encode()).hexdigest()
        total += len(text.encode())
        print(f"  {name}: {len(text) / 1024:.0f} KB")
    manifest = dumps({"numpy": np.__version__, "pillow": Image.__version__, "numba": numba.__version__,
                      "source_sha256": source_sha256(), "cases": shas})
    (FIXTURE_DIR / "manifest.json").write_text(manifest, encoding="utf-8", newline="\n")
    total += len(manifest)
    assert total < BUDGET_BYTES, f"fixtures total {total} bytes exceeds the {BUDGET_BYTES} byte budget"
    print(f"wrote {len(shas)} cases, {total / 1024:.0f} KB total")


def check() -> list[str]:
    """Return a list of problems (empty = fixtures are in sync with the Python sources)."""
    problems = []
    mpath = FIXTURE_DIR / "manifest.json"
    if not mpath.exists():
        return [f"{mpath} is missing; run `{REGEN_COMMAND}`"]
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    if manifest["source_sha256"] != source_sha256():
        problems.append(f"Python sources changed since the fixtures were exported; run `{REGEN_COMMAND}`")
    for name, sha in manifest["cases"].items():
        f = FIXTURE_DIR / f"{name}.json"
        if not f.exists() or hashlib.sha256(f.read_bytes()).hexdigest() != sha:
            problems.append(f"{name}.json does not match the manifest; run `{REGEN_COMMAND}`")
    if set(manifest["cases"]) != set(case_names()):
        problems.append(f"manifest case list is stale; run `{REGEN_COMMAND}`")
    for name in STABLE_CASES:
        f = FIXTURE_DIR / f"{name}.json"
        if f.exists() and canonical(build_case(name)) != canonical(f.read_text(encoding="utf-8")):
            problems.append(f"{name}.json differs from a fresh export; run `{REGEN_COMMAND}`")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="verify the committed fixtures instead of writing")
    args = ap.parse_args()
    if args.check:
        problems = check()
        for p in problems:
            print("DRIFT:", p)
        print("fixtures in sync" if not problems else f"{len(problems)} problem(s)")
        return 1 if problems else 0
    write_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
