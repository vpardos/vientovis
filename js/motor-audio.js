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
 *   VIENTO:           huracan.mp3 (loop: tramo elegido por análisis) → vientoNormalGain ────────────┐
 *                     huracanaterrador.mp3 (loop analizado, rate 0,88) → LP 2,2 kHz → vientoTerrorGain ─┴→ vientoFiltro (LP) → masterGain
 *   ONE-SHOTS:        bufferSource → ganancia puntual → masterGain
 *
 * Mapeos dato → parámetro
 * -----------------------
 *   u = clamp((1010 − presion_mb)/60, 0, 1)
 *   dron f = 30·2^(u·2.2) Hz (×2,5 en IR) · cutoff LP = 280 − u·200 Hz
 *   viento (grabaciones reales): cat_ss ≥ 4 → loop terrorífico; cat_ss < 4 → loop normal
 *           (crossfade ~0,6 s al cruzar el umbral 3↔4); ganancia por categoría
 *           0,07→0,85 con modulación fina ±20 % según viento_kt; el tramo de loop de cada
 *           grabación se elige por análisis RMS/ZCR (evita sirenas) y se refina su inicio
 *           para no arrancar en silencio; el terrorífico analiza solo a partir de ~20 s
 *           (su arranque es mudo) y añade rate 0,88 y lowpass propio ~2,2 kHz;
 *           tocatierra: lowpass compartido a 1.200 Hz (seco); en mar abierto a 18 kHz
 *   muertes: N = min(6, 1+⌊Δ/25⌋) pulsos repartidos en la ventana real del paso
 *   daños:   N = min(12, 1+⌊Δ/5e9⌋) ráfagas con jitter y ganancia ∝ log10(Δ)
 */

// ---------- Ajustes de la capa de viento real (huracan / huracanaterrador) ----------
// Ganancia del loop por categoría (cat_ss 0..5): niveles claramente separados y por
// encima de los one-shots para que el viento real domine la mezcla (antes ~0,04–0,58).
const VIENTO_GANANCIA_CAT = [0.07, 0.15, 0.27, 0.46, 0.71, 0.85];
const VIENTO_MODULACION = 0.20;    // variación fina ±20 % según viento_kt dentro de la categoría
const VIENTO_CUTOFF_MAR = 18000;   // lowpass compartido abierto en mar
const VIENTO_CUTOFF_TIERRA = 1200; // timbre seco tras tocatierra
const VIENTO_CROSSFADE = 0.6;      // segundos de crossfade al cruzar el umbral cat 3↔4

// Loop terrorífico (huracanaterrador, cat ≥ 4): la grabación trae silbidos/sirenas
// constantes; se le pone lowpass propio y se reproduce algo más grave para que
// suene a viento y no a "pitido".
const VIENTO_CUTOFF_TERROR = 2200; // lowpass propio del loop terrorífico (~2,2 kHz)
const VIENTO_RATE_TERROR = 0.88;   // playbackRate del loop terrorífico (más profundo)

// Balance de los one-shots frente al viento real (que ahora domina la mezcla).
const TOCATIERRA_GANANCIA = 0.55;   // antes 0,95: el golpe se destaca sin aplastar el viento
const RAFAGA_BALANCE = 0.75;       // −25 % a las ráfagas de daños (el pulso de muerte no cambia)

// Análisis de contenido para elegir el tramo de loop de cada grabación (RMS + ZCR).
const LOOP_VENTANA_ANALISIS = 1.0; // s de ventana deslizante
const LOOP_SALTO_ANALISIS = 0.5;   // s de salto entre ventanas
const LOOP_MIN_S = 4;              // duración mínima aceptable del tramo de loop
const LOOP_MAX_S = 14;             // duración máxima del tramo de loop

// Refinamiento del inicio del loop (aplica a AMBOS loops): tras elegir el tramo,
// el loopStart avanza hasta el primer frame corto con RMS ≥ LOOP_REF_RMS_PCT del
// RMS máximo del buffer (umbral relativo: salta silencios y respiraciones leves
// sin depender del nivel absoluto) y retrocede LOOP_REF_MARGEN para no cortar el
// ataque. Resuelve el silencio inicial de huracan.mp3 (loop normal).
const LOOP_REF_RMS_PCT = 0.40;   // fracción del RMS máximo del buffer
const LOOP_REF_MARGEN = 0.15;    // s de margen antes del primer frame audible
const LOOP_REF_FRAME = 0.02;     // s por frame del análisis de refinamiento

// huracanaterrador.mp3 (~72 s) trae ~20 s de silencio/relleno al comienzo: su
// análisis y elección de tramo se restringen a partir de este instante. El loop
// normal usa 0: su silencio inicial lo resuelve el refinamiento de arriba.
const LOOP_SKIP_TERROR = 20;    // s a saltar al inicio del loop terrorífico

// Cola reservada al final de cada grabación: el loopEnd nunca supera
// duración − LOOP_MARGEN_FIN (evita fades/silencios de cierre).
const LOOP_MARGEN_FIN = 1.0;    // s

class MotorAudio {
  constructor() {
    // El AudioContext se crea en iniciar() (requiere gesto del usuario).
    this.ctx = null;
    this.iniciado = false;
    this._promesaInicio = null;

    // Control global (se guardan aunque el motor no esté iniciado).
    this._volumen = 0.7;       // 0..1
    this._mudo = false;
    this._reproduciendo = false; // silencio hasta que la app llame setReproduciendo(true) al dar play

    // Nodos de audio (se crean en _construirGrafo).
    this.masterGain = null;
    this._nodos = null;

    // Buffers mp3 decodificados (dos grabaciones reales de viento + tres one-shots).
    this._buffers = { tocatierra: null, pulso: null, rafaga: null, huracan: null, huracanaterrador: null };

    // Tramo de loop elegido por análisis de contenido para cada grabación
    // (ver _analizarLoop); se expone en _debug() como loopSegNormal/loopSegTerror.
    this._loopInfo = { normal: null, terrorifico: null };

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

    // Lowpass propio del loop terrorífico: apaga el silbido agudo constante de esa
    // grabación sin oscurecer el loop normal. El filtro compartido (mar/tierra)
    // sigue después, igual que antes.
    const filtroVientoTerror = ctx.createBiquadFilter();
    filtroVientoTerror.type = 'lowpass';
    filtroVientoTerror.frequency.value = VIENTO_CUTOFF_TERROR;
    filtroVientoTerror.Q.value = 0.7;

    fuenteVientoNormal.connect(vientoNormalGain);
    fuenteVientoTerror.connect(filtroVientoTerror);
    filtroVientoTerror.connect(vientoTerrorGain);
    vientoNormalGain.connect(vientoFiltro);
    vientoTerrorGain.connect(vientoFiltro);
    vientoFiltro.connect(masterGain);

    // Arrancar fuentes continuas con el tramo de loop elegido por análisis de
    // contenido (RMS+ZCR): descarta tramos tonales (sirenas/alarmas) y refina el
    // inicio para no arrancar en silencio; el terrorífico además analiza solo a
    // partir de LOOP_SKIP_TERROR (~20 s, su arranque es mudo) y va más grave.
    this._configurarLoopViento(fuenteVientoNormal, 'normal', { playbackRate: 1, saltarInicio: 0 });
    this._configurarLoopViento(fuenteVientoTerror, 'terrorifico', { playbackRate: VIENTO_RATE_TERROR, saltarInicio: LOOP_SKIP_TERROR });
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
      filtroVientoTerror: filtroVientoTerror,
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
   * Configura y arranca un loop de viento con el tramo elegido por _analizarLoop
   * (reemplaza al antiguo recorte de silencios de borde). `clave` = 'normal' |
   * 'terrorifico'; `opciones.saltarInicio` (s) se salta al inicio del análisis
   * (el terrorífico ignora así sus primeros ~20 s mudos); guarda el resultado en
   * this._loopInfo para _debug().
   */
  _configurarLoopViento(fuente, clave, opciones) {
    const saltar = opciones && opciones.saltarInicio > 0 ? opciones.saltarInicio : 0;
    const seg = this._analizarLoop(fuente.buffer, saltar);
    fuente.loopStart = seg.inicio;
    fuente.loopEnd = Math.min(seg.fin, fuente.buffer.duration);
    if (opciones && opciones.playbackRate) fuente.playbackRate.value = opciones.playbackRate;
    this._loopInfo[clave] = seg;
    fuente.start(0, fuente.loopStart);
  }

  /**
   * Elige el tramo de loop de una grabación de viento por análisis de contenido
   * (runtime, barato: una pasada O(n) más una búsqueda O(m·k) sobre ~m≈duración/0,5).
   *   - `saltarInicio` (s): la zona analizable arranca aquí (el terrorífico salta
   *     sus primeros ~20 s, mudos). La zona reserva siempre LOOP_MARGEN_FIN al
   *     final: loopEnd ≤ duración − LOOP_MARGEN_FIN.
   *   - Ventanas deslizantes de 1 s (salto 0,5 s): por ventana se calcula RMS y la
   *     tasa de cruces por cero (ZCR, proxy de tonalidad: tono sostenido → ZCR bajo
   *     y estable; viento broadband → ZCR alto e irregular).
   *   - Peso = energía normalizada × irregularidad del ZCR × tendencia a ZCR alto.
   *     Los tramos dominados por tono sostenido (RMS alto con ZCR muy por debajo
   *     de la mediana audible: sirenas/alarmas) reciben peso negativo, de modo que
   *     el tramo elegido no los cruza.
   *   - Se elige el tramo contiguo de máximo peso con duración entre LOOP_MIN_S y
   *     LOOP_MAX_S y se ajustan los bordes al cruce por cero más cercano (±40 ms)
   *     para que el salto del loop no chasquee.
   *   - Al final se refina el inicio (_refinarInicioLoop): aunque el análisis haya
   *     elegido un tramo que arranca en una parte muda, el loop salta ese silencio.
   * Si la zona analizable es demasiado corta o prácticamente silenciosa (p. ej. el
   * tramo ≥20 s del terrorífico sin contenido), usa como fallback la grabación
   * completa + el mismo refinamiento de inicio, recortando la cola.
   */
  _analizarLoop(buffer, saltarInicio) {
    const sr = buffer.sampleRate;
    const dur = buffer.duration;
    const datos = buffer.getChannelData(0); // canal 0 basta: contenido correlacionado
    const n = datos.length;

    const ventana = Math.max(64, Math.round(LOOP_VENTANA_ANALISIS * sr));
    const salto = Math.max(32, Math.round(LOOP_SALTO_ANALISIS * sr));

    // Zona analizable [base, tope): salta el arranque pedido (terrorífico: ~20 s
    // mudos) y reserva la cola (loopEnd ≤ duración − LOOP_MARGEN_FIN).
    const saltar = saltarInicio > 0 ? saltarInicio : 0;
    const base = this._acotar(Math.round(saltar * sr), 0, Math.max(0, n - 1));
    const tope = Math.min(n, Math.max(base + ventana, n - Math.round(LOOP_MARGEN_FIN * sr)));
    const m = tope - ventana >= base ? Math.floor((tope - ventana - base) / salto) + 1 : 0;

    const rms = new Float64Array(m);
    const zcr = new Float64Array(m);
    for (let w = 0; w < m; w++) {
      const ini = base + w * salto;
      const fin = Math.min(tope, ini + ventana);
      let suma = 0;
      let cruces = 0;
      let positivo = datos[ini] >= 0;
      for (let i = ini; i < fin; i++) {
        const x = datos[i];
        suma += x * x;
        const signo = x >= 0;
        if (signo !== positivo) cruces++;
        positivo = signo;
      }
      const cuenta = Math.max(1, fin - ini);
      rms[w] = Math.sqrt(suma / cuenta);
      zcr[w] = cruces / cuenta; // cruces por muestra
    }

    // Estadísticas adaptativas sobre ventanas audibles (el silencio y el hiss
    // apenas rozan las cuerdas y falsearían los umbrales de ZCR).
    let rmsMax = 0;
    let zcrMax = 0;
    for (let w = 0; w < m; w++) {
      if (rms[w] > rmsMax) rmsMax = rms[w];
      if (zcr[w] > zcrMax) zcrMax = zcr[w];
    }
    const audibles = [];
    for (let w = 0; w < m; w++) {
      if (rmsMax > 0 && rms[w] >= 0.1 * rmsMax) audibles.push(zcr[w]);
    }
    audibles.sort((a, b) => a - b);
    const zcrRef = audibles.length ? audibles[Math.floor(audibles.length / 2)] : 0;

    // Peso por ventana: energía × irregularidad del ZCR × "broadbandness".
    // Tono sostenido (sirena/alarma): mucho RMS con ZCR muy por debajo de la
    // referencia audible → peso negativo, para que el tramo elegido no lo cruce.
    const pesos = new Float64Array(m);
    const tonales = new Uint8Array(m);
    for (let w = 0; w < m; w++) {
      const rmsNorm = rmsMax > 1e-5 ? rms[w] / rmsMax : 0;
      const zcrNorm = zcrMax > 0 ? zcr[w] / zcrMax : 0;
      const irregular = Math.min(1, Math.abs(zcr[w] - zcrRef) / (zcrRef + 1e-9));
      tonales[w] = (rmsNorm >= 0.5 && zcrRef > 0 && zcr[w] <= zcrRef * 0.55) ? 1 : 0;
      let peso = rmsNorm * (0.5 + 0.5 * irregular) * (0.75 + 0.25 * zcrNorm);
      if (tonales[w]) peso = -rmsNorm;
      pesos[w] = peso;
    }

    // Duración del tramo en nº de ventanas. Ventana w cubre [w·salto, w·salto+ventana].
    const ventanasMin = Math.max(1, Math.ceil((LOOP_MIN_S * sr - ventana) / salto) + 1);
    const ventanasMax = Math.max(ventanasMin, Math.min(m, Math.floor((LOOP_MAX_S * sr - ventana) / salto) + 1));

    if (m < ventanasMin || rmsMax < 1e-4) {
      // Zona corta o casi silenciosa (p. ej. el tramo ≥20 s del terrorífico sin
      // contenido audible): fallback = grabación completa, con el mismo
      // refinamiento de inicio y la cola reservada.
      const tramoFallback = this._finalizarTramo(datos, sr, dur, 0, dur);
      return { inicio: tramoFallback.inicio, fin: tramoFallback.fin, zcrRef: Number(zcrRef.toFixed(4)), tonalPct: 0 };
    }

    // Tramo contiguo de máximo peso (sumas prefijas; m es pequeño, ~duración/0,5 s).
    const pref = new Float64Array(m + 1);
    for (let w = 0; w < m; w++) pref[w + 1] = pref[w] + pesos[w];

    let mejorI = 0;
    let mejorJ = ventanasMin - 1;
    let mejorSuma = -Infinity;
    for (let i = 0; i < m; i++) {
      const jMax = Math.min(m - 1, i + ventanasMax - 1);
      const jMin = i + ventanasMin - 1;
      for (let j = jMin; j <= jMax; j++) {
        const suma = pref[j + 1] - pref[i];
        if (suma > mejorSuma + 1e-12) {
          mejorSuma = suma;
          mejorI = i;
          mejorJ = j;
        }
      }
    }

    let inicio = (base + mejorI * salto) / sr;
    let fin = Math.min(tope, base + mejorJ * salto + ventana) / sr;

    // Ajuste fino a cruces por cero cercanos (±40 ms): el salto del loop no chasquea.
    const radio = Math.round(0.04 * sr);
    const iniAjustado = this._cruceroCercano(datos, Math.round(inicio * sr), radio);
    const finAjustado = this._cruceroCercano(datos, Math.round(fin * sr), radio);
    if (iniAjustado !== null) inicio = iniAjustado / sr;
    if (finAjustado !== null) fin = finAjustado / sr;
    if (fin - inicio < 0.25) {
      // El ajuste nunca debería invertir el tramo; si pasa, se conserva el analítico.
      inicio = (base + mejorI * salto) / sr;
      fin = Math.min(tope, base + mejorJ * salto + ventana) / sr;
    }

    // El tramo nunca arranca antes de la zona analizable (terrorífico: ≥20 s), ni
    // siquiera tras el ajuste fino a cruces por cero (±40 ms).
    if (inicio < base / sr) inicio = base / sr;

    let cuentaTonal = 0;
    for (let w = mejorI; w <= mejorJ; w++) cuentaTonal += tonales[w];
    const tonalPct = Math.round((100 * cuentaTonal) / (mejorJ - mejorI + 1));

    // Epílogo común: refinamiento del inicio (salta el silencio inicial) + cola reservada.
    const tramo = this._finalizarTramo(datos, sr, dur, inicio, fin);

    return {
      inicio: tramo.inicio,
      fin: tramo.fin,
      zcrRef: Number(zcrRef.toFixed(4)),
      tonalPct: tonalPct,
    };
  }

  /**
   * Epílogo común del tramo de loop: refina el inicio con _refinarInicioLoop y
   * garantiza loopEnd ≤ duración − LOOP_MARGEN_FIN (si el buffer fuera diminuto,
   * conserva al menos ~0,25 s de tramo). Devuelve { inicio, fin } en segundos.
   */
  _finalizarTramo(datos, sr, dur, inicio, fin) {
    const inicioRefinado = this._refinarInicioLoop(datos, sr, inicio, fin);
    let finFinal = fin;
    const finTope = dur - LOOP_MARGEN_FIN;
    if (finFinal > finTope) finFinal = Math.max(finTope, Math.min(inicioRefinado + 0.25, dur));
    return { inicio: inicioRefinado, fin: finFinal };
  }

  /**
   * Refinamiento del inicio del loop (ambos loops): busca, a partir del inicio
   * elegido por el análisis, el primer frame corto (LOOP_REF_FRAME s) con RMS ≥
   * LOOP_REF_RMS_PCT del RMS máximo del buffer —umbral relativo que descarta
   * silencios y respiraciones leves sin depender del nivel absoluto— y retrocede
   * LOOP_REF_MARGEN para no cortar el ataque del viento. La detección se confirma
   * con el frame siguiente (~30 ms) para no confundir un clic aislado con el
   * arranque real. Solo avanza (jamás retrocede el inicio elegido) y nunca deja
   * menos de ~0,5 s de tramo hasta `fin`; si no encuentra contenido por encima del
   * umbral, conserva `inicio`.
   */
  _refinarInicioLoop(datos, sr, inicio, fin) {
    const n = datos.length;
    const frame = Math.max(64, Math.round(LOOP_REF_FRAME * sr));
    const salto = Math.max(32, Math.round(frame / 2));
    const desdeMuestra = this._acotar(Math.round(inicio * sr), 0, Math.max(0, n - 1));

    // RMS por frame corto sobre el buffer completo: máximo de referencia (no solo
    // la zona analizada) y búsqueda del primer frame audible desde el inicio elegido.
    const mFrames = Math.max(1, Math.ceil(n / salto));
    const rmsFrames = new Float64Array(mFrames);
    let rmsMax = 0;
    for (let f = 0; f < mFrames; f++) {
      const ini = f * salto;
      const finFrame = Math.min(n, ini + frame);
      let suma = 0;
      for (let i = ini; i < finFrame; i++) {
        const x = datos[i];
        suma += x * x;
      }
      const r = Math.sqrt(suma / Math.max(1, finFrame - ini));
      rmsFrames[f] = r;
      if (r > rmsMax) rmsMax = r;
    }
    if (rmsMax < 1e-4) return inicio; // buffer prácticamente silencioso: nada que refinar

    const umbral = rmsMax * LOOP_REF_RMS_PCT;
    const fDesde = Math.min(mFrames - 1, Math.floor(desdeMuestra / salto));
    let audible = -1;
    for (let f = fDesde; f < mFrames; f++) {
      const aqui = rmsFrames[f] >= umbral && (f + 1 >= mFrames || rmsFrames[f + 1] >= umbral);
      if (aqui) { audible = f * salto; break; }
    }
    if (audible < 0) return inicio; // nada por encima del umbral: conservar el inicio elegido

    const refinado = Math.max(0, audible / sr - LOOP_REF_MARGEN);
    // Solo avanza; si dejara un tramo inviable, se conserva el inicio original.
    if (refinado <= inicio || fin - refinado < 0.5) return inicio;
    return refinado;
  }

  /** Índice del cruce por cero (cambio de signo) más cercano a `centro` dentro
   *  de ±radio muestras; null si no se encuentra ninguno. */
  _cruceroCercano(datos, centro, radio) {
    const n = datos.length;
    const desde = Math.max(0, centro - radio);
    const hasta = Math.min(n - 2, centro + radio);
    for (let d = 0; d <= radio; d++) {
      const a = centro - d;
      if (a >= desde && a <= hasta && (datos[a] >= 0) !== (datos[a + 1] >= 0)) return a;
      const b = centro + d;
      if (b >= desde && b <= hasta && (datos[b] >= 0) !== (datos[b + 1] >= 0)) return b;
    }
    return null;
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

  /** Golpe de tocatierra: fijo, por debajo del viento (que ahora domina la mezcla). */
  _dispararTocatierra(ahora) {
    this._dispararMuestra(this._buffers.tocatierra, { cuando: ahora, ganancia: TOCATIERRA_GANANCIA });
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
   * actualizar(). A ×0,25, un paso de 6 h ≈ 2 s. Capada a 1,2 s para que un
   * scrub largo no deje eventos colgando sobre el paso siguiente.
   * (No se usa la diferencia entre marcas `t`: siempre son 6 h de dato.)
   */
  _ventanaEvento(ahora) {
    if (this._instanteUltimoPunto === null) return 0.6;
    return this._acotar(ahora - this._instanteUltimoPunto, 0.15, 1.2);
  }

  /** Ganancia ∝ log10 del delta en USD (saltos de miles de millones se oyen más),
   *  ×0,75 para que las ráfagas se destaquen sin aplastar el viento real. */
  _gananciaLog(delta) {
    const decadas = Math.log10(delta / 1e9 + 1);
    const base = 0.18 + 0.18 * decadas;
    return this._acotar(base * RAFAGA_BALANCE, 0.15 * RAFAGA_BALANCE, 0.7 * RAFAGA_BALANCE);
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
      cutoffVientoTerror: nodos ? nodos.filtroVientoTerror.frequency.value : null,
      rateVientoTerror: nodos ? nodos.fuenteVientoTerror.playbackRate.value : null,
      loopSegNormal: this._loopInfo.normal ? [Number(this._loopInfo.normal.inicio.toFixed(2)), Number(this._loopInfo.normal.fin.toFixed(2))] : null,
      loopSegTerror: this._loopInfo.terrorifico ? [Number(this._loopInfo.terrorifico.inicio.toFixed(2)), Number(this._loopInfo.terrorifico.fin.toFixed(2))] : null,
      loopTonalNormal: this._loopInfo.normal ? this._loopInfo.normal.tonalPct : null,
      loopTonalTerror: this._loopInfo.terrorifico ? this._loopInfo.terrorifico.tonalPct : null,
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
