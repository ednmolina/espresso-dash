"""Drift + unit tests for the ellipse-fit (feature A) reference and its JS fixtures.

Run in CI with ``pytest -m "" parity``. If a drift test fails, regenerate and commit:

    python parity/export_ellipse_fixtures.py
"""
import hashlib
import json
import math

import numpy as np
import pytest
from PIL import Image

import ellipse_reference as ref
import export_ellipse_fixtures as ex

REGEN = f"regenerate with `{ex.REGEN_COMMAND}` and commit the fixtures"


# ---------------------------------------------------------------------------
# drift
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def manifest():
    path = ex.FIXTURE_DIR / "manifest.json"
    assert path.exists(), f"{path} is missing; {REGEN}"
    return json.loads(path.read_text(encoding="utf-8"))


def test_source_hash_matches(manifest):
    assert manifest["source_sha256"] == ex.source_sha256(), (
        "The Python sources the fixtures were exported from have changed: " + REGEN)


def test_case_list_and_file_hashes(manifest):
    assert set(manifest["cases"]) == set(ex.case_names()), "case list changed: " + REGEN
    for name, sha in manifest["cases"].items():
        data = (ex.FIXTURE_DIR / f"{name}.json").read_bytes()
        assert hashlib.sha256(data).hexdigest() == sha, f"{name}.json does not match the manifest: " + REGEN


def test_size_budget():
    total = sum(p.stat().st_size for p in ex.FIXTURE_DIR.glob("*.json"))
    assert total < ex.BUDGET_BYTES, f"fixtures are {total} bytes (budget {ex.BUDGET_BYTES})"


@pytest.mark.parametrize("name", ex.CASES)
def test_cases_rebuild_identically(name):
    """All cases are CPU independent (legacy settings, no poly4 fit): a fresh export must match."""
    committed = (ex.FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8")
    assert ex.base.canonical(ex.build_case(name)) == ex.base.canonical(committed), f"{name} drifted: " + REGEN


# ---------------------------------------------------------------------------
# reference behaviour
# ---------------------------------------------------------------------------

def _analyze(img, **ov):
    from coffeegrindsize_core import AnalysisSettings, analyze_image
    return analyze_image(img if isinstance(img, Image.Image) else Image.fromarray(img),
                         AnalysisSettings.legacy(**ov))


def test_aspect_ratio_matches_truth_on_crisp_ellipses():
    from tests.synth import crisp_ellipses
    img, truth = crisp_ellipses(320, 240, ex.crisp_specs(11), seed=21)
    ds = _analyze(img, pixel_scale=20.0).dataset
    _, _, aspect = ref.moment_axes(ds.clusters)
    assert ds.nclusters == len(truth)
    checked = 0
    for c, ar in zip(ds.clusters, aspect):
        # xmean is the mean row (y), ymean the mean column (x)
        t = min(truth, key=lambda p: (p.cx - c.ymean) ** 2 + (p.cy - c.xmean) ** 2)
        assert (t.cx - c.ymean) ** 2 + (t.cy - c.xmean) ** 2 < 4.0
        tol = 0.02 if t.b >= 10 else 0.05 if t.b >= 5 else None
        if tol is None:
            continue
        checked += 1
        assert abs(ar - t.a / t.b) <= tol * (t.a / t.b), f"b={t.b} a={t.a}: AR {ar} vs {t.a / t.b}"
    assert checked >= 12


def test_lambda1_is_identical_to_the_core_under_moments():
    from tests.synth import soft_field
    img = soft_field(200, 150, 200 * 150 // 60, seed=33)
    ds = _analyze(img, axis_method="moments", pixel_scale=20.0).dataset
    major, minor, aspect = ref.moment_axes(ds.clusters)
    assert np.array_equal(major, np.array([c.long_axis for c in ds.clusters]))
    assert np.all(aspect >= 1.0) and np.all(minor > 0)
    assert np.array_equal(aspect, major / minor)


def test_lambda2_floor_for_a_one_pixel_line():
    class Line:
        x_pixels = np.zeros(30, dtype=np.int64)
        y_pixels = np.arange(30, dtype=np.int64)

    major, minor, aspect = ref.moment_axes([Line()])
    assert minor[0] == 2.0 * math.sqrt(1.0 / 12.0)
    assert major[0] == pytest.approx(2.0 * math.sqrt((30**2 - 1) / 12.0 + 1.0 / 12.0), rel=1e-12)
    assert aspect[0] == major[0] / minor[0]


def test_ellipsoid_volume_of_a_disc():
    surfaces = np.array([50.0, 314.0])
    v = ref.ellipsoid_volumes(surfaces, np.array([1.0, 2.0]))
    for s, ar, got in zip(surfaces, (1.0, 2.0), v):
        assert got == (4.0 / 3.0 * s) * math.sqrt(s / (math.pi * ar))


def test_shape_summary_null_paths():
    from tests.synth import crisp_ellipses
    specs = [(20.0 + 30.0 * i, 30.0, 6.0, 5.0, 0.1 * i) for i in range(5)]
    img, _ = crisp_ellipses(200, 60, specs)
    ds = _analyze(img, pixel_scale=20.0).dataset
    major, minor, aspect = ref.moment_axes(ds.clusters)
    s = ref.shape_summary(ds, major, minor, aspect)
    assert s["aspect_ratio_n"] == 5 and s["aspect_ratio_median"] is None
