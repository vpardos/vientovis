"""Loader para HURDAT2 (NHC best-track).

HURDAT2 mezcla dos tipos de línea en el mismo archivo, y eso es la razón principal
por la que `pd.read_csv` a secas no sirve:

  1. Línea de cabecera (1 por tormenta, 4 campos):
     `AL092017,            HARVEY,     74,`
     -> basin+numero+año, nombre, cantidad de registros que siguen
  2. Líneas de datos (20 campos):
     `20170825, 1200,  , HU, 27.9N,  96.0W, 115,  937, ...`

Los campos son de ANCHO FIJO con relleno de espacios, así que hay que hacer
`.strip()` a cada campo después de separar por coma.

Además hay un registro con un error de tipeo en el archivo fuente del NHC
(AL211969, 1969-09-29 06:00 UTC): le falta la coma entre latitud y longitud
(` 63.3N    7.5E`), lo que produce 20 campos en vez de 21. Sin parchear, esa
línea corre todas las columnas siguientes y la lat/lon queda como texto.
El loader lo detecta y lo separa por espacios. `df.attrs["n_patched"]` informa
cuántas líneas se corrigieron.

Uso:
    from hurdat2 import load_hurdat2, add_derived_columns, storm_track

    df, storms = load_hurdat2("data/hurricanes/hurdat2-1851-2025-091226.txt")
    df = add_derived_columns(df)

    katrina = storm_track(df, "AL122005")     # siempre por ID, no por nombre
    landfalls = df[df.is_landfall]            # tocamientos de tierra
    hurricanes = df[df.status == "HU"]
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

# Orden según la especificación oficial del NHC (hurdat2-format-atlantic.pdf):
# fecha, hora, id de registro, estado, lat, lon, viento, presión,
# y 4 radios de viento por umbral (34/50/64 kt), cada uno en 4 cuadrantes
# (NE, SE, SW, NW) -> 20 columnas de datos.
DATA_COLS = [
    "date", "time", "record_id", "status", "lat", "lon", "wind_kt", "pressure_mb",
    "r34_ne", "r34_se", "r34_sw", "r34_nw",
    "r50_ne", "r50_se", "r50_sw", "r50_nw",
    "r64_ne", "r64_se", "r64_sw", "r64_nw",
]

RADII_COLS = DATA_COLS[8:]
MISSING = -999  # centinela de dato faltante en el archivo

# Códigos de estado del sistema (columna `status`)
STATUS_LEGEND = {
    "TD": "Tropical Depression (<34 kt)",
    "TS": "Tropical Storm (34-63 kt)",
    "HU": "Hurricane (>=64 kt)",
    "EX": "Extratropical",
    "SD": "Subtropical Depression (<34 kt)",
    "SS": "Subtropical Storm (>=34 kt)",
    "LO": "Low (no tropical/subtropical/extratropical)",
    "WV": "Tropical Wave",
    "DB": "Disturbance",
}

# Códigos de la columna `record_id`
RECORD_ID_LEGEND = {
    "L": "Landfall (tocamiento de tierra)",
    "C": "Closest approach to coast (sin landfall)",
    "G": "Genesis",
    "I": "Intensity peak (viento y presión)",
    "P": "Minimum central pressure",
    "R": "Additional intensity detail (cambio rápido)",
    "S": "Status change",
    "T": "Additional track detail",
    "W": "Maximum sustained wind",
}

# IDs de las tormentas icónicas (el ID evita la colisión de nombres entre décadas)
ICONIC_STORM_IDS = {
    "AL091969": "Camille (1969)",
    "AL041992": "Andrew (1992)",
    "AL122005": "Katrina (2005)",
    "AL092008": "Ike (2008)",
    "AL182012": "Sandy (2012)",
    "AL092017": "Harvey (2017)",
    "AL112017": "Irma (2017)",
    "AL152017": "Maria (2017)",
    "AL142018": "Michael (2018)",
}


def saffir_simpson(wind_kt: float) -> str:
    """Categoría Saffir-Simpson a partir del viento en nudos."""
    if pd.isna(wind_kt):
        return "n/a"
    if wind_kt >= 137:
        return "Cat 5"
    if wind_kt >= 113:
        return "Cat 4"
    if wind_kt >= 96:
        return "Cat 3"
    if wind_kt >= 83:
        return "Cat 2"
    if wind_kt >= 64:
        return "Cat 1"
    if wind_kt >= 34:
        return "TS"
    return "TD"


def _coord_to_float(series: pd.Series) -> pd.Series:
    """Convierte '27.9N' / '96.0W' a 27.9 / -96.0 (W y S son negativos)."""
    s = series.astype(str).str.strip()
    val = pd.to_numeric(s.str.extract(r"([\d.]+)")[0], errors="coerce")
    sign = np.where(s.str.endswith(("W", "S")), -1.0, 1.0)
    return val * sign


def load_hurdat2(path: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Lee un archivo HURDAT2.

    Devuelve (df, storms):
      df     - un registro por fix de posición (20 columnas de datos + datetime,
               storm_id, storm_name); los centinelas -999 quedan como NaN
      storms - un registro por tormenta (storm_id, storm_name, n_records)
    """
    header_rows: list[tuple] = []
    data_rows: list[tuple] = []
    cur_id = cur_name = None
    n_patched = 0

    with open(path, encoding="utf-8") as fh:
        for line in fh:
            parts = [p.strip() for p in line.rstrip("\n").split(",")]
            if not parts or not parts[0]:
                continue

            # Cabecera: id empieza con el basin (AL = Atlántico), pocos campos
            if parts[0].startswith("AL") and len(parts) < 10:
                cur_id, cur_name = parts[0], parts[1]
                header_rows.append((cur_id, cur_name, int(parts[2])))
                continue

            # Parche: línea del NHC con la coma faltante entre lat y lon
            if len(parts) < len(DATA_COLS) + 1:
                parts = parts[:4] + re.split(r"\s+", parts[4]) + parts[5:]
                n_patched += 1

            data_rows.append((cur_id, cur_name, *parts[: len(DATA_COLS)]))

    df = pd.DataFrame(data_rows, columns=["storm_id", "storm_name", *DATA_COLS])
    storms = pd.DataFrame(header_rows, columns=["storm_id", "storm_name", "n_records"])

    # --- tipos ---
    df["datetime"] = pd.to_datetime(
        df["date"] + df["time"], format="%Y%m%d%H%M", errors="coerce"
    )
    df["lat"] = _coord_to_float(df["lat"])
    df["lon"] = _coord_to_float(df["lon"])

    for col in ["wind_kt", "pressure_mb", *RADII_COLS]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.replace(MISSING, np.nan)          # -999 -> NaN

    df.attrs["n_patched"] = n_patched
    df.attrs["status_legend"] = STATUS_LEGEND
    df.attrs["record_id_legend"] = RECORD_ID_LEGEND
    return df, storms


def add_derived_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Agrega categoría Saffir-Simpson y banderas de tocamientos de tierra."""
    out = df.copy()
    out["category"] = out["wind_kt"].map(saffir_simpson)
    out["is_landfall"] = out["record_id"].eq("L")
    out["coast_approach"] = out["record_id"].eq("C")
    return out


def storm_track(df: pd.DataFrame, storm_id: str) -> pd.DataFrame:
    """Trayectoria de UNA tormenta, ordenada cronológicamente.

    Usar siempre storm_id ('AL122005'), nunca el nombre: los nombres se
    repiten entre décadas (KATRINA existe en 1981, 1999 y 2005).
    """
    sub = df[df["storm_id"] == storm_id].sort_values("datetime").copy()
    if sub.empty:
        raise ValueError(f"storm_id {storm_id!r} no está en los datos")
    return sub
