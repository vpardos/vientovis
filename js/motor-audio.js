/**
 * motor-audio.js — Motor de sonificación de "vientovis" (V1).
 *
 * Script clásico (sin módulos ES, sin dependencias): define la clase global
 * `MotorAudio`. Todo el audio se crea SOLO dentro de iniciar(), que debe
 * llamarse tras un gesto del usuario (botón "Activar sonido").
 *
 * Grafo de audio
 * --------------
 *   masterGain → compresor (anti-clip) → destination
 *
 *   DRON (presión):   oscPrincipal (f, triangle, +5 cents) ─┐
 *                     oscSub (f/2, −7 cents) ────────────────┴→ dronGain → dronFiltro (LP) → masterGain
 *   ARMÓNICO (IR):    oscArmonico (3·f) → waveShaper (clip muy suave) → armonicoGain → masterGain
 *   VIENTO:           huracan.mp3 (loop) → vientoNormalGain ───┐
 *                     huracanaterrador.mp3 (loop) → vientoTerrorGain ─┴→ vientoFiltro (LP) → masterGain
 *   ONE-SHOTS:        bufferSource → ganancia puntual → masterGain
 *
 * Mapeos dato → parámetro
 * -----------------------
 *   u = clamp((1010 − presion_mb)/60, 0, 1)
 *   dron f = 30·2^(u·2.2) Hz (×2,5 en IR) · cutoff LP = 280 − u·200 Hz
 *   viento (grabaciones reales): cat_ss ≥ 4 → loop terrorífico; cat_ss < 4 → loop normal
 *           (crossfade ~0,6 s al cruzar el umbral 3↔4); ganancia por categoría
 *           0,04→0,58 con modulación fina ±20 % según viento_kt;
 *           tocatierra: lowpass compartido a 1.200 Hz (seco); en mar abierto a 18 kHz
 *   muertes: N = min(6, 1+⌊Δ/25⌋) pulsos repartidos en la ventana real del paso
 *   daños:   N = min(12, 1+⌊Δ/5e9⌋) ráfagas con jitter y ganancia ∝ log10(Δ)
 */

// ---------- Ajustes de la capa de viento real (huracan / huracanaterrador) ----------
// Ganancia del loop por categoría (cat_ss 0..5): niveles claramente separados.
const VIENTO_GANANCIA_CAT = [0.04, 0.09, 0.16, 0.27, 0.42, 0.58];
const VIENTO_MODULACION = 0.20;    // variación fina ±20 % según viento_kt dentro de la categoría
const VIENTO_CUTOFF_MAR = 18000;   // lowpass compartido abierto en mar
const VIENTO_CUTOFF_TIERRA = 1200; // timbre seco tras tocatierra
const VIENTO_CROSSFADE = 0.6;      // segundos de crossfade al cruzar el umbral cat 3↔4

class MotorAudio {
  constructor() {
    // El AudioContext se crea en iniciar() (requiere gesto del usuario).
    this.ctx = null;
    this.iniciado = false;
    this._promesaInicio = null;

    // Control global (se guardan aunque el motor no esté iniciado).
    this._volumen = 0.7;       // 0..1
    this._mudo = false;
    this._reproduciendo = true; // la app llama setReproduciendo(true) al dar play

    // Nodos de audio (se crean en _construirGrafo).
    this.masterGain = null;
    this._nodos = null;

    // Buffers mp3 decodificados (dos grabaciones reales de viento + tres one-shots).
    this._buffers = { tocatierra: null, pulso: null, rafaga: null, huracan: null, huracanaterrador: null };

    // Estado derivado del dato, para re-aplicar parámetros al reanudar.
    this._estado = {
      u: null,                 // normalización de presión
      fBase: 30,               // frecuencia base del dron (sin factor IR)
      fDron: 30,               // frecuencia realmente aplicada (incluye factor IR)
      enIR: false,             // tramo de intensificación rápida
      viento: null,            // último viento aplicado (kt)
      cat: null,               // última categoría aplicada (cat_ss 0..5)
      vientoLoop: null,        // loop activo de viento: 'normal' | 'terrorifico'
      gananciaViento: null,    // ganancia objetivo del loop activo
      sobreTierra: false,      // estado de timbre mar/tierra
      vientoTocatierra: null,  // viento registrado en el último tocatierra
      ultimoPunto: null,       // último punto recibido (para _reaplicarParametros)
    };

    // Control de eventos.
    this._ultimoPuntoCrudo = null;   // último punto aunque el motor no esté iniciado
    this._instanteUltimoPunto = null; // currentTime del último actualizar()
    this._ultimaClave = null;        // anti-duplicados: "t|tAnterior"
  }

  // ============================================================
  // API pública
  // ============================================================

  /**
   * Crea el AudioContext, carga los mp3 locales y construye el grafo.
   * Idempotente. Rechaza con Error informativo si Web Audio no está
   * disponible o si algún asset no carga.
   */
  async iniciar() {
    if (this.iniciado) return;
    if (this._promesaInicio) return this._promesaInicio; // ya se está iniciando

    this._promesaInicio = this._iniciarInterno().catch((err) => {
      this._promesaInicio = null; // permitir reintentar tras un fallo
      throw err;
    });
    return this._promesaInicio;
  }

  /** Volumen global 0..1 (rampa corta, respeta mute/pausa). */
  setVolumen(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    this._volumen = this._acotar(n, 0, 1);
    if (this.iniciado) {
      try { this._aplicarMaster(0.05); } catch (err) { console.error('[MotorAudio] setVolumen():', err); }
    }
  }

  /** Silencio total on/off; al quitar el mute restaura el volumen si hay reproducción. */
  setMudo(mudo) {
    this._mudo = !!mudo;
    if (this.iniciado) {
      try { this._aplicarMaster(0.08); } catch (err) { console.error('[MotorAudio] setMudo():', err); }
    }
  }

  /** Play (true) / pausa (false). La pausa atenúa TODO suavemente (~0,6 s). */
  setReproduciendo(reproduciendo) {
    this._reproduciendo = !!reproduciendo;
    if (!this.iniciado) return;
    try {
      // Al volver, los parámetros del dato se re-aplican (por si hubo scrub en pausa).
      if (this._reproduciendo) this._reaplicarParametros();
      this._aplicarMaster(this._reproduciendo ? 0.12 : 0.2);
    } catch (err) {
      console.error('[MotorAudio] setReproduciendo():', err);
    }
  }

  /**
   * Llamado en cada cambio de punto activo (avance del playback).
   * `punto` y `puntoAnterior` = {t, presion_mb, viento_kt, ir, tocatierra,
   * muertes_acum, danos_acum_usd}; `puntoAnterior` puede ser null (inicio/scrub).
   * Nunca lanza excepciones.
   */
  actualizar(punto, puntoAnterior) {
    if (!punto) return;
    this._ultimoPuntoCrudo = punto; // útil si el audio aún no está activado
    if (!this.iniciado) return;

    try {
      const ahora = this.ctx.currentTime;

      // 1) Máquina de estados de modo (IR / mar-tierra), antes de aplicar parámetros.
      const trans = this._actualizarEstadosDeModo(punto, puntoAnterior);

      // 2) Capas continuas dirigidas por el dato.
      this._actualizarDron(punto, ahora, trans);
      this._actualizarViento(punto, ahora);

      // 3) Eventos one-shot, solo con punto anterior y sin repetir el mismo par.
      if (trans.hayAnterior) {
        const clave = String(punto.t) + '|' + String(puntoAnterior.t);
        const repetido = clave === this._ultimaClave;
        this._ultimaClave = clave;
        if (!repetido) {
          const ventana = this._ventanaEvento(ahora);
          if (trans.entroTierra) this._dispararTocatierra(ahora);
          this._dispararMuertes(punto, puntoAnterior, ahora, ventana);
          this._dispararDanos(punto, puntoAnterior, ahora, ventana);
        }
      }

      this._instanteUltimoPunto = ahora;
    } catch (err) {
      // Regla del contrato: actualizar() jamás lanza.
      console.error('[MotorAudio] actualizar():', err);
    }
  }

  // ============================================================
  // Arranque: contexto, carga y grafo
  // ============================================================

  async _iniciarInterno() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      throw new Error('[MotorAudio] Web Audio API no está disponible en este navegador.');
    }

    const ctx = new AC();
    this.ctx = ctx;

    try {
      // Gesto del usuario ya ocurrió: reanudar el contexto (autoplay policy).
      await ctx.resume();

      // Assets locales (rutas relativas a la página). Si algo falla, rechazamos.
      const [tocatierra, pulso, rafaga, huracan, huracanaterrador] = await Promise.all([
        this._cargarBuffer('audio/tocatierra.mp3'),
        this._cargarBuffer('audio/pulso-muerte.mp3'),
        this._cargarBuffer('audio/rafaga-dano.mp3'),
        this._cargarBuffer('audio/huracan.mp3'),
        this._cargarBuffer('audio/huracanaterrador.mp3'),
      ]);
      this._buffers = {
        tocatierra: tocatierra,
        pulso: pulso,
        rafaga: rafaga,
        huracan: huracan,
        huracanaterrador: huracanaterrador,
      };

      this._construirGrafo();
      this.iniciado = true;
      this._aplicarMaster(0.05); // fade-in desde silencio

      // Si la app ya venía llamando actualizar() con el sonido apagado,
      // sincronizamos los parámetros con el punto actual (sin disparar eventos).
      if (this._ultimoPuntoCrudo) this.actualizar(this._ultimoPuntoCrudo, null);
    } catch (err) {
      try { await ctx.close(); } catch (e) { /* el contexto ya estaba cerrado */ }
      this.ctx = null;
      throw new Error('[MotorAudio] No se pudo iniciar el motor de audio: ' + err.message);
    }
  }

  /** fetch + decodeAudioData con error informativo por archivo. */
  async _cargarBuffer(ruta) {
    let respuesta;
    try {
      respuesta = await fetch(ruta);
    } catch (err) {
      throw new Error('No se pudo descargar ' + ruta + ' (' + err.message + ')');
    }
    if (!respuesta.ok) {
      throw new Error('No se pudo descargar ' + ruta + ' (HTTP ' + respuesta.status + ')');
    }
    const datos = await respuesta.arrayBuffer();
    try {
      // Wrapper con callbacks: compatible con navegadores antiguos y modernos.
      return await new Promise((resolver, rechazar) => {
        this.ctx.decodeAudioData(datos, resolver, rechazar);
      });
    } catch (err) {
      throw new Error('No se pudo decodificar ' + ruta + ' (' + (err && err.message ? err.message : err) + ')');
    }
  }

  /** Construye todos los nodos del grafo una sola vez. */
  _construirGrafo() {
    const ctx = this.ctx;

    // ---------- MASTER: masterGain → compresor (seguro anti-clip) → salida ----------
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0; // arranca en silencio; iniciar() hace fade-in

    const protector = ctx.createDynamicsCompressor();
    protector.threshold.value = -12;
    protector.knee.value = 20;
    protector.ratio.value = 6;
    protector.attack.value = 0.004;
    protector.release.value = 0.25;
    masterGain.connect(protector);
    protector.connect(ctx.destination);
    this.masterGain = masterGain;

    // ---------- DRON (presión central): fundamental + suboctava → LP ----------
    const dronGain = ctx.createGain();
    dronGain.gain.value = 0.06; // colchón sutil: por debajo de la grabación real de viento

    const dronFiltro = ctx.createBiquadFilter();
    dronFiltro.type = 'lowpass';
    dronFiltro.frequency.value = 280; // u=0 (1010 mb): 280 Hz; u=1 (950 mb): 80 Hz (sub-grave)
    dronFiltro.Q.value = 0.8;

    const oscPrincipal = ctx.createOscillator();
    oscPrincipal.type = 'triangle'; // triangle (sin los armónicos duros del sawtooth)
    oscPrincipal.frequency.value = 30; // se actualiza con la presión
    oscPrincipal.detune.value = 5;     // ligero detune contra la suboctava

    const oscSub = ctx.createOscillator();
    oscSub.type = 'triangle';
    oscSub.frequency.value = 15;       // suboctava (f/2)
    oscSub.detune.value = -7;

    oscPrincipal.connect(dronGain);
    oscSub.connect(dronGain);
    dronGain.connect(dronFiltro);
    dronFiltro.connect(masterGain);

    // ---------- ARMÓNICO IR: 3·f → waveshaper (clip muy suave) → ganancia ----------
    const oscArmonico = ctx.createOscillator();
    oscArmonico.type = 'sawtooth';
    oscArmonico.frequency.value = 90;

    const shaper = ctx.createWaveShaper();
    shaper.curve = this._crearCurvaDistorsion();
    shaper.oversample = '2x';

    const armonicoGain = ctx.createGain();
    armonicoGain.gain.value = 0.0001; // inaudible hasta entrar en IR

    oscArmonico.connect(shaper);
    shaper.connect(armonicoGain);
    armonicoGain.connect(masterGain);

    // ---------- VIENTO: grabaciones reales en loop (normal + terrorífico) ----------
    const fuenteVientoNormal = ctx.createBufferSource();
    fuenteVientoNormal.buffer = this._buffers.huracan;
    fuenteVientoNormal.loop = true;

    const fuenteVientoTerror = ctx.createBufferSource();
    fuenteVientoTerror.buffer = this._buffers.huracanaterrador;
    fuenteVientoTerror.loop = true;

    // Una ganancia por grabación; el crossfade normal↔terrorífico lo mueve el dato.
    const vientoNormalGain = ctx.createGain();
    vientoNormalGain.gain.value = 0;
    const vientoTerrorGain = ctx.createGain();
    vientoTerrorGain.gain.value = 0;

    // Filtro lowpass compartido: mar abierto (~18 kHz); tras tocatierra, seco (~1.200 Hz).
    const vientoFiltro = ctx.createBiquadFilter();
    vientoFiltro.type = 'lowpass';
    vientoFiltro.frequency.value = VIENTO_CUTOFF_MAR;
    vientoFiltro.Q.value = 0.7;

    fuenteVientoNormal.connect(vientoNormalGain);
    fuenteVientoTerror.connect(vientoTerrorGain);
    vientoNormalGain.connect(vientoFiltro);
    vientoTerrorGain.connect(vientoFiltro);
    vientoFiltro.connect(masterGain);

    // Arrancar fuentes continuas.
    // Las grabaciones traen ~5 s de silencio digital al principio (la terrorífica
    // también al final); se recortan esos bordes en el loop para que no haya
    // calvas de aire de varios segundos en cada vuelta.
    this._iniciarLoopReal(fuenteVientoNormal);
    this._iniciarLoopReal(fuenteVientoTerror);
    oscPrincipal.start();
    oscSub.start();
    oscArmonico.start();

    this._nodos = {
      protector: protector,
      dronGain: dronGain,
      dronFiltro: dronFiltro,
      oscPrincipal: oscPrincipal,
      oscSub: oscSub,
      oscArmonico: oscArmonico,
      shaper: shaper,
      armonicoGain: armonicoGain,
      fuenteVientoNormal: fuenteVientoNormal,
      fuenteVientoTerror: fuenteVientoTerror,
      vientoNormalGain: vientoNormalGain,
      vientoTerrorGain: vientoTerrorGain,
      vientoFiltro: vientoFiltro,
    };
  }

  /** Curva de clip suave (tanh normalizada) para el WaveShaper del IR. */
  _crearCurvaDistorsion() {
    const n = 1024;
    const dureza = 1.2; // tanh más suave: curva casi cúbica, sin zumbido agudo
    const normalizacion = Math.tanh(dureza);
    const curva = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curva[i] = Math.tanh(dureza * x) / normalizacion;
    }
    return curva;
  }

  /**
   * Arranca un loop de viento real saltando el silencio de los bordes.
   * Calcula loopStart/loopEnd del propio buffer con umbral ≈ −60 dB y un
   * margen de 50 ms para que el salto del loop caiga en zona silenciosa
   * (sin clics). Si el buffer es prácticamente silencioso, deja el loop entero.
   */
  _iniciarLoopReal(fuente) {
    const datos = fuente.buffer.getChannelData(0);
    const umbral = 0.001; // ≈ −60 dB
    const margen = 0.05;  // s
    const tasa = fuente.buffer.sampleRate;

    let inicio = 0;
    while (inicio < datos.length && Math.abs(datos[inicio]) < umbral) inicio++;
    let fin = datos.length - 1;
    while (fin > inicio && Math.abs(datos[fin]) < umbral) fin--;

    if (inicio >= fin) { // buffer silencioso: no hay nada que recortar
      fuente.start();
      return;
    }

    fuente.loopStart = Math.max(0, inicio / tasa - margen);
    fuente.loopEnd = Math.min(fuente.buffer.duration, (fin + 1) / tasa + margen);
    fuente.start(0, fuente.loopStart);
  }

  // ============================================================
  // Capas continuas
  // ============================================================

  /**
   * Detecta transiciones entre punto anterior y actual y actualiza el estado
   * de modo (IR, sobre tierra). Devuelve las banderas para los one-shots.
   * Con `puntoAnterior` null (inicio/scrub) sincroniza estados sin eventos.
   */
  _actualizarEstadosDeModo(punto, puntoAnterior) {
    const viento = this._numero(punto.viento_kt, 0);
    const flags = { hayAnterior: !!puntoAnterior, entroIR: false, salioIR: false, entroTierra: false, salioTierra: false };

    if (!puntoAnterior) {
      this._estado.enIR = !!punto.ir;
      this._estado.sobreTierra = !!punto.tocatierra;
      this._estado.vientoTocatierra = punto.tocatierra ? viento : null;
      return flags;
    }

    // IR: false→true dispara el salto de tono + armónico; true→false revierte.
    flags.entroIR = !puntoAnterior.ir && !!punto.ir;
    flags.salioIR = !!puntoAnterior.ir && !punto.ir;
    // El estado SIEMPRE refleja el dato: un salto de scrub puede saltarse la
    // transición adyacente true→false y dejaría el dron pegado en modo IR.
    this._estado.enIR = !!punto.ir;

    // Tocatierra: false→true dispara la muestra y el timbre seco.
    flags.entroTierra = !puntoAnterior.tocatierra && !!punto.tocatierra;
    if (flags.entroTierra) {
      this._estado.sobreTierra = true;
      this._estado.vientoTocatierra = viento;
    } else if (this._estado.sobreTierra &&
               this._estado.vientoTocatierra !== null &&
               viento >= this._estado.vientoTocatierra + 10) {
      // Reintensificación por encima del viento del tocatierra → vuelve "mar".
      this._estado.sobreTierra = false;
      flags.salioTierra = true;
    }

    return flags;
  }

  /**
   * DRON: presión → frecuencia (30·2^(u·2.2)) y oscuridad (cutoff 280−u·200).
   * IR: salto ×2,5 casi inmediato (~40 ms anti-clic) + armónico distorsionado sutil.
   */
  _actualizarDron(punto, ahora, transicion) {
    const presion = this._numero(punto.presion_mb, 1010);
    const u = this._acotar((1010 - presion) / 60, 0, 1);
    const fBase = 30 * Math.pow(2, u * 2.2); // ≈30 Hz (1010 mb) → ≈138 Hz (950 mb)
    const enIR = this._estado.enIR;
    const fDron = fBase * (enIR ? 2.5 : 1);
    const cutoff = 280 - u * 200; // menor presión → timbre más oscuro

    this._estado.u = u;
    this._estado.fBase = fBase;
    this._estado.fDron = fDron;
    this._estado.ultimoPunto = punto;

    const nodos = this._nodos;
    const entroIR = !!(transicion && transicion.entroIR);
    const salioIR = !!(transicion && transicion.salioIR);

    // τ normal 0,15 s; el salto del IR usa ~40 ms (suena inmediato, sin clic).
    const tau = entroIR ? 0.04 : (salioIR ? 0.08 : 0.15);
    nodos.oscPrincipal.frequency.setTargetAtTime(fDron, ahora, tau);
    nodos.oscSub.frequency.setTargetAtTime(fDron / 2, ahora, tau);
    nodos.dronFiltro.frequency.setTargetAtTime(cutoff, ahora, 0.15);

    // Armónico distorsionado (3·f): entra con ramp ~0,3 s y sale al abandonar el IR.
    nodos.oscArmonico.frequency.setTargetAtTime(3 * fDron, ahora, tau);
    if (entroIR) {
      this._rampaLineal(nodos.armonicoGain.gain, 0.06, ahora, 0.3);
    } else if (salioIR) {
      this._rampaLineal(nodos.armonicoGain.gain, 0.0001, ahora, 0.4);
    } else {
      // Estado sostenido (o re-aplicación al reanudar): mantener coherencia.
      nodos.armonicoGain.gain.setTargetAtTime(enIR ? 0.06 : 0.0001, ahora, 0.2);
    }
  }

  /**
   * VIENTO (grabaciones reales): dos loops en crossfade según cat_ss.
   *  - cat_ss ≥ 4 → huracanaterrador.mp3; cat_ss < 4 → huracan.mp3.
   *    Al cruzar el umbral 3↔4 el cruce dura ~0,6 s (rampas lineales).
   *  - Ganancia del loop activo por categoría (tabla bien separada) con una
   *    modulación fina de ±20 % según viento_kt (variación punto a punto).
   *  - Sobre tierra (tras tocatierra): el lowpass compartido baja a ~1.200 Hz
   *    (timbre seco); en mar abre a ~18 kHz. Rampas suaves.
   */
  _actualizarViento(punto, ahora) {
    const viento = this._numero(punto.viento_kt, 0);
    const cat = this._acotar(Math.round(this._numero(punto.cat_ss, 0)), 0, 5);
    const esTerror = cat >= 4;
    const loop = esTerror ? 'terrorifico' : 'normal';

    // Nivel base de la categoría + variación fina de ±20 % a lo largo de la
    // escala de viento (0,8 en el extremo bajo → 1,2 en el alto).
    const n = this._acotar((viento - 30) / 130, 0, 1);
    const factorViento = 1 + (n - 0.5) * (VIENTO_MODULACION * 2);
    const ganancia = VIENTO_GANANCIA_CAT[cat] * factorViento;

    const nodos = this._nodos;

    // Crossfade largo solo al cruzar el umbral; en el resto, rampa corta.
    const cruzoUmbral = this._estado.vientoLoop !== null && this._estado.vientoLoop !== loop;
    const duracion = cruzoUmbral ? VIENTO_CROSSFADE : 0.2;
    this._rampaLineal(nodos.vientoNormalGain.gain, esTerror ? 0 : ganancia, ahora, duracion);
    this._rampaLineal(nodos.vientoTerrorGain.gain, esTerror ? ganancia : 0, ahora, duracion);

    // Timbre mar/tierra: un solo filtro compartido para ambos loops.
    const cutoff = this._estado.sobreTierra ? VIENTO_CUTOFF_TIERRA : VIENTO_CUTOFF_MAR;
    nodos.vientoFiltro.frequency.setTargetAtTime(cutoff, ahora, 0.2);

    this._estado.viento = viento;
    this._estado.cat = cat;
    this._estado.vientoLoop = loop;
    this._estado.gananciaViento = ganancia;
  }

  // ============================================================
  // Eventos (one-shots)
  // ============================================================

  /** Golpe de tocatierra con ganancia fija alta. */
  _dispararTocatierra(ahora) {
    this._dispararMuestra(this._buffers.tocatierra, { cuando: ahora, ganancia: 0.95 });
  }

  /**
   * MUERTES: Δ > 0 → N = min(6, 1+⌊Δ/25⌋) pulsos repartidos en la ventana real.
   * Lotes grandes → playbackRate más grave y más pulsos.
   */
  _dispararMuertes(punto, puntoAnterior, ahora, ventana) {
    const delta = this._numero(punto.muertes_acum, 0) - this._numero(puntoAnterior.muertes_acum, 0);
    if (delta <= 0) return;

    const n = Math.min(6, 1 + Math.floor(delta / 25));
    const rate = Math.max(0.6, 1.05 - delta / 400);
    for (let i = 0; i < n; i++) {
      const cuando = ahora + ((i + 0.5) / n) * ventana; // repartidos en el paso
      this._dispararMuestra(this._buffers.pulso, { cuando: cuando, ganancia: 0.8, playbackRate: rate });
    }
  }

  /**
   * DAÑOS: Δ > 0 → N = min(12, 1+⌊Δ/5e9⌋) ráfagas granulares con jitter
   * aleatorio dentro de la ventana y ganancia proporcional al log10 del Δ.
   */
  _dispararDanos(punto, puntoAnterior, ahora, ventana) {
    const delta = this._numero(punto.danos_acum_usd, 0) - this._numero(puntoAnterior.danos_acum_usd, 0);
    if (delta <= 0) return;

    const n = Math.min(12, 1 + Math.floor(delta / 5e9));
    const ganancia = this._gananciaLog(delta);
    for (let i = 0; i < n; i++) {
      const cuando = ahora + Math.random() * ventana;
      // Ligera variación de velocidad para granularidad orgánica.
      const rate = 0.9 + Math.random() * 0.25;
      this._dispararMuestra(this._buffers.rafaga, { cuando: cuando, ganancia: ganancia, playbackRate: rate });
    }
  }

  /** Reproductor one-shot: bufferSource → ganancia puntual → masterGain, con limpieza. */
  _dispararMuestra(buffer, opciones) {
    if (!buffer) return;
    const ctx = this.ctx;

    const fuente = ctx.createBufferSource();
    fuente.buffer = buffer;
    if (opciones.playbackRate) fuente.playbackRate.value = opciones.playbackRate;

    const ganancia = ctx.createGain();
    ganancia.gain.value = opciones.ganancia;

    fuente.connect(ganancia);
    ganancia.connect(this.masterGain);
    fuente.onended = () => {
      try { fuente.disconnect(); ganancia.disconnect(); } catch (err) { /* ya desconectado */ }
    };

    fuente.start(Math.max(opciones.cuando, ctx.currentTime));
  }

  /**
   * Ventana real del paso: tiempo de audio transcurrido entre llamadas a
   * actualizar(). A 1×, un paso de 6 h ≈ 0,5 s; a 2× ≈ 0,25 s. Capada a 1,2 s
   * para que un scrub largo no deje eventos colgando sobre el paso siguiente.
   * (No se usa la diferencia entre marcas `t`: siempre son 6 h de dato.)
   */
  _ventanaEvento(ahora) {
    if (this._instanteUltimoPunto === null) return 0.6;
    return this._acotar(ahora - this._instanteUltimoPunto, 0.15, 1.2);
  }

  /** Ganancia ∝ log10 del delta en USD (saltos de miles de millones se oyen más). */
  _gananciaLog(delta) {
    const decadas = Math.log10(delta / 1e9 + 1);
    return this._acotar(0.18 + 0.18 * decadas, 0.15, 0.7);
  }

  // ============================================================
  // Control global
  // ============================================================

  /** Aplica volumen/mute/pausa al masterGain con rampa exponencial (setTargetAtTime). */
  _aplicarMaster(tau) {
    if (!this.masterGain || !this.ctx) return;
    const objetivo = (this._mudo || !this._reproduciendo) ? 0 : this._volumen;
    this.masterGain.gain.setTargetAtTime(objetivo, this.ctx.currentTime, tau);
  }

  /** Re-aplica los parámetros del último punto (al reanudar tras una pausa). */
  _reaplicarParametros() {
    const punto = this._estado.ultimoPunto;
    if (!punto || !this._nodos) return;
    const ahora = this.ctx.currentTime;
    this._actualizarDron(punto, ahora, { entroIR: false, salioIR: false });
    this._actualizarViento(punto, ahora);
  }

  // ============================================================
  // Depuración y utilidades
  // ============================================================

  /** Estado interno para verificación: mapeos aplicados y ganancia master. */
  _debug() {
    const nodos = this._nodos;
    const loop = this._estado.vientoLoop;
    const activa = loop === 'terrorifico' ? 'vientoTerrorGain' : 'vientoNormalGain';
    return {
      iniciado: this.iniciado,
      fDron: this._estado.fDron,
      cutoffDron: nodos ? nodos.dronFiltro.frequency.value : null,
      vientoLoop: loop,
      gananciaViento: nodos ? nodos[activa].gain.value : null,
      cutoffVientoFiltro: nodos ? nodos.vientoFiltro.frequency.value : null,
      cutoffTierra: this._estado.sobreTierra,
      gananciaVientoNormal: nodos ? nodos.vientoNormalGain.gain.value : null,
      gananciaVientoTerror: nodos ? nodos.vientoTerrorGain.gain.value : null,
      armonicoGain: nodos ? nodos.armonicoGain.gain.value : null,
      enIR: this._estado.enIR,
      sobreTierra: this._estado.sobreTierra,
      masterGain: this.masterGain ? this.masterGain.gain.value : null,
      volumen: this._volumen,
      mudo: this._mudo,
      reproduciendo: this._reproduciendo,
    };
  }

  /** Rampa lineal robusta: cancelAndHold si existe, si no cancel+setValueAtTime. */
  _rampaLineal(param, valor, ahora, duracion) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(ahora);
    } else {
      param.cancelScheduledValues(ahora);
      param.setValueAtTime(param.value, ahora);
    }
    param.linearRampToValueAtTime(valor, ahora + duracion);
  }

  /** Conversión segura a número finito. */
  _numero(valor, porDefecto) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : porDefecto;
  }

  /** clamp clásico. */
  _acotar(valor, min, max) {
    if (valor < min) return min;
    if (valor > max) return max;
    return valor;
  }
}

// Exponer en window además del binding global de la clase (compatibilidad).
window.MotorAudio = MotorAudio;
