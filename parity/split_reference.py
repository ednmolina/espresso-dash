"""Python reference for the optional "separate touching particles" split (feature B).

Mirrors React/frontend/src/analysis/split.js operation for operation (same integer / float
expressions, same tie-breaks), so the two agree bit for bit. Pure Python plus the frozen core's
``Cluster`` dataclass; numpy only for the pixel arrays. **No scipy** (an optional cross-check of
``edt_squared`` against ``scipy.ndimage.distance_transform_edt`` lives in the tests behind
``pytest.importorskip("scipy")``).

Pipeline position (JS ``analyzeImageBlue``): after the detector, before the axis / volume
re-measurement and the edge weights::

    clusters = split_touching(clusters, settings)      # this module
    _remeasure_clusters(...)                           # core, per cluster independent

Pieces are measured exactly like the detector (``_kernels.detect_core``), so legacy settings
(``max_radius`` + ``legacy``) need no further re-measurement. Edge weights are not recomputed here
(the fixtures use legacy settings, where edge correction is off and every weight is 1).

Constants, the candidate rule, the EDT, the watershed and the acceptance rule are specified in the
module docstring of split.js and in COMMON.md section 5.
"""
from __future__ import annotations

import math

import numpy as np

SPLIT_MIN_PX = 40
SPLIT_SOLIDITY_MAX = 0.95
SPLIT_MIN_PEAK_PX = 2.0
DEFAULT_NECK_RATIO = 0.7


# ---------------------------------------------------------------------------
# 1. solidity (candidate filter)
# ---------------------------------------------------------------------------

def cluster_solidity(rows, cols) -> float:
    """n / (A_hull + P_hull / 2 + 1); the hull of the pixel centres from per-row extents.

    Rows are taken relative to the bbox top, columns absolute (translation invariant, integer
    arithmetic is exact either way).
    """
    rows = [int(v) for v in rows]
    cols = [int(v) for v in cols]
    n = len(rows)
    rmin = min(rows)
    nr = max(rows) - rmin + 1
    lo = [None] * nr
    hi = [None] * nr
    for r, c in zip(rows, cols):
        r -= rmin
        if lo[r] is None or c < lo[r]:
            lo[r] = c
        if hi[r] is None or c > hi[r]:
            hi[r] = c
    pts = []
    for r in range(nr):
        if hi[r] is None:
            continue
        pts.append((r, lo[r]))
        if hi[r] != lo[r]:
            pts.append((r, hi[r]))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    area = 0
    perim = 0.0
    nh = len(hull)
    for q in range(nh):
        a = hull[q]
        b = hull[(q + 1) % nh]
        area += a[0] * b[1] - b[0] * a[1]
        dr = a[0] - b[0]
        dc = a[1] - b[1]
        perim += math.sqrt(dr * dr + dc * dc)
    area = abs(area) / 2
    return n / (area + perim / 2 + 1)


# ---------------------------------------------------------------------------
# 2. exact squared EDT
# ---------------------------------------------------------------------------

def edt_squared(mask) -> list:
    """Squared Euclidean distance (ints) to the nearest background cell centre.

    ``mask``: 2-D array-like, truthy = particle. Row 0 must be background (the caller pads the
    bbox by one cell). Column pass (integer, exact) then the Felzenszwalb-Huttenlocher lower
    envelope along rows, exactly as in split.js.
    """
    m = [[1 if v else 0 for v in row] for row in np.asarray(mask).tolist()]
    gh = len(m)
    gw = len(m[0])
    g = [[0] * gw for _ in range(gh)]
    for y in range(1, gh):
        for x in range(gw):
            g[y][x] = g[y - 1][x] + 1 if m[y][x] else 0
    for y in range(gh - 2, -1, -1):
        for x in range(gw):
            t = g[y + 1][x] + 1
            if t < g[y][x]:
                g[y][x] = t
    out = [[v * v for v in row] for row in g]
    inf = math.inf
    for y in range(gh):
        f = out[y]
        v = [0] * gw
        z = [0.0] * (gw + 1)
        k = 0
        v[0] = 0
        z[0] = -inf
        z[1] = inf
        for q in range(1, gw):
            fq = f[q] + q * q
            p = v[k]
            s = (fq - (f[p] + p * p)) / (2 * q - 2 * p)
            while s <= z[k]:
                k -= 1
                p = v[k]
                s = (fq - (f[p] + p * p)) / (2 * q - 2 * p)
            k += 1
            v[k] = q
            z[k] = s
            z[k + 1] = inf
        k = 0
        row = [0] * gw
        for q in range(gw):
            while z[k + 1] < q:
                k += 1
            p = v[k]
            row[q] = (q - p) * (q - p) + f[p]
        out[y] = row
    return out


# ---------------------------------------------------------------------------
# 3. flooding watershed with the neck rule
# ---------------------------------------------------------------------------

def _find(par, x):
    while par[x] != x:
        par[x] = par[par[x]]
        x = par[x]
    return x


def split_cluster_pixels(rows, cols, ratio: float = DEFAULT_NECK_RATIO):
    """Piece index (0, 1, ...) of every pixel and the number of pieces: ``(labels, n_pieces)``."""
    rows = [int(v) for v in rows]
    cols = [int(v) for v in cols]
    rmin, rmax = min(rows), max(rows)
    cmin, cmax = min(cols), max(cols)
    gh = rmax - rmin + 3
    gw = cmax - cmin + 3
    mask = [[0] * gw for _ in range(gh)]
    for r, c in zip(rows, cols):
        mask[r - rmin + 1][c - cmin + 1] = 1
    dist = edt_squared(mask)

    # particle cells in row-major order; j = cell number is the tie-break key
    cells = [(y, x) for y in range(1, gh - 1) for x in range(1, gw - 1) if mask[y][x]]
    order = sorted(range(len(cells)), key=lambda j: (-dist[cells[j][0]][cells[j][1]], j))

    lab = [[-1] * gw for _ in range(gh)]
    par = []
    peak = []
    minpeak = SPLIT_MIN_PEAK_PX * SPLIT_MIN_PEAK_PX
    r2 = ratio * ratio
    for j in order:
        y, x = cells[j]
        lev = dist[y][x]
        roots = []
        for ny, nx in ((y - 1, x), (y, x - 1), (y, x + 1), (y + 1, x)):  # up, left, right, down
            lb = lab[ny][nx]
            if lb >= 0:
                r = _find(par, lb)
                if r not in roots:
                    roots.append(r)
        if not roots:
            b = len(par)
            par.append(b)
            peak.append(lev)
            lab[y][x] = b
            continue
        roots.sort(key=lambda b: (-peak[b], b))
        main = roots[0]
        for b in roots[1:]:
            pb = peak[b]
            if not (pb >= minpeak and lev < r2 * pb):
                par[b] = main
        lab[y][x] = main

    piece_of_root = {}
    cell_piece = {}
    for (y, x) in cells:
        r = _find(par, lab[y][x])
        if r not in piece_of_root:
            piece_of_root[r] = len(piece_of_root)
        cell_piece[(y, x)] = piece_of_root[r]
    labels = [cell_piece[(r - rmin + 1, c - cmin + 1)] for r, c in zip(rows, cols)]
    return labels, len(piece_of_root)


# ---------------------------------------------------------------------------
# 4. split_touching
# ---------------------------------------------------------------------------

def find_candidates(clusters, settings):
    """``[(index, solidity)]`` of the clusters that are tested for a split, in dataset order."""
    min_px = max(SPLIT_MIN_PX, 2 * settings.min_surface)
    out = []
    for k, c in enumerate(clusters):
        if c.x_pixels.size < min_px:
            continue
        sol = cluster_solidity(c.x_pixels, c.y_pixels)
        if sol < SPLIT_SOLIDITY_MAX:
            out.append((k, sol))
    return out


def _measure_pieces(c, labels, n_pieces):
    """Detector-equivalent scalars of every piece: one tuple per piece, or None per piece list."""
    rows = [int(v) for v in c.x_pixels]
    cols = [int(v) for v in c.y_pixels]
    m = [0] * n_pieces
    sx = [0] * n_pieces
    sy = [0] * n_pieces
    for r, cc, p in zip(rows, cols, labels):
        m[p] += 1
        sx[p] += r
        sy[p] += cc
    xmean = [sx[p] / m[p] for p in range(n_pieces)]
    ymean = [sy[p] / m[p] for p in range(n_pieces)]
    long_axis = [0.0] * n_pieces
    for r, cc, p in zip(rows, cols, labels):
        dx = r - xmean[p]
        dy = cc - ymean[p]
        rd = math.sqrt(dx * dx + dy * dy)
        if not rd >= 1e-4:
            rd = 1e-4
        if rd > long_axis[p]:
            long_axis[p] = rd
    unit = c.surface / len(rows)
    pieces = []
    for p in range(n_pieces):
        surface = m[p] * unit
        la = long_axis[p]
        roundness = 1.0 if surface == 1.0 else float(surface / (math.pi * la ** 2))
        short_axis = float(surface / (math.pi * la))
        volume = float(math.pi * short_axis ** 2 * la)
        pieces.append((m[p], surface, roundness, short_axis, la, volume, xmean[p], ymean[p]))
    return pieces


def split_touching(clusters, settings, neck_ratio: float = DEFAULT_NECK_RATIO):
    """Split touching clusters. Returns ``(clusters_out, info)``.

    ``clusters``: list of ``coffeegrindsize_core.analysis.Cluster`` (detector output);
    ``settings``: object with ``min_surface``, ``max_cluster_axis``, ``min_roundness`` and
    optionally ``axis_method`` / ``volume_model`` (the pieces are re-measured with the core's
    ``_remeasure_clusters`` when those need it). ``info`` = {neck_ratio, candidates, clusters_split,
    pieces_added, rejected_splits}. When nothing is split the *same list* is returned.
    """
    from coffeegrindsize_core.analysis import Cluster, _remeasure_clusters

    info = {"neck_ratio": float(neck_ratio), "candidates": 0, "clusters_split": 0,
            "pieces_added": 0, "rejected_splits": 0}
    if not clusters:
        return clusters, info
    cands = find_candidates(clusters, settings)
    info["candidates"] = len(cands)
    accepted = {}
    for k, _sol in cands:
        c = clusters[k]
        labels, n_pieces = split_cluster_pixels(c.x_pixels, c.y_pixels, neck_ratio)
        if n_pieces < 2:
            continue
        pieces = _measure_pieces(c, labels, n_pieces)
        ok = all(m >= settings.min_surface and la <= settings.max_cluster_axis
                 and roundness >= settings.min_roundness
                 for (m, _s, roundness, _sh, la, _v, _x, _y) in pieces)
        if not ok:
            info["rejected_splits"] += 1
            continue
        accepted[k] = (labels, pieces)
        info["clusters_split"] += 1
        info["pieces_added"] += n_pieces - 1
    if not accepted:
        return clusters, info

    next_id = max(int(c.cluster_id) for c in clusters) + 1
    out = []
    new_pieces = []
    for k, c in enumerate(clusters):
        if k not in accepted:
            out.append(c)
            continue
        labels, pieces = accepted[k]
        lab = np.asarray(labels)
        for p, (m, surface, roundness, short_axis, la, volume, xm, ym) in enumerate(pieces):
            sel = lab == p
            piece = Cluster(
                cluster_id=next_id, surface=float(surface), roundness=roundness, short_axis=short_axis,
                long_axis=float(la), volume=volume, xmean=float(xm), ymean=float(ym),
                x_pixels=c.x_pixels[sel], y_pixels=c.y_pixels[sel], edge_weight=c.edge_weight,
            )
            next_id += 1
            out.append(piece)
            new_pieces.append(piece)
    _remeasure_clusters(new_pieces, getattr(settings, "axis_method", "max_radius"),
                        getattr(settings, "volume_model", "legacy"))
    return out, info


# ---------------------------------------------------------------------------
# 5. Dv at detection
# ---------------------------------------------------------------------------

def _stable_weighted_percentiles(values, weights, ps):
    order = np.argsort(values, kind="stable")
    sv = values[order]
    sw = weights[order]
    cum = np.cumsum(sw)
    pos = (cum - 0.5 * sw) / cum[-1] * 100.0
    return [float(np.interp(p, pos, sv)) for p in ps]


def unsplit_dv(dataset):
    """Dv10/50/90 (mm) and count as ``summarize_dataset`` reports them, or None.

    Same filter (``filter_by_min_diameter``), diameters and volume-equivalent weights as the
    summary; the percentiles use a stable sort (what the JS port does).
    """
    from coffeegrindsize_core.analysis import filter_by_min_diameter

    scale = dataset.pixel_scale
    if scale is None or not scale > 0:
        return None
    f = filter_by_min_diameter(dataset, scale, (dataset.meta or {}).get("min_diameter_um"))
    if f.nclusters == 0:
        return None
    d = 2.0 * np.sqrt(f.long_axes * f.short_axes) / scale
    w = (np.pi / 6.0) * d ** 3 * f.edge_weights
    dv10, dv50, dv90 = _stable_weighted_percentiles(d, w, (10.0, 50.0, 90.0))
    return {"cluster_count": int(f.nclusters), "dv10_mm": dv10, "dv50_mm": dv50, "dv90_mm": dv90}
