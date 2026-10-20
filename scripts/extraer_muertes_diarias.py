#!/usr/bin/env python3
"""extraer_muertes_diarias.py — reconstruye CUÁNDO murió la gente, tormenta por
tormenta, a partir de los ficheros individuales de víctimas de NOAA Storm Events.

De dónde salen los datos
------------------------
NOAA publica, además del resumen por evento, un fichero de **víctimas
individuales** (`StormEvents_fatalities`): una fila por persona fallecida, con su
fecha, tipo (directa/indirecta), edad, sexo y lugar. Ese es el dato que permite
saber *cuándo* murió la gente y no solo cuántos murieron en total.

Para saber a qué tormenta pertenece cada víctima se une
`fatalities.EVENT_ID` -> `details.EVENT_ID`, y del evento se lee su
`EPISODE_NARRATIVE`, que nombra la tormenta («Hurricane Maria was a
catastrophic category 4 hurricane...»). Además se acota por la ventana temporal
de la tormenta para no capturar tormentas homónimas de otros años.

Salida
------
  data/muertes/muertes_por_dia.csv   tormenta, fecha, directas, indirectas, total

Limitación honesta: Storm Events solo cubre EE. UU. Las muertes del resto del
Caribe (Haití en Ike, Dominica en María...) no aparecen aquí y hay que añadirlas
a mano con lo que dice el TCR.
"""

import csv
import gzip
import io
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
# Caché de descargas de Storm Events: bajo el repo por defecto (se puede
# sobreescribir con la variable de entorno VIENTOVIS_SE_CACHE).
CACHE = Path(os.environ.get("VIENTOVIS_SE_CACHE", str(RAIZ / ".cache" / "se-dl")))
BASE = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles"

# tormenta -> año, patrón del relato, ventana temporal del episodio
#
# El patrón es SOLO el nombre de la tormenta. Comprobado que los relatos alternan
# «Hurricane Helene», «Tropical Storm Helene», «Tropical Cyclone Helene»,
# «Remnants of Hurricane Helene»... y exigir «Hurricane X» perdía la mayoría de
# las muertes (Helene caía al 11 % de cobertura). La ventana temporal estrecha es
# la que evita confundir tormentas homónimas.
TORMENTAS = {
    "KATRINA": (2005, r"\bKatrina\b", ("2005-08-23", "2005-10-31")),
    "IKE":     (2008, r"\bIke\b",     ("2008-09-01", "2008-10-31")),
    "SANDY":   (2012, r"\bSandy\b",   ("2012-10-25", "2012-11-30")),
    "HARVEY":  (2017, r"\bHarvey\b",  ("2017-08-17", "2017-10-31")),
    "IRMA":    (2017, r"\bIrma\b",    ("2017-08-30", "2017-10-31")),
    "MARIA":   (2017, r"\bMaria\b",   ("2017-09-16", "2017-12-31")),
    "MICHAEL": (2018, r"\bMichael\b", ("2018-10-07", "2018-11-30")),
    "IDA":     (2021, r"\bIda\b",     ("2021-08-26", "2021-10-31")),
    "IAN":     (2022, r"\bIan\b",     ("2022-09-23", "2022-11-30")),
    "HELENE":  (2024, r"\bHelene\b",  ("2024-09-23", "2024-11-30")),
}

# Total verificado del NHC por tormenta — solo para el diagnóstico de cobertura.
# La fuente es data/muertes/muertes_verificadas.csv (Tropical Cyclone Reports).
NHC = {
    "KATRINA": 1392, "IKE": 195, "SANDY": 234, "HARVEY": 103, "IRMA": 128,
    "MARIA": 3022, "MICHAEL": 59, "IDA": 87, "IAN": 156, "HELENE": 250,
}


def bajar(nombre):
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / nombre
    if dest.exists() and dest.stat().st_size > 1000:
        return dest
    url = f"{BASE}/{nombre}"
    print(f"  bajando {nombre} ...", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as r, dest.open("wb") as fh:
        fh.write(r.read())
    return dest


def leer_gz(path):
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
        yield from csv.DictReader(fh)


FORMATOS_FECHA = ("%m/%d/%Y %H:%M:%S", "%d-%b-%y %H:%M:%S", "%Y-%m-%d %H:%M:%S")


def fecha(txt):
    """Los ficheros mezclan formatos: las víctimas usan MM/DD/YYYY y los eventos
    20-SEP-17. Se prueban los dos (y un tercero por si acaso)."""
    txt = (txt or "").strip()
    for fmt in FORMATOS_FECHA:
        try:
            return datetime.strptime(txt, fmt)
        except Exception:
            continue
    return None


def main():
    # --- qué años hacen falta y qué ficheros hay ---
    idx = urllib.request.urlopen(
        urllib.request.Request(f"{BASE}/", headers={"User-Agent": "Mozilla/5.0"}),
        timeout=120).read().decode("utf-8", "replace")

    def fichero(tipo, anio):
        ms = re.findall(rf"StormEvents_{tipo}-ftp_v1\.0_d{anio}_c\d+\.csv\.gz", idx)
        return sorted(set(ms))[-1] if ms else None

    anios = sorted({a for a, _, _ in TORMENTAS.values()})
    eventos = defaultdict(set)        # tormenta -> {EVENT_ID}
    n_episodios = defaultdict(set)    # tormenta -> {EPISODE_ID}
    resumen_dir = defaultdict(float)

    for anio in anios:
        det = fichero("details", anio)
        if not fichero or not det:
            print(f"AVISO: sin fichero details para {anio}", file=sys.stderr)
            continue
        p = bajar(det)
        print(f"  procesando details {anio} ...", file=sys.stderr)
        for row in leer_gz(p):
            # OJO: se usa SOLO el relato del episodio, y NO se filtra por tipo de
            # evento. Comprobado que las muertes de Sandy están en eventos de
            # «High Wind», «Coastal Flood», «Rip Current»...; filtrar por
            # «Hurricane» las perdería casi todas.
            narr = row.get("EPISODE_NARRATIVE") or ""
            if not narr:
                continue
            for tor, (aa, pat, (d0, d1)) in TORMENTAS.items():
                if aa != anio or not re.search(pat, narr, re.I):
                    continue
                f = fecha(row.get("BEGIN_DATE_TIME", ""))
                if not f or not (d0 <= f.strftime("%Y-%m-%d") <= d1):
                    continue
                eventos[tor].add(row["EVENT_ID"])
                n_episodios[tor].add(row["EPISODE_ID"])
                try:
                    resumen_dir[tor] += float(row.get("DEATHS_DIRECT") or 0)
                except ValueError:
                    pass

    # --- víctimas individuales ---
    por_dia = defaultdict(lambda: defaultdict(lambda: [0, 0]))   # tor -> fecha -> [dir, ind]
    for tor, (anio, _, _) in TORMENTAS.items():
        fat = fichero("fatalities", anio)
        if not fat:
            continue
        p = bajar(fat)
        ids = eventos[tor]
        for row in leer_gz(p):
            if row.get("EVENT_ID") not in ids:
                continue
            f = fecha(row.get("FATALITY_DATE", ""))
            if not f:
                continue
            i = 0 if row.get("FATALITY_TYPE") == "D" else 1
            por_dia[tor][f.strftime("%Y-%m-%d")][i] += 1

    # --- salida ---
    salida = RAIZ / "data" / "muertes" / "muertes_por_dia.csv"
    salida.parent.mkdir(parents=True, exist_ok=True)
    with salida.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["tormenta", "fecha", "muertes_directas", "muertes_indirectas", "muertes_total"])
        for tor in TORMENTAS:
            for d in sorted(por_dia[tor]):
                dir_, ind = por_dia[tor][d]
                w.writerow([tor.capitalize(), d, dir_, ind, dir_ + ind])

    # --- diagnóstico de cobertura ---
    # Storm Events solo cubre EE. UU. y subregistra, así que la forma diaria es
    # buena pero el total no: por eso se reescala al total del NHC después.
    lineas = [
        "Cobertura de Storm Events (solo EE. UU.) frente al total verificado del NHC.",
        "",
        "La forma diaria (cuándo murió la gente) sale de aquí; el total que se",
        "muestra sale del NHC. Por eso la cobertura no llega al 100 %: no es un",
        "error, es la diferencia entre «cuántos» (NHC) y «cuándo» (Storm Events).",
        "",
        f"{'tormenta':<10}{'episodios':>10}{'eventos':>9}{'días':>6}{'víctimas':>10}{'NHC':>7}{'cob.':>7}",
        "-" * 62,
    ]
    for tor in TORMENTAS:
        tot = sum(sum(v) for v in por_dia[tor].values())
        nhc = NHC.get(tor, 0)
        cob = f"{100*tot/nhc:5.0f}%" if nhc else "  -  "
        lineas.append(f"{tor:<10}{len(n_episodios[tor]):>10}{len(eventos[tor]):>9}"
                      f"{len(por_dia[tor]):>6}{tot:>10}{nhc:>7}{cob:>7}")
    texto = "\n".join(lineas)
    diag = RAIZ / "data" / "muertes" / "diagnostico.txt"
    diag.write_text(texto + "\n")
    print(f"\nescrito {diag}\n")
    print(texto)


if __name__ == "__main__":
    main()
