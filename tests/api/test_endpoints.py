"""API cases from specs/backend.md (numbered as in the spec). Status + shape, not message text."""
import io
import json
import re

import numpy as np
import pytest
from PIL import Image

from tests.api.conftest import REF, fake_png_header, png_bytes
from tests.synth import crisp_ellipses

UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
MISSING = "00000000-0000-4000-8000-000000000000"
PARTICLE_COLS = ("id", "surface", "roundness", "short_axis", "long_axis", "volume")


def assert_no_nonfinite(text: str):
    assert not re.search(r"\b(NaN|-?Infinity)\b", text)


# 1 ----------------------------------------------------------------------------------
def test_01_upload_ok(client, photo):
    r = client.post("/upload", files={"file": ("photo.png", png_bytes(photo), "image/png")})
    assert r.status_code == 200
    body = r.json()
    assert UUID4.match(body["image_id"])
    assert (body["width"], body["height"]) == (2400, 1800)
    assert isinstance(body["reference_objects"], dict) and body["reference_objects"]


# 2 ----------------------------------------------------------------------------------
def test_02_upload_garbage_400(client):
    r = client.post("/upload", files={"file": ("x.png", b"hello", "image/png")})
    assert r.status_code == 400 and isinstance(r.json()["detail"], str)


def test_02_upload_pixel_bomb_413(client):
    r = client.post("/upload", files={"file": ("big.png", fake_png_header(20000, 20000), "image/png")})
    assert r.status_code == 413 and isinstance(r.json()["detail"], str)


def test_02_upload_26mb_413(client):
    r = client.post("/upload", files={"file": ("big.bin", b"\x89PNG" + bytes(26 * 1024 * 1024), "image/png")})
    assert r.status_code == 413


# 3 ----------------------------------------------------------------------------------
def test_03_analyze_without_reference(client, small_id):
    r = client.post("/analyze", json={"image_id": small_id})
    assert r.status_code == 200, r.text
    assert_no_nonfinite(r.text)
    b = r.json()
    assert b["pixel_scale"] is None and b["summary"] is None
    assert b["nclusters"] > 5
    assert set(PARTICLE_COLS) <= set(b["particles"])
    assert len(b["particles"]["id"]) == b["nclusters"]
    for k in PARTICLE_COLS:
        assert len(b["particles"][k]) == b["nclusters"]
    assert "PIXEL_SCALE" not in b["particles"]
    assert b["analysis_scale"] == 1.0
    assert (b["width"], b["height"]) == (600, 450)
    assert b["threshold_layer_b64"] and b["cluster_layer_b64"] and b["analysis_id"].startswith(small_id)


# 4 ----------------------------------------------------------------------------------
def test_04_analyze_scaled_with_reference(client, photo_id):
    r = client.post("/analyze", json={"image_id": photo_id, "analysis_scale_pct": 25,
                                      "reference_points": [[240, 900], [640, 900]], "reference_physical_mm": 24})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["analysis_scale"] == 0.25
    assert (b["width"], b["height"]) == (600, 450)
    # 400 px / 24 mm * 0.25 analysis scale
    assert b["pixel_scale"] == pytest.approx(400 / 24 * 0.25)
    assert isinstance(b["summary"], dict) and b["summary"]["dv50_mm"] > 0
    assert_no_nonfinite(r.text)


# 5 ----------------------------------------------------------------------------------
@pytest.mark.parametrize("pct", [0, 9, 101])
def test_05_bad_analysis_scale_422(client, small_id, pct):
    assert client.post("/analyze", json={"image_id": small_id, "analysis_scale_pct": pct}).status_code == 422


def test_05_nan_in_body_422(client, small_id):
    body = '{"image_id": "%s", "threshold_percent": NaN}' % small_id
    r = client.post("/analyze", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 422


@pytest.mark.parametrize("field,val", [("threshold_percent", 0), ("threshold_percent", 101), ("reference_threshold", 1.5),
                                       ("max_cluster_axis", 0), ("max_cluster_axis", 201), ("min_surface", -1),
                                       ("min_roundness", 2), ("max_cost", -0.1), ("reference_physical_mm", 0)])
def test_05_field_ranges_422(client, small_id, field, val):
    assert client.post("/analyze", json={"image_id": small_id, field: val}).status_code == 422


# 6 ----------------------------------------------------------------------------------
def test_06_degenerate_reference_400(client, small_id):
    r = client.post("/analyze", json={"image_id": small_id, "reference_points": [[1, 1], [1, 1]], "reference_physical_mm": 10})
    assert r.status_code == 400 and isinstance(r.json()["detail"], str)


def test_06_malformed_points_422(client, small_id):
    assert client.post("/analyze", json={"image_id": small_id, "reference_points": [[1, 1, 5], [3, 3]],
                                         "reference_physical_mm": 10}).status_code == 422
    assert client.post("/analyze", json={"image_id": small_id, "polygon_points": [[1], [2], [3]]}).status_code == 422
    assert client.post("/analyze", json={"image_id": small_id, "reference_points": [[1, 1]] * 3,
                                         "reference_physical_mm": 10}).status_code == 422


def test_06_polygon_outside_image_400(client, small_id):
    poly = [[5000, 5000], [5100, 5000], [5100, 5100], [5000, 5100]]
    r = client.post("/analyze", json={"image_id": small_id, "polygon_points": poly})
    assert r.status_code == 400 and isinstance(r.json()["detail"], str)


def test_06_polygon_inside_restricts_clusters(client, small_id):
    full = client.post("/analyze", json={"image_id": small_id}).json()["nclusters"]
    poly = [[20.5, 20.5], [300.5, 20.5], [300.5, 400.5], [20.5, 400.5]]
    r = client.post("/analyze", json={"image_id": small_id, "polygon_points": poly})
    assert r.status_code == 200 and 0 < r.json()["nclusters"] < full


# 7 ----------------------------------------------------------------------------------
def test_07_bad_image_ids(client):
    assert client.post("/analyze", json={"image_id": "../x"}).status_code == 422
    assert client.post("/analyze", json={"image_id": MISSING}).status_code == 404
    assert client.get("/preview/not-a-uuid").status_code == 422
    assert client.get(f"/preview/{MISSING}").status_code == 404
    for bad in ("../../etc/passwd", "a" * 36, MISSING + "/../x"):
        assert client.post("/erase", json={"image_id": bad, "erase_points": [[1, 1]]}).status_code in (404, 422)


def test_07_preview_returns_image(client, small_id):
    r = client.get(f"/preview/{small_id}")
    assert r.status_code == 200
    assert r.json()["image_mime"] == "image/jpeg" and r.json()["image_b64"]


# 8 ----------------------------------------------------------------------------------
SPECS = [(300, 50, 8, 8, 0.0), (50, 250, 10, 7, 0.0), (200, 150, 9, 9, 0.0)]  # (col x, row y, ...)


@pytest.mark.parametrize("scale_pct", [100, 50])
def test_08_erase_hits_clicked_particle(client, upload, scale_pct):
    img, _ = crisp_ellipses(400, 300, SPECS)
    iid = upload(img)
    a = client.post("/analyze", json={"image_id": iid, "analysis_scale_pct": scale_pct, **REF})
    assert a.status_code == 200, a.text
    assert a.json()["nclusters"] == 3
    e = client.post("/erase", json={"image_id": iid, "erase_points": [[300, 50]], "erase_radius_px": 5})
    assert e.status_code == 200, e.text
    b = e.json()
    assert b["nclusters"] == 2 and len(b["removed_ids"]) == 1
    # erasing a click at x=50,y=250 would have hit the (50,250) particle only with swapped axes
    e2 = client.post("/erase", json={"image_id": iid, "erase_points": [[50, 250]], "erase_radius_px": 5,
                                     "already_removed_ids": b["removed_ids"]})
    assert e2.json()["nclusters"] == 1 and len(e2.json()["removed_ids"]) == 2
    # removed ids are real cluster ids from the analyze payload
    assert set(e2.json()["removed_ids"]) <= set(a.json()["particles"]["id"])


def test_08_erase_miss_removes_nothing(client, upload):
    img, _ = crisp_ellipses(400, 300, SPECS)
    iid = upload(img)
    client.post("/analyze", json={"image_id": iid, **REF})
    e = client.post("/erase", json={"image_id": iid, "erase_points": [[350, 280]], "erase_radius_px": 5})
    assert e.status_code == 200 and e.json()["removed_ids"] == [] and e.json()["nclusters"] == 3


# 9 ----------------------------------------------------------------------------------
def test_09_erase_validation(client, analysis):
    iid, _ = analysis
    assert client.post("/erase", json={"image_id": iid, "erase_points": []}).status_code == 422
    assert client.post("/erase", json={"image_id": iid, "erase_points": [[1, 1]], "erase_radius_px": -1}).status_code == 422
    assert client.post("/erase", json={"image_id": iid, "erase_points": [[1, 1]], "erase_radius_px": 0}).status_code == 422
    assert client.post("/erase", json={"image_id": MISSING, "erase_points": [[1, 1]]}).status_code == 404


def test_09_erase_response_has_no_particles(client, analysis):
    iid, _ = analysis
    r = client.post("/erase", json={"image_id": iid, "erase_points": [[10, 10]], "erase_radius_px": 5})
    assert r.status_code == 200
    b = r.json()
    assert "particles" not in b
    assert set(b) >= {"removed_ids", "nclusters", "cluster_layer_b64", "summary"}


# 10 ---------------------------------------------------------------------------------
def test_10_histogram_validation(client, analysis):
    iid, _ = analysis
    assert client.post("/histogram", json={"image_id": iid, "x_metric": "foo"}).status_code == 422
    assert client.post("/histogram", json={"image_id": iid, "weight_mode": "foo"}).status_code == 422
    assert client.post("/histogram", json={"image_id": iid, "bins": 0}).status_code == 422
    assert client.post("/histogram", json={"image_id": iid, "bins": 501}).status_code == 422


def test_10_histogram_without_scale_400(client, small_id):
    a = client.post("/analyze", json={"image_id": small_id})
    assert a.status_code == 200
    r = client.post("/histogram", json={"image_id": a.json()["analysis_id"]})
    assert r.status_code == 400 and isinstance(r.json()["detail"], str)


@pytest.mark.parametrize("metric", ["diameter", "surface", "volume", "extraction_yield"])
@pytest.mark.parametrize("weight", ["number", "mass"])
def test_10_histogram_series_without_png(client, analysis, metric, weight):
    iid, _ = analysis
    r = client.post("/histogram", json={"image_id": iid, "x_metric": metric, "weight_mode": weight, "include_png": False})
    assert r.status_code == 200, r.text
    assert_no_nonfinite(r.text)
    b = r.json()
    assert b["histogram_b64"] is None
    s = b["series"]
    edges, series = s["edges"], s["series"]
    assert len(series) == 1 and series[0]["label"]
    fractions = series[0]["fractions"]
    assert len(edges) == len(fractions) + 1
    assert all(np.isfinite(edges)) and np.all(np.diff(edges) > 0)
    assert sum(fractions) == pytest.approx(1.0, abs=1e-6)
    assert b["median"] > 0 and b["unit"] and b["axis_label"]


def test_10_histogram_png_default_and_removed_ids(client, analysis):
    iid, a = analysis
    r = client.post("/histogram", json={"image_id": iid, "removed_cluster_ids": a["particles"]["id"][:3]})
    assert r.status_code == 200 and r.json()["histogram_b64"]
    allgone = client.post("/histogram", json={"image_id": iid, "removed_cluster_ids": a["particles"]["id"]})
    assert allgone.status_code == 400


def test_10_histogram_weight_mode_honoured(client, analysis):
    iid, _ = analysis
    num = client.post("/histogram", json={"image_id": iid, "weight_mode": "number", "include_png": False}).json()
    mass = client.post("/histogram", json={"image_id": iid, "weight_mode": "mass", "include_png": False}).json()
    assert mass["median"] > num["median"]       # volume weighting shifts the median to coarser particles


# 11 ---------------------------------------------------------------------------------
def test_11_compare(client, small_id, analysis):
    iid, a = analysis
    b = client.post("/analyze", json={"image_id": small_id, "threshold_percent": 50, **REF}).json()
    assert b["analysis_id"] != a["analysis_id"]
    r = client.post("/histogram/compare", json={"runs": [
        {"image_id": a["analysis_id"], "label": "A"}, {"image_id": b["analysis_id"], "label": "B"}],
        "include_png": False})
    assert r.status_code == 200, r.text
    assert_no_nonfinite(r.text)
    body = r.json()
    assert len(body["per_run"]) == 2 and [p["label"] for p in body["per_run"]] == ["A", "B"]
    assert set(body["combined"]) >= {"mean_of_means", "median_of_medians"}


def test_11_compare_validation(client, analysis):
    iid, a = analysis
    assert client.post("/histogram/compare", json={"runs": []}).status_code == 422
    assert client.post("/histogram/compare", json={"runs": [{"image_id": a["analysis_id"]}] * 7}).status_code == 422
    assert client.post("/histogram/compare", json={"runs": [{"image_id": a["analysis_id"], "label": "x" * 61}]}).status_code == 422
    assert client.post("/histogram/compare", json={"runs": [{"image_id": MISSING}]}).status_code == 404
    assert client.post("/histogram/compare", json={"runs": [{"image_id": a["analysis_id"]}], "x_metric": "foo"}).status_code == 422


def test_11_frozen_analysis_id_survives_reanalysis(client, small_id, analysis):
    iid, a = analysis
    n_before = client.post("/histogram", json={"image_id": a["analysis_id"], "include_png": False}).json()["series"]
    client.post("/analyze", json={"image_id": small_id, "threshold_percent": 30, **REF})
    n_after = client.post("/histogram", json={"image_id": a["analysis_id"], "include_png": False}).json()["series"]
    assert n_before == n_after


# 12 ---------------------------------------------------------------------------------
def test_12_single_cluster_dataset(client, upload):
    img, _ = crisp_ellipses(200, 150, [(100, 75, 9, 9, 0.0)])
    iid = upload(img)
    r = client.post("/analyze", json={"image_id": iid, **REF})
    assert r.status_code == 200, r.text
    assert_no_nonfinite(r.text)
    b = r.json()
    assert b["nclusters"] == 1
    assert b["summary"] is not None and b["summary"]["surface_quality"] is None
    h = client.post("/histogram", json={"image_id": iid, "include_png": False})
    assert h.status_code == 200, h.text


def test_12_zero_clusters(client, upload):
    img, _ = crisp_ellipses(200, 150, [])
    r = client.post("/analyze", json={"image_id": upload(img), **REF})
    assert r.status_code == 200, r.text
    assert r.json()["nclusters"] == 0 and r.json()["summary"] is None


# 13 ---------------------------------------------------------------------------------
def test_13_health_no_auth(client):
    r = client.get("/health")
    assert r.status_code == 200
    b = r.json()
    assert b["status"] == "ok" and isinstance(b["warm"], bool) and isinstance(b["version"], str)


def test_13_auth_required_when_not_local_dev(client, main_module, monkeypatch, small_id):
    monkeypatch.setattr(main_module, "_LOCAL_DEV", False)
    assert client.get("/health").status_code == 200
    assert client.post("/analyze", json={"image_id": small_id}).status_code == 401
    assert client.post("/analyze", json={"image_id": small_id}, headers={"Authorization": "Bearer junk"}).status_code == 401
    assert client.post("/upload", files={"file": ("x.png", b"x", "image/png")}).status_code == 401
    assert client.get(f"/preview/{small_id}").status_code == 401


def test_13_startup_fails_without_allowlist(main_module, monkeypatch):
    monkeypatch.setattr(main_module, "_LOCAL_DEV", False)
    monkeypatch.setattr(main_module, "_ALLOWED_EMAILS", set())
    with pytest.raises(RuntimeError):
        main_module._check_config()


def test_13_unverified_or_unlisted_email_rejected(main_module, monkeypatch):
    import types, sys
    from fastapi import HTTPException
    monkeypatch.setattr(main_module, "_LOCAL_DEV", False)
    monkeypatch.setattr(main_module, "_ALLOWED_EMAILS", {"ok@example.com"})
    fake_auth = types.SimpleNamespace(verify_id_token=lambda token, app=None: {"email": "ok@example.com", "email_verified": False})
    fake_pkg = types.ModuleType("firebase_admin")
    fake_pkg.auth = fake_auth
    monkeypatch.setitem(sys.modules, "firebase_admin", fake_pkg)
    monkeypatch.setitem(sys.modules, "firebase_admin.auth", fake_auth)
    monkeypatch.setattr(main_module, "_get_firebase_app", lambda: None)
    with pytest.raises(HTTPException) as e:
        main_module._verify_token("Bearer t")
    assert e.value.status_code == 403
    fake_auth.verify_id_token = lambda token, app=None: {"email": "ok@example.com", "email_verified": True}
    main_module._verify_token("Bearer t")           # allowed
    fake_auth.verify_id_token = lambda token, app=None: {"email": "evil@example.com", "email_verified": True}
    with pytest.raises(HTTPException):
        main_module._verify_token("Bearer t")


# 14 ---------------------------------------------------------------------------------
def test_14_timing_and_request_id_headers(client, small_id):
    for r in (client.get("/health"),
              client.post("/analyze", json={"image_id": small_id}),
              client.post("/analyze", json={"image_id": "bad"}),
              client.get(f"/preview/{MISSING}")):
        assert re.search(r"total;dur=\d+(\.\d+)?", r.headers["server-timing"])
        assert r.headers["x-request-id"]
    ids = {client.get("/health").headers["x-request-id"] for _ in range(3)}
    assert len(ids) == 3


def test_14_gzip_on_analyze(client, small_id):
    r = client.post("/analyze", json={"image_id": small_id}, headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"
    assert r.json()["nclusters"] > 0     # TestClient transparently decodes


def test_14_cors_headers(client):
    r = client.options("/analyze", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
                                            "Access-Control-Request-Headers": "authorization,content-type"})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "http://localhost:5173"
    bad = client.options("/analyze", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers


def test_14_errors_are_json_detail(client):
    r = client.post("/upload", files={"file": ("x.png", b"hello", "image/png")})
    assert isinstance(r.json()["detail"], str)
    r = client.post("/histogram/compare", json={"runs": []})
    assert r.status_code == 422 and isinstance(r.json()["detail"], list)


# 15 ---------------------------------------------------------------------------------
def test_15_npz_round_trip_no_pickle(main_module, analysis):
    iid, _ = analysis
    stored = main_module._load_result(iid)
    raw = main_module._serialize_result(stored)
    assert raw[:2] == b"PK"                                           # npz is a zip
    with np.load(io.BytesIO(raw), allow_pickle=False) as z:           # must load without pickle
        assert {"cluster_id", "px_offsets", "x_pixels", "y_pixels", "meta"} <= set(z.files)
        assert z["x_pixels"].dtype == np.int32
        meta = json.loads(bytes(z["meta"].tobytes()).decode())
        assert meta["version"] == 1 and meta["shape"] == list(stored.shape)
    back = main_module._deserialize_result(raw)
    assert back.shape == stored.shape and back.analysis_scale == stored.analysis_scale
    assert back.dataset.pixel_scale == stored.dataset.pixel_scale
    assert back.dataset.nclusters == stored.dataset.nclusters
    for a, b in zip(stored.dataset.clusters, back.dataset.clusters):
        assert a.cluster_id == b.cluster_id
        for f in ("surface", "roundness", "short_axis", "long_axis", "volume", "xmean", "ymean"):
            assert getattr(a, f) == getattr(b, f)
        np.testing.assert_array_equal(np.sort(a.x_pixels), np.sort(b.x_pixels))
        np.testing.assert_array_equal(a.x_pixels, b.x_pixels)
        np.testing.assert_array_equal(a.y_pixels, b.y_pixels)
        assert getattr(a, "edge_weight", 1.0) == pytest.approx(getattr(b, "edge_weight", 1.0))
    assert main_module._cluster_layer_b64(back.shape, back.dataset) == main_module._cluster_layer_b64(stored.shape, stored.dataset)


def test_15_pickle_payload_is_not_loaded(main_module):
    import pickle
    with pytest.raises(Exception):
        main_module._deserialize_result(pickle.dumps({"x": 1}))


# extras: new model fields accepted by the API ----------------------------------------
def test_model_fields_accepted_and_validated(client, small_id):
    ok = client.post("/analyze", json={"image_id": small_id, **REF, "background_model": "global", "threshold_mode": "fixed",
                                       "edge_correction": False, "axis_method": "moments", "volume_model": "spheroid",
                                       "min_diameter_um": 100})
    assert ok.status_code == 200, ok.text
    assert client.post("/analyze", json={"image_id": small_id, "background_model": "bogus"}).status_code == 422
    assert client.post("/analyze", json={"image_id": small_id, "threshold_mode": "bogus"}).status_code == 422


def test_scale_uncertainty_reported_with_reference(client, small_id):
    s = client.post("/analyze", json={"image_id": small_id, **REF}).json()["summary"]
    assert s["diameter_scale_unc_pct"] == pytest.approx(2 ** 0.5 * 2.0 / 200.0 * 100, rel=0.02)   # 200 px reference, sigma 2
    assert s["detection_limit_um"] > 0 and "dv_ci95" in s
