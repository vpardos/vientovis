#!/usr/bin/env python3
"""
generar_mock.py — Genera los JSON de datos de REFERENCIA (mock) de vientovis V1.

Produce:
  data/indice.json            Manifiesto (id, nombre, año, totales) para la galería.
  data/tormentas/{id}.json    Un archivo por tormenta, con puntos cada 6 h.

El schema es el MISMO que tendrá el dataset final: cuando lleguen los datos
reales basta con sustituir estos archivos (y quitar "mock": true) para que la
app oculte el badge de "DATOS DE REFERENCIA".

Los valores son ÓRDENES DE MAGNITUD calibrados con cifras públicas redondeadas;
no son valores exactos. Ver prompt.md para las anclas por tormenta.

Uso:  python3 scripts/generar_mock.py
"""
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DIR_SALIDA = RAIZ / "data" / "tormentas"

PASO_H = 6
NOTA = "Datos de referencia (mock) — reemplazar por el dataset final"


# ---------------------------------------------------------------- utilidades

def presion_desde_viento(v):
    """Ajuste cuadrático simple viento→presión central (verosímil, no exacto).

    30 kt → ~1006 mb · 115 kt → ~946 mb · 150 kt → ~906 mb
    """
    return int(round(1014 - 0.15 * v - 0.0038 * v * v))


def categoria_ss(v, estatus):
    """Categoría Saffir–Simpson 0–5 a partir del viento sostenido en kt."""
    if estatus == "EX" or v < 64:
        return 0
    if v < 83:
        return 1
    if v < 96:
        return 2
    if v < 113:
        return 3
    if v < 137:
        return 4
    return 5


def estatus_desde_viento(v):
    if v < 34:
        return "TD"
    if v < 64:
        return "TS"
    return "HU"


def interpolar(waypoints, i):
    """Interpolación lineal de lat/lon/viento sobre waypoints (idx, lat, lon, kt)."""
    if i <= waypoints[0][0]:
        return waypoints[0][1], waypoints[0][2], waypoints[0][3]
    if i >= waypoints[-1][0]:
        return waypoints[-1][1], waypoints[-1][2], waypoints[-1][3]
    for (i0, la0, lo0, v0), (i1, la1, lo1, v1) in zip(waypoints, waypoints[1:]):
        if i0 <= i <= i1:
            f = (i - i0) / (i1 - i0)
            return la0 + f * (la1 - la0), lo0 + f * (lo1 - lo0), v0 + f * (v1 - v0)


def repartir_muertes(total, ramp, decaimiento):
    """Perfil de acumulación de muertes: sube y decae suave (tasa post-tocatierra)."""
    pesos = [(k + 1) * math.exp(-k / decaimiento) for k in range(ramp)]
    s = sum(pesos)
    return [w / s * total for w in pesos]


def repartir_danos(total, ramp):
    """Perfil de daños: abrupto, concentrado en el intervalo del tocatierra."""
    pesos = [math.exp(-k / 1.1) for k in range(ramp)]
    s = sum(pesos)
    return [w / s * total for w in pesos]


# ------------------------------------------------------------------ tormentas
# Config por tormenta. Vida/inicio/tomatierra/cifras según la tabla de prompt.md.
# waypoints: (índice de punto 6-h, lat, lon, viento_kt)
# tocatierras: (índice de punto, fracción de muertes, fracción de daños)
# ir: tramos [(i_ini, i_fin)] de intensificación rápida (≥30 kt / 24 h)

TORMENTAS = [
    {
        "id": "katrina-2005", "nombre": "Katrina", "anio": 2005,
        "inicio": "2005-08-23T18:00:00Z", "n_puntos": 30,
        "waypoints": [(0, 23.1, -75.5, 30), (4, 25.4, -80.1, 70), (7, 25.6, -84.4, 80),
                      (10, 24.9, -86.4, 100), (14, 26.0, -88.9, 150), (18, 26.5, -91.2, 135),
                      (22, 28.7, -89.6, 110), (25, 32.5, -89.0, 45), (27, 36.5, -86.5, 30),
                      (29, 38.8, -84.5, 25)],
        "tocatierras": [(4, 0.05, 0.03), (22, 0.95, 0.97)],   # Florida C1 · Buras LA C3
        "ir": [(1, 4), (9, 14)],
        "muertes": 1833, "danos": 125_000_000_000,
        "ramp_muertes": 14, "ramp_danos": 6,
    },
    {
        "id": "maria-2017", "nombre": "María", "anio": 2017,
        "inicio": "2017-09-16T18:00:00Z", "n_puntos": 55,
        "waypoints": [(0, 12.3, -52.0, 40), (6, 14.3, -58.6, 110), (8, 15.3, -60.4, 140),
                      (10, 15.5, -61.4, 150), (14, 17.2, -65.5, 135), (15, 18.1, -66.5, 125),
                      (20, 21.5, -68.6, 100), (28, 27.0, -71.0, 85), (40, 33.5, -71.8, 70),
                      (50, 37.5, -62.0, 50), (54, 41.0, -48.0, 40)],
        "tocatierras": [(10, 0.15, 0.08), (15, 0.85, 0.92)],   # Dominica C5 · Puerto Rico C4
        "ir": [(5, 10)],
        "muertes": 2975, "danos": 90_000_000_000,
        "ramp_muertes": 20, "decaimiento_muertes": 4.5, "ramp_danos": 8,  # cola larga (PR)
    },
    {
        "id": "helene-2024", "nombre": "Helene", "anio": 2024,
        "inicio": "2024-09-24T12:00:00Z", "n_puntos": 13,
        "waypoints": [(0, 16.5, -80.5, 40), (4, 19.8, -84.6, 65), (8, 23.5, -86.2, 105),
                      (10, 27.6, -85.3, 120), (12, 33.8, -84.4, 30)],
        "tocatierras": [(10, 1.0, 1.0)],                      # Big Bend FL C4
        "ir": [(4, 8)],
        "muertes": 230, "danos": 78_000_000_000,
        "ramp_muertes": 3, "ramp_danos": 3,
    },
    {
        "id": "sandy-2012", "nombre": "Sandy", "anio": 2012,
        "inicio": "2012-10-22T12:00:00Z", "n_puntos": 41,
        "waypoints": [(0, 13.0, -77.5, 40), (5, 16.0, -76.7, 55), (6, 16.5, -76.6, 80),
                      (10, 20.5, -76.4, 100), (16, 25.5, -75.8, 65), (24, 29.5, -73.0, 75),
                      (30, 35.0, -72.0, 80), (33, 39.5, -74.1, 70), (37, 42.5, -77.5, 30),
                      (40, 45.0, -80.0, 25)],
        "tocatierras": [(6, 0.05, 0.04), (10, 0.10, 0.10), (33, 0.85, 0.86)],  # Jamaica · Cuba · NJ
        "ir": [(5, 9)],
        "ex_desde": 33,                                       # postropical desde NJ
        "muertes": 190, "danos": 70_000_000_000,
        "ramp_muertes": 12, "ramp_danos": 6,
    },
    {
        "id": "ian-2022", "nombre": "Ian", "anio": 2022,
        "inicio": "2022-09-23T12:00:00Z", "n_puntos": 30,
        "waypoints": [(0, 13.7, -71.5, 35), (6, 15.5, -77.5, 60), (9, 19.2, -81.8, 75),
                      (12, 22.0, -83.3, 105), (15, 24.2, -83.0, 115), (20, 26.5, -82.2, 135),
                      (24, 29.0, -81.0, 55), (29, 32.0, -79.5, 30)],
        "tocatierras": [(12, 0.06, 0.04), (20, 0.94, 0.96)],  # Cuba C3 · Cayo Costa FL C4
        "ir": [(9, 13)],
        "muertes": 156, "danos": 112_900_000_000,
        "ramp_muertes": 8, "ramp_danos": 4,
    },
    {
        "id": "harvey-2017", "nombre": "Harvey", "anio": 2017,
        "inicio": "2017-08-17T18:00:00Z", "n_puntos": 59,
        "waypoints": [(0, 13.0, -55.0, 35), (8, 14.5, -67.5, 40), (16, 18.0, -82.0, 40),
                      (20, 21.5, -90.5, 45), (24, 24.0, -94.5, 70), (28, 27.2, -96.9, 115),
                      (31, 28.2, -96.9, 130), (36, 29.3, -96.3, 45), (44, 30.0, -95.4, 40),
                      (52, 30.8, -92.0, 30), (58, 34.0, -88.0, 25)],
        "tocatierras": [(31, 1.0, 1.0)],                      # Rockport TX C4
        "ir": [(23, 28)],
        "muertes": 68, "danos": 125_000_000_000,
        "ramp_muertes": 30, "decaimiento_muertes": 4.0,       # inundaciones: acumulación lenta
        "ramp_danos": 16, "decaimiento_danos": None,          # daños con cola larga
    },
    {
        "id": "ida-2021", "nombre": "Ida", "anio": 2021,
        "inicio": "2021-08-26T12:00:00Z", "n_puntos": 37,
        "waypoints": [(0, 13.5, -68.5, 35), (4, 16.5, -76.5, 55), (7, 20.0, -81.5, 70),
                      (8, 21.8, -82.5, 72), (12, 25.0, -86.5, 85), (16, 28.3, -89.6, 125),
                      (17, 29.3, -90.2, 130), (22, 33.0, -90.5, 45), (28, 34.5, -84.5, 30),
                      (36, 39.0, -73.0, 40)],
        "tocatierras": [(8, 0.05, 0.02), (17, 0.95, 0.98)],   # Cuba C1 · Port Fourchon LA C4
        "ir": [(12, 16)],
        "muertes": 87, "danos": 75_000_000_000,
        "ramp_muertes": 14, "ramp_danos": 4,
    },
    {
        "id": "irma-2017", "nombre": "Irma", "anio": 2017,
        "inicio": "2017-08-30T06:00:00Z", "n_puntos": 59,
        "waypoints": [(0, 16.4, -30.4, 45), (6, 17.5, -40.0, 100), (16, 17.6, -54.0, 155),
                      (28, 17.7, -61.8, 160), (34, 20.2, -67.8, 150), (40, 22.0, -75.0, 135),
                      (46, 24.0, -79.5, 118), (48, 25.4, -80.8, 115), (52, 29.5, -83.0, 55),
                      (58, 35.5, -88.5, 25)],
        "tocatierras": [(28, 0.15, 0.10), (40, 0.10, 0.08), (48, 0.75, 0.82)],  # Barbuda C5 · Cuba · FL C4
        "ir": [(0, 5)],
        "muertes": 92, "danos": 52_000_000_000,
        "ramp_muertes": 12, "ramp_danos": 5,
    },
    {
        "id": "michael-2018", "nombre": "Michael", "anio": 2018,
        "inicio": "2018-10-07T06:00:00Z", "n_puntos": 18,
        "waypoints": [(0, 18.0, -85.0, 35), (4, 19.5, -85.5, 65), (6, 21.9, -85.3, 85),
                      (10, 26.0, -85.9, 120), (13, 29.9, -85.4, 140), (16, 34.0, -82.0, 40),
                      (17, 36.5, -79.0, 40)],
        "tocatierras": [(13, 1.0, 1.0)],                      # Mexico Beach FL C5
        "ir": [(6, 10)],
        "muertes": 45, "danos": 25_000_000_000,
        "ramp_muertes": 3, "ramp_danos": 3,
    },
    {
        "id": "ike-2008", "nombre": "Ike", "anio": 2008,
        "inicio": "2008-09-01T12:00:00Z", "n_puntos": 54,
        "waypoints": [(0, 19.5, -46.0, 60), (4, 21.0, -54.0, 75), (8, 21.5, -62.0, 115),
                      (16, 21.8, -71.5, 130), (20, 21.0, -77.0, 120), (28, 23.0, -84.0, 95),
                      (36, 25.5, -91.0, 100), (45, 29.0, -94.7, 95), (50, 33.5, -93.5, 40),
                      (53, 38.0, -88.0, 30)],
        "tocatierras": [(20, 0.20, 0.08), (45, 0.80, 0.92)],  # Cuba C4 · Galveston TX C2
        "ir": [(4, 8)],
        "muertes": 103, "danos": 34_000_000_000,
        "ramp_muertes": 12, "ramp_danos": 6,
    },
]


def construir(cfg):
    n = cfg["n_puntos"]
    inicio = datetime.strptime(cfg["inicio"], "%Y-%m-%dT%H:%M:%SZ")
    idx_tocatierra = {i for i, _, _ in cfg["tocatierras"]}

    puntos = []
    for i in range(n):
        lat, lon, v = interpolar(cfg["waypoints"], i)
        v = int(round(v / 5) * 5)  # vientos en múltiplos de 5 kt (convención NHC)
        ex_desde = cfg.get("ex_desde")
        estatus = "EX" if (ex_desde is not None and i >= ex_desde) else estatus_desde_viento(v)
        t = inicio + timedelta(hours=PASO_H * i)
        puntos.append({
            "t": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lat": round(lat, 2),
            "lon": round(lon, 2),
            "viento_kt": v,
            "presion_mb": presion_desde_viento(v),
            "estatus": estatus,
            "cat_ss": categoria_ss(v, estatus),
            "tocatierra": i in idx_tocatierra,
            "ir": any(a <= i <= b for a, b in cfg.get("ir", [])),
            "muertes_acum": 0,
            "danos_acum_usd": 0,
        })

    # Impactos: deltas por punto partiendo del ancla de cada tocatierra
    delta_m = [0.0] * n
    delta_d = [0.0] * n
    for idx, pm, pd in cfg["tocatierras"]:
        rm = repartir_muertes(cfg["muertes"] * pm, min(cfg.get("ramp_muertes", 8), n - idx),
                              cfg.get("decaimiento_muertes", 2.2))
        rd = repartir_danos(cfg["danos"] * pd, min(cfg.get("ramp_danos", 4), n - idx))
        for k, x in enumerate(rm):
            delta_m[idx + k] += x
        for k, x in enumerate(rd):
            delta_d[idx + k] += x

    am = ad = 0.0
    for i in range(n):
        am += delta_m[i]
        ad += delta_d[i]
        puntos[i]["muertes_acum"] = max(int(round(am)), puntos[i - 1]["muertes_acum"] if i else 0)
        puntos[i]["danos_acum_usd"] = max(int(round(ad)), puntos[i - 1]["danos_acum_usd"] if i else 0)
    # Totales exactos al final de la serie
    puntos[-1]["muertes_acum"] = cfg["muertes"]
    puntos[-1]["danos_acum_usd"] = int(cfg["danos"])

    return {
        "id": cfg["id"],
        "nombre": cfg["nombre"],
        "anio": cfg["anio"],
        "mock": True,
        "nota": NOTA,
        "inicio": puntos[0]["t"],
        "fin": puntos[-1]["t"],
        "puntos": puntos,
    }


def main():
    DIR_SALIDA.mkdir(parents=True, exist_ok=True)
    indice = []
    for cfg in TORMENTAS:
        doc = construir(cfg)
        ruta = DIR_SALIDA / f"{cfg['id']}.json"
        ruta.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        indice.append({
            "id": cfg["id"],
            "nombre": cfg["nombre"],
            "anio": cfg["anio"],
            "cat_pico": max(p["cat_ss"] for p in doc["puntos"]),
            "muertes_total": cfg["muertes"],
            "danos_total_usd": int(cfg["danos"]),
            "mock": True,
        })
        print(f"{cfg['id']:<14} {len(doc['puntos']):>2} pts · "
              f"C{max(p['cat_ss'] for p in doc['puntos'])} · "
              f"{cfg['muertes']:>5} muertes · ${cfg['danos'] / 1e9:>6.1f} mil M")

    indice.sort(key=lambda t: -t["muertes_total"])  # galería: muertes desc
    (RAIZ / "data" / "indice.json").write_text(
        json.dumps({"mock": True, "nota": NOTA, "tormentas": indice},
                   ensure_ascii=False, indent=1),
        encoding="utf-8")
    print(f"\nOK · data/indice.json + {len(TORMENTAS)} archivos en data/tormentas/")


if __name__ == "__main__":
    main()
