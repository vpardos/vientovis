# Daños verificados por tormenta — fuente y método

Generado: 2026-10-13 · Autor del análisis: Jarvis (agente) para el proyecto `vientovis`

## El problema que resuelve este directorio

El CSV tomaba los daños de **NOAA Storm Events** (`damage_property_usd` +
`damage_crops_usd`). Esa fuente tiene dos defectos, los mismos que ya aparecieron con
las muertes:

1. **Solo cubre EE. UU.** Una tormenta que devastó varias islas antes de llegar al
   continente aparece con los daños del continente y **nada en las islas**.
2. **Subestima gravemente.** Es la estimación rápida del informe de eventos, no la
   revisión post-temporada.

| Tormenta | Antes (Storm Events) | Verificado (NHC) | Diferencia |
|---|---:|---:|---:|
| Katrina 2005 | 33 598 M$ | **125 000 M$** | ×3,7 |
| Harvey 2017 | 51 319 M$ | **125 000 M$** | ×2,4 |
| Ian 2022 | 16 447 M$ | **112 900 M$** | ×6,9 |
| María 2017 | 18 264 M$ | **91 430 M$** | ×5,0 |
| Helene 2024 | 11 334 M$ | **78 700 M$** | ×6,9 |
| Ida 2021 | 13 254 M$ | **75 250 M$** | ×5,7 |
| Irma 2017 | 4 654 M$ | **53 095 M$** | ×11,4 |
| Sandy 2012 | 25 250 M$ | **52 880 M$** | ×2,1 |
| Ike 2008 | 16 991 M$ | **33 145 M$** | ×2,0 |
| Michael 2018 | 15 849 M$ | **25 000 M$** | ×1,6 |

## De dónde salen las cifras

De los **Tropical Cyclone Report (TCR) del NHC**, la misma fuente que las muertes.
Los informes dan el total y, cuando la tormenta afectó a varios países, **el desglose
por isla o país**. Eso es lo que permite que cada tocatierra tenga sus daños.

### Totales y desglose

| Tormenta | Total | Composición |
|---|---:|---|
| Katrina 2005 | 125 000 M$ | EE. UU., dólares de 2005 (NCEI); intervalo 97 400–145 500 M$ |
| Harvey 2017 | 125 000 M$ | EE. UU. (NCEI); intervalo 90 000–160 000 M$ |
| Ian 2022 | 112 900 M$ | EE. UU. (NCEI); intervalo 86 800–135 900 M$ |
| María 2017 | 91 430 M$ | Puerto Rico + Islas Vírgenes EE.UU. **90 000** + Dominica **1 310** + Guadalupe **120** |
| Helene 2024 | 78 700 M$ | EE. UU. (NCEI) |
| Ida 2021 | 75 250 M$ | EE. UU. **75 000** + Cuba **250** |
| Irma 2017 | 53 095 M$ | EE. UU. **50 000** + San Martín **1 500** + Islas Vírgenes **500** + San Bartolomé **480** + Barbuda **225** + Cuba **200** + Anguila **190** |
| Sandy 2012 | 52 880 M$ | EE. UU. **50 000** + Cuba **2 000** + Haití **750** + Jamaica **100** + Rep. Dominicana **30** |
| Ike 2008 | 33 145 M$ | EE. UU. **29 520** + Cuba **3 500** + Bahamas/Turcas y Caicos **125** |
| Michael 2018 | 25 000 M$ | EE. UU.: Florida 18 400 + Georgia 4 700 + resto 1 100 |

Citas literales destacadas:

- **María**: «the estimated damage total in Dominica is **at least $1.31 billion**» ·
  «An estimated **$120 million** in damage was reported for Guadeloupe» ·
  «The NOAA estimate of damage in Puerto Rico and the U.S. Virgin Islands due to Maria
  is **90 billion dollars**, with a 90% confidence range of +/-$25.0 billion».
- **Sandy**: «Preliminary **U.S.** damage estimates are near **$50 billion**» · Cuba
  «Total losses are estimated at **$2 billion**» · Jamaica «about **$100 million**» ·
  Haití «**over $750 million**».
- **Ike**: «Using these preliminary figures, total damage is estimated at about
  **$29.52 billion** dollars» — y el propio informe aclara que eso «suggest that Ike is
  the second costliest hurricane to affect the **United States**», así que Cuba y las
  Turcas van aparte.

### URLs de los informes

Las mismas que en `../muertes/README.md` (`https://www.nhc.noaa.gov/data/tcr/<ID>.pdf`).

## Qué NO se inventa

Donde el informe dice explícitamente que **no hay cifra**, se deja a cero y se
documenta:

- **Ian en Cuba**: «At the time of this report, there is **no monetary damage estimate
  available for Cuba**». El tocatierra cubano del 27 de septiembre queda sin importe.
- **Katrina en Florida**: el informe describe daños en Miami-Dade pero no da una cifra
  separada; el total de 125 000 M$ es de EE. UU. en conjunto.

Es preferible un cero documentado a un número inventado.

## Cómo se reparte en el tiempo (`scripts/distribuir_danos.py`)

1. **Importes con lugar documentado** → se fijan en la fecha de su tocatierra. Así
   María tiene los 1 310 M$ de Dominica **en el tocatierra de Dominica** (19 sep), que
   antes no aparecían en ninguna parte.
2. **El resto** (casi siempre el grueso de EE. UU., sin desglose por estado en el
   informe) → se reparte **según la forma diaria real de Storm Events**, reescalada.
3. **Si esa forma no sirve** —María solo tiene un día con dato— → se reparte con un
   **decaimiento desde el último tocatierra** (τ = 4 días), que es como se acumulan los
   daños: destrucción de golpe y pérdidas que se van sumando.

Igual que con las muertes, cada importe se acumula **en el punto del tocatierra** de su
fecha, no a las 00:00Z, así que la curva salta en el marcador.

### Cobertura resultante

**Ningún día de tocatierra se queda sin daños** (0 de 23). Los segundos tocatierras que
caen el mismo día que otro acumulan en el primero de ese día, porque el convertidor
acumula una sola vez por fecha.

## Ajuste por inflación — dólares de 2024

Los totales de los TCR son **dólares nominales del año del evento**. Para que las
tormentas de 2005–2024 se comparen en poder de compra común, `distribuir_danos.py`
las re-escala a **dólares de 2024** con el **CPI-U** (índice de precios al consumidor
de EE. UU., promedio anual, serie CUUR0000SA0, base 1982-84 = 100, BLS; valores en
`data/SOURCES.md`). El desglose por país se ajusta con el mismo factor del año, así
cada tocatierra conserva su proporción exacta.

| Tormenta | Total nominal (TCR) | Factor | Total en USD 2024 |
|---|---:|---:|---:|
| Katrina 2005 | 125 000 M$ | ×1,6062 | **200 774 M$** |
| Harvey 2017 | 125 000 M$ | ×1,2797 | **159 967 M$** |
| Ian 2022 | 112 900 M$ | ×1,0719 | **121 014 M$** |
| María 2017 | 91 430 M$ | ×1,2797 | **117 006 M$** |
| Ida 2021 | 75 250 M$ | ×1,1577 | **87 113 M$** |
| Helene 2024 | 78 700 M$ | ×1,0000 | 78 700 M$ |
| Sandy 2012 | 52 880 M$ | ×1,3663 | **72 249 M$** |
| Irma 2017 | 53 095 M$ | ×1,2797 | **67 948 M$** |
| Ike 2008 | 33 145 M$ | ×1,4570 | **48 291 M$** |
| Michael 2018 | 25 000 M$ | ×1,2492 | **31 231 M$** |

Consecuencia visible: Katrina y Harvey **dejaban de empatar** en daños —en poder de
compra real, Katrina es con diferencia la tormenta más costosa del set—. El nominal
y el factor de cada tormenta quedan en las columnas `danos_total_usd_nominal` y
`factor_inflacion` de `danos_verificados.csv`.

## Advertencias de método (importante)

1. **Los importes del TCR son dólares nominales del año del evento; el pipeline los
   ajusta a dólares de 2024 con el CPI-U** (ver la sección anterior). La app muestra
   el total ajustado. Los datasets crudos de referencia (`data/damage`, `data/impacts`,
   NFIP y Storm Events) siguen en dólares nominales: son fuente, no cifras de
   exhibición.

2. **Los totales son casi siempre de EE. UU.** Solo María, Irma, Sandy e Ike tienen
   componentes fuera del continente. Katrina (Bahamas), Harvey y Michael dañaron poco
   fuera y el informe no da cifra aparte.

3. **Varios importes son preliminares** («preliminary», «at least», «between X and Y»).
   Se toma el valor puntual citado o el punto medio del rango, y el rango queda
   documentado en la columna `nota` de `danos_verificados.csv`.

4. **El reparto diario del resto es una reconstrucción**, no un dato observado. Lo
   verificado es el total por país; el reparto intra-país sale de Storm Events.

5. **Irma: puede haber solapamiento.** El informe da 1 500 M$ «total damage on the
   island» para San Martín y, aparte, cerca de 1 000 M$ para el lado francés. Se ha
   usado la cifra de la isla (1 500 M$) y **no** se ha sumado la segunda, para no
   contar dos veces el mismo daño.
