"""NumPy reference for the true ellipse fit (feature A) of the on-device analyzer.

Mirrors React/frontend/src/analysis/detect.js ``remeasureClusters`` (moment columns,
``volume_model: 'ellipsoid'``) and summary.js ``shapeSummaryOrNone``. Numpy only (no scipy), and it
never edits cloudrun/: it reuses the core's own dataset objects.

Definitions (see COMMON §4 of the spec):

* second moments of the pixel centres plus the unit-square variance 1/12;
* ``lam1 = half_trace + root`` (the exact expression of the core's ``_remeasure_clusters``),
  ``lam2 = max(half_trace - root, 1/12)``;
* ``major = 2*sqrt(lam1)``, ``minor = 2*sqrt(lam2)`` (semi-axes), ``aspect = major / minor``;
* ellipsoid volume (thickness = width, area-normalised): ``B = sqrt(S / (pi * AR))``,
  ``V = (4/3 * S) * B``.
"""
from __future__ import annotations

import math

import numpy as np

ASPECT_MIN_PX = 20
ASPECT_MIN_COUNT = 10


def moment_axes(clusters):
    """(major, minor, aspect) float64 arrays, one entry per cluster.

    Same operations as ``coffeegrindsize_core.analysis._remeasure_clusters`` (``np.bincount``
    sequential sums, +1/12, same expression order), plus the second eigenvalue.
    """
    if not clusters:
        z = np.zeros(0, dtype=np.float64)
        return z, z.copy(), z.copy()
    lens = np.array([c.x_pixels.size for c in clusters])
    xs = np.concatenate([c.x_pixels for c in clusters]).astype(np.float64)
    ys = np.concatenate([c.y_pixels for c in clusters]).astype(np.float64)
    idx = np.repeat(np.arange(len(clusters)), lens)
    n = lens.astype(np.float64)
    mx = np.bincount(idx, xs, len(clusters)) / n
    my = np.bincount(idx, ys, len(clusters)) / n
    dx = xs - mx[idx]
    dy = ys - my[idx]
    sxx = np.bincount(idx, dx * dx, len(clusters)) / n + 1.0 / 12.0
    syy = np.bincount(idx, dy * dy, len(clusters)) / n + 1.0 / 12.0
    sxy = np.bincount(idx, dx * dy, len(clusters)) / n
    half_trace = 0.5 * (sxx + syy)
    root = np.sqrt(np.maximum(0.25 * (sxx - syy) ** 2 + sxy**2, 0.0))
    lam1 = half_trace + root
    lam2 = np.maximum(half_trace - root, 1.0 / 12.0)
    major = 2.0 * np.sqrt(lam1)
    minor = 2.0 * np.sqrt(lam2)
    return major, minor, major / minor


def ellipsoid_volumes(surfaces, aspect):
    """``B = sqrt(S / (pi * AR))``; ``V = (4/3 * S) * B``, scalar Python floats in this order."""
    out = np.empty(len(surfaces), dtype=np.float64)
    for k, (s, ar) in enumerate(zip(surfaces, aspect)):
        s = float(s)
        b = math.sqrt(s / (math.pi * float(ar)))
        out[k] = ((4.0 / 3.0) * s) * b
    return out


def _stable_percentiles(values, weights, percentiles):
    """weighted_percentiles with a stable sort (what the JS port does)."""
    order = np.argsort(values, kind="stable")
    sv = values[order]
    cum = np.cumsum(weights[order])
    pos = (cum - 0.5 * weights[order]) / cum[-1] * 100.0
    return [float(np.interp(p, pos, sv)) for p in percentiles]


def shape_summary(dataset, major, minor, aspect):
    """The ``shape_summary`` dict of COMMON §3, or None for an empty dataset.

    ``dataset`` is a core ParticleDataset whose clusters align with ``major/minor/aspect``.
    """
    from coffeegrindsize_core import filter_by_min_diameter

    if dataset.nclusters == 0:
        return None
    aspect_by_id = {int(c.cluster_id): float(a) for c, a in zip(dataset.clusters, aspect)}
    scale = dataset.pixel_scale
    if isinstance(scale, (int, float)) and scale > 0:
        scale = float(scale)
        fds = filter_by_min_diameter(dataset, scale, (dataset.meta or {}).get("min_diameter_um"))
    else:
        fds = dataset
        scale = 1.0
    ar, w = [], []
    for c in fds.clusters:
        a = aspect_by_id[int(c.cluster_id)]
        if c.surface >= ASPECT_MIN_PX and math.isfinite(a):
            d = (2.0 * math.sqrt(c.long_axis * c.short_axis)) / scale
            ar.append(a)
            w.append(((math.pi / 6.0) * d**3) * c.edge_weight)
    kept = len(ar)
    p10 = p50 = p90 = None
    if kept >= ASPECT_MIN_COUNT:
        p10, p50, p90 = _stable_percentiles(np.array(ar, dtype=np.float64), np.array(w, dtype=np.float64),
                                            (10.0, 50.0, 90.0))
    return {"aspect_ratio_median": p50, "aspect_ratio_p10": p10, "aspect_ratio_p90": p90,
            "aspect_ratio_n": kept, "min_px": ASPECT_MIN_PX}
