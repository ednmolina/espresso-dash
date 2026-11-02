"""Measurement-model tests against synthetic ground truth (specs/model.md T1-T11)."""
from __future__ import annotations

import numpy as np
import pytest

from coffeegrindsize_core import (
    AnalysisSettings, ParticleDataset, analysis as an, metric_values, metric_weights, summarize_dataset,
)
from tests.gt import moments, place, render
from tests.helpers import d_area, legacy_settings, matched, modern_settings, run_image
from tests.synth import crisp_ellipses

MODERN_AND_LEGACY = [pytest.param(modern_settings, id="modern"), pytest.param(legacy_settings, id="legacy")]


# ----------------------------------------------------------------------------- basic detection
def _crisp_specs():
    specs = []
    for i, a in enumerate([6, 8, 10, 12, 15]):
        for j, ratio in enumerate([1.0, 0.6]):
            specs.append((45 + i * 70, 60 + j * 120, a, a * ratio, 0.3 * i))
    return specs


@pytest.mark.parametrize("factory", MODERN_AND_LEGACY)
def test_crisp_ellipses_count_centroid_and_size(factory):
    specs = _crisp_specs()
    img, truth = crisp_ellipses(400, 200, specs, noise=2.0)
    res = run_image(img, factory(pixel_scale=1.0))
    clusters = res.dataset.clusters
    assert len(clusters) == len(truth)
    for t in truth:
        # Cluster.xmean is the ROW, ymean the COLUMN
        c = min(clusters, key=lambda c: (c.ymean - t.cx) ** 2 + (c.xmean - t.cy) ** 2)
        assert np.hypot(c.ymean - t.cx, c.xmean - t.cy) < 0.5
        assert c.surface == pytest.approx(t.area, rel=0.15)
        assert c.long_axis == pytest.approx(t.a, rel=0.25)
        assert c.short_axis / c.long_axis == pytest.approx(t.b / t.a, abs=0.2)


def test_below_min_surface_dropped_and_kept():
    img, _ = crisp_ellipses(200, 100, [(50, 50, 6, 6, 0), (150, 50, 1.5, 1.5, 0)])
    assert len(run_image(img, min_surface=10.0).dataset.clusters) == 1
    assert len(run_image(img, min_surface=5.0).dataset.clusters) == 2


def test_polygon_cut_particles_rejected():
    img, _ = crisp_ellipses(300, 200, [(60, 100, 10, 10, 0), (150, 100, 10, 10, 0), (240, 100, 10, 10, 0)])
    poly = [(150.5, 20.5), (290.5, 20.5), (290.5, 180.5), (150.5, 180.5)]  # right edge of poly passes through particle 2
    res = run_image(img, modern_settings(pixel_scale=1.0, analysis_polygon=poly))
    xs = sorted(round(c.ymean) for c in res.dataset.clusters)
    assert xs == [240], xs   # particle at 60 outside, particle at 150 cut by the polygon edge


@pytest.mark.parametrize("vignette", [40.0])
def test_vignette_still_detects_all(vignette):
    img, truth = crisp_ellipses(400, 200, _crisp_specs(), noise=2.0, vignette=vignette)
    assert len(run_image(img).dataset.clusters) == len(truth)


def test_blank_image_zero_clusters():
    img, _ = crisp_ellipses(200, 100, [])
    assert len(run_image(img).dataset.clusters) == 0


def test_pixel_scale_diameter_mm():
    img, _ = crisp_ellipses(200, 100, [(100, 50, 10, 10, 0)])
    res = run_image(img, pixel_scale=10.0)
    d = metric_values(res.dataset, "diameter")
    assert len(d) == 1 and d[0] == pytest.approx(2.0, rel=0.15)


# ----------------------------------------------------------------------------- T1 / T2 sizing
def _discs(d, n=8, seed=1, size=500):
    parts = place(size, size, [d] * n, gap=20, seed=seed, margin=d, ecc=(1, 1))
    img, idm = render(size, size, parts, seed=seed)
    return parts, img, idm


@pytest.mark.parametrize("d", [12, 24, 48])
def test_T1_isolated_discs(d):
    parts, img, idm = _discs(d)
    res = run_image(img, modern_settings(pixel_scale=1.0, axis_method="moments", volume_model="spheroid"))
    m = matched(res, idm)
    assert len(res.dataset.clusters) == len(parts) and -1 not in m
    area_ratio, mom, vol = [], [], []
    for k, (_, _, a, b, _) in enumerate(parts):
        c = m[k][0]
        area_ratio.append(d_area(c) / (2 * a))
        mom.append(moments(c)[0] / a)
        vol.append(c.volume / (4 / 3 * np.pi * a * b * b))
    assert np.median(area_ratio) == pytest.approx(1.0, abs=0.02)
    assert np.median(mom) == pytest.approx(1.0, abs=0.02 if d == 12 else 0.01)
    assert np.median(vol) == pytest.approx(1.0, abs=0.03)
    # moments axis_method reports the same numbers the test recomputes
    assert np.median([m[k][0].long_axis / a for k, (_, _, a, _, _) in enumerate(parts)]) == pytest.approx(1.0, abs=0.03)


def test_T2_small_discs_6px():
    parts, img, idm = _discs(6, n=12, seed=2)
    m = matched(run_image(img, modern_settings(pixel_scale=1.0)), idm)
    assert np.median([d_area(m[k][0]) / (2 * a) for k, (_, _, a, _, _) in enumerate(parts)]) == pytest.approx(1.0, abs=0.03)
    ml = matched(run_image(img, legacy_settings(pixel_scale=1.0)), idm)
    # legacy max-radius axis underestimates slightly for tiny discs (spec: 0.945 +- 0.02; measured 0.97-0.98)
    lm = np.median([ml[k][0].long_axis / a for k, (_, _, a, _, _) in enumerate(parts)])
    assert 0.93 <= lm <= 1.01


# ----------------------------------------------------------------------------- T3 / T4 / T5 lighting
@pytest.fixture(scope="module")
def particles24():
    return place(700, 700, [24] * 60, gap=10, seed=5, margin=20, ecc=(0.8, 1.0))


def _ratio_by_zone(res, idm, parts, W=700, H=700):
    m = matched(res, idm)
    centre, corner = [], []
    for k, (cx, cy, a, b, _) in enumerate(parts):
        if k not in m:
            continue
        ratio = d_area(max(m[k], key=lambda c: c.surface)) / (2 * np.sqrt(a * b))
        rr = np.hypot(cx - W / 2, cy - H / 2) / np.hypot(W / 2, H / 2)
        if rr < 0.35:
            centre.append(ratio)
        elif rr > 0.7:
            corner.append(ratio)
    return m, centre, corner


def test_T3_vignette_flattened(particles24):
    img, idm = render(700, 700, particles24, blur=1.5, vignette=0.5, pcol=(140, 110, 90))
    res = run_image(img, modern_settings(pixel_scale=1.0))
    m, centre, corner = _ratio_by_zone(res, idm, particles24)
    assert len(centre) >= 8 and len(corner) >= 6
    assert np.median(corner) / np.median(centre) == pytest.approx(1.0, abs=0.03)
    # same data, global background: strongly biased (documents WHY poly4 exists)
    g = _ratio_by_zone(run_image(img, legacy_settings(pixel_scale=1.0)), idm, particles24)
    assert abs(np.median(g[2]) / np.median(g[1]) - 1.0) > 0.05


def test_T3_gradient_no_false_positives(particles24):
    img, idm = render(700, 700, particles24, blur=1.5, vignette=0.3, gradient=0.5, pcol=(140, 110, 90))
    res = run_image(img, modern_settings(pixel_scale=1.0))
    m = matched(res, idm)
    assert len(m.get(-1, [])) == 0
    assert len(res.dataset.clusters) == len(particles24)


def test_T4_uniform_lighting_poly4_matches_global(particles24):
    img, idm = render(700, 700, particles24, pcol=(95, 60, 40))
    on = run_image(img, modern_settings(pixel_scale=10.0, background_model="poly4"))
    off = run_image(img, modern_settings(pixel_scale=10.0, background_model="global"))
    assert abs(on.dataset.nclusters - off.dataset.nclusters) <= max(1, 0.005 * off.dataset.nclusters)
    s_on, s_off = summarize_dataset(on.dataset), summarize_dataset(off.dataset)
    assert s_on["dv50_mm"] == pytest.approx(s_off["dv50_mm"], rel=0.005)


def test_T5_half_contrast_light_particles(particles24):
    img, idm = render(700, 700, particles24, blur=1.5, pcol=(140, 110, 90))
    def med(s):
        m = matched(run_image(img, s), idm)
        return np.median([d_area(m[k][0]) / (2 * np.sqrt(a * b)) for k, (_, _, a, b, _) in enumerate(particles24) if k in m])
    half = med(modern_settings(pixel_scale=1.0, threshold_mode="half_contrast"))
    fixed = med(modern_settings(pixel_scale=1.0, threshold_mode="fixed"))
    assert half == pytest.approx(1.0, abs=0.03)
    assert half > fixed + 0.02            # legacy-style fixed 58.8 % under-sizes light particles (~0.94)


def test_threshold_mode_fixed_matches_legacy_threshold(particles24):
    img, _ = render(700, 700, particles24)
    a = run_image(img, modern_settings(pixel_scale=1.0, background_model="global", threshold_mode="fixed", edge_correction=False))
    b = run_image(img, legacy_settings(pixel_scale=1.0))
    np.testing.assert_array_equal(a.threshold_mask, b.threshold_mask)
    assert a.dataset.nclusters == b.dataset.nclusters


# ----------------------------------------------------------------------------- T6 edge correction
def test_edge_weight_formula_single_particle():
    img, _ = crisp_ellipses(300, 200, [(150, 100, 20, 20, 0)])
    res = run_image(img, modern_settings(pixel_scale=1.0, edge_correction=True))
    (c,) = res.dataset.clusters
    w, h = 40.0, 40.0   # bbox extent (px) of a radius-20 disc, +-1 px depending on convention
    expect = (300 * 200) / ((300 - w) * (200 - h))
    assert c.edge_weight == pytest.approx(expect, rel=0.03)
    off = run_image(img, modern_settings(pixel_scale=1.0, edge_correction=False))
    assert off.dataset.clusters[0].edge_weight == 1.0
    assert off.dataset.nclusters == res.dataset.nclusters      # statistics only, never counts


def test_T6_edge_correction_reduces_size_bias():
    px, wmm = 20, 15
    truth_d, sets = [], {True: [], False: []}
    for seed in range(12):
        rng = np.random.default_rng(100 + seed)
        dmm = np.clip(rng.lognormal(np.log(1.1), 0.45, 60), 0.3, 3.0)
        pm = place(wmm * 100, wmm * 100, list(dmm * 100), gap=25, seed=seed, margin=0)
        parts = [(cx / 100 * px, cy / 100 * px, a / 100 * px, b / 100 * px, th) for cx, cy, a, b, th in pm]
        truth_d += [2 * np.sqrt(a * b) / 100 for _, _, a, b, _ in pm]
        img, _ = render(wmm * px, wmm * px, parts, blur=0.8, seed=seed)
        for ec in (True, False):
            sets[ec].append(run_image(img, modern_settings(pixel_scale=float(px), edge_correction=ec)).dataset)
    dt = np.array(truth_d)
    truth = np.array(an._weighted_percentiles(dt, dt ** 3, (10, 50)))
    err = {}
    for ec, dsets in sets.items():
        big = ParticleDataset([c for d in dsets for c in d.clusters], pixel_scale=float(px), meta=dsets[0].meta)
        p = np.array(an._weighted_percentiles(metric_values(big, "diameter"), metric_weights(big, "mass"), (10, 50)))
        err[ec] = p / truth - 1
    assert np.all(np.abs(err[True]) < 0.03), err
    assert np.abs(err[True]).mean() < np.abs(err[False]).mean(), err
    assert err[False][1] < -0.015            # uncorrected Dv50 is biased low (spec: -1.5..-4 %)


# ----------------------------------------------------------------------------- T7 .. T11 reporting
def _fake_dataset(n=60, scale=20.0, seed=0, **meta):
    from tests.core.test_dataset import ds
    d = ds(n, scale, seed)
    d.meta = dict(meta)
    return d


def test_T7_weighted_percentiles():
    rng = np.random.default_rng(0)
    v = rng.normal(0, 1, 301)
    np.testing.assert_allclose(an._weighted_percentiles(v, np.ones(301), (10, 50, 90)),
                               np.percentile(v, (10, 50, 90), method="hazen"), rtol=1e-12)
    assert an._weighted_percentiles(np.array([2.0]), np.array([5.0]), (10, 90)) == [2.0, 2.0]
    assert an._weighted_percentiles(np.array([1.0, 2, 3, 4]), np.array([1.0, 1, 1, 97]), (50,))[0] == pytest.approx(3.969, abs=2e-3)


def test_T8_detection_limit_and_fines():
    s20 = summarize_dataset(_fake_dataset(scale=20.0), min_surface=5.0)
    assert s20["detection_limit_um"] == pytest.approx(126.0, abs=1.0)
    assert s20["fines_volume_pct"] is None and s20["fines_measurable"] is False
    assert s20["reliable_limit_um"] == pytest.approx(6000 / 20.0, rel=1e-6)
    s30 = summarize_dataset(_fake_dataset(scale=30.0), min_surface=5.0)
    assert s30["detection_limit_um"] == pytest.approx(84.0, abs=1.0)
    assert s30["fines_measurable"] is True and s30["fines_volume_pct"] is not None


def test_T9_dv_percentiles_and_bootstrap_ci():
    px, wmm, hmm = 20, 30, 22
    rng = np.random.default_rng(11)
    coarse = np.clip(rng.lognormal(np.log(0.40), 0.45, 450), 0.15, 1.6)
    fines = np.clip(rng.lognormal(np.log(0.07), 0.35, 300), 0.03, 0.15)
    dmm = np.concatenate([coarse, fines])
    pm = place(wmm * 100, hmm * 100, list(dmm * 100), gap=40, seed=4, margin=100)
    parts = [(cx / 100 * px, cy / 100 * px, a / 100 * px, b / 100 * px, th) for cx, cy, a, b, th in pm]
    dt = np.array([2 * np.sqrt(a * b) for _, _, a, b, _ in pm]) / 100
    truth = an._weighted_percentiles(dt, dt ** 3, (10, 50, 90))
    img, _ = render(wmm * px, hmm * px, parts, blur=0.8)
    res = run_image(img, modern_settings(pixel_scale=float(px), edge_correction=False))
    s = summarize_dataset(res.dataset)
    for key, t in zip(("dv10_mm", "dv50_mm", "dv90_mm"), truth):
        assert s[key] == pytest.approx(t, rel=0.03), key
    for key, t in zip(("dv10", "dv50", "dv90"), truth):
        lo, hi = s["dv_ci95"][key]
        assert lo <= t <= hi and lo < hi, key
    assert summarize_dataset(res.dataset)["dv_ci95"] == s["dv_ci95"]         # seeded -> deterministic
    assert s["detection_limit_um"] == pytest.approx(126.0, abs=1.0)


def test_T10_scale_uncertainty():
    s = summarize_dataset(_fake_dataset(), reference_px_length=480.0, click_sigma_px=2.0, min_surface=5.0)
    assert s["diameter_scale_unc_pct"] == pytest.approx(0.589, abs=0.01)
    assert s["volume_scale_unc_pct"] == pytest.approx(3 * s["diameter_scale_unc_pct"], rel=1e-6)
    assert summarize_dataset(_fake_dataset(), min_surface=5.0)["diameter_scale_unc_pct"] is None


def test_T11_histogram_stats_mass_weighted_equals_volume_weighted():
    from coffeegrindsize_core.stats import distribution_stats
    d = _fake_dataset(80, seed=3)
    vals = metric_values(d, "diameter")
    w = metric_weights(d, "mass")
    st = distribution_stats(vals, weights=w)
    assert st["median"] == pytest.approx(an._weighted_percentiles(vals, w, (50,))[0], rel=1e-9)
    assert st["p84"] == pytest.approx(an._weighted_percentiles(vals, w, (84,))[0], rel=1e-9)
    assert st["mean"] == pytest.approx(np.average(vals, weights=w), rel=1e-9)
    for k in ("mean_spread_upper", "mean_spread_lower", "median_spread_upper", "median_spread_lower", "n", "n_eff"):
        assert k in st
    unw = distribution_stats(vals)
    assert unw["median"] == pytest.approx(np.percentile(vals, 50, method="hazen"), rel=1e-9)


def test_mass_weights_are_equivalent_sphere_volume():
    d = _fake_dataset(20)
    diam = metric_values(d, "diameter")
    np.testing.assert_allclose(metric_weights(d, "mass"), np.pi / 6 * diam ** 3 * d.edge_weights, rtol=1e-9)


def test_summarize_new_keys_present():
    s = summarize_dataset(_fake_dataset(100), min_surface=5.0)
    for k in ("geometric_mean_number_mm", "gsd_number", "geometric_mean_volume_mm", "gsd_volume", "volume_mode_mm",
              "dv_ci95", "detection_limit_um", "reliable_limit_um", "fines_measurable", "model_notes",
              "effective_cluster_count", "n_excluded_below_min"):
        assert k in s, k
    assert s["gsd_number"] >= 1 and s["gsd_volume"] >= 1
    assert any("uncalibrated" in n for n in s["model_notes"])


def test_average_efficiency_is_volume_weighted():
    d = _fake_dataset(50, seed=5)
    s = summarize_dataset(d, min_surface=5.0)
    vol = d.volumes / d.pixel_scale ** 3
    att = an.attainable_mass(vol)
    assert s["average_efficiency_pct"] == pytest.approx(att.sum() / vol.sum() * 100, rel=1e-6)


def test_min_diameter_filter_and_common_cutoff():
    d = _fake_dataset(100, seed=7, min_surface=5.0)
    s_all = summarize_dataset(d)
    s_cut = summarize_dataset(d, min_diameter_um=400.0)
    assert s_cut["n_excluded_below_min"] > 0
    assert s_cut["cluster_count"] == s_all["cluster_count"] - s_cut["n_excluded_below_min"]
    f = an.filter_by_min_diameter(d, d.pixel_scale, 400.0)
    assert f.nclusters < d.nclusters
    assert np.all(metric_values(f, "diameter") * 1000 >= 400.0 - 1e-6)
    lim = an.common_min_diameter_um([d, d], [20.0, 40.0])
    assert lim == pytest.approx(2000 * np.sqrt(5 / np.pi) / 20.0, rel=1e-6)


def test_legacy_summary_flag_uses_dataset_volumes():
    d = _fake_dataset(60, seed=9)
    old = summarize_dataset(d, legacy_summary=True)
    diam = metric_values(d, "diameter")
    expect = an._weighted_percentiles(diam, d.volumes / d.pixel_scale ** 3, (10, 50, 90))
    assert [old["dv10_mm"], old["dv50_mm"], old["dv90_mm"]] == pytest.approx(expect, rel=1e-9)


def test_invalid_enum_settings_raise():
    for kw in (dict(background_model="x"), dict(threshold_mode="x"), dict(axis_method="x"), dict(volume_model="x")):
        with pytest.raises(ValueError):
            AnalysisSettings(**kw)
    s = AnalysisSettings.legacy()
    assert (s.background_model, s.threshold_mode, s.edge_correction, s.axis_method, s.volume_model) == \
           ("global", "fixed", False, "max_radius", "legacy")
    d = AnalysisSettings()
    assert (d.background_model, d.threshold_mode, d.edge_correction) == ("poly4", "half_contrast", True)
