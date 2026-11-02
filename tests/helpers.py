"""Helpers shared by core tests."""
from __future__ import annotations

import dataclasses

from coffeegrindsize_core import AnalysisSettings


def legacy_settings(**kw) -> AnalysisSettings:
    """Settings reproducing the e299811 behaviour (global bg, fixed threshold, no edge corr.).

    Uses ``AnalysisSettings.legacy()`` once the model builder provides it; until then the
    plain defaults are the legacy behaviour.
    """
    factory = getattr(AnalysisSettings, "legacy", None)
    base = factory() if callable(factory) else AnalysisSettings()
    return dataclasses.replace(base, **kw)


def modern_settings(**kw) -> AnalysisSettings:
    """Current defaults (poly4 / half_contrast / edge_correction ON when they exist)."""
    return dataclasses.replace(AnalysisSettings(), **kw)


def run_image(img, settings=None, **kw):
    """Analyze an RGB uint8 array / PIL image. Defaults: modern settings, pixel_scale=1."""
    from PIL import Image
    from coffeegrindsize_core import analyze_image
    if not hasattr(img, "convert"):
        img = Image.fromarray(img)
    if settings is None:
        kw.setdefault("pixel_scale", 1.0)
        settings = modern_settings(**kw)
    return analyze_image(img, settings)


def matched(res, idmap):
    """Map truth-index -> [clusters] (clusters overlapping no truth go under -1)."""
    import numpy as np
    out = {}
    for c in res.dataset.clusters:
        ids = idmap[c.x_pixels, c.y_pixels]
        ids = ids[ids > 0]
        if ids.size == 0:
            out.setdefault(-1, []).append(c)
            continue
        out.setdefault(int(np.bincount(ids).argmax()) - 1, []).append(c)
    return out


def d_area(cluster):
    import numpy as np
    return 2.0 * np.sqrt(cluster.surface / np.pi)
