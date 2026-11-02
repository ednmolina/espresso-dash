import io

import numpy as np
import pandas as pd
import pytest

from coffeegrindsize_core import (
    Cluster, ParticleDataset, clusters_within_radius, filter_dataset_by_cluster_ids,
    metric_values, summarize_dataset,
)
from coffeegrindsize_core import analysis as an


def ds(n=40, scale=20.0, seed=0, label="t"):
    rng = np.random.default_rng(seed)
    clusters = []
    for i in range(n):
        r = rng.uniform(2.5, 14)
        e = rng.uniform(0.6, 1.0)
        a, b = r / np.sqrt(e), r * np.sqrt(e)
        S = np.pi * a * b
        clusters.append(Cluster(
            cluster_id=i, surface=S, roundness=float(e), short_axis=b, long_axis=a,
            volume=float(np.pi * b ** 2 * a), xmean=float(rng.uniform(0, 100)), ymean=float(rng.uniform(0, 100)),
            x_pixels=np.zeros(1, np.int32), y_pixels=np.zeros(1, np.int32)))
    return ParticleDataset(clusters=clusters, pixel_scale=scale, label=label)


def test_csv_round_trip():
    d = ds()
    back = ParticleDataset.from_csv_bytes(d.to_csv_bytes())
    assert back.nclusters == d.nclusters
    assert back.pixel_scale == pytest.approx(d.pixel_scale)
    np.testing.assert_allclose(back.surfaces, d.surfaces)
    np.testing.assert_allclose(back.long_axes, d.long_axes)
    np.testing.assert_allclose(back.volumes, d.volumes)


def test_csv_missing_columns_raises():
    frame = pd.DataFrame({"SURFACE": [1.0], "ROUNDNESS": [1.0]})
    with pytest.raises(ValueError, match="Missing"):
        ParticleDataset.from_frame(frame)


@pytest.mark.parametrize("scale", [0, -1.0, None])
def test_summarize_requires_positive_scale(scale):
    d = ds(scale=None)
    with pytest.raises(ValueError):
        summarize_dataset(d, scale)


def test_summarize_empty_dataset_raises():
    with pytest.raises(ValueError):
        summarize_dataset(ParticleDataset(clusters=[], pixel_scale=10.0))


def test_summarize_basic_keys_and_ordering():
    s = summarize_dataset(ds(200, seed=1))
    assert s["cluster_count"] == 200
    assert s["dv10_mm"] <= s["dv50_mm"] <= s["dv90_mm"]
    assert s["diameter_number_median_mm"] > 0
    assert s["fines_volume_pct"] is None or 0 <= s["fines_volume_pct"] <= 100


def test_summarize_single_particle_does_not_crash():
    """Backend spec P0-1: one particle used to give surface_std 0 -> inf quality -> HTTP 500."""
    s = summarize_dataset(ds(1, seed=2))
    q = s["surface_quality"]
    assert q is None or not np.isinf(q)


def test_summarize_identical_particles_quality_not_inf():
    d = ds(5)
    c0 = d.clusters[0]
    d = ParticleDataset([Cluster(**{**c0.__dict__, "cluster_id": i}) for i in range(5)], pixel_scale=20.0)
    q = summarize_dataset(d)["surface_quality"]
    assert q is None or not np.isinf(q)


def test_filter_dataset_by_cluster_ids():
    d = ds(10)
    f = filter_dataset_by_cluster_ids(d, {1, 3, 99})
    assert [c.cluster_id for c in f.clusters] == [0, 2, 4, 5, 6, 7, 8, 9]
    assert f.pixel_scale == d.pixel_scale and f.label == d.label
    assert filter_dataset_by_cluster_ids(d, []).nclusters == 10


def test_clusters_within_radius():
    d = ds(3)
    for c, (x, y) in zip(d.clusters, [(10, 10), (50, 50), (52, 50)]):
        c.xmean, c.ymean = float(x), float(y)
    assert clusters_within_radius(d, [(50, 50)], 3) == {1, 2}
    assert clusters_within_radius(d, [(50, 50)], 1) == {1}
    assert clusters_within_radius(d, [(10, 10), (52, 50)], 0.5) == {0, 2}
    assert clusters_within_radius(d, [(50, 50)], 0) == set()
    assert clusters_within_radius(d, [], 5) == set()
    assert clusters_within_radius(ParticleDataset([], 1.0), [(1, 1)], 5) == set()


def test_metric_values_all_modes():
    d = ds(30)
    sc = d.pixel_scale
    np.testing.assert_allclose(metric_values(d, "diameter"), 2 * np.sqrt(d.long_axes * d.short_axes) / sc)
    np.testing.assert_allclose(metric_values(d, "surface"), d.surfaces / sc ** 2)
    np.testing.assert_allclose(metric_values(d, "volume"), d.volumes / sc ** 3)
    ey = metric_values(d, "extraction_yield")
    assert ey.shape == (30,) and np.all((ey > 0) & (ey < 30))
    with pytest.raises(ValueError):
        metric_values(d, "bogus")
    with pytest.raises(ValueError):
        metric_values(ds(scale=None), "diameter")


@pytest.mark.parametrize("mode", ["number", "surface", "mass", "available_mass", "extracted_mass"])
def test_metric_weights_modes(mode):
    d = ds(30)
    w = an.metric_weights(d, mode)
    assert w.shape == (30,) and np.all(np.isfinite(w)) and np.all(w >= 0)
    if mode == "number":
        assert np.all(w == 1)
    if mode == "surface":
        np.testing.assert_allclose(w, d.surfaces)
    assert an.metric_weights(d, "mass").sum() > 0
    with pytest.raises(ValueError):
        an.metric_weights(d, "nope")


def test_weighted_percentiles_unit_weights_hazen():
    rng = np.random.default_rng(0)
    v = rng.normal(5, 2, 501)
    got = an._weighted_percentiles(v, np.ones_like(v), (10, 50, 90))
    exp = np.percentile(v, (10, 50, 90), method="hazen")
    np.testing.assert_allclose(got, exp, rtol=1e-12)


def test_weighted_percentiles_single_and_skewed():
    assert an._weighted_percentiles(np.array([3.5]), np.array([2.0]), (10, 50, 90)) == [3.5, 3.5, 3.5]
    got = an._weighted_percentiles(np.array([1.0, 2, 3, 4]), np.array([1.0, 1, 1, 97]), (50,))
    assert got[0] == pytest.approx(3.969, abs=2e-3)
