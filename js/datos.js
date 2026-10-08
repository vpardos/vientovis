'use strict';
/* datos.js — acceso a los datos y utilidades de formato (objeto global `Datos`).
 * Todos los accesos a puntos son por MARCA DE TIEMPO (Date), nunca por índice
 * de cadencia: `p.d` es la versión Date de `p.t` (ISO-UTC). */

const Datos = {

  /* Paleta de categoría Saffir–Simpson (semáforo verde→rojo), fija.
   * Los 6 pasos difieren en luminosidad/saturación además del matiz para
   * seguir siendo distinguibles en deuteranopia. Índice = cat_ss 0–5. */
  CAT_COLORES: ['#29c47f', '#8fc72f', '#d8c21c', '#f0952e', '#ef5f2d', '#e63946'],

  MESES: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],

  ESTATUS_TEXTO: {
    TD: 'Depresión tropical',
    TS: 'Tormenta tropical',
    HU: 'Huracán',
    EX: 'Postropical'
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

  /* Versión corta para ejes y deltas: "$125 mil M" / "$350 M". */
  fmtUSDCorto(v) {
    const n = +v || 0;
    if (Math.abs(n) >= 1e9) {
      return '$' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(n / 1e9) + ' mil M';
    }
    return '$' + this.fmtEntero(n / 1e6) + ' M';
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
  fmtCatCorto(cat) {
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