"""Regression: histogram bin end edges must be exactly xmin / xmax.

np.logspace(log10(xmin), log10(xmax), n) computes 10 ** log10(x) for its end points, which is not
always exactly x (it depends on the CPU / libm). When the last edge rounds just below xmax (or the
first just above xmin) the extreme particle falls outside every bin and the fractions sum to < 1.
Intermittent CI failures: tests/api/test_endpoints.py::test_10_histogram_series_without_png.

Run in CI with ``pytest -m "" parity``.
"""
import numpy as np
import pytest

import conftest  # noqa: F401  (sets up sys.path for cloudrun/)
from coffeegrindsize_core import plotting

# Found by brute force on one machine: 10 ** np.log10(x) < x (the raw last logspace edge misses x).
ROUNDS_DOWN = [1539.3605070043973, 1320.6062968093877, 1588.0105347142508,
               233.02619420975805, 105.2775792179123]
# ... and 10 ** np.log10(x) > x (the raw first edge would sit above xmin when x is xmin).
ROUNDS_UP = [312.01027601918236, 1702.4957870276037, 547.3846001918723,
             1016.0984198292848, 926.5075763380394]


def _search(sign, want=3):
    rng = np.random.default_rng(0)
    out = []
    for x in rng.uniform(50, 2000, 20000):
        r = 10 ** np.log10(x)
        if (r < x) if sign < 0 else (r > x):
            out.append(float(x))
            if len(out) == want:
                break
    return out


# Hardcoded values may not reproduce on another libm; add a few that do here. If none reproduce
# anywhere, the invariants are still asserted on every value.
XS = ROUNDS_DOWN + ROUNDS_UP + _search(-1) + _search(+1)


def _check(xmin, xmax, x_log, bins):
    edges = plotting._build_bins(xmin, xmax, x_log, bins)
    assert edges[0] == xmin
    assert edges[-1] == xmax
    assert np.all(np.diff(edges) > 0)
    values = np.array([xmin, xmax, (xmin + xmax) / 2, xmin + (xmax - xmin) / 3])
    counts, _ = np.histogram(values, bins=edges, weights=np.full(len(values), 0.25))
    assert counts.sum() == pytest.approx(1.0, abs=1e-12)
    assert np.histogram(values, bins=edges)[0].sum() == len(values)


@pytest.mark.parametrize("bins", [None, 10, 37])
@pytest.mark.parametrize("x_log", [True, False])
@pytest.mark.parametrize("x", XS)
def test_end_edges_exact_and_all_values_binned(x, x_log, bins):
    _check(x / 20, x, x_log, bins)   # x as xmax
    _check(x, x * 4, x_log, bins)    # x as xmin


def test_raw_logspace_is_the_problem_when_it_reproduces():
    """Documents the bug: where the raw edge misses, the fixed edges still capture the value."""
    for x in XS:
        raw = np.logspace(np.log10(x / 20), np.log10(x), 30)
        fixed = plotting._build_bins(x / 20, x, True, 30)
        assert fixed[-1] == x
        if raw[-1] < x:
            assert np.histogram([x], bins=raw)[0].sum() == 0  # the bug
        assert np.histogram([x], bins=fixed)[0].sum() == 1


def test_single_point_bins_unchanged():
    assert plotting._build_bins(2.0, 5.0, False, 1).tolist() == [2.0]
