'use strict';
/* app.js — global `App`: routing por hash y PANTALLA PRINCIPAL (V3).
 * La visualización de tormenta ES la portada: héroe compacto (título,
 * descripción y frase editorial «potencia ≠ destructividad» computada del
 * índice), un selector de huracanes ordenado por MUERTES y, debajo, la vista
 * tormenta completa (mapa satelital + 3 paneles + reproductor + contador).
 * Rutas: #/ · #galeria (alias histórico, también es la portada) ·
 * #tormenta/<id>; cualquier hash desconocido cae a la portada. El selector
 * cambia de huracán SIN recargar (solo re-render de la vista) y reescribe el
 * hash con history.replaceState para conservar los enlaces profundos.
 * El reproductor avanza SIEMPRE a ×0,25 (un punto de 6 h cada 2 s reales). */

/* Factor exacto kt → km/h (1 kt = 1,852 km/h). Se usa SOLO en el overlay
 * `#viento-mapa`; el resto de la app (línea de valores, paneles, ficha,
 * leyenda y notas) sigue mostrando nudos. */
const KT_A_KMH = 1.852;

const App = {

  motor: null,
  _volumen: 0.7,
  _mudo: false,
  _estado: null,
  _paneles: null,
  _mapa: null,
  _limpieza: [],
  _token: 0,
  _notasPromesa: null, // carga única de data/notas-tocatierras.json (caché en memoria)
  _raizTormenta: null, // el div donde la vista tormenta se monta sobre la portada

  /* ===================== arranque y rutas ===================== */

  async iniciar() {
    const main = document.getElementById('vista');
    try {
      main.innerHTML = '<p class="cargando mono">Cargando datos de tormentas…</p>';
      await Datos.cargar();
    } catch (err) {
      main.innerHTML =
        '<section class="carga-error"><h1>No se pudieron cargar los datos</h1>' +
        '<p class="mono">' + String(err.message || err) + '</p>' +
        '<p>Necesita un servidor local (p. ej. <span class="mono">python3 -m http.server</span>).</p></section>';
      return;
    }
    window.addEventListener('hashchange', () => this._rotear());
    this._rotear();
  },

  _parseHash() {
    let crudo = '';
    try { crudo = decodeURIComponent(location.hash.slice(1)); } catch (e) { crudo = ''; }
    const ruta = crudo.split('?')[0];
    /* la tormenta de MÁS MUERTES es la portada por defecto */
    const idPortada = () => {
      const orden = Datos.ordenPorMuertes();
      return orden.length ? orden[0].id : null;
    };
    if (ruta.indexOf('tormenta/') === 0) {
      const id = ruta.slice('tormenta/'.length);
      if (Datos.porId(id)) return { id: id, profundo: true };
    }
    /* raíz (# y #/), #galeria (alias histórico) y cualquier hash raro → portada */
    return { id: idPortada(), profundo: false };
  },

  _rotear() {
    /* BUG (C1): al salir de una tormenta cuyo sonido estaba activo y sonando,
     * las capas seguían sonando en la vista siguiente. Corto el playback (rAF
     * + temporizadores + motor.setReproduciendo(false)) ANTES de desmontar:
     * el motor atenúa el master a 0 (~0,6 s) y calla por completo. */
    const dest = this._parseHash();
    this._pararPlayback();
    this._desmontar();
    const token = ++this._token;
    window.scrollTo(0, 0);

    /* cualquier hash raro o viejo (p. ej. #comparar) cae a la portada y la
     * URL se normaliza a #/ (replaceState: sin entrada al historial) */
    if (!dest.profundo) { try { history.replaceState(null, '', '#/'); } catch (e) { /* file:// etc */ } }

    const meta = Datos.porId(dest.id);
    document.title = dest.profundo && meta
      ? 'Vientovis — ' + meta.nombre + ' (' + meta.anio + ')'
      : 'Los 10 huracanes con más impacto según su mortalidad y pérdida económica';
    this._montarPantallaPrincipal(dest.id, token);
  },

  /* Detener playback + sonido de la tormenta activa: lo llama el routing al
   * salir y el selector al cambiar de huracán. */
  _pararPlayback() {
    const previa = this._estado;
    if (!previa) return;
    if (previa.raf) cancelAnimationFrame(previa.raf);
    previa.raf = null;
    previa.reproducido = false;
    previa.ultimoTs = null;
    this._conAudio('setReproduciendo', false);
  },

  /* limpieza del estado de la tormenta montada: los listeners registrados con
   * _al mueren aquí y el mapa se remueve ANTES de vaciar su contenedor, así
   * re-entrar a la ruta no dispara «Map container is already initialized». */
  _desmontar() {
    this._limpieza.forEach(fn => { try { fn(); } catch (e) { /* noop */ } });
    this._limpieza = [];
    if (this._estado && this._estado.raf) {
      cancelAnimationFrame(this._estado.raf);
      this._estado.raf = null;
    }
    this._estado = null;
    if (this._mapa) { this._mapa.destruir(); this._mapa = null; }
    this._paneles = null;
    const tip = document.getElementById('tooltip');
    if (tip) tip.classList.add('oculto');
  },

  /* registra limpieza ligada a la vista actual */
  _al(ev, fn) {
    window.addEventListener(ev, fn);
    this._limpieza.push(() => window.removeEventListener(ev, fn));
  },

  /* ===================== helpers de audio ===================== */

  _conAudio(metodo) {
    if (typeof MotorAudio === 'undefined' || !this.motor) return;
    try { this.motor[metodo].apply(this.motor, Array.prototype.slice.call(arguments, 1)); }
    catch (err) { console.warn('[vientovis] audio omitido (' + metodo + '):', err); }
  },

  /* ===================== notas de tocatierra ===================== */

  /* data/notas-tocatierras.json (un archivo para todas las tormentas) con
   * caché simple en memoria: una única carga por sesión. Si el fetch falla se
   * cachea el fallo y la vista sigue igual, sin notas. */
  _cargarNotas() {
    if (!this._notasPromesa) {
      this._notasPromesa = fetch('data/notas-tocatierras.json')
        .then(resp => (resp.ok ? resp.json() : {}))
        .catch(err => {
          console.warn('[vientovis] notas de tocatierra no disponibles:', err);
          return {};
        });
    }
    return this._notasPromesa;
  },

  /* ===================== PANTALLA PRINCIPAL ===================== */

  async _montarPantallaPrincipal(id, token) {
    const main = document.getElementById('vista');
    const frase = Datos.frasePotenciaImpacto(); // computada del índice en runtime

    main.innerHTML =
      '<section class="inicio">' +
      '<div class="hero">' +
      '<h1 class="hero-titulo">Los 10 huracanes con <em>más impacto</em> según su mortalidad y pérdida económica</h1>' +
      '<div class="hero-lateral">' +
      '<p class="hero-lede">Los daños ocasionados por los huracanes más relevantes de la actualidad, medidos según la cantidad de víctimas, la destrucción de propiedades y sus costos.</p>' +
      '<p class="hero-frase" id="hero-frase"></p>' +
      '</div>' +
      '</div>' +
      '<nav class="selec" aria-label="Huracanes, ordenados por muertes">' +
      '<p class="selec-etiqueta mono">Orden por <b>muertes, no por potencia</b> · elige un huracán' +
      '<span class="selec-clave mono"><i aria-hidden="true"></i>barra: muertes relativas</span></p>' +
      '<ol class="selec-lista" id="selec-lista"></ol>' +
      '</nav>' +
      '<div class="tor-raiz" id="tor-raiz"></div>' +
      '</section>';

    /* frase editorial: textContent (nada se inyecta tal cual) */
    const elFrase = document.getElementById('hero-frase');
    if (elFrase) elFrase.textContent = frase ||
      'La potencia no predice el impacto: en esta selección, las muertes y la categoría máxima no siempre van de la mano.';

    this._pintaSelector(id);
    await this._montarTormenta(id, document.getElementById('tor-raiz'), token);
  },

  /* Fichas del selector: ordenadas por MUERTES descendente (el impacto manda);
   * el chip de categoría es discreto y la barra codifica muertes relativas
   * (NUNCA la categoría), así los desbalances potencia/impacto se ven solos. */
  _pintaSelector(idActivo) {
    const ol = document.getElementById('selec-lista');
    if (!ol) return;
    const orden = Datos.ordenPorMuertes();
    const maxMuertes = orden.reduce((m, t) => Math.max(m, +t.muertes_total || 0), 1);

    ol.innerHTML = orden.map((t, i) => {
      const activo = t.id === idActivo;
      const pct = Math.round(((+t.muertes_total || 0) / maxMuertes) * 100);
      return '<li class="selec-item"><button type="button" class="selec-tarjeta' + (activo ? ' activo' : '') + '"' +
        ' data-id="' + t.id + '"' + (activo ? ' aria-current="true"' : '') +
        ' title="' + t.nombre + ' ' + t.anio + ' · Cat ' + t.cat_pico + ' · ' +
        Datos.fmtEntero(t.muertes_total) + ' muertes · ' + Datos.fmtUSDCorto(t.danos_total_usd) + ' en daños">' +
        '<span class="selec-sup"><span class="selec-rango mono">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="selec-nombre">' + t.nombre + '</span>' +
        '<span class="selec-anio mono">' + t.anio + '</span></span>' +
        '<span class="selec-medias"><span class="chip chip-mini chip-cat-' + t.cat_pico + '">Cat ' + t.cat_pico + '</span>' +
        '<span class="selec-muertes">' + Datos.fmtEntero(t.muertes_total) + '<span class="selec-unidad">muertes</span></span></span>' +
        '<span class="selec-colas"><span class="selec-danos">' + Datos.fmtUSDCorto(t.danos_total_usd) +
        '<span class="selec-unidad">daños</span></span></span>' +
        '<span class="selec-barra" aria-hidden="true"><i style="width:' + pct + '%"></i></span>' +
        '</button></li>';
    }).join('');

    ol.querySelectorAll('.selec-tarjeta').forEach(b => {
      b.addEventListener('click', () => this.seleccionarTormenta(b.getAttribute('data-id')));
    });
  },

  /* cambiar de huracán desde el selector: sin recarga del documento ni
   * entrada al historial (replaceState), solo re-render de la vista */
  async seleccionarTormenta(id) {
    const meta = Datos.porId(id);
    if (!meta || !this._raizTormenta) return;
    if (this._estado && this._estado.id === id) return;
    this._pararPlayback();
    this._desmontar();
    const token = ++this._token;
    try { history.replaceState(null, '', '#tormenta/' + id); } catch (e) { /* file:// etc */ }
    document.title = 'Vientovis — ' + meta.nombre + ' (' + meta.anio + ')';
    this._marcarSelector(id);
    await this._montarTormenta(id, this._raizTormenta, token);
  },

  /* estado activo del selector (tarjeta + aria-current; en la tira con
   * desbordamiento de móvil, centra la tarjeta activa) */
  _marcarSelector(id) {
    document.querySelectorAll('.selec-tarjeta').forEach(b => {
      const activo = b.getAttribute('data-id') === id;
      b.classList.toggle('activo', activo);
      if (activo) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    const lista = document.getElementById('selec-lista');
    const activa = lista ? lista.querySelector('.selec-tarjeta.activo') : null;
    if (activa && lista.scrollWidth > lista.clientWidth + 2) {
      try { activa.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); } catch (e) { /* noop */ }
    }
  },

  async _esperaRuta(token) {
    if (token !== this._token) return false;
    await new Promise(r => setTimeout(r, 0));
    return token === this._token;
  },

  /* ===================== VISTA TORMENTA (se monta en la portada) ===================== */

  async _montarTormenta(id, raiz, token) {
    const meta = Datos.porId(id);
    this._raizTormenta = raiz || null;
    if (!meta || !raiz) return;
    raiz.innerHTML = '<p class="cargando mono">Cargando ' + meta.nombre + '…</p>';
    let tor, notasTodas;
    try {
      /* las notas de tocatierra (archivo único, cacheado) viajan en paralelo
       * con la tormenta; su carga nunca lanza: sin archivo o sin id para la
       * tormenta se sigue sin notas */
      [tor, notasTodas] = await Promise.all([Datos.tormenta(id), this._cargarNotas()]);
    } catch (err) {
      raiz.innerHTML = '<section class="carga-error"><h1>No se pudo cargar la tormenta</h1><p class="mono">' + (err.message || err) + '</p></section>';
      return;
    }
    if (!(await this._esperaRuta(token))) return;

    const puntos = tor.puntos;
    const tocas = Datos.puntosTocatierra(puntos);
    const tramosIR = Datos.tramosIR(puntos);
    const s = this._estado = {
      id: id, meta: meta, puntos: puntos,
      notas: (notasTodas && notasTodas[id]) || [], // notas de tocatierra: paneles (eje X) y ticker
      iActivo: 0, reproducido: false, vel: 0.25, // ×0,25 FIJO (sin selector): 6 h ≈ 2 s
      fichaAbierta: false,
      simT: +puntos[0].d, raf: null, ultimoTs: null, tooltipAnclado: false,
      z: { modo: null } // coreografía de zoom (C4): 'inicio'|'seguir' (sin zoom profundo)
    };
    /* ticker narrativo: línea de inicio + sucesos derivados de los puntos,
     * calculados UNA vez al montar la tormenta */
    s.lineaInicio = this._lineaInicioSucesos(s);
    s.sucesos = this._construirSucesos(s);

    /* cabecera: la cifra de daños se parte en VALOR fuerte + unidad en gris
     * («mil M» / «M») + etiqueta («daños»), para que la unidad nunca se funda
     * con la etiqueta en una sola corrida («$125 mil M daños»). */
    const danosCab = Datos.fmtUSDCorto(meta.danos_total_usd);
    const mDanos = /^(\$[\d.,]+)\s*(.*)$/.exec(danosCab) || [danosCab, danosCab, ''];
    const unidadDanos = String(mDanos[2] || '').trim();

    raiz.innerHTML =
      '<section class="tormenta">' +
      '<div class="tormenta-cabecera">' +
      '<h2 class="tormenta-titulo">' + meta.nombre + ' <span class="tormenta-anio">' + meta.anio + '</span></h2>' +
      '<span class="chip chip-intensidad chip-cat-' + meta.cat_pico + '">Cat ' + meta.cat_pico + '</span>' +
      '<div class="tormenta-stats mono">' +
      '<span class="ts-item"><b>' + Datos.fmtEntero(meta.muertes_total) + '</b> muertes</span>' +
      '<span class="ts-item"><b>' + mDanos[1] + '</b>' +
      (unidadDanos ? '<span class="ts-unidad">' + unidadDanos + '</span>' : '') +
      ' daños</span>' +
      '<span class="ts-item"><b>' + tocas.length + '</b> tocatier' + (tocas.length === 1 ? 'ra' : 'ras') + '</span>' +
      '<span class="ts-item"><b>' + tramosIR.length + '</b> tramo' + (tramosIR.length === 1 ? '' : 's') + ' IR</span>' +
      '</div>' +
      '</div>' +
      /* reproductor: barra superior de la vista tormenta (por encima del mapa y los paneles) */
      '<div class="reproductor" id="reproductor">' +
      '<button type="button" id="btn-play" class="btn btn-primario" aria-label="Reproducir la tormenta · ×0,25 (6 h ≈ 2 s)">Reproducir</button>' +
      '<input type="range" id="scrubber" class="scrubber" min="0" max="' + (puntos.length - 1) + '" step="1" value="0" aria-label="Línea de tiempo de la tormenta · ×0,25 (6 h ≈ 2 s)" aria-valuemin="0" aria-valuemax="' + (puntos.length - 1) + '">' +
      '<div class="audio-grupo">' +
      '<button type="button" id="btn-audio" class="btn">Activar sonido</button>' +
      '<div class="audio-extra oculto" id="audio-extra">' +
      '<button type="button" id="btn-mudo" class="btn" aria-pressed="false">Silenciar</button>' +
      '<input type="range" id="volumen" class="volumen" min="0" max="1" step="0.01" value="0.7" aria-label="Volumen del sonido">' +
      '</div></div>' +
      '<p class="rep-valores" id="rep-valores" aria-live="off"></p>' +
      '</div>' +
      '<div class="tormenta-cuerpo">' +
      '<div class="tormenta-mapa" id="tor-mapa">' +
      '<div class="reloj-mapa" id="reloj-mapa" role="group" aria-label="Fecha y hora UTC del punto activo">' + Datos.fmtReloj(puntos[0].d) + '</div>' +
      /* intensidad + viento del punto activo: overlay superior central, misma
       * vía de actualización que contador/reloj (_actualizarPunto). Aquí el
       * viento se muestra en km/h (no en kt). */
      '<div class="viento-mapa" id="viento-mapa" role="group" aria-label="Categoría y viento en km/h del punto activo">' +
      '<span id="vm-cat"></span><span class="vm-sep" aria-hidden="true">·</span><span id="vm-kt">—</span>' +
      '</div>' +
      '<div class="contador-impacto" id="contador-impacto" role="group" aria-label="Acumulados del punto activo">' +
      '<div class="ci-fila"><span class="ci-etq">Muertes:</span><span class="ci-cifra ci-muertes" id="ci-muertes">—</span></div>' +
      '<div class="ci-fila"><span class="ci-etq">Daños:</span><span class="ci-cifra ci-danos" id="ci-danos">—</span></div>' +
      '</div>' +
      '<div class="leyenda-categorias" aria-label="Leyenda de categoría Saffir–Simpson">' +
      '<span class="li"><span class="cuadr" style="background:' + Datos.colorCat(0) + '"></span>T.T./TD</span>' +
      [1, 2, 3, 4, 5].map(c => '<span class="li"><span class="cuadr" style="background:' + Datos.colorCat(c) + '"></span>' + c + '</span>').join('') +
      '</div>' +
      /* barra de noticias de TV al pie del mapa: último SUCESO narrativo del
       * huracán con índice ≤ el punto activo (misma vía que contador/reloj-mapa:
       * _actualizarPunto) */
      '<div class="ticker-noticias" id="ticker" role="group" aria-label="Última actualización del huracán">' +
      '<span class="ticker-chip mono" id="ticker-chip"><i class="ticker-punto" aria-hidden="true"></i><span id="ticker-chip-texto">En pausa</span></span>' +
      '<span class="ticker-cuerpo" id="ticker-cuerpo"><span class="ticker-texto" id="ticker-texto" role="note" tabindex="0"></span></span>' +
      '</div>' +
      /* tooltip del MENSAJE COMPLETO del ticker (hover/foco del texto): mismo
       * vidrio que .nota-tocatierra, anclado SOBRE la barra dentro del mapa y
       * sin capturar el puntero; el texto completo vive también en aria-label */
      '<div class="nota-tocatierra ticker-tip oculto" id="ticker-tip" aria-hidden="true">' +
      '<p class="nt-nota" id="ticker-tip-texto"></p></div>' +
      '<div class="ficha-flotante oculto" id="ficha" role="group" aria-label="Ficha del punto activo">' +
      '<div class="ficha-cab"><h3 class="ficha-titulo">Ficha del punto</h3>' +
      '<button type="button" id="btn-cerrar-ficha" class="ficha-cerrar" aria-label="Cerrar ficha" title="Cerrar ficha">✕</button></div>' +
      '<div id="ficha-cuerpo"></div>' +
      '</div>' +
      '</div>' +
      '<div class="tormenta-paneles" id="tor-paneles"></div>' +
      '</div>' +
      '</section>';

    /* --- paneles + mapa --- */
    const colMapa = document.getElementById('tor-mapa');
    const colPaneles = document.getElementById('tor-paneles');
    this._paneles = Paneles.crearPanelTormenta(colPaneles, {
      puntos: puntos,
      notas: s.notas,
      alHover: (i, ev) => this._setHover(i, ev),
      alSalida: () => this._salidaHover(),
      alFija: i => this._alFijar(i)
    });

    this._mapa = MapaTormenta.crear(colMapa, {
      puntos: puntos,
      notas: (notasTodas && notasTodas[id]) || [], // notas de tocatierra de esta tormenta
      alPasarPorEncima: (i, ev) => this._setHover(i, ev),
      alSalirDelHover: () => this._salidaHover(),
      alHacerClicEnPunto: i => this._alClicPunto(i)
    });

    /* Altura del mapa: relativa al viewport (encoge en portátiles bajos para
     * que la visualización quepa en una pantalla) y acotada por la columna de
     * paneles: sus alturas SVG son fijas (paneles.js), así que un mapa más
     * bajo que ellos dejaría un vacío a la izquierda. */
    const fijaAltura = () => {
      if (!this._estado) return;
      if (window.innerWidth >= 1024) {
        const porVista = Math.max(340, Math.min(700, Math.round((window.innerHeight || 900) * 0.9)));
        const porPaneles = Math.max(430, colPaneles.offsetHeight || 600);
        colMapa.style.height = Math.min(porVista, porPaneles) + 'px';
      } else {
        colMapa.style.height = '430px';
      }
      this._mapa.invalidateSize();
      if (this._mapa.reencuadrar) this._mapa.reencuadrar(); // encuadre ajustado a la altura final
    };
    fijaAltura();
    const tt0 = setTimeout(fijaAltura, 80);
    this._limpieza.push(() => clearTimeout(tt0));

    /* redibujar en resize (con pequeña espera) */
    this._al('resize', (() => {
      let t; return () => {
        clearTimeout(t);
        t = setTimeout(() => { fijaAltura(); if (this._estado) { this._paneles = Paneles.crearPanelTormenta(colPaneles, { puntos: puntos, notas: s.notas, alHover: (i, ev) => this._setHover(i, ev), alSalida: () => this._salidaHover(), alFija: i => this._alFijar(i) }); this._paneles.setActivo(s.iActivo); } }, 160);
      };
    })());

    /* --- reproductor --- */
    const btnPlay = document.getElementById('btn-play');
    const scrubber = document.getElementById('scrubber');
    const repValores = document.getElementById('rep-valores');

    this._refs = { btnPlay: btnPlay, scrubber: scrubber, repValores: repValores, relojMapa: document.getElementById('reloj-mapa'), vmCat: document.getElementById('vm-cat'), vmKt: document.getElementById('vm-kt'), tickerTexto: document.getElementById('ticker-texto'), tickerCuerpo: document.getElementById('ticker-cuerpo'), tickerChip: document.getElementById('ticker-chip'), tickerChipTexto: document.getElementById('ticker-chip-texto'), tickerTip: document.getElementById('ticker-tip'), tickerTipTexto: document.getElementById('ticker-tip-texto'), ficha: document.getElementById('ficha'), fichaCuerpo: document.getElementById('ficha-cuerpo'), ciMuertes: document.getElementById('ci-muertes'), ciDanos: document.getElementById('ci-danos') };

    /* Tooltip del mensaje completo del ticker: hover sobre la zona del texto
     * (la barra entera, chip incluido, sigue sin capturar clics) y foco de
     * teclado del propio texto truncado. */
    if (this._refs.tickerCuerpo) {
      const cuerpo = this._refs.tickerCuerpo;
      cuerpo.addEventListener('mouseenter', () => this._tickerTipMostrar());
      cuerpo.addEventListener('mouseleave', () => {
        if (!cuerpo.contains(document.activeElement)) this._tickerTipOcultar();
      });
      cuerpo.addEventListener('focusin', () => this._tickerTipMostrar());
      cuerpo.addEventListener('focusout', (ev) => {
        if (!cuerpo.contains(ev.relatedTarget)) this._tickerTipOcultar();
      });
    }

    this._pintarChipTicker(); // estado de carga (sin reproducción): «En pausa»

    btnPlay.addEventListener('click', () => s.reproducido ? this._pausar() : this._reproducir());
    scrubber.addEventListener('pointerdown', () => { if (s.reproducido) this._pausar(); });
    scrubber.addEventListener('input', () => {
      const destino = +scrubber.value; // leer antes: _pausar() reescribe el valor del range
      this._pausar();
      this._salirDeCoreo(); // scrub: cámara al encuadre base, solo mueve el marcador
      this._setActivo(destino);
    });
    this._al('keydown', ev => { if (ev.key === 'Escape') this._cerrarFicha(); });

    /* --- ficha --- */
    document.getElementById('btn-cerrar-ficha').addEventListener('click', () => this._cerrarFicha());

    /* --- audio --- */
    this._cablearAudio();

    /* --- estado inicial --- */
    this._setActivo(0);
  },

  /* --- cablear botones/slider del motor de audio (defensivo por diseño) --- */
  _cablearAudio() {
    const btn = document.getElementById('btn-audio');
    const extra = document.getElementById('audio-extra');
    const btnMudo = document.getElementById('btn-mudo');
    const vol = document.getElementById('volumen');
    if (!btn) return;

    if (typeof MotorAudio === 'undefined') {
      btn.disabled = true;
      btn.textContent = 'Sonido no disponible';
      btn.title = 'js/motor-audio.js no se cargó';
      if (extra) extra.classList.add('oculto');
      return;
    }
    if (!this.motor) this.motor = new MotorAudio();

    if (this.motor.iniciado) {
      btn.classList.add('oculto');
      if (extra) {
        extra.classList.remove('oculto');
        if (btnMudo) {
          btnMudo.textContent = this._mudo ? 'Quitar silencio' : 'Silenciar';
          btnMudo.setAttribute('aria-pressed', String(this._mudo));
        }
        if (vol) vol.value = String(this._volumen);
      }
    } else {
      btn.classList.remove('oculto');
      btn.disabled = false;
      btn.textContent = 'Activar sonido';
      btn.title = 'Sonificación dirigida por los datos (requiere gesto)';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Activando…';
        try {
          await this.motor.iniciar();
          this._conAudio('setVolumen', this._volumen);
          this._conAudio('setMudo', this._mudo);
          btn.classList.add('oculto');
          if (extra) extra.classList.remove('oculto');
        } catch (err) {
          btn.textContent = 'Sonido no disponible';
          btn.title = String(err.message || err);
          console.warn('[vientovis] iniciar() fallo:', err);
        }
      });
    }

    if (btnMudo) {
      btnMudo.addEventListener('click', () => {
        this._mudo = !this._mudo;
        this._conAudio('setMudo', this._mudo);
        btnMudo.textContent = this._mudo ? 'Quitar silencio' : 'Silenciar';
        btnMudo.setAttribute('aria-pressed', String(this._mudo));
      });
    }
    if (vol) {
      vol.addEventListener('input', () => {
        this._volumen = +vol.value;
        this._conAudio('setVolumen', this._volumen);
      });
    }
  },

  /* --- playback --- */

  _reproducir() {
    const s = this._estado;
    if (!s) return;
    const n = s.puntos.length;
    if (s.iActivo >= n - 1) this._setActivo(0);
    /* SOLO al pulsar Reproducir: deja la visualización completa en pantalla
     * (si ya lo está, sin scroll) antes de arrancar la animación */
    this._scrollAVista();
    s.reproducido = true;
    s.ultimoTs = null;
    s.simT = +s.puntos[s.iActivo].d;
    const btn = document.getElementById('btn-play');
    if (btn) {
      btn.textContent = 'Pausar';
      btn.setAttribute('aria-label', 'Pausar la reproducción · ×0,25 (6 h ≈ 2 s)');
      btn.classList.add('reproduciendo'); // CSS: estado pause neutro, sin sub-pulso
    }
    this._pintarChipTicker();
    this._seguroTooltipOcultar();
    this._conAudio('setReproduciendo', true);
    this._coreoInicio(); // C4: zoom de arranque y, desde ahí, seguimiento del punto activo
    /* Arranque instantáneo: el rAF se agenda aquí mismo, sin setTimeout ni
     * esperas; la coreografía de zoom corre EN PARALELO dentro del mapa y el
     * primer _tick ya avanza reloj/marcador aunque el flyTo siga en curso. */
    s.raf = requestAnimationFrame(ts => this._tick(ts));
  },

  /* Scroll al nivel de la visualización (.tormenta) al pulsar Reproducir:
   * solo si la sección no está YA completa en pantalla; suave, salvo con
   * prefers-reduced-motion (instantáneo). El snap de la sección la centra. */
  _scrollAVista() {
    const sec = document.querySelector('.tormenta');
    if (!sec) return;
    const r = sec.getBoundingClientRect();
    const alto = window.innerHeight || document.documentElement.clientHeight || 0;
    if (r.top >= -2 && r.bottom <= alto + 2) return; // ya visible del todo
    const reduce = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try { sec.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); } catch (e) { /* noop */ }
  },

  _pausar() {
    const s = this._estado;
    if (!s) return;
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = null; }
    s.reproducido = false;
    s.ultimoTs = null;
    const btn = document.getElementById('btn-play');
    if (btn) {
      btn.textContent = 'Reproducir';
      btn.setAttribute('aria-label', 'Reproducir la tormenta · ×0,25 (6 h ≈ 2 s)');
      btn.classList.remove('reproduciendo');
    }
    this._pintarChipTicker();
    this._conAudio('setReproduciendo', false);
    this._setActivo(s.iActivo, true); // re-aplica el crosshair al punto activo (sin audio)
  },

  _tick(ts) {
    const s = this._estado;
    if (!s || !s.reproducido) return;
    const n = s.puntos.length;
    const dt = s.ultimoTs == null ? 16.7 : Math.min(150, ts - s.ultimoTs);
    s.ultimoTs = ts;
    /* ×0,25 FIJO (sin selector): un paso de 6 h de tormenta (21 600 000 ms)
     * cada 2 s reales, la mitad del paso-base de 0,5× (6 h por segundo) */
    s.simT += dt * (s.vel / 0.5) * (21600000 / 1000);

    const iPrevio = s.iActivo;
    let i = s.iActivo;
    while (i < n - 1 && +s.puntos[i + 1].d <= s.simT) {
      i++;
      this._setActivo(i);
    }
    if (i !== iPrevio) this._coreoPorPunto(i); // C4: acompañar el punto activo (tocatierras incluidos)
    if (i >= n - 1 && s.simT >= +s.puntos[n - 1].d) {
      s.simT = +s.puntos[n - 1].d;
      this._pausar(); // llegó al final
      s.z.modo = null;
      if (this._mapa && this._mapa.panorama) this._mapa.panorama(0.9); // fin: vuelve al trayecto
      return;
    }

    const p = s.puntos[i], q = s.puntos[i + 1];
    const frac = q ? Math.max(0, Math.min(1, (s.simT - (+p.d)) / (+q.d - (+p.d)))) : 0;
    this._setInterp(i, frac);
    /* Deslizamiento del huracán en cada frame con el mismo i/frac que el reloj
     * (en selección discreta sigue mandando setPuntoActivo vía _setActivo).
     * La cámara acompaña la posición interpolada solo en modo 'seguir': durante
     * la intro de zoom (modo 'inicio') manda la animación de zoomInicio. */
    if (this._mapa) {
      if (this._mapa.setPuntoInterp) this._mapa.setPuntoInterp(i, frac);
      /* Rotación de la imagen del huracán: el ángulo acumula con el dt REAL de
       * este frame y la ω del viento INTERPOLADO que acaba de fijar
       * setPuntoInterp (sentido antihorario en mapa.js). Fuera del playback no
       * se llama: el ángulo queda congelado, no se reinicia. */
      if (this._mapa.avanzarRotacion) this._mapa.avanzarRotacion(dt);
      if (s.z.modo === 'seguir' && this._mapa.seguir) this._mapa.seguir(i, frac);
    }

    s.raf = requestAnimationFrame(t2 => this._tick(t2));
  },

  /* --- cambios de punto activo / hover --- */

  _setActivo(i, sinAudio) {
    const s = this._estado;
    if (!s) return;
    const puntos = s.puntos;
    s.iActivo = Math.max(0, Math.min(puntos.length - 1, i));
    s.simT = +puntos[s.iActivo].d;

    if (this._paneles) this._paneles.setActivo(s.iActivo);
    this._actualizarPunto(s.iActivo);

    const p = puntos[s.iActivo];
    const ant = s.iActivo > 0 ? puntos[s.iActivo - 1] : null;
    const refs = this._refs || {};
    if (refs.scrubber) {
      refs.scrubber.value = String(s.iActivo);
      const pct = puntos.length > 1 ? s.iActivo / (puntos.length - 1) * 100 : 0;
      refs.scrubber.style.background = 'linear-gradient(to right, var(--acento) ' + pct + '%, var(--linea) ' + pct + '%)';
      refs.scrubber.setAttribute('aria-valuenow', String(s.iActivo));
      refs.scrubber.setAttribute('aria-valuetext', Datos.fmtReloj(p.d));
    }
    if (refs.repValores) refs.repValores.innerHTML = this._htmlValores(p, ant);
    if (s.fichaAbierta) this._pintaFicha();

    if (!sinAudio) this._conAudio('actualizar', p, ant);
  },

  /* Marcador del mapa + contador de acumulados + reloj UTC + indicador de
   * viento + ticker: SIEMPRE por la misma vía (playback, scrub, hover, ficha)
   * para que nunca se desincronicen. */
  _actualizarPunto(i) {
    if (this._mapa) this._mapa.setPuntoActivo(i);
    this._pintarContador(i);
    this._pintarRelojMapa(i);
    this._pintarVientoMapa(i);
    this._pintarTicker(i);
  },

  /* Fecha/hora UTC del punto activo en el overlay superior izquierdo del mapa
   * (mismo vidrio que el contador); durante el playback la interpola _setInterp. */
  _pintarRelojMapa(i) {
    const s = this._estado;
    if (!s || !this._refs || !this._refs.relojMapa) return;
    const p = s.puntos[i];
    if (p) this._refs.relojMapa.textContent = Datos.fmtReloj(p.d);
  },

  /* Intensidad y viento del punto activo en el overlay superior central del
   * mapa (misma vía que contador/reloj). El viento es el del punto activo —el
   * mismo que muestra la línea de valores del reproductor— y la categoría no
   * se interpola: cambia solo al cambiar de punto. El viento va en km/h
   * (kt × 1,852, sin decimales): única vista en km/h, decisión de usuario; el
   * id `vm-kt` se conserva como ancla del DOM. En cat 0 (T. tropical/TD)
   * se usa etiqueta textual sin chip rojo, como la leyenda. */
  _pintarVientoMapa(i) {
    const s = this._estado;
    const refs = this._refs;
    if (!s || !refs || !refs.vmCat || !refs.vmKt) return;
    const p = s.puntos[i];
    if (!p) return;
    if (refs.vmKt.dataset.i === String(i)) return; // playback a 60 fps: ya pintado
    refs.vmKt.dataset.i = String(i);
    const cat = Math.max(0, Math.min(5, p.cat_ss | 0));
    if (cat >= 1) {
      refs.vmCat.className = 'chip chip-mini chip-intensidad chip-cat-' + cat;
      refs.vmCat.textContent = 'Cat ' + cat;
    } else {
      refs.vmCat.className = 'vm-cat-texto';
      refs.vmCat.textContent = 'T.T./TD'; // etiqueta de la leyenda, sin chip rojo
    }
    refs.vmKt.textContent = Math.round((+p.viento_kt || 0) * KT_A_KMH) + ' km/h';
  },

  /* Acumulados del punto activo en el overlay superior derecho del mapa
   * (formatos es-ES ya existentes: 1.004 muertes · $33,6 mil M USD). */
  _pintarContador(i) {
    const s = this._estado;
    if (!s || !this._refs) return;
    const p = s.puntos[i];
    if (!p) return;
    if (this._refs.ciMuertes) this._refs.ciMuertes.textContent = Datos.fmtEntero(p.muertes_acum);
    if (this._refs.ciDanos) this._refs.ciDanos.textContent = Datos.fmtUSD(p.danos_acum_usd);
  },

  /* ============ ticker narrativo: sucesos del huracán ============ */

  /* Chip del ticker: «En vivo» SOLO mientras se reproduce (tinte de acento y
   * punto latente); con el playback pausado o recién cargado queda «En pausa»
   * con tinte neutro y sin punto. Se ata a la MISMA condición que la clase
   * .reproduciendo del botón play (s.reproducido). */
  _pintarChipTicker() {
    const s = this._estado;
    const chip = this._refs && this._refs.tickerChip;
    if (!chip) return;
    const vivo = !!(s && s.reproducido);
    chip.classList.toggle('vivo', vivo);
    const txt = this._refs.tickerChipTexto;
    if (txt) txt.textContent = vivo ? 'En vivo' : 'En pausa';
  },

  /* Sucesos narrativos de la tormenta: UNA lista calculada al montar (derivada
   * de s.puntos, EN ORDEN): (a) transiciones de estatus/categoría, (b)
   * tocatierras (nota 1:1 de data/notas-tocatierras.json o aviso genérico),
   * (c) pico de intensidad (único, notable y sin repetir la categoría que una
   * intensificación contigua acaba de anunciar) y (d) cierre con los totales.
   * Como máximo un suceso por índice: en puntos contiguos nunca se solapa
   * contenido (los sucesos se derivan de TRANSICIONES, no de cada punto). */
  _construirSucesos(s) {
    const puntos = s.puntos;
    const n = puntos.length;
    const nombre = s.meta.nombre;
    const eventos = new Map(); // índice de punto → {texto, tipo, cat}
    const catTxt = c => Datos.fmtCatCorto(Math.max(0, Math.min(5, c | 0)));
    const pon = (i, texto, tipo, cat) => { eventos.set(i, { texto: texto, tipo: tipo, cat: cat }); };

    /* (a) transiciones de estatus/categoría: una por CAMBIO, nunca por punto */
    for (let i = 1; i < n; i++) {
      const a = puntos[i - 1], b = puntos[i];
      const estA = a.estatus, estB = b.estatus;
      const catA = Math.max(0, a.cat_ss | 0), catB = Math.max(0, b.cat_ss | 0);
      if (estA === estB && catA === catB) continue;
      let texto = null;
      let tipo = 'trans';
      if (estB === 'TD') {
        /* vuelta a depresión desde TS/HU → se degrada; organización desde un
         * sistema no tropical (EX/WV/DB) → se organizan (formación) */
        texto = (estA === 'TS' || estA === 'HU')
          ? nombre + ' se degrada a depresión tropical'
          : 'se organizan como depresión tropical';
      } else if (estB === 'TS') {
        texto = (estA === 'HU')
          ? nombre + ' decae a tormenta tropical'
          : nombre + ' avanza como tormenta tropical';
      } else if (estB === 'HU') {
        if (estA === 'HU') {
          tipo = catB > catA ? 'intensifica' : 'decae';
          texto = nombre + (catB > catA ? ' se intensifica a ' : ' decae a ') + catTxt(catB);
        } else {
          tipo = 'intensifica';
          texto = nombre + ' eleva su estado a ' + catTxt(catB) + ' y se vuelve huracán';
        }
      } else if (estB === 'EX' || estB === 'LO') {
        if (estA === 'EX' || estA === 'LO') continue; // ya postropical: sin suceso
        texto = nombre + (estB === 'EX' ? ' se vuelve post-tropical' : ' pierde características tropicales');
      } else {
        /* DB/WV/otros: sistema no tropical en disipación */
        if (estA === 'EX' || estA === 'LO' || estA === 'DB' || estA === 'WV') continue;
        texto = nombre + ' pierde características tropicales';
      }
      if (texto) pon(i, texto, tipo, catB);
    }

    /* (b) tocatierras: cada nota se empareja 1:1 con su tocatierra más cercano
     * (±2 h, mismo criterio que mapa y paneles); sin nota, aviso genérico que
     * nunca pisa un suceso más relevante del mismo punto */
    const notas = this._normalizarNotasToca(s.notas);
    const UMBRAL_NOTA_MS = 2 * 3600 * 1000;
    const conNota = new Map(); // índice → nota
    notas.forEach(nota => {
      let mejor = -1, mejorDist = Infinity;
      puntos.forEach((p, i) => {
        if (!p.tocatierra) return;
        const dist = Math.abs(+p.d - nota.tMs);
        if (dist < mejorDist) { mejorDist = dist; mejor = i; }
      });
      if (mejor >= 0 && mejorDist <= UMBRAL_NOTA_MS) conNota.set(mejor, nota);
    });
    puntos.forEach((p, i) => {
      if (!p.tocatierra) return;
      const cat = Math.max(0, Math.min(5, p.cat_ss | 0));
      const nota = conNota.get(i);
      if (nota) {
        pon(i, 'toca tierra en ' + nota.lugar + ' (' + catTxt(cat) + '): ' + nota.nota, 'nota', cat);
      } else if (!eventos.has(i)) {
        pon(i, 'toca tierra como ' + Datos.fmtEstatus(p.estatus) + (cat >= 1 ? ' (' + catTxt(cat) + ')' : ''), 'toca', cat);
      }
    });

    /* (c) pico de intensidad: un ÚNICO suceso, solo si el punto es notable
     * (cat ≥ la de sus vecinos); si una intensificación CONTIGUA ya anunció
     * esa misma categoría, el pico la deja obsoleta (dedupe: sin contenido
     * repetido en puntos contiguos; el pico informa kt y cat). Nunca pisa una
     * nota del mismo punto. */
    const pico = Datos.pico(puntos);
    if (pico) {
      const ip = puntos.indexOf(pico);
      const catP = Math.max(0, Math.min(5, pico.cat_ss | 0));
      const catAnt = Math.max(0, Math.min(5, puntos[ip - 1].cat_ss | 0));
      const catSig = Math.max(0, Math.min(5, puntos[ip + 1].cat_ss | 0));
      const yaHay = eventos.get(ip);
      if (ip > 0 && ip < n - 1 && catP >= catAnt && catP >= catSig && !(yaHay && yaHay.tipo === 'nota')) {
        const vecino = eventos.get(ip - 1);
        if (vecino && vecino.tipo === 'intensifica' && vecino.cat === catP) eventos.delete(ip - 1);
        pon(ip, nombre + ' alcanza su pico: ' + pico.viento_kt + ' kt (' + catTxt(catP) + ')', 'pico', catP);
      }
    }

    /* (d) cierre: totales del último punto, solo al llegar al final */
    const fin = puntos[n - 1];
    pon(n - 1, 'El paso de ' + nombre + ' ha provocado daños por ' + Datos.fmtUSD(fin.danos_acum_usd) +
      ' y ' + Datos.fmtEntero(fin.muertes_acum) + ' muertes.', 'fin', 0);

    /* en orden de índice y con la fecha/hora UTC delante (helpers de datos.js) */
    return Array.from(eventos.keys()).sort((a, b) => a - b).map(i => ({
      i: i,
      tipo: eventos.get(i).tipo,
      texto: Datos.fmtReloj(puntos[i].d) + ' — ' + eventos.get(i).texto
    }));
  },

  /* Línea de inicio del ticker (antes del primer suceso): nombre, fecha y
   * estado de formación del primer punto. */
  _lineaInicioSucesos(s) {
    const p = s.puntos[0];
    const estado = p.estatus === 'TD' ? 'depresión tropical en formación'
      : p.estatus === 'TS' ? 'tormenta tropical en formación'
      : p.estatus === 'HU' ? 'huracán en seguimiento'
      : 'sistema en seguimiento';
    return s.meta.nombre + ' · ' + Datos.fmtReloj(p.d) + ' · ' + estado;
  },

  /* Normaliza data/notas-tocatierras.json (mismo formato de entrada que
   * mapa.js/paneles.js) para emparejar notas con tocatierras en el ticker. */
  _normalizarNotasToca(lista) {
    return (Array.isArray(lista) ? lista : [])
      .map(n => ({
        tMs: +new Date(n.t),
        lugar: String(n.lugar == null ? '' : n.lugar),
        nota: String(n.nota == null ? '' : n.nota)
      }))
      .filter(n => Number.isFinite(n.tMs));
  },

  /* Última actualización del huracán en la barra de noticias al pie del mapa
   * (TV): SIEMPRE el último SUCESO con índice ≤ el punto activo — persiste
   * entre sucesos, el ticker ya no cambia punto a punto; antes del primer
   * suceso muestra la línea de inicio. Un slide corto por cambio de texto
   * (clase .entra; CSS, nunca marquee) y solo se repinta si el texto cambió
   * (hover/pausa no re-animan). El texto VISUAL se trunca con elipsis; el
   * mensaje COMPLETO va en aria-label (accesibilidad) y en el tooltip
   * flotante que abren hover/foco (ver _tickerTipMostrar). */
  _pintarTicker(i) {
    const s = this._estado;
    const el = this._refs && this._refs.tickerTexto;
    if (!s || !el) return;
    let texto = s.lineaInicio || '';
    const sucesos = s.sucesos || [];
    for (let k = 0; k < sucesos.length && sucesos[k].i <= i; k++) texto = sucesos[k].texto;
    if (el.getAttribute('aria-label') !== texto) el.setAttribute('aria-label', texto);
    if (el.textContent === texto) return;
    el.textContent = texto;
    el.classList.remove('entra');
    void el.offsetWidth; // reinicia la animación de entrada (un slide por suceso)
    el.classList.add('entra');
    /* con el tooltip abierto (hover o foco), el mensaje completo sigue al
     * texto vigente: el playback cambia de suceso sin cerrarlo */
    if (this._refs.tickerTip && !this._refs.tickerTip.classList.contains('oculto')) {
      this._tickerTipMostrar();
    }
  },

  /* Tooltip del MENSAJE COMPLETO del ticker: vidrio del proyecto (mismo
   * .nota-tocatierra que las notas de tocatierra), anclado 8 px SOBRE la barra
   * y alineado con el inicio del texto — no sigue al puntero porque la barra
   * es fija. Se mantiene dentro del mapa: el CSS acota el ancho y aquí se
   * acota el left al contenedor. textContent: el mensaje es dato, nunca HTML. */
  _tickerTipMostrar() {
    const refs = this._refs;
    if (!refs || !refs.tickerTip || !refs.tickerTipTexto || !refs.tickerTexto) return;
    const texto = (refs.tickerTexto.getAttribute('aria-label') || refs.tickerTexto.textContent || '').trim();
    if (!texto) return;
    const tip = refs.tickerTip;
    refs.tickerTipTexto.textContent = texto;
    tip.classList.remove('oculto');
    const cont = tip.offsetParent; // .tormenta-mapa (position: relative)
    if (!cont) return;
    const rTexto = refs.tickerTexto.getBoundingClientRect();
    const rCont = cont.getBoundingClientRect();
    const ancho = tip.offsetWidth || 260;
    const xMax = rCont.width - ancho - 8;
    const x = Math.max(8, Math.min(rTexto.left - rCont.left + 8, xMax));
    const y = rCont.bottom - rTexto.top + 8; // pie del mapa → borde superior del texto + aire
    tip.style.left = x + 'px';
    tip.style.bottom = y + 'px';
  },

  _tickerTipOcultar() {
    const tip = this._refs && this._refs.tickerTip;
    if (tip) tip.classList.add('oculto');
  },

  _setInterp(i, frac) {
    const s = this._estado;
    if (!s) return;
    this._paneles && this._paneles.setInterp(i, frac);
    const p = s.puntos[i], q = s.puntos[i + 1];
    const tInterp = q ? +p.d + (+q.d - +p.d) * frac : +s.puntos[s.puntos.length - 1].d;
    if (this._refs && this._refs.relojMapa) this._refs.relojMapa.textContent = Datos.fmtReloj(new Date(tInterp));
    this._pintarVientoMapa(i); // mismo punto que la línea de valores (sin interpolar)
  },

  _setHover(i, ev) {
    const s = this._estado;
    if (!s || s.reproducido) return;
    s.iHover = i;
    this._paneles && this._paneles.setHover(i);
    this._actualizarPunto(i);
    if (this._mapa) this._mapa.setHover(i);
    this._tooltipMostrar(s.puntos[i], ev);
  },

  _salidaHover() {
    const s = this._estado;
    if (!s || s.reproducido) return;
    s.iHover = null;
    this._paneles && this._paneles.limpiarHover();
    if (this._mapa) this._mapa.setHover(null);
    this._actualizarPunto(s.iActivo);
    this._tooltipOcultar();
  },

  /* clic de scrub en los paneles */
  _alFijar(i) {
    const s = this._estado;
    if (!s) return;
    if (s.reproducido) this._pausar();
    this._salirDeCoreo();
    this._setActivo(i);
  },

  /* clic en un punto del mapa: scrub + ficha fijada */
  _alClicPunto(i) {
    const s = this._estado;
    if (!s) return;
    if (s.reproducido) this._pausar();
    this._salirDeCoreo();
    this._setActivo(i);
    this._abrirFicha();
  },

  /* ============ coreografía de zoom del mapa (C4) ============
   * SOLO playback automático: ni hover ni scrub manual disparan cámara.
   * Sin zoom profundo: TODOS los puntos (tocatierras incluidos) se siguen al
   * mismo nivel constante; s.z.modo solo recuerda si la cámara quedó fuera del
   * encuadre base (para que el scrub/click sepan cuándo reencuadrar).
   * La velocidad fija ×0,25 escala el avance de datos, no las animaciones. */

  /* Zoom de arranque al pulsar Reproducir: zoom-in notable hacia el punto
   * actual (fitZoom+2, ~1 s). A partir de ahí NO hay retorno al panorama:
   * _coreoPorPunto acompaña el punto activo hasta el final. */
  _coreoInicio() {
    const s = this._estado;
    if (!s || !this._mapa || !this._mapa.zoomInicio) return;
    s.z.modo = 'inicio';
    this._mapa.zoomInicio(s.iActivo);
  },

  /* Por cada punto activo DURANTE el playback: seguir el punto con el zoom de
   * seguimiento CONSTANTE y sin animación (setView), tocatierras incluidos.
   * Nunca se vuelve al encuadre completo aquí: eso solo pasa al terminar la
   * reproducción o al hacer scrub. */
  _coreoPorPunto(i) {
    const s = this._estado;
    if (!s || !s.reproducido) return; // solo playback automático
    if (!this._mapa) return;
    if (!s.puntos[i]) return;
    s.z.modo = 'seguir';
    if (this._mapa.seguir) this._mapa.seguir(i);
  },

  /* Scrub manual (playback ya pausado): si la cámara quedó en coreografía
   * (intro o seguimiento), vuelve al encuadre base SIN animación — el scrub
   * solo mueve el marcador, como hoy. */
  _salirDeCoreo() {
    const s = this._estado;
    if (!s) return;
    const enCoreo = s.z.modo !== null;
    s.z.modo = null;
    if (enCoreo && this._mapa && this._mapa.reencuadrar) this._mapa.reencuadrar();
  },

  /* --- tooltip flotante (mapa y paneles) --- */

  _tooltipMostrar(p, ev) {
    const tip = document.getElementById('tooltip');
    if (!tip || !p) return;
    tip.innerHTML = this._htmlTooltip(p);
    tip.classList.remove('oculto');
    if (ev) {
      const margen = 16, anchoT = 250, altoT = 130;
      let x = ev.clientX + margen, y = ev.clientY + margen;
      if (x + anchoT > window.innerWidth) x = ev.clientX - anchoT - margen / 2;
      if (y + altoT > window.innerHeight) y = ev.clientY - altoT - margen / 2;
      tip.style.left = Math.max(6, x) + 'px';
      tip.style.top = Math.max(6, y) + 'px';
    }
  },

  _tooltipOcultar() {
    const tip = document.getElementById('tooltip');
    if (tip) tip.classList.add('oculto');
  },

  _seguroTooltipOcultar() { this._tooltipOcultar(); },

  /* --- ficha fijada (details on demand) --- */

  _abrirFicha() {
    const s = this._estado;
    if (!s) return;
    s.fichaAbierta = true;
    if (this._refs && this._refs.ficha) this._refs.ficha.classList.remove('oculto');
    this._pintaFicha();
  },

  _cerrarFicha() {
    const s = this._estado;
    if (!s) return;
    s.fichaAbierta = false;
    if (this._refs && this._refs.ficha) this._refs.ficha.classList.add('oculto');
  },

  _pintaFicha() {
    const s = this._estado;
    if (!s || !s.fichaAbierta || !this._refs) return;
    const p = s.puntos[s.iActivo];
    const ant = s.iActivo > 0 ? s.puntos[s.iActivo - 1] : null;
    const meta = s.meta;
    const pico = Datos.pico(s.puntos);
    const tocas = Datos.puntosTocatierra(s.puntos);
    const dMuertes = ant ? p.muertes_acum - ant.muertes_acum : 0;
    const dDanos = ant ? p.danos_acum_usd - ant.danos_acum_usd : 0;
    const cat = Math.max(0, Math.min(5, p.cat_ss | 0));
    const chipCls = cat >= 1 ? 'chip chip-cat-' + cat : 'chip chip-neutro';
    const chipTxt = Datos.fmtCatCorto(cat);
    /* nota de tocatierra emparejada (si el punto activo es un tocatierra
     * explicado en data/notas-tocatierras.json), ya cargada por el mapa */
    const notaToca = (this._mapa && this._mapa.notaDePunto) ? this._mapa.notaDePunto(s.iActivo) : null;

    this._refs.fichaCuerpo.innerHTML =
      '<p class="ficha-instante mono">' + Datos.fmtReloj(p.d) + '</p>' +
      '<dl class="ficha-datos mono">' +
      '<div><dt>Posición</dt><dd>' + Datos.fmtLatLon(p.lat, p.lon) + '</dd></div>' +
      '<div><dt>Estado</dt><dd>' + Datos.fmtEstatus(p.estatus) + '</dd></div>' +
      '<div><dt>Categoría</dt><dd><span class="' + chipCls + '">' + chipTxt + '</span></dd></div>' +
      '<div><dt>Viento</dt><dd><b>' + p.viento_kt + ' kt</b></dd></div>' +
      '<div><dt>Presión</dt><dd>' + p.presion_mb + ' mb</dd></div>' +
      '<div><dt>Muertes acum.</dt><dd>' + Datos.fmtEntero(p.muertes_acum) + ' <span class="delta">(' + Datos.fmtDeltaEntero(dMuertes) + ')</span></dd></div>' +
      '<div><dt>Daños acum.</dt><dd>' + Datos.fmtUSD(p.danos_acum_usd) + ' <span class="delta">(' + Datos.fmtDeltaUSD(dDanos) + ')</span></dd></div>' +
      '</dl>' +
      (notaToca
        ? '<p class="ficha-nota"><span class="ficha-nota-cab mono">Tocatierra · ' + notaToca.lugar + '</span>' + notaToca.nota + '</p>'
        : '') +
      '<hr class="ficha-sep">' +
      '<h4 class="ficha-resumen-titulo">Resumen · ' + meta.nombre + ' ' + meta.anio + '</h4>' +
      '<dl class="ficha-datos mono">' +
      '<div><dt>Pico</dt><dd>' + (pico ? 'Cat ' + pico.cat_ss + ' · ' + pico.viento_kt + ' kt · ' + Datos.fmtDiaMesAnio(pico.d) : '—') + '</dd></div>' +
      '<div><dt>Tocatierras</dt><dd>' + (tocas.length ? tocas.map(tp => Datos.fmtDia(tp.d) + ' · Cat ' + tp.cat_ss).join('<br>') : '—') + '</dd></div>' +
      '<div><dt>Totales</dt><dd>' + Datos.fmtEntero(meta.muertes_total) + ' muertes · ' + Datos.fmtUSDCorto(meta.danos_total_usd) + '</dd></div>' +
      '</dl>';
  },

  /* --- líneas de texto de valores (tooltip, barra del reproductor) --- */

  _htmlTooltip(p) {
    const s = this._estado;
    const idx = s && s.puntos ? s.puntos.indexOf(p) : -1;
    const ant = idx > 0 ? s.puntos[idx - 1] : null;
    const dMuertes = ant ? p.muertes_acum - ant.muertes_acum : 0;
    const dDanos = ant ? p.danos_acum_usd - ant.danos_acum_usd : 0;
    const cat = Math.max(0, Math.min(5, p.cat_ss | 0));
    return '<p class="tip-titulo mono">' + Datos.fmtReloj(p.d) + '</p>' +
      '<p class="tip-fila">' + Datos.fmtLatLon(p.lat, p.lon) + '</p>' +
      '<p class="tip-fila">Viento <b>' + p.viento_kt + ' kt</b> · Presión <b>' + p.presion_mb + ' mb</b></p>' +
      '<p class="tip-fila">' + Datos.fmtEstatus(p.estatus) + (cat >= 1 ? ' · <span class="chip chip-cat-' + cat + '">' + cat + '</span>' : '') + '</p>' +
      '<p class="tip-fila">Muertes ' + Datos.fmtEntero(p.muertes_acum) + ' <span class="delta">(' + Datos.fmtDeltaEntero(dMuertes) + ')</span>' +
      ' · Daños ' + Datos.fmtUSDCorto(p.danos_acum_usd) + ' <span class="delta">(' + Datos.fmtDeltaUSD(dDanos) + ')</span></p>';
  },

  _htmlValores(p, ant) {
    const cat = Math.max(0, Math.min(5, p.cat_ss | 0));
    /* chip con fondo de intensidad y texto blanco (ver .rep-valores
     * .chip-cat-* en css): SIEMPRE chip-cat-N, cat 0 incluida */
    const chipCls = 'chip chip-cat-' + cat;
    const chipTxt = Datos.fmtCatCorto(cat);
    const dMu = ant ? p.muertes_acum - ant.muertes_acum : 0;
    const dDa = ant ? p.danos_acum_usd - ant.danos_acum_usd : 0;
    /* la línea cierra en los acumulados con su delta: «Muertes N (Δ d) ·
     * Daños $X (Δ $Y)». Sin nota suelta de «intervalo» (el delta ya lo dice). */
    return '<span class="' + chipCls + '">' + chipTxt + '</span>' +
      '<span>' + Datos.fmtEstatus(p.estatus) + '</span>' +
      '<span>Viento <b>' + p.viento_kt + ' kt</b> · Presión <b>' + p.presion_mb + ' mb</b></span>' +
      '<span>Muertes <b>' + Datos.fmtEntero(p.muertes_acum) + '</b> <span class="delta">(Δ ' + Datos.fmtDeltaEntero(dMu) + ')</span>' +
      ' · Daños <b>' + Datos.fmtUSDCorto(p.danos_acum_usd) + '</b> <span class="delta">(Δ ' + Datos.fmtDeltaUSD(dDa) + ')</span></span>';
  }

};

window.App = App;

document.addEventListener('DOMContentLoaded', () => App.iniciar());