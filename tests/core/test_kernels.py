import numpy as np
import pytest

from coffeegrindsize_core import Cluster, cluster_center_mask, cluster_outline_mask
from coffeegrindsize_core import _kernels
from coffeegrindsize_core import analysis as an
from tests.reference import analysis_e299811_stable as ref


def make_cluster(cid, rows, cols):
    rows = np.asarray(rows); cols = np.asarray(cols)
    return Cluster(cluster_id=cid, surface=float(rows.size), roundness=1.0, short_axis=1.0, long_axis=1.0,
                   volume=1.0, xmean=float(rows.mean()), ymean=float(cols.mean()), x_pixels=rows, y_pixels=cols)


def square(cid, r0, c0, n):
    rr, cc = np.meshgrid(np.arange(r0, r0 + n), np.arange(c0, c0 + n), indexing="ij")
    return make_cluster(cid, rr.ravel(), cc.ravel())


def test_outline_mask_5x5_square_is_16_px_ring():
    out = cluster_outline_mask((20, 20), [square(0, 5, 5, 5)])
    assert out.dtype == bool
    assert out.sum() == 16
    assert not out[7, 7]               # interior pixel is not on the outline
    assert out[5, 5] and out[9, 9] and out[5, 7]


def test_outline_mask_two_touching_squares_outlines_each():
    out = cluster_outline_mask((20, 30), [square(0, 5, 5, 5), square(1, 5, 10, 5)])
    assert out.sum() == 32             # touching clusters keep their own borders


def test_outline_mask_at_image_edge():
    out = cluster_outline_mask((10, 10), [square(0, 0, 0, 4)])
    assert out.sum() == 12             # 4x4 block: only the 2x2 centre is interior


def test_outline_mask_empty():
    assert cluster_outline_mask((8, 8), []).sum() == 0


def test_center_mask_in_bounds_and_marks_centroids():
    clusters = [square(0, 0, 0, 3), square(1, 7, 7, 3)]   # centroids (1,1) and (8,8)
    m = cluster_center_mask((9, 9), clusters)
    assert m.sum() == 2 and m[1, 1] and m[8, 8]


def test_center_mask_clusters_at_far_corner_are_in_bounds():
    m = cluster_center_mask((10, 12), [square(0, 7, 9, 3)])
    assert m.sum() == 1 and m[8, 10]


def test_polygon_mask_random_float_polygons_equal_matplotlib():
    rng = np.random.default_rng(5)
    for _ in range(100):
        k = int(rng.integers(3, 8))
        pts = rng.uniform(-10, 90, (k, 2)).tolist()
        shape = (70, 80)
        a = an._build_polygon_mask(shape, pts)
        b = ref._build_polygon_mask(shape, pts)
        assert (a != b).sum() == 0


def test_polygon_mask_on_edge_integer_vertices_match_matplotlib():
    """Pins the boundary rule: pixels exactly on integer-vertex edges follow matplotlib."""
    for poly in ([(10, 10), (60, 10), (60, 40), (10, 40)], [(5, 5), (55, 35), (20, 45)]):
        a = an._build_polygon_mask((50, 70), poly)
        b = ref._build_polygon_mask((50, 70), poly)
        assert (a != b).sum() == 0


def test_polygon_with_fewer_than_three_points_raises():
    with pytest.raises(ValueError):
        an._build_polygon_mask((10, 10), [(1, 1), (5, 5)])
    assert an._build_polygon_mask((10, 10), None) is None


def test_kernels_import_without_pickle_or_cache_errors():
    assert hasattr(_kernels, "polygon_mask") and hasattr(_kernels, "outline_mask")


def test_warm_up_returns_seconds():
    import coffeegrindsize_core as core
    if not hasattr(core, "warm_up"):
        pytest.fail("coffeegrindsize_core.warm_up missing (B1 spec item 10)")
    t = core.warm_up()
    assert isinstance(t, float) and t >= 0.0
