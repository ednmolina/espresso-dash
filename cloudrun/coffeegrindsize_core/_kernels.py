"""Compiled inner loops for particle detection.

These kernels reproduce the original coffeegrindsize algorithm step for step
(same flood-fill order, same dark-reference search, same path-cost test). The
speed-up comes from replacing the O(n^2) "scan every pixel" searches of the
pure-NumPy version with grid lookups, and from running the loops under numba.

If numba is not installed the same functions run as plain Python. Results are
the same but much slower, so numba is listed in requirements.txt.
"""
from __future__ import annotations

import math

import numpy as np

try:  # pragma: no cover - exercised implicitly
    from numba import njit

    HAVE_NUMBA = True
except ImportError:  # pragma: no cover
    HAVE_NUMBA = False

    def njit(*args, **kwargs):
        if len(args) == 1 and callable(args[0]) and not kwargs:
            return args[0]

        def wrap(func):
            return func

        return wrap


SQRT2 = math.sqrt(2.0)


@njit(cache=True)
def grow_cluster(index_grid, counted, row_pos, col_pos, current, max_axis_sq, visit_stamp, stamp, out, queue):
    """4-connected flood fill from ``current`` over open thresholded pixels.

    Only pixels within ``sqrt(max_axis_sq)`` of the start pixel are eligible,
    which matches the original "precluster" radius cut. Neighbours are visited
    in increasing pixel-index order so the output order matches the original
    ``_quick_cluster`` exactly. Returns the number of pixels written to ``out``.
    """
    n_rows, n_cols = index_grid.shape
    r0 = row_pos[current]
    c0 = col_pos[current]
    out[0] = current
    queue[0] = current
    visit_stamp[current] = stamp
    n_out = 1
    head = 0
    tail = 1
    neigh = np.empty(4, dtype=np.int64)
    while head < tail:
        p = queue[head]
        head += 1
        r = int(row_pos[p])
        c = int(col_pos[p])
        k = 0
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            rr = r + dr
            cc = c + dc
            if rr < 0 or rr >= n_rows or cc < 0 or cc >= n_cols:
                continue
            q = index_grid[rr, cc]
            if q < 0 or counted[q] or visit_stamp[q] == stamp:
                continue
            d2 = (r0 - row_pos[q]) ** 2 + (c0 - col_pos[q]) ** 2
            if d2 > max_axis_sq:
                continue
            neigh[k] = q
            k += 1
        # insertion sort (k <= 4) so neighbours are appended in index order
        for i in range(1, k):
            v = neigh[i]
            j = i - 1
            while j >= 0 and neigh[j] > v:
                neigh[j + 1] = neigh[j]
                j -= 1
            neigh[j + 1] = v
        for i in range(k):
            q = neigh[i]
            visit_stamp[q] = stamp
            out[n_out] = q
            n_out += 1
            queue[tail] = q
            tail += 1
    return n_out


@njit(cache=True)
def _smoothed_max(values, window):
    """max(np.convolve(values, ones(w)/w, 'same') * w) for len(values) > w."""
    n = values.size
    offset = (window - 1) // 2
    inv = 1.0 / window
    best = -np.inf
    for i in range(n):
        k = i + offset  # index into the 'full' convolution
        acc = 0.0
        for j in range(window):
            src = k - j
            if 0 <= src < n:
                acc += values[src] * inv
        acc *= window
        if acc > best:
            best = acc
    return best


@njit(cache=True)
def filter_cluster_pixels(
    cluster_indices,
    row_pos,
    col_pos,
    blue,
    background_median,
    reference_threshold,
    max_cost,
    smoothing_window,
):
    """Cluster breakup pass (``_filter_cluster_pixels`` in the reference code).

    ``cluster_indices`` must be sorted by distance from the start pixel, with
    the start pixel first. Each pixel is accepted only if the straight path to
    the nearest already-accepted "dark" pixel has no bright gap (smoothed
    brightness-change cost below ``max_cost``). Returns the accepted positions
    within ``cluster_indices``, in acceptance order.
    """
    n = cluster_indices.size
    current = cluster_indices[0]
    b_cur = blue[current]
    bg2 = background_median * background_median
    dark_limit = (background_median - b_cur) * reference_threshold + b_cur

    xs = np.empty(n)
    ys = np.empty(n)
    cost = np.empty(n)
    rmin = 1 << 30
    cmin = 1 << 30
    rmax = -1
    cmax = -1
    for i in range(n):
        idx = cluster_indices[i]
        xs[i] = row_pos[idx]
        ys[i] = col_pos[idx]
        c = (blue[idx] - b_cur) ** 2 / bg2
        cost[i] = c if c > 0.0 else 0.0
        ri = int(xs[i])
        ci = int(ys[i])
        rmin = min(rmin, ri)
        rmax = max(rmax, ri)
        cmin = min(cmin, ci)
        cmax = max(cmax, ci)

    # local lookup grid: (row, col) -> position within the cluster
    h = rmax - rmin + 1
    w = cmax - cmin + 1
    local = np.full((h, w), -1, dtype=np.int64)
    for i in range(n):
        local[int(xs[i]) - rmin, int(ys[i]) - cmin] = i

    accepted = np.empty(n, dtype=np.int64)
    accepted[0] = 0
    n_acc = 1
    dark = np.empty(n, dtype=np.int64)  # accepted dark pixels, acceptance order
    n_dark = 0
    if blue[current] <= dark_limit:
        dark[0] = 0
        n_dark = 1

    path = np.empty(n, dtype=np.int64)
    proj = np.empty(n)

    for li in range(1, n):
        x1 = xs[li]
        y1 = ys[li]

        # nearest accepted dark pixel (first one wins ties, like np.argmin)
        ref = dark[0]
        if n_dark > 1:
            best = np.inf
            for k in range(n_dark):
                d = dark[k]
                d2 = (xs[d] - x1) ** 2 + (ys[d] - y1) ** 2
                if d2 < best:
                    best = d2
                    ref = d
        x2 = xs[ref]
        y2 = ys[ref]

        denom = math.sqrt((y2 - y1) ** 2 + (x2 - x1) ** 2)
        ref_dist = math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
        a = y2 - y1
        b = x2 - x1
        cst = x2 * y1 - y2 * x1

        # Candidate path pixels lie within ~1.5 px of the segment. Visit the
        # segment's bounding box (padded by 2 px) through the local grid in
        # cluster order instead of testing every cluster pixel.
        r_lo = max(int(min(x1, x2)) - 2 - rmin, 0)
        r_hi = min(int(max(x1, x2)) + 2 - rmin, h - 1)
        c_lo = max(int(min(y1, y2)) - 2 - cmin, 0)
        c_hi = min(int(max(y1, y2)) + 2 - cmin, w - 1)
        n_path = 0
        if (r_hi - r_lo + 1) * (c_hi - c_lo + 1) <= n:
            for rr in range(r_lo, r_hi + 1):
                for cc in range(c_lo, c_hi + 1):
                    j = local[rr, cc]
                    if j < 0:
                        continue
                    x0 = xs[j]
                    y0 = ys[j]
                    ld = abs(a * x0 - b * y0 + cst) / denom
                    if ld > SQRT2:
                        continue
                    ds = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
                    if ds > ref_dist:
                        continue
                    dref = math.sqrt((x2 - x0) ** 2 + (y2 - y0) ** 2)
                    if dref > ref_dist:
                        continue
                    path[n_path] = j
                    proj[n_path] = math.sqrt(dref * dref - ld * ld)
                    n_path += 1
            # restore cluster order for ties (grid order != cluster order)
            order0 = np.argsort(path[:n_path], kind="mergesort")
            path_sorted = path[:n_path][order0]
            proj_sorted = proj[:n_path][order0]
        else:
            for j in range(n):
                x0 = xs[j]
                y0 = ys[j]
                ld = abs(a * x0 - b * y0 + cst) / denom
                if ld > SQRT2:
                    continue
                ds = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
                if ds > ref_dist:
                    continue
                dref = math.sqrt((x2 - x0) ** 2 + (y2 - y0) ** 2)
                if dref > ref_dist:
                    continue
                path[n_path] = j
                proj[n_path] = math.sqrt(dref * dref - ld * ld)
                n_path += 1
            path_sorted = path[:n_path].copy()
            proj_sorted = proj[:n_path].copy()

        order = np.argsort(proj_sorted, kind="mergesort")
        ordered_proj = proj_sorted[order]
        gap = False
        for k in range(1, n_path):
            if ordered_proj[k] - ordered_proj[k - 1] > SQRT2 * 1.01:
                gap = True
                break
        if gap:
            continue

        path_cost = np.empty(n_path)
        for k in range(n_path):
            path_cost[k] = cost[path_sorted[order[k]]]
        if smoothing_window < n_path:
            worst = _smoothed_max(path_cost, smoothing_window)
        else:
            worst = path_cost.sum()

        if worst < max_cost:
            accepted[n_acc] = li
            n_acc += 1
            if blue[cluster_indices[li]] <= dark_limit:
                dark[n_dark] = li
                n_dark += 1

    return accepted[:n_acc]


@njit(cache=True)
def outline_mask(label_grid):
    """True where a labelled pixel has any 8-neighbour with a different label."""
    n_rows, n_cols = label_grid.shape
    out = np.zeros((n_rows, n_cols), dtype=np.bool_)
    for r in range(n_rows):
        for c in range(n_cols):
            lab = label_grid[r, c]
            if lab < 0:
                continue
            edge = False
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    rr = r + dr
                    cc = c + dc
                    if rr < 0 or rr >= n_rows or cc < 0 or cc >= n_cols or label_grid[rr, cc] != lab:
                        edge = True
                        break
                if edge:
                    break
            out[r, c] = edge
    return out


@njit(cache=True)
def polygon_mask(n_rows, n_cols, xs, ys):
    """Even-odd point-in-polygon test for every pixel (x = col, y = row).

    Same crossing rule as matplotlib's ``Path.contains_points`` but done one
    scanline at a time, so cost is O(rows * edges + pixels) instead of a
    per-pixel test against every edge.
    """
    mask = np.zeros((n_rows, n_cols), dtype=np.bool_)
    n = xs.size
    crossings = np.empty(n)
    for r in range(n_rows):
        y = float(r)
        k = 0
        for i in range(n):
            j = i - 1 if i > 0 else n - 1
            y0 = ys[j]
            y1 = ys[i]
            if (y0 >= y) != (y1 >= y):
                crossings[k] = xs[j] + (y - y0) * (xs[i] - xs[j]) / (y1 - y0)
                k += 1
        if k < 2:
            continue
        xc = np.sort(crossings[:k])
        for m in range(0, k - 1, 2):
            c_start = max(int(math.ceil(xc[m])), 0)
            # a pixel exactly on the right crossing is outside
            c_stop = min(int(math.ceil(xc[m + 1])), n_cols)
            for c in range(c_start, c_stop):
                mask[r, c] = True
    return mask
