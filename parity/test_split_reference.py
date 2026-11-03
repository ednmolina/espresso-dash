"""Drift + unit tests for the touching-particle split (feature B) reference and its JS fixtures.

Run in CI with ``pytest -m "" parity``. If a drift test fails, regenerate and commit:

    python parity/export_split_fixtures.py
"""
import hashlib
import json
from types import SimpleNamespace

import numpy as np
import pytest

import export_split_fixtures as ex
import split_reference as ref

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
# edt_squared
# ---------------------------------------------------------------------------

def _brute_edt(mask):
    mask = np.asarray(mask, bool)
    gh, gw = mask.shape
    yy, xx = np.mgrid[0:gh, 0:gw]
    by, bx = yy[~mask], xx[~mask]
    out = np.zeros((gh, gw), np.int64)
    for y, x in zip(*np.nonzero(mask)):
        out[y, x] = ((by - y) ** 2 + (bx - x) ** 2).min()
    return out


def _padded(core):
    core = np.asarray(core, bool)
    out = np.zeros((core.shape[0] + 2, core.shape[1] + 2), bool)
    out[1:-1, 1:-1] = core
    return out


def test_edt_matches_brute_force_on_random_masks():
    rng = np.random.default_rng(2024)
    for _ in range(50):
        h, w = int(rng.integers(1, 39)), int(rng.integers(1, 39))
        core = rng.random((h, w)) < rng.uniform(0.3, 0.95)
        mask = _padded(core)
        assert np.array_equal(np.array(ref.edt_squared(mask)), _brute_edt(mask))


def test_edt_edge_cases():
    shapes = {
        "single pixel": np.ones((1, 1), bool),
        "1 x n line": np.ones((1, 17), bool),
        "full rectangle": np.ones((9, 13), bool),
        "ring with a hole": np.pad(np.zeros((5, 5), bool), 4, constant_values=True),
    }
    for name, core in shapes.items():
        mask = _padded(core)
        assert np.array_equal(np.array(ref.edt_squared(mask)), _brute_edt(mask)), name
    # known values: the centre of a 9-wide full rectangle is 5 cells from the background
    d = np.array(ref.edt_squared(_padded(np.ones((9, 9), bool))))
    assert d[5, 5] == 25


def test_edt_matches_scipy():
    ndimage = pytest.importorskip("scipy.ndimage")
    rng = np.random.default_rng(5)
    for _ in range(10):
        mask = _padded(rng.random((20, 25)) < 0.7)
        want = np.rint(ndimage.distance_transform_edt(mask) ** 2).astype(np.int64)
        assert np.array_equal(np.array(ref.edt_squared(mask)), want)


# ---------------------------------------------------------------------------
# solidity
# ---------------------------------------------------------------------------

def _shape(fn, radius=40):
    rows, cols = [], []
    for r in range(2 * radius):
        for c in range(2 * radius):
            if fn(r + 0.5 - radius, c + 0.5 - radius):
                rows.append(r + 3)
                cols.append(c + 3)
    return np.array(rows), np.array(cols)


def test_solidity_values():
    disc = lambda cy, cx, r: (lambda y, x: (y - cy) ** 2 + (x - cx) ** 2 <= r * r)
    assert ref.cluster_solidity(*_shape(disc(0, 0, 12))) >= 0.95
    assert ref.cluster_solidity(*_shape(lambda y, x: abs(x) <= 8 and abs(y) <= 8)) >= 0.99
    # tangent discs and an L shape are clearly non convex
    assert ref.cluster_solidity(*_shape(lambda y, x: disc(0, -10, 10)(y, x) or disc(0, 10, 10)(y, x))) < 0.9
    assert ref.cluster_solidity(*_shape(lambda y, x: (abs(x) <= 12 and abs(y) <= 12) and (x < -4 or y < -4))) < 0.9
    # a 1 x 40 line has solidity 1
    assert ref.cluster_solidity(np.zeros(40, int), np.arange(40)) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# ground truth and conservation
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def runs():
    out = {}
    for name in ex.CASES:
        rgb, idmap, groups, ov, neck = ex.case_image(name)
        settings, res = ex.analyze(rgb, ov)
        clusters = res.dataset.clusters
        pieces, info = ref.split_touching(clusters, settings, neck)
        out[name] = SimpleNamespace(rgb=rgb, idmap=idmap, groups=groups, settings=settings, parents=clusters,
                                    out=pieces, info=info)
    return out


@pytest.mark.parametrize("name", ex.TRUTH_CASES)
def test_every_rendered_object_is_split_into_its_true_count(runs, name):
    from tests import gt
    r = runs[name]
    match = gt.match(SimpleNamespace(dataset=SimpleNamespace(clusters=r.out)), r.idmap, 0)
    assert not match.get(-1), "a cluster does not overlap any rendered object"
    for group in r.groups:
        # one output cluster per rendered particle of the group; none is shared or missing
        for k in group:
            assert len(match.get(k, [])) == 1, f"{name}: particle {k} got {len(match.get(k, []))} clusters"
    # every group was one parent cluster before the split
    assert r.info["clusters_split"] == len(r.groups)
    assert r.info["pieces_added"] == sum(len(g) - 1 for g in r.groups)
    assert r.info["rejected_splits"] == 0


def test_isolated_convex_shapes_are_not_split(runs):
    r = runs["split_convex"]
    assert r.info["clusters_split"] == 0 and r.info["pieces_added"] == 0
    assert r.info["candidates"] > 0, "the case should exercise the candidate path"
    assert r.out is r.parents, "nothing split: the very same list is returned"


def test_min_surface_rejects_small_pieces(runs):
    r = runs["split_minsurface"]
    assert r.info["rejected_splits"] > 0 and r.info["clusters_split"] > 0
    kept = {int(c.cluster_id) for c in r.out}
    # a rejected parent is kept whole, with its own id
    assert len(kept & {int(c.cluster_id) for c in r.parents}) >= r.info["rejected_splits"]


def _four_connected(rows, cols):
    cells = set(zip(rows.tolist(), cols.tolist()))
    start = next(iter(cells))
    seen, stack = {start}, [start]
    while stack:
        y, x = stack.pop()
        for n in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if n in cells and n not in seen:
                seen.add(n)
                stack.append(n)
    return len(seen) == len(cells)


@pytest.mark.parametrize("name", ["split_pairs", "split_chains", "split_overlap", "split_dense", "split_minsurface"])
def test_conservation(runs, name):
    r = runs[name]
    parents = {int(c.cluster_id): c for c in r.parents}
    ids = [int(c.cluster_id) for c in r.out]
    assert len(set(ids)) == len(ids), "ids are unique"
    assert sum(c.x_pixels.size for c in r.out) == sum(c.x_pixels.size for c in r.parents)
    assert len(r.out) == len(r.parents) + r.info["pieces_added"]
    max_id = max(parents)
    new = [c for c in r.out if int(c.cluster_id) not in parents]
    assert all(int(c.cluster_id) > max_id for c in new)
    # unsplit clusters keep their ids and stay in dataset order; pieces replace the parent in place
    old = [int(c.cluster_id) for c in r.out if int(c.cluster_id) in parents]
    assert old == sorted(old)
    assert [int(c.cluster_id) for c in new] == list(range(max_id + 1, max_id + 1 + len(new)))
    # the surviving parents are unchanged objects; the pieces of one retired parent partition it
    pix = {int(c.cluster_id): set(zip(c.x_pixels.tolist(), c.y_pixels.tolist())) for c in r.out}
    retired = [p for p in parents.values() if int(p.cluster_id) not in pix]
    assert len(retired) == r.info["clusters_split"]
    owner = {}
    for pid, p in parents.items():
        for cell in zip(p.x_pixels.tolist(), p.y_pixels.tolist()):
            owner[cell] = pid
    for c in new:
        assert _four_connected(c.x_pixels, c.y_pixels), "every piece is 4-connected"
        assert len({owner[cell] for cell in pix[int(c.cluster_id)]}) == 1, "a piece lies inside one parent"
    for p in retired:
        got = set()
        for c in new:
            cells = pix[int(c.cluster_id)]
            if owner[next(iter(cells))] == int(p.cluster_id):
                assert not (got & cells), "pieces do not overlap"
                got |= cells
        assert got == set(zip(p.x_pixels.tolist(), p.y_pixels.tolist())), "the pieces partition the parent"


def test_pieces_follow_the_parents_position_in_row_major_piece_order(runs):
    r = runs["split_pairs"]
    # the first parent (a pair) is replaced in place by its two pieces: new, adjacent, ids ascending (= piece order)
    first, second = r.out[0], r.out[1]
    assert second.cluster_id == first.cluster_id + 1
    # piece 0 holds the first cell of the parent's bbox in a row-major scan
    assert min(first.x_pixels.min(), second.x_pixels.min()) == first.x_pixels.min()


def test_unsplit_dv_is_the_summary_dv(runs):
    from coffeegrindsize_core import summarize_dataset
    r = runs["split_dense"]
    from coffeegrindsize_core.analysis import ParticleDataset
    full = ParticleDataset(clusters=r.parents, pixel_scale=20.0, meta={"min_diameter_um": None})
    dv = ref.unsplit_dv(full)
    summ = summarize_dataset(full)
    assert dv["cluster_count"] == summ["cluster_count"]
    for k in ("dv10_mm", "dv50_mm", "dv90_mm"):
        assert dv[k] == pytest.approx(summ[k], rel=1e-6)
    assert ref.unsplit_dv(ParticleDataset(clusters=r.parents, pixel_scale=None)) is None
