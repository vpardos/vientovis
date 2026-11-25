'use strict';
/* ayuda.js — global `Ayuda` (V4): pop-ups de ayuda que aparecen al abrir la
 * página y señalan lo que se puede pulsar: las fichas de los huracanes, el
 * botón Reproducir y el botón Activar sonido.
 *
 * - Se muestran una vez por carga de página (App los llama tras el primer
 *   montaje de la portada).
 * - Cada burbuja se cierra con su ✕, al pulsar el elemento que señala o con
 *   Escape (cierra todas).
 * - Posición fija calculada desde el elemento en cada frame mientras quede
 *   alguna abierta: siguen al elemento con scroll, resize y re-montajes (el
 *   botón Reproducir se re-crea al cambiar de huracán, por eso se busca por
 *   selector y no se guarda la referencia).
 * - Si el elemento no está visible (p. ej. Activar sonido ya activado y
 *   oculto), su burbuja se esconde.
 * - En pantallas angostas (< 700 px) se muestran de a una, en orden. */

const Ayuda = {

  PASOS: [
    {
      clave: 'selec',
      objetivo: '#selec-lista',
      cerrarCon: '.selec-tarjeta',
      html: '<b>Haz clic en cada huracán</b> para ver su trayectoria, sus muertes y sus daños.'
    },
    {
      clave: 'play',
      objetivo: '#btn-play',
      cerrarCon: '#btn-play',
      html: '<b>Pulsa Reproducir</b> para ver avanzar la tormenta.'
    },
    {
      clave: 'audio',
      objetivo: '#btn-audio',
      cerrarCon: '#btn-audio',
      html: '<b>Activa el sonido</b> para escuchar el huracán a partir de sus datos.'
    }
  ],

  _abiertas: [],   // [{ paso, el }]
  _raf: null,
  _alClic: null,
  _alTecla: null,

  mostrar() {
    if (this._abiertas.length) return;
    this.PASOS.forEach((paso, i) => {
      const el = document.createElement('div');
      el.className = 'ayuda-burbuja ayuda-' + paso.clave;
      el.setAttribute('role', 'note');
      el.style.animationDelay = (i * 0.15) + 's, ' + (0.35 + i * 0.15) + 's';
      el.innerHTML = paso.html +
        '<button type="button" class="ayuda-cerrar" aria-label="Cerrar ayuda" title="Cerrar">✕</button>';
      el.querySelector('.ayuda-cerrar').addEventListener('click', () => this._cerrar(paso.clave));
      document.body.appendChild(el);
      this._abiertas.push({ paso: paso, el: el });
    });

    /* pulsar lo señalado cierra su burbuja (captura: corre aunque el botón
     * re-renderice o detenga la propagación) */
    this._alClic = ev => {
      const t = ev.target;
      if (!t || !t.closest) return;
      this._abiertas.slice().forEach(a => {
        if (t.closest(a.paso.cerrarCon)) this._cerrar(a.paso.clave);
      });
    };
    this._alTecla = ev => { if (ev.key === 'Escape') this.cerrarTodas(); };
    document.addEventListener('click', this._alClic, true);
    document.addEventListener('keydown', this._alTecla);

    const bucle = () => {
      this._ubicar();
      this._raf = this._abiertas.length ? requestAnimationFrame(bucle) : null;
    };
    this._ubicar(); // primera ubicación inmediata: ningún frame en (0, 0)
    this._raf = requestAnimationFrame(bucle);
  },

  cerrarTodas() {
    this._abiertas.slice().forEach(a => this._cerrar(a.paso.clave));
  },

  _cerrar(clave) {
    const i = this._abiertas.findIndex(a => a.paso.clave === clave);
    if (i < 0) return;
    this._abiertas[i].el.remove();
    this._abiertas.splice(i, 1);
    if (!this._abiertas.length) {
      document.removeEventListener('click', this._alClic, true);
      document.removeEventListener('keydown', this._alTecla);
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  },

  /* Debajo del elemento, centrada y acotada al ancho de la ventana; si no cabe
   * abajo, va arriba. La flecha apunta al centro del elemento. */
  _ubicar() {
    const anchoV = document.documentElement.clientWidth || window.innerWidth;
    const altoV = window.innerHeight;
    const margen = 8;
    const sep = 14;
    /* pantallas angostas: el reproductor se apila y las burbujas se taparían
     * entre sí y a los botones, así que se muestran de a una, en orden */
    const deAUna = anchoV < 700;
    let yaHayUna = false;
    this._abiertas.forEach(a => {
      const obj = document.querySelector(a.paso.objetivo);
      let visible = obj && obj.offsetParent !== null && !obj.classList.contains('oculto');
      if (visible && deAUna) {
        if (yaHayUna) visible = false;
        yaHayUna = true;
      }
      a.el.style.visibility = visible ? '' : 'hidden';
      if (!visible) return;
      const r = obj.getBoundingClientRect();
      const bw = a.el.offsetWidth;
      const bh = a.el.offsetHeight;
      const centro = r.left + r.width / 2;
      const izq = Math.max(margen, Math.min(anchoV - bw - margen, centro - bw / 2));
      const abajo = r.bottom + sep + bh <= altoV || r.top - sep - bh < 0;
      a.el.style.left = Math.round(izq) + 'px';
      a.el.style.top = Math.round(abajo ? r.bottom + sep : r.top - sep - bh) + 'px';
      a.el.classList.toggle('abajo', abajo);
      a.el.classList.toggle('arriba', !abajo);
      const flecha = Math.max(16, Math.min(bw - 16, centro - izq));
      a.el.style.setProperty('--flecha-x', Math.round(flecha) + 'px');
    });
  }
};
