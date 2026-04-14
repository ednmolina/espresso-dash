from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import LogFormatter, ScalarFormatter

from .analysis import (
    ParticleDataset,
    metric_axis_label,
    metric_values,
    metric_weights,
    weight_axis_label,
)

DEFAULT_LOG_BIN_SIZE = 0.05
DEFAULT_LINEAR_BIN_SIZE = 0.1


@dataclass
class HistogramSettings:
    x_metric: str = "diameter"
    weight_mode: str = "number"
    x_log: bool = False
    bins: int | None = None
    xmin: float | None = None
    xmax: float | None = None


def plot_histogram(
    datasets: Sequence[ParticleDataset],
    settings: HistogramSettings,
) -> tuple[plt.Figure, np.ndarray]:
    if not datasets:
        raise ValueError("At least one dataset is required to plot a histogram.")

    metric_arrays = [metric_values(dataset, settings.x_metric) for dataset in datasets]
    weight_arrays = [metric_weights(dataset, settings.weight_mode) for dataset in datasets]
    if any(values.size == 0 for values in metric_arrays):
        raise ValueError("At least one dataset has no detected particles to plot.")

    xmin = settings.xmin if settings.xmin is not None else float(min(np.nanmin(values) for values in metric_arrays))
    xmax = settings.xmax if settings.xmax is not None else float(max(np.nanmax(values) for values in metric_arrays))
    if settings.x_metric == "extraction_yield":
        xmin = min(xmin, 20.0)
        xmax = max(xmax, 30.0)
    if xmin <= 0 and settings.x_log:
        raise ValueError("Logarithmic histograms require strictly positive x values.")
    if xmax <= xmin:
        raise ValueError("Histogram xmax must be greater than xmin.")

    bins = _build_bins(xmin=xmin, xmax=xmax, x_log=settings.x_log, bins=settings.bins)
    fig, ax = plt.subplots(figsize=(10, 6), dpi=160)
    palette = ["#93241e", "#4a7cb3", "#2f7d4a", "#9c5a14"]

    for index, (dataset, values, weights) in enumerate(zip(datasets, metric_arrays, weight_arrays)):
        normalized_weights = weights / np.nansum(weights)
        style = "bar" if index == 0 else "step"
        ax.hist(
            values,
            bins=bins,
            weights=normalized_weights,
            density=False,
            histtype=style,
            linewidth=2,
            alpha=0.75 if style == "bar" else 1.0,
            label=dataset.label,
            color=palette[index % len(palette)],
        )

    if settings.x_log:
        ax.set_xscale("log")
        ax.xaxis.set_minor_formatter(LogFormatter())
        ax.xaxis.set_major_formatter(ScalarFormatter())

    ax.set_xlabel(metric_axis_label(settings.x_metric))
    ax.set_ylabel(weight_axis_label(settings.weight_mode))
    ax.tick_params(axis="both", which="major", labelsize=9, length=5, width=1.5)
    ax.tick_params(axis="both", which="minor", labelsize=8, length=3, width=1.0)
    ax.legend()
    fig.tight_layout()
    return fig, bins


def _build_bins(xmin: float, xmax: float, x_log: bool, bins: int | None) -> np.ndarray:
    if bins is None:
        if x_log:
            span = np.log10(xmax) - np.log10(xmin)
            bins = max(int(np.ceil(span / DEFAULT_LOG_BIN_SIZE)), 10)
        else:
            bins = max(int(np.ceil((xmax - xmin) / DEFAULT_LINEAR_BIN_SIZE)), 10)

    if x_log:
        return np.logspace(np.log10(xmin), np.log10(xmax), bins)
    return np.linspace(xmin, xmax, bins)
