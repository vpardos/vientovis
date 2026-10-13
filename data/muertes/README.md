# Muertes verificadas por tormenta — fuente y método

Generado: 2026-10-13 · Autor del análisis: Jarvis (agente) para el proyecto `vientovis`

## El problema que resuelve este directorio

El CSV `notebooks/hurricanes_unido.csv` toma las muertes de **NOAA Storm Events**
agregadas por día. Storm Events **solo registra muertes en EE. UU.** y, además, su
recuento es el de las declaraciones locales, sin la revisión post-temporada.

Consecuencia: la página mostraba **1 854 muertes** en total, cuando las cifras
oficiales del NHC suman **~5 631**. El caso extremo es María: la página mostraba
**20** muertes y el propio informe oficial del NHC dice **2 975** solo en
Puerto Rico.

| Tormenta | Antes (Storm Events) | Verificado (NHC) | Diferencia |
|---|---:|---:|---:|
| María 2017 | 20 | 3 022 | +3 002 |
| Katrina 2005 | 1 004 | 1 392 | +388 |
| Ike 2008 | 60 | 195 | +135 |
| Sandy 2012 | 136 | 234 | +98 |
| Helene 2024 | 184 | 250 | +66 |
| Irma 2017 | 79 | 128 | +49 |
| Harvey 2017 | 78 | 103 | +25 |
| Ian 2022 | 146 | 156 | +10 |
| Michael 2018 | 59 | 59 | 0 |
| Ida 2021 | 88 | 87 | −1 |
| **TOTAL** | **1 854** | **5 626** | **+3 772** |

## De dónde salen las cifras

**Fuente principal: los Tropical Cyclone Report (TCR) del NHC** — la revisión
post-temporada oficial de cada tormenta. Son la misma fuente que ya cita
`data/SOURCES.md` para muertes y daños, así que no se introduce una fuente nueva.

Todos los PDF se descargaron y se leyeron (`data/muertes/` documenta cada URL).
Los TCR separan **muertes directas** (por el propio fenómeno: ahogamiento en la
marejada, viento, lluvia) de las **indirectas** (infartos, incendios,
electrocución, accidentes durante la limpieza, falta de atención médica).

| Tormenta | Directas | Indirectas | Total | Nota |
|---|---:|---:|---:|---|
| Katrina 2005 | 520 | 565 | **1 392** | +307 de causa indeterminada (Rappaport 2014; Rappaport & Blanchard 2016) |
| Ike 2008 | 103 | ~92 | **195** | 103 directas (74 en Haití) + hasta 64 indirectas en Texas + ≥28 en el valle del Ohio |
| Sandy 2012 | 147 | 87 | **234** | El TCR da 147 directas y 87 indirectas en EE. UU. |
| Harvey 2017 | 68 | ~35 | **103** | TCR: 68 directas en Texas + «about 35» indirectas |
| Irma 2017 | 46 | 82 | **128** | 46 directas en todo el Caribe/EE. UU. + 82 indirectas en EE. UU. |
| María 2017 | — | — | **3 022** | Puerto Rico 2 975 (directas+indirectas, estudio GWU 2018) + 47 en el resto del Caribe y EE. UU. |
| Michael 2018 | 16 | 43 | **59** | EE. UU.; el TCR da 16 directas + 43 indirectas |
| Ida 2021 | 55 | 32 | **87** | EE. UU.; 55 directas + 32 indirectas |
| Ian 2022 | 66 | 90 | **156** | EE. UU.; el TCR añade 5 muertes más en Cuba |
| Helene 2024 | 175 | 75 | **250** | El TCR da el total: «at least 250 fatalities (including at least 175 direct deaths)» |

### URLs de los informes (verificados, HTTP 200)

- Katrina 2005 — <https://www.nhc.noaa.gov/data/tcr/AL122005_Katrina.pdf>
- Ike 2008 — <https://www.nhc.noaa.gov/data/tcr/AL092008_Ike.pdf>
- Sandy 2012 — <https://www.nhc.noaa.gov/data/tcr/AL182012_Sandy.pdf>
- Harvey 2017 — <https://www.nhc.noaa.gov/data/tcr/AL092017_Harvey.pdf>
- Irma 2017 — <https://www.nhc.noaa.gov/data/tcr/AL112017_Irma.pdf>
- María 2017 — <https://www.nhc.noaa.gov/data/tcr/AL152017_Maria.pdf>
- Michael 2018 — <https://www.nhc.noaa.gov/data/tcr/AL142018_Michael.pdf>
- Ida 2021 — <https://www.nhc.noaa.gov/data/tcr/AL092021_Ida.pdf>
- Ian 2022 — <https://www.nhc.noaa.gov/data/tcr/AL092022_Ian.pdf>
- Helene 2024 — <https://www.nhc.noaa.gov/data/tcr/AL092024_Helene.pdf>

Cita sugerida: *NOAA National Hurricane Center, Tropical Cyclone Reports
(consultados en octubre de 2026).*

## Cómo se reparte en el tiempo (`scripts/distribuir_muertes.py`)

El total es verificado (NHC); lo que se reconstruye es **cuándo** ocurrió. Tres casos:

**1. Ocho tormentas — dato real, víctima por víctima.**
NOAA publica un fichero de **víctimas individuales** (`StormEvents_fatalities`), una
fila por fallecido con su fecha. Da la distribución diaria real de Ike, Sandy,
Harvey, Irma, Michael, Ida, Ian y Helene. Lo extrae
`scripts/extraer_muertes_diarias.py`.

Dos trampas que costaron un intento cada una:

- **Las muertes NO están en eventos de tipo «Hurricane».** En Sandy están en
  eventos de «High Wind», «Coastal Flood», «Rip Current»... Filtrar por tipo de
  evento perdía casi todas.
- **La fecha sola tampoco sirve.** Una ventana amplia de octubre-diciembre
  capturaba ventiscas y aludes ajenos y disparaba el recuento.

La clave correcta es el **`EPISODE_ID`**: el NWS agrupa los eventos de una misma
situación en un episodio cuyo relato nombra la tormenta. También hay que buscar
solo el nombre: los relatos alternan «Hurricane Helene», «Tropical Storm Helene»,
«Remnants of Hurricane Helene»... y exigir «Hurricane X» dejaba a Helene en el
11 % de cobertura.

**2. Katrina — modelo documentado.**
Storm Events no sirve: Luisiana declaró sus muertes **en bloque** (982 de las
1 004 en una sola fecha), y el fichero de eventos tiene el mismo problema. Se usa
un **decaimiento desde el fallo de los diques (29 ago 2005)**, coherente con lo
documentado (el grueso de las muertes ocurrió en los días siguientes a la
inundación de Nueva Orleans). Es una reconstrucción, no un dato observado.

**3. María — solo los días activos (302, no 3 022).**
Puerto Rico apenas registró muertes en Storm Events (20 de 2 975). El total
verificado de 3 022 es un **exceso de mortalidad de seis meses** (sep 2017 –
feb 2018) del estudio de la **Universidad George Washington** (Santos-Burgoa et
al., *Lancet Planetary Health* 2018): sep 574 · oct 697 · nov 348 · dic 479 ·
ene 558 · feb 320.

Ese periodo es mucho más largo que la línea de tiempo de la app, que solo cubre
el recorrido de la tormenta (16 sep – 2 oct). **Decisión tomada: la página muestra
solo las muertes de los días activos**, no las de los seis meses:

- **Puerto Rico**: la tasa diaria media de cada mes del estudio (sep 574/30,
  oct 697/31) aplicada a los días activos **desde el tocatierra en Yabucoa
  (20 sep)**. Antes del impacto no hubo exceso de mortalidad en la isla.
- **Resto del Caribe y EE. UU.**: las **47** muertes que el TCR sí sitúa en días
  concretos (Dominica 31 el 19 sep, Guadalupe 2, St. Thomas 2, República
  Dominicana 5, Haití 3, EE. UU. 4), en esos días.

Total que muestra la página: **302**. Las 2 720 restantes corresponden a meses en
que la tormenta ya no estaba activa y no caben en la línea de tiempo.

⚠️ **Consecuencia importante:** con 302 muertes, **María deja de ser la tormenta
más mortífera del proyecto** y Katrina (1 392) pasa al primer puesto. No es un
error de cálculo: se están comparando cosas distintas. El total de María es una
estimación de exceso de mortalidad de seis meses; el de Katrina es un recuento de
muertes atribuidas a la tormenta. Si en la presentación se comparan mortalidades
entre tormentas, **hay que decir cuál de las dos cifras de María se está usando**,
porque 302 y 3 022 son ambas correctas y significan cosas distintas.

## Cuándo aparece cada salto: alineado con el tocatierra

Las fechas de muertes de NOAA son **días locales y no traen hora**. Al principio
cada día se acumulaba a las 00:00Z, así que el salto de muertes aparecía *antes*
del tocatierra que lo había causado: en Sandy, 120 muertes a las 00:00Z del 29 de
octubre, cuando el tocatierra en Nueva Jersey fue a las **23:30Z** de ese mismo
día — casi 24 h antes.

`convertir_dataset.py` ahora acumula los impactos de cada fecha **en el punto
exacto del tocatierra** que dibuja la app (`data/notas-tocatierras.json`); si la
fecha no tiene ninguno, en su primer punto. Verificado tormenta por tormenta:

| Tormenta | Salto de muertes | En el tocatierra |
|---|---|---|
| Sandy | +120 | `2012-10-29T23:30Z` Brigantine/Atlantic City |
| Katrina | +624 | `2005-08-29T11:10Z` Buras, Luisiana |
| Michael | +54 | `2018-10-10T17:30Z` Florida |
| Ian | +19 / +113 / +5 | Cuba, Florida, Carolina del Sur |
| Helene | +235 | `2024-09-27T03:10Z` Florida |
| María | +33 / +19 | Dominica, Yabucoa |

Hay que usar los tocatierras **curados**, no solo la columna de HURDAT2: HURDAT2
marca como tocatierra puntos que la app no dibuja (Ian tiene uno a las 02:00Z del
28 sep, mientras el tocatierra real en Florida es a las 19:05Z) y las muertes
caían en el punto equivocado.

### Cobertura (por qué los totales no cuadran con Storm Events)

Storm Events solo cubre **EE. UU.** y subregistra. La forma diaria es buena; el
total no. Por eso se reescala al total del NHC. Ver `diagnostico.txt`.

## Advertencias de método (importante)

1. **El reparto diario de Katrina es un modelo y el de María una estimación; en
   las otras ocho tormentas sí es dato real, víctima por víctima.** Además, en
   María el total de la página (302) es solo la parte que cae en los días activos,
   no el total verificado (3 022).

2. **Los fallecimientos posteriores al final del recorrido se pliegan en la última
   fecha disponible.** La línea de tiempo de la app solo llega hasta donde llega
   la trayectoria, así que las muertes indirectas de los días siguientes (por
   ejemplo las de Sandy hasta el 9 de noviembre) se acumulan en el último punto.
   Son colas pequeñas (Sandy 13 %, Ian 6 %), pero existen.

3. **«Sin identificar» no es cero.** En Katrina, 307 muertes quedaron sin
   clasificar como directas o indirectas; se suman al total pero no a ninguna de
   las dos columnas.

4. **Las cifras siguen revisándose.** Los TCR se actualizan (el de Helene ya lleva
   dos correcciones). Al re-descargar, comprobar que el PDF no tenga una versión
   más nueva.

5. **Rango vs. punto.** En varios informes el NHC dice «at least» / «about». Aquí
   se toma el valor puntual citado y se documenta el rango en la columna `nota`.

6. **Los daños se acumulan en el mismo punto que las muertes.** La alineación con
   el tocatierra se aplica a las dos series, así que la curva de daños también
   salta en el tocatierra en vez de a las 00:00Z. Antes saltaba a medianoche.
