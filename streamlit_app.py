from __future__ import annotations

import math
import re
import shutil
from pathlib import Path

import altair as alt
import numpy as np
import pandas as pd
import pydeck as pdk
import streamlit as st
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import IsolationForest, RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.model_selection import KFold, StratifiedKFold, cross_val_score
from sklearn.neighbors import NearestNeighbors
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler


BASE_DIR = Path(__file__).resolve().parent
SOURCE_CSV = BASE_DIR / "Espresso Extraction TDS OrgCSV.csv"
WORKING_CSV = BASE_DIR / "Espresso Extraction TDS OrgCSV_editable.csv"
COLUMN_ORDER = [
    "Date",
    "Spray",
    "Avg Grind",
    "Roaster",
    "Region",
    "Lat",
    "Long",
    "Variety",
    "Processing Technique",
    "Elevation",
    "Roast",
    "Notes",
    "Continent",
    "Brix",
    "TempC",
    "AdjustmentTemp",
    "AdjustmentFactor",
    "TDS",
    "Dose",
    "Grind Setting",
    "Yield",
    "Time",
    "Extraction",
    "Rating",
]
RATING_LABELS = {"Bad": 0, "Good": 1, "Great": 2}
RATING_COLORS = {
    "Bad": "#F2AE84",
    "Good": "#F9D949",
    "Great": "#628F47",
}
MACRO_OPTIONS = [str(value) for value in range(1, 32)]
MICRO_OPTIONS = list("ABCDEFGHI")
TARGET_EXTRACTION_LOW = 18.0
TARGET_EXTRACTION_HIGH = 22.0
EXPERIMENT_NUMERIC_FEATURES = [
    "Brix",
    "TempC",
    "Dose",
    "Yield",
    "Time",
    "Avg Grind Numeric",
    "Grind Score",
]
EXPERIMENT_CATEGORICAL_FEATURES = [
    "Roaster",
    "Region",
    "Variety",
    "Processing Technique",
    "Roast",
    "Continent",
]


def ensure_working_csv() -> None:
    if not WORKING_CSV.exists():
        shutil.copy2(SOURCE_CSV, WORKING_CSV)


def calculate_adjustment_factor(temp_c: float) -> tuple[float, float]:
    adjusted_temp = 20 + (temp_c - 20)
    factor = (
        -0.4647
        - 0.03971 * adjusted_temp
        + 0.004669 * adjusted_temp**2
        - 0.00009287 * adjusted_temp**3
        + 0.0000008152 * adjusted_temp**4
    )
    return adjusted_temp, factor


def calculate_tds(brix: float, adjustment_factor: float) -> float:
    return (adjustment_factor + brix) * 0.85


def calculate_extraction(tds: float, yield_grams: float, dose: float) -> float:
    return tds * (yield_grams / dose)


def load_data() -> pd.DataFrame:
    ensure_working_csv()
    df = pd.read_csv(WORKING_CSV)
    backfilled, changed = backfill_computed_columns(df)
    normalized = normalize_dataframe(backfilled)
    if changed:
        save_dataframe(normalized.drop(columns=["Rating Label"]))
    return normalized


def latest_value(df: pd.DataFrame, column: str):
    if column not in df.columns:
        return None
    series = df[column].dropna()
    if series.empty:
        return None
    for value in series:
        if isinstance(value, str):
            if value.strip():
                return value
        else:
            return value
    return None


def placeholder_text(value) -> str:
    if value is None or pd.isna(value):
        return ""
    if isinstance(value, float):
        return f"{value:.4f}".rstrip("0").rstrip(".")
    return str(value)


def parse_optional_float(value: str) -> float | None:
    stripped = value.strip()
    if not stripped:
        return None
    return float(stripped)


def split_grind_setting(value: str | None) -> tuple[str, str]:
    if not value:
        return "10", "E"
    text = str(value).strip().upper()
    if not text:
        return "10", "E"
    macro = "".join(char for char in text if char.isdigit())
    micro = "".join(char for char in text if char.isalpha())
    if macro not in MACRO_OPTIONS:
        macro = "10"
    if micro not in MICRO_OPTIONS:
        micro = "E"
    return macro, micro


def grind_setting_to_score(value: str | None) -> float | None:
    if value is None or pd.isna(value):
        return None
    text = str(value).strip().upper()
    match = re.fullmatch(r"(\d{1,2})([A-I])(?:\.5)?", text)
    if not match:
        return None
    macro = int(match.group(1))
    micro = MICRO_OPTIONS.index(match.group(2))
    half_step = 0.5 if text.endswith(".5") else 0.0
    return macro * 10 + micro + half_step


def parse_optional_number(value: str) -> float | None:
    try:
        return parse_optional_float(value)
    except ValueError:
        return None


def match_nonempty(series: pd.Series, value: str) -> pd.Series:
    if not value.strip():
        return pd.Series([True] * len(series), index=series.index)
    return series.fillna("").astype(str).str.strip().str.casefold() == value.strip().casefold()


def recommend_grind_setting(
    df: pd.DataFrame,
    roaster: str,
    region: str,
    variety: str,
    processing_technique: str,
    roast: str,
    continent: str,
) -> tuple[str, str]:
    candidates = df.copy()
    filters = [
        ("Roaster", roaster),
        ("Region", region),
        ("Variety", variety),
        ("Processing Technique", processing_technique),
        ("Roast", roast),
        ("Continent", continent),
    ]
    for column, value in filters:
        if value.strip():
            filtered = candidates[match_nonempty(candidates[column], value)]
            if not filtered.empty:
                candidates = filtered

    rated = candidates.dropna(subset=["Grind Setting", "Rating"]).copy()
    rated = rated[rated["Grind Setting"].fillna("").astype(str).str.strip() != ""]
    if rated.empty:
        return "No recommendation yet", "Add shots for this coffee to generate a grind recommendation."

    rated = rated.copy()
    rated["Date"] = pd.to_datetime(rated["Date"], errors="coerce")
    newest_date = rated["Date"].max()
    if pd.notna(newest_date):
        age_days = (newest_date - rated["Date"]).dt.days.fillna(0).clip(lower=0)
        rated["recency_weight"] = 1 / (1 + age_days / 14)
    else:
        rated["recency_weight"] = 1.0

    rated["target_center_distance"] = (rated["Extraction"] - 20.0).abs()
    rated["in_target_window"] = rated["Extraction"].between(TARGET_EXTRACTION_LOW, TARGET_EXTRACTION_HIGH, inclusive="both")

    summary = (
        rated.groupby("Grind Setting", dropna=False)
        .apply(
            lambda group: pd.Series(
                {
                    "weighted_rating": (group["Rating"] * group["recency_weight"]).sum() / group["recency_weight"].sum(),
                    "weighted_extraction": (group["Extraction"] * group["recency_weight"]).sum() / group["recency_weight"].sum(),
                    "window_hit_rate": (group["in_target_window"] * group["recency_weight"]).sum() / group["recency_weight"].sum(),
                    "center_distance": (group["target_center_distance"] * group["recency_weight"]).sum() / group["recency_weight"].sum(),
                    "shots": len(group),
                }
            )
        )
        .reset_index()
        .sort_values(
            ["window_hit_rate", "weighted_rating", "center_distance", "shots"],
            ascending=[False, False, True, False],
        )
    )
    best = summary.iloc[0]
    label = str(best["Grind Setting"])
    detail = (
        f"{int(best['shots'])} shots | target hit {best['window_hit_rate']:.0%} | "
        f"weighted extraction {best['weighted_extraction']:.2f}% | weighted rating {best['weighted_rating']:.2f}"
    )
    return label, detail


def prepare_experiment_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    prepared = df.copy()
    prepared["Avg Grind Numeric"] = pd.to_numeric(prepared["Avg Grind"], errors="coerce")
    prepared["Grind Score"] = prepared["Grind Setting"].apply(grind_setting_to_score)
    for column in EXPERIMENT_CATEGORICAL_FEATURES:
        prepared[column] = (
            prepared[column]
            .fillna("Unknown")
            .astype(str)
            .str.strip()
            .replace("", "Unknown")
        )
    for column in EXPERIMENT_NUMERIC_FEATURES + ["Extraction", "Rating"]:
        if column in prepared.columns:
            prepared[column] = pd.to_numeric(prepared[column], errors="coerce")
    return prepared


def build_experiment_models(df: pd.DataFrame) -> dict[str, object] | None:
    prepared = prepare_experiment_dataframe(df)
    modeling_df = prepared.dropna(subset=["Extraction", "Rating"]).copy()
    if len(modeling_df) < 25:
        return None

    feature_columns = EXPERIMENT_NUMERIC_FEATURES + EXPERIMENT_CATEGORICAL_FEATURES
    X = modeling_df[feature_columns]
    y_extraction = modeling_df["Extraction"]
    y_rating = modeling_df["Rating"].astype(int)

    preprocessor = ColumnTransformer(
        transformers=[
            ("num", Pipeline([("imputer", SimpleImputer(strategy="median"))]), EXPERIMENT_NUMERIC_FEATURES),
            (
                "cat",
                Pipeline(
                    [
                        ("imputer", SimpleImputer(strategy="most_frequent")),
                        ("onehot", OneHotEncoder(handle_unknown="ignore")),
                    ]
                ),
                EXPERIMENT_CATEGORICAL_FEATURES,
            ),
        ]
    )

    extraction_model = Pipeline(
        [
            ("preprocessor", preprocessor),
            ("model", RandomForestRegressor(n_estimators=300, min_samples_leaf=2, random_state=42)),
        ]
    )
    rating_model = Pipeline(
        [
            ("preprocessor", preprocessor),
            (
                "model",
                RandomForestClassifier(
                    n_estimators=300,
                    min_samples_leaf=2,
                    random_state=42,
                    class_weight="balanced_subsample",
                ),
            ),
        ]
    )

    regression_splits = max(2, min(5, len(modeling_df) // 20))
    extraction_cv = KFold(n_splits=regression_splits, shuffle=True, random_state=42)
    class_counts = y_rating.value_counts()
    classification_splits = max(2, min(4, int(class_counts.min())))
    rating_cv = StratifiedKFold(n_splits=classification_splits, shuffle=True, random_state=42)

    extraction_r2 = float(cross_val_score(extraction_model, X, y_extraction, cv=extraction_cv, scoring="r2").mean())
    extraction_mae = float(
        -cross_val_score(extraction_model, X, y_extraction, cv=extraction_cv, scoring="neg_mean_absolute_error").mean()
    )
    rating_balanced_accuracy = float(
        cross_val_score(rating_model, X, y_rating, cv=rating_cv, scoring="balanced_accuracy").mean()
    )

    extraction_model.fit(X, y_extraction)
    rating_model.fit(X, y_rating)

    similarity_preprocessor = ColumnTransformer(
        transformers=[
            (
                "num",
                Pipeline(
                    [
                        ("imputer", SimpleImputer(strategy="median")),
                        ("scale", StandardScaler()),
                    ]
                ),
                EXPERIMENT_NUMERIC_FEATURES,
            ),
            (
                "cat",
                Pipeline(
                    [
                        ("imputer", SimpleImputer(strategy="most_frequent")),
                        ("onehot", OneHotEncoder(handle_unknown="ignore")),
                    ]
                ),
                EXPERIMENT_CATEGORICAL_FEATURES,
            ),
        ]
    )
    similarity_matrix = similarity_preprocessor.fit_transform(modeling_df[feature_columns])
    novelty_model = IsolationForest(random_state=42, contamination=0.12)
    novelty_model.fit(similarity_matrix)

    successful_shots = modeling_df[
        (modeling_df["Rating"] >= 1)
        & modeling_df["Extraction"].between(TARGET_EXTRACTION_LOW, TARGET_EXTRACTION_HIGH, inclusive="both")
    ].copy()
    nearest_success = None
    successful_matrix = None
    if len(successful_shots) >= 5:
        successful_matrix = similarity_preprocessor.transform(successful_shots[feature_columns])
        nearest_success = NearestNeighbors(
            n_neighbors=min(5, len(successful_shots)),
            metric="cosine",
        )
        nearest_success.fit(successful_matrix)

    return {
        "prepared": prepared,
        "feature_columns": feature_columns,
        "extraction_model": extraction_model,
        "rating_model": rating_model,
        "similarity_preprocessor": similarity_preprocessor,
        "novelty_model": novelty_model,
        "nearest_success": nearest_success,
        "successful_shots": successful_shots,
        "successful_matrix": successful_matrix,
        "extraction_r2": extraction_r2,
        "extraction_mae": extraction_mae,
        "rating_balanced_accuracy": rating_balanced_accuracy,
        "rows": len(modeling_df),
    }


def build_current_context(
    roaster: str,
    region: str,
    variety: str,
    processing_technique: str,
    roast: str,
    continent: str,
    brix: float,
    temp_c: float,
    dose: float,
    yield_grams: float,
    shot_time: int,
    avg_grind_value: str,
    grind_setting: str,
) -> pd.DataFrame:
    avg_grind_numeric = parse_optional_number(avg_grind_value) if avg_grind_value else None
    return pd.DataFrame(
        [
            {
                "Brix": brix,
                "TempC": temp_c,
                "Dose": dose,
                "Yield": yield_grams,
                "Time": shot_time,
                "Avg Grind Numeric": avg_grind_numeric,
                "Grind Score": grind_setting_to_score(grind_setting),
                "Roaster": roaster.strip() or "Unknown",
                "Region": region.strip() or "Unknown",
                "Variety": variety.strip() or "Unknown",
                "Processing Technique": processing_technique.strip() or "Unknown",
                "Roast": roast.strip() or "Unknown",
                "Continent": continent.strip() or "Unknown",
            }
        ]
    )


def simulate_grind_sweep(
    prepared_df: pd.DataFrame,
    extraction_model,
    rating_model,
    context_row: pd.DataFrame,
) -> pd.DataFrame:
    candidates = (
        prepared_df[["Grind Setting", "Grind Score", "Avg Grind Numeric"]]
        .dropna(subset=["Grind Setting", "Grind Score"])
        .drop_duplicates()
        .sort_values("Grind Score")
        .copy()
    )
    if candidates.empty:
        return pd.DataFrame()

    base = pd.concat([context_row] * len(candidates), ignore_index=True)
    base["Grind Score"] = candidates["Grind Score"].to_numpy()
    base["Avg Grind Numeric"] = candidates["Avg Grind Numeric"].to_numpy()

    extraction_pred = extraction_model.predict(base)
    rating_probs = rating_model.predict_proba(base)
    classes = rating_model.named_steps["model"].classes_
    great_index = int(np.where(classes == 2)[0][0]) if 2 in classes else len(classes) - 1

    sweep = candidates.copy()
    sweep["Predicted Extraction"] = extraction_pred
    sweep["Great Probability"] = rating_probs[:, great_index]
    sweep["Target Distance"] = (sweep["Predicted Extraction"] - 20.0).abs()
    sweep["In Target Window"] = sweep["Predicted Extraction"].between(
        TARGET_EXTRACTION_LOW,
        TARGET_EXTRACTION_HIGH,
        inclusive="both",
    )
    return sweep


def find_similar_successful_shots(models: dict[str, object], context_row: pd.DataFrame) -> pd.DataFrame:
    nearest_success = models.get("nearest_success")
    successful_shots = models.get("successful_shots")
    similarity_preprocessor = models.get("similarity_preprocessor")
    if nearest_success is None or successful_shots is None or similarity_preprocessor is None or successful_shots.empty:
        return pd.DataFrame()

    context_matrix = similarity_preprocessor.transform(context_row)
    distances, indices = nearest_success.kneighbors(context_matrix)
    similar = successful_shots.iloc[indices[0]].copy()
    similar["Similarity Distance"] = distances[0]
    return similar


def normalize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    normalized = df.copy()
    for column in COLUMN_ORDER:
        if column not in normalized.columns:
            normalized[column] = pd.NA
    normalized["Date"] = pd.to_datetime(normalized["Date"], errors="coerce")
    for column in ["Lat", "Long", "Brix", "TempC", "Dose", "Yield", "Time", "AdjustmentTemp", "AdjustmentFactor", "TDS", "Extraction"]:
        normalized[column] = pd.to_numeric(normalized[column], errors="coerce")

    temp_adjustment = normalized["TempC"].apply(
        lambda value: calculate_adjustment_factor(value) if pd.notna(value) else (pd.NA, pd.NA)
    )
    computed_adjustment_temp = temp_adjustment.apply(lambda item: item[0])
    computed_adjustment_factor = temp_adjustment.apply(lambda item: item[1])
    normalized["AdjustmentTemp"] = normalized.apply(
        lambda row: computed_adjustment_temp.loc[row.name]
        if pd.notna(row["TempC"])
        else row["AdjustmentTemp"],
        axis=1,
    )
    normalized["AdjustmentFactor"] = normalized.apply(
        lambda row: computed_adjustment_factor.loc[row.name]
        if pd.notna(row["TempC"])
        else row["AdjustmentFactor"],
        axis=1,
    )
    computed_tds = normalized.apply(
        lambda row: calculate_tds(row["Brix"], row["AdjustmentFactor"])
        if pd.notna(row["Brix"]) and pd.notna(row["AdjustmentFactor"])
        else pd.NA,
        axis=1,
    )
    normalized["TDS"] = normalized.apply(
        lambda row: computed_tds.loc[row.name]
        if pd.notna(row["Brix"]) and pd.notna(row["AdjustmentFactor"])
        else row["TDS"],
        axis=1,
    )
    computed_extraction = normalized.apply(
        lambda row: calculate_extraction(row["TDS"], row["Yield"], row["Dose"])
        if pd.notna(row["TDS"]) and pd.notna(row["Yield"]) and pd.notna(row["Dose"]) and row["Dose"] != 0
        else pd.NA,
        axis=1,
    )
    normalized["Extraction"] = normalized.apply(
        lambda row: computed_extraction.loc[row.name]
        if pd.notna(row["TDS"]) and pd.notna(row["Yield"]) and pd.notna(row["Dose"]) and row["Dose"] != 0
        else row["Extraction"],
        axis=1,
    )
    normalized["Rating"] = pd.to_numeric(normalized["Rating"], errors="coerce").astype("Int64")
    normalized["Rating Label"] = normalized["Rating"].map({value: key for key, value in RATING_LABELS.items()})
    normalized = normalized.sort_values("Date", ascending=False, na_position="last")
    return normalized


def backfill_computed_columns(df: pd.DataFrame) -> tuple[pd.DataFrame, bool]:
    backfilled = df.copy()
    changed = False

    for column in COLUMN_ORDER:
        if column not in backfilled.columns:
            backfilled[column] = pd.NA

    for column in ["Brix", "TempC", "Dose", "Yield", "Time"]:
        backfilled[column] = pd.to_numeric(backfilled[column], errors="coerce")

    for index, row in backfilled.iterrows():
        temp_c = row.get("TempC")
        brix = row.get("Brix")
        dose = row.get("Dose")
        yield_grams = row.get("Yield")

        adjustment_temp = row.get("AdjustmentTemp")
        adjustment_factor = row.get("AdjustmentFactor")
        tds = row.get("TDS")
        extraction = row.get("Extraction")

        if pd.notna(temp_c):
            computed_adjustment_temp, computed_adjustment_factor = calculate_adjustment_factor(temp_c)
            new_adjustment_temp = round(computed_adjustment_temp, 2)
            new_adjustment_factor = round(computed_adjustment_factor, 4)
            if pd.isna(adjustment_temp) or round(float(adjustment_temp), 2) != new_adjustment_temp:
                backfilled.at[index, "AdjustmentTemp"] = new_adjustment_temp
                changed = True
            if pd.isna(adjustment_factor) or round(float(adjustment_factor), 4) != new_adjustment_factor:
                backfilled.at[index, "AdjustmentFactor"] = new_adjustment_factor
                changed = True
        else:
            computed_adjustment_temp, computed_adjustment_factor = (pd.NA, pd.NA)

        usable_adjustment_factor = computed_adjustment_factor if pd.notna(computed_adjustment_factor) else pd.to_numeric(pd.Series([adjustment_factor]), errors="coerce").iloc[0]
        if pd.notna(brix) and pd.notna(usable_adjustment_factor):
            new_tds = round(calculate_tds(brix, usable_adjustment_factor), 2)
            if pd.isna(tds) or round(float(tds), 2) != new_tds:
                backfilled.at[index, "TDS"] = new_tds
                changed = True

        usable_tds = pd.to_numeric(pd.Series([backfilled.at[index, "TDS"]]), errors="coerce").iloc[0]
        if pd.notna(usable_tds) and pd.notna(dose) and pd.notna(yield_grams) and dose != 0:
            new_extraction = round(calculate_extraction(usable_tds, yield_grams, dose), 2)
            if pd.isna(extraction) or round(float(extraction), 2) != new_extraction:
                backfilled.at[index, "Extraction"] = new_extraction
                changed = True

    return backfilled, changed


def restore_missing_computed_from_source() -> bool:
    if not SOURCE_CSV.exists() or not WORKING_CSV.exists():
        return False
    source = pd.read_csv(SOURCE_CSV)
    working = pd.read_csv(WORKING_CSV)
    key_columns = ["Date", "Roaster", "Region", "Variety", "Processing Technique", "Roast", "Notes"]
    computed_columns = ["AdjustmentTemp", "AdjustmentFactor", "TDS", "Extraction"]
    for column in key_columns + computed_columns:
        if column not in source.columns or column not in working.columns:
            return False

    changed = False
    source_lookup = source.set_index(key_columns)
    for index, row in working.iterrows():
        key = tuple(row.get(column) for column in key_columns)
        if key in source_lookup.index:
            source_row = source_lookup.loc[key]
            if isinstance(source_row, pd.DataFrame):
                source_row = source_row.iloc[0]
            for column in computed_columns:
                if pd.isna(row.get(column)) and pd.notna(source_row.get(column)):
                    working.at[index, column] = source_row.get(column)
                    changed = True
    if changed:
        working.to_csv(WORKING_CSV, index=False)
    return changed


def save_dataframe(df: pd.DataFrame) -> None:
    writable = df.copy()
    writable["Date"] = writable["Date"].dt.strftime("%-m/%-d/%Y")
    writable["Rating"] = writable["Rating"].astype("Int64")
    writable = writable[COLUMN_ORDER]
    writable.to_csv(WORKING_CSV, index=False)


def add_entry(
    entry_date,
    roaster: str,
    region: str,
    latitude: float | None,
    longitude: float | None,
    variety: str,
    processing_technique: str,
    elevation: str,
    roast: str,
    notes: str,
    continent: str,
    temp_c: float,
    brix: float,
    dose: float,
    avg_grind: str,
    grind_setting: str,
    yield_grams: float,
    shot_time: int,
    rating_label: str,
) -> None:
    df = load_data()
    adjustment_temp, adjustment_factor = calculate_adjustment_factor(temp_c)
    tds = calculate_tds(brix, adjustment_factor)
    extraction = calculate_extraction(tds, yield_grams, dose)
    new_row = pd.DataFrame(
        [
            {
                "Date": pd.Timestamp(entry_date),
                "Roaster": roaster.strip(),
                "Region": region.strip(),
                "Lat": latitude,
                "Long": longitude,
                "Variety": variety.strip(),
                "Processing Technique": processing_technique.strip(),
                "Elevation": elevation.strip(),
                "Roast": roast.strip(),
                "Notes": notes.strip(),
                "Continent": continent.strip(),
                "Brix": round(brix, 2),
                "TempC": round(temp_c, 2),
                "AdjustmentTemp": round(adjustment_temp, 2),
                "AdjustmentFactor": round(adjustment_factor, 4),
                "TDS": round(tds, 2),
                "Dose": round(dose, 2),
                "Avg Grind": avg_grind.strip(),
                "Grind Setting": grind_setting.strip(),
                "Yield": round(yield_grams, 2),
                "Time": int(shot_time),
                "Extraction": round(extraction, 2),
                "Rating": RATING_LABELS[rating_label],
            }
        ]
    )
    updated = pd.concat([df.drop(columns=["Rating Label"]), new_row], ignore_index=True)
    save_dataframe(normalize_dataframe(updated).drop(columns=["Rating Label"]))


def reset_working_copy() -> None:
    shutil.copy2(SOURCE_CSV, WORKING_CSV)


st.set_page_config(page_title="Espresso Dashboard", layout="wide")
st.title("Espresso Shot Dashboard")
st.caption("The app reads from an editable CSV copy. Your original export remains untouched.")

ensure_working_csv()
df = load_data()
last_entry = df.iloc[0] if not df.empty else pd.Series(dtype="object")

with st.sidebar:
    st.subheader("Data File")
    st.code(str(WORKING_CSV.name))
    if st.button("Reset Editable Copy to Original", type="secondary"):
        reset_working_copy()
        st.success("Editable CSV reset from original source.")
        st.rerun()

col1, col2, col3, col4 = st.columns(4)
col1.metric("Shots Logged", len(df))
col2.metric("Average TDS", f"{df['TDS'].mean():.2f}")
col3.metric("Average Extraction", f"{df['Extraction'].mean():.2f}")
col4.metric("Average Rating", f"{df['Rating'].mean():.2f}")

dashboard_tab, coffees_tab, experiment_tab = st.tabs(["Dashboard", "Coffee Origins", "Experiment"])

with dashboard_tab:
    with st.expander("Add historical shot", expanded=True):
        carry_forward = st.toggle("Carry forward previous values", value=True)
        carry_shot = st.toggle("Carry forward previous pull settings", value=True)
        recommendation_box = st.empty()
        form_col1, form_col2, form_col3 = st.columns(3)
        with form_col1:
            entry_date = st.date_input("Date")
            roaster = st.text_input("Roaster", placeholder=placeholder_text(latest_value(df, "Roaster")))
            region = st.text_input("Region", placeholder=placeholder_text(latest_value(df, "Region")))
            continent = st.text_input("Continent", placeholder=placeholder_text(latest_value(df, "Continent")))
            temp_c = st.number_input(
                "Temperature (C)",
                min_value=0.0,
                max_value=100.0,
                value=float(latest_value(df, "TempC") or 28.0) if carry_shot else 28.0,
                step=0.1,
            )
            brix = st.number_input(
                "Brix",
                min_value=0.0,
                max_value=30.0,
                value=float(latest_value(df, "Brix") or 10.0),
                step=0.1,
            )
            live_adjustment_temp, live_adjustment_factor = calculate_adjustment_factor(temp_c)
            live_tds = calculate_tds(brix, live_adjustment_factor)
            st.text_input("TDS", value=f"{live_tds:.2f}", disabled=True)
        with form_col2:
            dose = st.number_input(
                "Dose (g)",
                min_value=0.0,
                max_value=50.0,
                value=float(latest_value(df, "Dose") or 18.0) if carry_shot else 18.0,
                step=0.1,
            )
            yield_grams = st.number_input(
                "Output / Yield (g)",
                min_value=0.0,
                max_value=100.0,
                value=float(latest_value(df, "Yield") or 36.0) if carry_shot else 36.0,
                step=0.1,
            )
            shot_time = st.number_input(
                "Time (s)",
                min_value=0,
                max_value=120,
                value=int(latest_value(df, "Time") or 30) if carry_shot else 30,
                step=1,
            )
            avg_grind = st.text_input(
                "Grind Size (micrometers)",
                placeholder=placeholder_text(latest_value(df, "Avg Grind")),
            )
            last_macro, last_micro = split_grind_setting(latest_value(df, "Grind Setting"))
            grind_col1, grind_col2 = st.columns(2)
            with grind_col1:
                grind_macro = st.selectbox(
                    "Grind Macro",
                    options=MACRO_OPTIONS,
                    index=MACRO_OPTIONS.index(last_macro if carry_shot else "10"),
                )
            with grind_col2:
                grind_micro = st.selectbox(
                    "Grind Micro",
                    options=MICRO_OPTIONS,
                    index=MICRO_OPTIONS.index(last_micro if carry_shot else "E"),
                )
            grind_setting = f"{grind_macro}{grind_micro}"
            latitude_text = st.text_input("Lat", placeholder=placeholder_text(latest_value(df, "Lat")))
            longitude_text = st.text_input("Long", placeholder=placeholder_text(latest_value(df, "Long")))
            elevation_text = st.text_input("Elevation", placeholder=placeholder_text(latest_value(df, "Elevation")))
        with form_col3:
            variety = st.text_input("Variety", placeholder=placeholder_text(latest_value(df, "Variety")))
            processing_technique = st.text_input(
                "Processing Technique",
                placeholder=placeholder_text(latest_value(df, "Processing Technique")),
            )
            roast = st.text_input("Roast", placeholder=placeholder_text(latest_value(df, "Roast")))
            notes = st.text_area("Notes", placeholder=placeholder_text(latest_value(df, "Notes")))
            rating_label = st.selectbox(
                "Rating",
                options=list(RATING_LABELS.keys()),
                index=int(latest_value(df, "Rating") or 1),
            )
            preview_extraction = calculate_extraction(live_tds, yield_grams, dose) if dose else 0.0
            st.caption(
                f"Adj Temp: {live_adjustment_temp:.2f} | Adj Factor: {live_adjustment_factor:.4f} | Extraction: {preview_extraction:.2f}"
            )
            recommended_grind, recommendation_detail = recommend_grind_setting(
                df,
                roaster or placeholder_text(latest_value(df, "Roaster")),
                region or placeholder_text(latest_value(df, "Region")),
                variety or placeholder_text(latest_value(df, "Variety")),
                processing_technique or placeholder_text(latest_value(df, "Processing Technique")),
                roast or placeholder_text(latest_value(df, "Roast")),
                continent or placeholder_text(latest_value(df, "Continent")),
            )
            recommendation_box.markdown(
                f"""
<div style="padding: 0.85rem 1rem; border-radius: 18px; background: #f3efe7; border: 1px solid #d8cfbf; margin-bottom: 0.75rem;">
  <div style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6d6253;">Recommended Grind Setting</div>
  <div style="font-size: 1.7rem; font-weight: 700; color: #2d241c; line-height: 1.1;">{recommended_grind}</div>
  <div style="font-size: 0.82rem; color: #6d6253; margin-top: 0.2rem;">{recommendation_detail}</div>
</div>
""",
                unsafe_allow_html=True,
            )
            if st.button("Add row", type="primary", use_container_width=True):
                latitude = parse_optional_float(latitude_text) if latitude_text.strip() else parse_optional_float(placeholder_text(latest_value(df, "Lat"))) if carry_forward and placeholder_text(latest_value(df, "Lat")) else None
                longitude = parse_optional_float(longitude_text) if longitude_text.strip() else parse_optional_float(placeholder_text(latest_value(df, "Long"))) if carry_forward and placeholder_text(latest_value(df, "Long")) else None
                elevation = elevation_text or (placeholder_text(latest_value(df, "Elevation")) if carry_forward else "")
                add_entry(
                    entry_date,
                    roaster or placeholder_text(latest_value(df, "Roaster")),
                    region or placeholder_text(latest_value(df, "Region")),
                    latitude,
                    longitude,
                    variety or placeholder_text(latest_value(df, "Variety")),
                    processing_technique or placeholder_text(latest_value(df, "Processing Technique")),
                    elevation,
                    roast or placeholder_text(latest_value(df, "Roast")),
                    notes or placeholder_text(latest_value(df, "Notes")),
                    continent or placeholder_text(latest_value(df, "Continent")),
                    temp_c,
                    brix,
                    dose,
                    avg_grind or placeholder_text(latest_value(df, "Avg Grind")),
                    grind_setting,
                    yield_grams,
                    shot_time,
                    rating_label,
                )
                st.success("Row added to editable CSV.")
                st.rerun()

    chart_data = df.dropna(subset=["Extraction", "TDS", "Rating Label"]).copy()

    scatter = (
        alt.Chart(chart_data)
        .mark_circle(size=140, opacity=0.8)
        .encode(
            x=alt.X("Extraction:Q", title="Extraction"),
            y=alt.Y("TDS:Q", title="Total Dissolved Solids"),
            color=alt.Color(
                "Rating Label:N",
                scale=alt.Scale(
                    domain=list(RATING_COLORS.keys()),
                    range=list(RATING_COLORS.values()),
                ),
                legend=alt.Legend(title="Rating"),
            ),
            tooltip=[
                alt.Tooltip("Date:T", title="Date"),
                alt.Tooltip("Roaster:N"),
                alt.Tooltip("Region:N"),
                alt.Tooltip("Notes:N"),
                alt.Tooltip("Avg Grind:N", title="Avg Grind (um)"),
                alt.Tooltip("Grind Setting:N", title="Grind"),
                alt.Tooltip("Dose:Q", format=".2f"),
                alt.Tooltip("Yield:Q", title="Output", format=".2f"),
                alt.Tooltip("Time:Q", title="Time (s)"),
                alt.Tooltip("TDS:Q", format=".2f"),
                alt.Tooltip("Extraction:Q", format=".2f"),
                alt.Tooltip("Rating Label:N", title="Rating"),
            ],
        )
        .properties(height=420)
    )

    reference_lines = pd.DataFrame(
        [
            {"x": 18, "y": chart_data["TDS"].min() if not chart_data.empty else 0},
            {"x": 22, "y": chart_data["TDS"].min() if not chart_data.empty else 0},
        ]
    )
    tds_lines = pd.DataFrame(
        [
            {"y": 1.2},
            {"y": 1.45},
        ]
    )

    verticals = alt.Chart(reference_lines).mark_rule(strokeDash=[6, 6], color="black").encode(x="x:Q")
    horizontals = alt.Chart(tds_lines).mark_rule(strokeDash=[6, 6], color="black").encode(y="y:Q")

    trend = (
        alt.Chart(df.dropna(subset=["Date", "Extraction", "TDS"]))
        .mark_line(point=True)
        .encode(
            x=alt.X("Date:T"),
            y=alt.Y("Extraction:Q", title="Extraction"),
            tooltip=[
                alt.Tooltip("Date:T", title="Date"),
                alt.Tooltip("Roaster:N"),
                alt.Tooltip("Extraction:Q", format=".2f"),
                alt.Tooltip("TDS:Q", format=".2f"),
            ],
        )
        .properties(height=250)
    )

    left, right = st.columns([1.4, 1])
    with left:
        st.subheader("TDS vs. Extraction")
        st.altair_chart(scatter + verticals + horizontals, use_container_width=True)
    with right:
        st.subheader("Extraction Over Time")
        st.altair_chart(trend, use_container_width=True)

    st.subheader("Shot Log")
    display_df = df.copy()
    display_df["Date"] = display_df["Date"].dt.strftime("%Y-%m-%d")
    st.dataframe(
        display_df[
            [
                "Date",
                "Roaster",
                "Region",
                "Continent",
                "Variety",
                "Processing Technique",
                "Elevation",
                "Roast",
                "Notes",
                "Avg Grind",
                "Grind Setting",
                "Dose",
                "Yield",
                "Time",
                "Brix",
                "TempC",
                "TDS",
                "Extraction",
                "Rating Label",
            ]
        ],
        use_container_width=True,
        hide_index=True,
    )

with coffees_tab:
    st.subheader("Coffee Origins")
    coffee_df = df.copy()
    coffee_df["Date Label"] = coffee_df["Date"].dt.strftime("%Y-%m-%d")
    if st.button("Reset Filters", key="reset_coffee_filters"):
        for key in [
            "coffee_roasters",
            "coffee_regions",
            "coffee_varieties",
            "coffee_continents",
        ]:
            if key in st.session_state:
                st.session_state[key] = []
        st.rerun()
    show_unknown_continent = st.toggle("Show null/unknown continent values", value=True, key="show_unknown_continent")
    filter_col1, filter_col2, filter_col3, filter_col4 = st.columns(4)
    with filter_col1:
        selected_roasters = st.multiselect(
            "Roaster",
            sorted([value for value in coffee_df["Roaster"].dropna().unique() if str(value).strip()]),
            key="coffee_roasters",
        )
    with filter_col2:
        selected_regions = st.multiselect(
            "Region",
            sorted([value for value in coffee_df["Region"].dropna().unique() if str(value).strip()]),
            key="coffee_regions",
        )
    with filter_col3:
        selected_varieties = st.multiselect(
            "Variety",
            sorted([value for value in coffee_df["Variety"].dropna().unique() if str(value).strip()]),
            key="coffee_varieties",
        )
    with filter_col4:
        selected_continents = st.multiselect(
            "Continent",
            sorted([value for value in coffee_df["Continent"].dropna().unique() if str(value).strip()]),
            key="coffee_continents",
        )

    if selected_roasters:
        coffee_df = coffee_df[coffee_df["Roaster"].isin(selected_roasters)]
    if selected_regions:
        coffee_df = coffee_df[coffee_df["Region"].isin(selected_regions)]
    if selected_varieties:
        coffee_df = coffee_df[coffee_df["Variety"].isin(selected_varieties)]
    if selected_continents:
        coffee_df = coffee_df[coffee_df["Continent"].isin(selected_continents)]

    origins_plot_df = coffee_df.dropna(subset=["Lat", "Long", "Extraction", "TDS"]).copy()
    origins_plot_df["Continent Display"] = (
        origins_plot_df["Continent"].fillna("").astype(str).str.strip().replace("", "Unknown")
    )
    if not show_unknown_continent:
        origins_plot_df = origins_plot_df[origins_plot_df["Continent Display"] != "Unknown"]
    map_df = origins_plot_df.copy()
    if not map_df.empty:
        map_df["Date Label"] = map_df["Date"].dt.strftime("%Y-%m-%d")
        map_df["tooltip_html"] = map_df.apply(
            lambda row: (
                f"<b>{row.get('Roaster', '')}</b><br/>"
                f"{row.get('Region', '')}<br/>"
                f"Continent: {row.get('Continent Display', 'Unknown')}<br/>"
                f"Extraction: {row.get('Extraction', float('nan')):.2f}<br/>"
                f"TDS: {row.get('TDS', float('nan')):.2f}<br/>"
                f"Dose: {row.get('Dose', float('nan')):.2f} g<br/>"
                f"Yield: {row.get('Yield', float('nan')):.2f} g<br/>"
                f"Time: {row.get('Time', float('nan')):.0f} s<br/>"
                f"Grind: {row.get('Grind Setting', '')} | {row.get('Avg Grind', '')} um<br/>"
                f"Date: {row.get('Date Label', '')}"
            ),
            axis=1,
        )
        layer = pdk.Layer(
            "ScatterplotLayer",
            data=map_df,
            get_position="[Long, Lat]",
            get_radius=50000,
            radius_min_pixels=5,
            radius_max_pixels=12,
            get_fill_color="[200, 92, 58, 180]",
            pickable=True,
        )
        view_state = pdk.ViewState(
            latitude=float(map_df["Lat"].mean()),
            longitude=float(map_df["Long"].mean()),
            zoom=1.5,
            pitch=0,
        )
        st.pydeck_chart(
            pdk.Deck(
                layers=[layer],
                initial_view_state=view_state,
                tooltip={"html": "{tooltip_html}", "style": {"backgroundColor": "#f3efe7", "color": "#2d241c"}},
            ),
            use_container_width=True,
        )
    else:
        st.info("Add latitude and longitude to map coffee origins.")

    notes_chart_data = origins_plot_df.copy()
    if not notes_chart_data.empty:
        known_continent_data = notes_chart_data[notes_chart_data["Continent Display"] != "Unknown"].copy()
        unknown_continent_data = notes_chart_data[notes_chart_data["Continent Display"] == "Unknown"].copy()
        known_continent_values = sorted(known_continent_data["Continent Display"].dropna().unique().tolist())
        continent_colors = {
            "Africa": "#6b8f71",
            "Asia": "#d9a441",
            "North America": "#3b6fb6",
            "South America": "#c85c3a",
            "Europe": "#7d5ba6",
            "Oceania": "#2a9d8f",
        }
        known_chart = (
            alt.Chart(known_continent_data)
            .mark_circle(size=150, opacity=0.8)
            .encode(
                x=alt.X("Extraction:Q", title="Extraction"),
                y=alt.Y("TDS:Q", title="TDS"),
                color=alt.Color(
                    "Continent Display:N",
                    scale=alt.Scale(
                        domain=known_continent_values,
                        range=[continent_colors.get(value, "#888888") for value in known_continent_values],
                    ),
                ),
                tooltip=[
                    alt.Tooltip("Roaster:N"),
                    alt.Tooltip("Continent Display:N", title="Continent"),
                    alt.Tooltip("Region:N"),
                    alt.Tooltip("Variety:N"),
                    alt.Tooltip("Processing Technique:N"),
                    alt.Tooltip("Roast:N"),
                    alt.Tooltip("Notes:N"),
                    alt.Tooltip("Avg Grind:N", title="Avg Grind (um)"),
                    alt.Tooltip("Grind Setting:N"),
                    alt.Tooltip("Dose:Q"),
                    alt.Tooltip("Yield:Q"),
                    alt.Tooltip("Time:Q"),
                    alt.Tooltip("Date Label:N", title="Date"),
                ],
            )
        )
        unknown_chart = (
            alt.Chart(unknown_continent_data)
            .mark_circle(size=150, opacity=0.18, color="#c9c3b8")
            .encode(
                x=alt.X("Extraction:Q", title="Extraction"),
                y=alt.Y("TDS:Q", title="TDS"),
                tooltip=[
                    alt.Tooltip("Roaster:N"),
                    alt.Tooltip("Continent Display:N", title="Continent"),
                    alt.Tooltip("Region:N"),
                    alt.Tooltip("Variety:N"),
                    alt.Tooltip("Processing Technique:N"),
                    alt.Tooltip("Roast:N"),
                    alt.Tooltip("Notes:N"),
                    alt.Tooltip("Avg Grind:N", title="Avg Grind (um)"),
                    alt.Tooltip("Grind Setting:N"),
                    alt.Tooltip("Dose:Q"),
                    alt.Tooltip("Yield:Q"),
                    alt.Tooltip("Time:Q"),
                    alt.Tooltip("Date Label:N", title="Date"),
                ],
            )
        )
        origin_chart = (known_chart + unknown_chart).properties(height=320)
        st.altair_chart(origin_chart, use_container_width=True)

    st.dataframe(
        coffee_df[
            [
                "Date Label",
                "Roaster",
                "Continent",
                "Region",
                "Variety",
                "Processing Technique",
                "Elevation",
                "Roast",
                "Notes",
                "Avg Grind",
                "Grind Setting",
                "Dose",
                "Yield",
                "Time",
                "TDS",
                "Extraction",
                "Rating Label",
            ]
        ].rename(columns={"Date Label": "Date"}),
        use_container_width=True,
        hide_index=True,
    )

with experiment_tab:
    st.subheader("Experiment")
    st.caption("Machine-learning experiments use the logged shot history to estimate extraction, rating, and grind tradeoffs. Treat these as directional suggestions, not ground truth.")

    experiment_models = build_experiment_models(df)
    if experiment_models is None:
        st.info("The experiment lab needs at least 25 usable rows with extraction and rating data.")
    else:
        metric_col1, metric_col2, metric_col3, metric_col4 = st.columns(4)
        metric_col1.metric("Model Rows", int(experiment_models["rows"]))
        metric_col2.metric("Extraction R²", f"{experiment_models['extraction_r2']:.2f}")
        metric_col3.metric("Extraction MAE", f"{experiment_models['extraction_mae']:.2f}")
        metric_col4.metric("Rating Balanced Acc.", f"{experiment_models['rating_balanced_accuracy']:.2f}")

        st.subheader("Current Context Simulator")
        sim_col1, sim_col2, sim_col3 = st.columns(3)
        with sim_col1:
            current_roaster = st.text_input("Sim Roaster", value=placeholder_text(latest_value(df, "Roaster")), key="exp_roaster")
            current_region = st.text_input("Sim Region", value=placeholder_text(latest_value(df, "Region")), key="exp_region")
            current_continent = st.text_input("Sim Continent", value=placeholder_text(latest_value(df, "Continent")), key="exp_continent")
            current_temp_c = st.number_input(
                "Sim Temperature (C)",
                min_value=0.0,
                max_value=100.0,
                value=float(latest_value(df, "TempC") or 28.0),
                step=0.1,
                key="exp_temp",
            )
            current_brix = st.number_input(
                "Sim Brix",
                min_value=0.0,
                max_value=30.0,
                value=float(latest_value(df, "Brix") or 10.0),
                step=0.1,
                key="exp_brix",
            )
        with sim_col2:
            current_variety = st.text_input("Sim Variety", value=placeholder_text(latest_value(df, "Variety")), key="exp_variety")
            current_process = st.text_input(
                "Sim Processing Technique",
                value=placeholder_text(latest_value(df, "Processing Technique")),
                key="exp_process",
            )
            current_roast = st.text_input("Sim Roast", value=placeholder_text(latest_value(df, "Roast")), key="exp_roast")
            current_dose = st.number_input(
                "Sim Dose (g)",
                min_value=0.0,
                max_value=50.0,
                value=float(latest_value(df, "Dose") or 18.0),
                step=0.1,
                key="exp_dose",
            )
            current_yield = st.number_input(
                "Sim Yield (g)",
                min_value=0.0,
                max_value=100.0,
                value=float(latest_value(df, "Yield") or 36.0),
                step=0.1,
                key="exp_yield",
            )
        with sim_col3:
            current_time = st.number_input(
                "Sim Time (s)",
                min_value=0,
                max_value=120,
                value=int(latest_value(df, "Time") or 30),
                step=1,
                key="exp_time",
            )
            current_avg_grind = st.text_input(
                "Sim Avg Grind (um)",
                value=placeholder_text(latest_value(df, "Avg Grind")),
                key="exp_avg_grind",
            )
            current_grind_setting = st.text_input(
                "Sim Grind Setting",
                value=placeholder_text(latest_value(df, "Grind Setting")) or "10E",
                key="exp_grind_setting",
            )

        current_context = build_current_context(
            current_roaster,
            current_region,
            current_variety,
            current_process,
            current_roast,
            current_continent,
            current_brix,
            current_temp_c,
            current_dose,
            current_yield,
            current_time,
            current_avg_grind,
            current_grind_setting,
        )
        context_matrix = experiment_models["similarity_preprocessor"].transform(current_context)

        extraction_prediction = float(experiment_models["extraction_model"].predict(current_context)[0])
        rating_probabilities = experiment_models["rating_model"].predict_proba(current_context)[0]
        rating_classes = experiment_models["rating_model"].named_steps["model"].classes_
        probability_lookup = {int(label): float(prob) for label, prob in zip(rating_classes, rating_probabilities)}
        predicted_rating_label = {0: "Bad", 1: "Good", 2: "Great"}.get(
            int(experiment_models["rating_model"].predict(current_context)[0]),
            "Unknown",
        )
        novelty_score = float(experiment_models["novelty_model"].decision_function(context_matrix)[0])
        novelty_flag = bool(experiment_models["novelty_model"].predict(context_matrix)[0] == -1)
        similar_successes = find_similar_successful_shots(experiment_models, current_context)

        grind_sweep = simulate_grind_sweep(
            experiment_models["prepared"],
            experiment_models["extraction_model"],
            experiment_models["rating_model"],
            current_context,
        )

        recommendation_card_col, quality_col = st.columns([1.3, 1])
        with recommendation_card_col:
            st.markdown(
                f"""
<div style="padding: 0.95rem 1.05rem; border-radius: 18px; background: #efe5d4; border: 1px solid #d4c2a4;">
  <div style="font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6f624f;">Current Shot Model Read</div>
  <div style="font-size: 1.6rem; font-weight: 700; color: #2d241c; line-height: 1.1;">Predicted extraction {extraction_prediction:.2f}%</div>
  <div style="font-size: 0.88rem; color: #6f624f; margin-top: 0.3rem;">Predicted cup rating: {predicted_rating_label}</div>
  <div style="font-size: 0.82rem; color: #6f624f; margin-top: 0.35rem;">Great probability {probability_lookup.get(2, 0.0):.0%} | Good probability {probability_lookup.get(1, 0.0):.0%}</div>
</div>
""",
                unsafe_allow_html=True,
            )
        with quality_col:
            within_target = TARGET_EXTRACTION_LOW <= extraction_prediction <= TARGET_EXTRACTION_HIGH
            st.metric("Target Window", "Inside" if within_target else "Outside")
            st.metric("Distance From 20%", f"{abs(extraction_prediction - 20.0):.2f}")
            st.metric("Setup Familiarity", "Unusual" if novelty_flag else "In Family")
            st.metric("Novelty Score", f"{novelty_score:.2f}")

        if not grind_sweep.empty:
            best_candidates = (
                grind_sweep.sort_values(
                    ["In Target Window", "Target Distance", "Great Probability"],
                    ascending=[False, True, False],
                )
                .head(8)
                .copy()
            )

            band_df = pd.DataFrame([{"y": TARGET_EXTRACTION_LOW}, {"y": TARGET_EXTRACTION_HIGH}])
            sweep_chart = (
                alt.Chart(grind_sweep)
                .mark_line(point=True)
                .encode(
                    x=alt.X("Grind Score:Q", title="Grind progression"),
                    y=alt.Y("Predicted Extraction:Q", title="Predicted Extraction (%)"),
                    color=alt.Color("Great Probability:Q", scale=alt.Scale(scheme="goldred"), title="Great Probability"),
                    tooltip=[
                        alt.Tooltip("Grind Setting:N"),
                        alt.Tooltip("Avg Grind Numeric:Q", title="Avg Grind (um)", format=".2f"),
                        alt.Tooltip("Predicted Extraction:Q", format=".2f"),
                        alt.Tooltip("Great Probability:Q", format=".0%"),
                        alt.Tooltip("In Target Window:N"),
                    ],
                )
                .properties(height=340)
            )
            sweep_rules = alt.Chart(band_df).mark_rule(strokeDash=[5, 5], color="#5f5a53").encode(y="y:Q")
            st.subheader("Grind Sweep Simulator")
            st.altair_chart(sweep_chart + sweep_rules, use_container_width=True)

            st.dataframe(
                best_candidates[
                    ["Grind Setting", "Avg Grind Numeric", "Predicted Extraction", "Great Probability", "In Target Window"]
                ].rename(columns={"Avg Grind Numeric": "Avg Grind (um)"}),
                use_container_width=True,
                hide_index=True,
            )

        if not similar_successes.empty:
            st.subheader("Closest Successful Historical Shots")
            st.caption("These are the nearest past shots that were at least rated good and landed inside the 18-22% extraction window.")
            st.dataframe(
                similar_successes[
                    [
                        "Date",
                        "Roaster",
                        "Region",
                        "Variety",
                        "Grind Setting",
                        "Avg Grind Numeric",
                        "Dose",
                        "Yield",
                        "Time",
                        "Extraction",
                        "Rating",
                        "Similarity Distance",
                    ]
                ].rename(columns={"Avg Grind Numeric": "Avg Grind (um)"}),
                use_container_width=True,
                hide_index=True,
            )

        target_history = prepare_experiment_dataframe(df).copy()
        target_history["Coffee Label"] = (
            target_history["Roaster"].fillna("Unknown").astype(str).str.strip()
            + " | "
            + target_history["Region"].fillna("Unknown").astype(str).str.strip()
        )
        target_summary = (
            target_history.groupby("Coffee Label", dropna=False)
            .agg(
                shots=("Coffee Label", "size"),
                avg_extraction=("Extraction", "mean"),
                target_hit_rate=("Extraction", lambda values: values.between(TARGET_EXTRACTION_LOW, TARGET_EXTRACTION_HIGH).mean()),
                avg_rating=("Rating", "mean"),
            )
            .reset_index()
        )
        target_summary = target_summary[target_summary["shots"] >= 2].sort_values(
            ["target_hit_rate", "avg_rating", "shots"],
            ascending=[False, False, False],
        )

        if not target_summary.empty:
            st.subheader("Target Window Leaders")
            leaders_chart = (
                alt.Chart(target_summary.head(12))
                .mark_bar()
                .encode(
                    x=alt.X("target_hit_rate:Q", title="Hit Rate In 18-22%"),
                    y=alt.Y("Coffee Label:N", sort="-x", title="Coffee"),
                    color=alt.Color("avg_rating:Q", scale=alt.Scale(scheme="orangered"), title="Avg Rating"),
                    tooltip=[
                        alt.Tooltip("Coffee Label:N"),
                        alt.Tooltip("shots:Q"),
                        alt.Tooltip("avg_extraction:Q", format=".2f"),
                        alt.Tooltip("target_hit_rate:Q", format=".0%"),
                        alt.Tooltip("avg_rating:Q", format=".2f"),
                    ],
                )
                .properties(height=320)
            )
            st.altair_chart(leaders_chart, use_container_width=True)
