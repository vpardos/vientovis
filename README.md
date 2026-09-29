# vientovis — El impacto de los huracanes

**V1** de una visualización interactiva y sonora para el curso de visualización de
información. Sigue, punto por punto (cada 6 h), la anatomía de 10 huracanes del
Atlántico — trayectoria, viento, presión, intensificación rápida y tocatierras —
junto con muertes y daños en USD acumulados, para mostrar **en qué momento del
ciclo de vida se concentra el impacto**.

Sitio 100% estático (GitHub Pages): sin backend, sin paso de build. D3.js v7 y
Leaflet por CDN; sonificación con Web Audio API nativo.

## Correr en local

```bash
python -m http.server
# abrir http://localhost:8000
```

Hace falta un servidor (no `file://`) porque la app carga los JSON con `fetch`.

## Datos

Los datos de `data/` son el **dataset final del grupo**, construido desde
`notebooks/hurricanes_unido.csv` (HURDAT2 + impactos) por
`scripts/convertir_dataset.py`:

- `data/indice.json` — manifiesto para la galería (id, nombre, año, categoría
  pico, muertes y daños totales).
- `data/tormentas/{id}.json` — un archivo por tormenta con los puntos:
  `t` (UTC, cadencia 6 h + boletines especiales), `lat`, `lon`, `viento_kt`,
  `presion_mb`, `estatus`, `cat_ss` (Saffir–Simpson 0–5), `tocatierra`, `ir`
  (intensificación rápida ≥30 kt/24 h), `muertes_acum`, `danos_acum_usd`.

Notas:

- **Para regenerar**: `python3 scripts/convertir_dataset.py` (determinista, con
  autovalidación). El mock previo se regenera con `scripts/generar_mock.py`.
- Los impactos del CSV son valores **diarios de EE. UU.** (storm_events):
  los totales son menores que las cifras históricas globales (p. ej. María
  refleja solo sus muertes en territorio de EE. UU.). El CSV es la fuente de
  verdad.
- El acceso a puntos es por **marca de tiempo** (`t`), no por índice.
- Si algún dato volviera a ser sintético (`"mock": true`), el generador lo
  marca como tal en los JSON.

## Vistas

1. **Galería** (overview first): las 10 tormentas como fichas con mini-mapa
   satelital (Leaflet con imagen Esri World Imagery, sin API key) y totales,
   ordenadas por muertes descendente.
2. **Tormenta** (zoom/filter): mapa Leaflet satelital con trayectoria coloreada
   por categoría, ícono de huracán (`img/hurricane.png`) cuyo tamaño escala
   linealmente con el viento (30 kt → 28 px, 160 kt → 92 px), contador de
   muertes y daños acumulados del punto activo arriba a la derecha del mapa,
   3 paneles temporales con crosshair sincronizado (viento/presión, muertes,
   daños) y reproductor (play/pausa, 0,25×/0,5× con 0,5× por defecto — un
   punto de 6 h ≈ 1 s —, scrubber, reloj UTC). Coreografía de zoom en playback:
   encuadre completo al cargar → zoom al punto actual al arrancar y
   **seguimiento continuo** del huracán a zoom constante (tocatierras
   incluidas) → panorama completo al terminar. Scrub y hover sin coreografía.
3. **Comparar**: dos tormentas lado a lado con ejes alineados por horas
   relativas al primer tocatierra (0 = tocatierra).

Detalles on demand: hover → tooltip con valores exactos y deltas por intervalo;
clic en un punto → ficha fijada (la información no depende solo del hover).

## Sonificación (dirigida por el dato, no por volumen)

| Parámetro | Dato que lo dirige |
|---|---|
| Tono y oscuridad del dron | Presión central (950–1010 mb, escala fija) |
| Grabación de viento real y su intensidad | Categoría Saffir–Simpson: cat 0–3 `audio/huracan.mp3`, cat 4–5 `audio/huracanaterrador.mp3` (crossfade en el umbral); ganancia escalada por categoría (0,04–0,58) con modulación fina por viento |
| Salto de tono + armónico distorsionado | Entrada en tramo de IR |
| Golpe percusivo + grabación más seca (lowpass) | Tocatierra / vida sobre tierra |
| Ritmo y gravedad de pulsos graves | Muertes por intervalo |
| Densidad de ráfagas granulares | Tasa de daños por hora |

Las grabaciones de sonido de huracán (`huracan.mp3`, `huracanaterrador.mp3`) son
reales, aportadas por el equipo. El audio solo arranca tras el gesto del usuario
(«Activar sonido»); hay toggle de silencio, volumen, y pausar el playback atenúa
suavemente. Al salir de la vista de tormenta el playback se detiene y el
audio se atenúa por completo.

## Decisiones de diseño (V1)

- **Cadencia 6 h y unión por tiempo**: coincide con los boletines del NHC y con
  el formato mock; el buscador usa `d3.bisector` sobre fechas para que subir la
  resolución temporal no toque el código.
- **Paleta de categoría derivada de viridis** (distinguible en deuteranopia) y
  canales de impacto en tonos propios ajenos a ella (carmesí para muertes,
  ámbar para daños): no se mezclan canales.
- **Eje de presión invertido**: práctica meteorológica estándar para leer junto
  al viento; está declarado en la leyenda del panel. Es la única escala no
  directa; daños y muertes van desde 0, sin truncar.
- **IR y tocatierras repetidos en los tres paneles** (bandas y líneas
  verticales): el mensaje del proyecto es *cuándo* ocurre el impacto; las marcas
  compartidas hacen legible la alineación temporal sin interacción.
- **Mini-mapas de la galería como mapas Leaflet satelitales** (no interactivos,
  teselas Esri World Imagery sin API key, atribución única en el pie): reales y
  legibles frente a un SVG abstracto; cada uno encuadrado a su propio trayecto.
- **Ícono `hurricane.png` para el punto actual**, dimensionado linealmente por
  viento (30–160 kt → 30–64 px, ancla centrada, halo para recortar sobre
  satélite): el tamaño responde a la fuerza del momento, no a la etiqueta de
  categoría; el color por categoría lo lleva el halo inferior.
- **Coreografía de zoom en playback**: encuadre por defecto al cargar, zoom de
  seguimiento al punto actual desde el arranque, seguimiento constante en
  tocatierras y panorama final — el mapa narra el ciclo de vida junto al audio
  y el contador de impactos.
- **Dron sonoro sutil**: tras incorporar grabaciones reales de huracán, el dron
  sintetizado (triangle, ganancia ~1/5, filtro oscuro) pasa a ser un colchón de
  sub-grave que no tapa las grabaciones; el evento IR se percibe como cambio de
  color del tono, no como un zumbido.
- **Scripts planos con objetos globales** (`Datos`, `MapaTormenta`, `Paneles`,
  `MotorAudio`, `App`) en vez de módulos ES/build: la V1 prioriza legibilidad y
  despliegue estático sin toolchain.

## Auto-revisión de V1

1. La galería ordenada por muertes transmite la concentración del impacto sin
   interactuar. ✔
2. Cada parámetro sonoro (tono, timbre, ritmo, densidad) depende de un dato. ✔
3. Hover, scrub y play con crosshair sincronizado entre mapa y 3 paneles. ✔
4. Los totales del dataset (reales) sostienen el mensaje sin interactuar y
   ninguna cifra se presenta como estimación propia. ✔
5. Se puede entrar a una tormenta, reproducirla, escucharla y comparar dos. ✔
