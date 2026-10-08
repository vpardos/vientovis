'use strict';
/* app.js — global `App`: routing por hash, galería, vista tormenta,
 * reproductor + wiring del motor de audio (siempre envuelto en try/catch:
 * un fallo de audio jamás rompe la UI) y ficha on demand.
 *   #galeria · #tormenta/<id> · #comparar[?a=<id>&b=<id>] */

const App = {

  motor: null,
  _volumen: 0.7,
  _mudo: false,
  _estado: null,
  _paneles: null,
  _mapa: null,
  _minis: null,
  _limpieza: [],
  _token: 0,

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
    if (!crudo) return { vista: 'galeria' };
    const partes = crudo.split('?');
    const ruta = partes[0];
    const params = new URLSearchParams(partes[1] || '');
    if (ruta === 'comparar') return { vista: 'comparar', a: params.get('a'), b: params.get('b') };
    if (ruta.indexOf('tormenta/') === 0) {
      const id = ruta.slice('tormenta/'.length);
      if (Datos.porId(id)) return { vista: 'tormenta', id: id };
    }
    return { vista: 'galeria' };
  },

  _rotear() {
    /* BUG (C1): al salir de una tormenta cuyo sonido estaba activo y sonando,
     * las capas seguían sonando en la vista siguiente. Corto el playback (rAF
     * + temporizadores + motor.setReproduciendo(false)) ANTES de desmontar:
     * el motor atenúa el master a 0 (~0,6 s) y calla por completo. */
    const previa = this._estado;
    if (previa && previa.tipo === 'tormenta') {
      if (previa.raf) cancelAnimationFrame(previa.raf);
      previa.raf = null;
      previa.reproducido = false;
      previa.ultimoTs = null;
      this._conAudio('setReproduciendo', false);
    }
    this._desmontar();
    const dest = this._parseHash();
    const token = ++this._token;
    window.scrollTo(0, 0);

    this._marcarNav(dest.vista === 'tormenta' ? 'galeria' : dest.vista);

    if (dest.vista === 'comparar') {
      document.title = 'Vientovis — Comparar tormentas';
      this._vistaComparar(dest.a, dest.b, token);
    } else if (dest.vista === 'tormenta') {
      this._vistaTormenta(dest.id, token);
    } else {
      document.title = 'El impacto de los huracanes más relevantes de los últimos años';
      this._vistaGaleria(token);
    }
  },

  _marcarNav(vista) {
    document.querySelectorAll('.nav-enlace').forEach(a => {
      a.classList.toggle('activo', a.getAttribute('data-nav') === vista);
    });
  },

  /* limpieza del estado de la vista anterior */
  _desmontar() {
    this._limpieza.forEach(fn => { try { fn(); } catch (e) { /* noop */ } });
    this._limpieza = [];
    if (this._estado) {
      if (this._estado.raf) cancelAnimationFrame(this._estado.raf);
    }
    this._estado = null;
    if (this._mapa) { this._mapa.destruir(); this._mapa = null; }
    this._destruirMinis();
    this._paneles = null;
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

  /* Mini-mapas Leaflet de la galería (C2): los de la vista anterior se
   * removieron AL desmontar (map.remove()), así que re-entrar a la ruta no
   * dispara «Map container is already initialized». */
  _destruirMinis() {
    if (!this._minis) return;
    this._minis.forEach(m => { try { m.destruir(); } catch (e) { /* noop */ } });
    this._minis = null;
  },

  /* ===================== helpers de audio ===================== */

  _conAudio(metodo) {
    if (typeof MotorAudio === 'undefined' || !this.motor) return;
    try { this.motor[metodo].apply(this.motor, Array.prototype.slice.call(arguments, 1)); }
    catch (err) { console.warn('[vientovis] audio omitido (' + metodo + '):', err); }
  },

  /* ===================== VISTA GALERÍA ===================== */

  async _vistaGaleria(token) {
    const main = document.getElementById('vista');
    try { this._estado = { tipo: 'galeria' }; await this._esperaRuta(token); } catch (e) { return; }

    const orden = Datos.ordenPorMuertes();
    const n = orden.length;
    const k = Math.min(3, n);
    const top = orden.slice(0, k);
    const totalMuertes = orden.reduce((s, t) => s + (+t.muertes_total || 0), 0);

    main.innerHTML =
      '<section class="galeria">' +
      '<div class="galeria-cabecera">' +
      '<h1 class="galeria-titulo">El impacto de los huracanes más relevantes de los últimos años</h1>' +
      '<p class="galeria-lede">Los daños ocasionados por los huracanes más relevantes de la actualidad, medidos según la cantidad de víctimas, la destrucción de propiedades y sus costos, para dar mayor claridad sobre su impacto en las zonas a largo plazo.</p>' +
      '<div class="cinta" id="cinta" role="img" aria-label="Concentración de muertes por tormenta"></div>' +
      '<p class="cinta-caption mono">Cada segmento es una tormenta, en el mismo orden que la galería; su ancho, sus muertes. ' +
      'La trayectoria de cada ficha se colorea por categoría Saffir–Simpson:</p>' +
      '<div class="chips-categorias" id="chips-categorias"></div>' +
      '</div>' +
      '<ol class="galeria-grid" id="galeria-grid" style="list-style:none"></ol>' +
      /* atribución única (C2): NUNCA se repite en los 10 mini-mapas */
      '<p class="galeria-atr mono">Mini-mapas de las fichas: imágenes satelitales &copy; Esri — Esri, Maxar, Earthstar Geographics.</p>' +
      '</section>';

    /* leyenda de categoría (1 sola vez aquí) */
    const chips = document.getElementById('chips-categorias');
    chips.innerHTML =
      '<span class="chip chip-neutro">T. tropical</span>' +
      [1, 2, 3, 4, 5].map(c => '<span class="chip chip-cat-' + c + '">Cat ' + c + '</span>').join('');

    /* cinta de concentración (segmentos = muertes) */
    const cinta = document.getElementById('cinta');
    cinta.innerHTML = orden.map(t => {
      const pct = totalMuertes ? ((+t.muertes_total || 0) / totalMuertes) * 100 : 0;
      return '<span class="cinta-seg' + (top.indexOf(t) >= 0 ? ' cinta-top' : '') + '" ' +
        'style="width:' + pct + '%;background:' + Datos.colorCat(t.cat_pico) + '" ' +
        'title="' + t.nombre + ' ' + t.anio + ' · ' + Datos.fmtEntero(t.muertes_total) + ' muertes">' +
        '</span>';
    }).join('');

    /* fichas (cargamos los 10 archivos para dibujar las trayectorias) */
    const grid = document.getElementById('galeria-grid');
    try {
      const detalles = await Promise.all(orden.map(t => Datos.tormenta(t.id).catch(() => null)));
      if (!(await this._esperaRuta(token))) return;

      grid.innerHTML = orden.map((t, i) => {
        const tor = detalles[i];
        const hayDatos = !!(tor && tor.puntos && tor.puntos.length > 1);
        const mini = hayDatos
          ? '<div class="mini-mapa" id="mini-' + t.id + '" role="img" aria-label="Mapa satelital · trayectoria de ' + t.nombre + ' (' + t.anio + ')"></div>'
          : '';
        const esTop = i < 3;
        return '<li class="ficha"><a class="ficha-enlace" href="#tormenta/' + t.id + '" ' +
          'aria-label="' + t.nombre + ' ' + t.anio + ' · Cat ' + t.cat_pico + ' · ' +
          Datos.fmtEntero(t.muertes_total) + ' muertes">' +
          '<div class="ficha-mini">' + (mini || '<div class="mini-vacio"></div>') +
          '<span class="ficha-rango mono' + (esTop ? ' impacto' : '') + '">Nº ' + Datos.fmtEntero(i + 1).padStart(2, '0') + (esTop ? ' · impacto' : '') + '</span></div>' +
          '<div class="ficha-cuerpo">' +
          '<h3 class="ficha-nombre">' + t.nombre + ' <span class="ficha-anio">' + t.anio + '</span></h3>' +
          '<div class="ficha-chips"><span class="chip chip-cat-' + t.cat_pico + '">Cat ' + t.cat_pico + '</span></div>' +
          '<dl class="ficha-stats">' +
          '<div><dt>Muertes</dt><dd>' + Datos.fmtEntero(t.muertes_total) + '</dd></div>' +
          '<div><dt>Daños</dt><dd>' + Datos.fmtUSDCorto(t.danos_total_usd) + '</dd></div>' +
          '</dl></div></a></li>';
      }).join('');

      /* C2: los 10 mini-mapas Leaflet REALES (teselas satelitales), creados al
       * montar la galería. Los anteriores siempre murieron en _desmontar()
       * (map.remove()), así que este montaje nunca choca con un contenedor
       * ya inicializado. */
      this._destruirMinis();
      this._minis = [];
      orden.forEach((t, i) => {
        const tor = detalles[i];
        if (!tor || !tor.puntos || tor.puntos.length < 2) return;
        const div = document.getElementById('mini-' + t.id);
        if (div) this._minis.push(MapaTormenta.crearMini(div, tor.puntos));
      });
      /* los minis son non-interactive (trackResize:false): el re-fit es nuestro */
      this._al('resize', (() => {
        let retardo;
        return () => {
          clearTimeout(retardo);
          retardo = setTimeout(() => {
            if (this._minis) this._minis.forEach(m => m.reencuadrar());
          }, 200);
        };
      })());
    } catch (e) {
      grid.innerHTML = '<li class="mono carga-error">No se pudieron cargar las fichas.</li>';
    }
  },

  async _esperaRuta(token) {
    if (token !== this._token) return false;
    await new Promise(r => setTimeout(r, 0));
    return token === this._token;
  },

  /* ===================== VISTA TORMENTA ===================== */

  async _vistaTormenta(id, token) {
    const meta = Datos.porId(id);
    if (!meta) { location.replace('#galeria'); return; }
    const main = document.getElementById('vista');
    main.innerHTML = '<p class="cargando mono">Cargando ' + meta.nombre + '…</p>';
    let tor;
    try {
      tor = await Datos.tormenta(id);
    } catch (err) {
      main.innerHTML = '<section class="carga-error"><h1>No se pudo cargar la tormenta</h1><p class="mono">' + (err.message || err) + '</p></section>';
      return;
    }
    if (!(await this._esperaRuta(token))) return;

    const puntos = tor.puntos;
    const tocas = Datos.puntosTocatierra(puntos);
    const tramosIR = Datos.tramosIR(puntos);
    const pico = Datos.pico(puntos);
    const s = this._estado = {
      tipo: 'tormenta', id: id, meta: meta, puntos: puntos,
      iActivo: 0, reproducido: false, vel: 0.5, fichaAbierta: false,
      simT: +puntos[0].d, raf: null, ultimoTs: null, tooltipAnclado: false,
      z: { modo: null } // coreografía de zoom (C4): 'inicio'|'seguir' (sin zoom profundo)
    };

    main.innerHTML =
      '<section class="tormenta">' +
      '<div class="tormenta-cabecera">' +
      '<a class="tormenta-volver" href="#galeria">← Huracanes</a>' +
      '<h1 class="tormenta-titulo">' + meta.nombre + ' <span class="tormenta-anio">' + meta.anio + '</span></h1>' +
      '<span class="chip chip-cat-' + meta.cat_pico + '">Cat ' + meta.cat_pico + '</span>' +
      '<div class="tormenta-stats mono">' +
      '<span class="ts-item"><b>' + Datos.fmtEntero(meta.muertes_total) + '</b> muertes</span>' +
      '<span class="ts-item"><b>' + Datos.fmtUSDCorto(meta.danos_total_usd) + '</b> daños</span>' +
      '<span class="ts-item"><b>' + tocas.length + '</b> tocatier' + (tocas.length === 1 ? 'ra' : 'ras') + '</span>' +
      '<span class="ts-item"><b>' + tramosIR.length + '</b> tramo' + (tramosIR.length === 1 ? '' : 's') + ' IR</span>' +
      '</div>' +
      '</div>' +
      /* reproductor: barra superior de la vista tormenta (por encima del mapa y los paneles) */
      '<div class="reproductor" id="reproductor">' +
      '<button type="button" id="btn-play" class="btn btn-primario" aria-label="Reproducir la tormenta">Reproducir</button>' +
      '<div class="velocidades" role="group" aria-label="Velocidad de reproducción">' +
      '<button type="button" class="vel" data-vel="0.25" aria-pressed="false">0,25×</button>' +
      '<button type="button" class="vel activo" data-vel="0.5" aria-pressed="true">0,5×</button>' +
      '</div>' +
      '<input type="range" id="scrubber" class="scrubber" min="0" max="' + (puntos.length - 1) + '" step="1" value="0" aria-label="Línea de tiempo de la tormenta" aria-valuemin="0" aria-valuemax="' + (puntos.length - 1) + '">' +
      '<span class="reloj" id="reloj">' + Datos.fmtReloj(puntos[0].d) + '</span>' +
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
      '<div class="contador-impacto" id="contador-impacto" role="group" aria-label="Acumulados del punto activo">' +
      '<div class="ci-fila"><span class="ci-etq">Muertes:</span><span class="ci-cifra ci-muertes" id="ci-muertes">—</span></div>' +
      '<div class="ci-fila"><span class="ci-etq">Daños:</span><span class="ci-cifra ci-danos" id="ci-danos">—</span></div>' +
      '</div>' +
      '<div class="leyenda-categorias" aria-label="Leyenda de categoría Saffir–Simpson">' +
      '<span class="li"><span class="cuadr" style="background:' + Datos.colorCat(0) + '"></span>T.T./TD</span>' +
      [1, 2, 3, 4, 5].map(c => '<span class="li"><span class="cuadr" style="background:' + Datos.colorCat(c) + '"></span>' + c + '</span>').join('') +
      '</div>' +
      '<div class="ficha-flotante oculto" id="ficha" role="group" aria-label="Ficha del punto activo">' +
      '<div class="ficha-cab"><h3 class="ficha-titulo">Ficha del punto</h3>' +
      '<button type="button" id="btn-cerrar-ficha" class="ficha-cerrar" aria-label="Cerrar ficha" title="Cerrar ficha">✕</button></div>' +
      '<div id="ficha-cuerpo"></div>' +
      '</div>' +
      '</div>' +
      '<div class="tormenta-paneles" id="tor-paneles"></div>' +
      '</div>' +
      '</section>';

    document.title = 'Vientovis — ' + meta.nombre + ' (' + meta.anio + ')';

    /* --- paneles + mapa --- */
    const colMapa = document.getElementById('tor-mapa');
    const colPaneles = document.getElementById('tor-paneles');
    this._paneles = Paneles.crearPanelTormenta(colPaneles, {
      puntos: puntos,
      alHover: (i, ev) => this._setHover(i, ev),
      alSalida: () => this._salidaHover(),
      alFija: i => this._alFijar(i)
    });

    this._mapa = MapaTormenta.crear(colMapa, {
      puntos: puntos,
      alPasarPorEncima: (i, ev) => this._setHover(i, ev),
      alSalirDelHover: () => this._salidaHover(),
      alHacerClicEnPunto: i => this._alClicPunto(i)
    });

    const fijaAltura = () => {
      if (!this._estado || this._estado.tipo !== 'tormenta') return;
      if (window.innerWidth >= 1024) {
        const h = Math.max(430, colPaneles.offsetHeight || 600);
        colMapa.style.height = h + 'px';
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
        t = setTimeout(() => { fijaAltura(); if (this._estado && this._estado.tipo === 'tormenta') { this._paneles = Paneles.crearPanelTormenta(colPaneles, { puntos: puntos, alHover: (i, ev) => this._setHover(i, ev), alSalida: () => this._salidaHover(), alFija: i => this._alFijar(i) }); this._paneles.setActivo(s.iActivo); } }, 160);
      };
    })());

    /* --- reproductor --- */
    const btnPlay = document.getElementById('btn-play');
    const scrubber = document.getElementById('scrubber');
    const reloj = document.getElementById('reloj');
    const repValores = document.getElementById('rep-valores');

    this._refs = { btnPlay: btnPlay, scrubber: scrubber, reloj: reloj, repValores: repValores, ficha: document.getElementById('ficha'), fichaCuerpo: document.getElementById('ficha-cuerpo'), ciMuertes: document.getElementById('ci-muertes'), ciDanos: document.getElementById('ci-danos') };

    btnPlay.addEventListener('click', () => s.reproducido ? this._pausar() : this._reproducir());
    scrubber.addEventListener('pointerdown', () => { if (s.reproducido) this._pausar(); });
    scrubber.addEventListener('input', () => {
      const destino = +scrubber.value; // leer antes: _pausar() reescribe el valor del range
      this._pausar();
      this._salirDeCoreo(); // scrub: cámara al encuadre base, solo mueve el marcador
      this._setActivo(destino);
    });
    this._al('keydown', ev => { if (ev.key === 'Escape') this._cerrarFicha(); });
    document.querySelectorAll('.vel').forEach(b => {
      b.addEventListener('click', () => {
        const v = +b.dataset.vel;
        if (!v) return;
        s.vel = v;
        document.querySelectorAll('.vel').forEach(x => {
          const act = +x.dataset.vel === v;
          x.classList.toggle('activo', act);
          x.setAttribute('aria-pressed', String(act));
        });
      });
    });

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
    if (!s || s.tipo !== 'tormenta') return;
    const n = s.puntos.length;
    if (s.iActivo >= n - 1) this._setActivo(0);
    s.reproducido = true;
    s.ultimoTs = null;
    s.simT = +s.puntos[s.iActivo].d;
    const btn = document.getElementById('btn-play');
    if (btn) { btn.textContent = 'Pausar'; btn.setAttribute('aria-label', 'Pausar la reproducción'); }
    this._seguroTooltipOcultar();
    this._conAudio('setReproduciendo', true);
    this._coreoInicio(); // C4: zoom de arranque y, desde ahí, seguimiento del punto activo
    s.raf = requestAnimationFrame(ts => this._tick(ts));
  },

  _pausar() {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta') return;
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = null; }
    s.reproducido = false;
    s.ultimoTs = null;
    const btn = document.getElementById('btn-play');
    if (btn) { btn.textContent = 'Reproducir'; btn.setAttribute('aria-label', 'Reproducir la tormenta'); }
    this._conAudio('setReproduciendo', false);
    this._setActivo(s.iActivo, true); // re-aplica el crosshair al punto activo (sin audio)
  },

  _tick(ts) {
    const s = this._estado;
    if (!s || !s.reproducido || s.tipo !== 'tormenta') return;
    const n = s.puntos.length;
    const dt = s.ultimoTs == null ? 16.7 : Math.min(150, ts - s.ultimoTs);
    s.ultimoTs = ts;
    /* 0,5× = un paso de 6 h (21 600 000 ms de tormenta) en 1 s real;
     * 0,25× avanza la mitad por milisegundo (un punto cada 2 s) */
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
      if (s.z.modo === 'seguir' && this._mapa.seguir) this._mapa.seguir(i, frac);
    }

    s.raf = requestAnimationFrame(t2 => this._tick(t2));
  },

  /* --- cambios de punto activo / hover --- */

  _setActivo(i, sinAudio) {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta') return;
    const puntos = s.puntos;
    s.iActivo = Math.max(0, Math.min(puntos.length - 1, i));
    s.simT = +puntos[s.iActivo].d;

    if (this._paneles) this._paneles.setActivo(s.iActivo);
    this._actualizarPunto(s.iActivo);

    const p = puntos[s.iActivo];
    const ant = s.iActivo > 0 ? puntos[s.iActivo - 1] : null;
    const refs = this._refs || {};
    if (refs.reloj) refs.reloj.textContent = Datos.fmtReloj(p.d);
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

  /* Marcador del mapa + contador de acumulados: SIEMPRE por la misma vía
   * (playback, scrub, hover, ficha) para que nunca se desincronicen. */
  _actualizarPunto(i) {
    if (this._mapa) this._mapa.setPuntoActivo(i);
    this._pintarContador(i);
  },

  /* Acumulados del punto activo en el overlay superior derecho del mapa
   * (formatos es-ES ya existentes: 1.004 muertes · $33,6 mil M USD). */
  _pintarContador(i) {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta' || !this._refs) return;
    const p = s.puntos[i];
    if (!p) return;
    if (this._refs.ciMuertes) this._refs.ciMuertes.textContent = Datos.fmtEntero(p.muertes_acum);
    if (this._refs.ciDanos) this._refs.ciDanos.textContent = Datos.fmtUSD(p.danos_acum_usd);
  },

  _setInterp(i, frac) {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta') return;
    this._paneles && this._paneles.setInterp(i, frac);
    const p = s.puntos[i], q = s.puntos[i + 1];
    const tInterp = q ? +p.d + (+q.d - +p.d) * frac : +s.puntos[s.puntos.length - 1].d;
    if (this._refs && this._refs.reloj) this._refs.reloj.textContent = Datos.fmtReloj(new Date(tInterp));
  },

  _setHover(i, ev) {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta' || s.reproducido) return;
    s.iHover = i;
    this._paneles && this._paneles.setHover(i);
    this._actualizarPunto(i);
    if (this._mapa) this._mapa.setHover(i);
    this._tooltipMostrar(s.puntos[i], ev);
  },

  _salidaHover() {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta' || s.reproducido) return;
    s.iHover = null;
    this._paneles && this._paneles.limpiarHover();
    if (this._mapa) this._mapa.setHover(null);
    this._actualizarPunto(s.iActivo);
    this._tooltipOcultar();
  },

  /* clic de scrub en los paneles */
  _alFijar(i) {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta') return;
    if (s.reproducido) this._pausar();
    this._salirDeCoreo();
    this._setActivo(i);
  },

  /* clic en un punto del mapa: scrub + ficha fijada */
  _alClicPunto(i) {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta') return;
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
   * Las velocidades 0,25×/0,5× escalan el avance de datos, no las animaciones. */

  /* Zoom de arranque al pulsar Reproducir: zoom-in notable hacia el punto
   * actual (fitZoom+2, ~1 s). A partir de ahí NO hay retorno al panorama:
   * _coreoPorPunto acompaña el punto activo hasta el final. */
  _coreoInicio() {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta' || !this._mapa || !this._mapa.zoomInicio) return;
    s.z.modo = 'inicio';
    this._mapa.zoomInicio(s.iActivo);
  },

  /* Por cada punto activo DURANTE el playback: seguir el punto con el zoom de
   * seguimiento CONSTANTE y sin animación (setView), tocatierras incluidos.
   * Nunca se vuelve al encuadre completo aquí: eso solo pasa al terminar la
   * reproducción o al hacer scrub. */
  _coreoPorPunto(i) {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta' || !s.reproducido) return; // solo playback automático
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
    if (!s || s.tipo !== 'tormenta') return;
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
    if (!s || s.tipo !== 'tormenta') return;
    s.fichaAbierta = true;
    if (this._refs && this._refs.ficha) this._refs.ficha.classList.remove('oculto');
    this._pintaFicha();
  },

  _cerrarFicha() {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta') return;
    s.fichaAbierta = false;
    if (this._refs && this._refs.ficha) this._refs.ficha.classList.add('oculto');
  },

  _pintaFicha() {
    const s = this._estado;
    if (!s || s.tipo !== 'tormenta' || !s.fichaAbierta || !this._refs) return;
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
    const chipCls = cat >= 1 ? 'chip chip-cat-' + cat : 'chip chip-neutro';
    const chipTxt = Datos.fmtCatCorto(cat);
    const dMu = ant ? p.muertes_acum - ant.muertes_acum : 0;
    const dDa = ant ? p.danos_acum_usd - ant.danos_acum_usd : 0;
    return '<span class="' + chipCls + '">' + chipTxt + '</span>' +
      '<span>' + Datos.fmtEstatus(p.estatus) + '</span>' +
      '<span>Viento <b>' + p.viento_kt + ' kt</b> · Presión <b>' + p.presion_mb + ' mb</b></span>' +
      '<span>Muertes <b>' + Datos.fmtEntero(p.muertes_acum) + '</b> (Δ ' + Datos.fmtDeltaEntero(dMu) + ')' +
      ' · Daños <b>' + Datos.fmtUSDCorto(p.danos_acum_usd) + '</b> (Δ ' + Datos.fmtDeltaUSD(dDa) + ')</span>' +
      '<span class="delta">' + (ant ? 'intervalo desde ' + Datos.fmtDia(ant.d) : 'inicio de la tormenta') + '</span>';
  },

  /* ===================== VISTA COMPARAR ===================== */

  async _vistaComparar(aId, bId, token) {
    const main = document.getElementById('vista');
    const orden = Datos.ordenPorMuertes();
    let a = Datos.porId(aId) ? aId : (orden[0] && orden[0].id);
    let b = Datos.porId(bId) ? bId : (orden[1] && orden[1].id);
    if (a === b) b = (orden.find(t => t.id !== a) || {}).id;
    main.innerHTML = '<p class="cargando mono">Cargando comparación…</p>';

    let A, B;
    try {
      A = await Datos.tormenta(a); B = await Datos.tormenta(b);
    } catch (err) {
      main.innerHTML = '<section class="carga-error"><h1>No se pudo cargar la comparación</h1><p class="mono">' + (err.message || err) + '</p></section>';
      return;
    }
    if (!(await this._esperaRuta(token))) return;
    this._estado = { tipo: 'comparar' };

    const opciones = orden.map(t => '<option value="' + t.id + '"' + (t.id === A.id ? ' selected' : '') + '>' + t.nombre + ' ' + t.anio + '</option>').join('');

    main.innerHTML =
      '<section class="comparar">' +
      '<div class="compara-controles">' +
      '<label class="compara-label">A <select class="selector mono" id="sel-a" aria-label="Primera tormenta">' + opciones + '</select></label>' +
      '<span class="compara-vs mono" aria-hidden="true">vs</span>' +
      '<label class="compara-label">B <select class="selector mono" id="sel-b" aria-label="Segunda tormenta">' + orden.map(t => '<option value="' + t.id + '"' + (t.id === B.id ? ' selected' : '') + '>' + t.nombre + ' ' + t.anio + '</option>').join('') + '</select></label>' +
      '</div>' +
      '<div class="compara-cuerpo">' +
      this._htmlCabeceraComparar(A, Paneles.PIZARRA) +
      this._htmlCabeceraComparar(B, Paneles.SIENA) +
      '</div>' +
      '<div class="compara-graficas" id="compara-graficas"></div>' +
      '</section>';

    document.title = 'Vientovis — Comparar: ' + A.nombre + ' vs ' + B.nombre;

    const go = () => { location.hash = '#comparar?a=' + a + '&b=' + b; };
    document.getElementById('sel-a').addEventListener('change', ev => { a = ev.target.value; go(); });
    document.getElementById('sel-b').addEventListener('change', ev => { b = ev.target.value; go(); });

    this._paneles = Paneles.crearComparar(document.getElementById('compara-graficas'), {
      a: A, b: B, lo: -120, hi: 240
    });

    this._al('resize', (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => this._paneles && this._paneles.redibujar(), 160); }; })());
  },

  _htmlCabeceraComparar(storm, color) {
    const meta = Datos.porId(storm.id) || storm; // cat_pico/muertes/danos viven en el índice
    const toca = Datos.primerTocatierra(storm.puntos);
    return '<div class="compara-ficha" style="--color:' + color + '">' +
      '<span class="muestra" style="border-top-color:' + color + ';border-top-width:3px" aria-hidden="true"></span>' +
      '<h2 class="compara-nombre">' + meta.nombre + ' <span class="ficha-anio">' + meta.anio + '</span></h2>' +
      '<span class="chip chip-cat-' + meta.cat_pico + '">Cat ' + meta.cat_pico + '</span>' +
      '<p class="compara-numeros mono"><b>' + Datos.fmtEntero(meta.muertes_total) + '</b> muertes · <b>' + Datos.fmtUSDCorto(meta.danos_total_usd) + '</b></p>' +
      '<p class="compara-nota mono">' + (toca ? 'Primer tocatierra: ' + Datos.fmtDiaMesAnio(toca.d) + ' UTC · Cat ' + toca.cat_ss + ' · ' + toca.viento_kt + ' kt' : 'Sin tocatierra registrado') + '</p>' +
      '</div>';
  }
};

window.App = App;

document.addEventListener('DOMContentLoaded', () => App.iniciar());
