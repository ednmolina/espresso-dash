"""Regenerate touching.png: 800x600, dark soft-edged discs in tangent pairs and chains on a light background.

Used by the e2e tests of "Separate touching particles": most particles touch at a narrow neck, so
the separated run finds clumps to cut. The scale clicks of setScale() (y = 40) stay on blank paper.
Usage: python make_touching_fixture.py [out.png]
"""
import sys
import numpy as np
from PIL import Image

W, H = 800, 600
rng = np.random.default_rng(11)
yy, xx = np.mgrid[0:H, 0:W]
bg = 235 - 20 * (((xx - W / 2) / W) ** 2 + ((yy - H / 2) / H) ** 2)
img = np.stack([bg * 0.98, bg * 0.97, bg], -1)

discs = []
# tangent pairs, one per grid cell, at varying angles
for cy in (150, 270, 390, 510):
    for cx in (110, 250, 390, 530, 670):
        r1, r2 = rng.uniform(13, 20, 2)
        ang = rng.uniform(0, np.pi)
        d = r1 + r2 - 1.5
        discs.append((cx, cy, r1))
        discs.append((cx + d * np.cos(ang), cy + d * np.sin(ang), r2))
# a few singles, so not everything is a clump
for cx, cy in ((60, 330), (740, 200), (740, 450)):
    discs.append((cx, cy, 14))

for cx, cy, r in discs:
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
    a = np.clip(1.4 - dist, 0, 1)[..., None]
    img = img * (1 - a) + np.array([80, 50, 30]) * a
img += rng.normal(0, 2, img.shape)
Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(sys.argv[1] if len(sys.argv) > 1 else "touching.png")
