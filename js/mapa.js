'use strict';
/* mapa.js — global `MapaTormenta`.
 *  crear() → mapa Leaflet de la vista tormenta con IMÁGENES SATELITALES
 *                 reales (Esri World Imagery, sin API key): trayectoria con
 *                 «carril» de contorno oscuro + interior ADAPTATIVO por
 *                 categoría para contraste sobre satélite, tocatierras con
 *                 etiqueta, marcador = img/hurricane.png escalado por viento
 *                 (kt) con tamaño aparente CONSISTENTE con el zoom del mapa
 *                 y con halo por categoría, y la API de coreografía de zoom
 *                 (C4): zoomInicio / seguir / panorama, usados SOLO durante
 *                 el playback.
 *  (V2: ya no hay mini-mapas — la galería desapareció; la vista tormenta
 *  es la pantalla principal y su atribución vive en el pie del sitio.)
 */

const MapaTormenta = {

  /* Teselas satelitales (Esri World Imagery) — sin clave de API. */
  TES_SATELITE: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  ATTR_SATELITE: 'Teselas &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, Maxar, Earthstar Geographics',

  /* Colores del «carril» (contornos bajo el trazo coloreado por categoría).
   * Con la rampa de ROJOS el interior del carril pasa a ser ADAPTATIVO:
   *  - el EXTERIOR oscuro es continuo (separa toda la paleta de la textura
   *    del satélite, como siempre);
   *  - el INTERIOR: pálido bajo los tramos OSCUROS (cat 3–5 — el granate lee
   *    sobre el carril casi blanco) y oscuro bajo los tramos CLAROS (cat 0–2 —
   *    el salmón #f2a08f se fundía con un carril pálido y con el satélite:
   *    dentro de una ranura oscura destaca en terreno claro y oscuro). */
  CARRIL_OSCURO: '#061018',
  CARRIL_INTERIOR_OSCURO: '#1b0a08',
  CARRIL_CLARO: '#eef5f9',
  CLARO_ETIQUETA: '#eef5f9',

  crear(contenedor, opciones) {
    const puntos = opciones.puntos;

    const mapa = L.map(contenedor, {
      scrollWheelZoom: false,
      zoomControl: true,
      attributionControl: true,
      zoomSnap: 0.5
    });
    mapa.attributionControl.setPrefix('');

    /* --- satélite real, sin API key (la viñeta del contenedor, en CSS,
     * integra la imagen con el tema nocturno) --- */
    L.tileLayer(this.TES_SATELITE, {
      maxZoom: 19,
      attribution: this.ATTR_SATELITE
    }).addTo(mapa);

    /* Accesibilidad de movimiento: con `prefers-reduced-motion` las coreografías
     * saltan SIN animación (setView/fitBounds instantáneos; flyTo con duración 0
     * NO es instantáneo en Leaflet — computeda su propia duración). */
    const reduceMov = () => (typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const saltarSinAnim = () => reduceMov();

    /* --- trayectoria: un segmento por par de puntos, color por categoría
     * (rampa de rojos: más cat, más oscuro). Debajo va el carril: contorno
     * EXTERIOR oscuro continuo + contorno INTERIOR por TRAMO adaptativo
     * (pálido para cat 3–5, oscuro para cat 0–2 — ver colores arriba). --- */
    const maxPeso = 3 + 4 * 0.8; // peso del tramo de cat 5
    const coordsTrazo = puntos.map(p => [p.lat, p.lon]);
    L.polyline(coordsTrazo, {
      color: this.CARRIL_OSCURO, weight: maxPeso + 4, opacity: 0.95,
      lineJoin: 'round', lineCap: 'round', interactive: false
    }).addTo(mapa);
    for (let i = 0; i < puntos.length - 1; i++) {
      const p = puntos[i], q = puntos[i + 1];
      const cat = Math.max(p.cat_ss, q.cat_ss);
      const peso = 3 + cat * 0.8;
      L.polyline([[p.lat, p.lon], [q.lat, q.lon]], {
        color: cat >= 3 ? this.CARRIL_CLARO : this.CARRIL_INTERIOR_OSCURO,
        weight: peso + 2, opacity: 0.92,
        lineJoin: 'round', lineCap: 'round', interactive: false
      }).addTo(mapa);
      L.polyline([[p.lat, p.lon], [q.lat, q.lon]], {
        color: Datos.colorCat(cat),
        weight: peso,
        opacity: 0.96,
        interactive: false
      }).addTo(mapa);
    }

    /* --- tocatierras: círculo con borde claro + etiqueta "timestamp" ---
     * La etiqueta de cada tocatierra es informativa: fecha/hora corta + lugar
     * + «Cat N» cuando hay NOTA emparejada desde data/notas-tocatierras.json
     * (opción `notas`, emparejo por marca de tiempo ≤ 2 h, la más cercana);
     * sin nota se queda la etiqueta genérica «Tocatierra» de siempre. La nota
     * completa queda accesible al hover (tooltip flotante) y como respaldo en
     * title/aria-label. */
    const UMBRAL_NOTA_MS = 2 * 3600 * 1000;
    const normalizarNotas = (lista) => (Array.isArray(lista) ? lista : [])
      .map(n => ({
        tMs: +new Date(n.t),
        lugar: String(n.lugar == null ? '' : n.lugar),
        nota: String(n.nota == null ? '' : n.nota)
      }))
      .filter(n => Number.isFinite(n.tMs));
    let notasToca = normalizarNotas(opciones.notas);

    /* nota más cercana a la fecha del punto (null si ninguna cae en ±2 h) */
    const notaDe = (p) => {
      const tp = +p.d;
      let mejor = null;
      let mejorDist = Infinity;
      notasToca.forEach(n => {
        const dist = Math.abs(n.tMs - tp);
        if (dist < mejorDist) { mejorDist = dist; mejor = n; }
      });
      return (mejor && mejorDist <= UMBRAL_NOTA_MS) ? mejor : null;
    };

    const escapar = (s) => String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /* fecha/hora corta del tocatierra: «29 ago · 11:10 UTC» */
    const fmtHoraCorta = (d) => Datos.fmtDia(d) + ' · ' +
      String(d.getUTCHours()).padStart(2, '0') + ':' +
      String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';

    /* HTML de la etiqueta: genérica sin nota; con nota, tarjeta compacta de
     * dos líneas (hora + Cat N / lugar) con title y aria-label de respaldo */
    const htmlEtiqueta = (e) => {
      if (!e.nota) return '<span class="etq-tocatierra">Tocatierra</span>';
      const cat = Math.max(0, Math.min(5, e.p.cat_ss | 0));
      const desc = 'Tocatierra · ' + Datos.fmtReloj(e.p.d) + ' · ' + e.nota.lugar + ' — ' + e.nota.nota;
      return '<span class="etq-tocatierra etq-toca-nota" role="img"' +
        ' title="' + escapar(desc) + '" aria-label="' + escapar(desc) + '">' +
        '<span class="etq-toca-cab"><span class="etq-toca-hora">' + fmtHoraCorta(e.p.d) + '</span>' +
        '<span class="chip chip-mini chip-intensidad chip-cat-' + cat + '">' + Datos.fmtCatCorto(cat) + '</span></span>' +
        '<span class="etq-toca-lugar">' + escapar(e.nota.lugar) + '</span>' +
        '</span>';
    };

    const iconoEtiqueta = (e, ax, ay) => L.divIcon({
      className: '',
      html: htmlEtiqueta(e),
      iconSize: null,
      iconAnchor: [ax, ay]
    });

    const etiquetas = [];        // {i, p, nota, marcador, ax, ay, elConectado}
    const porIndice = new Map(); // índice de punto → etiqueta (solo tocatierras)

    puntos.forEach((p, i) => {
      if (!p.tocatierra) return;
      L.circleMarker([p.lat, p.lon], {
        radius: 8,
        color: this.CLARO_ETIQUETA,
        weight: 2.5,
        opacity: 0.95,
        fillColor: Datos.colorCat(p.cat_ss),
        fillOpacity: 0.55,
        interactive: false
      }).addTo(mapa);
      /* Etiqueta SIEMPRE por encima del marcador del huracán: con el ícono de
       * hasta ~280 px, el zIndexOffset 400 del marcador taparía la etiqueta;
       * 2000 domina cualquier distancia vertical en píxeles del encuadre
       * (dentro del propio panel de marcadores: contador y reloj-mapa viven
       * en un z-index DOM superior y nunca quedan tapados). */
      const e = { i: i, p: p, nota: notaDe(p), marcador: null, ax: 0, ay: 22, elConectado: null };
      e.marcador = L.marker([p.lat, p.lon], {
        interactive: false,
        keyboard: false,
        zIndexOffset: 2000,
        icon: iconoEtiqueta(e, e.ax, e.ay)
      }).addTo(mapa);
      etiquetas.push(e);
      porIndice.set(i, e);
    });

    /* --- tooltip flotante de la NOTA (hover sobre la etiqueta): vidrio
     * oscuro como la leyenda, no captura el puntero --- */
    const notaTip = document.createElement('div');
    notaTip.className = 'nota-tocatierra oculto';
    notaTip.setAttribute('role', 'tooltip');
    contenedor.appendChild(notaTip);

    const ocultarNota = () => { notaTip.classList.add('oculto'); };

    const mostrarNota = (e, ev) => {
      if (!e.nota || !ev) return;
      const cat = Math.max(0, Math.min(5, e.p.cat_ss | 0));
      notaTip.innerHTML =
        '<p class="nt-cab"><span>' + Datos.fmtReloj(e.p.d) + '</span>' +
        '<span class="chip chip-mini chip-intensidad chip-cat-' + cat + '">' + Datos.fmtCatCorto(cat) + '</span></p>' +
        '<p class="nt-lugar">' + escapar(e.nota.lugar) + '</p>' +
        '<p class="nt-nota">' + escapar(e.nota.nota) + '</p>';
      notaTip.classList.remove('oculto');
      const ancho = notaTip.offsetWidth || 260;
      const alto = notaTip.offsetHeight || 110;
      let x = ev.clientX + 16;
      let y = ev.clientY + 14;
      if (x + ancho > window.innerWidth - 8) x = ev.clientX - ancho - 12;
      if (y + alto > window.innerHeight - 8) y = ev.clientY - alto - 12;
      notaTip.style.left = Math.max(8, x) + 'px';
      notaTip.style.top = Math.max(8, y) + 'px';
    };

    /* Engancha los eventos propios de la etiqueta al elemento que Leaflet
     * tenga montado ahora (setIcon los recrea). El hover abre el tooltip de
     * la nota y el clic fija la ficha, igual que el círculo del punto. */
    const conectarEtiqueta = (e) => {
      const el = e.marcador.getElement();
      if (!el || el === e.elConectado) return;
      e.elConectado = el;
      if (!e.nota) return;
      el.addEventListener('mouseenter', (ev) => mostrarNota(e, ev));
      el.addEventListener('mouseleave', ocultarNota);
      el.addEventListener('click', () => { ocultarNota(); opciones.alHacerClicEnPunto(e.i); });
    };

    /* Sin solapes entre etiquetas: en orden temporal, cada una prueba
     * posiciones cercanas (arriba → abajo → derecha → izquierda) y, si un
     * racimo las agota, niveles extra de apilado vertical; toma la primera
     * que no pise a las ya puestas ni se salga del encuadre y, en el peor
     * caso, la de menor solape. Se recalcula con el encuadre base (zoomBase),
     * donde el riesgo de solape es mayor: al acercar, los puntos se separan y
     * las etiquetas (tamaño fijo en pantalla) no vuelven a juntarse. */
    const acomodarEtiquetas = () => {
      const tam = mapa.getSize();
      const puestas = [];
      etiquetas.forEach((e) => {
        const el = e.marcador.getElement();
        if (!el) return;
        const w = el.offsetWidth || 150;
        const h = el.offsetHeight || 18;
        const c = mapa.latLngToContainerPoint([e.p.lat, e.p.lon]);
        const cands = [
          { ax: w / 2, ay: h + 8 },        // encima
          { ax: w / 2, ay: -8 },           // debajo
          { ax: -10, ay: h / 2 },          // derecha
          { ax: w + 10, ay: h / 2 },       // izquierda
          { ax: w / 2, ay: 2 * h + 14 },   // encima, 2.º nivel
          { ax: w / 2, ay: -(h + 14) },    // debajo, 2.º nivel
          { ax: w / 2, ay: 3 * h + 20 },   // encima, 3.er nivel
          { ax: w / 2, ay: -(2 * h + 20) } // debajo, 3.er nivel
        ];
        const rects = cands.map(cd => ({ x: c.x - cd.ax, y: c.y - cd.ay, w: w + 6, h: h + 4 }));
        const choca = r => puestas.some(q => !(r.x + r.w <= q.x || q.x + q.w <= r.x ||
          r.y + r.h <= q.y || q.y + q.h <= r.y));
        const solape = r => puestas.reduce((acc, q) => {
          const dx = Math.min(r.x + r.w, q.x + q.w) - Math.max(r.x, q.x);
          const dy = Math.min(r.y + r.h, q.y + q.h) - Math.max(r.y, q.y);
          return acc + (dx > 0 && dy > 0 ? dx * dy : 0);
        }, 0);
        const dentro = r => r.x >= 2 && r.y >= 2 && r.x + r.w <= tam.x + 4 && r.y + r.h <= tam.y + 4;
        let k = rects.findIndex(r => !choca(r) && dentro(r));
        if (k < 0) k = rects.findIndex(r => !choca(r));
        if (k < 0) { // racimo saturado: la posición de menor solape
          k = 0;
          let minSolape = Infinity;
          rects.forEach((r, j) => { const s = solape(r); if (s < minSolape) { minSolape = s; k = j; } });
        }
        puestas.push(rects[k]);
        const cd = cands[k];
        if (e.ax !== cd.ax || e.ay !== cd.ay) {
          e.ax = cd.ax; e.ay = cd.ay;
          e.marcador.setIcon(iconoEtiqueta(e, e.ax, e.ay)); // recrea el icono
        }
        conectarEtiqueta(e);
      });
    };

    /* --- zona de hover: círculos invisibles por punto (tooltip + clic propios) --- */
    const capturas = puntos.map((p, i) =>
      L.circleMarker([p.lat, p.lon], {
        radius: 7, stroke: false, fillColor: '#000', fillOpacity: 0, interactive: true
      })
        .on('mouseover', (e) => opciones.alPasarPorEncima(i, e.originalEvent))
        .on('mouseout', () => opciones.alSalirDelHover())
        .on('click', () => opciones.alHacerClicEnPunto(i))
        .addTo(mapa)
    );

    /* --- punto actual: img/hurricane.png, escalado LINEALMENTE por VIENTO
     * (30 kt → 84 px, 160 kt → 276 px en el encuadre base; redondeado, ancla
     * centrada) + halo de intensidad coloreado POR CATEGORÍA (el canal de dato
     * pasa por el halo).
     * Tamaño CONSISTENTE CON EL ZOOM: los px por grado del mapa escalan ~2^zoom,
     * así que el ícono = tamañoBase(viento) · 2^(zoom − zoomBase), con zoomBase
     * el encuadre de REFERENCIA (el del fitBounds inicial/reencuadrar): en el
     * zoom por defecto se ve igual que antes, encoge al alejar y crece al
     * acercar (sin tope superior), conservando su tamaño aparente sobre el
     * terreno. Redondeo a múltiplos de 2 px (acota la caché de L.icon) y suelo
     * de 12 px para que nunca desaparezca al alejarse mucho. --- */
    let zoomBase = 4; // zoom del encuadre de REFERENCIA del ícono (lo fija encajar())
    const tamIconoBase = (kt) => {
      const v = +kt;
      return 84 + ((Number.isFinite(v) ? v : 30) - 30) * (192 / 130);
    };
    const tamIcono = (kt, zoom) => {
      const z = Number.isFinite(zoom) ? zoom : mapa.getZoom();
      const zr = Number.isFinite(zoomBase) ? zoomBase : z;
      // Solo encoge al alejarse del zoom de referencia; al acercar no crece
      // (mantiene el tamaño aprobado en el plano de seguimiento).
      const f = (Number.isFinite(z) && Number.isFinite(zr)) ? Math.min(1, Math.pow(2, z - zr)) : 1;
      return Math.max(12, Math.round((tamIconoBase(kt) * f) / 2) * 2);
    };
    const cacheIconos = Object.create(null); // una L.icon por tamaño (px) ya usado
    const iconoHuracan = (px) => {
      if (!cacheIconos[px]) {
        cacheIconos[px] = L.icon({
          iconUrl: 'img/hurricane.png',
          iconSize: [px, px],
          iconAnchor: [px / 2, px / 2],
          className: 'marcador-huracan'
        });
      }
      return cacheIconos[px];
    };

    const haloActual = L.circleMarker([puntos[0].lat, puntos[0].lon], {
      radius: 12, stroke: false, interactive: false
    }).addTo(mapa);
    const puntoActual = L.marker([puntos[0].lat, puntos[0].lon], {
      icon: iconoHuracan(tamIcono(puntos[0].viento_kt)),
      interactive: false,
      keyboard: false,
      zIndexOffset: 400
    }).addTo(mapa);
    let tamIconoActual = tamIcono(puntos[0].viento_kt); // px actuales (mapa sin vista aún: base)
    let vientoActivo = +puntos[0].viento_kt; // último viento aplicado: el zoom reusa esto

    /* Aplica posición + viento al marcador y su halo: misma vía para el snap
     * discreto y para el deslizamiento interpolado del playback. El tamaño en
     * pantalla lo deriva tamIcono() del viento y del zoom actual del mapa. */
    const aplicarPunto = (lat, lon, viento, p) => {
      vientoActivo = +viento;
      const t = tamIcono(vientoActivo);
      if (t !== tamIconoActual) { // reescalado solo si cambia el tamaño (viento o zoom)
        puntoActual.setIcon(iconoHuracan(t));
        tamIconoActual = t;
      }
      puntoActual.setLatLng([lat, lon]);
      haloActual.setLatLng([lat, lon]);
      haloActual.setRadius(t / 2 + 3);
      haloActual.setStyle({
        fillColor: Datos.colorCat(p.cat_ss),
        fillOpacity: p.tocatierra ? 0.4 : 0.26
      });
    };

    /* Posición y viento LINEALMENTE interpolados entre puntos[i] y puntos[i+1]
     * según `frac` (0..1). En el último punto no hay siguiente: se usa tal cual.
     * La categoría (color del halo) NO se interpola: es la del punto activo i. */
    const interp = (i, frac) => {
      const p = puntos[i];
      const q = puntos[i + 1];
      const f = q ? Math.max(0, Math.min(1, Number(frac) || 0)) : 0;
      if (!q) return { lat: p.lat, lon: p.lon, viento: +p.viento_kt };
      return {
        lat: p.lat + (q.lat - p.lat) * f,
        lon: p.lon + (q.lon - p.lon) * f,
        viento: (+p.viento_kt) + ((+q.viento_kt) - (+p.viento_kt)) * f
      };
    };

    /* --- anillo punteado para el punto bajo el cursor (vista previa) --- */
    const anilloHover = L.circleMarker([puntos[0].lat, puntos[0].lon], {
      radius: 12, fill: false, stroke: false, interactive: false
    }).addTo(mapa);
    let indiceHover = -1; // punto en vista previa (anillo visible), o -1

    /* Reaplica el tamaño al zoom ACTUAL: lo llama cada zoomend y encajar().
     * El viento no cambia al hacer zoom, así que reusa el último conocido
     * (vientoActivo / indiceHover; por defecto, el punto inicial). */
    const refrescarTamanoZoom = () => {
      const z = mapa.getZoom();
      const t = tamIcono(vientoActivo, z);
      if (t !== tamIconoActual) { // setIcon solo si el px redondeado cambió
        puntoActual.setIcon(iconoHuracan(t));
        tamIconoActual = t;
      }
      haloActual.setRadius(t / 2 + 3); // halo: mismo factor que el ícono
      if (indiceHover >= 0) {
        const h = puntos[indiceHover];
        if (h) anilloHover.setRadius(tamIcono(h.viento_kt, z) / 2 + 6); // anillo hover ídem
      }
    };

    /* Encuadre AJUSTADO: el trayecto entra y sale por los bordes del mapa.
     * Sin tope de zoom. Nota: el fit real corre en encajar(), tras fijar la
     * altura final (la app llama reencuadrar()). zoomBase (declarado arriba:
     * referencia del tamaño del ícono y de la coreografía C4) queda
     * registrado aquí. */
    const encuadre = L.latLngBounds(puntos.map(p => [p.lat, p.lon]));
    const PAD = [12, 12];
    let zSeguimiento = null; // nivel cercano constante del acompañamiento (C4)
    const encajar = () => {
      const anterior = mapa.options.zoomSnap;
      mapa.options.zoomSnap = 0.001; // ajuste fino puntual
      mapa.fitBounds(encuadre, { padding: PAD, animate: false });
      zoomBase = mapa.getZoom();
      mapa.options.zoomSnap = anterior; // grid normal para la interacción
      refrescarTamanoZoom(); // el encuadre fija el tamaño base de referencia
      acomodarEtiquetas();   // y la posición sin solapes de las etiquetas
    };
    encajar();

    /* El zoom de usuario (control/doble clic, grid zoomSnap 0.5) reescala el
     * ícono: conserva su tamaño aparente sobre el terreno. */
    mapa.on('zoomend', refrescarTamanoZoom);

    return {
      mapa: mapa,

      getZoom() { return mapa.getZoom(); },

      /* Re-empareja y repinta las etiquetas si las notas llegan después de
       * crear el mapa (la app normalmente ya las pasa en `crear`, opción
       * `notas`). */
      setNotas(nuevas) {
        notasToca = normalizarNotas(nuevas);
        etiquetas.forEach(e => {
          e.nota = notaDe(e.p);
          e.marcador.setIcon(iconoEtiqueta(e, e.ax, e.ay));
        });
        ocultarNota();
        acomodarEtiquetas();
      },

      /* Nota emparejada con el tocatierra de índice i (o null): la ficha
       * abierta al clic la usa para incluir la explicación. */
      notaDePunto(i) {
        const e = porIndice.get(i);
        return e && e.nota ? e.nota : null;
      },

      /* Mueve el marcador al punto EXACTO i (hover, scrub, ficha, clic, pausa). */
      setPuntoActivo(i) {
        const p = puntos[i];
        if (!p) return;
        aplicarPunto(p.lat, p.lon, p.viento_kt, p);
      },

      /* SOLO playback automático: desliza el marcador a la posición y viento
       * interpolados entre puntos[i] y puntos[i+1] (mismo `frac` que el reloj).
       * Con i en el último punto equivale a setPuntoActivo(i). Con
       * prefers-reduced-motion no se desliza: mantiene el snap por punto. */
      setPuntoInterp(i, frac) {
        const p = puntos[i];
        if (!p) return;
        const v = saltarSinAnim()
          ? { lat: p.lat, lon: p.lon, viento: +p.viento_kt }
          : interp(i, frac);
        aplicarPunto(v.lat, v.lon, v.viento, p);
      },

      /* Anillo punteado del punto en vista previa (hover), o null para quitarlo. */
      setHover(i) {
        const p = puntos[i];
        indiceHover = p ? i : -1;
        if (!p) { anilloHover.setStyle({ stroke: false }); return; }
        anilloHover.setLatLng([p.lat, p.lon]);
        anilloHover.setRadius(tamIcono(p.viento_kt) / 2 + 6); // viento × zoom
        anilloHover.setStyle({
          stroke: true, color: '#ffffff', opacity: 0.9,
          dashArray: '3 4', weight: 1.6, fill: false
        });
      },

      /* ============ coreografía de zoom (C4) ============
       * Solo las invoca la app durante el playback automático.
       * `zSeguimiento` = nivel cercano constante del acompañamiento
       * (fitZoom + 2, tope 8), igual para todos los puntos. */

      /* Zoom de arranque: zoom-in notable hacia el punto actual
       * (fitZoom + 2, tope 8, ~1 s) y fija ahí el nivel de seguimiento;
       * la app ya NO agenda retorno: a partir de aquí acompaña el punto. */
      zoomInicio(i) {
        const p = puntos[i];
        if (!p) return;
        zSeguimiento = Math.min(zoomBase + 2, 8);
        if (saltarSinAnim()) { mapa.setView([p.lat, p.lon], zSeguimiento, { animate: false }); return; }
        mapa.flyTo([p.lat, p.lon], zSeguimiento, { duration: 1, easeLinearity: 0.28 });
      },

      /* Acompañamiento del punto activo: lo centra SIN animación manteniendo
       * el zoom de seguimiento CONSTANTE (no-op si ya está centrado ahí).
       * Con `frac` centra la posición INTERPOLADA del playback (deslizamiento
       * continuo); sin él (frac=0) centra el punto exacto i (cambio de punto). */
      seguir(i, frac) {
        if (!puntos[i]) return;
        const v = interp(i, frac);
        if (zSeguimiento == null) zSeguimiento = Math.min(zoomBase + 2, 8);
        const destino = L.latLng(v.lat, v.lon);
        if (mapa.getZoom() === zSeguimiento && mapa.getCenter().equals(destino)) return;
        mapa.setView(destino, zSeguimiento, { animate: false });
      },

      /* Retorno suave al encuadre completo del trayecto. */
      panorama(segundos) {
        zSeguimiento = null; // el encuadre completo cancela el nivel de seguimiento
        if (saltarSinAnim()) { mapa.fitBounds(encuadre, { padding: PAD, animate: false }); return; }
        const anterior = mapa.options.zoomSnap;
        mapa.options.zoomSnap = 0.001; // el objetivo fraccional del fit estático
        mapa.flyToBounds(encuadre, {
          padding: PAD,
          duration: (segundos == null ? 0.9 : segundos),
          easeLinearity: 0.24
        });
        mapa.options.zoomSnap = anterior;
      },

      /* Vuelve a ajustar el encuadre (usado tras cambiar la altura del mapa:
       * el fit inicial corre con la altura por defecto y quedaría centrado).
       * Actualiza zoomBase (el encuadre de la coreografía depende del tamaño). */
      reencuadrar() {
        zSeguimiento = null; // el encuadre base cancela el nivel de seguimiento
        encajar();
      },

      invalidateSize() {
        mapa.invalidateSize();
      },

      destruir() {
        ocultarNota();
        if (notaTip.parentNode) notaTip.parentNode.removeChild(notaTip);
        mapa.remove();
      }
    };
  }
};

window.MapaTormenta = MapaTormenta;