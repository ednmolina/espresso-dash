from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from typing import Iterable

import numpy as np
import pandas as pd
from matplotlib.path import Path
from PIL import Image

from . import _kernels

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


@dataclass
class ParticleDataset:
    clusters: list[Cluster]
    pixel_scale: float | None = None
    label: str = "Current Data"

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
        return pd.DataFrame(
            {
                "SURFACE": self.surfaces,
                "ROUNDNESS": self.roundness,
                "SHORT_AXIS": self.short_axes,
                "LONG_AXIS": self.long_axes,
                "VOLUME": self.volumes,
                "PIXEL_SCALE": pixel_scale,
            }
        )

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
    threshold_overlay: np.ndarray = field(repr=False)
    cluster_overlay: np.ndarray = field(repr=False)
    background_median: float
    dataset: ParticleDataset
    settings: AnalysisSettings


def analyze_image(image: Image.Image | bytes | bytearray, settings: AnalysisSettings) -> AnalysisResult:
    rgb = _load_rgb_image(image)
    blue_channel = rgb[:, :, 2]

    polygon_mask = _build_polygon_mask(blue_channel.shape, settings.analysis_polygon)
    background_median = _background_median(blue_channel, polygon_mask)
    threshold_mask = blue_channel < background_median * settings.threshold_percent / 100.0

    if polygon_mask is not None:
        threshold_mask &= polygon_mask
        if not np.any(threshold_mask):
            raise ValueError("No thresholded pixels were found inside the selected analysis region.")

    threshold_overlay = _make_threshold_overlay(rgb, threshold_mask)
    clusters = _detect_particles(
        blue_channel=blue_channel,
        threshold_mask=threshold_mask,
        background_median=background_median,
        settings=settings,
        polygon_mask=polygon_mask,
    )
    dataset = ParticleDataset(
        clusters=clusters,
        pixel_scale=settings.pixel_scale,
        label="Current Data",
    )
    cluster_overlay = _make_cluster_overlay(rgb, clusters)
    return AnalysisResult(
        source_rgb=rgb,
        blue_channel=blue_channel,
        threshold_mask=threshold_mask,
        threshold_overlay=threshold_overlay,
        cluster_overlay=cluster_overlay,
        background_median=float(background_median),
        dataset=dataset,
        settings=settings,
    )


def summarize_dataset(dataset: ParticleDataset, pixel_scale: float | None = None) -> dict[str, float]:
    scale = pixel_scale if pixel_scale is not None else dataset.pixel_scale
    if scale is None or scale <= 0:
        raise ValueError("A positive pixel scale in pixels/mm is required to summarize the dataset.")
    if dataset.nclusters == 0:
        raise ValueError("No detected particles are available for summary statistics.")

    diameters = 2.0 * np.sqrt(dataset.long_axes * dataset.short_axes) / scale
    surfaces = dataset.surfaces / scale**2
    volumes = dataset.volumes / scale**3
    extraction_yields = extraction_yield(surfaces)
    reachable_masses = attainable_mass(volumes)
    efficiencies = reachable_masses / volumes

    cell_volume = (COFFEE_CELL_SIZE_MICRONS / 1e3) ** 3
    mass_weights = np.maximum(np.ceil(reachable_masses / cell_volume), 1.0)
    diam_avg = np.sum(diameters * mass_weights) / np.sum(mass_weights)
    diam_std = _weighted_stddev(diameters, mass_weights, frequency=True, unbiased=True)

    surf_avg = np.sum(surfaces * mass_weights) / np.sum(mass_weights)
    surf_std = _weighted_stddev(surfaces, mass_weights, frequency=True, unbiased=True)

    extraction_weights = extraction_yields * reachable_masses
    ey_avg = np.sum(extraction_yields * extraction_weights) / np.sum(extraction_weights) * 100.0
    ey_std = _weighted_stddev(
        extraction_yields,
        extraction_weights,
        frequency=True,
        unbiased=True,
    ) * 100.0

    # Volume-weighted size percentiles (Dv10/Dv50/Dv90), the convention used by
    # laser-diffraction grind analysers, so numbers are comparable with them.
    volume_weights = np.clip(volumes, 0.0, None)
    dv10, dv50, dv90 = _weighted_percentiles(diameters, volume_weights, (10.0, 50.0, 90.0))
    fines_pct = float(np.sum(volume_weights[diameters < FINES_DIAMETER_MM]) / np.sum(volume_weights) * 100.0)

    return {
        "cluster_count": float(dataset.nclusters),
        "diameter_number_mean_mm": float(np.mean(diameters)),
        "diameter_number_median_mm": float(np.median(diameters)),
        "dv10_mm": dv10,
        "dv50_mm": dv50,
        "dv90_mm": dv90,
        "span": float((dv90 - dv10) / dv50) if dv50 > 0 else float("nan"),
        "fines_volume_pct": fines_pct,
        "diameter_mean_mm": float(diam_avg),
        "diameter_std_mm": float(diam_std),
        "surface_mean_mm2": float(surf_avg),
        "surface_std_mm2": float(surf_std),
        "surface_quality": float(surf_avg / surf_std),
        "average_extraction_yield_pct": float(ey_avg),
        "extraction_yield_std_pct": float(ey_std),
        "average_efficiency_pct": float(np.mean(efficiencies) * 100.0),
    }


def filter_dataset_by_cluster_ids(
    dataset: ParticleDataset,
    excluded_cluster_ids: set[int] | list[int] | tuple[int, ...],
) -> ParticleDataset:
    excluded = set(int(cluster_id) for cluster_id in excluded_cluster_ids)
    return ParticleDataset(
        clusters=[cluster for cluster in dataset.clusters if int(cluster.cluster_id) not in excluded],
        pixel_scale=dataset.pixel_scale,
        label=dataset.label,
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

    if weight_mode == "number":
        return np.ones(dataset.nclusters, dtype=float)
    if weight_mode == "surface":
        return dataset.surfaces
    if weight_mode == "mass":
        return dataset.volumes
    if weight_mode == "available_mass":
        return attainable_mass(dataset.volumes / scale**3)
    if weight_mode == "extracted_mass":
        reachable = attainable_mass(dataset.volumes / scale**3)
        yield_pct = extraction_yield(dataset.surfaces / scale**2) * 100.0
        return reachable * yield_pct
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


def _background_median(blue_channel: np.ndarray, polygon_mask: np.ndarray | None) -> float:
    if polygon_mask is None:
        return float(np.median(blue_channel))
    if not np.any(polygon_mask):
        raise ValueError("The selected analysis polygon does not contain any image pixels.")
    return float(np.median(blue_channel[polygon_mask]))


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
    rows, cols = np.where(threshold_mask)
    if rows.size == 0:
        return []

    edge_grid = None
    if polygon_mask is not None:
        edge_grid = _polygon_edge_grid(blue_channel.shape, rows, cols, settings.analysis_polygon)

    sort_indices = np.argsort(blue_channel[rows, cols].astype(float))
    row_positions = rows[sort_indices].astype(float)
    col_positions = cols[sort_indices].astype(float)
    blue_values = blue_channel[rows[sort_indices], cols[sort_indices]].astype(float)
    total_pixels = row_positions.size

    # (row, col) -> index into the brightness-sorted pixel arrays
    index_grid = np.full(blue_channel.shape, -1, dtype=np.int64)
    index_grid[rows[sort_indices], cols[sort_indices]] = np.arange(total_pixels, dtype=np.int64)

    counted = np.zeros(total_pixels, dtype=np.bool_)
    visit_stamp = np.zeros(total_pixels, dtype=np.int64)
    out_buf = np.empty(total_pixels, dtype=np.int64)
    queue_buf = np.empty(total_pixels, dtype=np.int64)
    max_axis_sq = float(settings.max_cluster_axis) ** 2
    n_rows, n_cols = blue_channel.shape

    clusters: list[Cluster] = []
    next_open = 0
    for cluster_id in range(total_pixels):
        # the darkest pixel not yet assigned seeds the next cluster
        while next_open < total_pixels and counted[next_open]:
            next_open += 1
        if next_open >= total_pixels:
            break
        current = next_open

        n_found = _kernels.grow_cluster(
            index_grid, counted, row_positions, col_positions, current,
            max_axis_sq, visit_stamp, cluster_id + 1, out_buf, queue_buf,
        )
        cluster_indices = out_buf[:n_found].copy()
        if cluster_indices.size < settings.min_surface:
            counted[current] = True
            continue

        if settings.quick_mode:
            accepted_positions = np.arange(cluster_indices.size, dtype=int)
        else:
            cluster_indices = cluster_indices[
                np.argsort(
                    (row_positions[cluster_indices] - row_positions[current]) ** 2
                    + (col_positions[cluster_indices] - col_positions[current]) ** 2
                )
            ]
            accepted_positions = _kernels.filter_cluster_pixels(
                cluster_indices,
                row_positions,
                col_positions,
                blue_values,
                float(background_median),
                float(settings.reference_threshold),
                float(settings.max_cost),
                int(settings.smoothing_window),
            )

        counted[cluster_indices] = True
        if accepted_positions.size < settings.min_surface:
            continue

        accepted_indices = cluster_indices[accepted_positions]
        x_pixels = row_positions[accepted_indices]
        y_pixels = col_positions[accepted_indices]
        z_values = blue_values[accepted_indices]

        if (
            x_pixels.min() <= 0
            or x_pixels.max() >= n_rows - 1
            or y_pixels.min() <= 0
            or y_pixels.max() >= n_cols - 1
        ):
            continue

        if edge_grid is not None and edge_grid[x_pixels.astype(np.intp), y_pixels.astype(np.intp)].any():
            continue

        # NOTE: (bg - zmin) / bg <= 1 always, so this multiplier is always 1.0.
        # Kept to match the reference implementation.
        surface_multiplier = max((background_median - z_values.min()) / background_median, 1.0)
        surface = float(accepted_positions.size) * surface_multiplier
        xmean = float(np.mean(x_pixels))
        ymean = float(np.mean(y_pixels))
        radial_distances = np.sqrt((x_pixels - xmean) ** 2 + (y_pixels - ymean) ** 2)
        radial_distances = np.maximum(radial_distances, 1e-4)
        long_axis = float(np.max(radial_distances))
        if long_axis > settings.max_cluster_axis:
            continue

        roundness = 1.0 if surface == 1.0 else float(surface / (np.pi * long_axis**2))
        if roundness < settings.min_roundness:
            continue

        short_axis = float(surface / (np.pi * long_axis))
        volume = float(np.pi * short_axis**2 * long_axis)
        clusters.append(
            Cluster(
                cluster_id=cluster_id,
                surface=surface,
                roundness=roundness,
                short_axis=short_axis,
                long_axis=long_axis,
                volume=volume,
                xmean=xmean,
                ymean=ymean,
                x_pixels=x_pixels.astype(np.int32),
                y_pixels=y_pixels.astype(np.int32),
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
    triggered = np.zeros(x_points.size, dtype=bool)
    for line_index in range(x_polygon.size - 1):
        x1 = x_polygon[line_index]
        y1 = y_polygon[line_index]
        x2 = x_polygon[line_index + 1]
        y2 = y_polygon[line_index + 1]
        line_distances = np.abs((y2 - y1) * x_points - (x2 - x1) * y_points + x2 * y1 - y2 * x1) / np.sqrt(
            (y2 - y1) ** 2 + (x2 - x1) ** 2
        )
        distance_1 = np.sqrt((x1 - x_points) ** 2 + (y1 - y_points) ** 2)
        distance_2 = np.sqrt((x2 - x_points) ** 2 + (y2 - y_points) ** 2)
        segment_length = np.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
        on_segment = np.where(
            (line_distances <= np.sqrt(2.0) * 1.01)
            & (distance_1 <= segment_length)
            & (distance_2 <= segment_length)
        )[0]
        triggered[on_segment] = True
    return np.where(triggered)[0]


def cluster_label_grid(image_shape: tuple[int, int], clusters: list[Cluster]) -> np.ndarray:
    labels = np.full(image_shape, -1, dtype=np.int64)
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


def _weighted_percentiles(values: np.ndarray, weights: np.ndarray, percentiles: Iterable[float]) -> list[float]:
    """Percentiles of ``values`` where each sample counts in proportion to ``weights``."""
    order = np.argsort(values)
    sorted_values = values[order]
    cumulative = np.cumsum(weights[order])
    total = cumulative[-1]
    if total <= 0:
        return [float(np.percentile(values, p)) for p in percentiles]
    # midpoint rule: each sample sits at the centre of its weight interval
    positions = (cumulative - 0.5 * weights[order]) / total * 100.0
    return [float(np.interp(p, positions, sorted_values)) for p in percentiles]


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
