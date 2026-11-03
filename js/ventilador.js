'use strict';
/* ventilador.js — sincronización de un ventilador físico con el viento del
 * punto activo, por Web Serial (objeto global `Ventilador`).
 *
 * Protocolo: el Arduino recibe líneas «F<0-100>\n» a 9600 bauds (sketch
 * codigoarduino.txt); el servo «S<0-180>\n» existe pero aquí NO se toca.
 *
 * DISEÑO DE LA CURVA: el duty no es lineal en el viento. Un ventilador de 12 V
 * no arranca bajo ~30 % de duty (se queda parado y zumba), y con una recta
 * 0 kt → 0 % / 155 kt → 100 % casi toda la tormenta caería en el rango muerto.
 * La curva está anclada en los umbrales Saffir–Simpson —así el ventilador sube
 * por escalones reconocibles de la escala— y arranca en DUTY_MIN en cuanto hay
 * sistema tropical, para que una depresión también produzca aire visible.
 * Es una tabla editable: si tu ventilador arranca a otro duty, cambia DUTY_MIN.
 *
 * El envío va SMOOTHED y THROTTLED: nunca se escriben más de ~22 líneas por
 * segundo ni se repite un valor ya enviado, así el Arduino (que lee de a una
 * línea por loop) no se atrasa y el ventilador acelera con inercia real. */

const Ventilador = {

  BAUDIOS: 9600,

  /* Duty mínimo con viento > 0: por debajo el ventilador no gira. */
  DUTY_MIN: 28,

  /* Curva viento (kt) → duty (0-100). Umbrales Saffir–Simpson: TD, TS, y
   * Cat 1-5 en 64 / 83 / 96 / 113 / 137 kt. Sobre el umbral de Cat 5 la curva
   * sigue subiendo hasta 155 kt (el pico de la serie, Irma) para que Cat 4 y
   * Cat 5 no se aplasten contra el 100 %: solo el techo real lo alcanza. */
  CURVA: [
    [0, 0],
    [15, 28],   // mínimo de la serie (TD en formación): ya por encima del arranque
    [34, 38],   // tormenta tropical
    [64, 52],   // huracán Cat 1
    [83, 65],   // Cat 2
    [96, 76],   // Cat 3
    [113, 84],  // Cat 4
    [137, 93],  // Cat 5 (umbral)
    [155, 100]  // pico de la serie (Irma 2017): saturación
  ],

  /* rampa: unidades de duty por tick de 40 ms (≈ 62 %/s: barrido completo en
   * 1,6 s, la inercia de un ventilador real) */
  PASO_MAX: 2.5,
  TICK_MS: 40,
  /* separación mínima entre escrituras al puerto (el sketch lee una línea por
   * iteración de loop; más rápido que esto solo llena el buffer) */
  MS_ENTRE_ENVIOS: 45,

  soportado: typeof navigator !== 'undefined' && !!(navigator && navigator.serial),

  puerto: null,
  conectado: false,

  _escritor: null,
  _codificador: new TextEncoder(),
  _objetivo: 0,   // duty que pide la app (viento del punto activo)
  _actual: 0,     // duty que se está enviando (rampa)
  _enviado: null, // último valor escrito en el puerto
  _temporizador: null,
  _escribiendo: false,
  _ultimoEnvio: 0,
  _boton: null,
  _oyentes: false,

  /* ===================== mapeo viento → duty ===================== */

  /* Piecewise-lineal sobre CURVA, con saturación en los extremos. */
  dutyViento(kt) {
    const v = +kt;
    if (!Number.isFinite(v) || v <= 0) return 0;
    const c = this.CURVA;
    for (let i = 1; i < c.length; i++) {
      if (v <= c[i][0]) {
        const x0 = c[i - 1][0], y0 = c[i - 1][1];
        const x1 = c[i][0], y1 = c[i][1];
        const t = x1 === x0 ? 1 : (v - x0) / (x1 - x0);
        return Math.round(y0 + (y1 - y0) * Math.max(0, Math.min(1, t)));
      }
    }
    return c[c.length - 1][1];
  },

  /* ===================== API que usa app.js ===================== */

  /* El botón se re-crea en cada montaje de la vista tormenta: se re-apunta
   * siempre (y se repinta el estado real, que vive en el módulo). */
  enlazarBoton(btn) {
    this._boton = btn || null;
    this._pintarEstado();
  },

  /* Fija el objetivo a partir del viento del punto activo, en nudos. */
  seguir(kt) {
    this._objetivo = this.dutyViento(kt);
    if (this.conectado && !this._temporizador) this._arrancarBucle();
  },

  /* Vista desmontada o sin tormenta: el ventilador se detiene (la conexión
   * sigue abierta para cuando vuelva la vista). */
  reposo() {
    this._objetivo = 0;
  },

  /* Clic del botón: conectar ↔ desconectar. */
  async alternar() {
    if (this.conectado) return this.desconectar();
    return this.conectar();
  },

  /* ===================== conexión ===================== */

  async conectar() {
    if (this.conectado) return true;
    if (!this.soportado) {
      this._error('Este navegador no tiene Web Serial (requiere Chrome o Edge de escritorio sobre https).');
      return false;
    }
    const btn = this._boton;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Conectando…';
      btn.title = 'Elige el puerto del Arduino en el diálogo del navegador.';
    }
    try {
      this.puerto = await navigator.serial.requestPort();
      await this.puerto.open({ baudRate: this.BAUDIOS });
      this._escritor = this.puerto.writable.getWriter();
      this.conectado = true;
      this._escribiendo = false;
      this._enviado = null;
      this._ultimoEnvio = 0;
      this._actual = 0;                    // arranca en frío y sube por la rampa
      this._oyentesDesconexion();
      this._arrancarBucle();
      this._pintarEstado();
      return true;
    } catch (err) {
      /* cancelar el diálogo (AbortError/NotFoundError) no es un fallo de la
       * página: solo se restaura el botón. El resto sí se informa. */
      const cancelado = err && (err.name === 'AbortError' || err.name === 'NotFoundError');
      this.puerto = null;
      this.conectado = false;
      this._escritor = null;
      if (cancelado) this._pintarEstado();
      else this._error('No se pudo abrir el puerto: ' + (err && err.message ? err.message : err));
      return false;
    } finally {
      if (this._boton) this._boton.disabled = false;
    }
  },

  async desconectar() {
    this._detenerBucle();
    const puerto = this.puerto;
    const escritor = this._escritor;
    this.conectado = false;
    this._escritor = null;
    this.puerto = null;
    this._enviado = null;
    this._objetivo = 0;
    this._actual = 0;
    /* estado seguro ANTES de soltar: el ventilador no debe quedarse girando
     * si se cierra la página o se desconecta el cable */
    if (escritor) {
      try { await escritor.write(this._codificador.encode('F0\n')); } catch (err) { /* puerto ya ido */ }
      try { escritor.releaseLock(); } catch (err) { /* noop */ }
    }
    if (puerto) { try { await puerto.close(); } catch (err) { /* noop */ } }
    this._pintarEstado();
  },

  /* El navegador avisa cuando el USB se va: sin esto el botón seguiría
   * diciendo «conectado» y las escrituras fallarían en silencio. */
  _oyentesDesconexion() {
    if (this._oyentes || !this.soportado) return;
    this._oyentes = true;
    navigator.serial.addEventListener('disconnect', ev => {
      if (ev.target !== this.puerto) return;
      this._error('El ventilador se desconectó del puerto USB.');
    });
  },

  /* ===================== bucle de envío ===================== */

  _arrancarBucle() {
    if (this._temporizador) return;
    this._temporizador = setInterval(() => this._tick(), this.TICK_MS);
  },

  _detenerBucle() {
    if (this._temporizador) { clearInterval(this._temporizador); this._temporizador = null; }
  },

  _tick() {
    if (!this.conectado) { this._detenerBucle(); return; }
    const dif = this._objetivo - this._actual;
    if (Math.abs(dif) <= this.PASO_MAX) this._actual = this._objetivo;
    else this._actual += Math.sign(dif) * this.PASO_MAX;

    const v = Math.round(this._actual);
    if (v === this._enviado) return;
    const ahora = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (ahora - this._ultimoEnvio < this.MS_ENTRE_ENVIOS) return;
    this._enviar(v, ahora);
  },

  _enviar(v, ahora) {
    if (!this._escritor || this._escribiendo) return;
    this._escribiendo = true;
    this._enviado = v;
    this._ultimoEnvio = ahora;
    this._escritor.write(this._codificador.encode('F' + v + '\n'))
      .then(() => { this._escribiendo = false; this._pintarEstado(); })
      .catch(err => {
        this._escribiendo = false;
        this._error('Se perdió la escritura al puerto: ' + (err && err.message ? err.message : err));
      });
  },

  /* ===================== interfaz ===================== */

  /* El botón es el único testigo del estado: sin elementos extra que alteren
   * la barra del reproductor. */
  _pintarEstado() {
    const btn = this._boton;
    if (!btn) return;
    btn.classList.toggle('conectado', this.conectado);
    btn.setAttribute('aria-pressed', String(this.conectado));
    if (this.conectado) {
      btn.textContent = 'Ventilador · ' + Math.round(this._actual) + ' %';
      btn.title = 'Conectado por USB. Sigue el viento del punto activo. Clic para desconectar.';
    } else {
      btn.textContent = 'Conectar a Ventilador';
      btn.title = 'Sincroniza el viento del punto activo con un ventilador por USB (Web Serial).';
    }
  },

  /* Un fallo siempre deja el botón en un estado coherente con el puerto real:
   * si había conexión se cierra primero (estado seguro del ventilador) y el
   * botón queda como reintento, con el motivo en el title. */
  _error(mensaje) {
    console.warn('[vientovis] ventilador:', mensaje);
    if (this.conectado) {
      this.desconectar().then(() => {
        if (!this._boton) return;
        this._boton.disabled = false;
        this._boton.textContent = 'Reintentar Ventilador';
        this._boton.title = mensaje;
      }).catch(() => { /* noop */ });
      return;
    }
    const btn = this._boton;
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = 'Reintentar Ventilador';
    btn.title = mensaje;
  }
};

window.Ventilador = Ventilador;
