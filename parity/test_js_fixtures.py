"""Drift test for the JS parity fixtures (React/frontend/src/analysis/__fixtures__).

Run in CI with ``pytest -m "" parity``. If it fails, regenerate and commit the fixtures:

    python parity/export_js_fixtures.py
"""
import hashlib
import json
import math

import pytest

import export_js_fixtures as ex

REGEN = f"regenerate with `{ex.REGEN_COMMAND}` and commit the fixtures"


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


# numpy picks its SIMD math kernels (sum, log, exp, power) by CPU at runtime, so the last bit of a
# float can differ between an AVX-512 runner and an AVX2 one. Floats are compared within this relative
# tolerance; everything else (ints, strings, structure, inflated image bytes) must be identical.
FLOAT_REL_TOL = 1e-12


def _diff(a, b, path="$"):
    """First difference between two decoded fixtures, or None."""
    if isinstance(a, float) or isinstance(b, float):
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
            if a == b or math.isclose(a, b, rel_tol=FLOAT_REL_TOL, abs_tol=1e-300):
                return None
        return f"{path}: {a!r} != {b!r}"
    if type(a) is not type(b):
        return f"{path}: type {type(a).__name__} != {type(b).__name__}"
    if isinstance(a, dict):
        if a.keys() != b.keys():
            return f"{path}: keys differ: {sorted(set(a) ^ set(b))}"
        for k in a:
            d = _diff(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: length {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = _diff(x, y, f"{path}[{i}]")
            if d:
                return d
        return None
    return None if a == b else f"{path}: {a!r} != {b!r}"


def test_float_tolerance_catches_real_drift():
    assert _diff({"x": 1.8606303193536122}, {"x": 1.8606303193536127}) is None
    assert _diff({"x": 1.86063031935}, {"x": 1.86063031936}) is not None
    assert _diff({"n": 3}, {"n": 4}) is not None
    assert _diff({"h": "ab"}, {"h": "ac"}) is not None


@pytest.mark.parametrize("name", ex.STABLE_CASES)
def test_stable_cases_rebuild_identically(name):
    """CPU-independent cases (no poly4 fit): a fresh export must equal the committed file.

    Compared via ex.canonical(): the zlib payloads are compared by their inflated bytes, because
    compressed output can differ between zlib builds; floats within FLOAT_REL_TOL (see above).
    """
    committed = (ex.FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8")
    fresh = json.loads(ex.canonical(ex.build_case(name)))
    diff = _diff(fresh, json.loads(ex.canonical(committed)))
    assert diff is None, f"{name} drifted ({diff}): " + REGEN
