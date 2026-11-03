"""Lock the numba implementation to the pure-NumPy golden reference (e299811, stable sorts).

Exact equality (tolerance 0) of every cluster: id, surface, roundness, long/short axis,
volume, centroid and the sorted pixel set. Settings use the legacy preset.
Fast tier: 30 seeds. Slow tier (`-m slow`): 300 seeds + large images.
"""
from __future__ import annotations

import dataclasses
import time

import numpy as np
import pytest

from coffeegrindsize_core import _kernels
from coffeegrindsize_core import analysis as new
from tests.helpers import legacy_settings
from tests.reference import analysis_e299811_stable as ref
from tests.synth import soft_field

pytestmark = pytest.mark.usefixtures("legacy_polygon_edges")

FAST_SEEDS = list(range(30))
SLOW_SEEDS = list(range(30, 330))


def cluster_key(c):
    px = sorted(zip(np.asarray(c.x_pixels).tolist(), np.asarray(c.y_pixels).tolist()))
    return (int(c.cluster_id), float(c.surface), float(c.roundness), float(c.long_axis),
            float(c.short_axis), float(c.volume), float(c.xmean), float(c.ymean), tuple(px))


def keys(clusters):
    return [cluster_key(c) for c in clusters]


def make_case(seed):
    rng = np.random.default_rng(seed)
    w, h = int(rng.integers(80, 220)), int(rng.integers(80, 220))
    kind = int(rng.integers(0, 4))
    n = int(w * h / [400, 80, 40, 25][kind])
    img = np.array(soft_field(w, h, n, seed=seed)).astype(float)
    if rng.random() < 0.25:
        img *= rng.uniform(0.4, 0.8)
    img = np.clip(img + rng.normal(0, rng.uniform(0, 8), img.shape), 0, 255).astype(np.uint8)
    params = dict(
        threshold_percent=float(rng.uniform(40, 85)),
        reference_threshold=float(rng.uniform(0.05, 0.95)),
        max_cost=float(rng.uniform(0.05, 1.0)),
        smoothing_window=int(rng.integers(1, 6)),
        max_cluster_axis=float(rng.choice([10, 30, 60, 100])),
        min_surface=float(rng.choice([1, 3, 5, 10])),
        quick_mode=bool(rng.random() < 0.3),
    )
    poly = None
    if rng.random() < 0.4:
        poly = [(float(rng.uniform(0, w * 0.3)), float(rng.uniform(0, h * 0.3))),
                (float(rng.uniform(w * 0.7, w)), float(rng.uniform(0, h * 0.3))),
                (float(rng.uniform(w * 0.6, w)), float(rng.uniform(h * 0.7, h))),
                (float(rng.uniform(0, w * 0.4)), float(rng.uniform(h * 0.6, h)))]
    return img, params, poly


def check_seed(seed):
    img, params, poly = make_case(seed)
    blue = img[:, :, 2]
    pm_ref = ref._build_polygon_mask(blue.shape, poly)
    pm_new = new._build_polygon_mask(blue.shape, poly)
    if poly is not None:
        assert int((pm_ref != pm_new).sum()) == 0, "polygon mask differs from matplotlib"
    bg = ref._background_median(blue, pm_ref)
    assert new._background_median(blue, pm_new) == pytest.approx(bg, abs=1e-9)
    tm = blue < bg * params["threshold_percent"] / 100.0
    if pm_ref is not None:
        tm &= pm_ref
    s_ref = ref.AnalysisSettings(analysis_polygon=poly, **params)
    s_new = legacy_settings(analysis_polygon=poly, **params)
    c_ref = ref._detect_particles(blue, tm, bg, s_ref, pm_ref)
    c_new = new._detect_particles(blue, tm, bg, s_new, pm_new)
    k_ref, k_new = keys(c_ref), keys(c_new)
    if k_ref != k_new:
        a, b = set(k_ref), set(k_new)
        pytest.fail(f"seed {seed}: ref={len(k_ref)} new={len(k_new)} common={len(a & b)} "
                    f"params={params} poly={poly is not None}")


@pytest.mark.parametrize("seed", FAST_SEEDS)
def test_detect_particles_parity_fast(seed):
    check_seed(seed)


@pytest.mark.slow
@pytest.mark.parametrize("seed", SLOW_SEEDS)
def test_detect_particles_parity_slow(seed):
    check_seed(seed)


E2E_CASES = [  # (w, h, n, seed, quick, polygon)
    pytest.param(300, 300, 160, 1, False, False, id="300-full"),
    pytest.param(300, 300, 160, 2, True, False, id="300-quick"),
    pytest.param(400, 300, 220, 3, False, True, id="400-poly"),
    pytest.param(600, 450, 500, 4, False, False, id="600-full", marks=pytest.mark.slow),
    pytest.param(600, 450, 500, 5, True, True, id="600-quick-poly", marks=pytest.mark.slow),
    pytest.param(1200, 900, 1800, 6, False, True, id="1200-poly", marks=pytest.mark.slow),
]


@pytest.mark.parametrize("w,h,n,seed,quick,poly", E2E_CASES)
def test_analyze_image_matches_reference(w, h, n, seed, quick, poly):
    img = soft_field(w, h, n, seed)
    polygon = [(30.37, 20.61), (w - 35.2, 40.13), (w - 50.71, h - 30.4), (45.9, h - 45.27)] if poly else None
    kw = dict(quick_mode=quick, analysis_polygon=polygon, pixel_scale=20.0)
    t0 = time.perf_counter()
    r_ref = ref.analyze_image(img, ref.AnalysisSettings(**kw))
    t1 = time.perf_counter()
    r_new = new.analyze_image(img, legacy_settings(**kw))
    t2 = time.perf_counter()
    print(f"ref={t1 - t0:.2f}s new={t2 - t1:.2f}s n={r_ref.dataset.nclusters}")
    assert r_ref.dataset.nclusters >= 20
    assert r_new.background_median == pytest.approx(r_ref.background_median, abs=1e-9)
    np.testing.assert_array_equal(r_new.threshold_mask, r_ref.threshold_mask)
    assert keys(r_new.dataset.clusters) == keys(r_ref.dataset.clusters)


# ---- building blocks --------------------------------------------------------------

def _poly_cases():
    rng = np.random.default_rng(11)
    out = []
    for i in range(60):
        k = int(rng.integers(3, 7))
        kind = i % 3
        if kind == 0:
            pts = rng.integers(0, 60, (k, 2)).astype(float)          # integer vertices
        elif kind == 1:
            pts = rng.integers(0, 120, (k, 2)) / 2.0                 # half-integer
        else:
            pts = rng.uniform(0, 60, (k, 2))                         # float, often self-intersecting
        out.append(pts.tolist())
    out.append([(5, 5), (50, 5), (50, 40), (5, 40)])                 # axis-aligned integer rectangle
    out.append([(5, 5), (50, 40), (50, 5), (5, 40)])                 # bow-tie
    return out


@pytest.mark.parametrize("poly", _poly_cases())
def test_polygon_mask_equals_matplotlib(poly):
    shape = (50, 60)
    expected = ref._build_polygon_mask(shape, poly)
    got = new._build_polygon_mask(shape, poly)
    assert got.shape == expected.shape
    assert int((got != expected).sum()) == 0


@pytest.mark.parametrize("window", [1, 2, 3, 4, 5, 9])
def test_smoothed_max_matches_convolve(window):
    """Perf spec: ascending-order summation => bit-identical to np.convolve (was 23% ulp diffs)."""
    if not hasattr(_kernels, "_smoothed_max"):
        pytest.skip("kernel absent")
    rng = np.random.default_rng(window)
    for n in (window + 1, 40, 400):
        v = rng.uniform(0, 3, n)
        expected = float(np.max(ref._smooth(v, window) * window))
        assert float(_kernels._smoothed_max(v, window)) == expected


def test_median_matches_numpy():
    rng = np.random.default_rng(3)
    for shape in [(31, 40), (30, 40), (1, 1), (2, 1)]:
        blue = rng.integers(0, 256, shape).astype(np.uint8)
        assert new._background_median(blue, None) == ref._background_median(blue, None)
    blue = rng.integers(0, 256, (40, 50)).astype(np.uint8)
    pm = ref._build_polygon_mask(blue.shape, [(3.5, 3.5), (45.2, 6.5), (40.1, 35.5)])
    assert new._background_median(blue, pm) == ref._background_median(blue, pm)
