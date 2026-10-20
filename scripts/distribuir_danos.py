#!/usr/bin/env python3
"""distribuir_danos.py — reparte los daños verificados a lo largo del evento.

Mismo proceso que `distribuir_muertes.py`, para las columnas de daños.

De dónde salen las cifras
-------------------------
Del **Tropical Cyclone Report** de cada tormenta (la misma fuente que las muertes).
Los informes dan, además del total, el desglose por país o isla cuando la tormenta
afectó a varios. Eso permite que **cada tocatierra tenga sus daños**, en vez de
concentrar todo en un único punto:

- María: Dominica 1 310 M$ y Guadalupe 120 M$ **en su tocatierra** (19 sep), y
  Puerto Rico + Islas Vírgenes 90 000 M$ desde el tocatierra de Yabucoa (20 sep).
  Antes esta tormenta solo tenía un valor para Puerto Rico y **nada en Dominica**.
- Irma: Barbuda, San Martín, San Bartolomé y Anguila (6 sep), Islas Vírgenes
  (7 sep), Cuba (9 sep) y EE. UU. (10 sep).
- Sandy: Jamaica (24 oct), Cuba (25 oct), Haití y República Dominicana (26 oct),
  EE. UU. (29 oct).
- Ike: Bahamas (7 sep), Cuba (8 sep), EE. UU. (13 sep).
- Ida: Cuba (27 ago), EE. UU. (29 ago).

Qué NO se inventa
------------------
Donde el informe dice explícitamente que no hay cifra, se deja a cero y se
documenta: Ian en Cuba («no monetary damage estimate available for Cuba») y el
paso de Katrina por Florida. Esos tocatierras quedan sin daños porque el dato no
existe, no porque se haya perdido.

Cómo se reparte lo que no tiene país asignado
----------------------------------------------
El resto del total (el grueso, casi siempre de EE. UU. y sin desglose por estado en
el informe) se reparte **según la forma diaria real de NOAA Storm Events** para esa
tormenta, reescalada. Si esa forma no sirve —María solo tiene un día con dato— se
reparte con un **decaimiento desde el último tocatierra**, que es como se acumulan
los daños: destrucción de golpe y pérdidas que se van sumando.

Ajuste por inflación
--------------------
Los totales de los TCR vienen en **dólares nominales del año del evento**. Este
script los re-escala a **dólares de 2024** con el CPI-U (promedio anual, serie
CUUR0000SA0, base 1982-84=100, BLS), de modo que la app compara tormentas de
2005–2024 en poder de compra común. El desglose por país (COMPONENTES) se ajusta
con el mismo factor del año, así cada tocatierra conserva su proporción exacta.
`danos_verificados.csv` guarda el total nominal Y el ajustado, con el factor usado.

Uso:
    python3 scripts/distribuir_danos.py --dry-run
    python3 scripts/distribuir_danos.py
"""

import csv
import shutil
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CSV = RAIZ / "notebooks" / "hurricanes_unido.csv"
NOTAS = RAIZ / "data" / "notas-tocatierras.json"
DESTINO_CSV = RAIZ / "data" / "danos" / "danos_verificados.csv"

M = 1_000_000

# Totales verificados (USD nominales del año del evento) y su procedencia.
# Ver data/danos/README.md para las citas textuales.
VERIFICADOS = {
    "KATRINA": dict(anio=2005, total=125_000 * M, tcr="AL122005",
                    nota="EE. UU., dólares de 2005 (NCEI); intervalo 97 400–145 500 M$. Incluye Florida, Luisiana y Misisipi"),
    "IKE": dict(anio=2008, total=33_145 * M, tcr="AL092008",
                nota="EE. UU. 29 520 M$ (doblado del daño asegurado) + Cuba 3 500 M$ + Bahamas/Turcas y Caicos 125 M$"),
    "SANDY": dict(anio=2012, total=52_880 * M, tcr="AL182012",
                  nota="EE. UU. 50 000 M$ (preliminar) + Cuba 2 000 M$ + Haití 750 M$ + Jamaica 100 M$ + Rep. Dominicana 30 M$"),
    "HARVEY": dict(anio=2017, total=125_000 * M, tcr="AL092017",
                   nota="EE. UU. (NCEI); intervalo 90 000–160 000 M$"),
    "IRMA": dict(anio=2017, total=53_095 * M, tcr="AL112017",
                 nota="EE. UU. 50 000 M$ + San Martín 1 500 M$ + Islas Vírgenes (EE.UU./Brit.) 500 M$ + San Bartolomé 480 M$ + Barbuda 225 M$ + Cuba 200 M$ + Anguila 190 M$"),
    "MARIA": dict(anio=2017, total=91_430 * M, tcr="AL152017",
                  nota="Puerto Rico + Islas Vírgenes EE.UU. 90 000 M$ (NCEI; intervalo 65 000–115 000 M$) + Dominica 1 310 M$ + Guadalupe 120 M$"),
    "MICHAEL": dict(anio=2018, total=25_000 * M, tcr="AL142018",
                    nota="EE. UU.: Florida 18 400 M$, Georgia 4 700 M$, resto 1 100 M$"),
    "IDA": dict(anio=2021, total=75_250 * M, tcr="AL092021",
                nota="EE. UU. 75 000 M$ (NCEI) + Cuba 250 M$"),
    "IAN": dict(anio=2022, total=112_900 * M, tcr="AL092022",
                nota="Solo EE. UU. (NCEI); intervalo 86 800–135 900 M$. El informe dice que NO hay estimación monetaria para Cuba"),
    "HELENE": dict(anio=2024, total=78_700 * M, tcr="AL092024",
                   nota="EE. UU. (NCEI)"),
}

# Importes documentados con lugar concreto -> se fijan en la fecha de su tocatierra,
# expresados como (fecha, importe, lugar).
COMPONENTES = {
    "IKE": [("20080907", 125 * M, "Bahamas / Turcas y Caicos"),
            ("20080908", 3_500 * M, "Cuba")],
    "SANDY": [("20121024", 100 * M, "Jamaica"),
              ("20121025", 2_000 * M, "Cuba"),
              ("20121026", 750 * M, "Haití"),
              ("20121026", 30 * M, "República Dominicana")],
    "IRMA": [("20170906", 225 * M, "Barbuda"),
             ("20170906", 1_500 * M, "San Martín / Sint Maarten"),
             ("20170906", 480 * M, "San Bartolomé"),
             ("20170906", 190 * M, "Anguila"),
             ("20170907", 500 * M, "Islas Vírgenes EE.UU. y Británicas"),
             ("20170909", 200 * M, "Cuba")],
    "MARIA": [("20170919", 1_310 * M, "Dominica"),
              ("20170919", 120 * M, "Guadalupe")],
    "IDA": [("20210827", 250 * M, "Cuba")],
}

# --- Ajuste por inflación: dólares del año del evento -> dólares de 2024 ----
# CPI-U, promedio anual, serie CUUR0000SA0 (base 1982-84=100), BLS.
# Valores verificados contra la tabla histórica (ver data/SOURCES.md, «Inflación»).
ANIO_REFERENCIA = 2024
CPI_U = {
    2005: 195.3,
    2008: 215.303,
    2012: 229.594,
    2017: 245.120,
    2018: 251.107,
    2021: 270.970,
    2022: 292.655,
    2024: 313.689,
}


def factor_inflacion(anio):
    """Factor para pasar dólares del año del evento a dólares de ANIO_REFERENCIA."""
    if anio not in CPI_U:
        raise SystemExit(f"ERROR: sin CPI-U para {anio}; añadir su promedio anual a CPI_U")
    return CPI_U[ANIO_REFERENCIA] / CPI_U[anio]


def resto_mayor(valores, total):
    """Reparte `total` proporcionalmente a `valores`; la suma es EXACTAMENTE total."""
    total = int(round(total))
    base = sum(valores)
    if base <= 0 or total <= 0:
        return [0] * len(valores)
    cuotas = [v * total / base for v in valores]
    pisos = [int(q) for q in cuotas]
    falta = total - sum(pisos)
    for i in sorted(range(len(cuotas)), key=lambda i: (-(cuotas[i] - pisos[i]), i))[:falta]:
        pisos[i] += 1
    return pisos


def fechas_tocatierra():
    """{storm_id: [fechas de tocatierra]} a partir del fichero curado de la app."""
    import json
    crudo = json.load(NOTAS.open(encoding="utf-8"))
    salida = {}
    for tid, notas in crudo.items():
        ds = []
        for n in notas:
            txt = n["t"].rstrip("Z")
            for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
                try:
                    ds.append(datetime.strptime(txt, fmt).date())
                    break
                except ValueError:
                    continue
        salida[tid] = sorted(set(ds))
    return salida


def main():
    dry = "--dry-run" in sys.argv
    filas = list(csv.DictReader(CSV.open()))
    campos = list(filas[0].keys())

    def a_float(v):
        v = (v or "").strip()
        try:
            return float(v)
        except ValueError:
            return 0.0

    fechas_tormenta = defaultdict(list)
    forma = defaultdict(dict)      # storm -> {fecha: daño Storm Events}
    for f in filas:
        d = datetime.strptime(f["date"], "%Y%m%d").date()
        if d not in fechas_tormenta[f["storm"]]:
            fechas_tormenta[f["storm"]].append(d)
        if f["date"] not in forma[f["storm"]]:
            forma[f["storm"]][f["date"]] = 0.0
        # la primera fila de la fecha manda (el converter acumula una vez por fecha)
    for storm, fechas in fechas_tormenta.items():
        fechas.sort()

    # forma real de Storm Events (una vez por fecha)
    vistos = set()
    for f in filas:
        k = (f["storm"], f["date"])
        if k in vistos:
            continue
        vistos.add(k)
        forma[f["storm"]][f["date"]] = a_float(f["damage_property_usd"]) + a_float(f["damage_crops_usd"])

    tocs = fechas_tocatierra()
    id_de = {"KATRINA": "katrina-2005", "IKE": "ike-2008", "SANDY": "sandy-2012",
             "HARVEY": "harvey-2017", "IRMA": "irma-2017", "MARIA": "maria-2017",
             "MICHAEL": "michael-2018", "IDA": "ida-2021", "IAN": "ian-2022",
             "HELENE": "helene-2024"}

    nuevas = {}
    objetivos = {}
    informe = []

    for storm, fechas in fechas_tormenta.items():
        if storm not in VERIFICADOS:
            print(f"  AVISO: {storm} sin daño verificado; se deja igual", file=sys.stderr)
            continue

        total_nominal = VERIFICADOS[storm]["total"]
        factor = factor_inflacion(VERIFICADOS[storm]["anio"])
        total = int(round(total_nominal * factor))
        forzados = defaultdict(float)
        for fstr, imp, lugar in COMPONENTES.get(storm, []):
            d = datetime.strptime(fstr, "%Y%m%d").date()
            if d not in fechas:
                print(f"  AVISO {storm}: {fstr} ({lugar}) fuera del recorrido", file=sys.stderr)
                continue
            forzados[fstr] += int(round(imp * factor))
        forzados = dict(forzados)

        puesto = sum(forzados.values())
        resto = total - puesto
        if resto < 0:
            raise SystemExit(f"ERROR {storm}: los componentes ({puesto/1e9:.2f} mil M) "
                             f"superan el total ({total/1e9:.2f} mil M)")

        candidatos = [d for d in fechas if d.strftime("%Y%m%d") not in forzados]
        pesos = [forma[storm].get(d.strftime("%Y%m%d"), 0.0) for d in candidatos]

        origen = "forma diaria de Storm Events"
        if sum(1 for p in pesos if p > 0) < 2:
            # forma degenerada: decaimiento desde el último tocatierra
            lista_toc = tocs.get(id_de[storm]) or [fechas[0]]
            ancla = max(lista_toc)
            pesos = []
            for d in candidatos:
                dias = (d - ancla).days
                pesos.append(0.0 if dias < 0 else 2.718281828 ** (-float(dias) / 4.0))
            origen = "decaimiento desde el último tocatierra (forma no utilizable)"

        reparto = resto_mayor(pesos, resto)
        valores = {d.strftime("%Y%m%d"): v for d, v in zip(candidatos, reparto)}
        for fstr, imp in forzados.items():
            valores[fstr] = valores.get(fstr, 0) + int(round(imp))
        nuevas[storm] = valores
        objetivos[storm] = total
        informe.append((storm, total_nominal, total, factor,
                        len([v for v in valores.values() if v]),
                        len(forzados), origen))

    print(f"\n{'tormenta':<9}{'nominal':>11}{'USD 2024':>11}{'factor':>9}{'días':>6}{'fijados':>9}   reparto")
    print("-" * 92)
    for s, tn, t, f, n, nf, o in sorted(informe, key=lambda x: -x[2]):
        print(f"{s:<9}{tn/1e9:>10.1f}B{t/1e9:>10.1f}B{f:>9.4f}{n:>6}{nf:>9}   {o}")

    if dry:
        print("\n(--dry-run: no se ha escrito nada)")
        return

    shutil.copy2(CSV, CSV.with_suffix(".csv.predanos"))
    for f in filas:
        s = f["storm"]
        if s not in nuevas:
            continue
        v = nuevas[s].get(f["date"], 0)
        f["damage_property_usd"] = str(v) if v else ""
        f["damage_crops_usd"] = ""

    with CSV.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=campos)
        w.writeheader()
        w.writerows(filas)
    print(f"\nescrito {CSV}")
    print(f"copia: {CSV.with_suffix('.csv.predanos')}")

    malos = [f"{s}: {sum(nuevas[s].values())} != {objetivos[s]}"
             for s in nuevas if sum(nuevas[s].values()) != objetivos[s]]
    if malos:
        for m in malos:
            print("ERROR:", m, file=sys.stderr)
        raise SystemExit(1)
    print("validación OK: cada tormenta suma exactamente su daño verificado")

    DESTINO_CSV.parent.mkdir(parents=True, exist_ok=True)
    with DESTINO_CSV.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["tormenta", "anio", "danos_total_usd_nominal", "danos_total_usd",
                    "factor_inflacion", "informe_tcr", "url_tcr", "nota"])
        for tor, v in VERIFICADOS.items():
            nombre = tor.capitalize()
            f = factor_inflacion(v["anio"])
            w.writerow([nombre, v["anio"], v["total"], int(round(v["total"] * f)),
                        f"{f:.6f}", v["tcr"],
                        f"https://www.nhc.noaa.gov/data/tcr/{v['tcr']}_{nombre}.pdf",
                        v["nota"]])
    print(f"escrito {DESTINO_CSV}")


if __name__ == "__main__":
    main()
