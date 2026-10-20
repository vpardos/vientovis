/**
 * motor-audio.js — Motor de sonificación de "vientovis" (V1).
 *
 * Grafo: masterGain → compresor → destination
 *   DRON:    oscPrincipal (triangle) + oscSub (f/2) → dronGain → dronFiltro (LP) → masterGain
 *   VIENTO:  huracan.mp3 → vientoNormalGain ──┐
 *            huracanaterrador.mp3 → LP(2,2k) → vientoTerrorGain ─┴→ vientoFiltro (LP) → masterGain
 *   ONE-SHOTS: bufferSource → gain → masterGain
 *
 * Mapeos:  u = clamp((1010−presion_mb)/60, 0,1)
 *   dron   f = 30·2^(u·2.2) Hz · LP cutoff = 280−u·200 Hz
 *   viento cat≥4 → loop terrorífico (rate 0,88, LP 2,2k), crossfade 0,6 s al cruzar 3↔4
 *          ganancia tabla [0,07..0,85] × modulación ±20% viento_kt
 *          tocatierra → LP 1,2 kHz (seco) | mar → 18 kHz
 *   muertes N = min(6,  1+⌊Δ/25⌋)   pulsos en ventana real
 *   daños   N = min(12, 1+⌊Δ/5e9⌋)  ráfagas con jitter y ganancia ∝ log10(Δ)
 */

// — Viento —
const VIENTO_GANANCIA_CAT  = [0.07, 0.15, 0.27, 0.46, 0.71, 0.85]; // por cat_ss 0..5
const VIENTO_MODULACION    = 0.20;   // ±20 % según viento_kt
const VIENTO_CUTOFF_MAR    = 18000;  // LP compartido en mar
const VIENTO_CUTOFF_TIERRA = 1200;   // LP seco tras tocatierra
const VIENTO_CROSSFADE     = 0.6;    // s de crossfade al cruzar umbral cat 3↔4
const VIENTO_CUTOFF_TERROR = 2200;   // LP propio del loop terrorífico
const VIENTO_RATE_TERROR   = 0.88;   // playbackRate terrorífico (más grave)
const TOCATIERRA_GANANCIA  = 0.55;
const RAFAGA_BALANCE       = 0.75;   // −25 % a las ráfagas de daños

// — Análisis de loop (RMS + ZCR, búsqueda O(m) por ventana deslizante) —
const LOOP_VENTANA_ANALISIS = 1.0;  // s ventana
const LOOP_SALTO_ANALISIS   = 0.5;  // s salto
const LOOP_MIN_S            = 4;    // duración mínima del tramo
const LOOP_MAX_S            = 14;   // duración máxima
const LOOP_REF_RMS_PCT      = 0.40; // umbral relativo para refinamiento de inicio
const LOOP_REF_MARGEN       = 0.15; // s de margen antes del primer frame audible
const LOOP_REF_FRAME        = 0.02; // s por frame de refinamiento
const LOOP_SKIP_TERROR      = 20;   // s a saltar al inicio del terrorífico (silencio)
const LOOP_MARGEN_FIN       = 1.0;  // s reservados al final de cada grabación

class MotorAudio {
  constructor() {
    this.ctx              = null;
    this.iniciado         = false;
    this._promesaInicio   = null;
    this._volumen         = 0.7;
    this._mudo            = false;
    this._reproduciendo   = false;
    this.masterGain       = null;
    this._nodos           = null;
    this._buffers         = { tocatierra: null, pulso: null, rafaga: null, huracan: null, huracanaterrador: null };
    this._loopInfo        = { normal: null, terrorifico: null };
    this._estado          = {
      u: null, fBase: 30, fDron: 30,
      viento: null, cat: null, vientoLoop: null, gananciaViento: null,
      sobreTierra: false, vientoTocatierra: null, ultimoPunto: null,
    };
    this._ultimoPuntoCrudo    = null;
    this._instanteUltimoPunto = null;
    this._ultimaClave         = null;
  }

  // ── API pública ──────────────────────────────────────────────

  /** Inicializa el AudioContext y carga los assets. Idempotente. */
  async iniciar() {
    if (this.iniciado) return;
    if (this._promesaInicio) return this._promesaInicio;
    this._promesaInicio = this._iniciarInterno().catch(err => {
      this._promesaInicio = null;
      throw err;
    });
    return this._promesaInicio;
  }

  setVolumen(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    this._volumen = this._acotar(n, 0, 1);
    if (this.iniciado) try { this._aplicarMaster(0.05); } catch (e) { console.error('[MotorAudio] setVolumen():', e); }
  }

  setMudo(mudo) {
    this._mudo = !!mudo;
    if (this.iniciado) try { this._aplicarMaster(0.08); } catch (e) { console.error('[MotorAudio] setMudo():', e); }
  }

  setReproduciendo(reproduciendo) {
    this._reproduciendo = !!reproduciendo;
    if (!this.iniciado) return;
    try {
      if (this._reproduciendo) this._reaplicarParametros();
      this._aplicarMaster(this._reproduciendo ? 0.12 : 0.2);
    } catch (e) { console.error('[MotorAudio] setReproduciendo():', e); }
  }

  /** Llamado en cada cambio de punto activo. Nunca lanza. */
  actualizar(punto, puntoAnterior) {
    if (!punto) return;
    this._ultimoPuntoCrudo = punto;
    if (!this.iniciado) return;
    try {
      const ahora = this.ctx.currentTime;
      const trans = this._actualizarEstadosDeModo(punto, puntoAnterior);
      this._actualizarDron(punto, ahora);
      this._actualizarViento(punto, ahora);
      if (trans.hayAnterior) {
        const clave = `${punto.t}|${puntoAnterior.t}`;
        if (clave !== this._ultimaClave) {
          this._ultimaClave = clave;
          const ventana = this._ventanaEvento(ahora);
          if (trans.entroTierra) this._dispararTocatierra(ahora);
          this._dispararMuertes(punto, puntoAnterior, ahora, ventana);
          this._dispararDanos(punto, puntoAnterior, ahora, ventana);
        }
      }
      this._instanteUltimoPunto = ahora;
    } catch (e) { console.error('[MotorAudio] actualizar():', e); }
  }

  // ── Arranque ─────────────────────────────────────────────────

  async _iniciarInterno() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('[MotorAudio] Web Audio API no disponible.');
    const ctx = this.ctx = new AC();
    try {
      await ctx.resume();
      const [tocatierra, pulso, rafaga, huracan, huracanaterrador] = await Promise.all([
        this._cargarBuffer('audio/tocatierra.mp3'),
        this._cargarBuffer('audio/pulso-muerte.mp3'),
        this._cargarBuffer('audio/rafaga-dano.mp3'),
        this._cargarBuffer('audio/huracan.mp3'),
        this._cargarBuffer('audio/huracanaterrador.mp3'),
      ]);
      this._buffers = { tocatierra, pulso, rafaga, huracan, huracanaterrador };
      this._construirGrafo();
      this.iniciado = true;
      this._aplicarMaster(0.05);
      if (this._ultimoPuntoCrudo) this.actualizar(this._ultimoPuntoCrudo, null);
    } catch (err) {
      try { await ctx.close(); } catch (_) {}
      this.ctx = null;
      throw new Error('[MotorAudio] No se pudo iniciar: ' + err.message);
    }
  }

  async _cargarBuffer(ruta) {
    let r;
    try { r = await fetch(ruta); }
    catch (e) { throw new Error(`No se pudo descargar ${ruta} (${e.message})`); }
    if (!r.ok) throw new Error(`No se pudo descargar ${ruta} (HTTP ${r.status})`);
    const datos = await r.arrayBuffer();
    try {
      return await new Promise((ok, ko) => this.ctx.decodeAudioData(datos, ok, ko));
    } catch (e) {
      throw new Error(`No se pudo decodificar ${ruta} (${e && e.message ? e.message : e})`);
    }
  }

  _construirGrafo() {
    const ctx = this.ctx;
    const mk  = type => ctx[`create${type}`]();

    // Master
    const masterGain = ctx.createGain(); masterGain.gain.value = 0;
    const protector  = ctx.createDynamicsCompressor();
    protector.threshold.value = -12; protector.knee.value = 20;
    protector.ratio.value = 6; protector.attack.value = 0.004; protector.release.value = 0.25;
    masterGain.connect(protector);
    protector.connect(ctx.destination);
    this.masterGain = masterGain;

    // Dron: oscPrincipal + oscSub → dronGain → dronFiltro → master
    const dronGain   = mk('Gain');      dronGain.gain.value = 0.06;
    const dronFiltro = mk('BiquadFilter'); dronFiltro.type = 'lowpass'; dronFiltro.frequency.value = 280; dronFiltro.Q.value = 0.8;
    const oscPrincipal = mk('Oscillator'); oscPrincipal.type = 'triangle'; oscPrincipal.frequency.value = 30; oscPrincipal.detune.value = 5;
    const oscSub       = mk('Oscillator'); oscSub.type = 'triangle';       oscSub.frequency.value = 15;  oscSub.detune.value = -7;
    oscPrincipal.connect(dronGain); oscSub.connect(dronGain);
    dronGain.connect(dronFiltro); dronFiltro.connect(masterGain);

    // Viento: dos fuentes en loop con crossfade
    const fNormal = mk('BufferSource'); fNormal.buffer = this._buffers.huracan;          fNormal.loop = true;
    const fTerror = mk('BufferSource'); fTerror.buffer = this._buffers.huracanaterrador; fTerror.loop = true;
    const vientoNormalGain = mk('Gain'); vientoNormalGain.gain.value = 0;
    const vientoTerrorGain = mk('Gain'); vientoTerrorGain.gain.value = 0;
    const vientoFiltro     = mk('BiquadFilter'); vientoFiltro.type = 'lowpass'; vientoFiltro.frequency.value = VIENTO_CUTOFF_MAR; vientoFiltro.Q.value = 0.7;
    const filtroTerror     = mk('BiquadFilter'); filtroTerror.type = 'lowpass'; filtroTerror.frequency.value = VIENTO_CUTOFF_TERROR; filtroTerror.Q.value = 0.7;
    fNormal.connect(vientoNormalGain);
    fTerror.connect(filtroTerror); filtroTerror.connect(vientoTerrorGain);
    vientoNormalGain.connect(vientoFiltro); vientoTerrorGain.connect(vientoFiltro);
    vientoFiltro.connect(masterGain);

    this._configurarLoopViento(fNormal, 'normal',      { playbackRate: 1,                  saltarInicio: 0 });
    this._configurarLoopViento(fTerror, 'terrorifico', { playbackRate: VIENTO_RATE_TERROR, saltarInicio: LOOP_SKIP_TERROR });
    oscPrincipal.start(); oscSub.start();

    this._nodos = { protector, dronGain, dronFiltro, oscPrincipal, oscSub,
                    fuenteVientoNormal: fNormal, fuenteVientoTerror: fTerror,
                    filtroVientoTerror: filtroTerror, vientoNormalGain, vientoTerrorGain, vientoFiltro };
  }

  // ── Análisis y configuración de loops ────────────────────────

  _configurarLoopViento(fuente, clave, { playbackRate = 1, saltarInicio = 0 } = {}) {
    const seg = this._analizarLoop(fuente.buffer, saltarInicio);
    fuente.loopStart = seg.inicio;
    fuente.loopEnd   = Math.min(seg.fin, fuente.buffer.duration);
    fuente.playbackRate.value = playbackRate;
    this._loopInfo[clave] = seg;
    fuente.start(0, fuente.loopStart);
  }

  /**
   * Elige el tramo de loop por análisis RMS + ZCR.
   * Búsqueda: O(m) por tamaño de ventana con suma prefija (antes O(m²)).
   */
  _analizarLoop(buffer, saltarInicio = 0) {
    const sr    = buffer.sampleRate;
    const dur   = buffer.duration;
    const datos = buffer.getChannelData(0);
    const n     = datos.length;
    const ven   = Math.max(64, Math.round(LOOP_VENTANA_ANALISIS * sr));
    const sal   = Math.max(32, Math.round(LOOP_SALTO_ANALISIS * sr));
    const base  = this._acotar(Math.round(saltarInicio * sr), 0, Math.max(0, n - 1));
    const tope  = Math.min(n, Math.max(base + ven, n - Math.round(LOOP_MARGEN_FIN * sr)));
    const m     = tope - ven >= base ? Math.floor((tope - ven - base) / sal) + 1 : 0;

    // Calcular RMS y ZCR por ventana
    const rms = new Float64Array(m);
    const zcr = new Float64Array(m);
    for (let w = 0; w < m; w++) {
      const ini = base + w * sal;
      const fin = Math.min(tope, ini + ven);
      let suma = 0, cruces = 0, pos = datos[ini] >= 0;
      for (let i = ini; i < fin; i++) {
        const x = datos[i], s = x >= 0;
        suma += x * x;
        if (s !== pos) cruces++;
        pos = s;
      }
      const cnt = Math.max(1, fin - ini);
      rms[w] = Math.sqrt(suma / cnt);
      zcr[w] = cruces / cnt;
    }

    // Estadísticas adaptativas
    let rmsMax = 0, zcrMax = 0;
    for (let w = 0; w < m; w++) {
      if (rms[w] > rmsMax) rmsMax = rms[w];
      if (zcr[w] > zcrMax) zcrMax = zcr[w];
    }
    const audibles = [];
    for (let w = 0; w < m; w++) if (rmsMax > 0 && rms[w] >= 0.1 * rmsMax) audibles.push(zcr[w]);
    audibles.sort((a, b) => a - b);
    const zcrRef = audibles.length ? audibles[Math.floor(audibles.length / 2)] : 0;

    // Pesos (tono sostenido → peso negativo)
    const pesos  = new Float64Array(m);
    const tonales = new Uint8Array(m);
    for (let w = 0; w < m; w++) {
      const rN = rmsMax > 1e-5 ? rms[w] / rmsMax : 0;
      const zN = zcrMax > 0    ? zcr[w] / zcrMax  : 0;
      const irr = Math.min(1, Math.abs(zcr[w] - zcrRef) / (zcrRef + 1e-9));
      tonales[w] = (rN >= 0.5 && zcrRef > 0 && zcr[w] <= zcrRef * 0.55) ? 1 : 0;
      pesos[w] = tonales[w] ? -rN : rN * (0.5 + 0.5 * irr) * (0.75 + 0.25 * zN);
    }

    const vMin = Math.max(1, Math.ceil((LOOP_MIN_S * sr - ven) / sal) + 1);
    const vMax = Math.max(vMin, Math.min(m, Math.floor((LOOP_MAX_S * sr - ven) / sal) + 1));

    if (m < vMin || rmsMax < 1e-4) {
      const fb = this._finalizarTramo(datos, sr, dur, 0, dur);
      return { inicio: fb.inicio, fin: fb.fin, zcrRef: +zcrRef.toFixed(4), tonalPct: 0 };
    }

    // Sumas prefijas + ventana deslizante O(m) por tamaño k
    const pref = new Float64Array(m + 1);
    for (let w = 0; w < m; w++) pref[w + 1] = pref[w] + pesos[w];

    let mejorI = 0, mejorK = vMin, mejorSuma = -Infinity;
    for (let k = vMin; k <= vMax; k++) {
      for (let i = 0; i + k <= m; i++) {
        const s = pref[i + k] - pref[i];
        if (s > mejorSuma + 1e-12) { mejorSuma = s; mejorI = i; mejorK = k; }
      }
    }
    const mejorJ = mejorI + mejorK - 1;

    let inicio = (base + mejorI * sal) / sr;
    let fin    = Math.min(tope, base + mejorJ * sal + ven) / sr;

    // Ajuste fino a cruces por cero (±40 ms)
    const radio = Math.round(0.04 * sr);
    const iA = this._cruceroCercano(datos, Math.round(inicio * sr), radio);
    const fA = this._cruceroCercano(datos, Math.round(fin * sr),   radio);
    if (iA !== null) inicio = iA / sr;
    if (fA !== null) fin    = fA / sr;
    if (fin - inicio < 0.25) {
      inicio = (base + mejorI * sal) / sr;
      fin    = Math.min(tope, base + mejorJ * sal + ven) / sr;
    }
    if (inicio < base / sr) inicio = base / sr;

    let ct = 0;
    for (let w = mejorI; w <= mejorJ; w++) ct += tonales[w];
    const tramo = this._finalizarTramo(datos, sr, dur, inicio, fin);
    return { inicio: tramo.inicio, fin: tramo.fin, zcrRef: +zcrRef.toFixed(4), tonalPct: Math.round(100 * ct / (mejorJ - mejorI + 1)) };
  }

  _finalizarTramo(datos, sr, dur, inicio, fin) {
    const ini = this._refinarInicioLoop(datos, sr, inicio, fin);
    const finTope = dur - LOOP_MARGEN_FIN;
    let f = fin > finTope ? Math.max(finTope, Math.min(ini + 0.25, dur)) : fin;
    return { inicio: ini, fin: f };
  }

  /**
   * Refina el inicio del loop sin asignar arrays: dos pasadas streaming.
   * Pasada 1 → rmsMax global. Pasada 2 → primer frame audible desde `inicio`.
   */
  _refinarInicioLoop(datos, sr, inicio, fin) {
    const n      = datos.length;
    const frame  = Math.max(64, Math.round(LOOP_REF_FRAME * sr));
    const salto  = Math.max(32, Math.round(frame / 2));
    const desde  = this._acotar(Math.round(inicio * sr), 0, Math.max(0, n - 1));

    // Pasada 1: rmsMax
    let rmsMax = 0;
    for (let i = 0; i < n; i += salto) {
      const f2 = Math.min(n, i + frame);
      let s = 0;
      for (let j = i; j < f2; j++) s += datos[j] * datos[j];
      const r = Math.sqrt(s / Math.max(1, f2 - i));
      if (r > rmsMax) rmsMax = r;
    }
    if (rmsMax < 1e-4) return inicio;

    // Pasada 2: primer frame audible (confirmado con el siguiente)
    const umbral = rmsMax * LOOP_REF_RMS_PCT;
    const fDesde = Math.floor(desde / salto);
    let audible = -1, rPrev = -1;
    for (let i = fDesde * salto; i < n; i += salto) {
      const f2 = Math.min(n, i + frame);
      let s = 0;
      for (let j = i; j < f2; j++) s += datos[j] * datos[j];
      const r = Math.sqrt(s / Math.max(1, f2 - i));
      if (r >= umbral && rPrev >= umbral) { audible = i - salto; break; }
      rPrev = r;
    }
    if (audible < 0) return inicio;
    const refinado = Math.max(0, audible / sr - LOOP_REF_MARGEN);
    return (refinado <= inicio || fin - refinado < 0.5) ? inicio : refinado;
  }

  /** Cruce por cero más cercano a `centro` dentro de ±radio muestras. */
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

  // ── Capas continuas ──────────────────────────────────────────

  _actualizarEstadosDeModo(punto, puntoAnterior) {
    const viento = this._numero(punto.viento_kt, 0);
    const flags  = { hayAnterior: !!puntoAnterior, entroTierra: false, salioTierra: false };
    if (!puntoAnterior) {
      this._estado.sobreTierra     = !!punto.tocatierra;
      this._estado.vientoTocatierra = punto.tocatierra ? viento : null;
      return flags;
    }
    flags.entroTierra = !puntoAnterior.tocatierra && !!punto.tocatierra;
    if (flags.entroTierra) {
      this._estado.sobreTierra = true;
      this._estado.vientoTocatierra = viento;
    } else if (this._estado.sobreTierra && this._estado.vientoTocatierra !== null &&
               viento >= this._estado.vientoTocatierra + 10) {
      this._estado.sobreTierra = false;
      flags.salioTierra = true;
    }
    return flags;
  }

  /** DRON: presión → f (30·2^(u·2.2)) y cutoff (280−u·200), τ = 0,15 s. */
  _actualizarDron(punto, ahora) {
    const u      = this._acotar((1010 - this._numero(punto.presion_mb, 1010)) / 60, 0, 1);
    const fBase  = 30 * Math.pow(2, u * 2.2);
    this._estado.u = u; this._estado.fBase = this._estado.fDron = fBase;
    this._estado.ultimoPunto = punto;
    const { oscPrincipal, oscSub, dronFiltro } = this._nodos;
    oscPrincipal.frequency.setTargetAtTime(fBase,     ahora, 0.15);
    oscSub.frequency.setTargetAtTime(fBase / 2,       ahora, 0.15);
    dronFiltro.frequency.setTargetAtTime(280 - u*200, ahora, 0.15);
  }

  /** VIENTO: crossfade normal↔terrorífico según cat_ss; modula ±20% con viento_kt. */
  _actualizarViento(punto, ahora) {
    const viento  = this._numero(punto.viento_kt, 0);
    const cat     = this._acotar(Math.round(this._numero(punto.cat_ss, 0)), 0, 5);
    const terror  = cat >= 4;
    const loop    = terror ? 'terrorifico' : 'normal';
    const factor  = 1 + (this._acotar((viento - 30) / 130, 0, 1) - 0.5) * (VIENTO_MODULACION * 2);
    const g       = VIENTO_GANANCIA_CAT[cat] * factor;
    const dur     = (this._estado.vientoLoop !== null && this._estado.vientoLoop !== loop) ? VIENTO_CROSSFADE : 0.2;
    const { vientoNormalGain, vientoTerrorGain, vientoFiltro } = this._nodos;
    this._rampaLineal(vientoNormalGain.gain, terror ? 0 : g, ahora, dur);
    this._rampaLineal(vientoTerrorGain.gain, terror ? g : 0, ahora, dur);
    vientoFiltro.frequency.setTargetAtTime(this._estado.sobreTierra ? VIENTO_CUTOFF_TIERRA : VIENTO_CUTOFF_MAR, ahora, 0.2);
    this._estado.viento = viento; this._estado.cat = cat;
    this._estado.vientoLoop = loop; this._estado.gananciaViento = g;
  }

  // ── One-shots ────────────────────────────────────────────────

  _dispararTocatierra(ahora) {
    this._dispararMuestra(this._buffers.tocatierra, { cuando: ahora, ganancia: TOCATIERRA_GANANCIA });
  }

  /** MUERTES: N = min(6, 1+⌊Δ/25⌋) pulsos repartidos en la ventana. */
  _dispararMuertes(punto, prev, ahora, ventana) {
    const delta = this._numero(punto.muertes_acum, 0) - this._numero(prev.muertes_acum, 0);
    if (delta <= 0) return;
    const n    = Math.min(6, 1 + Math.floor(delta / 25));
    const rate = Math.max(0.6, 1.05 - delta / 400);
    for (let i = 0; i < n; i++)
      this._dispararMuestra(this._buffers.pulso, { cuando: ahora + ((i + 0.5) / n) * ventana, ganancia: 0.8, playbackRate: rate });
  }

  /** DAÑOS: N = min(12, 1+⌊Δ/5e9⌋) ráfagas con jitter y ganancia ∝ log10(Δ). */
  _dispararDanos(punto, prev, ahora, ventana) {
    const delta = this._numero(punto.danos_acum_usd, 0) - this._numero(prev.danos_acum_usd, 0);
    if (delta <= 0) return;
    const n = Math.min(12, 1 + Math.floor(delta / 5e9));
    const g = this._gananciaLog(delta);
    for (let i = 0; i < n; i++)
      this._dispararMuestra(this._buffers.rafaga, { cuando: ahora + Math.random() * ventana, ganancia: g, playbackRate: 0.9 + Math.random() * 0.25 });
  }

  /** bufferSource → gain → masterGain, con limpieza al terminar. */
  _dispararMuestra(buffer, { cuando, ganancia, playbackRate }) {
    if (!buffer) return;
    const fuente = this.ctx.createBufferSource();
    fuente.buffer = buffer;
    if (playbackRate) fuente.playbackRate.value = playbackRate;
    const g = this.ctx.createGain(); g.gain.value = ganancia;
    fuente.connect(g); g.connect(this.masterGain);
    fuente.onended = () => { try { fuente.disconnect(); g.disconnect(); } catch (_) {} };
    fuente.start(Math.max(cuando, this.ctx.currentTime));
  }

  // ── Control global y utilidades ──────────────────────────────

  _ventanaEvento(ahora) {
    return this._instanteUltimoPunto === null ? 0.6
      : this._acotar(ahora - this._instanteUltimoPunto, 0.15, 1.2);
  }

  _gananciaLog(delta) {
    const base = 0.18 + 0.18 * Math.log10(delta / 1e9 + 1);
    return this._acotar(base * RAFAGA_BALANCE, 0.15 * RAFAGA_BALANCE, 0.7 * RAFAGA_BALANCE);
  }

  _aplicarMaster(tau) {
    if (!this.masterGain || !this.ctx) return;
    this.masterGain.gain.setTargetAtTime(
      (this._mudo || !this._reproduciendo) ? 0 : this._volumen,
      this.ctx.currentTime, tau
    );
  }

  _reaplicarParametros() {
    const p = this._estado.ultimoPunto;
    if (!p || !this._nodos) return;
    const t = this.ctx.currentTime;
    this._actualizarDron(p, t); this._actualizarViento(p, t);
  }

  _debug() {
    const nd = this._nodos;
    const lp = this._estado.vientoLoop;
    const gK = lp === 'terrorifico' ? 'vientoTerrorGain' : 'vientoNormalGain';
    const ls = k => this._loopInfo[k] ? [+this._loopInfo[k].inicio.toFixed(2), +this._loopInfo[k].fin.toFixed(2)] : null;
    return {
      iniciado: this.iniciado, fDron: this._estado.fDron,
      cutoffDron: nd?.dronFiltro.frequency.value ?? null,
      vientoLoop: lp, gananciaViento: nd?.[gK].gain.value ?? null,
      cutoffVientoFiltro: nd?.vientoFiltro.frequency.value ?? null,
      cutoffVientoTerror: nd?.filtroVientoTerror.frequency.value ?? null,
      rateVientoTerror:   nd?.fuenteVientoTerror.playbackRate.value ?? null,
      loopSegNormal: ls('normal'), loopSegTerror: ls('terrorifico'),
      loopTonalNormal: this._loopInfo.normal?.tonalPct ?? null,
      loopTonalTerror: this._loopInfo.terrorifico?.tonalPct ?? null,
      gananciaVientoNormal: nd?.vientoNormalGain.gain.value ?? null,
      gananciaVientoTerror: nd?.vientoTerrorGain.gain.value ?? null,
      sobreTierra: this._estado.sobreTierra,
      masterGain: this.masterGain?.gain.value ?? null,
      volumen: this._volumen, mudo: this._mudo, reproduciendo: this._reproduciendo,
    };
  }

  /** Rampa lineal robusta: cancelAndHold si existe, si no cancel+setValueAtTime. */
  _rampaLineal(param, valor, ahora, dur) {
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(ahora);
    else { param.cancelScheduledValues(ahora); param.setValueAtTime(param.value, ahora); }
    param.linearRampToValueAtTime(valor, ahora + dur);
  }

  _numero(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
  _acotar(v, min, max) { return v < min ? min : v > max ? max : v; }
}

window.MotorAudio = MotorAudio;
