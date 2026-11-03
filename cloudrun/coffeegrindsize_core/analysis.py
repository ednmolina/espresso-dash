from __future__ import annotations

from dataclasses import dataclass, field, replace
from io import BytesIO
from typing import Iterable

import numpy as np
import pandas as pd
from matplotlib.path import Path
from PIL import Image

from . import _kernels
from . import background as _background
from . import stats as _stats

DEFAULT_REFERENCE_THRESHOLD = 0.4
DEFAULT_THRESHOLD_PERCENT = 58.8
DEFAULT_MAX_CLUSTER_AXIS = 100.0
DEFAULT_MIN_SURFACE = 5.0
DEFAULT_MIN_ROUNDNESS = 0.0
DEFAULT_MAX_COST = 0.35
DEFAULT_SMOOTHING = 3
COFFEE_CELL_SIZE_MICRONS = 20.0
# The reference implementation skipped the closing edge (last point -> first
# point) when rejecting particles cut by the analysis region border.
CLOSE_POLYGON_EDGES = True
# Particles below this diameter count as "fines" (by volume).
FINES_DIAMETER_MM = 0.1
REFERENCE_OBJECTS_MM = {
    "Custom": None,
    "Canadian Quarter": 23.81,
    "Canadian Dollar": 26.5,
    "Canadian Dime": 18.03,
    "Canadian Two Dollars": 28.0,
    "Canadian Five Cents": 21.3,
    "US Quarter": 24.26,
    "US Dollar": 26.92,
    "US Dime": 17.91,
    "US Penny": 19.05,
    "2 Euros": 25.75,
    "1 Euro": 23.25,
    "50 Euro Cents": 24.25,
    "20 Euro Cents": 22.25,
}


@dataclass
class AnalysisSettings:
    threshold_percent: float = DEFAULT_THRESHOLD_PERCENT
    reference_threshold: float = DEFAULT_REFERENCE_THRESHOLD
    max_cluster_axis: float = DEFAULT_MAX_CLUSTER_AXIS
    min_surface: float = DEFAULT_MIN_SURFACE
    min_roundness: float = DEFAULT_MIN_ROUNDNESS
    max_cost: float = DEFAULT_MAX_COST
    smoothing_window: int = DEFAULT_SMOOTHING
    quick_mode: bool = False
    analysis_polygon: list[tuple[float, float]] | None = None
    pixel_scale: float | None = None
    # --- measurement-model options (defaults: the improved model) ---
    # "poly4": divide out a degree-4 polynomial illumination field before thresholding.
    background_model: str = "poly4"  # "global" | "poly4"
    # "half_contrast": threshold halfway between background and typical particle intensity
    # (threshold_percent is then only the preliminary / fallback value).
    threshold_mode: str = "half_contrast"  # "fixed" | "half_contrast"
    # Miles-Lantuejoul weights for particles lost at the region border (statistics only).
    edge_correction: bool = True
    axis_method: str = "max_radius"  # "max_radius" | "moments"
    volume_model: str = "legacy"  # "legacy" | "spheroid"
    min_diameter_um: float | None = None
    # Reference object length in (analysis) pixels, used to report scale uncertainty.
    reference_px_length: float | None = None
    click_sigma_px: float = 2.0

    def __post_init__(self) -> None:
        for name, allowed in (
            ("background_model", ("global", "poly4")),
            ("threshold_mode", ("fixed", "half_contrast")),
            ("axis_method", ("max_radius", "moments")),
            ("volume_model", ("legacy", "spheroid")),
        ):
            if getattr(self, name) not in allowed:
                raise ValueError(f"{name} must be one of {', '.join(allowed)}.")

    @classmethod
    def legacy(cls, **overrides) -> "AnalysisSettings":
        """Settings reproducing the original (e299811) behaviour exactly."""
        values = dict(
            background_model="global",
            threshold_mode="fixed",
            edge_correction=False,
            axis_method="max_radius",
            volume_model="legacy",
        )
        values.update(overrides)
        return cls(**values)


@dataclass
class Cluster:
    cluster_id: int
    surface: float
    roundness: float
    short_axis: float
    long_axis: float
    volume: float
    xmean: float
    ymean: float
    x_pixels: np.ndarray = field(repr=False)
    y_pixels: np.ndarray = field(repr=False)
    # Border-loss correction weight (>= 1); applied to statistics, never to counts.
    edge_weight: float = 1.0


@dataclass
class ParticleDataset:
    clusters: list[Cluster]
    pixel_scale: float | None = None
    label: str = "Current Data"
    # JSON-safe analysis metadata (min_surface, reference_px_length, image_shape, ...).
    meta: dict = field(default_factory=dict)

    @property
    def edge_weights(self) -> np.ndarray:
        return np.array([getattr(cluster, "edge_weight", 1.0) for cluster in self.clusters], dtype=float)

    @property
    def nclusters(self) -> int:
        return len(self.clusters)

    @property
    def surfaces(self) -> np.ndarray:
        return np.array([cluster.surface for cluster in self.clusters], dtype=float)

    @property
    def roundness(self) -> np.ndarray:
        return np.array([cluster.roundness for cluster in self.clusters], dtype=float)

    @property
    def short_axes(self) -> np.ndarray:
        return np.array([cluster.short_axis for cluster in self.clusters], dtype=float)

    @property
    def long_axes(self) -> np.ndarray:
        return np.array([cluster.long_axis for cluster in self.clusters], dtype=float)

    @property
    def volumes(self) -> np.ndarray:
        return np.array([cluster.volume for cluster in self.clusters], dtype=float)

    def to_frame(self) -> pd.DataFrame:
        pixel_scale = np.nan if self.pixel_scale is None else float(self.pixel_scale)
        frame = pd.DataFrame(
            {
                "SURFACE": self.surfaces,
                "ROUNDNESS": self.roundness,
                "SHORT_AXIS": self.short_axes,
                "LONG_AXIS": self.long_axes,
                "VOLUME": self.volumes,
                "PIXEL_SCALE": pixel_scale,
            }
        )
        edge = self.edge_weights
        if edge.size and np.any(edge != 1.0):
            frame["EDGE_WEIGHT"] = edge
        return frame

    def to_csv_bytes(self) -> bytes:
        return self.to_frame().to_csv(index_label="ID").encode("utf-8")

    @classmethod
    def from_frame(cls, frame: pd.DataFrame, label: str = "Comparison Data") -> "ParticleDataset":
        required = ["SURFACE", "ROUNDNESS", "SHORT_AXIS", "LONG_AXIS", "VOLUME"]
        missing = [column for column in required if column not in frame.columns]
        if missing:
            raise ValueError(f"Missing required CSV columns: {', '.join(missing)}")

        pixel_scale = None
        if "PIXEL_SCALE" in frame.columns:
            pixel_values = pd.to_numeric(frame["PIXEL_SCALE"], errors="coerce").dropna()
            if not pixel_values.empty:
                pixel_scale = float(pixel_values.iloc[0])

        edge_weights = None
        if "EDGE_WEIGHT" in frame.columns:
            edge_weights = pd.to_numeric(frame["EDGE_WEIGHT"], errors="coerce").fillna(1.0).to_numpy(float)

        clusters: list[Cluster] = []
        for row_id, row in frame.reset_index(drop=True).iterrows():
            clusters.append(
                Cluster(
                    cluster_id=int(row_id),
                    surface=float(row["SURFACE"]),
                    roundness=float(row["ROUNDNESS"]),
                    short_axis=float(row["SHORT_AXIS"]),
                    long_axis=float(row["LONG_AXIS"]),
                    volume=float(row["VOLUME"]),
                    xmean=np.nan,
                    ymean=np.nan,
                    x_pixels=np.array([], dtype=int),
                    y_pixels=np.array([], dtype=int),
                    edge_weight=1.0 if edge_weights is None else float(edge_weights[row_id]),
                )
            )
        return cls(clusters=clusters, pixel_scale=pixel_scale, label=label)

    @classmethod
    def from_csv_bytes(cls, payload: bytes, label: str = "Comparison Data") -> "ParticleDataset":
        return cls.from_frame(pd.read_csv(BytesIO(payload)), label=label)


@dataclass
class AnalysisResult:
    source_rgb: np.ndarray = field(repr=False)
    blue_channel: np.ndarray = field(repr=False)
    threshold_mask: np.ndarray = field(repr=False)
    background_median: float
    dataset: ParticleDataset
    settings: AnalysisSettings
    # Lazily rendered (see the properties below); may still be passed explicitly.
    threshold_overlay: np.ndarray | None = field(default=None, repr=False)
    cluster_overlay: np.ndarray | None = field(default=None, repr=False)
    threshold_percent_used: float | None = None
    model_info: dict = field(default_factory=dict)


def _lazy_overlay(name: str, build):
    """Property that renders an overlay on first access and caches it.

    The dataclass keeps ``name`` as an optional init field (default None); the
    property's setter stores whatever __init__ passes, and the getter fills it in.
    """
    attr = "_" + name

    def getter(self):
        value = self.__dict__.get(attr)
        if value is None:
            value = build(self)
            self.__dict__[attr] = value
        return value

    def setter(self, value):
        self.__dict__[attr] = value

    return property(getter, setter)


AnalysisResult.threshold_overlay = _lazy_overlay(
    "threshold_overlay", lambda r: _make_threshold_overlay(r.source_rgb, r.threshold_mask)
)
AnalysisResult.cluster_overlay = _lazy_overlay(
    "cluster_overlay", lambda r: _make_cluster_overlay(r.source_rgb, r.dataset.clusters)
)


def analyze_image(image: Image.Image | bytes | bytearray, settings: AnalysisSettings) -> AnalysisResult:
    rgb = _load_rgb_image(image)
    blue_channel = rgb[:, :, 2]
    image_shape = blue_channel.shape

    polygon_mask = _build_polygon_mask(image_shape, settings.analysis_polygon)
    model_info: dict = {
        "background_model": settings.background_model,
        "threshold_mode": settings.threshold_mode,
        "edge_correction": bool(settings.edge_correction),
        "axis_method": settings.axis_method,
        "volume_model": settings.volume_model,
        "flattened": False,
    }

    if settings.background_model == "poly4":
        blue_channel, flat_info = _background.flatten_blue(blue_channel, polygon_mask, settings.threshold_percent)
        model_info["flattened"] = bool(flat_info.get("applied"))

    background_median = _background_median(blue_channel, polygon_mask)
    threshold_percent = float(settings.threshold_percent)
    if settings.threshold_mode == "half_contrast":
        prelim_mask = blue_channel < background_median * threshold_percent / 100.0
        if polygon_mask is not None:
            prelim_mask &= polygon_mask
        prelim = _detect_particles(
            blue_channel=blue_channel,
            threshold_mask=prelim_mask,
            background_median=background_median,
            settings=replace(settings, quick_mode=True, min_surface=float(_background.CONTRAST_CLUSTER_MIN_PIXELS)),
            polygon_mask=polygon_mask,
        )
        threshold_percent, contrast_info = _background.half_contrast_percent(
            blue_channel, prelim, background_median, threshold_percent
        )
        model_info.update(contrast_info)
    model_info["threshold_percent_used"] = threshold_percent

    threshold_mask = blue_channel < background_median * threshold_percent / 100.0

    if polygon_mask is not None:
        threshold_mask &= polygon_mask
        if not np.any(threshold_mask):
            raise ValueError("No thresholded pixels were found inside the selected analysis region.")

    clusters = _detect_particles(
        blue_channel=blue_channel,
        threshold_mask=threshold_mask,
        background_median=background_median,
        settings=settings,
        polygon_mask=polygon_mask,
    )
    _remeasure_clusters(clusters, settings.axis_method, settings.volume_model)
    if settings.edge_correction and clusters:
        weights = _stats.edge_weights(
            [c.x_pixels for c in clusters], [c.y_pixels for c in clusters], image_shape, polygon_mask
        )
        for cluster, weight in zip(clusters, weights):
            cluster.edge_weight = float(weight)

    dataset = ParticleDataset(
        clusters=clusters,
        pixel_scale=settings.pixel_scale,
        label="Current Data",
        meta={
            "min_surface": float(settings.min_surface),
            "reference_px_length": settings.reference_px_length,
            "click_sigma_px": float(settings.click_sigma_px),
            "min_diameter_um": settings.min_diameter_um,
            "image_shape": [int(image_shape[0]), int(image_shape[1])],
            "threshold_percent_used": float(threshold_percent),
            "background_model": settings.background_model,
            "threshold_mode": settings.threshold_mode,
            "edge_correction": bool(settings.edge_correction),
            "axis_method": settings.axis_method,
            "volume_model": settings.volume_model,
        },
    )
    return AnalysisResult(
        source_rgb=rgb,
        blue_channel=blue_channel,
        threshold_mask=threshold_mask,
        background_median=float(background_median),
        dataset=dataset,
        settings=settings,
        threshold_percent_used=float(threshold_percent),
        model_info=model_info,
    )


def _remeasure_clusters(clusters: list[Cluster], axis_method: str, volume_model: str) -> None:
    """Recompute axes / roundness / volume of detected clusters (surface is unchanged).

    ``max_radius`` + ``legacy`` leaves the detector output untouched (original behaviour).
    ``moments``: semi-axes from the second moments of the pixel set (+1/12 pixel-size term),
    unbiased for small particles, with short = S / (pi * long) so 2*sqrt(long*short) stays the
    area-equivalent diameter. ``spheroid``: V = 4/3 pi long short^2 (prolate) instead of
    pi short^2 long.
    """
    if not clusters or (axis_method == "max_radius" and volume_model == "legacy"):
        return
    if axis_method == "moments":
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
        lam1 = half_trace + np.sqrt(np.maximum(0.25 * (sxx - syy) ** 2 + sxy**2, 0.0))
        long_axes = 2.0 * np.sqrt(lam1)
    else:
        long_axes = np.array([c.long_axis for c in clusters], dtype=np.float64)
    for cluster, long_axis in zip(clusters, long_axes):
        long_axis = float(long_axis)
        surface = cluster.surface
        cluster.long_axis = long_axis
        cluster.short_axis = float(surface / (np.pi * long_axis))
        if axis_method == "moments":
            cluster.roundness = 1.0 if surface == 1.0 else float(surface / (np.pi * long_axis**2))
        if volume_model == "spheroid":
            cluster.volume = float(4.0 / 3.0 * np.pi * long_axis * cluster.short_axis**2)
        else:
            cluster.volume = float(np.pi * cluster.short_axis**2 * long_axis)


MODEL_NOTES = [
    "Extraction yield, efficiency and surface quality come from an uncalibrated model "
    "(Gagne heuristic), not from measurements."
]


def _finite_or_none(value):
    if isinstance(value, dict):
        return {key: _finite_or_none(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite_or_none(item) for item in value]
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, float, np.integer, np.floating)):
        value = float(value)
        return value if np.isfinite(value) else None
    return value


def _resolve_scale(dataset: ParticleDataset, pixel_scale: float | None, what: str) -> float:
    scale = pixel_scale if pixel_scale is not None else dataset.pixel_scale
    if scale is None or scale <= 0:
        raise ValueError(f"A positive pixel scale in pixels/mm is required {what}.")
    return float(scale)


def _dataset_min_surface(dataset: ParticleDataset) -> float:
    value = (dataset.meta or {}).get("min_surface")
    if value is not None:
        return float(value)
    return float(dataset.surfaces.min()) if dataset.nclusters else 0.0


def filter_by_min_diameter(
    dataset: ParticleDataset,
    pixel_scale: float | None = None,
    min_diameter_um: float | None = None,
) -> ParticleDataset:
    """Dataset without particles whose area-equivalent diameter is below ``min_diameter_um``."""
    if min_diameter_um is None or min_diameter_um <= 0 or dataset.nclusters == 0:
        return dataset
    scale = _resolve_scale(dataset, pixel_scale, "to apply a minimum diameter")
    diameters_um = 2000.0 * np.sqrt(dataset.long_axes * dataset.short_axes) / scale
    keep = diameters_um >= float(min_diameter_um)
    return ParticleDataset(
        clusters=[c for c, k in zip(dataset.clusters, keep) if k],
        pixel_scale=dataset.pixel_scale,
        label=dataset.label,
        meta=dataset.meta,
    )


def common_min_diameter_um(
    datasets: Iterable[ParticleDataset],
    pixel_scales: Iterable[float | None] | None = None,
) -> float:
    """Common size cutoff for comparing runs: the largest detection limit (or explicit minimum)."""
    datasets = list(datasets)
    scales = list(pixel_scales) if pixel_scales is not None else [None] * len(datasets)
    limits = [0.0]
    for dataset, scale in zip(datasets, scales):
        s = _resolve_scale(dataset, scale, "to compare runs")
        limits.append(_stats.detection_limit_um(_dataset_min_surface(dataset), s))
        explicit = (dataset.meta or {}).get("min_diameter_um")
        if explicit:
            limits.append(float(explicit))
    return float(max(limits))


def summarize_dataset(
    dataset: ParticleDataset,
    pixel_scale: float | None = None,
    *,
    min_diameter_um: float | None = None,
    min_surface: float | None = None,
    reference_px_length: float | None = None,
    click_sigma_px: float | None = None,
    legacy_summary: bool = False,
) -> dict:
    """Summary statistics (all values JSON-safe; non-finite -> None).

    Size percentiles are weighted by equivalent-sphere volume (and border-loss weights).
    ``legacy_summary=True`` reproduces the original weighting (Dv from cluster volumes,
    unweighted mean efficiency, fines always reported).
    Extraction yield / efficiency / surface quality are an uncalibrated heuristic model.
    """
    scale = _resolve_scale(dataset, pixel_scale, "to summarize the dataset")
    if dataset.nclusters == 0:
        raise ValueError("No detected particles are available for summary statistics.")
    meta = dataset.meta or {}
    if min_diameter_um is None:
        min_diameter_um = meta.get("min_diameter_um")
    if reference_px_length is None:
        reference_px_length = meta.get("reference_px_length")
    if click_sigma_px is None:
        click_sigma_px = meta.get("click_sigma_px", 2.0)
    min_surf = float(min_surface) if min_surface is not None else _dataset_min_surface(dataset)

    n_total = dataset.nclusters
    dataset = filter_by_min_diameter(dataset, scale, min_diameter_um)
    if dataset.nclusters == 0:
        raise ValueError("No particles remain above the minimum diameter.")

    edge_w = dataset.edge_weights
    diameters = 2.0 * np.sqrt(dataset.long_axes * dataset.short_axes) / scale
    surfaces = dataset.surfaces / scale**2
    volumes = dataset.volumes / scale**3
    extraction_yields = extraction_yield(surfaces)
    reachable_masses = attainable_mass(volumes)
    efficiencies = reachable_masses / volumes

    cell_volume = (COFFEE_CELL_SIZE_MICRONS / 1e3) ** 3
    mass_weights = np.maximum(np.ceil(reachable_masses / cell_volume), 1.0) * edge_w
    diam_avg = np.sum(diameters * mass_weights) / np.sum(mass_weights)
    diam_std = _weighted_stddev(diameters, mass_weights, frequency=True, unbiased=True)

    surf_avg = np.sum(surfaces * mass_weights) / np.sum(mass_weights)
    surf_std = _weighted_stddev(surfaces, mass_weights, frequency=True, unbiased=True)

    extraction_weights = extraction_yields * reachable_masses * edge_w
    ey_avg = np.sum(extraction_yields * extraction_weights) / np.sum(extraction_weights) * 100.0
    ey_std = _weighted_stddev(
        extraction_yields,
        extraction_weights,
        frequency=True,
        unbiased=True,
    ) * 100.0

    if legacy_summary:
        volume_weights = np.clip(volumes, 0.0, None) * edge_w
        efficiency_pct = float(np.mean(efficiencies) * 100.0)
    else:
        # equivalent-sphere volume of the area-equivalent diameter (ISO 13322 convention)
        volume_weights = (np.pi / 6.0) * diameters**3 * edge_w
        efficiency_pct = float(np.sum(reachable_masses * edge_w) / np.sum(volumes * edge_w) * 100.0)
    dv10, dv50, dv90 = _weighted_percentiles(diameters, volume_weights, (10.0, 50.0, 90.0))
    ci = _stats.bootstrap_percentile_ci(diameters, volume_weights)

    limit_um = _stats.detection_limit_um(min_surf, scale)
    fines_measurable = limit_um < _stats.FINES_RELIABLE_LIMIT_UM
    fines_pct = None
    if fines_measurable or legacy_summary:
        fines_pct = float(
            np.sum(volume_weights[diameters < FINES_DIAMETER_MM]) / np.sum(volume_weights) * 100.0
        )

    gm_n, gsd_n = _stats.geometric_stats(diameters, edge_w)
    gm_v, gsd_v = _stats.geometric_stats(diameters, volume_weights)
    rel_unc = _stats.scale_relative_uncertainty(reference_px_length, float(click_sigma_px))
    number_median = _weighted_percentiles(diameters, edge_w, (50.0,))[0]

    summary = {
        "cluster_count": float(dataset.nclusters),
        "diameter_number_mean_mm": float(np.sum(diameters * edge_w) / np.sum(edge_w)),
        "diameter_number_median_mm": number_median,
        "dv10_mm": dv10,
        "dv50_mm": dv50,
        "dv90_mm": dv90,
        "span": float((dv90 - dv10) / dv50) if dv50 > 0 else None,
        "fines_volume_pct": fines_pct,
        "diameter_mean_mm": float(diam_avg),
        "diameter_std_mm": float(diam_std),
        "surface_mean_mm2": float(surf_avg),
        "surface_std_mm2": float(surf_std),
        "surface_quality": float(surf_avg / surf_std) if surf_std > 0 else None,
        "average_extraction_yield_pct": float(ey_avg),
        "extraction_yield_std_pct": float(ey_std),
        "average_efficiency_pct": efficiency_pct,
        # --- measurement-model additions ---
        "detection_limit_um": limit_um,
        "reliable_limit_um": _stats.reliable_limit_um(scale),
        "fines_measurable": bool(fines_measurable),
        "dv_ci95": {"dv10": ci[0], "dv50": ci[1], "dv90": ci[2]},
        "geometric_mean_number_mm": gm_n,
        "gsd_number": gsd_n,
        "geometric_mean_volume_mm": gm_v,
        "gsd_volume": gsd_v,
        "volume_mode_mm": _stats.volume_mode(diameters, volume_weights),
        "diameter_scale_unc_pct": None if rel_unc is None else 100.0 * rel_unc,
        "volume_scale_unc_pct": None if rel_unc is None else 300.0 * rel_unc,
        "min_diameter_um": None if not min_diameter_um else float(min_diameter_um),
        "n_excluded_below_min": int(n_total - dataset.nclusters),
        "edge_correction_applied": bool(np.any(edge_w != 1.0)),
        "effective_cluster_count": float(np.sum(edge_w)),
        "model_notes": list(MODEL_NOTES),
    }
    for key in ("threshold_percent_used", "background_model", "threshold_mode", "axis_method", "volume_model"):
        if key in meta:
            summary[key] = meta[key]
    return _finite_or_none(summary)


def filter_dataset_by_cluster_ids(
    dataset: ParticleDataset,
    excluded_cluster_ids: set[int] | list[int] | tuple[int, ...],
) -> ParticleDataset:
    excluded = set(int(cluster_id) for cluster_id in excluded_cluster_ids)
    return ParticleDataset(
        clusters=[cluster for cluster in dataset.clusters if int(cluster.cluster_id) not in excluded],
        pixel_scale=dataset.pixel_scale,
        label=dataset.label,
        meta=dataset.meta,
    )


def clusters_within_radius(
    dataset: ParticleDataset,
    points: Iterable[tuple[float, float]],
    radius_pixels: float,
) -> set[int]:
    points = list(points)
    if radius_pixels <= 0 or not points or not dataset.clusters:
        return set()

    xmeans = np.array([cluster.xmean for cluster in dataset.clusters], dtype=float)
    ymeans = np.array([cluster.ymean for cluster in dataset.clusters], dtype=float)
    ids = np.array([int(cluster.cluster_id) for cluster in dataset.clusters])
    hit = np.zeros(ids.size, dtype=bool)
    for x_point, y_point in points:
        hit |= np.sqrt((xmeans - x_point) ** 2 + (ymeans - y_point) ** 2) <= radius_pixels
    return set(int(i) for i in ids[hit])


def render_cluster_overlay(source_rgb: np.ndarray, dataset: ParticleDataset) -> np.ndarray:
    return _make_cluster_overlay(source_rgb, dataset.clusters)


def attainable_mass(volumes_mm3: np.ndarray) -> np.ndarray:
    depth_limit = 0.1
    radii = (3.0 * volumes_mm3 / (4.0 * np.pi)) ** (1.0 / 3.0)
    unreachable_volumes = np.zeros_like(volumes_mm3, dtype=float)
    large_mask = radii > depth_limit
    unreachable_volumes[large_mask] = 4.0 / 3.0 * np.pi * (radii[large_mask] - depth_limit) ** 3
    return volumes_mm3 - unreachable_volumes


def extraction_yield(surfaces_mm2: np.ndarray) -> np.ndarray:
    k_reference = 0.25014
    extraction_limit = 0.3
    extraction_speed = 1.0 / surfaces_mm2
    return extraction_speed / (k_reference + extraction_speed) * extraction_limit


def metric_values(dataset: ParticleDataset, metric: str, pixel_scale: float | None = None) -> np.ndarray:
    scale = pixel_scale if pixel_scale is not None else dataset.pixel_scale
    if scale is None or scale <= 0:
        raise ValueError("A positive pixel scale in pixels/mm is required for physical metrics.")

    if metric == "diameter":
        return 2.0 * np.sqrt(dataset.long_axes * dataset.short_axes) / scale
    if metric == "surface":
        return dataset.surfaces / scale**2
    if metric == "volume":
        return dataset.volumes / scale**3
    if metric == "extraction_yield":
        return extraction_yield(dataset.surfaces / scale**2) * 100.0
    raise ValueError(f"Unsupported histogram metric: {metric}")


def metric_weights(dataset: ParticleDataset, weight_mode: str, pixel_scale: float | None = None) -> np.ndarray:
    scale = pixel_scale if pixel_scale is not None else dataset.pixel_scale
    if scale is None or scale <= 0:
        raise ValueError("A positive pixel scale in pixels/mm is required for weighted histograms.")

    # Border-loss weights make these statistics unbiased; they are 1 when correction is off.
    edge_w = dataset.edge_weights
    if weight_mode == "number":
        return edge_w
    if weight_mode == "surface":
        return dataset.surfaces * edge_w
    if weight_mode == "mass":
        # equivalent-sphere volume of the area-equivalent diameter (same as the Dv weights)
        diameters = 2.0 * np.sqrt(dataset.long_axes * dataset.short_axes) / scale
        return (np.pi / 6.0) * diameters**3 * edge_w
    if weight_mode == "available_mass":
        return attainable_mass(dataset.volumes / scale**3) * edge_w
    if weight_mode == "extracted_mass":
        reachable = attainable_mass(dataset.volumes / scale**3)
        yield_pct = extraction_yield(dataset.surfaces / scale**2) * 100.0
        return reachable * yield_pct * edge_w
    raise ValueError(f"Unsupported histogram weight mode: {weight_mode}")


def metric_axis_label(metric: str) -> str:
    if metric == "diameter":
        return "Particle Diameter (mm)"
    if metric == "surface":
        return "Particle Surface (mm^2)"
    if metric == "volume":
        return "Particle Volume (mm^3)"
    if metric == "extraction_yield":
        return "Extraction Yield (%)"
    raise ValueError(f"Unsupported histogram metric: {metric}")


def weight_axis_label(weight_mode: str) -> str:
    if weight_mode == "number":
        return "Fraction of Particles"
    if weight_mode == "surface":
        return "Fraction of Total Surface"
    if weight_mode == "mass":
        return "Fraction of Total Mass"
    if weight_mode == "available_mass":
        return "Fraction of Available Mass"
    if weight_mode == "extracted_mass":
        return "Fraction of Extracted Mass"
    raise ValueError(f"Unsupported histogram weight mode: {weight_mode}")


def _load_rgb_image(image: Image.Image | bytes | bytearray) -> np.ndarray:
    if isinstance(image, Image.Image):
        pil_image = image.convert("RGB")
    else:
        pil_image = Image.open(BytesIO(image)).convert("RGB")
    return np.array(pil_image)


def _median(values: np.ndarray) -> float:
    """np.median, via a 256-bin histogram for uint8 input (about 2x faster)."""
    values = np.asarray(values)
    if values.dtype != np.uint8 or values.size == 0:
        return float(np.median(values))
    counts = np.bincount(values.ravel(), minlength=256)
    n = values.size
    cumulative = np.cumsum(counts)
    # same as numpy: mean of the two middle order statistics (equal when n is odd)
    low = int(np.searchsorted(cumulative, (n - 1) // 2 + 1))
    high = int(np.searchsorted(cumulative, n // 2 + 1))
    return (low + high) / 2.0


def _background_median(blue_channel: np.ndarray, polygon_mask: np.ndarray | None) -> float:
    if polygon_mask is None:
        return _median(blue_channel)
    if not np.any(polygon_mask):
        raise ValueError("The selected analysis polygon does not contain any image pixels.")
    return _median(blue_channel[polygon_mask])


def _build_polygon_mask(
    image_shape: tuple[int, int],
    polygon_points: Iterable[tuple[float, float]] | None,
) -> np.ndarray | None:
    if polygon_points is None:
        return None

    points = list(polygon_points)
    if len(points) < 3:
        raise ValueError("An analysis polygon must contain at least three points.")

    rows, cols = image_shape
    xs = np.array([p[0] for p in points], dtype=float)
    ys = np.array([p[1] for p in points], dtype=float)
    return _kernels.polygon_mask(rows, cols, xs, ys)


def _make_threshold_overlay(source_rgb: np.ndarray, threshold_mask: np.ndarray) -> np.ndarray:
    overlay = source_rgb.copy()
    overlay[threshold_mask] = np.array([255, 0, 0], dtype=np.uint8)
    return overlay


def _detect_particles(
    blue_channel: np.ndarray,
    threshold_mask: np.ndarray,
    background_median: float,
    settings: AnalysisSettings,
    polygon_mask: np.ndarray | None,
) -> list[Cluster]:
    """Grow, break up and measure particles. ``blue_channel`` may be uint8 or float."""
    rows, cols = np.where(threshold_mask)
    if rows.size == 0:
        return []
    if not settings.quick_mode and not settings.reference_threshold >= 0:
        raise ValueError("reference_threshold must be >= 0.")

    use_edge = polygon_mask is not None
    edge_grid = np.zeros((1, 1), dtype=np.bool_)
    if use_edge:
        edge_grid = _polygon_edge_grid(blue_channel.shape, rows, cols, settings.analysis_polygon)

    # Stable sort: brightness ties must resolve identically on every CPU
    # (numpy's default quicksort is SIMD-dispatched and not stable).
    sort_indices = np.argsort(blue_channel[rows, cols], kind="stable")
    rows = rows[sort_indices]
    cols = cols[sort_indices]
    total_pixels = rows.size

    # (row, col) -> index into the brightness-sorted pixel arrays
    index_grid = np.full(blue_channel.shape, -1, dtype=np.int32)
    index_grid[rows, cols] = np.arange(total_pixels, dtype=np.int32)

    ids, stats, offsets, pix_rows, pix_cols = _kernels.detect_core(
        index_grid,
        rows.astype(np.float64),
        cols.astype(np.float64),
        blue_channel[rows, cols].astype(np.float64),
        float(background_median),
        float(settings.reference_threshold),
        float(settings.max_cost),
        int(settings.smoothing_window),
        float(settings.max_cluster_axis),
        float(settings.min_surface),
        -1e300,  # min_roundness is applied below, in Python (bit-exact **)
        bool(settings.quick_mode),
        edge_grid,
        use_edge,
    )

    clusters: list[Cluster] = []
    for i in range(ids.size):
        surface = float(stats[i, 0])
        long_axis = float(stats[i, 3])
        roundness = 1.0 if surface == 1.0 else float(surface / (np.pi * long_axis**2))
        if roundness < settings.min_roundness:
            continue
        short_axis = float(surface / (np.pi * long_axis))
        volume = float(np.pi * short_axis**2 * long_axis)
        clusters.append(
            Cluster(
                cluster_id=int(ids[i]),
                surface=surface,
                roundness=roundness,
                short_axis=short_axis,
                long_axis=long_axis,
                volume=volume,
                xmean=float(stats[i, 5]),
                ymean=float(stats[i, 6]),
                x_pixels=pix_rows[offsets[i] : offsets[i + 1]],
                y_pixels=pix_cols[offsets[i] : offsets[i + 1]],
            )
        )
    return clusters


def _polygon_edge_grid(
    image_shape: tuple[int, int],
    rows: np.ndarray,
    cols: np.ndarray,
    polygon_points: Iterable[tuple[float, float]] | None,
) -> np.ndarray | None:
    """Boolean image marking thresholded pixels that sit on the polygon border."""
    if polygon_points is None:
        return None

    polygon = [tuple(point) for point in polygon_points]
    if CLOSE_POLYGON_EDGES and len(polygon) >= 3 and polygon[0] != polygon[-1]:
        polygon.append(polygon[0])
    edge_indices = _points_along_polygon(
        cols.astype(float),
        rows.astype(float),
        np.array([point[0] for point in polygon], dtype=float),
        np.array([point[1] for point in polygon], dtype=float),
    )
    grid = np.zeros(image_shape, dtype=bool)
    grid[rows[edge_indices], cols[edge_indices]] = True
    return grid


def _points_along_polygon(
    x_points: np.ndarray,
    y_points: np.ndarray,
    x_polygon: np.ndarray,
    y_polygon: np.ndarray,
) -> np.ndarray:
    # numba port evaluating the identical float expressions (see _kernels)
    triggered = _kernels.points_along_polygon(
        np.ascontiguousarray(x_points, dtype=np.float64),
        np.ascontiguousarray(y_points, dtype=np.float64),
        np.ascontiguousarray(x_polygon, dtype=np.float64),
        np.ascontiguousarray(y_polygon, dtype=np.float64),
    )
    return np.where(triggered)[0]


def cluster_label_grid(image_shape: tuple[int, int], clusters: list[Cluster]) -> np.ndarray:
    labels = np.full(image_shape, -1, dtype=np.int32)
    for position, cluster in enumerate(clusters):
        labels[cluster.x_pixels, cluster.y_pixels] = position
    return labels


def cluster_outline_mask(image_shape: tuple[int, int], clusters: list[Cluster]) -> np.ndarray:
    """Pixels on the border of each particle (3x3 neighbourhood not fully inside it)."""
    return _kernels.outline_mask(cluster_label_grid(image_shape, clusters))


def cluster_center_mask(image_shape: tuple[int, int], clusters: list[Cluster]) -> np.ndarray:
    mask = np.zeros(image_shape, dtype=bool)
    for cluster in clusters:
        mask[int(round(cluster.xmean)), int(round(cluster.ymean))] = True
    return mask


def _make_cluster_overlay(source_rgb: np.ndarray, clusters: list[Cluster]) -> np.ndarray:
    overlay = source_rgb.copy()
    shape = source_rgb.shape[:2]
    overlay[cluster_outline_mask(shape, clusters)] = np.array([255, 0, 0], dtype=np.uint8)
    overlay[cluster_center_mask(shape, clusters)] = np.array([80, 80, 255], dtype=np.uint8)
    return overlay


def _smooth(values: np.ndarray, window_size: int) -> np.ndarray:
    window = np.ones(int(window_size), dtype=float) / float(window_size)
    return np.convolve(values, window, "same")


_weighted_percentiles = _stats.weighted_percentiles


def _weighted_stddev(
    data: np.ndarray,
    weights: np.ndarray,
    frequency: bool = False,
    unbiased: bool = True,
) -> float:
    weights = weights.astype(float)
    if unbiased:
        if frequency:
            bias = (np.nansum(weights) - 1.0) / np.nansum(weights)
        else:
            bias = 1.0 - (np.nansum(weights**2)) / (np.nansum(weights) ** 2)
    else:
        bias = 1.0

    normalized = weights / np.nansum(weights)
    weighted_mean = np.nansum(data * normalized)
    weighted_variance = np.nansum((data - weighted_mean) ** 2 * normalized) / bias
    weighted_variance = max(float(weighted_variance), 0.0)
    return float(np.sqrt(weighted_variance))
