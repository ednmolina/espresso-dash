"""Regenerate grind.png: 800x600, 6x4 grid of dark soft-edged discs on a vignetted light background.

Disc centres are known (see GRID in analyzer.spec.js) so the e2e tests can click on a real particle.
Usage: python make_fixture.py [out.png]
"""
import sys
import numpy as np
from PIL import Image

W, H = 800, 600
COLS = [100 + 120 * i for i in range(6)]   # x
ROWS = [120 + 120 * j for j in range(4)]   # y
rng = np.random.default_rng(7)
yy, xx = np.mgrid[0:H, 0:W]
bg = 235 - 20 * (((xx - W / 2) / W) ** 2 + ((yy - H / 2) / H) ** 2)
img = np.stack([bg * 0.98, bg * 0.97, bg], -1)
for cy in ROWS:
    for cx in COLS:
        r = rng.uniform(7, 12)
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
        a = np.clip(1.4 - d, 0, 1)[..., None]
        img = img * (1 - a) + np.array([80, 50, 30]) * a
img += rng.normal(0, 2, img.shape)
Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(sys.argv[1] if len(sys.argv) > 1 else "grind.png")
