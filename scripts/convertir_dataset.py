#!/usr/bin/env python3
"""
convertir_dataset.py — Convierte el DATASET FINAL real (notebooks/hurricanes_unido.csv)
en los JSON que consume la app vientovis, SOBRESCRIBIENDO el mock.

Genera:
  data/indice.json             Manifiesto (id, nombre, año, totales) ordenado por muertes desc.
  data/tormentas/{id}.json     Un archivo por tormenta, con TODOS los puntos del CSV
                               (cadencia mixta 6 h + boletines especiales).

El schema de salida es idéntico al del mock (scripts/generar_mock.py), pero con
"mock": false y la nota del dataset final, de modo que la app oculta el badge
de «datos de referencia».

Uso:  python3 scripts/convertir_dataset.py
Determinista, solo stdlib.

SUPUESTOS / DECISIONES (contrastados con el CSV real de 492 filas / 10 tormentas):
1. Cadencia temporal: se conservan TODAS las filas. `t` se construye desde date+time
   (UTC) como "YYYY-MM-DDTHH:MM:00Z"; la app une series por marca de tiempo, no por
   índice. No hay timestamps duplicados dentro de una tormenta (el script falla si
   los hubiera, porque la unión por marca de tiempo se rompería).
2. Estatus: LO y EX se homogeneizan a "EX"; el resto (TD/TS/HU y también WV/DB,
   códigos transitorios de HURDAT2) se dejan "tal cual", como indica la regla.
   La app muestra códigos desconocidos con su texto crudo (fallback de fmtEstatus).
3. cat_ss se deriva SIEMPRE de wind_kt (regla explícita), sin excepción por estatus.
   Consecuencia esperada: puntos EX con viento >= 64 kt (Sandy 70-75 kt, Michael
   65 kt) quedan con cat_ss >= 1, a diferencia del mock que forzaba 0 para EX.
4. La columna `category` (texto TD/TS/Cat N) NO se usa: la categoría se calcula
   de wind_kt según los cortes de Saffir-Simpson indicados.
5. La columna `datetime` (formato DD-MM-AA) NO se usa: `t` sale de date+time.
6. `is_landfall == "True"` -> tocatierra=true (columna booleana de HURDAT2).
   Se registran 34 tocatierras en total (HURDAT2 marca cualquier tocatierra,
   no solo EE. UU.).
7. Muertes y daños del CSV son valores POR DÍA repetidos en cada punto de ese día.
   Se acumulan UNA sola vez por fecha, en el primer punto cronológico de la fecha;
   el resto de puntos de la fecha mantienen el acumulado. Valores vacíos = 0.
   Si una misma fecha tuviera valores distintos entre filas (no ocurre en este
   CSV), se usa el de la fila más temprana y se emite un aviso por stderr.
   - muertes_acum: int, redondeo sobre el acumulado (no sobre cada delta), de modo
     que el último punto lleva el total exacto de la tormenta.
   - danos_acum_usd: número; en este CSV todos los importes son enteros, así que
     se emiten como int.
8. `ir`: true si viento(t) - viento(punto más cercano a t-24 h) >= 30 kt. La
   búsqueda es por marca de tiempo (valor absoluto de la diferencia); en empate
   gana el punto ANTERIOR (determinista). En los primeros puntos, si t-24 h cae
   antes del inicio de la serie, el «más cercano» es el primer punto disponible.
9. Impactos solo diarios de EE. UU. (storm_events): los totales son los del
   dataset (p. ej. Katrina 1004 muertes), aunque difieran de cifras históricas
   globales. El dataset es la fuente de verdad.
10. Se borran los *.json de data/tormentas/ cuyos ids no estén en el dataset
    (regla 8; con estos 10 ids solo se sobrescriben los del mock).
11. El script se autovalida al final (schema, monotonía, cadencia, totales) y
    falla con SystemExit != 0 si algo no cuadra.
"""

import csv
import json
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

# ------------------------------------------------------------------ rutas

RAIZ = Path(__file__).resolve().parent.parent
CSV_FUENTE = RAIZ / "notebooks" / "hurricanes_unido.csv"
DIR_TORMENTAS = RAIZ / "data" / "tormentas"
RUTA_INDICE = RAIZ / "data" / "indice.json"

NOTA = "Dataset final — fuentes en data/SOURCES.md"

# Nombres para la UI (con tilde donde corresponde). Mapa exacto del enunciado.
NOMBRES = {
    "KATRINA": "Katrina",
    "MARIA": "María",
    "HELENE": "Helene",
    "SANDY": "Sandy",
    "IAN": "Ian",
    "HARVEY": "Harvey",
    "IDA": "Ida",
    "IRMA": "Irma",
    "MICHAEL": "Michael",
    "IKE": "Ike",
}

# Orden de claves del punto, idéntico al schema del mock.
CLAVES_PUNTO = (
    "t", "lat", "lon", "viento_kt", "presion_mb", "estatus",
    "cat_ss", "tocatierra", "ir", "muertes_acum", "danos_acum_usd",
)
CLAVES_DOC = ("id", "nombre", "anio", "mock", "nota", "inicio", "fin", "puntos")
CLAVES_INDICE = (
    "id", "nombre", "anio", "cat_pico", "muertes_total", "danos_total_usd", "mock",
)


# ---------------------------------------------------------------- utilidades

def a_float(txt):
    """Número desde celda del CSV; vacío o None -> 0.0."""
    txt = (txt or "").strip()
    return float(txt) if txt else 0.0


def a_int(txt):
    """Entero desde celda del CSV (admite '30.0'); vacío -> 0."""
    return int(round(a_float(txt)))


def fecha_hora(fila):
    """date (YYYYMMDD) + time (HHMM) -> datetime UTC (naive, todo el CSV es UTC)."""
    return datetime.strptime(fila["date"] + fila["time"], "%Y%m%d%H%M")


def iso_utc(t):
    """datetime -> 'YYYY-MM-DDTHH:MM:00Z' (formato del schema)."""
    return t.strftime("%Y-%m-%dT%H:%M:00Z")


def numero_json(x):
    """Emite int si el valor es entero exacto; si no, float redondeado a 2 decimales."""
    if abs(x - round(x)) < 1e-6:
        return int(round(x))
    return round(x, 2)


def categoria_ss(viento_kt):
    """Categoría Saffir-Simpson 0-5 desde el viento sostenido en kt."""
    if viento_kt < 64:
        return 0
    if viento_kt < 83:
        return 1
    if viento_kt < 96:
        return 2
    if viento_kt < 113:
        return 3
    if viento_kt < 137:
        return 4
    return 5


def estatus_ui(status):
    """LO/EX -> EX (postropical); el resto tal cual (TD/TS/HU/WV/DB)."""
    return "EX" if status in ("LO", "EX") else status


def id_tormenta(storm, storm_id):
    """id = nombre-lowercase-año, con el año en los últimos 4 dígitos del storm_id."""
    return storm.lower() + "-" + storm_id[-4:]


def nombre_ui(storm):
    """Nombre con tilde desde el mapa; aviso y capitalizado si apareciera uno nuevo."""
    if storm in NOMBRES:
        return NOMBRES[storm]
    print(f"AVISO: tormenta '{storm}' fuera del mapa de nombres; se usa capitalizado.",
          file=sys.stderr)
    return storm.capitalize()


def indice_mas_cercano(tiempos, objetivo):
    """Índice del punto con marca de tiempo más cercana a `objetivo`.

    `tiempos` está ordenado y sin duplicados. En empate gana el anterior
    (clave (|dt|, timestamp) -> determinista).
    """
    pos = bisect_left(tiempos, objetivo)
    candidatos = []
    if pos < len(tiempos):
        candidatos.append(pos)
    if pos > 0:
        candidatos.append(pos - 1)
    return min(candidatos, key=lambda k: (abs(tiempos[k] - objetivo), tiempos[k]))


# -------------------------------------------------------------- conversión

def convertir_tormenta(filas):
    """Convierte las filas de UNA tormenta en el documento JSON final.

    Devuelve (doc, resumen) donde resumen alimenta data/indice.json y la
    autovalidación.
    """
    filas = sorted(filas, key=lambda r: (r["date"], r["time"]))
    storm = filas[0]["storm"]
    sid = filas[0]["storm_id"]
    tid = id_tormenta(storm, sid)

    # Timestamps: se exige unicidad porque la app une por marca de tiempo.
    tiempos = [fecha_hora(f) for f in filas]
    if len(set(tiempos)) != len(tiempos):
        repetidos = sorted({t for t in tiempos if tiempos.count(t) > 1})
        raise SystemExit(f"ERROR {tid}: timestamps duplicados: {repetidos}")

    puntos = []
    muertes = 0.0        # acumulado en float; se redondea al emitir
    danos = 0.0
    fecha_previa = None
    totales_por_fecha = {}   # validación: {fecha: (muertes, daños)} una vez por fecha

    for fila, t in zip(filas, tiempos):
        viento = a_int(fila["wind_kt"])
        fecha = fila["date"]

        # Impactos: deltas diarios UNA vez por fecha (primer punto cronológico).
        if fecha != fecha_previa:
            m_dia = a_float(fila["deaths_direct"]) + a_float(fila["deaths_indirect"])
            d_dia = a_float(fila["damage_property_usd"]) + a_float(fila["damage_crops_usd"])
            # Consistencia dentro del día (en este CSV siempre se repiten igual).
            for otra in filas:
                if otra["date"] == fecha:
                    m_otra = a_float(otra["deaths_direct"]) + a_float(otra["deaths_indirect"])
                    d_otra = a_float(otra["damage_property_usd"]) + a_float(otra["damage_crops_usd"])
                    if abs(m_otra - m_dia) > 1e-6 or abs(d_otra - d_dia) > 1e-6:
                        print(f"AVISO {tid} {fecha}: valores diarios inconsistentes; "
                              f"se usa la primera fila cronológica.", file=sys.stderr)
                        break
            muertes += m_dia
            danos += d_dia
            fecha_previa = fecha
            totales_por_fecha[fecha] = (m_dia, d_dia)

        # ir: contra el punto más cercano a t-24 h (por marca de tiempo).
        j = indice_mas_cercano(tiempos, t - timedelta(hours=24))
        ir = (viento - a_int(filas[j]["wind_kt"])) >= 30

        puntos.append({
            "t": iso_utc(t),
            "lat": float(fila["lat"]),
            "lon": float(fila["lon"]),
            "viento_kt": viento,
            "presion_mb": a_int(fila["pressure_mb"]),
            "estatus": estatus_ui(fila["status"]),
            "cat_ss": categoria_ss(viento),
            "tocatierra": fila["is_landfall"].strip() == "True",
            "ir": ir,
            "muertes_acum": int(round(muertes)),
            "danos_acum_usd": numero_json(danos),
        })

    # El último punto lleva el total exacto de la tormenta.
    total_muertes = int(round(muertes))
    total_danos = numero_json(danos)
    puntos[-1]["muertes_acum"] = total_muertes
    puntos[-1]["danos_acum_usd"] = total_danos

    doc = {
        "id": tid,
        "nombre": nombre_ui(storm),
        "anio": int(sid[-4:]),
        "mock": False,
        "nota": NOTA,
        "inicio": puntos[0]["t"],
        "fin": puntos[-1]["t"],
        "puntos": puntos,
    }
    resumen = {
        "id": tid,
        "nombre": doc["nombre"],
        "anio": doc["anio"],
        "cat_pico": max(p["cat_ss"] for p in puntos),
        "muertes_total": total_muertes,
        "danos_total_usd": total_danos,
        "mock": False,
        # extra solo para la validación interna, no se escribe en el índice:
        "_puntos": len(puntos),
        "_tocatierras": sum(1 for p in puntos if p["tocatierra"]),
        "_totales_por_fecha": totales_por_fecha,
    }
    return doc, resumen


# -------------------------------------------------------------- validación

def validar(docs, resumenes):
    """Autovalidación barata del output antes de dar por bueno el dataset."""
    assert len(docs) == 10, f"se esperaban 10 tormentas, hay {len(docs)}"
    problemas = []
    for tid, doc in docs.items():
        puntos = doc["puntos"]
        res = resumenes[tid]
        # 1. schema exacto (claves y nada de más)
        faltan = [k for k in CLAVES_DOC if k not in doc]
        extra = [k for k in doc if k not in CLAVES_DOC]
        if faltan or extra:
            problemas.append(f"{tid}: claves doc faltan={faltan} extra={extra}")
        for k in ("mock",):
            if doc.get(k) is not False:
                problemas.append(f"{tid}: {k} debe ser false")
        for i, p in enumerate(puntos):
            faltan = [k for k in CLAVES_PUNTO if k not in p]
            extra = [k for k in p if k not in CLAVES_PUNTO]
            if faltan or extra:
                problemas.append(f"{tid}[{i}]: claves punto faltan={faltan} extra={extra}")
            # 2. tipos y timestamps ISO
            if p["t"] != iso_utc(datetime.strptime(p["t"], "%Y-%m-%dT%H:%M:%SZ")):
                problemas.append(f"{tid}[{i}]: t no ISO válido: {p['t']}")
            if not isinstance(p["viento_kt"], int) or not isinstance(p["cat_ss"], int):
                problemas.append(f"{tid}[{i}]: viento_kt/cat_ss no int")
            if not 0 <= p["cat_ss"] <= 5:
                problemas.append(f"{tid}[{i}]: cat_ss fuera de rango")
            if not isinstance(p["tocatierra"], bool) or not isinstance(p["ir"], bool):
                problemas.append(f"{tid}[{i}]: tocatierra/ir no bool")
            if i:
                if not p["t"] > puntos[i - 1]["t"]:
                    problemas.append(f"{tid}[{i}]: timestamps no crecientes")
                if p["muertes_acum"] < puntos[i - 1]["muertes_acum"]:
                    problemas.append(f"{tid}[{i}]: muertes_acum no monótona")
                if p["danos_acum_usd"] < puntos[i - 1]["danos_acum_usd"]:
                    problemas.append(f"{tid}[{i}]: danos_acum_usd no monótona")
        # 3. extremos y totales
        if doc["inicio"] != puntos[0]["t"] or doc["fin"] != puntos[-1]["t"]:
            problemas.append(f"{tid}: inicio/fin no coinciden con el primer/último punto")
        exp_m = int(round(sum(m for m, _ in res["_totales_por_fecha"].values())))
        exp_d = numero_json(sum(d for _, d in res["_totales_por_fecha"].values()))
        if puntos[-1]["muertes_acum"] != exp_m:
            problemas.append(f"{tid}: total muertes {puntos[-1]['muertes_acum']} != {exp_m}")
        if puntos[-1]["danos_acum_usd"] != exp_d:
            problemas.append(f"{tid}: total daños {puntos[-1]['danos_acum_usd']} != {exp_d}")
    if problemas:
        for p in problemas:
            print("FALLO:", p, file=sys.stderr)
        raise SystemExit(f"Autovalidación fallida ({len(problemas)} problemas).")


# ------------------------------------------------------------------- main

def main():
    with CSV_FUENTE.open(newline="", encoding="utf-8") as f:
        filas = list(csv.DictReader(f))
    if not filas:
        raise SystemExit(f"ERROR: {CSV_FUENTE} vacío")

    por_tormenta = defaultdict(list)
    for fila in filas:
        por_tormenta[fila["storm_id"]].append(fila)

    DIR_TORMENTAS.mkdir(parents=True, exist_ok=True)

    docs, resumenes = {}, {}
    for sid in sorted(por_tormenta):
        doc, res = convertir_tormenta(por_tormenta[sid])
        docs[doc["id"]] = doc
        resumenes[doc["id"]] = res

    validar(docs, resumenes)

    # Escritura determinista: tormentas en orden de id; índice por muertes desc.
    for tid in sorted(docs):
        ruta = DIR_TORMENTAS / f"{tid}.json"
        ruta.write_text(json.dumps(docs[tid], ensure_ascii=False, indent=1) + "\n",
                        encoding="utf-8")

    # Regla 8: limpiar JSON del mock que no estén en el dataset.
    borrados = []
    for ruta in sorted(DIR_TORMENTAS.glob("*.json")):
        if ruta.stem not in docs:
            ruta.unlink()
            borrados.append(ruta.name)

    orden = sorted(resumenes.values(), key=lambda r: (-r["muertes_total"], r["id"]))
    indice = []
    for r in orden:
        indice.append({k: r[k] for k in CLAVES_INDICE})
    RUTA_INDICE.write_text(
        json.dumps({"mock": False, "nota": NOTA, "tormentas": indice},
                   ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8")

    # Reporte final.
    print(f"\n{len(docs)} tormentas · {sum(r['_puntos'] for r in resumenes.values())} puntos "
          f"· {len(filas)} filas CSV")
    if borrados:
        print("Borrados del mock:", ", ".join(borrados))
    print(f"\n{'tormenta':<14} {'puntos':>6} {'cat_pico':>8} {'muertes':>8} "
          f"{'danos_total_usd':>16} {'tocatierras':>11}")
    for r in orden:
        print(f"{r['id']:<14} {r['_puntos']:>6} {r['cat_pico']:>8} {r['muertes_total']:>8} "
              f"{r['danos_total_usd']:>16} {r['_tocatierras']:>11}")
    print(f"\nOK · {RUTA_INDICE} + {len(docs)} archivos en {DIR_TORMENTAS}/")


if __name__ == "__main__":
    main()
