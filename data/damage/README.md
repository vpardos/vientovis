# Datasets diarios de impacto

Generado por `scripts/build_daily_impacts.py` (re-ejecutable, idempotente).

## Archivos

### `data/damage/nfip_daily_damage.csv` — daño de inundación asegurado por día

| columna | descripción |
|---|---|
| `storm` | tormenta, formato `Nombre AAAA` |
| `date` | fecha del siniestro (`YYYY-MM-DD`) |
| `claims` | cantidad de reclamos NFIP ese día |
| `building_damage_usd` | daño a la edificación, USD |
| `contents_damage_usd` | daño a contenidos, USD |

Fuente: OpenFEMA **NFIP Redacted Claims v3**, `https://www.fema.gov/api/open/v3/NfipClaims`.
Sin API key, ~2.7M registros, actualización mensual.

### `data/damage/nfip_storm_totals.csv` — totales y **conteo de completitud**

Trae `api_count` (lo que dice la API), `records_pulled` (lo que se bajó realmente)
y `complete` (yes/NO). **Revisar siempre `complete` antes de citar un total**: si
dice `NO`, el total es un piso, no el total.

### `data/impacts/storm_events_daily.csv` — muertes y daño por día

| columna | descripción |
|---|---|
| `storm`, `date` | tormenta y fecha |
| `events` | cuántos registros de evento contribuyen |
| `deaths_direct`, `deaths_indirect` | muertes directas e indirectas |
| `injuries_direct`, `injuries_indirect` | heridos |
| `damage_property_usd`, `damage_crops_usd` | daño a propiedad y cultivos |
| `states` | estados/zonas involucrados (separados por `|`) |

Fuente: NCEI **Storm Events Database**, archivos `details` por año,
`https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/`.

## Resultados (verificados)

### NFIP — daño diario (todos completos)

| tormenta | reclamos | edificaciones | contenidos |
|---|---|---|---|
| Katrina 2005 | 210,576 | $15,397.5M | $4,809.0M |
| Sandy 2012 | 142,555 | $7,867.8M | $1,140.4M |
| Harvey 2017 | 91,772 | $7,073.6M | $2,444.2M |
| Helene 2024 | 58,059 | $6,204.4M | $1,006.0M |
| Ike 2008 | 52,914 | $2,231.2M | $646.2M |
| Ian 2022 | 48,503 | $4,333.3M | $858.1M |
| Irma 2017 | 33,437 | $981.5M | $196.4M |
| Ida 2021 | 27,589 | $1,135.0M | $383.6M |
| Michael 2018 | 4,400 | $209.5M | $43.9M |
| Maria 2017 | 898 | $33.7M | $10.6M |

### Storm Events — muertes (todas las tormentas)

| tormenta | muertes totales | directas |
|---|---|---|
| Katrina 2005 | 1,004 | 1,004 |
| Helene 2024 | 184 | — |
| Ian 2022 | 146 | 126 |
| Sandy 2012 | 136 | 76 |
| Ida 2021 | 88 | 38 |
| Irma 2017 | 79 | 8 |
| Harvey 2017 | 78 | — |
| Ike 2008 | 60 | 35 |
| Michael 2018 | 59 | 15 |
| Maria 2017 | 20 | 20 |

## Advertencias metodológicas

1. **No existe daño ni muertes por hora.** `dateOfLoss` del NFIP siempre viene
   con hora `T00:00:00` (verificado en 10,000 registros: 100% medianoche). En
   Storm Events el campo `FAT_TIME` es `0` y `FATALITY_DATE` cae a `12:00:00`
   como placeholder en el **94.3%** de los 24,569 registros de 1980-2026.
   **La unidad mínima honesta es el DÍA** (y en Storm Events, la ventana del
   episodio con resolución de minuto para `BEGIN`/`END`).

2. **NFIP es solo inundación y solo asegurado.** No mide daño por viento ni
   pérdida total. Por eso Michael 2018 muestra $209M cuando su daño real fue
   ~$25B (fue un evento de viento). No usar NFIP como "el daño" de una tormenta.

3. **María 2017 tiene solo 898 reclamos NFIP pero $18.3B en Storm Events.**
   La diferencia es real: NFIP es inundación, y el daño de María en Puerto Rico
   fue principalmente viento. Las dos columnas no son comparables entre sí.

4. **Storm Events registra el daño por condado/zona.** La suma es correcta (los
   valores por fila son distintos y pequeños, no un total repetido) — verificado
   para María: 52 filas de municipios sumando $18.26B.

5. **El match por nombre en el narrative es frágil** y fue la fuente de dos bugs
   corregidos:
   - Substring suelto (`ian`) matchea `Canadian`, `Floridian`: metía ~5,000
     eventos de invierno a Ian 2022. Solución: `\b` (límite de palabra).
   - Exigir solo `"hurricane <nombre>"` pierde muertes reales que NOAA registra
     bajo el tipo de peligro (Flash Flood, Tornado): Harvey daba 13 muertes en
     vez de 78. Solución: aceptar el nombre con límite de palabra + contexto
     ciclónico o un tipo de peligro plausible (`HAZARD_TYPES`).
   El criterio vive en `build_storm_events()`; si se agrega una tormenta, revisar
   que los totales contra las cifras oficiales del NHC cuadren.

6. **`DEATHS_DIRECT` vs `DEATHS_INDIRECT` no es comparable entre años.** La
   convención cambió: Michael 2018 (8 directas / 44 indirectas) frente a Ian
   2022 (105 directas / 20 indirectas). Graficar solo "directas" hace ver a
   Michael como trivial. Usar la suma y decirlo.

## Reproducir

```bash
python3 scripts/build_daily_impacts.py
```

Requiere los archivos de Storm Events en
`~/.hermes/cache/scratch/se/` (se bajan de la URL de arriba). El script
re-escribe las tres salidas completas.
