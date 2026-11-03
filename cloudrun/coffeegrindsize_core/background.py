"""Illumination flattening and contrast-based threshold selection (vectorised numpy)."""
from __future__ import annotations

import numpy as np

CLIP_GAIN = (0.5, 1.5)
HALF_CONTRAST_BOUNDS = (50.0, 80.0)
MIN_CONTRAST_CLUSTERS = 10
CONTRAST_CLUSTER_MIN_PIXELS = 150
MAX_CONTRAST_CLUSTERS = 600
MAX_FIT_POINTS = 60_000


def _dilate3(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    out[1:] |= mask[:-1]
    out[:-1] |= mask[1:]
    out[:, 1:] |= out[:, :-1].copy()
    out[:, :-1] |= out[:, 1:].copy()
    return out


def flatten_blue(
    blue: np.ndarray,
    polygon_mask: np.ndarray | None,
    global_threshold_percent: float,
    degree: int = 4,
    step: int = 4,
) -> tuple[np.ndarray, dict]:
    """Divide out a smooth illumination field (2D polynomial fit on background pixels).

    Fit uses strided samples of pixels that are not dark (below the global threshold, dilated)
    and, when given, inside the polygon, with one 3*MAD robust refit. The result is
    ``blue * median(B) / B`` with the gain clipped to [0.5, 1.5], returned as uint8.
    """
    rows, cols = blue.shape
    info: dict = {"applied": False}
    bs = blue[::step, ::step].astype(np.float32)
    ms = polygon_mask[::step, ::step] if polygon_mask is not None else None
    ref0 = float(np.median(bs[ms])) if ms is not None and ms.any() else float(np.median(bs))
    dark = _dilate3(bs < ref0 * global_threshold_percent / 100.0)
    valid = ~dark if ms is None else (~dark & ms)
    if valid.sum() < 10 * (degree + 1) * (degree + 2):
        return blue, info

    ys = (np.arange(0, rows, step) / rows * 2.0 - 1.0)
    xs = (np.arange(0, cols, step) / cols * 2.0 - 1.0)
    vy, vx = np.nonzero(valid)
    if vy.size > MAX_FIT_POINTS:  # plenty of samples for 15 coefficients
        pick = np.linspace(0, vy.size - 1, MAX_FIT_POINTS).astype(np.intp)
        vy, vx = vy[pick], vx[pick]
    X = xs[vx]
    Y = ys[vy]
    z = bs[vy, vx].astype(np.float64)
    xp = [np.ones_like(X)]
    yp = [np.ones_like(Y)]
    for _ in range(degree):
        xp.append(xp[-1] * X)
        yp.append(yp[-1] * Y)
    terms = [(i, j) for i in range(degree + 1) for j in range(degree + 1 - i)]
    A = np.stack([xp[i] * yp[j] for i, j in terms], axis=1)

    def solve(mat: np.ndarray, rhs: np.ndarray) -> np.ndarray:
        # normal equations: 15x15 system, well conditioned for coordinates in [-1, 1]
        return np.linalg.solve(mat.T @ mat, mat.T @ rhs)

    coef = solve(A, z)
    resid = z - A @ coef
    sigma = 1.4826 * np.median(np.abs(resid)) + 1e-6
    keep = np.abs(resid) < 3.0 * sigma
    if keep.sum() > 5 * len(terms):
        coef = solve(A[keep], z[keep])

    C = np.zeros((degree + 1, degree + 1))
    for c, (i, j) in zip(coef, terms):
        C[i, j] = c
    y_full = np.arange(rows, dtype=np.float64) / rows * 2.0 - 1.0
    x_full = np.arange(cols, dtype=np.float64) / cols * 2.0 - 1.0
    # P_i(y) = sum_j C[i, j] y^j ; B(y, x) = sum_i P_i(y) x^i  (separable evaluation)
    ypow = np.stack([y_full ** j for j in range(degree + 1)], axis=1)
    P = (ypow @ C.T).astype(np.float32)  # rows x (degree+1)
    xpow = np.stack([x_full ** i for i in range(degree + 1)], axis=0).astype(np.float32)  # (degree+1) x cols

    # reference level: median of the model over the (strided) analysis area
    Bs = (P[::step] @ xpow[:, ::step])
    ref = float(np.median(Bs[ms])) if ms is not None and ms.any() else float(np.median(Bs))
    if not np.isfinite(ref) or ref <= 1.0:
        return blue, info

    out = np.empty((rows, cols), dtype=np.uint8)
    chunk = max(1, int(1_000_000 // max(cols, 1)))
    lo, hi = CLIP_GAIN
    for r0 in range(0, rows, chunk):
        r1 = min(rows, r0 + chunk)
        Bm = P[r0:r1] @ xpow
        np.maximum(Bm, 1.0, out=Bm)
        np.divide(ref, Bm, out=Bm)
        np.clip(Bm, lo, hi, out=Bm)
        Bm *= blue[r0:r1]
        Bm += 0.5
        np.clip(Bm, 0.0, 255.0, out=Bm)
        out[r0:r1] = Bm
    info.update(applied=True, reference_level=ref, n_fit_points=int(keep.sum()))
    return out, info


def half_contrast_percent(
    blue: np.ndarray,
    clusters: list,
    background: float,
    fallback_percent: float,
) -> tuple[float, dict]:
    """Threshold (percent of background) halfway between background and particle intensity.

    Ip is the median over big preliminary clusters (> 150 px) of each cluster's 5th-percentile
    blue value. Falls back to ``fallback_percent`` with fewer than 10 such clusters.
    """
    big = [c for c in clusters if c.x_pixels.size > CONTRAST_CLUSTER_MIN_PIXELS]
    info = {"n_contrast_clusters": len(big), "contrast_particle_intensity": None}
    if len(big) < MIN_CONTRAST_CLUSTERS or background <= 0:
        return float(fallback_percent), info
    if len(big) > MAX_CONTRAST_CLUSTERS:
        pick = np.linspace(0, len(big) - 1, MAX_CONTRAST_CLUSTERS).astype(int)
        big = [big[i] for i in pick]
    p5 = [float(np.percentile(blue[c.x_pixels, c.y_pixels], 5)) for c in big]
    ip = float(np.median(p5))
    info["contrast_particle_intensity"] = ip
    pct = 100.0 * 0.5 * (background + ip) / background
    lo, hi = HALF_CONTRAST_BOUNDS
    return float(min(max(pct, lo), hi)), info
