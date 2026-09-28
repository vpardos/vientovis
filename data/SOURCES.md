# Fuentes de datos

Descargado el 2026-09-28. Verificar URLs antes de re-descargar: los productos del NHC
se publican con fecha en el nombre (`-091226` = 12 sep 2026) y las versiones nuevas
reemplazan a las viejas.

## Huracanes

### HURDAT2 — mejor trayectoria (best track)

- Archivo: `data/hurricanes/hurdat2-1851-2025-091226.txt`
- Fuente: https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2025-091226.txt
- Directorio (vintages anteriores/nuevos): https://www.nhc.noaa.gov/data/hurdat/
- Especificación del formato: https://www.nhc.noaa.gov/data/hurdat/hurdat2-format-atlantic.pdf
- Cobertura: 1851–2025, cuenca Atlántica (incluye Golfo de México y Caribe). 1988 tormentas.
- Columnas por registro: fecha, hora, identificador de registro, estado, lat, lon,
  viento máx (kt), presión mín (mb), y 4 radios de viento (34/50/64 kt) en 4 cuadrantes.

Notas de uso:

- **Identificador de registro `L` = tocamientos de tierra (landfall).**
  Hay 1213 registros `L` en el archivo completo — es el filtro directo para "tocamientos".
- Los **radios de viento** son lo que convierte una trayectoria en un *corredor*
  (huella de extensión). Ojo: vienen como `-999` (dato faltante) en la mayoría de los
  registros previos a ~1990, así que el trabajo por corredores empuja hacia tormentas
  modernas (1990+).
- **Los nombres se repiten entre décadas.** `KATRINA` existe en 1981, 1999 y 2005;
  `HARVEY` en 1981, 1993, 1999, 2005, 2011 y 2017. Filtrar SIEMPRE por ID completo
  (`AL122005`), nunca por nombre, o se mezclan tormentas distintas.
- Formato del ID: `AL` + número de tormenta (2 dígitos) + año (4 dígitos).

IDs de las tormentas icónicas:

- Camille 1969 — `AL091969`
- Andrew 1992 — `AL041992`
- Katrina 2005 — `AL122005`
- Ike 2008 — `AL092008`
- Sandy 2012 — `AL182012`
- Harvey 2017 — `AL092017`
- Irma 2017 — `AL112017`
- Maria 2017 — `AL152017`
- Michael 2018 — `AL142018`

### Reportes post-temporada del NHC (TCR) — muertes, daños, tocamientos

- Índice: `data/hurricanes/TCR_StormReportsIndex.xml`
- Fuente del índice: https://www.nhc.noaa.gov/TCR_StormReportsIndex.xml
- Portal: https://www.nhc.noaa.gov/data/tcr/index.php
- El índice tiene 1538 entradas (1080 con URL directa a PDF). Campos por entrada:
  `StormName`, `StormReportURL`, `Year`, `Basin`.
- Los TCR son la fuente de las cifras de **muertes y daños** (los daños vienen como
  estimación en USD, con desglose por país/estado).

PDFs directos (todos verificados 200 OK):

- Katrina 2005 — https://www.nhc.noaa.gov/data/tcr/AL122005_Katrina.pdf
- Harvey 2017 — https://www.nhc.noaa.gov/data/tcr/AL092017_Harvey.pdf
- Maria 2017 — https://www.nhc.noaa.gov/data/tcr/AL152017_Maria.pdf
- Irma 2017 — https://www.nhc.noaa.gov/data/tcr/AL112017_Irma.pdf
- Sandy 2012 — https://www.nhc.noaa.gov/data/tcr/AL182012_Sandy.pdf
- Michael 2018 — https://www.nhc.noaa.gov/data/tcr/AL142018_Michael.pdf
- Ike 2008 — https://www.nhc.noaa.gov/data/tcr/AL092008_Ike.pdf

**Tormentas previas a 1985 no tienen PDF**: usan páginas de archivo (storm wallets).

- Camille 1969 — https://www.nhc.noaa.gov/archive/storm_wallets/atlantic/atl1969-prelim/camille/
- Andrew 1992 — https://www.nhc.noaa.gov/1992andrew.html

### Muertes y daños en formato tabular

En lugar de extraer de los PDF, usar el NCEI Billion-Dollar Weather & Climate Disasters:

- https://www.ncei.noaa.gov/access/billions/ — CSV/JSON por evento con muertes,
  heridos y costo (nominal y ajustado por inflación, método CPI).

## Población

### Censo de EE.UU. por condado (recomendado)

- Archivo: `data/population/co-est2024-alldata.csv`
- Fuente: https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/totals/co-est2024-alldata.csv
- Directorio (todos los vintages): https://www2.census.gov/programs-surveys/popest/datasets/
- 1.77 MB, sin necesidad de API key. Columnas clave: `STNAME`, `CTYNAME`,
  `POPESTIMATE2020`…`POPESTIMATE2024`, más nacimientos, muertes y migración.
- Es una **descarga masiva directa** — no requiere clave, a diferencia de la API.

Ojo con la API del Censo: `api.census.gov` ahora **exige clave** (devuelve
"Missing Key" sin ella). Registro gratuito: https://api.census.gov/data/key_signup.html
El CSV masivo de arriba no la necesita, por eso es la vía recomendada.

### Población en grillas (elegir según lo que se necesite)

- **GHSL GHS-POP (EU JRC)** — gratis, sin login, la más permisiva de las tres.
  Portal: https://ghsl.jrc.ec.europa.eu/download.php — releases R2023/R2024,
  100 m a 1 km, incluye cobertura de EE.UU.
- **WorldPop** — gratis, sin login, rasters de EE.UU. 2000–2020.
  API REST: https://hub.worldpop.org/rest/data/pop/wpgp (devuelve JSON con el
  listado de archivos por país). Útil si se quiere GeoTIFF crudo sin portal.
- **SEDAC GPW v4** — gratis pero exige login de NASA Earthdata para descargar:
  https://sedac.ciesin.columbia.edu/data/set/gpw-v4-population-count-rev11/data-download
  (doi.org/10.7927/H4PN93PB)
- **LandScan (ORNL)** — **NO es abierto.** Portal JS en https://landscan.ornl.gov/
  que requiere solicitud de licencia aprobada; acceso restringido. Para población
  ambiente a 1 km, GHSL y WorldPop dan datos equivalentes sin trámite.

## Unir trayectorias con población

HURDAT2 da lat/lon cada 6 horas por tormenta, así que hay que **interpolar la
trayectoria** entre registros y después:

- opción condado: sumar poblaciones de condados cuyos centroides/costa caigan dentro
  de un buffer sobre los radios de viento; o
- opción grilla: estadística zonal de los rasters contra ese buffer.

Los totales por condado son administrativos y exactos pero gruesos; los rasters dan
precisión en la franja costera pero requieren estadística zonal.
