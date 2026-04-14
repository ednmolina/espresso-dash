from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from typing import Iterable

import numpy as np
import pandas as pd
from matplotlib.path import Path
from PIL import Image

DEFAULT_REFERENCE_THRESHOLD = 0.4
DEFAULT_THRESHOLD_PERCENT = 58.8
DEFAULT_MAX_CLUSTER_AXIS = 100.0
DEFAULT_MIN_SURFACE = 5.0
DEFAULT_MIN_ROUNDNESS = 0.0
DEFAULT_MAX_COST = 0.35
DEFAULT_SMOOTHING = 3
COFFEE_CELL_SIZE_MICRONS = 20.0
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

    return {
        "cluster_count": float(dataset.nclusters),
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
    selected: set[int] = set()
    if radius_pixels <= 0:
        return selected

    for x_point, y_point in points:
        for cluster in dataset.clusters:
            distance = np.sqrt((cluster.xmean - x_point) ** 2 + (cluster.ymean - y_point) ** 2)
            if distance <= radius_pixels:
                selected.add(int(cluster.cluster_id))
    return selected


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

    polygon_path = Path(points)
    rows, cols = image_shape
    y_coords, x_coords = np.mgrid[0:rows, 0:cols]
    query_points = np.vstack((x_coords.ravel(), y_coords.ravel())).T
    contained = polygon_path.contains_points(query_points)
    return contained.reshape(image_shape)


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

    edge_lookup = set()
    if polygon_mask is not None:
        edge_lookup = _polygon_edge_lookup(rows, cols, settings.analysis_polygon)

    sort_indices = np.argsort(blue_channel[rows, cols].astype(float))
    row_positions = rows[sort_indices].astype(float)
    col_positions = cols[sort_indices].astype(float)
    blue_values = blue_channel[rows[sort_indices], cols[sort_indices]].astype(float)
    total_pixels = row_positions.size

    counted = np.zeros(total_pixels, dtype=bool)
    clusters: list[Cluster] = []
    for cluster_id in range(total_pixels):
        open_indices = np.where(~counted)[0]
        if open_indices.size == 0:
            break

        current = open_indices[0]
        distances_squared = (
            (row_positions[current] - row_positions[open_indices]) ** 2
            + (col_positions[current] - col_positions[open_indices]) ** 2
        )
        nearby = np.where(distances_squared <= settings.max_cluster_axis**2)[0]
        if nearby.size == 0:
            counted[current] = True
            continue

        precluster = open_indices[nearby]
        connected = _quick_cluster(
            row_positions[precluster],
            col_positions[precluster],
            row_positions[current],
            col_positions[current],
        )
        cluster_indices = precluster[connected]
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
            accepted_positions = _filter_cluster_pixels(
                cluster_indices=cluster_indices,
                current=current,
                row_positions=row_positions,
                col_positions=col_positions,
                blue_values=blue_values,
                background_median=background_median,
                reference_threshold=settings.reference_threshold,
                max_cost=settings.max_cost,
                smoothing_window=settings.smoothing_window,
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
            or x_pixels.max() >= blue_channel.shape[0] - 1
            or y_pixels.min() <= 0
            or y_pixels.max() >= blue_channel.shape[1] - 1
        ):
            continue

        if edge_lookup and any((int(xp), int(yp)) in edge_lookup for xp, yp in zip(x_pixels, y_pixels)):
            continue

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
                x_pixels=x_pixels.astype(int),
                y_pixels=y_pixels.astype(int),
            )
        )

    return clusters


def _filter_cluster_pixels(
    cluster_indices: np.ndarray,
    current: int,
    row_positions: np.ndarray,
    col_positions: np.ndarray,
    blue_values: np.ndarray,
    background_median: float,
    reference_threshold: float,
    max_cost: float,
    smoothing_window: int,
) -> np.ndarray:
    current_position = np.where(cluster_indices == current)[0]
    if current_position.size != 1:
        raise ValueError("The starting pixel was not found in the cluster.")

    cost = (blue_values[cluster_indices] - blue_values[current]) ** 2 / background_median**2
    cost = np.maximum(cost, 0.0)
    accepted = np.array([int(current_position[0])], dtype=int)

    for local_index, mask_index in enumerate(cluster_indices):
        if mask_index == current:
            continue

        dark_candidates = cluster_indices[accepted][
            blue_values[cluster_indices[accepted]]
            <= ((background_median - blue_values[current]) * reference_threshold + blue_values[current])
        ]
        if dark_candidates.size == 0:
            raise ValueError("At least one dark reference pixel should exist in every cluster.")

        if dark_candidates.size > 1:
            distances_squared = (
                (row_positions[dark_candidates] - row_positions[mask_index]) ** 2
                + (col_positions[dark_candidates] - col_positions[mask_index]) ** 2
            )
            dark_reference = dark_candidates[np.argmin(distances_squared)]
        else:
            dark_reference = dark_candidates[0]

        if mask_index == dark_reference:
            accepted = np.append(accepted, local_index)
            continue

        x1 = row_positions[mask_index]
        y1 = col_positions[mask_index]
        x2 = row_positions[dark_reference]
        y2 = col_positions[dark_reference]
        x0 = row_positions[cluster_indices]
        y0 = col_positions[cluster_indices]

        line_distances = np.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) / np.sqrt(
            (y2 - y1) ** 2 + (x2 - x1) ** 2
        )
        distance_to_start = np.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
        distance_to_reference = np.sqrt((x2 - x0) ** 2 + (y2 - y0) ** 2)
        reference_distance = np.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

        on_path = np.where(
            (line_distances <= np.sqrt(2.0))
            & (distance_to_start <= reference_distance)
            & (distance_to_reference <= reference_distance)
        )[0]
        projected = np.sqrt(distance_to_reference[on_path] ** 2 - line_distances[on_path] ** 2)
        ordered_path = on_path[np.argsort(projected)]
        ordered_projected = np.sqrt(
            distance_to_reference[ordered_path] ** 2 - line_distances[ordered_path] ** 2
        )
        if ordered_projected.size > 1 and np.diff(ordered_projected).max() > np.sqrt(2.0) * 1.01:
            continue

        path_cost = cost[ordered_path]
        if smoothing_window < path_cost.size:
            path_cost = _smooth(path_cost, smoothing_window) * smoothing_window
        else:
            path_cost = np.full(path_cost.size, np.sum(path_cost))

        if np.max(path_cost) < max_cost:
            accepted = np.append(accepted, local_index)

    return accepted


def _polygon_edge_lookup(
    rows: np.ndarray,
    cols: np.ndarray,
    polygon_points: Iterable[tuple[float, float]] | None,
) -> set[tuple[int, int]]:
    if polygon_points is None:
        return set()

    x_points = cols.astype(float)
    y_points = rows.astype(float)
    polygon = list(polygon_points)
    edge_indices = _points_along_polygon(
        x_points,
        y_points,
        np.array([point[0] for point in polygon], dtype=float),
        np.array([point[1] for point in polygon], dtype=float),
    )
    return {(int(rows[index]), int(cols[index])) for index in edge_indices}


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


def _make_cluster_overlay(source_rgb: np.ndarray, clusters: list[Cluster]) -> np.ndarray:
    overlay = source_rgb.copy()
    for cluster in clusters:
        x_pixels = cluster.x_pixels
        y_pixels = cluster.y_pixels
        for pixel_index in range(x_pixels.size):
            neighbors = np.where(
                (np.abs(x_pixels - x_pixels[pixel_index]) <= 1)
                & (np.abs(y_pixels - y_pixels[pixel_index]) <= 1)
            )[0]
            if neighbors.size == 9:
                continue
            overlay[x_pixels[pixel_index], y_pixels[pixel_index]] = np.array([255, 0, 0], dtype=np.uint8)

        x_center = int(round(cluster.xmean))
        y_center = int(round(cluster.ymean))
        overlay[x_center, y_center] = np.array([80, 80, 255], dtype=np.uint8)
    return overlay


def _smooth(values: np.ndarray, window_size: int) -> np.ndarray:
    window = np.ones(int(window_size), dtype=float) / float(window_size)
    return np.convolve(values, window, "same")


def _quick_cluster(x_pixels: np.ndarray, y_pixels: np.ndarray, x_start: float, y_start: float) -> np.ndarray:
    x_to_check = np.array([x_start], dtype=float)
    y_to_check = np.array([y_start], dtype=float)

    x_remaining = x_pixels.copy()
    y_remaining = y_pixels.copy()
    remaining_indices = np.arange(x_pixels.size, dtype=int)

    start_index = np.where((x_remaining == x_start) & (y_remaining == y_start))[0]
    if start_index.size == 0:
        return np.array([], dtype=int)

    x_remaining = np.delete(x_remaining, start_index[0])
    y_remaining = np.delete(y_remaining, start_index[0])
    remaining_indices = np.delete(remaining_indices, start_index[0])

    output = start_index.astype(int)
    for _ in range(x_pixels.size):
        if x_to_check.size == 0:
            break

        selection = np.where(
            (np.abs(x_remaining - x_to_check[0]) + np.abs(y_remaining - y_to_check[0])) <= 1.001
        )[0]
        if selection.size == 0:
            x_to_check = np.delete(x_to_check, 0)
            y_to_check = np.delete(y_to_check, 0)
            continue

        output = np.append(output, remaining_indices[selection])
        x_to_check = np.append(x_to_check, x_remaining[selection])
        y_to_check = np.append(y_to_check, y_remaining[selection])
        x_to_check = np.delete(x_to_check, 0)
        y_to_check = np.delete(y_to_check, 0)

        if selection.size == x_remaining.size:
            break

        x_remaining = np.delete(x_remaining, selection)
        y_remaining = np.delete(y_remaining, selection)
        remaining_indices = np.delete(remaining_indices, selection)

    return output.astype(int)


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
