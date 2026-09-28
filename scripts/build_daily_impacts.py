#!/usr/bin/env python3
"""Construye datasets diarios (daño y muertes) para los huracanes del proyecto.

Salidas:
  data/damage/nfip_daily_damage.csv   daño de inundación asegurado por día (NFIP)
  data/damage/nfip_storm_totals.csv   totales por tormenta + conteo real
  data/impacts/storm_events_daily.csv muertes y daño por día (NOAA Storm Events)

Fuentes:
  - OpenFEMA NFIP claims  https://www.fema.gov/api/open/v3/NfipClaims
  - NCEI Storm Events     https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/

Es idempotente: re-ejecutarlo reescribe las salidas.
"""
from __future__ import annotations

import csv
import glob
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

ROOT = "/home/ubuntu/Universidad/26-02/vientovis"
SE_DIR = "/home/ubuntu/.hermes/cache/scratch/se"
NFIP = "https://www.fema.gov/api/open/v3/NfipClaims"
UA = {"User-Agent": "vientovis-research/1.0"}

# Tormentas: ventana temporal y estados a considerar.
# El inicio se pone 1-3 días antes del landfall para capturar marejada previa.
STORMS = {
    "Katrina 2005":  (["LA", "MS", "AL", "FL"], "2005-08-25", "2005-09-05", 2005),
    "Ike 2008":      (["TX", "LA"],             "2008-09-10", "2008-09-18", 2008),
    "Sandy 2012":    (["NY", "NJ", "CT", "MD", "VA", "DE"], "2012-10-27", "2012-11-04", 2012),
    "Harvey 2017":   (["TX", "LA"],             "2017-08-24", "2017-09-03", 2017),
    "Irma 2017":     (["FL", "GA", "SC"],       "2017-09-08", "2017-09-16", 2017),
    "Maria 2017":    (["PR", "VI"],             "2017-09-16", "2017-10-05", 2017),
    "Michael 2018":  (["FL", "GA", "AL"],       "2018-10-08", "2018-10-16", 2018),
    "Ida 2021":      (["LA", "MS", "NJ", "NY", "PA"], "2021-08-27", "2021-09-05", 2021),
    "Ian 2022":      (["FL", "SC"],             "2022-09-26", "2022-10-04", 2022),
    "Helene 2024":   (["FL", "GA", "SC", "NC", "TN"], "2024-09-24", "2024-10-03", 2024),
}

# Palabras para reconocer cada tormenta en el narrative de Storm Events.
# (la definición real vive en build_storm_events() como regex con límite de
#  palabra; se mantiene aquí solo como referencia del criterio)
SE_MATCH = {
    "Katrina 2005": ["hurricane katrina", "tropical storm katrina"],
    "Ike 2008":     ["hurricane ike", "tropical storm ike"],
    "Sandy 2012":   ["hurricane sandy", "post-tropical cyclone sandy"],
    "Harvey 2017":  ["hurricane harvey", "tropical storm harvey"],
    "Irma 2017":    ["hurricane irma", "tropical storm irma"],
    "Maria 2017":   ["hurricane maria", "tropical storm maria"],
    "Michael 2018": ["hurricane michael", "tropical storm michael"],
    "Ida 2021":     ["hurricane ida", "tropical storm ida"],
    "Ian 2022":     ["hurricane ian", "tropical storm ian"],
    "Helene 2024":  ["hurricane helene", "tropical storm helene"],
}


def log(*a):
    print(*a, flush=True)


# --------------------------------------------------------------------------
# 1. NFIP: daño de inundación asegurado por día
# --------------------------------------------------------------------------
def nfip_url(flt, select, top, skip=0, orderby=None, count=False):
    # OJO: $metadata=false suprime el objeto metadata, y el conteo ($count=true)
    # vive DENTRO de metadata. Por eso no se puede pedir el conteo y silenciar
    # la metadata a la vez: la API devuelve solo los datos, sin 'count'.
    parts = [("$select", select), ("$top", str(top))]
    if not count:
        parts.append(("$metadata", "false"))
    if count:
        parts.append(("$count", "true"))
    if orderby:
        parts.append(("$orderby", orderby))
    if skip:
        parts.append(("$skip", str(skip)))
    parts.append(("$filter", flt))
    SAFE = "'(),-:."
    q = "&".join(f"{k}={urllib.parse.quote(str(v), safe=SAFE)}" for k, v in parts)
    return f"{NFIP}?{q}"


def nfip_get(url, tries=5):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode())
        except Exception as ex:
            if attempt == tries - 1:
                raise
            wait = 2 ** attempt
            log(f"    retry {attempt+1}/{tries} after {type(ex).__name__}: wait {wait}s")
            time.sleep(wait)


def build_nfip():
    log("=" * 70)
    log("NFIP: daño de inundación asegurado por día")
    log("=" * 70)
    select = "dateOfLoss,buildingDamageAmount,contentsDamageAmount,state,yearOfLoss"
    daily_rows, total_rows = [], []

    for storm, (states, start, end, year) in STORMS.items():
        st_clause = " or ".join(f"state eq '{s}'" for s in states)
        flt = (f"({st_clause}) and dateOfLoss ge '{start}T00:00:00.000Z' "
               f"and dateOfLoss le '{end}T23:59:59.000Z'")

        # conteo real primero, para saber cuántas páginas y no truncar
        try:
            meta = nfip_get(nfip_url(flt, "dateOfLoss", 1, count=True))
            total = meta["metadata"].get("count", 0)
        except Exception as ex:
            log(f"  {storm}: conteo falló ({type(ex).__name__}), se omite")
            total_rows.append((storm, "", "", "", "error"))
            continue

        day_claims = defaultdict(int)
        day_bldg = defaultdict(float)
        day_cont = defaultdict(float)
        got, skip = 0, 0
        while got < total:
            try:
                d = nfip_get(nfip_url(flt, select, 10000, skip, orderby="dateOfLoss"))
            except Exception as ex:
                log(f"    página en skip={skip} falló: {type(ex).__name__}")
                break
            rows = d.get("NfipClaims", [])
            if not rows:
                break
            for r in rows:
                day = (r.get("dateOfLoss") or "")[:10]
                if not day:
                    continue
                day_claims[day] += 1
                if r.get("buildingDamageAmount"):
                    day_bldg[day] += r["buildingDamageAmount"]
                if r.get("contentsDamageAmount"):
                    day_cont[day] += r["contentsDamageAmount"]
            got += len(rows)
            skip += len(rows)
            if len(rows) < 10000:
                break

        tb = sum(day_bldg.values())
        tc = sum(day_cont.values())
        for day in sorted(set(day_claims) | set(day_bldg)):
            daily_rows.append({
                "storm": storm, "date": day,
                "claims": day_claims.get(day, 0),
                "building_damage_usd": round(day_bldg.get(day, 0.0), 2),
                "contents_damage_usd": round(day_cont.get(day, 0.0), 2),
            })
        complete = "yes" if got >= total else "NO"
        total_rows.append((storm, total, got, round(tb, 2), round(tc, 2), complete))
        log(f"  {storm:15s} claims={got:7d}/{total:<7d} complete={complete:3s} "
            f"bldg=${tb/1e6:9,.1f}M cont=${tc/1e6:8,.1f}M")

    # escribir
    out1 = os.path.join(ROOT, "data/damage/nfip_daily_damage.csv")
    os.makedirs(os.path.dirname(out1), exist_ok=True)
    daily_rows.sort(key=lambda r: (r["storm"], r["date"]))
    with open(out1, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["storm", "date", "claims",
                                           "building_damage_usd", "contents_damage_usd"])
        w.writeheader()
        w.writerows(daily_rows)

    out2 = os.path.join(ROOT, "data/damage/nfip_storm_totals.csv")
    with open(out2, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["storm", "api_count", "records_pulled", "building_damage_usd",
                    "contents_damage_usd", "complete"])
        w.writerows(total_rows)

    log(f"\n  -> {out1}  ({len(daily_rows)} filas)")
    log(f"  -> {out2}  ({len(total_rows)} filas)")
    return daily_rows, total_rows


# --------------------------------------------------------------------------
# 2. Storm Events: muertes y daño por día
# --------------------------------------------------------------------------
def num(v):
    try:
        return int(float(v or 0))
    except (TypeError, ValueError):
        return 0


def parse_se_date(s):
    """'28-SEP-22 14:05:00' -> '2022-09-28'"""
    try:
        dd, mon, rest = s.split("-", 2)
        yy = rest.split(" ")[0]
        mm = {"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05",
              "JUN": "06", "JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10",
              "NOV": "11", "DEC": "12"}[mon[:3].upper()]
        year = int(yy) + (2000 if int(yy) < 70 else 1900)
        return f"{year}-{mm}-{int(dd):02d}"
    except Exception:
        return None


def money(v):
    """'5.00K' / '1.2M' / '250' -> float USD"""
    if v is None:
        return 0.0
    s = str(v).strip().upper()
    if not s or s in ("0", ""):
        return 0.0
    try:
        if s.endswith("K"):
            return float(s[:-1]) * 1e3
        if s.endswith("M"):
            return float(s[:-1]) * 1e6
        if s.endswith("B"):
            return float(s[:-1]) * 1e9
        return float(s)
    except ValueError:
        return 0.0


def build_storm_events():
    log("\n" + "=" * 70)
    log("Storm Events: muertes y daño por día")
    log("=" * 70)
    # Criterio de match. Dos problemas opuestos:
    #   a) substring suelto ('ian') -> falsos positivos masivos
    #      ('Canadian', 'Floridian'); Ian 2022 metía ~5000 eventos de invierno.
    #   b) exigir solo "<tipo> <nombre>" -> se pierden muertes reales que NOAA
    #      registra bajo el tipo de peligro (Flash Flood, Tornado), no bajo
    #      "Hurricane". Harvey 2017: 13 muertes (estricto) vs 78 (real).
    # Solución: aceptar la mención del nombre con límite de palabra Y
    # (a) el nombre va precedido de un término de ciclón, o
    # (b) el evento es de un tipo/estado que la tormenta realmente afectó.
    # Se exige límite de palabra para evitar 'Canadian'/'Floridian'.
    SE_MATCH = {
        "Katrina 2005": r"\bkatrina\b",
        "Ike 2008":     r"\bike\b",
        "Sandy 2012":   r"\bsandy\b",
        "Harvey 2017":  r"\bharvey\b",
        "Irma 2017":    r"\birma\b",
        "Maria 2017":   r"\bmaria\b",
        "Michael 2018": r"\bmichael\b",
        "Ida 2021":     r"\bida\b",
        "Ian 2022":     r"\bian\b",
        "Helene 2024":  r"\bhelene\b",
    }
    SE_RE = {k: re.compile(v, re.I) for k, v in SE_MATCH.items()}
    # término de ciclón cerca del nombre -> casi siempre es la tormenta
    TROPICAL_CTX = re.compile(
        r"\b(hurricane|tropical storm|tropical cyclone|post-tropical|"
        r"typhoon|cyclone|depression)\b", re.I)
    # tipos de peligro que la tormenta produce; fuera de estos no cuenta
    HAZARD_TYPES = {
        "Flash Flood", "Flood", "Coastal Flood", "Storm Surge/Tide", "High Surf",
        "Hurricane (Typhoon)", "Tropical Storm", "High Wind", "Strong Wind",
        "Thunderstorm Wind", "Tornado", "Heavy Rain", "Marine High Wind",
        "Marine Thunderstorm Wind", "Debris Flow", "Landslide", "Rip Current",
    }
    # ventana de fechas holgada por tormenta para el match contextual
    LOOSE = {
        "Katrina 2005":  ("2005-08-24", "2005-09-05"),
        "Ike 2008":      ("2008-09-09", "2008-09-20"),
        "Sandy 2012":    ("2012-10-26", "2012-11-05"),
        "Harvey 2017":   ("2017-08-23", "2017-09-05"),
        "Irma 2017":     ("2017-09-07", "2017-09-18"),
        "Maria 2017":    ("2017-09-15", "2017-10-06"),
        "Michael 2018":  ("2018-10-07", "2018-10-18"),
        "Ida 2021":      ("2021-08-26", "2021-09-07"),
        "Ian 2022":      ("2022-09-25", "2022-10-05"),
        "Helene 2024":   ("2024-09-23", "2024-10-05"),
    }
    years = sorted({v[3] for v in STORMS.values()})
    daily = defaultdict(lambda: {"deaths_direct": 0, "deaths_indirect": 0,
                                 "injuries_direct": 0, "injuries_indirect": 0,
                                 "damage_property_usd": 0.0, "damage_crops_usd": 0.0,
                                 "events": 0, "states": set()})
    per_storm = defaultdict(lambda: defaultdict(int))

    for year in years:
        g = glob.glob(f"{SE_DIR}/StormEvents_details*{year}*.csv.gz")
        if not g:
            log(f"  {year}: sin archivo de details, se omite")
            continue
        with gzip.open(g[0], "rt", encoding="utf-8", errors="replace") as fh:
            rows = list(csv.DictReader(fh))
        log(f"  {year}: {len(rows)} eventos cargados")

        for r in rows:
            narr = ((r.get("EPISODE_NARRATIVE") or "") + " " +
                    (r.get("EVENT_NARRATIVE") or ""))
            if not narr:
                continue
            for storm, rx in SE_RE.items():
                if STORMS[storm][3] != year:
                    continue
                if not rx.search(narr):
                    continue
                day = parse_se_date(r.get("BEGIN_DATE_TIME") or "")
                if not day:
                    continue
                lo_start, lo_end = LOOSE[storm]
                if not (lo_start <= day <= lo_end):
                    continue
                # exigir contexto ciclónico o un tipo de peligro que la
                # tormenta realmente produce (evita 'Idaho' por 'ida',
                # 'Canadian' por 'ian', tormentas de invierno, etc.)
                et = r.get("EVENT_TYPE") or ""
                if not (TROPICAL_CTX.search(narr) or et in HAZARD_TYPES):
                    continue
                # ventana de la tormenta
                _, start, end, _ = STORMS[storm]
                if not (start <= day <= end):
                    continue
                k = (storm, day)
                d = daily[k]
                d["deaths_direct"] += num(r.get("DEATHS_DIRECT"))
                d["deaths_indirect"] += num(r.get("DEATHS_INDIRECT"))
                d["injuries_direct"] += num(r.get("INJURIES_DIRECT"))
                d["injuries_indirect"] += num(r.get("INJURIES_INDIRECT"))
                d["damage_property_usd"] += money(r.get("DAMAGE_PROPERTY"))
                d["damage_crops_usd"] += money(r.get("DAMAGE_CROPS"))
                d["events"] += 1
                d["states"].add(r.get("STATE"))
                per_storm[storm]["deaths"] += num(r.get("DEATHS_DIRECT")) + num(r.get("DEATHS_INDIRECT"))
                break

    out = os.path.join(ROOT, "data/impacts/storm_events_daily.csv")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    keys = sorted(daily)
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["storm", "date", "events", "deaths_direct", "deaths_indirect",
                    "injuries_direct", "injuries_indirect", "damage_property_usd",
                    "damage_crops_usd", "states"])
        for (storm, day) in keys:
            d = daily[(storm, day)]
            w.writerow([storm, day, d["events"], d["deaths_direct"], d["deaths_indirect"],
                        d["injuries_direct"], d["injuries_indirect"],
                        round(d["damage_property_usd"], 2),
                        round(d["damage_crops_usd"], 2),
                        "|".join(sorted(s for s in d["states"] if s))])

    log(f"\n  -> {out}  ({len(keys)} filas)")
    log("\n  muertes totales por tormenta (Storm Events):")
    for storm in STORMS:
        n = per_storm[storm]["deaths"]
        flag = "" if n else "   <- sin match"
        log(f"    {storm:15s} {n:5d}{flag}")
    return daily


if __name__ == "__main__":
    t0 = time.time()
    build_nfip()
    build_storm_events()
    log(f"\nlisto en {time.time()-t0:.0f}s")
