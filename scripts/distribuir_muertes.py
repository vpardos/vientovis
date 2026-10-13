#!/usr/bin/env python3
"""distribuir_muertes.py — reparte las muertes verificadas a lo largo del tiempo,
con la mejor distribución temporal que permita la evidencia.

Sustituye al reparto de un solo día que traía el dataset (Storm Events concentraba
el total de cada tormenta en una única fecha).

De dónde sale la forma temporal
-------------------------------
1. **Ocho tormentas** (Ike, Sandy, Harvey, Irma, Michael, Ida, Ian, Helene): del
   fichero de **víctimas individuales** de NOAA Storm Events, que da una fila por
   fallecido con su fecha. Lo genera `extraer_muertes_diarias.py`.

2. **Katrina**: Storm Events no sirve (Louisiana declaró sus muertes en bloque: 982
   en una sola fecha). Se usa un **modelo de decaimiento documentado**: el
   grueso de las muertes ocurrió en los días siguientes al fallo de los diques
   (29 ago – 4 sep), con una cola decreciente durante septiembre. Es una
   reconstrucción, no un dato observado.

3. **María**: tampoco sirve Storm Events (Puerto Rico apenas registró muertes:
   solo 20). Se usa la **distribución mensual de exceso de mortalidad** del
   estudio de la Universidad George Washington (Santos-Burgoa et al., Lancet
   Planetary Health 2018), que es de donde sale el propio total de 2 975:
   sep 574 · oct 697 · nov 348 · dic 479 · ene 558 · feb 320.

   OJO: esa ventana de 6 meses es más larga que la línea de tiempo de la app, que
   solo cubre el recorrido de la tormenta (16 sep – 2 oct). Aquí se **comprime**
   al tramo visible, manteniendo la forma decreciente. Es la mayor distorsión
   temporal de todo el dataset y así queda documentada.

El TOTAL siempre es el verificado del NHC; lo que se reconstruye es el reparto.

Uso:
    python3 scripts/distribuir_muertes.py --dry-run
    python3 scripts/distribuir_muertes.py
"""

import csv
import shutil
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CSV = RAIZ / "notebooks" / "hurricanes_unido.csv"
POR_DIA = RAIZ / "data" / "muertes" / "muertes_por_dia.csv"

# Totales verificados (Tropical Cyclone Reports del NHC) — ver
# data/muertes/muertes_verificadas.csv y data/muertes/README.md
#
# directas / indirectas / indeterminadas -> del propio TCR; total -> lo que se muestra.
VERIFICADAS = {
    "KATRINA": dict(anio=2005, directas=520, indirectas=565, indeterminadas=307, total=1392,
                    tcr="AL122005",
                    nota="520 directas + 565 indirectas + 307 de causa indeterminada (Rappaport 2014; Rappaport y Blanchard 2016)"),
    "IKE": dict(anio=2008, directas=103, indirectas=92, indeterminadas=0, total=195,
                tcr="AL092008",
                nota="El TCR publica 103 directas (74 en Haití); el total añade las indirectas"),
    "SANDY": dict(anio=2012, directas=147, indirectas=87, indeterminadas=0, total=234,
                  tcr="AL182012",
                  nota="147 directas en la cuenca + 87 indirectas en EE. UU."),
    "HARVEY": dict(anio=2017, directas=68, indirectas=35, indeterminadas=0, total=103,
                   tcr="AL092017",
                   nota="68 directas en Texas (todas en EE. UU.) + «about 35» indirectas"),
    "IRMA": dict(anio=2017, directas=46, indirectas=82, indeterminadas=0, total=128,
                 tcr="AL112017",
                 nota="46 directas en el Caribe y EE. UU. + 82 indirectas en EE. UU."),
    "MARIA": dict(anio=2017, directas=3022, indirectas=0, indeterminadas=0, total=3022,
                  tcr="AL152017",
                  nota="Puerto Rico 2 975 (directas+indirectas, estudio GWU 2018) + 47 en el resto del Caribe y EE. UU. El TCR no separa directas de indirectas en Puerto Rico"),
    "MICHAEL": dict(anio=2018, directas=16, indirectas=43, indeterminadas=0, total=59,
                    tcr="AL142018",
                    nota="16 directas + 43 indirectas, todas en EE. UU."),
    "IDA": dict(anio=2021, directas=55, indirectas=32, indeterminadas=0, total=87,
                tcr="AL092021",
                nota="55 directas + 32 indirectas en EE. UU."),
    "IAN": dict(anio=2022, directas=66, indirectas=90, indeterminadas=0, total=156,
                tcr="AL092022",
                nota="156 en EE. UU. (66 directas + 90 indirectas); el TCR añade 5 muertes más en Cuba"),
    "HELENE": dict(anio=2024, directas=175, indirectas=75, indeterminadas=0, total=250,
                   tcr="AL092024",
                   nota="El TCR da el total: «at least 250 fatalities (including at least 175 direct deaths)» en EE. UU."),
}

TOTAL = {k: v["total"] for k, v in VERIFICADAS.items()}

# Muertes de María FUERA de Puerto Rico (47 en total). El TCR no da fecha exacta
# de cada una, pero sí el sitio y el orden: Dominica el 19 (tocatierra 01:15Z),
# Guadalupe el 19, y el resto en los días siguientes. Fechas estimadas.
MARIA_FUERA_PR = {
    "20170919": 33,   # Dominica 31 (tocatierra) + Guadalupe 2
    "20170921": 2,    # St. Thomas
    "20170922": 5,    # República Dominicana (4 arrastrados + 1 deslizamiento)
    "20170923": 3,    # Haití
    "20170925": 4,    # EE. UU. (3 corrientes de resaca + 1 en Fernandina Beach)
}


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


def leer_forma_real():
    """tormenta -> {fecha(YYYY-MM-DD): muertes} de las víctimas individuales."""
    forma = defaultdict(dict)
    if not POR_DIA.exists():
        return forma
    for r in csv.DictReader(POR_DIA.open()):
        forma[r["tormenta"].upper()][r["fecha"]] = int(r["muertes_total"])
    return forma


def forma_katrina(fechas_validas):
    """Decaimiento exponencial desde el fallo de los diques (29 ago 2005).

    Documentado: el grueso de las muertes ocurrió en los días inmediatos a la
    inundación de Nueva Orleans; después la cola decrece durante septiembre.
    """
    ini = date(2005, 8, 29)
    pesos = []
    for f in fechas_validas:
        d = (f - ini).days
        if d < 0:
            pesos.append(0.0)
        else:
            pesos.append(2.718281828 ** (-d / 3.0))
    return pesos


def muertes_maria(fechas_validas):
    """Muertes REALES dentro de la ventana activa de María (16 sep – 2 oct).

    El total verificado de 3 022 es un **exceso de mortalidad de seis meses**
    (sep 2017 – feb 2018), no muertes del día del impacto. Aquí solo se cuentan
    las que caen dentro de los días en que la tormenta estuvo activa:

    - **Puerto Rico**: la tasa diaria media de su mes en el estudio de GWU
      (sep 574/30 · oct 697/31), desde el tocatierra en Yabucoa (20 sep).
      Antes del impacto no hubo exceso de mortalidad en la isla.
    - **Resto del Caribe y EE. UU.**: las 47 muertes que el TCR sí sitúa en días
      concretos, en esos días.

    Resultado: ≈302 muertes en vez de 3 022. La diferencia son los meses en que
    la tormenta ya no estaba activa y no caben en la línea de tiempo de la app.
    """
    ATERRIZAJE_PR = date(2017, 9, 20)     # tocatierra en Yabucoa, Puerto Rico
    TASA_MENSUAL = {(2017, 9): (574, 30), (2017, 10): (697, 31)}

    valores = []
    for f in fechas_validas:
        v = 0.0
        if f >= ATERRIZAJE_PR:
            t = TASA_MENSUAL.get((f.year, f.month))
            if t:
                v += t[0] / t[1]
        valores.append(v)

    # Muertes fuera de Puerto Rico (47 en total), fechadas según el relato del TCR.
    for fstr, n in MARIA_FUERA_PR.items():
        d = datetime.strptime(fstr, "%Y%m%d").date()
        if d in fechas_validas:
            valores[fechas_validas.index(d)] += n
        else:
            print(f"  AVISO: {fstr} no está en la ventana de María; {n} muertes sin colocar",
                  file=sys.stderr)
    return valores


def main():
    dry = "--dry-run" in sys.argv
    filas = list(csv.DictReader(CSV.open()))
    campos = list(filas[0].keys())

    fechas_tormenta = defaultdict(list)
    for f in filas:
        d = datetime.strptime(f["date"], "%Y%m%d").date()
        if d not in fechas_tormenta[f["storm"]]:
            fechas_tormenta[f["storm"]].append(d)
    for k in fechas_tormenta:
        fechas_tormenta[k].sort()

    forma = leer_forma_real()
    nuevas = {}
    objetivos = {}
    informe = []

    for storm, fechas in fechas_tormenta.items():
        if storm not in TOTAL:
            print(f"  AVISO: {storm} sin total verificado; se deja igual", file=sys.stderr)
            continue

        if storm == "KATRINA":
            pesos = forma_katrina(fechas)
            objetivo = TOTAL[storm]
            origen = "modelo (fallo de diques, 29 ago)"
        elif storm == "MARIA":
            pesos = muertes_maria(fechas)
            objetivo = int(round(sum(pesos)))     # solo la ventana activa
            origen = "solo ventana activa (tasa GWU + 47 fuera de PR)"
        else:
            real = forma.get(storm, {})
            # muertes en fechas fuera del recorrido -> se pliegan en la más cercana
            idx = {d: i for i, d in enumerate(fechas)}
            pesos = [0.0] * len(fechas)
            for fstr, n in real.items():
                d = datetime.strptime(fstr, "%Y-%m-%d").date()
                if d in idx:
                    pesos[idx[d]] += n
                else:
                    # fuera de la ventana: a la fecha disponible más próxima
                    j = min(range(len(fechas)), key=lambda k: abs((fechas[k] - d).days))
                    pesos[j] += n
            objetivo = TOTAL[storm]
            origen = "víctimas individuales Storm Events" if sum(pesos) else "sin datos"

        reparto = resto_mayor(pesos, objetivo)
        nuevas[storm] = {f.strftime("%Y%m%d"): v for f, v in zip(fechas, reparto)}
        objetivos[storm] = objetivo

        # días con muertes, para el informe
        nz = sum(1 for v in reparto if v)
        informe.append((storm, objetivo, nz, origen))

    print(f"\n{'tormenta':<10}{'total':>7}{'días c/muertes':>16}   forma temporal")
    print("-" * 74)
    for s, t, nz, o in sorted(informe, key=lambda x: -x[1]):
        print(f"{s:<10}{t:>7}{nz:>16}   {o}")

    if dry:
        print("\n(--dry-run: no se ha escrito nada)")
        return

    shutil.copy2(CSV, CSV.with_suffix(".csv.predistrib"))
    for f in filas:
        s = f["storm"]
        if s not in nuevas:
            continue
        v = nuevas[s].get(f["date"], 0)
        f["deaths_direct"] = str(v) if v else ""
        f["deaths_indirect"] = ""

    with CSV.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=campos)
        w.writeheader()
        w.writerows(filas)
    print(f"\nescrito {CSV}")
    print(f"copia: {CSV.with_suffix('.csv.predistrib')}")

    # validación
    malos = []
    for s in nuevas:
        suma = sum(nuevas[s].values())
        if suma != objetivos[s]:
            malos.append(f"{s}: {suma} != {objetivos[s]}")
    if malos:
        for m in malos:
            print("ERROR:", m, file=sys.stderr)
        raise SystemExit(1)
    print("validación OK: cada tormenta suma exactamente su objetivo")

    # --- tabla de cifras verificadas con procedencia completa ---
    destino = RAIZ / "data" / "muertes" / "muertes_verificadas.csv"
    with destino.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["tormenta", "anio", "muertes_directas", "muertes_indirectas",
                    "muertes_indeterminadas", "muertes_total", "informe_tcr",
                    "url_tcr", "nota"])
        for tor, v in VERIFICADAS.items():
            nombre = tor.capitalize()
            w.writerow([nombre, v["anio"], v["directas"], v["indirectas"],
                        v["indeterminadas"], v["total"], v["tcr"],
                        f"https://www.nhc.noaa.gov/data/tcr/{v['tcr']}_{nombre}.pdf",
                        v["nota"]])
    print(f"escrito {destino}")


if __name__ == "__main__":
    main()
