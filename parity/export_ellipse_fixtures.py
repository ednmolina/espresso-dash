#!/usr/bin/env python
"""Export numpy-reference results for the true ellipse fit (feature A) as JS parity fixtures.

    python parity/export_ellipse_fixtures.py            # (re)write the fixtures + manifest
    python parity/export_ellipse_fixtures.py --check    # fail if they drifted from the sources

Output: React/frontend/src/analysis/__fixtures_ellipse__/{manifest.json, ellipse_*.json}
(a sibling of ``__fixtures__``, so the existing parity budget/caseNames tests never see it).

Case format: ``{kind: 'ellipse', name, settings, height, width, blue_b64z, blue_hash, truth?, expected}``
(blue channel encoding as in export_js_fixtures.py).  Every case runs the core's
``analyze_image`` with ``AnalysisSettings.legacy(**settings)`` (global background, fixed threshold:
CPU independent) and then applies ``ellipse_reference``.  ``expected``:

    cluster_id, long_axis       the core's own values (long_axis: max radius, or moments)
    major, minor, aspect        full-precision floats (moment fit)
    volume_ellipsoid            ellipsoid volume of every cluster
    shape_summary               COMMON §3 (pixel_scale / min_diameter_um from ``settings``)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import export_js_fixtures as base  # noqa: E402  (sets up sys.path / env for cloudrun and tests)
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import ellipse_reference as ref  # noqa: E402

ROOT = base.ROOT
FIXTURE_DIR = ROOT / "React" / "frontend" / "src" / "analysis" / "__fixtures_ellipse__"
BUDGET_BYTES = 400 * 1024
REGEN_COMMAND = "python parity/export_ellipse_fixtures.py"
CASES = [
    "ellipse_crisp",
    "ellipse_crisp_noise",
    "ellipse_soft",
    "ellipse_soft_mindiam",
    "ellipse_soft_moments",
    "ellipse_tiny",
]


def source_sha256() -> str:
    files = sorted(
        [*(ROOT / "cloudrun" / "coffeegrindsize_core").glob("*.py"),
         ROOT / "tests" / "synth.py",
         HERE / "ellipse_reference.py", pathlib.Path(__file__).resolve()],
        key=lambda p: p.relative_to(ROOT).as_posix(),
    )
    h = hashlib.sha256()
    for p in files:
        h.update(p.relative_to(ROOT).as_posix().encode() + b"\0")
        h.update(p.read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


def case_names() -> list[str]:
    return list(CASES)


# ---------------------------------------------------------------------------

def run_case(rgb: np.ndarray, overrides: dict, truth=None) -> dict:
    from coffeegrindsize_core import AnalysisSettings, analyze_image

    settings = AnalysisSettings.legacy(**overrides)
    res = analyze_image(Image.fromarray(rgb), settings)
    ds = res.dataset
    blue = np.ascontiguousarray(rgb[:, :, 2])
    major, minor, aspect = ref.moment_axes(ds.clusters)
    surfaces = [c.surface for c in ds.clusters]
    out = {
        "kind": "ellipse",
        "settings": dict(overrides),
        "height": int(blue.shape[0]), "width": int(blue.shape[1]),
        "blue_b64z": base.b64z(blue), "blue_hash": base.fnv_bytes(blue),
        "expected": {
            "cluster_id": [int(c.cluster_id) for c in ds.clusters],
            "long_axis": [float(c.long_axis) for c in ds.clusters],
            "major": major, "minor": minor, "aspect": aspect,
            "volume_ellipsoid": ref.ellipsoid_volumes(surfaces, aspect),
            "shape_summary": ref.shape_summary(ds, major, minor, aspect),
        },
    }
    if truth is not None:
        out["truth"] = [{"cx": t.cx, "cy": t.cy, "a": t.a, "b": t.b, "theta": t.theta} for t in truth]
    return out


def crisp_specs(seed: int):
    """20 well separated ellipses on a 5x4 grid: AR 1 / 1.5 / 2.5 / 4 per row, several angles."""
    rng = np.random.default_rng(seed)
    b_by_row = [
        (1.0, [6.0, 9.0, 12.0, 16.0, 22.0]),
        (1.5, [6.0, 9.0, 12.0, 15.0, 18.0]),
        (2.5, [5.0, 7.0, 9.0, 10.0, 10.8]),
        (4.0, [4.0, 5.0, 6.0, 6.5, 6.75]),
    ]
    angles = [0.0, 0.4, 0.7, 1.0, 1.4]
    specs = []
    for i, (ar, bs) in enumerate(b_by_row):
        for j, b in enumerate(bs):
            cx = 32.0 + 64.0 * j + float(rng.uniform(-1.5, 1.5))
            cy = 30.0 + 60.0 * i + float(rng.uniform(-1.5, 1.5))
            specs.append((cx, cy, b * ar, b, angles[(i * 2 + j) % len(angles)]))
    return specs


def build_case(name: str) -> str:
    from tests.synth import crisp_ellipses, soft_field

    if name in ("ellipse_crisp", "ellipse_crisp_noise"):
        noise = 4.0 if name.endswith("noise") else 0.0
        img, truth = crisp_ellipses(320, 240, crisp_specs(11), noise=noise, seed=21)
        payload = run_case(np.array(img), {"pixel_scale": 20.0}, truth)
    elif name.startswith("ellipse_soft"):
        img = soft_field(200, 150, 200 * 150 // 60, seed=33)
        ov = {"pixel_scale": 20.0}
        if name == "ellipse_soft_mindiam":
            ov["min_diameter_um"] = 500.0
        if name == "ellipse_soft_moments":
            ov["axis_method"] = "moments"
        payload = run_case(np.array(img), ov)
    elif name == "ellipse_tiny":
        rng = np.random.default_rng(5)
        specs = []
        for i in range(24):  # sub-20 px particles on a jittered grid
            a = float(rng.uniform(1.6, 2.4))
            specs.append((15.0 + 25.0 * (i % 6) + float(rng.uniform(-3, 3)), 15.0 + 25.0 * (i // 6) + float(rng.uniform(-3, 3)),
                          a, a * float(rng.uniform(0.6, 1.0)), float(rng.uniform(0, np.pi))))
        for i in range(4):  # a few that qualify (>= 20 px), still fewer than 10
            specs.append((140.0 + 6.0 * i, 20.0 + 25.0 * i, 4.0, 3.0, 0.5 * i))
        specs = [s for s in specs if s[0] < 160 and s[1] < 100]
        img, _ = crisp_ellipses(160, 100, specs, noise=1.0, seed=7)
        payload = run_case(np.array(img), {"pixel_scale": 20.0})
        assert payload["expected"]["shape_summary"]["aspect_ratio_median"] is None, "tiny case must hit the null path"
        assert payload["expected"]["shape_summary"]["aspect_ratio_n"] > 0
    else:
        raise KeyError(name)
    return base.dumps({"name": name, **payload})


def write_all() -> None:
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
    manifest = base.dumps({"numpy": np.__version__, "source_sha256": source_sha256(), "cases": shas})
    (FIXTURE_DIR / "manifest.json").write_text(manifest, encoding="utf-8", newline="\n")
    total += len(manifest)
    assert total < BUDGET_BYTES, f"fixtures total {total} bytes exceeds the {BUDGET_BYTES} byte budget"
    print(f"wrote {len(shas)} cases, {total / 1024:.0f} KB total")


def check() -> list[str]:
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
