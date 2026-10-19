'use strict';
/* paneles.js — global `Paneles`.
 *  - crearPanelTormenta() → los 3 paneles apilados (viento/presión, muertes,
 *    daños) con eje temporal compartido y crosshair sincronizado.
 *
 * Muertes y daños van desde 0 (sin truncar); la única escala no directa es la
 * del eje derecho de presión (invertido, práctica meteorológica), declarada en
 * la leyenda del panel 1. Infrarrojos (IR) y tocatierras se repiten en los 3
 * paneles para leer la alineación temporal sin interacción; bajo el eje X del
 * panel INFERIOR (daños) van los timestamps de los tocatierras que tienen
 * nota emparejada en data/notas-tocatierras.json. */

const Paneles = {

  /* Tinta (el trazo de viento) en claro sobre el panel nocturno.
   * El carmesí de muertes es más rosado que la rampa de rojos de categoría
   * (V2): el matiz los aparta en la misma vista (panel vs. mapa/chips). */
  TINTA: '#edf2fa',
  GRIS: '#a3b4d6',
  CARMESI: '#ea4f7e',   // muertes (canal propio; nunca paleta de categoría)
  AMBAR: '#e8a845',     // daños (canal propio; nunca paleta de categoría)
  LINEA_EJE: '#3d4f76',

  /* renglón extra bajo el eje X del panel inferior (etiquetas de tocatierra) */
  ALTO_ETQ_TOCA: 54,
  /* ancho medio de un glifo mono a 11.5 px (0,6 em) — usado para estimar el
   * ancho de las etiquetas de tocatierra del eje X */
  ANCHO_CAD: 7,
  /* caracteres totales que se reservan a cada etiqueta de tocatierra del eje X */
  MAX_CAD_ETQ_TOCA: 35,
  /* emparejado nota↔tocatierra: mismo criterio que el mapa (±2 h, la más cercana) */
  NOTA_UMBRAL_MS: 2 * 3600 * 1000,

  M: { sup: 26, der: 58, izq: 46, inf: 26 },

  /* =====================================================================
   *  Vista tormenta: 3 paneles apilados con eje X compartido
   * ===================================================================== */

  crearPanelTormenta(contenedor, opciones) {
    const puntos = opciones.puntos;
    const t0 = +puntos[0].d;
    const t1 = +puntos[puntos.length - 1].d;
    const span = Math.max(t1 - t0, 1);
    const padT = span * 0.03;

    const presionMin = d3.min(puntos, p => p.presion_mb);
    const presionBaja = Math.min(950, presionMin - 6);
    const vientoMax = d3.max(puntos, p => p.viento_kt) || 1;
    /* notas de tocatierra de esta tormenta (opción `notas`, cruda): alimentan
     * los timestamps bajo el eje X del panel inferior */
    const notas = Paneles._normalizarNotasToca(opciones.notas);

    let iActivo = 0;
    let iHover = null;     // vista previa por hover (tiene prioridad)
    let tInterp = null;    // posición continua durante el playback
    let paneles = [];
    let x = null;

    const raiz = d3.select(contenedor);
    raiz.html('');
    const marco = raiz.append('div').attr('class', 'paneles-marco');

    const leyendaP1 =
      '<span class="pl-item"><span class="muestra sw-tinta"></span>viento (kt)</span>' +
      '<span class="pl-item"><span class="muestra sw-punteado"></span>presión (mb)</span>' +
      '<span class="pl-item"><span class="muestra sw-ir"></span>IR</span>' +
      '<span class="pl-aviso">eje de presión invertido (práctica meteorológica)</span>';

    function construir() {
      const ancho = Math.max(360, contenedor.clientWidth || 720);
      x = d3.scaleUtc()
        .domain([new Date(t0 - padT), new Date(t1 + padT)])
        .range([0, ancho - Paneles.M.izq - Paneles.M.der]);
      marco.html('');
      paneles = [
        Paneles._panelVientoPresion(marco, { puntos: puntos, x: x, ancho: ancho, vientoMax: vientoMax, presionBaja: presionBaja, leyendaP1: leyendaP1, sub: Datos.fmtRango(puntos) }),
        Paneles._panelAcumulado(marco, { puntos: puntos, x: x, ancho: ancho, campo: 'muertes_acum', titulo: 'Muertes acumuladas', fmtTick: v => Datos.fmtEntero(v), color: Paneles.CARMESI, colorArea: 'rgba(234,79,126,0.13)', ultimo: false }),
        Paneles._panelAcumulado(marco, { puntos: puntos, x: x, ancho: ancho, campo: 'danos_acum_usd', titulo: 'Daños acumulados', fmtTick: v => Datos.fmtUSDCorto(v), color: Paneles.AMBAR, colorArea: 'rgba(232,168,69,0.12)', ultimo: true, notas: notas })
      ];
    }

    function refrescar() {
      const iBase = iHover !== null ? iHover : iActivo;
      const conInterp = iHover === null && tInterp !== null;
      let frac = 0;
      if (conInterp) {
        const pa = +puntos[iBase].d;
        const pb = puntos[iBase + 1] ? +puntos[iBase + 1].d : pa;
        frac = pb > pa ? Math.max(0, Math.min(1, (tInterp - pa) / (pb - pa))) : 0;
      }
      const xLinea = conInterp ? x(tInterp) : x(puntos[iBase].d);
      paneles.forEach(pn => pn.act(xLinea, iBase, conInterp, frac));
    }

    construir();
    refrescar();

    /* hover/clic: los rect de captura de los 3 paneles llaman a la app, que
     * sincroniza (los métodos set/setHover re-renderizan los crosshair). */
    paneles.forEach(pn => {
      pn.captura
        .on('mousemove', (ev) => {
          const [mx] = d3.pointer(ev, pn.g.node());
          const idx = Datos.masCercano(puntos, x.invert(Math.max(0, Math.min(pn.innerW, mx))));
          opciones.alHover(idx, ev);
        })
        .on('mouseleave', () => opciones.alSalida())
        .on('click', (ev) => {
          const [mx] = d3.pointer(ev, pn.g.node());
          opciones.alFija(Datos.masCercano(puntos, x.invert(Math.max(0, Math.min(pn.innerW, mx)))));
        });
    });

    return {
      setActivo(i) { iActivo = i; iHover = null; tInterp = null; refrescar(); },
      setInterp(i, f) {
        iActivo = i;
        iHover = null;
        tInterp = (puntos[i + 1] && f > 0) ? +puntos[i].d + (+puntos[i + 1].d - +puntos[i].d) * f : null;
        refrescar();
      },
      setHover(i) { iHover = i; tInterp = null; refrescar(); },
      limpiarHover() { iHover = null; tInterp = null; refrescar(); }
    };
  },

  /* Marcas del eje Y a partir del MÁXIMO del dato: paso «nice» (1·2·2,5·5·10 ×
   * 10^k) con como mucho `maxMarcas` marcas y dominio cerrado en la ÚLTIMA
   * marca, que por construcción es ≥ el máximo real. Así la escalera (o el
   * área) nunca queda por encima del tick más alto —sin truncar: el dominio
   * solo sobra lo justo que pide el redondeo—. Devuelve {max, valores}. */
  _marcasY(maxV, maxMarcas) {
    const max = +maxV;
    if (!(max > 0)) return { max: 1, valores: [0, 1] };
    const intervalos = Math.max(1, (maxMarcas || 5) - 1);
    const bruto = max / intervalos;
    const pot = Math.pow(10, Math.floor(Math.log10(bruto)));
    let paso = pot * 10;
    [1, 2, 2.5, 5, 10].some(m => {
      if (m * pot >= bruto * (1 - 1e-12)) { paso = m * pot; return true; }
      return false;
    });
    const fin = Math.ceil(max / paso - 1e-9) * paso;
    const valores = [];
    for (let i = 0; i * paso <= fin + paso * 1e-6; i++) valores.push(i * paso);
    return { max: fin, valores: valores };
  },

  /* Utilidad compartida: bandas IR + líneas de tocatierra (en los 3 paneles). */
  _marcasTemporales(g, o) {
    Datos.tramosIR(o.puntos).forEach(tr => {
      const x1 = Math.max(o.x(tr.tIni), -4);
      const x2 = Math.min(o.x(tr.tFin), o.innerW + 4);
      g.append('rect')
        .attr('x', x1).attr('y', 0)
        .attr('width', Math.max(x2 - x1, 5)).attr('height', o.altoInt)
        .attr('fill', 'rgba(237,242,250,0.055)');
      const xEtq = Math.max(Math.min(x1 + 3, o.innerW - 18), 2);
      g.append('text').attr('class', 'etq-ir').attr('x', xEtq).attr('y', 11).text('IR');
    });
    o.puntos.forEach(p => {
      if (!p.tocatierra) return;
      const xt = o.x(p.d);
      g.append('line').attr('x1', xt).attr('x2', xt)
        .attr('y1', 0).attr('y2', o.altoInt)
        .attr('stroke', '#d5e1ef').attr('stroke-width', 1.3).attr('opacity', 0.85);
      g.append('path')
        .attr('d', 'M' + (xt - 4.5) + ' 0 L' + (xt + 4.5) + ' 0 L' + xt + ' 7 Z')
        .attr('fill', '#d5e1ef');
    });
  },

  /* ---------- timestamps de tocatierra (bajo el eje X del panel inferior) ---------- */

  /* Normaliza las notas de data/notas-tocatierras.json (mismo formato de
   * entrada que usa el mapa): {tMs, lugar, nota, cat}. */
  _normalizarNotasToca(lista) {
    return (Array.isArray(lista) ? lista : [])
      .map(n => ({
        tMs: +new Date(n.t),
        lugar: String(n.lugar == null ? '' : n.lugar),
        nota: String(n.nota == null ? '' : n.nota),
        cat: n.cat
      }))
      .filter(n => Number.isFinite(n.tMs));
  },

  /* Emparejado 1:1 nota → tocatierra: el tocatierra más cercano en tiempo
   * (±2 h, mismo umbral que el mapa), sin repetir una nota en dos tocatierras
   * contiguos. Devuelve [{p, nota, x}] ordenado por tiempo. */
  _tocasConNota(puntos, notas, x) {
    const etiquetas = [];
    (notas || []).forEach(nota => {
      let mejor = null;
      let mejorDist = Infinity;
      puntos.forEach(p => {
        if (!p.tocatierra) return;
        const dist = Math.abs(+p.d - nota.tMs);
        if (dist < mejorDist) { mejorDist = dist; mejor = p; }
      });
      if (mejor && mejorDist <= Paneles.NOTA_UMBRAL_MS) etiquetas.push({ p: mejor, nota: nota, x: x(mejor.d) });
    });
    etiquetas.sort((a, b) => +a.p.d - +b.p.d);
    return etiquetas;
  },

  /* Lugar abreviado para las etiquetas del eje X: primero el TRAMO principal
   * (lo que va antes de la coma o del paréntesis: «Sur de Florida»,
   * «Buras»); si aún es largo, corte por frontera de palabra con «…»
   * («Desembocadura…»). La nota completa sigue en el tooltip. */
  _abreviarLugar(lugar, max) {
    const limpio = String(lugar == null ? '' : lugar).replace(/\s+/g, ' ').trim();
    if (!limpio) return '';
    const tope = Math.max(8, max | 0);
    if (limpio.length <= tope) return limpio;
    const cabeza = (limpio.split(/\s*[,;(]\s*/)[0] || limpio).trim() || limpio;
    if (cabeza.length <= tope) return cabeza;
    const trozo = cabeza.slice(0, tope - 1); // −1: el «…» ocupa el último hueco
    const corte = trozo.lastIndexOf(' ');
    const base = (corte >= Math.floor(tope * 0.5) ? trozo.slice(0, corte) : trozo)
      .replace(/[\s,;:.·—-]+$/, '');
    return base + '…';
  },

  /* Texto compacto de la etiqueta: «29 ago · 11:10 — Sur de Florida».
   * `maxChars` (por defecto MAX_CAD_ETQ_TOCA) acota el TOTAL del texto al ancho
   * disponible del trazado: el lugar se acorta para que nunca haya desbordes
   * (nada de «Sur de Florida (M…»); el detalle completo va en el tooltip. */
  _fmtEtqToca(p, nota, maxChars) {
    const hh = String(p.d.getUTCHours()).padStart(2, '0');
    const mm = String(p.d.getUTCMinutes()).padStart(2, '0');
    const cab = Datos.fmtDia(p.d) + ' · ' + hh + ':' + mm;
    const tope = (maxChars || Paneles.MAX_CAD_ETQ_TOCA) - cab.length - 3; // 3 = « — »
    const lugar = Paneles._abreviarLugar(nota.lugar, tope);
    return lugar ? cab + ' — ' + lugar : cab;
  },

  /* Texto completo (title nativo): fecha/hora UTC + lugar + Cat + nota. */
  _tituloEtqToca(p, nota) {
    const cat = Math.max(0, Math.min(5, p.cat_ss | 0));
    return 'Tocatierra · ' + Datos.fmtReloj(p.d) + ' · ' + nota.lugar +
      ' (' + (cat >= 1 ? 'Cat ' + cat : Datos.fmtCatCorto(cat)) + ') — ' + nota.nota;
  },

  /* Coloca etiquetas en hasta CUATRO niveles bajo el eje (anti-colisión por
   * rectángulos de ancho estimado, margen 6 px; si un racimo los satura, al
   * nivel menos cargado). Puro (sin DOM): devuelve [{e, centro, y}]. */
  _colocarTocas(etiquetas, innerW, altoInt, maxChars) {
    const ANCHO_CAD = Paneles.ANCHO_CAD;
    const niveles = [altoInt + 36, altoInt + 48, altoInt + 60, altoInt + 72];
    const ocupados = niveles.map(() => []);
    return etiquetas.map(e => {
      const ancho = Paneles._fmtEtqToca(e.p, e.nota, maxChars).length * ANCHO_CAD + 4;
      const centro = ancho >= innerW
        ? innerW / 2
        : Math.max(ancho / 2, Math.min(e.x, innerW - ancho / 2));
      const rect = { x: centro - ancho / 2, w: ancho };
      const choca = rs => rs.some(r => !(rect.x + rect.w + 6 <= r.x || r.x + r.w + 6 <= rect.x));
      let nivel = ocupados.findIndex(rs => !choca(rs));
      if (nivel < 0) { // racimo saturado: el nivel menos cargado
        nivel = 0;
        ocupados.forEach((rs, j) => { if (rs.length < ocupados[nivel].length) nivel = j; });
      }
      ocupados[nivel].push(rect);
      return { e: e, centro: centro, y: niveles[nivel] };
    });
  },

  /* Etiquetas de timestamp de los tocatierras CON nota, en el renglón
   * reservado bajo el eje X del panel inferior: centradas bajo su línea y
   * recortadas al área de trazado; NO tocan los ticks regulares (van en el
   * renglón de arriba) y una marca corta en acento prolonga cada trazo de
   * tocatierra bajo el eje. */
  _etqTocatierraEje(g, o) {
    const etiquetas = Paneles._tocasConNota(o.puntos, o.notas, o.x);
    if (!etiquetas.length) return;
    /* ancho disponible expresado en CARACTERES (nunca más que MAX_CAD_ETQ_TOCA):
     * en columnas estrechas el lugar se acorta aún más para que la etiqueta
     * nunca desborde el trazado */
    const maxChars = Math.min(Paneles.MAX_CAD_ETQ_TOCA,
      Math.max(24, Math.floor((o.innerW - 8) / Paneles.ANCHO_CAD)));
    const colocadas = Paneles._colocarTocas(etiquetas, o.innerW, o.altoInt, maxChars);
    const grupo = g.append('g').attr('class', 'etq-tocas-eje');
    colocadas.forEach(c => {
      const e = c.e;

      /* prolonga el trazo vertical del tocatierra (que termina en el eje)
       * hasta el renglón de etiquetas */
      grupo.append('line').attr('class', 'tick-toca-eje')
        .attr('x1', e.x).attr('x2', e.x)
        .attr('y1', o.altoInt).attr('y2', o.altoInt + 4);

      grupo.append('text')
        .attr('class', 'etq-toca-eje')
        .attr('x', c.centro)
        .attr('y', c.y)
        .attr('text-anchor', 'middle')
        .text(Paneles._fmtEtqToca(e.p, e.nota, maxChars))
        .append('title').text(Paneles._tituloEtqToca(e.p, e.nota));
    });
  },

  /* Marco DOM de un panel: cabecera (título/sub/leyenda) + svg vacío. */
  _envoltura(marco, clase, titulo, sub, leyendaHTML) {
    const sec = marco.append('section').attr('class', 'panel ' + clase);
    const cab = sec.append('header').attr('class', 'panel-cab');
    cab.append('h3').attr('class', 'panel-titulo').text(titulo);
    if (sub) cab.append('span').attr('class', 'panel-sub').text(sub);
    if (leyendaHTML) cab.append('span').attr('class', 'panel-leyenda').html(leyendaHTML);
    sec.append('svg').attr('class', 'panel-svg');
    return sec;
  },

  /* ---------- Panel 1: viento (izq, desde 0) + presión (der, invertido) ---------- */

  _panelVientoPresion(marco, o) {
    const M = this.M;
    const alto = 212;
    const sec = this._envoltura(marco, 'panel-vp', 'Viento y presión', o.sub, o.leyendaP1);
    const svg = sec.select('svg').attr('width', o.ancho).attr('height', alto);
    const innerW = o.ancho - M.izq - M.der;
    const altoInt = alto - M.sup - M.inf;
    const g = svg.append('g').attr('transform', 'translate(' + M.izq + ',' + M.sup + ')');

    this._marcasTemporales(g, { x: o.x, puntos: o.puntos, altoInt: altoInt, innerW: innerW });

    /* marcas «nice» cerradas en el máximo: el área de viento nunca supera el
     * tick más alto (misma regla que los acumulados) */
    const mYV = Paneles._marcasY(o.vientoMax, 5);
    const yV = d3.scaleLinear().domain([0, mYV.max]).range([altoInt, 0]);
    /* El eje derecho está INVERTIDO: la menor presión (mayor intensidad) se lee
     * más arriba, así la línea de presión co-varía con la del viento. */
    const yP = d3.scaleLinear().domain([o.presionBaja, 1010]).range([0, altoInt]);

    const areaV = d3.area().curve(d3.curveMonotoneX)
      .x(p => o.x(p.d)).y0(altoInt).y1(p => yV(p.viento_kt));
    g.append('path').attr('d', areaV(o.puntos)).attr('fill', 'rgba(214,226,240,0.1)');
    const lineaV = d3.line().curve(d3.curveMonotoneX).x(p => o.x(p.d)).y(p => yV(p.viento_kt));
    g.append('path').attr('d', lineaV(o.puntos)).attr('fill', 'none')
      .attr('stroke', this.TINTA).attr('stroke-width', 1.9);
    const lineaP = d3.line().curve(d3.curveMonotoneX).x(p => o.x(p.d)).y(p => yP(p.presion_mb));
    g.append('path').attr('d', lineaP(o.puntos)).attr('fill', 'none')
      .attr('stroke', this.GRIS).attr('stroke-width', 1.5).attr('stroke-dasharray', '5 4');

    g.append('g').attr('class', 'eje')
      .call(d3.axisLeft(yV).tickValues(mYV.valores).tickFormat(v => Datos.fmtEntero(v)));
    g.append('g').attr('class', 'eje eje-der')
      .attr('transform', 'translate(' + innerW + ',0)')
      .call(d3.axisRight(yP).ticks(4).tickFormat(v => Datos.fmtEntero(v)));
    g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', altoInt).attr('y2', altoInt)
      .attr('stroke', this.LINEA_EJE);

    /* crosshair: línea + dos puntos (viento sólido, presión hueco) */
    const cruz = g.append('g').attr('class', 'crosshair');
    cruz.append('line').attr('y1', 0).attr('y2', altoInt);
    const cV = cruz.append('circle').attr('class', 'cruz-pt pt-viento').attr('r', 3.2);
    const cP = cruz.append('circle').attr('class', 'cruz-pt pt-presion').attr('r', 3.2);

    const captura = g.append('rect')
      .attr('width', innerW).attr('height', altoInt)
      .attr('fill', 'transparent').style('cursor', 'crosshair');

    return {
      g: g, captura: captura, innerW: innerW, x: o.x,
      act(xLinea, iBase, conInterp, frac) {
        const p = o.puntos[iBase], q = o.puntos[iBase + 1];
        const vis = xLinea >= 0 && xLinea <= innerW;
        cruz.select('line')
          .attr('x1', xLinea).attr('x2', xLinea)
          .style('opacity', vis ? 1 : 0);
        let vV = p.viento_kt, vP = p.presion_mb;
        if (conInterp && q) {
          vV = p.viento_kt + (q.viento_kt - p.viento_kt) * frac;
          vP = p.presion_mb + (q.presion_mb - p.presion_mb) * frac;
        }
        cV.attr('cx', xLinea).attr('cy', yV(vV)).style('opacity', vis ? 1 : 0);
        cP.attr('cx', xLinea).attr('cy', yP(vP)).style('opacity', vis ? 1 : 0);
      }
    };
  },

  /* ---------- Panel 2/3: acumulados en escalón (desde 0, sin truncar) ---------- */

  _panelAcumulado(marco, o) {
    const M = Object.assign({}, this.M);
    if (o.campo === 'danos_acum_usd') M.izq = 84; // las etiquetas del eje ($125 mil M) son más anchas
    /* el panel INFERIOR reserva un renglón extra bajo el eje X para los
     * timestamps de tocatierra; el área de trazado no cambia */
    const extraInf = o.ultimo ? Paneles.ALTO_ETQ_TOCA : 0;
    const alto = 176 + extraInf;
    const sec = this._envoltura(marco, o.ultimo ? 'panel-danos' : 'panel-muertes', o.titulo, '', '');
    const svg = sec.select('svg').attr('width', o.ancho).attr('height', alto);
    const innerW = o.ancho - M.izq - M.der;
    const altoInt = alto - M.sup - (M.inf + extraInf);
    const g = svg.append('g').attr('transform', 'translate(' + M.izq + ',' + M.sup + ')');

    this._marcasTemporales(g, { x: o.x, puntos: o.puntos, altoInt: altoInt, innerW: innerW });

    /* Dominio = última marca «nice» ≥ máximo (ver _marcasY): la escalera y el
     * área NUNCA pasan por encima del tick superior (sin truncar el dato). */
    const maxV = d3.max(o.puntos, p => p[o.campo]) || 1;
    const mY = Paneles._marcasY(maxV, 5);
    const y = d3.scaleLinear().domain([0, mY.max]).range([altoInt, 0]);

    const paso = d3.line().curve(d3.curveStepAfter).x(p => o.x(p.d)).y(p => y(p[o.campo]));
    const area = d3.area().curve(d3.curveStepAfter)
      .x(p => o.x(p.d)).y0(altoInt).y1(p => y(p[o.campo]));
    g.append('path').attr('d', area(o.puntos)).attr('fill', o.colorArea);
    g.append('path').attr('d', paso(o.puntos)).attr('fill', 'none')
      .attr('stroke', o.color).attr('stroke-width', 1.9);

    g.append('g').attr('class', 'eje')
      .call(d3.axisLeft(y).tickValues(mY.valores).tickFormat(o.fmtTick));

    if (o.ultimo) {
      g.append('g').attr('class', 'eje eje-x')
        .attr('transform', 'translate(0,' + altoInt + ')')
        .call(d3.axisBottom(o.x).ticks(6).tickFormat(d => Datos.fmtDia(d)));
      Paneles._etqTocatierraEje(g, {
        puntos: o.puntos, x: o.x, notas: o.notas, innerW: innerW, altoInt: altoInt
      });
    } else {
      g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', altoInt).attr('y2', altoInt)
        .attr('stroke', this.LINEA_EJE);
    }

    const cruz = g.append('g').attr('class', 'crosshair');
    cruz.append('line').attr('y1', 0).attr('y2', altoInt);
    const cPt = cruz.append('circle').attr('class', 'cruz-pt').attr('r', 3.4)
      .attr('fill', o.color).attr('stroke', '#142033').attr('stroke-width', 1.5);

    const captura = g.append('rect')
      .attr('width', innerW).attr('height', altoInt)
      .attr('fill', 'transparent').style('cursor', 'crosshair');

    return {
      g: g, captura: captura, innerW: innerW, x: o.x,
      act(xLinea, iBase) {
        const vis = xLinea >= 0 && xLinea <= innerW;
        cruz.select('line')
          .attr('x1', xLinea).attr('x2', xLinea)
          .style('opacity', vis ? 1 : 0);
        cPt.attr('cx', xLinea).attr('cy', y(o.puntos[iBase][o.campo]))
          .style('opacity', vis ? 1 : 0);
      }
    };
  }

};

window.Paneles = Paneles;