"""Deterministic synthetic grind images. Pure NumPy/PIL; no repo imports."""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np
from PIL import Image


def soft_field(w: int, h: int, n: int, seed: int = 0) -> Image.Image:
    """Soft log-normal ellipses on a vignetted background (bench/gen.py)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    bg = 235 - 25 * (((xx - w / 2) / w) ** 2 + ((yy - h / 2) / h) ** 2)
    img = np.stack([bg * 0.98, bg * 0.97, bg], -1)
    for _ in range(n):
        r = float(np.clip(rng.lognormal(np.log(4.0), 0.55), 1.2, 30))
        e = rng.uniform(0.6, 1.0); th = rng.uniform(0, np.pi)
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        R = int(r) + 3
        x0, x1 = max(0, int(cx) - R), min(w, int(cx) + R + 1)
        y0, y1 = max(0, int(cy) - R), min(h, int(cy) + R + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        X = xx[y0:y1, x0:x1] - cx; Y = yy[y0:y1, x0:x1] - cy
        u = X * np.cos(th) + Y * np.sin(th); v = -X * np.sin(th) + Y * np.cos(th)
        d = np.sqrt((u / r) ** 2 + (v / (r * e)) ** 2)
        a = np.clip(1.3 - d, 0, 1)
        col = np.array([95, 60, 35]) * rng.uniform(0.6, 1.1)
        sub = img[y0:y1, x0:x1]
        img[y0:y1, x0:x1] = sub * (1 - a[..., None]) + col * a[..., None]
    img += rng.normal(0, 3, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


@dataclass(frozen=True)
class TrueParticle:
    cx: float
    cy: float
    a: float      # semi-major (px)
    b: float      # semi-minor (px)
    theta: float

    @property
    def area(self) -> float:
        return float(np.pi * self.a * self.b)


def crisp_ellipses(w=400, h=300, specs=None, bg=230, ink=50, noise=0.0, seed=0, vignette=0.0):
    """Hard-edged, well separated, uniform-dark ellipses with known geometry.

    specs: list of (cx, cy, a, b, theta). Returns (PIL image, [TrueParticle]).
    """
    rng = np.random.default_rng(seed)
    if specs is None:
        specs, gx = [], 0
        for i, a in enumerate([4, 6, 8, 10, 12, 15]):
            for j, ratio in enumerate([1.0, 0.6]):
                specs.append((40 + i * 60, 70 + j * 140, a, a * ratio, 0.3 * i))
    yy, xx = np.mgrid[0:h, 0:w] + 0.0
    base = bg - vignette * (((xx - w / 2) / w) ** 2 + ((yy - h / 2) / h) ** 2)
    img = np.repeat(base[..., None], 3, -1)
    truth = []
    for cx, cy, a, b, th in specs:
        u = (xx - cx) * np.cos(th) + (yy - cy) * np.sin(th)
        v = -(xx - cx) * np.sin(th) + (yy - cy) * np.cos(th)
        img[(u / a) ** 2 + (v / b) ** 2 <= 1.0] = ink
        truth.append(TrueParticle(cx, cy, a, b, th))
    if noise:
        img += rng.normal(0, noise, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)), truth
