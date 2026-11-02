"""Coarse performance guards (generous limits; catch algorithmic regressions, not noise)."""
import os
import subprocess
import sys
import time

import numpy as np
import pytest
from PIL import Image

from coffeegrindsize_core import analyze_image
import coffeegrindsize_core as core
from tests.helpers import legacy_settings, modern_settings

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def adversarial(w, h, cover=0.45, R=55, seed=1):
    """Large textured dark clumps: used to make the old nearest-dark / path search quadratic."""
    rng = np.random.default_rng(seed)
    img = np.full((h, w), 235.0)
    yy, xx = np.mgrid[0:h, 0:w]
    dark = np.zeros((h, w), bool)
    while dark.mean() < cover:
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        r = rng.uniform(R * 0.6, R)
        x0, x1 = max(0, int(cx - r)), min(w, int(cx + r) + 1)
        y0, y1 = max(0, int(cy - r)), min(h, int(cy + r) + 1)
        dark[y0:y1, x0:x1] |= (xx[y0:y1, x0:x1] - cx) ** 2 + (yy[y0:y1, x0:x1] - cy) ** 2 <= r * r
    img[dark] = rng.uniform(30, 110, dark.sum())
    img = np.clip(img + rng.normal(0, 5, img.shape), 0, 255)
    return Image.fromarray(np.stack([img * 0.9, img * 0.8, img], -1).astype(np.uint8))


@pytest.fixture(scope="module", autouse=True)
def _warm():
    core.warm_up()


def test_adversarial_1200x900_full_under_budget():
    img = adversarial(1200, 900)
    t = time.perf_counter()
    res = analyze_image(img, legacy_settings(pixel_scale=10.0))
    dt = time.perf_counter() - t
    assert res.dataset.nclusters >= 1
    assert dt < 4.0, f"{dt:.2f}s (perf spec target < 2s on a warm cache; was 30s+ before the fix)"


def test_modern_pipeline_adds_little_overhead():
    img = adversarial(1200, 900, cover=0.2, R=25)
    t = time.perf_counter(); analyze_image(img, legacy_settings(pixel_scale=10.0)); t_leg = time.perf_counter() - t
    t = time.perf_counter(); analyze_image(img, modern_settings(pixel_scale=10.0)); t_mod = time.perf_counter() - t
    assert t_mod < t_leg + 3.0, (t_leg, t_mod)


def test_kernel_cache_load_is_fast(tmp_path):
    """Second process start with a populated numba cache must not recompile (~6.5 s cold)."""
    env = dict(os.environ, NUMBA_CACHE_DIR=str(tmp_path / "nbc"), PYTHONPATH=os.path.join(ROOT, "cloudrun"))
    code = "import time,coffeegrindsize_core as c;t=time.perf_counter();c.warm_up();print(time.perf_counter()-t)"
    first = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=110)
    assert first.returncode == 0, first.stderr
    second = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=110)
    assert second.returncode == 0, second.stderr
    cold, warm = float(first.stdout.strip().splitlines()[-1]), float(second.stdout.strip().splitlines()[-1])
    assert warm < 2.0, (cold, warm)
    assert warm < cold
