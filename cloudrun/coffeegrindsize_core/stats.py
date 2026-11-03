"""Statistics helpers: weighted percentiles, log-normal moments, bootstrap CI, edge correction."""
from __future__ import annotations

from typing import Iterable

import numpy as np

MAX_EDGE_WEIGHT = 10.0
BOOTSTRAP_B = 200
FINES_RELIABLE_LIMIT_UM = 100.0


def weighted_percentiles(values: np.ndarray, weights: np.ndarray, percentiles: Iterable[float]) -> list[float]:
    """Percentiles of ``values`` where each sample counts in proportion to ``weights``.

    Midpoint rule (each sample at the centre of its weight interval); equals
    ``np.percentile(method="hazen")`` for equal weights.
    """
    values = np.asarray(values, dtype=float)
    weights = np.asarray(weights, dtype=float)
    percentiles = list(percentiles)
    order = np.argsort(values)
    sorted_values = values[order]
    cumulative = np.cumsum(weights[order])
    total = cumulative[-1]
    if total <= 0:
        return [float(np.percentile(values, p)) for p in percentiles]
    positions = (cumulative - 0.5 * weights[order]) / total * 100.0
    return [float(np.interp(p, positions, sorted_values)) for p in percentiles]


def detection_limit_um(min_surface: float, pixel_scale: float) -> float:
    """Diameter (um) of a disc of ``min_surface`` pixels."""
    return float(2000.0 * np.sqrt(max(min_surface, 0.0) / np.pi) / pixel_scale)


def reliable_limit_um(pixel_scale: float) -> float:
    """Diameter (um) of ~6 pixels, below which sizes are biased (blur/thresholding)."""
    return float(6000.0 / pixel_scale)


def geometric_stats(values: np.ndarray, weights: np.ndarray) -> tuple[float, float]:
    """Weighted geometric mean and geometric standard deviation."""
    w = np.asarray(weights, dtype=float)
    ln = np.log(np.asarray(values, dtype=float))
    total = w.sum()
    gm_ln = float(np.sum(w * ln) / total)
    var = float(np.sum(w * (ln - gm_ln) ** 2) / total)
    return float(np.exp(gm_ln)), float(np.exp(np.sqrt(max(var, 0.0))))


def volume_mode(values: np.ndarray, weights: np.ndarray, bins_per_decade: int = 40) -> float | None:
    """Peak of the smoothed, log-binned weighted size histogram (centre of the peak bin)."""
    values = np.asarray(values, dtype=float)
    ok = values > 0
    if ok.sum() < 3:
        return None
    ln = np.log10(values[ok])
    lo, hi = ln.min(), ln.max()
    if hi - lo < 1e-9:
        return float(values[ok][0])
    n_bins = max(int(np.ceil((hi - lo) * bins_per_decade)), 8)
    hist, edges = np.histogram(ln, bins=n_bins, range=(lo, hi), weights=np.asarray(weights, float)[ok])
    kernel = np.array([1.0, 2.0, 3.0, 2.0, 1.0])
    kernel /= kernel.sum()
    smooth = np.convolve(hist, kernel, mode="same")
    peak = int(np.argmax(smooth))
    return float(10.0 ** (0.5 * (edges[peak] + edges[peak + 1])))


def bootstrap_percentile_ci(
    values: np.ndarray,
    weights: np.ndarray,
    percentiles: Iterable[float] = (10.0, 50.0, 90.0),
    n_boot: int = BOOTSTRAP_B,
    seed: int = 0,
) -> list[list[float]]:
    """Seeded bootstrap 95 % interval of weighted percentiles (resampling particles)."""
    values = np.asarray(values, dtype=float)
    weights = np.asarray(weights, dtype=float)
    percentiles = np.asarray(list(percentiles), dtype=float)
    n = values.size
    order = np.argsort(values)
    sv = values[order]
    sw = weights[order]
    rng = np.random.default_rng(seed)
    out = np.empty((n_boot, percentiles.size))
    uniform = np.full(n, 1.0 / n)
    for b in range(n_boot):
        # resampling n particles with replacement == multinomial multiplicities
        w = sw * rng.multinomial(n, uniform)
        cumulative = np.cumsum(w)
        total = cumulative[-1]
        if total <= 0:
            out[b] = np.nan
            continue
        positions = (cumulative - 0.5 * w) / total * 100.0
        out[b] = np.interp(percentiles, positions, sv)
    lo = np.nanpercentile(out, 2.5, axis=0)
    hi = np.nanpercentile(out, 97.5, axis=0)
    return [[float(a), float(b)] for a, b in zip(lo, hi)]


def scale_relative_uncertainty(reference_px_length: float | None, click_sigma_px: float) -> float | None:
    """Relative 1-sigma uncertainty of the px/mm scale from two imprecise clicks."""
    if reference_px_length is None or not np.isfinite(reference_px_length) or reference_px_length <= 0:
        return None
    return float(np.sqrt(2.0) * click_sigma_px / reference_px_length)


def distribution_stats(values: np.ndarray, weights: np.ndarray | None = None) -> dict:
    """Mean/median and percentile spread of a (weighted) distribution.

    Keys ``*_upper``/``*_lower`` are kept for compatibility; ``*_spread_*`` are the same
    numbers under their correct name: they describe the spread of the distribution
    (p16-p84 around the mean, IQR around the median), not an error on the mean.
    """
    values = np.asarray(values, dtype=float)
    w = np.ones_like(values) if weights is None else np.asarray(weights, dtype=float)
    ok = np.isfinite(values) & np.isfinite(w) & (w >= 0)
    values, w = values[ok], w[ok]
    if values.size == 0 or w.sum() <= 0:
        raise ValueError("No data available for distribution statistics.")
    mean = float(np.sum(values * w) / np.sum(w))
    p16, p25, p50, p75, p84 = weighted_percentiles(values, w, (16, 25, 50, 75, 84))
    return {
        "mean": mean, "mean_upper": p84 - mean, "mean_lower": mean - p16,
        "median": p50, "median_upper": p75 - p50, "median_lower": p50 - p25,
        "mean_spread_upper": p84 - mean, "mean_spread_lower": mean - p16,
        "median_spread_upper": p75 - p50, "median_spread_lower": p50 - p25,
        "p16": p16, "p25": p25, "p75": p75, "p84": p84,
        "n": int(values.size), "n_eff": float(np.sum(w) ** 2 / np.sum(w ** 2)),
    }


# --------------------------------------------------------------------------- edge correction
def edge_weights(
    x_pixels: list[np.ndarray],
    y_pixels: list[np.ndarray],
    image_shape: tuple[int, int],
    polygon_mask: np.ndarray | None = None,
) -> np.ndarray:
    """Miles-Lantuejoul weights for particles rejected when touching the region border.

    A particle with bounding box (bw, bh) can only be observed if its box lies fully inside the
    region, so each detected particle represents 1/P(box fits) particles. Rectangle:
    w = W*H / ((W-bw)(H-bh)). Polygon: A_poly / A(polygon eroded by the box), evaluated on
    log-spaced box sizes with a summed-area table on a downsampled mask.
    ``x_pixels`` are image rows, ``y_pixels`` image columns (as in Cluster).
    """
    n = len(x_pixels)
    rows, cols = image_shape
    bh = np.array([float(x.max() - x.min() + 1) for x in x_pixels]) if n else np.zeros(0)
    bw = np.array([float(y.max() - y.min() + 1) for y in y_pixels]) if n else np.zeros(0)
    if n == 0:
        return np.ones(0)
    if polygon_mask is None:
        denom = np.maximum(cols - bw, 1.0) * np.maximum(rows - bh, 1.0)
        return np.minimum(rows * cols / denom, MAX_EDGE_WEIGHT)

    f = max(1, int(np.ceil(np.sqrt(rows * cols / 250_000.0))))
    m = polygon_mask[::f, ::f]
    a_poly = float(m.sum())
    if a_poly <= 0:
        return np.ones(n)
    sat = np.zeros((m.shape[0] + 1, m.shape[1] + 1), dtype=np.int32)
    np.cumsum(np.cumsum(m, axis=0, dtype=np.int32), axis=1, out=sat[1:, 1:])

    def anchors(h: int, w: int) -> float:
        h = min(h, m.shape[0])
        w = min(w, m.shape[1])
        box = sat[h:, w:] - sat[:-h, w:] - sat[h:, :-w] + sat[:-h, :-w]
        return float(np.count_nonzero(box == h * w))

    bin_h = np.round(2.0 * np.log2(np.maximum(bh, 1.0))).astype(int)
    bin_w = np.round(2.0 * np.log2(np.maximum(bw, 1.0))).astype(int)
    cache: dict[tuple[int, int], float] = {}
    out = np.empty(n)
    for k in range(n):
        key = (int(bin_h[k]), int(bin_w[k]))
        if key not in cache:
            h = max(1, int(round(2.0 ** (key[0] / 2.0) / f)))
            w = max(1, int(round(2.0 ** (key[1] / 2.0) / f)))
            cnt = anchors(h, w)
            cache[key] = MAX_EDGE_WEIGHT if cnt <= 0 else min(a_poly / cnt, MAX_EDGE_WEIGHT)
        out[k] = cache[key]
    return out
