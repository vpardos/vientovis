# Prompt — V1 de visualización interactiva y sonora: "El impacto de los huracanes más relevantes de los últimos años"

## Contexto y objetivo

Construye la **versión V1, completa y funcional**, de una visualización de información **interactiva y con sonificación** para un curso universitario de visualización de información. Se desplegará en **GitHub Pages**: sitio 100% estático, sin backend, sin base de datos.

La V1 debe ser **completa pero cruda**: funcional de punta a punta (mensaje → datos → forma visual → interacción → sonido), sin pulido excesivo. Será iterada en diseño durante semanas: prioriza código legible, decisiones simples y estructura de datos limpia.

## Mensaje principal

La vida de un huracán se decide en horas: la **intensificación rápida (IR)** antes de tocar tierra y las horas del tocatierra concentran el costo humano y económico. La visualización sigue **punto por punto (cada 6 h)** la anatomía de 10 huracanes del Atlántico, mostrando trayectoria e intensidad junto con **muertes y daños en dólares acumulados en el tiempo**, para que se vea en qué momento del ciclo de vida ocurre el impacto.

## Datos — DATOS DE REFERENCIA (mock)

El dataset real está en construcción. Genera **datos sintéticos verosímiles con la misma estructura que tendrá el dataset final**, de modo que reemplazarlos sea solo sustituir archivos JSON. Reglas:

1. Un JSON por tormenta en `data/tormentas/`, más `data/indice.json` (manifiesto con id, nombre, año y totales, para la vista general).
2. Cada archivo incluye `"mock": true` y un campo `nota` indicando que son datos de referencia.
3. La UI debe mostrar **siempre un badge visible** — "V1 · DATOS DE REFERENCIA" — mientras los datos cargados sean mock. Ninguna cifra mock se presenta como real.

### Schema (compartido por mock y dataset final)

```json
{
  "id": "katrina-2005",
  "nombre": "Katrina",
  "anio": 2005,
  "mock": true,
  "nota": "Datos de referencia — reemplazar por dataset final",
  "inicio": "2005-08-23T18:00:00Z",
  "fin": "2005-08-31T00:00:00Z",
  "puntos": [
    {
      "t": "2005-08-23T18:00:00Z",
      "lat": 23.1,
      "lon": -75.5,
      "viento_kt": 30,
      "presion_mb": 1008,
      "estatus": "TD",
      "cat_ss": 0,
      "tocatierra": false,
      "ir": false,
      "muertes_acum": 0,
      "danos_acum_usd": 0
    }
  ]
}
```

Notas de schema: cadencia de 6 h (el dataset final puede refinar a horas; el cargador debe unir por marca de tiempo, no por índice); `ir` = punto dentro de un tramo de intensificación rápida (≥ 30 kt en 24 h); `cat_ss` = Saffir–Simpson 0–5 (0 = TD/TS); `muertes_acum` y `danos_acum_usd` = acumulados desde el inicio de la tormenta.

### Las 10 tormentas y anclas aproximadas

Calibra el mock con estas cifras (órdenes de magnitud redondeados de fuentes públicas; **no son valores exactos** — el grupo verificará contra el dataset final):

| Tormenta | Vida (aprox.) | Tocatierra principal | Pico | Muertes (orden) | Daños (orden) |
|---|---|---|---|---|---|
| Katrina 2005 | 23–31 ago | Buras, LA — C3, 29 ago | C5 (150 kt) | ~1.800 | ~USD 125 mil M |
| Maria 2017 | 16–30 sep | Dominica C5 (19) · Puerto Rico C4 (20) | C5 | ~3.000 | ~USD 90 mil M |
| Helene 2024 | 24–27 sep | Big Bend, FL — C4, 26 sep | C4 | ~230 | ~USD 75–80 mil M |
| Sandy 2012 | 22 oct–1 nov | Nueva Jersey — postropical, 29 oct | C3 (95 kt) | ~150–230 | ~USD 70 mil M |
| Ian 2022 | 23–30 sep | Cayo Costa, FL — C4, 28 sep | C4 (135 kt) | ~150 | ~USD 113 mil M |
| Harvey 2017 | 17 ago–1 sep | Rockport, TX — C4, 25 ago | C4 (130 kt) | ~70 | ~USD 125 mil M |
| Ida 2021 | 26 ago–4 sep | Port Fourchon, LA — C4, 29 ago | C4 (130 kt) | ~30–90 | ~USD 75 mil M |
| Irma 2017 | 30 ago–13 sep | Barbuda C5 (6) · Florida C4 (10) | C5 (160 kt) | ~50–130 | ~USD 50 mil M |
| Michael 2018 | 7–11 oct | Mexico Beach, FL — C5, 10 oct | C5 (140 kt) | ~16–45 | ~USD 25 mil M |
| Ike 2008 | 1–14 sep | Galveston, TX — C2, 13 sep | C4 | ~100 | ~USD 30–38 mil M |

### Reglas de realismo del mock (forma, no precisión)

- Génesis en el Atlántico tropical o el Caribe; deriva W/NW; **IR antes de los tocatierra mayores** (marca esos tramos con `ir: true`); decaimiento sobre tierra.
- Impactos: muertes y daños ≈ 0 antes del primer tocatierra; salto en el tocatierra; acumulación durante las 24–72 h siguientes. El daño es más abrupto (concentrado en el tocatierra); las muertes pueden acumularse más lento y después (inundaciones — p. ej. el perfil de Harvey: días de acumulación tierra adentro). Los totales deben caer en el orden de magnitud de la tabla.

## Forma visual (V1)

- **Vista general (overview first):** galería de las 10 tormentas como fichas: mini-mapa con la trayectoria, nombre + año, categoría pico, muertes y daños totales. Ordenada por muertes descendente. El mensaje —pocos huracanes concentran casi todo el impacto— debe leerse sin interactuar.
- **Vista de tormenta (zoom/filter):**
  - Mapa (Leaflet con teselas claras, o canvas propio): trayectoria coloreada por categoría Saffir–Simpson, punto actual cuyo tamaño crece con la categoría, marcas de tocatierra.
  - Tres paneles apilados con **eje temporal compartido y crosshair sincronizado**:
    1. **Viento y presión**: viento (línea con área), presión (línea punteada, **eje invertido** — práctica meteorológica estándar, decláralo en la leyenda). Tramos IR sombreados; líneas verticales en tocatierras.
    2. **Muertes acumuladas**: línea escalonada (step-after).
    3. **Daños acumulados (USD)**: línea escalonada; formateo en miles de millones; **eje completo desde 0**, sin truncar.
  - **Reproductor**: play/pausa, velocidad (0.5× / 1× / 2×), scrubber, fecha y hora actuales en UTC. Un paso de 6 h ≈ 0,5 s a 1×.
- **Vista comparación:** dos tormentas lado a lado con los ejes temporales **alineados por horas respecto al primer tocatierra** (0 = tocatierra, eje en horas relativas), para comparar muertes y daños por hora relativa.
- **Detalles on demand:** hover en cualquier punto → tooltip con valores exactos (fecha UTC, lat/lon, viento kt, presión mb, categoría, muertes acumuladas y delta del intervalo, daños acumulados y delta). Clic en tormenta/punto → ficha con pico, tocatierra(s) y totales.
- **Color:** paleta secuencial accesible para la categoría (verificable en deuteranopia, p. ej. derivada de viridis); muertes y daños en tonos neutros distintos, sin reutilizar la paleta de categoría (no mezclar canales). La idea es que el diseño sea atractivo, se creativo con este.

## Interacción — mantra de Shneiderman

Overview first (galería) → zoom and filter (selección de tormenta, comparación) → details on demand (tooltips, fichas). Más playback temporal y crosshair. Controles con texto, no solo iconos: la interacción debe ser descubrible.

## Sonificación (Web Audio API nativo; sin librerías de audio)

Todo parámetro sonoro es dirigido por el estado temporal actual — **nada de loops fijos desacoplados del dato**, y no descansar solo en el volumen:

- **Dron base:** tono mapeado a la presión central (menor presión → tono más grave y oscuro; escala fija normalizada, p. ej. 950–1010 mb).
- **Capa de viento:** ruido con filtro paso-banda cuya frecuencia de corte y rugosidad siguen el viento (más viento → timbre más brillante y áspero). Cambia el **timbre**, no solo la ganancia.
- **Intensificación rápida:** al entrar en un tramo IR, el tono del dron **salta** y aparece un armónico distorsionado — el evento se oye.
- **Tocatierra:** golpe percusivo + cambio de timbre del ruido (mar → tierra: más seco, menos "oleaje").
- **Muertes:** cada incremento del acumulado dispara **pulsos graves**; ritmo = tasa de mortalidad (lotes grandes → pulsos más densos y graves).
- **Daños:** ráfagas granulares cuya densidad sigue la tasa de daños por hora.
- Reglas técnicas: iniciar audio solo tras gesto del usuario (botón "Activar sonido"); toggle de mute y control de volumen; pausar el playback atenúa suavemente.

## Requisitos técnicos

- 100% estático para GitHub Pages: `index.html` + assets; sin backend; sin paso de build obligatorio.
- Stack sugerido: **D3.js v7** (escalas, ejes, paneles), canvas propio (mapa), para el sonido, se usarán archivos mp3 locales.
- UI completamente en español; unidades siempre explícitas (kt, mb, USD, UTC).
- Accesibilidad básica: contraste AA, foco visible, la información no depende solo del hover.
- 10 tormentas × decenas de puntos: performance irrelevante. No sobre-ingeniería ni dependencias innecesarias.


El README debe incluir: cómo correr en local (`python -m http.server`), **cómo reemplazar el mock por el dataset final** (sustituir los JSON; la app oculta el badge cuando `mock` no esté), y las decisiones de diseño tomadas, 2–3 líneas por decisión.

## Qué NO hacer

- No presentar cifras mock como reales.
- No usar Plotly ni la interacción por defecto de una librería.
- No basar la visualización en gráficos de barras.
- No ejes truncados (salvo la presión, eje invertido justificado y declarado), no dobles ejes engañosos, no 3D.
- No agregar funciones extra no pedidas: la V1 es cruda pero completa.

## Auto-revisión antes de terminar

1. ¿La galería transmite el mensaje sin interacción?
2. ¿Cada parámetro del sonido (tono, ritmo, timbre) cambia con un dato — no solo el volumen?
3. ¿Hover, scrub y play funcionan, con crosshair sincronizado entre mapa y los 3 paneles?
4. ¿El badge de datos de referencia es visible en todo momento?
5. ¿Se puede entrar a una tormenta, reproducirla, escucharla y comparar dos tormentas?

Entrega el proyecto completo, funcionando en local y listo para subir a GitHub Pages.
