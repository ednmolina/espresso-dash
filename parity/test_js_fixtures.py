"""Drift test for the JS parity fixtures (React/frontend/src/analysis/__fixtures__).

Run in CI with ``pytest -m "" parity``. If it fails, regenerate and commit the fixtures:

    python parity/export_js_fixtures.py
"""
import hashlib
import json

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


@pytest.mark.parametrize("name", ex.STABLE_CASES)
def test_stable_cases_rebuild_identically(name):
    """CPU-independent cases (no poly4 fit): a fresh export must equal the committed file.

    Compared via ex.canonical(): identical JSON with the zlib payloads compared by their inflated
    bytes, because compressed output can differ between zlib builds.
    """
    committed = (ex.FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8")
    assert ex.canonical(ex.build_case(name)) == ex.canonical(committed), f"{name} drifted: " + REGEN
