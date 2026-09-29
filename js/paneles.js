'use strict';
/* paneles.js — global `Paneles`.
 *  - crearPanelTormenta() → los 3 paneles apilados (viento/presión, muertes,
 *    daños) con eje temporal compartido y crosshair sincronizado.
 *  - crearComparar()      → los 2 paneles de la vista comparación, alineados
 *    por horas relativas al PRIMER tocatierra de cada tormenta.
 *
 * Muertes y daños van desde 0 (sin truncar); la única escala no directa es la
 * del eje derecho de presión (invertido, práctica meteorológica), declarada en
 * la leyenda del panel 1. Infrarrojos (IR) y tocatierras se repiten en los 3
 * paneles para leer la alineación temporal sin interacción. */

const Paneles = {

  /* Tinta (el trazo de viento) en claro sobre el panel nocturno. */
  TINTA: '#edf2fa',
  GRIS: '#a3b4d6',
  CARMESI: '#e8506a',   // muertes (canal propio; nunca paleta de categoría)
  AMBAR: '#e8a845',     // daños (canal propio; nunca paleta de categoría)
  LINEA_EJE: '#3d4f76',
  PIZARRA: '#a9c3dc',   // neutro A en comparación (bruma; nunca paleta de categoría)
  SIENA: '#dcb287',     // neutro B en comparación (arena; nunca paleta de categoría)

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
        Paneles._panelAcumulado(marco, { puntos: puntos, x: x, ancho: ancho, campo: 'muertes_acum', titulo: 'Muertes acumuladas', fmtTick: v => Datos.fmtEntero(v), color: Paneles.CARMESI, colorArea: 'rgba(232,80,106,0.13)', ultimo: false }),
        Paneles._panelAcumulado(marco, { puntos: puntos, x: x, ancho: ancho, campo: 'danos_acum_usd', titulo: 'Daños acumulados', fmtTick: v => Datos.fmtUSDCorto(v), color: Paneles.AMBAR, colorArea: 'rgba(232,168,69,0.12)', ultimo: true })
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

    const yV = d3.scaleLinear().domain([0, o.vientoMax]).nice().range([altoInt, 0]);
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

    g.append('g').attr('class', 'eje').call(d3.axisLeft(yV).ticks(4).tickFormat(v => Datos.fmtEntero(v)));
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
    const alto = 176;
    const sec = this._envoltura(marco, o.ultimo ? 'panel-danos' : 'panel-muertes', o.titulo, '', '');
    const svg = sec.select('svg').attr('width', o.ancho).attr('height', alto);
    const innerW = o.ancho - M.izq - M.der;
    const altoInt = alto - M.sup - M.inf;
    const g = svg.append('g').attr('transform', 'translate(' + M.izq + ',' + M.sup + ')');

    this._marcasTemporales(g, { x: o.x, puntos: o.puntos, altoInt: altoInt, innerW: innerW });

    const maxV = d3.max(o.puntos, p => p[o.campo]) || 1;
    const y = d3.scaleLinear().domain([0, maxV]).nice().range([altoInt, 0]);

    const paso = d3.line().curve(d3.curveStepAfter).x(p => o.x(p.d)).y(p => y(p[o.campo]));
    const area = d3.area().curve(d3.curveStepAfter)
      .x(p => o.x(p.d)).y0(altoInt).y1(p => y(p[o.campo]));
    g.append('path').attr('d', area(o.puntos)).attr('fill', o.colorArea);
    g.append('path').attr('d', paso(o.puntos)).attr('fill', 'none')
      .attr('stroke', o.color).attr('stroke-width', 1.9);

    g.append('g').attr('class', 'eje').call(d3.axisLeft(y).ticks(4).tickFormat(o.fmtTick));

    if (o.ultimo) {
      g.append('g').attr('class', 'eje eje-x')
        .attr('transform', 'translate(0,' + altoInt + ')')
        .call(d3.axisBottom(o.x).ticks(6).tickFormat(d => Datos.fmtDia(d)));
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
  },

  /* =====================================================================
   *  Vista comparar: 2 paneles sobre el eje de HORAS RELATIVAS
   *  (0 = primer tocatierra de cada tormenta, dominio [−120, +240] h)
   * ===================================================================== */

  crearComparar(contenedor, opciones) {
    const lo = opciones.lo != null ? opciones.lo : -120;
    const hi = opciones.hi != null ? opciones.hi : 240;
    const tormentaA = opciones.a, tormentaB = opciones.b;

    /* serie recortada al dominio con continuidad de escalón en los bordes */
    function serieRelativa(tormenta, campo) {
      const pts = tormenta.puntos;
      const primerToca = Datos.primerTocatierra(pts) || pts[0];
      const t0 = +primerToca.d;
      const serie = [];
      for (let i = 0; i < pts.length; i++) {
        const r = (+pts[i].d - t0) / 3.6e6;
        if (r > hi) {
          if (serie.length) serie.push({ rel: hi, val: serie[serie.length - 1].val });
          break;
        }
        if (r >= lo) {
          if (serie.length === 0 && i > 0) serie.push({ rel: lo, val: pts[i - 1][campo] });
          serie.push({ rel: r, val: pts[i][campo] });
        }
      }
      return serie;
    }

    const raiz = d3.select(contenedor);
    raiz.html('');
    const marco = raiz.append('div').attr('class', 'paneles-marco');

    const par = [
      { storm: tormentaA, color: this.PIZARRA },
      { storm: tormentaB, color: this.SIENA }
    ];

    const M = { sup: 18, der: 66, izq: 46, inf: 40 };
    const ALTO = 196;
    let x = null;

    function construir() {
      const ancho = Math.max(480, contenedor.clientWidth || 980);
      x = d3.scaleLinear().domain([lo, hi]).range([0, ancho - M.izq - M.der]);
      marco.html('');

      /* leyenda de los dos tonos neutros */
      const leyenda = marco.append('div').attr('class', 'panel-cab compara-leyenda');
      leyenda.html(par.map((c, k) =>
        '<span class="pl-item"><span class="muestra" style="border-top-color:' + c.color + ';border-top-width:3px"></span>' +
        c.storm.nombre + ' ' + c.storm.anio + '</span>').join(''))
        .append('span').attr('class', 'panel-sub').text('horas relativas al primer tocatierra de cada tormenta');

      Paneles._panelRelativo(marco, {
        series: [
          { datos: serieRelativa(tormentaA, 'muertes_acum'), color: Paneles.PIZARRA, nombre: tormentaA.nombre + ' ' + tormentaA.anio },
          { datos: serieRelativa(tormentaB, 'muertes_acum'), color: Paneles.SIENA, nombre: tormentaB.nombre + ' ' + tormentaB.anio }
        ],
        titulo: 'Muertes acumuladas (por hora relativa)',
        fmtTick: v => Datos.fmtEntero(v),
        lo: lo, hi: hi, ancho: ancho, M: M, alto: 190
      });

      Paneles._panelRelativo(marco, {
        series: [
          { datos: serieRelativa(tormentaA, 'danos_acum_usd'), color: Paneles.PIZARRA, nombre: tormentaA.nombre + ' ' + tormentaA.anio },
          { datos: serieRelativa(tormentaB, 'danos_acum_usd'), color: Paneles.SIENA, nombre: tormentaB.nombre + ' ' + tormentaB.anio }
        ],
        titulo: 'Daños acumulados (por hora relativa)',
        fmtTick: v => Datos.fmtUSDCorto(v),
        lo: lo, hi: hi, ancho: ancho, M: Object.assign({}, M, { izq: 84 }), alto: 190
      });
    }

    construir();

    return {
      redibujar() { construir(); }
    };
  },

  /* Panel relativo: dos series step-after superpuestas + línea de tocatierra en 0. */
  _panelRelativo(marco, o) {
    const sec = this._envoltura(marco, 'panel-rel', o.titulo, '', '');
    const svg = sec.select('svg').attr('width', o.ancho).attr('height', o.alto);
    const M = o.M;
    const innerW = o.ancho - M.izq - M.der;
    const altoInt = o.alto - M.sup - M.inf;
    const g = svg.append('g').attr('transform', 'translate(' + M.izq + ',' + M.sup + ')');
    const x = d3.scaleLinear().domain([o.lo, o.hi]).range([0, innerW]);

    /* el escalón solo existe dentro del dominio: recorte por clipPath */
    const idClip = 'clip-rel-' + Math.round(Math.random() * 1e9);
    g.append('clipPath').attr('id', idClip)
      .append('rect').attr('x', 0).attr('y', -10)
      .attr('width', innerW).attr('height', altoInt + 20);
    const recortes = g.append('g').attr('clip-path', 'url(#' + idClip + ')');

    /* línea vertical en 0 · tocatierra (solo si el dominio la contiene) */
    if (o.lo < 0 && o.hi > 0) {
      g.append('line').attr('x1', x(0)).attr('x2', x(0))
        .attr('y1', 0).attr('y2', altoInt)
        .attr('stroke', '#d5e1ef').attr('stroke-width', 1.4).attr('opacity', 0.85);
      g.append('path')
        .attr('d', 'M' + (x(0) - 4.5) + ' 0 L' + (x(0) + 4.5) + ' 0 L' + x(0) + ' 7 Z')
        .attr('fill', '#d5e1ef');
    }

    const y = d3.scaleLinear()
      .domain([0, Math.max(
        o.series[0].datos.length ? d3.max(o.series[0].datos, d => d.val) : 1,
        o.series[1].datos.length ? d3.max(o.series[1].datos, d => d.val) : 1
      ) || 1]).nice().range([altoInt, 0]);

    o.series.forEach((s, k) => {
      if (!s.datos.length) return;
      const area = d3.area().curve(d3.curveStepAfter)
        .x(d => x(d.rel)).y0(altoInt).y1(d => y(d.val));
      const lin = d3.line().curve(d3.curveStepAfter)
        .x(d => x(d.rel)).y(d => y(d.val));
      recortes.append('path').attr('d', area(s.datos))
        .attr('fill', k === 0 ? 'rgba(169,195,220,0.13)' : 'rgba(220,178,135,0.12)');
      recortes.append('path').attr('d', lin(s.datos))
        .attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2);
      /* nombre de la tormenta al final de su línea */
      const ultimoPto = s.datos[s.datos.length - 1];
      recortes.append('text')
        .attr('class', 'etq-serie')
        .attr('x', x(Math.min(ultimoPto.rel, o.hi)) - 4)
        .attr('y', Math.max(y(ultimoPto.val) - 6 - k * 13, 10))
        .attr('text-anchor', 'end')
        .attr('fill', s.color)
        .text(s.nombre);
    });

    const marcas = [];
    for (let h = Math.ceil(o.lo / 48) * 48; h <= o.hi; h += 48) marcas.push(h);
    if (!marcas.includes(0) && o.lo < 0 && o.hi > 0) marcas.push(0);
    marcas.sort((a, b) => a - b);

    g.append('g').attr('class', 'eje').call(d3.axisLeft(y).ticks(4).tickFormat(o.fmtTick));
    g.append('g').attr('class', 'eje eje-x')
      .attr('transform', 'translate(0,' + altoInt + ')')
      .call(d3.axisBottom(x).tickValues(marcas)
        .tickFormat(v => v === 0 ? '0 · tocatierra' : Datos.fmtHoraRelativa(v)));
  }

};

window.Paneles = Paneles;