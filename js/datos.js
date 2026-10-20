'use strict';
/* datos.js — acceso a los datos y utilidades de formato (objeto global `Datos`).
 * Todos los accesos a puntos son por MARCA DE TIEMPO (Date), nunca por índice
 * de cadencia: `p.d` es la versión Date de `p.t` (ISO-UTC). */

const Datos = {

  /* Paleta de categoría Saffir–Simpson (V2: rampa de ROJOS) — fija.
   * Monótona en oscuridad: cat más alta = más grave = más oscura. Los 6 pasos
   * se distinguen por LUMINOSIDAD (además del matiz dentro del rojo), así
   * siguen separándose en deuteranopia. Índice = cat_ss 0–5. */
  CAT_COLORES: ['#f2a08f', '#e47762', '#d0503f', '#b33326', '#8f221c', '#6b1414'],

  MESES: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],

  ESTATUS_TEXTO: {
    TD: 'Depresión tropical',
    TS: 'Tormenta tropical',
    HU: 'Huracán',
    EX: 'Postropical',
    /* Códigos de HURDAT2 que NO son ciclones tropicales ni extratropicales:
     * se nombran para que la línea de tiempo no muestre siglas sueltas. */
    WV: 'Onda tropical',
    LO: 'Baja presión',
    DB: 'Disturbio'
  },

  indice: null,
  cargadas: [],
  _cachePromesas: new Map(),

  /* =================== carga =================== */

  async cargar() {
    if (this.indice) return this.indice;
    const resp = await fetch('data/indice.json');
    if (!resp.ok) throw new Error('No se pudo cargar data/indice.json (HTTP ' + resp.status + ')');
    const cuerpo = await resp.json();
    this.indice = (cuerpo.tormentas || []).slice();
    return this.indice;
  },

  porId(id) {
    return this.indice ? (this.indice.find(t => t.id === id) || null) : null;
  },

  ordenPorMuertes() {
    return (this.indice || []).slice().sort((a, b) => b.muertes_total - a.muertes_total);
  },

  /* Frase editorial «potencia ≠ destructividad» (V2): la tormenta con
   * cat_pico < 5 que supera en muertes al MAYOR número de huracanes de
   * Cat 5. Se computa del índice cargado (nunca a mano) y devuelve null si
   * ninguna Cat < 5 supera a ninguna Cat 5 (la app muestra entonces una
   * frase genérica sin cifras). */
  frasePotenciaImpacto() {
    const todas = this.indice || [];
    const cat5 = todas.filter(t => (t.cat_pico | 0) === 5);
    let mejor = null;
    let mejorN = 0;
    todas.forEach(t => {
      if ((t.cat_pico | 0) >= 5) return;
      const n = cat5.filter(m => (+m.muertes_total || 0) < (+t.muertes_total || 0)).length;
      if (n < mejorN) return; // solo interesa el máximo
      if (n === mejorN && mejor && (+t.muertes_total || 0) <= (+mejor.muertes_total || 0)) return; // empate: gana más muertes
      mejor = t;
      mejorN = n;
    });
    if (!mejor || mejorN <= 0) return null;
    return 'La potencia no predice el impacto: ' + mejor.nombre + ' (Cat ' + (mejor.cat_pico | 0) +
      ') superó en muertes a ' + mejorN + ' ' + (mejorN === 1 ? 'huracán' : 'huracanes') + ' de Cat 5.';
  },

  /* Carga (con caché) de una tormenta individual. */
  async tormenta(id) {
    const ya = this._cachePromesas.get(id);
    if (ya) return ya;
    const promesa = (async () => {
      const resp = await fetch('data/tormentas/' + encodeURIComponent(id) + '.json');
      if (!resp.ok) throw new Error('No se pudo cargar la tormenta «' + id + '» (HTTP ' + resp.status + ')');
      const cuerpo = await resp.json();
      (cuerpo.puntos || []).forEach(p => {
        if (typeof p.t === 'string' && !(p.d instanceof Date)) p.d = new Date(p.t);
      });
      this.cargadas.push(cuerpo);
      return cuerpo;
    })();
    this._cachePromesas.set(id, promesa);
    return promesa;
  },

  /* ¿Algún dato cargado (índice o archivos de tormenta) es mock? */
  hayMock() {
    return (this.indice || []).some(t => t.mock) || this.cargadas.some(t => t.mock);
  },

  /* =================== derivados =================== */

  masCercano(puntos, fecha) {
    if (!puntos || !puntos.length) return -1;
    const busca = d3.bisector(p => +p.d);
    let i = busca.center(puntos, +fecha);
    if (i < 0) i = 0;
    if (i > puntos.length - 1) i = puntos.length - 1;
    return i;
  },

  /* Contigüidad de puntos con ir:true → tramos [{tIni, tFin}]. */
  tramosIR(puntos) {
    const tramos = [];
    let ini = -1;
    for (let i = 0; i < puntos.length; i++) {
      if (puntos[i].ir && ini < 0) ini = i;
      if ((!puntos[i].ir || i === puntos.length - 1) && ini >= 0) {
        const fin = puntos[i].ir ? i : i - 1;
        tramos.push({ tIni: puntos[ini].d, tFin: puntos[fin].d });
        ini = -1;
      }
    }
    return tramos;
  },

  puntosTocatierra(puntos) {
    return (puntos || []).filter(p => p.tocatierra);
  },

  primerTocatierra(puntos) {
    return (puntos || []).find(p => p.tocatierra) || null;
  },

  /* Punto de máxima intensidad (más cat, a igual cat más viento). */
  pico(puntos) {
    return (puntos || []).reduce((mejor, p) => {
      if (!mejor) return p;
      return (p.cat_ss > mejor.cat_ss || (p.cat_ss === mejor.cat_ss && p.viento_kt > mejor.viento_kt)) ? p : mejor;
    }, null);
  },

  /* =================== formato =================== */

  colorCat(cat) {
    return this.CAT_COLORES[Math.max(0, Math.min(5, cat | 0))];
  },

  /* Escapa texto crudo para interpolación segura en HTML/atributos
   * (una sola implementación: la usan app.js y mapa.js). */
  escapar(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  fmtEntero(n) {
    return Math.round(+n || 0).toLocaleString('es-ES');
  },

  fmtDecimal(n, dec) {
    return (+n || 0).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  },

  fmtPorcentaje(part, total) {
    if (!total) return '0 %';
    return ((part / total) * 100).toLocaleString('es-ES', { maximumFractionDigits: 0 }) + ' %';
  },

  /* USD: "≥ 1e9 → $125 mil M USD · millones → $350 M USD · < 1e6 → $350.000 USD" */
  fmtUSD(v) {
    const n = +v || 0;
    if (Math.abs(n) >= 1e9) {
      return '$' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(n / 1e9) + ' mil M USD';
    }
    if (Math.abs(n) >= 1e6) {
      return '$' + this.fmtEntero(n / 1e6) + ' M USD';
    }
    return '$' + this.fmtEntero(n) + ' USD';
  },

  /* Versión corta para ejes y deltas: "$125 mil M" / "$350 M" / "$350.000".
   * < $1 M va como entero: decir «$0 M» para importes pequeños es falso. */
  fmtUSDCorto(v) {
    const n = +v || 0;
    if (Math.abs(n) >= 1e9) {
      return '$' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(n / 1e9) + ' mil M';
    }
    if (Math.abs(n) >= 1e6) {
      return '$' + this.fmtEntero(n / 1e6) + ' M';
    }
    return '$' + this.fmtEntero(n);
  },

  fmtDeltaEntero(d) {
    if (!(+d)) return '0';
    return (+d > 0 ? '+' : '−') + this.fmtEntero(Math.abs(d));
  },

  fmtDeltaUSD(d) {
    if (!(+d)) return '0';
    return (+d > 0 ? '+' : '−') + this.fmtUSDCorto(Math.abs(d));
  },

  /* Cat 0 del mock cubre TD/TS: chip neutro propio. */
  fmtCatCorto(cat, estatus) {
    /* Un sistema que ya no es ciclón tropical (onda, baja presión, disturbio) no
     * tiene categoría Saffir–Simpson: su cat_ss es 0 por construcción, y rotularlo
     * «T. tropical» contradice al estado que se muestra justo al lado. */
    if (estatus === 'WV' || estatus === 'LO' || estatus === 'DB') return 'No tropical';
    return (cat | 0) >= 1 ? 'Cat ' + (cat | 0) : 'T. tropical';
  },

  fmtEstatus(e) {
    return this.ESTATUS_TEXTO[e] || e;
  },

  fmtDia(d) {
    return d.getUTCDate() + ' ' + this.MESES[d.getUTCMonth()];
  },

  fmtDiaMesAnio(d) {
    return this.fmtDia(d) + ' ' + d.getUTCFullYear();
  },

  /* Reloj textual del reproductor: "29 ago 2005 · 12:00 UTC". */
  fmtReloj(d) {
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return this.fmtDiaMesAnio(d) + ' · ' + hh + ':' + mm + ' UTC';
  },

  /* Rango temporal de una tormenta: "23 – 31 ago 2005 · UTC" o "22 oct – 1 nov 2012 · UTC". */
  fmtRango(puntos) {
    if (!puntos || !puntos.length) return '';
    const a = puntos[0].d, b = puntos[puntos.length - 1].d;
    const mismoMes = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
    const rango = mismoMes
      ? a.getUTCDate() + ' – ' + b.getUTCDate() + ' ' + this.MESES[b.getUTCMonth()] + ' ' + b.getUTCFullYear()
      : this.fmtDia(a) + ' ' + a.getUTCFullYear() + ' – ' + this.fmtDia(b) + ' ' + b.getUTCFullYear();
    return rango + ' · UTC';
  },

  /* Horas relativas, con signo U+2212 para negativos. */
  fmtHoraRelativa(h) {
    const n = Math.round(+h || 0);
    if (n === 0) return '0';
    return (n > 0 ? '+' : '−') + this.fmtEntero(Math.abs(n)) + ' h';
  },

  fmtLatLon(lat, lon) {
    const la = this.fmtDecimal(lat, 1) + '° ' + (lat >= 0 ? 'N' : 'S');
    const lo = this.fmtDecimal(Math.abs(lon), 1) + '° ' + (lon >= 0 ? 'E' : 'O');
    return la + ', ' + lo;
  }
};

window.Datos = Datos;