#!/usr/bin/env python
"""Export reference results for "separate touching particles" (feature B) as JS fixtures.

    python parity/export_split_fixtures.py            # (re)write the fixtures + manifest
    python parity/export_split_fixtures.py --check    # fail if they drifted from the sources

Output: React/frontend/src/analysis/__fixtures_split__/{manifest.json, split_*.json}
(a sibling of ``__fixtures__``, so the existing parity budget/caseNames tests never see it).

Case format: ``{kind: 'split', name, settings, neck_ratio, height, width, blue_b64z, blue_hash, expected}``
(blue channel encoding as in export_js_fixtures.py).  Every case runs the core's
``analyze_image`` with ``AnalysisSettings.legacy(**settings)`` (global background, fixed threshold:
CPU independent) and then applies ``split_reference``.  ``expected``:

    candidates   [{parent_id, solidity}]   clusters tested for a split (size + solidity filter)
    info         {neck_ratio, candidates, clusters_split, pieces_added, rejected_splits}
    clusters     the output clusters, in output order: cluster_id, surface, roundness, short_axis,
                 long_axis, volume, xmean, ymean, edge_weight, n_px, px_hash
    unsplit      {cluster_count, dv10_mm, dv50_mm, dv90_mm} computed on the parents (null: no scale)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import export_js_fixtures as base  # noqa: E402  (sets up sys.path / env for cloudrun and tests)
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import split_reference as ref  # noqa: E402

ROOT = base.ROOT
FIXTURE_DIR = ROOT / "React" / "frontend" / "src" / "analysis" / "__fixtures_split__"
BUDGET_BYTES = 400 * 1024
REGEN_COMMAND = "python parity/export_split_fixtures.py"
CASES = [
    "split_pairs",
    "split_chains",
    "split_bigsmall",
    "split_overlap",
    "split_convex",
    "split_dense",
    "split_overlap_r05",
    "split_minsurface",
]
# Cases whose rendered particles are known, so a test can check the true piece counts.
TRUTH_CASES = ["split_pairs", "split_chains", "split_bigsmall"]


def source_sha256() -> str:
    files = sorted(
        [*(ROOT / "cloudrun" / "coffeegrindsize_core").glob("*.py"),
         ROOT / "tests" / "synth.py", ROOT / "tests" / "gt.py",
         HERE / "split_reference.py", pathlib.Path(__file__).resolve()],
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
# images: parts are (cx, cy, a, b, theta) for tests.gt.render; `groups` lists the part indices of
# every object that is supposed to be separated into that many pieces (ground truth).
# ---------------------------------------------------------------------------

def _disc(cx, cy, r):
    return (cx, cy, float(r), float(r), 0.0)


def _pair(cx, cy, r1, r2, d, angle=0.0):
    """Two discs with centre distance d (tangent: d = r1 + r2), centred on (cx, cy), rotated."""
    ca, sa = math.cos(angle), math.sin(angle)
    ox, oy = -d / 2 * ca, -d / 2 * sa
    return [_disc(cx + ox, cy + oy, r1), _disc(cx - ox, cy - oy, r2)]


def parts_for(name: str):
    """(W, H, parts, groups, overrides, neck_ratio) of a case image."""
    ov: dict = {"pixel_scale": 20.0}
    neck = 0.7
    groups: list[list[int]] = []
    parts: list = []

    def add(group_parts):
        groups.append(list(range(len(parts), len(parts) + len(group_parts))))
        parts.extend(group_parts)

    if name == "split_pairs":
        W, H = 300, 130
        for i, r in enumerate([6, 8, 10, 12]):
            add(_pair(40 + 70 * i, 35, r, r, 2 * r))
        add(_pair(40, 95, 14, 14, 28))
        add(_pair(125, 95, 9, 9, 18, angle=0.5))      # slanted
        add(_pair(210, 95, 7, 10, 17, angle=1.2))     # unequal, slanted
    elif name == "split_chains":
        W, H = 300, 130
        add([_disc(30, 30, 7), _disc(44, 30, 7), _disc(58, 30, 7)])
        add([_disc(110, 30, 9), _disc(128, 30, 9), _disc(146, 30, 9)])
        add([_disc(200, 30, 11), _disc(222, 30, 11), _disc(244, 30, 11)])
        # bent chain: 60 degree elbow
        r = 9
        add([_disc(40, 100, r), _disc(40 + 2 * r, 100, r), _disc(40 + 3 * r, 100 + r * math.sqrt(3), r)])
        add([_disc(150, 90, 8), _disc(150 + 16, 90, 8), _disc(150 + 8, 90 + 8 * math.sqrt(3), 8)])  # triangle
    elif name == "split_bigsmall":
        W, H = 300, 130
        for i, (r1, r2) in enumerate([(12, 5), (14, 6), (10, 4), (16, 4)]):
            add(_pair(45 + 70 * i, 35, r1, r2, r1 + r2))
        add(_pair(45, 95, 12, 8, 20, angle=0.7))
        add(_pair(125, 95, 15, 7, 22, angle=2.0))
    elif name in ("split_overlap", "split_overlap_r05"):
        W, H = 290, 60
        r = 10.0
        for i, q in enumerate([0.4, 0.55, 0.65, 0.75, 0.9]):
            d = 2 * r * math.sqrt(1 - q * q)           # neck / peak = q
            add(_pair(30 + 56 * i, 30, r, r, d))
        if name.endswith("r05"):
            neck = 0.5
    elif name == "split_convex":
        W, H = 300, 130
        specs = [(35, 30, 10, 10, 0.0), (90, 30, 14, 7, 0.4), (150, 30, 18, 6, 1.1), (215, 30, 21, 7, 0.0),
                 (270, 30, 12, 9, 2.4), (35, 95, 8, 8, 0.0), (95, 95, 16, 8, 0.8), (160, 95, 24, 8.5, 1.9),
                 (230, 95, 13, 13, 0.0)]
        for sp in specs:
            add([sp])
    elif name == "split_dense":
        raise KeyError("dense case uses soft_field")
    elif name == "split_minsurface":
        W, H = 300, 130
        for i, (r1, r2) in enumerate([(12, 5), (14, 6), (10, 4), (16, 4)]):
            add(_pair(45 + 70 * i, 35, r1, r2, r1 + r2))
        add(_pair(45, 95, 12, 8, 20, angle=0.7))
        add(_pair(125, 95, 15, 7, 22, angle=2.0))
        ov["min_surface"] = 60.0
    else:
        raise KeyError(name)
    return W, H, parts, groups, ov, neck


def case_image(name: str):
    """(rgb, idmap, groups, overrides, neck_ratio) of a case."""
    from tests import gt
    from tests.synth import soft_field

    if name == "split_dense":
        img = soft_field(240, 180, 240 * 180 // 45, seed=61)
        return np.array(img), None, [], {"pixel_scale": 20.0, "max_cluster_axis": 100.0}, 0.7
    W, H, parts, groups, ov, neck = parts_for(name)
    rgb, idmap = gt.render(W, H, parts, ss=4, noise=2.0, seed=40 + CASES.index(name))
    return rgb, idmap, groups, ov, neck


# ---------------------------------------------------------------------------

def cluster_columns(clusters, width: int) -> dict:
    cols = {k: [] for k in ("cluster_id", "surface", "roundness", "short_axis", "long_axis", "volume",
                            "xmean", "ymean", "edge_weight", "n_px", "px_hash")}
    for c in clusters:
        lin = np.sort(np.asarray(c.x_pixels, dtype=np.int64) * width + np.asarray(c.y_pixels, dtype=np.int64))
        cols["cluster_id"].append(int(c.cluster_id))
        for k in ("surface", "roundness", "short_axis", "long_axis", "volume", "xmean", "ymean", "edge_weight"):
            cols[k].append(float(getattr(c, k)))
        cols["n_px"].append(int(lin.size))
        cols["px_hash"].append(base.fnv_u32(lin))
    return cols


def analyze(rgb: np.ndarray, overrides: dict):
    from coffeegrindsize_core import AnalysisSettings, analyze_image

    settings = AnalysisSettings.legacy(**overrides)
    return settings, analyze_image(Image.fromarray(rgb), settings)


def run_case(rgb: np.ndarray, overrides: dict, neck_ratio: float) -> dict:
    settings, res = analyze(rgb, overrides)
    ds = res.dataset
    blue = np.ascontiguousarray(rgb[:, :, 2])
    h, w = blue.shape
    cands = ref.find_candidates(ds.clusters, settings)
    out, info = ref.split_touching(ds.clusters, settings, neck_ratio)
    expected = {
        "candidates": [{"parent_id": int(ds.clusters[k].cluster_id), "solidity": float(sol)} for k, sol in cands],
        "info": info,
        "clusters": cluster_columns(out, w),
        "unsplit": ref.unsplit_dv(ds),
    }
    return {
        "kind": "split", "settings": dict(overrides), "neck_ratio": float(neck_ratio),
        "height": int(h), "width": int(w), "blue_b64z": base.b64z(blue), "blue_hash": base.fnv_bytes(blue),
        "expected": expected,
    }


def build_case(name: str) -> str:
    rgb, _idmap, _groups, ov, neck = case_image(name)
    payload = run_case(rgb, ov, neck)
    info = payload["expected"]["info"]
    if name in ("split_pairs", "split_chains", "split_bigsmall", "split_overlap", "split_overlap_r05",
                "split_dense", "split_minsurface"):
        assert info["clusters_split"] > 0, f"{name}: nothing was split"
    if name == "split_convex":
        assert info["clusters_split"] == 0 and info["candidates"] > 0, f"{name}: {info}"
    if name == "split_minsurface":
        assert info["rejected_splits"] > 0, f"{name}: no split was rejected"
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
