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
        # np.convolve accumulates in ascending source order; match it exactly
        lo = max(k - window + 1, 0)
        hi = min(k, n - 1)
        for src in range(lo, hi + 1):
            acc += values[src] * inv
        acc *= window
        if acc > best:
            best = acc
    return best


@njit(cache=True, error_model="numpy")
def points_along_polygon(x_points, y_points, x_polygon, y_polygon):
    """Boolean flag per point: within ~1.4 px of any polygon segment.

    Evaluates exactly the same floating-point expressions as the vectorised
    NumPy reference (``_points_along_polygon``), one point at a time.
    """
    n = x_points.size
    triggered = np.zeros(n, dtype=np.bool_)
    thresh = math.sqrt(2.0) * 1.01
    for line in range(x_polygon.size - 1):
        x1 = x_polygon[line]
        y1 = y_polygon[line]
        x2 = x_polygon[line + 1]
        y2 = y_polygon[line + 1]
        dy = y2 - y1
        dx = x2 - x1
        norm = math.sqrt(dy * dy + dx * dx)
        seg = math.sqrt(dx * dx + dy * dy)
        for i in range(n):
            if triggered[i]:
                continue
            x = x_points[i]
            y = y_points[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
            if d > thresh:
                continue
            d1 = math.sqrt((x1 - x) * (x1 - x) + (y1 - y) * (y1 - y))
            d2 = math.sqrt((x2 - x) * (x2 - x) + (y2 - y) * (y2 - y))
            if d1 <= seg and d2 <= seg:
                triggered[i] = True
    return triggered


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
    # matplotlib point_in_path_impl crossing rule, evaluated exactly per edge:
    # edge (j->i) toggles pixel tx iff ((y1-ty)*(x0-x1) >= (x1-tx)*(y0-y1)) == yflag1
    mask = np.zeros((n_rows, n_cols), dtype=np.bool_)
    n = xs.size
    bounds = np.empty(n, dtype=np.int64)
    for r in range(n_rows):
        ty = float(r)
        k = 0
        for i in range(n):
            j = i - 1 if i > 0 else n - 1
            x0 = xs[j]; y0 = ys[j]; x1 = xs[i]; y1 = ys[i]
            yflag0 = y0 >= ty
            yflag1 = y1 >= ty
            if yflag0 == yflag1:
                continue
            xc = x0 + (ty - y0) * (x1 - x0) / (y1 - y0)
            # the toggled set is {tx < b}; find b near xc with the exact predicate
            b = int(math.floor(xc)) - 2
            while True:
                tx = float(b)
                if not ((((y1 - ty) * (x0 - x1)) >= ((x1 - tx) * (y0 - y1))) == yflag1):
                    break
                b += 1
            while True:
                tx = float(b - 1)
                if (((y1 - ty) * (x0 - x1)) >= ((x1 - tx) * (y0 - y1))) == yflag1:
                    break
                b -= 1
            bounds[k] = b
            k += 1
        if k < 2:
            continue
        bs = np.sort(bounds[:k])
        # pixel tx is inside iff #(b > tx) is odd
        for m in range(k - 1, 0, -2):
            hi = min(bs[m], n_cols)
            lo = max(bs[m - 1], 0)
            for c in range(lo, hi):
                mask[r, c] = True
    return mask


@njit(cache=True)
def filter_cluster_pixels(
    cluster_indices, row_pos, col_pos, blue, background_median,
    reference_threshold, max_cost, smoothing_window,
):
    """Cluster breakup pass (``_filter_cluster_pixels`` in the reference code).

    ``cluster_indices`` must be sorted by distance from the start pixel, with
    the start pixel first. A pixel is accepted only if the straight path to the
    nearest accepted "dark" pixel has no bright gap (smoothed brightness-change
    cost below ``max_cost``). Returns accepted positions in acceptance order.

    The nearest-dark search walks expanding Chebyshev rings of a local rank grid
    (ties -> lowest acceptance rank, i.e. np.argmin) and the path search only
    visits columns inside the segment's band, so cost stays near-linear even for
    huge clumps. Results are identical to the brute-force scans.
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
    h = rmax - rmin + 1
    w = cmax - cmin + 1
    local = np.full((h, w), -1, dtype=np.int32)
    for i in range(n):
        local[int(xs[i]) - rmin, int(ys[i]) - cmin] = i
    # dark_rank[cell] = acceptance rank among dark pixels, -1 if none
    dark_rank = np.full((h, w), -1, dtype=np.int32)

    accepted = np.empty(n, dtype=np.int64)
    accepted[0] = 0
    n_acc = 1
    dark = np.empty(n, dtype=np.int64)
    n_dark = 0
    if blue[current] <= dark_limit:
        dark[0] = 0
        n_dark = 1
        dark_rank[int(xs[0]) - rmin, int(ys[0]) - cmin] = 0

    path = np.empty(n, dtype=np.int64)
    proj = np.empty(n)

    for li in range(1, n):
        x1 = xs[li]
        y1 = ys[li]
        r1 = int(x1) - rmin
        c1 = int(y1) - cmin

        ref = dark[0] if n_dark > 0 else 0  # n_dark==0 only for reference_threshold<0
        if n_dark > 1:
            best = np.inf
            best_rank = n_dark
            done = False
            if n_dark > 16:
                # expanding Chebyshev rings; stop once ring radius^2 > best
                visited = 0
                rad = 0
                while True:
                    if rad * rad > best:
                        done = True
                        break
                    if visited > n_dark:
                        break  # linear scan is cheaper from here
                    if rad > h + w:
                        done = True
                        break
                    for rr in range(r1 - rad, r1 + rad + 1):
                        if rr < 0 or rr >= h:
                            continue
                        edge_row = rr == r1 - rad or rr == r1 + rad
                        step = 1 if edge_row else 2 * rad
                        if step == 0:
                            step = 1
                        cc = c1 - rad
                        while cc <= c1 + rad:
                            if 0 <= cc < w:
                                visited += 1
                                k = dark_rank[rr, cc]
                                if k >= 0:
                                    d = dark[k]
                                    d2 = (xs[d] - x1) ** 2 + (ys[d] - y1) ** 2
                                    if d2 < best or (d2 == best and k < best_rank):
                                        best = d2
                                        best_rank = k
                            cc += step
                    rad += 1
            if done:
                ref = dark[best_rank]
            else:
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

        r_lo = max(int(min(x1, x2)) - 2 - rmin, 0)
        r_hi = min(int(max(x1, x2)) + 2 - rmin, h - 1)
        c_lo = max(int(min(y1, y2)) - 2 - cmin, 0)
        c_hi = min(int(max(y1, y2)) + 2 - cmin, w - 1)
        n_path = 0
        band = SQRT2 * denom
        for rr in range(r_lo, r_hi + 1):
            x0 = float(rr + rmin)
            lo = c_lo
            hi = c_hi
            if b != 0.0:
                # |a*x0 - b*y0 + cst| <= band  ->  y0 in [(a*x0+cst-band)/b, (a*x0+cst+band)/b]
                u = (a * x0 + cst - band) / b
                v = (a * x0 + cst + band) / b
                if u > v:
                    u, v = v, u
                lo = max(lo, int(math.floor(u)) - 1 - cmin)
                hi = min(hi, int(math.ceil(v)) + 1 - cmin)
            for cc in range(lo, hi + 1):
                j = local[rr, cc]
                if j < 0:
                    continue
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
        order0 = np.argsort(path[:n_path], kind="mergesort")
        path_sorted = path[:n_path][order0]
        proj_sorted = proj[:n_path][order0]

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
                dark_rank[r1, c1] = n_dark
                n_dark += 1

    return accepted[:n_acc]


@njit(cache=True)
def detect_core(index_grid, row_pos, col_pos, blue, background_median, reference_threshold,
                max_cost, smoothing_window, max_axis, min_surface, min_roundness, quick,
                edge_grid, use_edge):
    """Whole particle-detection driver loop (flood fill, breakup filter, rejection).

    Pixel arrays are sorted darkest-first (stable) and ``index_grid`` maps
    (row, col) -> position in them. Returns cluster ids, a (n, 7) stats array
    (surface, roundness, short_axis, long_axis, volume, xmean, ymean), and flat
    int32 pixel coordinate arrays with per-cluster offsets. roundness/short/
    volume are recomputed in Python by the caller (numba's ``**`` can differ by
    1 ulp from CPython's); ``min_roundness`` here is only a pre-filter.
    """
    n_rows, n_cols = index_grid.shape
    total = row_pos.size
    counted = np.zeros(total, dtype=np.bool_)
    visit_stamp = np.zeros(total, dtype=np.int32)
    out_buf = np.empty(total, dtype=np.int64)
    queue_buf = np.empty(total, dtype=np.int64)
    max_axis_sq = max_axis * max_axis
    # outputs (grown as lists)
    ids = []
    stats = []  # surface, roundness, short, long, volume, xmean, ymean
    pix_r = np.empty(total, dtype=np.int32)
    pix_c = np.empty(total, dtype=np.int32)
    offsets = [0]
    n_pix = 0
    next_open = 0
    for cluster_id in range(total):
        while next_open < total and counted[next_open]:
            next_open += 1
        if next_open >= total:
            break
        current = next_open
        n_found = grow_cluster(index_grid, counted, row_pos, col_pos, current,
                               max_axis_sq, visit_stamp, cluster_id + 1, out_buf, queue_buf)
        if n_found < min_surface:
            counted[current] = True
            continue
        ci = out_buf[:n_found].copy()
        if quick:
            acc = np.arange(n_found)
        else:
            d2 = np.empty(n_found)
            for i in range(n_found):
                d2[i] = (row_pos[ci[i]] - row_pos[current]) ** 2 + (col_pos[ci[i]] - col_pos[current]) ** 2
            ci = ci[np.argsort(d2, kind="mergesort")]
            acc = filter_cluster_pixels(ci, row_pos, col_pos, blue, background_median,
                                           reference_threshold, max_cost, smoothing_window)
        for i in range(n_found):
            counted[ci[i]] = True
        m = acc.size
        if m < min_surface:
            continue
        xmin = np.inf; xmax = -np.inf; ymin = np.inf; ymax = -np.inf
        sx = 0.0; sy = 0.0; zmin = np.inf
        hit_edge = False
        for k in range(m):
            p = ci[acc[k]]
            x = row_pos[p]; y = col_pos[p]
            xmin = min(xmin, x); xmax = max(xmax, x); ymin = min(ymin, y); ymax = max(ymax, y)
            sx += x; sy += y
            zmin = min(zmin, blue[p])
            if use_edge and edge_grid[int(x), int(y)]:
                hit_edge = True
        if xmin <= 0 or xmax >= n_rows - 1 or ymin <= 0 or ymax >= n_cols - 1:
            continue
        if hit_edge:
            continue
        mult = max((background_median - zmin) / background_median, 1.0)
        surface = float(m) * mult
        xmean = sx / m
        ymean = sy / m
        long_axis = 0.0
        for k in range(m):
            p = ci[acc[k]]
            rd = math.sqrt((row_pos[p] - xmean) ** 2 + (col_pos[p] - ymean) ** 2)
            rd = max(rd, 1e-4)
            long_axis = max(long_axis, rd)
        if long_axis > max_axis:
            continue
        roundness = 1.0 if surface == 1.0 else surface / (math.pi * long_axis ** 2)
        if roundness < min_roundness:
            continue
        short_axis = surface / (math.pi * long_axis)
        volume = math.pi * short_axis ** 2 * long_axis
        ids.append(cluster_id)
        stats.append((surface, roundness, short_axis, long_axis, volume, xmean, ymean))
        for k in range(m):
            p = ci[acc[k]]
            pix_r[n_pix] = int(row_pos[p]); pix_c[n_pix] = int(col_pos[p])
            n_pix += 1
        offsets.append(n_pix)
    nc = len(ids)
    ids_a = np.empty(nc, dtype=np.int64)
    st = np.empty((nc, 7))
    off = np.empty(nc + 1, dtype=np.int64)
    off[0] = 0
    for i in range(nc):
        ids_a[i] = ids[i]
        s = stats[i]
        st[i, 0] = s[0]; st[i, 1] = s[1]; st[i, 2] = s[2]; st[i, 3] = s[3]
        st[i, 4] = s[4]; st[i, 5] = s[5]; st[i, 6] = s[6]
        off[i + 1] = offsets[i + 1]
    return ids_a, st, off, pix_r[:n_pix].copy(), pix_c[:n_pix].copy()


def warm_up() -> float:
    """Compile (or load from cache) every kernel with tiny synthetic inputs.

    Returns elapsed seconds. Covers the polygon mask, quick and full detection,
    the edge-grid path and the outline mask, with the exact argument types
    ``analysis._detect_particles`` uses so later calls hit the compiled code.
    """
    import time

    t0 = time.perf_counter()
    h = w = 24
    mask = np.zeros((h, w), dtype=np.bool_)
    mask[6:16, 6:14] = True
    rows, cols = np.where(mask)
    n = rows.size
    index_grid = np.full((h, w), -1, dtype=np.int32)
    index_grid[rows, cols] = np.arange(n, dtype=np.int32)
    rpos = rows.astype(np.float64)
    cpos = cols.astype(np.float64)
    blue = (60.0 + (rows + cols) % 7).astype(np.float64)
    edge = np.zeros((h, w), dtype=np.bool_)
    for quick in (False, True):
        for use_edge in (False, True):
            detect_core(
                index_grid, rpos, cpos, blue, 230.0, 0.4, 0.35, 3, 100.0, 5.0,
                -1e300, quick, edge, use_edge,
            )
    points_along_polygon(rpos, cpos, np.array([2.0, 20.5, 18.0, 3.0, 2.0]), np.array([1.0, 3.0, 21.0, 19.5, 1.0]))
    polygon_mask(h, w, np.array([2.0, 20.5, 18.0, 3.0]), np.array([1.0, 3.0, 21.0, 19.5]))
    outline_mask(np.where(mask, 0, -1).astype(np.int32))
    return time.perf_counter() - t0
