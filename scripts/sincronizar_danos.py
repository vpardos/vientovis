#!/usr/bin/env python3
"""sincronizar_danos.py — re-timbra los incrementos de daños para que la escalera
de `danos_acum_usd` suba SINCRONIZADA con los tocatierras, como ya hacen las
muertes.

Contexto
--------
`convertir_dataset.py` acumula los importes diarios de daños en el PRIMER punto
de cada fecha. Por eso el salto grande de Katrina (+90,33 mil M$) caía el 08-28,
un día ANTES del tocatierra de Buras (08-29 11:10), y la escalera de daños subía
antes de la línea roja del mapa. Las muertes ya estaban alineadas porque se
acumulaban en el tocatierra. Este script corrige SOLO los daños; muertes, viento,
presión, posición, estatus y banderas no se tocan.

Regla de re-timbrado (determinista, una sola lógica)
----------------------------------------------------
1. Por tormenta se reconstruyen los incrementos Δ de `danos_acum_usd` entre puntos
   consecutivos. El primer punto aporta el valor inicial y no se mueve nunca: no
   se inventan impactos en el génesis (si valía 0, sigue valiendo 0).
2. Ningún incremento de daños puede ocurrir ANTES de un tocatierra (no hay
   ventana temporal: la regla es dura). Para cada Δ>0 en el punto i:
   - si el punto i ES un tocatierra, Δ se queda en él (no se mueve);
   - si no, Δ se RE-ATRIBUYE al tocatierra FUTURO más cercano (el siguiente,
     estrictamente posterior). Si hay varios Δ que caen en el mismo tramo, se
     suman en ese tocatierra;
   - Δ solo se queda donde estaba cuando NO existe tocatierra futuro, es decir,
     en los incrementos POSTERIORES al último tocatierra: cola legítima (igual
     que el final de las muertes).
   Consecuencia: la escalera queda PLANA entre tocatierras y salta exactamente
   en cada tocatierra.
3. Se reconstruye la serie como la suma de los incrementos ya re-timbrados con
   tiempo ≤ t del punto. Al ser todos Δ ≥ 0, la serie es monótona no decreciente.
   El último punto conserva EXACTAMENTE el total original (assert).
4. El proceso es idempotente: al ejecutarlo otra vez, los incrementos re-timbrados
   ya están EN un tocatierra (o después del último) y no se vuelven a mover. El
   script lo comprueba dos veces antes/depués de escribir: en memoria y
   releyendo el fichero recién escrito desde disco, y publica el sha256 de cada
   JSON para que una segunda corrida pueda compararse byte a byte.

La fidelidad temporal del dato cede ante la legibilidad de la visualización
(decisión del usuario): el total por tormenta es invariante y es el verificado.

Pipeline
--------
    extraer_muertes_diarias.py / distribuir_muertes.py / distribuir_danos.py
        → convertir_dataset.py        (escribe data/tormentas/*.json)
        → sincronizar_danos.py        (este script; re-timbra solo los daños)

`data/indice.json` NO se toca: los totales por tormenta no cambian.

Uso:
    python3 scripts/sincronizar_danos.py --dry-run
    python3 scripts/sincronizar_danos.py
"""

import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DIR_TORMENTAS = RAIZ / "data" / "tormentas"
N_TORMENTAS = 10


def instante(t):
    """'2005-08-29T11:10:00Z' -> datetime con zona UTC."""
    return datetime.fromisoformat(t.replace("Z", "+00:00"))


def retimbrar_danos(puntos):
    """Devuelve (serie_nueva, movimientos) para una lista de puntos.

    `serie_nueva[k]` es el `danos_acum_usd` re-timbrado del punto k.
    `movimientos` describe los Δ que cambiaron de punto, solo para el informe.
    No modifica `puntos`.
    """
    n = len(puntos)
    if n == 0:
        raise ValueError("tormenta sin puntos")

    tiempos = [instante(p["t"]) for p in puntos]
    for i in range(1, n):
        if tiempos[i] <= tiempos[i - 1]:
            raise ValueError(
                f"puntos no estrictamente cronológicos: "
                f"{puntos[i - 1]['t']} -> {puntos[i]['t']}"
            )
    tocatierras = [i for i, p in enumerate(puntos) if p.get("tocatierra")]

    valores = []
    for p in puntos:
        v = p["danos_acum_usd"]
        if not isinstance(v, int) or isinstance(v, bool):
            raise TypeError(f"danos_acum_usd no es entero: {v!r} en {p['t']}")
        if v < 0:
            raise ValueError(f"danos_acum_usd negativo: {v} en {p['t']}")
        valores.append(v)

    # Incrementos agrupados por punto de destino.
    por_punto = [0] * n
    movimientos = []

    # El valor inicial (normalmente 0) se queda en el primer punto: no se mueve
    # hacia delante ni se le suman impactos que no tenía.
    if valores[0] > 0:
        por_punto[0] += valores[0]

    for i in range(1, n):
        delta = valores[i] - valores[i - 1]
        if delta < 0:
            raise ValueError(
                f"serie de daños no monótona en el punto {i}: "
                f"{valores[i - 1]} -> {valores[i]} ({puntos[i]['t']})"
            )
        if delta == 0:
            continue

        destino = i
        if not puntos[i].get("tocatierra"):
            # Ningún incremento antes de un tocatierra: salta al SIGUIENTE
            # tocatierra, sin ventana de tiempo.
            futuros = [j for j in tocatierras if tiempos[j] > tiempos[i]]
            if futuros:
                destino = min(futuros, key=lambda k: (tiempos[k], k))
                if destino <= i:
                    raise AssertionError("un incremento no puede moverse al pasado")
                movimientos.append(
                    {
                        "desde": i,
                        "hasta": destino,
                        "importe": delta,
                        "horas": (tiempos[destino] - tiempos[i]).total_seconds()
                        / 3600.0,
                    }
                )
        por_punto[destino] += delta

    serie = []
    acumulado = 0
    for v in por_punto:
        acumulado += v
        serie.append(acumulado)

    # Invariantes de la reconstrucción.
    if serie[0] != valores[0]:
        raise AssertionError(f"el primer punto cambió: {valores[0]} -> {serie[0]}")
    if serie[-1] != valores[-1]:
        raise AssertionError(
            f"el total cambió: {valores[-1]} -> {serie[-1]} ({puntos[-1]['t']})"
        )
    if any(serie[k] < serie[k - 1] for k in range(1, n)):
        raise AssertionError("la serie reconstruida no es monótona")
    if sum(por_punto) != valores[-1]:
        raise AssertionError("la suma de incrementos no coincide con el total")

    # Regla dura: no puede quedar ningún incremento ANTES de un tocatierra.
    for i in range(1, n):
        if serie[i] - serie[i - 1] > 0 and not puntos[i].get("tocatierra"):
            if any(tiempos[j] > tiempos[i] for j in tocatierras):
                raise AssertionError(
                    f"incremento {serie[i] - serie[i - 1]:,} en {puntos[i]['t']} "
                    f"antes de un tocatierra"
                )
    return serie, movimientos


def formatear(v):
    """Importe legible: 125.000B / 5.023B / 0.7M / 315 USD."""
    if abs(v) >= 1_000_000_000:
        return f"{v / 1e9:.3f}B"
    if abs(v) >= 1_000_000:
        return f"{v / 1e6:.1f}M"
    return f"{v:,} USD"


def saltos(serie, puntos):
    """Lista de (índice, delta, es_tocatierra) con Δ != 0 en la serie nueva."""
    salida = []
    for i in range(1, len(serie)):
        d = serie[i] - serie[i - 1]
        if d:
            salida.append((i, d, bool(puntos[i].get("tocatierra"))))
    return salida


def clasificar_salto(puntos, i):
    """Etiqueta un salto según su posición respecto a los tocatierras."""
    if puntos[i].get("tocatierra"):
        return "TOCATIERRA"
    t = instante(puntos[i]["t"])
    if any(p.get("tocatierra") and instante(p["t"]) > t for p in puntos):
        return "ANOMALÍA: antes de un tocatierra"
    return "después del último tocatierra"


def main():
    dry = "--dry-run" in sys.argv
    rutas = sorted(DIR_TORMENTAS.glob("*.json"))
    if len(rutas) != N_TORMENTAS:
        raise SystemExit(
            f"ERROR: se esperaban {N_TORMENTAS} tormentas en {DIR_TORMENTAS}, "
            f"hay {len(rutas)}"
        )

    informe = []
    katrina_detalle = None
    avisos_generacion = []
    hashes = []

    for ruta in rutas:
        doc = json.loads(ruta.read_text(encoding="utf-8"))
        puntos = doc["puntos"]
        original = [p["danos_acum_usd"] for p in puntos]
        muertes = [p["muertes_acum"] for p in puntos]

        serie, movimientos = retimbrar_danos(puntos)

        # Idempotencia (1/2): una segunda pasada sobre la serie ya re-timbrada no
        # debe mover nada ni cambiar ningún valor.
        copia = [dict(p, danos_acum_usd=serie[i]) for i, p in enumerate(puntos)]
        serie2, movimientos2 = retimbrar_danos(copia)
        if serie2 != serie:
            raise AssertionError(f"{doc['id']}: el re-timbrado no es idempotente")
        if movimientos2:
            raise AssertionError(
                f"{doc['id']}: la segunda pasada movería {len(movimientos2)} "
                f"incrementos"
            )

        # Muertes y total: invariantes.
        if [p["muertes_acum"] for p in puntos] != muertes:
            raise AssertionError(f"{doc['id']}: las muertes cambiaron")
        if not serie or serie[-1] != original[-1]:
            raise AssertionError(f"{doc['id']}: el total de daños cambió")
        if serie[0] != original[0]:
            raise AssertionError(f"{doc['id']}: el primer punto cambió")

        contenido = None
        if not dry:
            for p, v in zip(puntos, serie):
                p["danos_acum_usd"] = v
            contenido = json.dumps(doc, ensure_ascii=False, indent=1) + "\n"
            ruta.write_text(contenido, encoding="utf-8")
            # Idempotencia (2/2): releer del disco y comprobar que no cambia nada.
            doc_disco = json.loads(ruta.read_text(encoding="utf-8"))
            serie_disco = [p["danos_acum_usd"] for p in doc_disco["puntos"]]
            if serie_disco != serie:
                raise AssertionError(f"{doc['id']}: lo escrito no coincide")
            if [p["muertes_acum"] for p in doc_disco["puntos"]] != muertes:
                raise AssertionError(f"{doc['id']}: las muertes cambiaron en disco")
            serie3, movimientos3 = retimbrar_danos(doc_disco["puntos"])
            if serie3 != serie or movimientos3:
                raise AssertionError(
                    f"{doc['id']}: el fichero escrito no es idempotente"
                )
            hashes.append(
                (ruta.name, hashlib.sha256(contenido.encode("utf-8")).hexdigest())
            )

        # Aviso de generación: daños acumulados antes del primer tocatierra.
        # Con la regla dura solo puede quedar el valor inicial del génesis.
        primer_toc = next((p["t"] for p in puntos if p.get("tocatierra")), None)
        previos = 0
        if primer_toc is not None:
            for p, v in zip(puntos, serie):
                if instante(p["t"]) < instante(primer_toc):
                    previos = v
                else:
                    break
            if previos > 0:
                avisos_generacion.append((doc["id"], primer_toc, previos))

        info = {
            "id": doc["id"],
            "puntos": puntos,
            "antes": original[-1],
            "despues": serie[-1],
            "monotona": all(serie[k] >= serie[k - 1] for k in range(1, len(serie))),
            "movidos": movimientos,
            "saltos": saltos(serie, puntos),
        }
        informe.append(info)
        if doc["id"] == "katrina-2005":
            katrina_detalle = info

    # ------------------------------------------------------------- informe
    print(f"\n{'tormenta':<16}{'total antes':>18}{'total después':>18}"
          f"{'monótona':>10}{'Δ movidos':>22}")
    print("-" * 88)
    for info in informe:
        mov = info["movidos"]
        detalle = (f"{len(mov)} ({formatear(sum(m['importe'] for m in mov))})"
                   if mov else "—")
        print(f"{info['id']:<16}{info['antes']:>18,}{info['despues']:>18,}"
              f"{'sí' if info['monotona'] else 'NO':>10}{detalle:>22}")

    if katrina_detalle:
        print("\nKatrina · saltos finales de danos_acum_usd por punto:")
        for i, delta, _toc in katrina_detalle["saltos"]:
            print(f"  {katrina_detalle['puntos'][i]['t']}  {delta:>+18,}  "
                  f"{clasificar_salto(katrina_detalle['puntos'], i)}")
        print("  el resto de puntos no cambia (tramos planos)")

    print("\nΔ re-atribuidos (todos al tocatierra siguiente, sin ventana):")
    alguno = False
    for info in informe:
        for m in info["movidos"]:
            origen = info["puntos"][m["desde"]]["t"]
            destino = info["puntos"][m["hasta"]]["t"]
            print(f"  {info['id']:<16}{origen}  +{formatear(m['importe']):>10}  "
                  f"→ tocatierra {destino}  ({m['horas']:.1f} h)")
            alguno = True
    if not alguno:
        print("  ninguno")

    print("\nCola legítima después del último tocatierra (no se mueve):")
    alguno = False
    for info in informe:
        puntos = info["puntos"]
        ult = max((i for i, p in enumerate(puntos) if p.get("tocatierra")),
                  default=None)
        if ult is None:
            continue
        cola = [(i, d) for i, d, _toc in info["saltos"] if i > ult]
        if cola:
            total_cola = sum(d for _i, d in cola)
            pct = 100.0 * total_cola / info["despues"] if info["despues"] else 0.0
            print(f"  {info['id']:<16}{len(cola)} punto(s)  "
                  f"+{formatear(total_cola):>10}  ({pct:.1f}% del total)  "
                  f"(último tocatierra {puntos[ult]['t']})")
            alguno = True
    if not alguno:
        print("  ninguno")

    print("\nAnomalías:")
    anomalias = []
    for info in informe:
        for i, delta, toc in info["saltos"]:
            if not toc and clasificar_salto(info["puntos"], i).startswith("ANOMALÍA"):
                anomalias.append(f"{info['id']}: +{formatear(delta)} en "
                                 f"{info['puntos'][i]['t']} antes de un tocatierra")
    for tid, primer_toc, v in avisos_generacion:
        anomalias.append(f"{tid}: {formatear(v)} acumulados antes del primer "
                         f"tocatierra {primer_toc} (valor inicial del génesis)")
    if anomalias:
        for a in anomalias:
            print(f"  {a}")
    else:
        print("  ninguna: escalera plana entre tocatierras y salto en cada uno; "
              "primer punto y totales intactos")

    if dry:
        print("\n(--dry-run: no se ha escrito nada)")
    else:
        print(f"\nescritas {len(rutas)} tormentas en {DIR_TORMENTAS}")
        print("validación OK: totales invariantes, primer punto intacto, "
              "series monótonas, muertes intactas, idempotencia (2 pasadas)")
        print("\nsha256 de los JSON escritos (debe repetirse en la 2ª corrida):")
        for nombre, h in hashes:
            print(f"  {h}  {nombre}")


if __name__ == "__main__":
    main()
