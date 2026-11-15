/* ============================================================================
   Gráficas de cada nodo y calendario de actividad (panel principal)
   Sustituye al detalle de panel.js para Pi-master, Faraday y Mustang (el del
   clúster sigue siendo el de panel.js). Gráficas con uPlot (MIT, uplot.min.js).
     - Ahora: 1 h, 6 h o 24 h. Días pasados: ‹ › o el calendario.
     - Pasar el ratón: valor y hora en todas a la vez.
     - Arrastrar en horizontal: amplía ese tramo en todas; doble clic, vuelve.
     - Calendario: horas encendida cada máquina cada día (Pi incluida).
   ========================================================================== */
(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const filaNodos = $("#fila-nodos"), cajaVieja = $("#detalle-caja");
  if (!filaNodos || !cajaVieja || !window.uPlot) return;

  const MAQUINAS = [["pi-master", "Pi-master"], ["faraday", "Faraday"], ["mustang", "Mustang"]];
  const NOMBRES = Object.fromEntries(MAQUINAS);
  const SERIES = [
    { clave: "cpu",       titulo: "CPU",         unidad: "%",     dec: 1, suelo: 0, techo: 100, minimo: 10 },
    { clave: "temp",      titulo: "Temperatura", unidad: "°C",    dec: 1, suelo: 0, minimo: 6 },
    { clave: "ram_usada", titulo: "RAM",         unidad: " GB",   dec: 1, suelo: 0, minimo: 1 },
    { clave: "carga",     titulo: "Carga",       unidad: " proc.", dec: 2, suelo: 0, minimo: 0.5,
      ayuda: "Procesos esperando CPU (media de 1 minuto). Por debajo del número de núcleos, va holgado." },
    { clave: "red",       titulo: "Red",         unidad: " KB/s", dec: 1, suelo: 0, minimo: 10 },
    { clave: "disco_pct", titulo: "Disco",       unidad: "%",     dec: 1, suelo: 0, techo: 100, minimo: 4 },
  ];
  const RANGOS = [[1, "1 h"], [6, "6 h"], [24, "24 h"]];
  // En el móvil: una debajo de otra, a lo ancho y muy bajas; solo la última lleva el eje de tiempo
  const movil = () => matchMedia("(max-width: 720px)").matches;
  const EJE_MOVIL = 18;
  const alto = k => movil() ? 34 + (k === SERIES.length - 1 ? EJE_MOVIL : 0) : 140;

  // dia: null = "ahora" (últimas N horas); si no, un día concreto "AAAA-MM-DD" de 00:00 a 24:00
  const est = { nodo: null, horas: 6, vista: "graficas", dia: null, zoom: null, mes: null, cal: "mes", anio: null };
  let graficos = [], DATOS = null, HUECOS = [], CAL = null;

  const panel = document.createElement("div");
  panel.className = "graf-panel";
  panel.hidden = true;
  cajaVieja.after(panel);

  /* ---------------- utilidades ---------------- */
  const horaMin = ms => new Date(ms).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  const claveDia = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const deClave = k => { const [a, m, d] = k.split("-").map(Number); return new Date(a, m - 1, d); };
  const hoyClave = () => claveDia(new Date());
  const sumarDias = (k, n) => { const d = deClave(k); d.setDate(d.getDate() + n); return claveDia(d); };
  const diaLargo = k => {
    const txt = deClave(k).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    const pref = k === hoyClave() ? "Hoy, " : k === sumarDias(hoyClave(), -1) ? "Ayer, " : "";
    return pref + (pref ? txt : txt.charAt(0).toUpperCase() + txt.slice(1));
  };
  const num = (v, d) => v == null ? "—" : Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(d);

  // Colores del tema actual, convertidos a rgb() de verdad (sirve con cualquier paleta)
  const lienzo = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  function rgb(css) {
    const i = document.createElement("i");
    i.style.cssText = `position:absolute;visibility:hidden;color:${css}`;
    document.body.appendChild(i);
    const c = getComputedStyle(i).color; i.remove();
    lienzo.clearRect(0, 0, 1, 1); lienzo.fillStyle = "#000"; lienzo.fillStyle = c; lienzo.fillRect(0, 0, 1, 1);
    const [r, g, b] = lienzo.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  }
  function colores() {
    const a = rgb("var(--acento)"), t = rgb("var(--texto-3)"), r = rgb("var(--mal)");
    const f = (c, al) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${al})`;
    return { linea: f(a, 1), area: f(a, .14), ejes: f(t, 1), malla: f(t, .12), hueco: f(r, .07) };
  }

  /* ---------------- abrir / cerrar ---------------- */
  function abrir(nodo, opciones = {}) {
    if (typeof nodoActivo !== "undefined" && nodoActivo && typeof cerrarDetalle === "function") cerrarDetalle();
    est.nodo = nodo; est.zoom = null;
    if ("dia" in opciones) est.dia = opciones.dia;
    if (opciones.vista) est.vista = opciones.vista;
    $$(".nodo", filaNodos).forEach(t => t.classList.toggle("seleccionada", t.dataset.nodo === nodo));
    panel.hidden = false;
    panel.innerHTML = `
      <div class="graf-cab">
        <h3>${esc(NOMBRES[nodo] || nodo)}</h3>
        <div class="seg" data-grupo="vista">
          <button type="button" data-vista="graficas">Gráficas</button><button type="button" data-vista="calendario">Calendario</button>
        </div>
        <button type="button" class="cerrar-tarjeta" title="Cerrar"><svg class="ico"><use href="#i-cerrar"/></svg></button>
      </div>
      <div class="graf-dia">
        <button type="button" class="dia-flecha" data-dia-paso="-1" title="Día anterior">‹</button>
        <div class="dia-texto"><strong data-dia-titulo></strong><span data-dia-sub></span></div>
        <button type="button" class="dia-flecha" data-dia-paso="1" title="Día siguiente">›</button>
        <div class="seg" data-grupo="rango">${RANGOS.map(([h, t]) => `<button type="button" data-horas="${h}">${t}</button>`).join("")}</div>
        <button type="button" class="volver-ahora" data-ahora>Volver a ahora</button>
      </div>
      <div class="graf-pista"></div>
      <div class="graf-rejilla">${SERIES.map(s => `
        <div class="graf" data-serie="${s.clave}">
          <div class="graf-titulo"${s.ayuda ? ` title="${esc(s.ayuda)}"` : ""}><span>${s.titulo}</span><span class="graf-cifras"><b data-valor></b><small data-max></small></span></div>
          <div class="graf-lienzo"></div>
        </div>`).join("")}</div>
      <div class="calendario" hidden></div>`;
    cambiarVista(est.vista);
  }

  function cerrar() {
    destruir();
    panel.hidden = true; panel.innerHTML = "";
    est.nodo = null; est.dia = null; est.zoom = null; est.vista = "graficas";
    $$(".nodo", filaNodos).forEach(t => t.classList.remove("seleccionada"));
  }

  function pintarCabecera() {
    $$('[data-grupo="vista"] button', panel).forEach(b => b.classList.toggle("activo", b.dataset.vista === est.vista));
    const graf = est.vista === "graficas";
    $(".graf-dia", panel).hidden = !graf;
    $(".graf-pista", panel).hidden = !graf;
    $(".graf-rejilla", panel).hidden = !graf;
    $(".calendario", panel).hidden = graf;
    if (!graf) return;
    const vivo = !est.dia;
    panel.classList.toggle("pasado", !vivo);
    $("[data-dia-titulo]", panel).textContent = vivo ? "Ahora" : diaLargo(est.dia);
    $("[data-dia-sub]", panel).textContent = vivo ? `últimas ${est.horas} h · se actualiza sola` : "de 00:00 a 24:00";
    $('[data-grupo="rango"]', panel).hidden = !vivo;
    $("[data-ahora]", panel).hidden = vivo;
    $('[data-dia-paso="1"]', panel).disabled = vivo;
    $$('[data-grupo="rango"] button', panel).forEach(b => b.classList.toggle("activo", +b.dataset.horas === est.horas));
  }

  function cambiarVista(vista) {
    est.vista = vista;
    pintarCabecera();
    if (vista === "graficas") cargar(); else { destruir(); pintarCalendario(); }
  }

  // ‹ desde "ahora" va a hoy entero; › desde hoy vuelve a "ahora"
  function moverDia(paso) {
    if (!est.dia) { if (paso < 0) est.dia = hoyClave(); }
    else {
      const nuevo = sumarDias(est.dia, paso);
      est.dia = nuevo > hoyClave() ? null : nuevo;
    }
    est.zoom = null;
    pintarCabecera(); cargar();
  }

  /* ---------------- datos ---------------- */
  async function cargar() {
    const nodo = est.nodo, dia = est.dia;
    const ahora = Date.now() / 1000;
    let t0, t1, url;
    if (dia) {
      t0 = deClave(dia).getTime() / 1000; t1 = Math.min(t0 + 86400, ahora);
      url = `/api/historico/${encodeURIComponent(nodo)}?desde=${Math.floor(t0)}&hasta=${Math.ceil(t1)}`;
    } else {
      t0 = ahora - est.horas * 3600; t1 = ahora;
      url = `/api/historico/${encodeURIComponent(nodo)}?horas=${est.horas}`;
    }
    pista("Cargando…");
    let d;
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || r.status);
    } catch {
      if (est.nodo === nodo) { destruir(); pista("Sin histórico: Beszel no responde o no conoce esta máquina."); }
      return;
    }
    if (est.nodo !== nodo || est.dia !== dia) return;     // ha cambiado mientras cargaba
    const t = d.t.map(x => Date.parse(String(x).replace(" ", "T").replace(/\.\d+/, "").replace(/Z?$/, "Z")) / 1000);
    const pasos = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
    const paso = pasos[Math.floor(pasos.length / 2)] || 300;
    const xs = [], cols = SERIES.map(() => []);
    HUECOS = [];
    if (!t.length) HUECOS.push([t0, t1]);
    else if (t[0] - t0 > paso * 2.5) HUECOS.push([t0, t[0]]);
    t.forEach((v, i) => {
      if (i && v - t[i - 1] > paso * 2.5) {                // un null corta la línea en los apagones
        HUECOS.push([t[i - 1], v]);
        xs.push((v + t[i - 1]) / 2); cols.forEach(c => c.push(null));
      }
      xs.push(v); SERIES.forEach((s, k) => cols[k].push(d[s.clave]?.[i] ?? null));
    });
    if (t.length && t1 - t.at(-1) > paso * 2.5) HUECOS.push([t.at(-1), t1]);
    DATOS = { xs, cols, t0, t1, paso, muestras: t.length, grueso: paso > 1800 };
    dibujar();
    if (!dia) enVivo();
  }

  /* ---------------- eje de tiempo ----------------
     Siempre se rotulan las dos horas donde corta la gráfica (izquierda y derecha: con "Ahora",
     la de la derecha es la actual), y entre medias horas redondas que no se peguen a ellas. */
  const PASOS = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200];
  const DESFASE = () => -new Date().getTimezoneOffset() * 60;
  function marcasX(u, ai, min, max) {
    const caben = Math.max(1, Math.floor((u.width - 60) / (movil() ? 70 : 80)));
    const paso = PASOS.find(p => (max - min) / p <= caben) || 86400;
    const marcas = [min];
    for (let t = Math.ceil((min + DESFASE()) / paso) * paso - DESFASE(); t <= max; t += paso)
      if (t - min >= paso * 0.6 && max - t >= paso * 0.6) marcas.push(t);
    marcas.push(max);
    return marcas;
  }

  /* ---------------- gráficas ---------------- */
  function destruir() { graficos.forEach(g => g.destroy()); graficos = []; }

  function rangoY(s) {
    return (u, min, max) => {
      if (min == null || max == null || !isFinite(min)) return [s.suelo ?? 0, (s.suelo ?? 0) + s.minimo];
      let lo = min, hi = max;
      const falta = s.minimo - (hi - lo);
      if (falta > 0) { lo -= falta / 2; hi += falta / 2; }
      const margen = (hi - lo) * 0.1; lo -= margen; hi += margen;
      if (s.suelo != null && lo < s.suelo) { hi += s.suelo - lo; lo = s.suelo; }
      if (s.techo != null && hi > s.techo) { lo = Math.max(s.suelo ?? lo, lo - (hi - s.techo)); hi = s.techo; }
      return [lo, hi];
    };
  }

  // → [valor grande, máximo del tramo visible]. Ahora: último valor y máximo; día pasado o ampliado: el máximo
  function cifras(k) {
    const s = SERIES[k], [x0, x1] = est.zoom || [DATOS.t0, DATOS.t1];
    const vals = DATOS.cols[k].filter((v, i) => v != null && DATOS.xs[i] >= x0 && DATOS.xs[i] <= x1);
    if (!vals.length) return ["—", ""];
    const max = `máx ${num(Math.max(...vals), s.dec)}${s.unidad}`;
    if (!est.dia && !est.zoom) return [num(vals.at(-1), s.dec) + s.unidad, max];
    return [max, ""];
  }
  function ponerCifras(k) {
    const g = $(`.graf[data-serie="${SERIES[k].clave}"]`, panel);
    if (!g || !DATOS) return;
    const [v, m] = cifras(k), b = $("[data-valor]", g);
    b.textContent = v; b.classList.remove("cursor");
    $("[data-max]", g).textContent = m;
  }

  function dibujar() {
    destruir();
    if (!DATOS || est.vista !== "graficas") return;
    const c = colores();
    const [x0, x1] = est.zoom || [DATOS.t0, DATOS.t1];
    const conPuntos = DATOS.muestras < 50;                              // pocos datos: que se vean
    SERIES.forEach((s, k) => {
      const caja = $(`.graf[data-serie="${s.clave}"] .graf-lienzo`, panel);
      const etiqueta = $(`.graf[data-serie="${s.clave}"] [data-valor]`, panel);
      ponerCifras(k);
      const m = movil(), ultima = k === SERIES.length - 1;
      const ejeX = { stroke: c.ejes, grid: { stroke: c.malla, width: 1 }, ticks: { show: false }, size: m ? (ultima ? EJE_MOVIL : 0) : 26,
            gap: m ? 3 : 6, font: `${m ? 9 : 11}px 'DM Sans', sans-serif`, splits: marcasX,
            values: (u, v) => v.map(x => (m && !ultima) ? ""
              : (est.dia && !est.zoom && Math.abs(x - (DATOS.t0 + 86400)) < 2) ? "24:00" : horaMin(x * 1000)) };
      const opciones = {
        width: Math.max(120, Math.floor(caja.getBoundingClientRect().width)), height: alto(k),
        legend: { show: false },
        padding: m ? [3, 16, 0, 16] : [10, 24, 0, 0],        // a los lados, sitio para las horas de los bordes
        scales: { x: { time: true, min: x0, max: x1 }, y: { range: rangoY(s) } },
        series: [{}, {
          stroke: c.linea, fill: c.area, width: 1.6, spanGaps: false,
          points: { show: conPuntos, size: 5, fill: c.linea, stroke: c.linea },
        }],
        axes: [
          ejeX,
          m ? { show: false } : { stroke: c.ejes, grid: { stroke: c.malla, width: 1 }, ticks: { show: false }, size: movil() ? 30 : 46, gap: movil() ? 3 : 6,
            font: `${movil() ? 9 : 11}px 'DM Sans', sans-serif`, space: movil() ? 26 : 34,
            values: (u, v) => v.map((x, i) => i === 0 && Math.abs(x - u.scales.y.min) < 1e-9 ? ""
                                              : num(x, x !== 0 && Math.abs(x) < 10 ? 1 : 0)) },
        ],
        cursor: {
          sync: { key: "graficas-nodo" },
          drag: { x: true, y: false, setScale: false },
          points: { size: 7, fill: c.linea },
          bind: { dblclick: () => () => { restablecer(); return null; } },
        },
        hooks: {
          drawClear: [u => {                                // franjas apagado, muy suaves y dentro del área
            const ctx = u.ctx, { left, top, width, height } = u.bbox;
            ctx.save(); ctx.fillStyle = c.hueco;
            for (const [a, b] of HUECOS) {
              const xa = Math.max(left, u.valToPos(a, "x", true)), xb = Math.min(left + width, u.valToPos(b, "x", true));
              if (xb > xa) ctx.fillRect(xa, top, xb - xa, height);
            }
            ctx.restore();
          }],
          draw: [u => {                                     // en "Ahora": raya fina en la hora actual
            if (est.dia || est.zoom) return;
            const ctx = u.ctx, x = Math.round(u.valToPos(u.scales.x.max, "x", true)) - 0.5;
            ctx.save(); ctx.strokeStyle = c.linea; ctx.globalAlpha = .35; ctx.lineWidth = devicePixelRatio || 1;
            ctx.setLineDash([3 * (devicePixelRatio || 1), 3 * (devicePixelRatio || 1)]);
            ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke();
            ctx.restore();
          }],
          setSelect: [u => {                                // arrastrar: ampliar ese tramo en todas
            if (u.select.width < 8) return;
            const a = u.posToVal(u.select.left, "x"), b = u.posToVal(u.select.left + u.select.width, "x");
            u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
            ampliar(a, b);
          }],
          setCursor: [u => {
            const i = u.cursor.idx;
            if (i == null || u.cursor.left < 0) {
              ponerCifras(k);
              if (k === 0) pistaNormal();
              return;
            }
            const v = u.data[1][i];
            etiqueta.textContent = v == null ? "apagado" : num(v, s.dec) + s.unidad;
            etiqueta.classList.add("cursor");
            if (k === 0) pista(`<strong>${horaMin(u.data[0][i] * 1000)}</strong>`);
          }],
        },
      };
      graficos.push(new uPlot(opciones, [DATOS.xs, DATOS.cols[k]], caja));
    });
    pistaNormal();
  }

  function ampliar(a, b) {
    est.zoom = [a, b];
    graficos.forEach(g => g.setScale("x", { min: a, max: b }));
    SERIES.forEach((_, k) => ponerCifras(k));
    pistaNormal();
  }
  function restablecer() {
    if (!est.zoom) return;
    est.zoom = null;
    if (DATOS) graficos.forEach(g => g.setScale("x", { min: DATOS.t0, max: DATOS.t1 }));
    SERIES.forEach((_, k) => ponerCifras(k));
    pistaNormal();
  }

  function pista(html) { const p = $(".graf-pista", panel); if (p) p.innerHTML = html; }
  function pistaNormal() {
    if (!DATOS) return;
    const apagado = HUECOS.reduce((a, [x, y]) => a + Math.max(0, Math.min(y, DATOS.t1) - Math.max(x, DATOS.t0)), 0);
    const total = DATOS.t1 - DATOS.t0;
    const partes = [];
    if (est.zoom) partes.push(`Ampliado: ${horaMin(est.zoom[0] * 1000)} – ${horaMin(est.zoom[1] * 1000)}
      <button type="button" class="mini-boton" data-restablecer>Ver todo</button>`);
    else if (!movil()) partes.push("Pasa el ratón para ver los valores · arrastra en horizontal para ampliar");
    if (!DATOS.muestras) partes.push("apagado todo el tramo");
    else if (apagado > 120) partes.push(`<span class="leyenda-hueco"></span> apagado ${apagado >= 5400 ? `${(apagado / 3600).toFixed(1).replace(".", ",")} h` : `${Math.round(apagado / 60)} min`} de ${Math.round(total / 3600)} h`);
    if (DATOS.grueso) partes.push("poco detalle: de ese día solo hay un punto cada pocas horas");
    pista(partes.join(" · "));
  }

  /* ---------------- calendario: una fila por máquina, una casilla por día ---------------- */
  async function traerCalendario() {
    try {
      const r = await fetch("/api/calendario", { credentials: "same-origin" });
      if (r.ok) CAL = await r.json();
    } catch { /* se ve vacío */ }
  }

  const LEYENDA = `<span class="cal-leyenda">0 h <i class="cal-escala"></i> 24 h <i class="cal-muestra-aprox"></i> estimado</span>`;
  const SELECTOR_CAL = () => `<div class="seg" data-grupo="cal">
      <button type="button" data-cal="mes" class="${est.cal === "mes" ? "activo" : ""}">Mes</button><button
        type="button" data-cal="anio" class="${est.cal === "anio" ? "activo" : ""}">Año</button></div>`;
  const celda = (n, nombre, k, hoy, extra = "") => {
    const v = CAL?.nodos?.[n]?.[k], h = v?.horas || 0, futuro = k > hoy;
    const titulo = futuro ? "" : `${nombre} · ${diaLargo(k)}: ${h ? `${h.toLocaleString("es-ES")} h encendida${v?.aprox ? " (estimado)" : ""}` : "apagada o sin datos"}`;
    return [`<button type="button" class="cal-celda${extra}${h ? " on" : ""}${v?.aprox ? " aprox" : ""}${
      k === hoy ? " hoy" : ""}${k === est.dia && n === est.nodo ? " elegida" : ""}"
      style="--h:${Math.min(1, h / 24).toFixed(3)}" data-cal-nodo="${n}" data-cal-dia="${k}"
      ${futuro ? "disabled" : ""} title="${esc(titulo)}"></button>`, h];
  };

  async function pintarCalendario() {
    const caja = $(".calendario", panel);
    if (!caja) return;
    if (!CAL) { caja.innerHTML = `<p class="cargando">Cargando…</p>`; await traerCalendario(); }
    if (est.cal === "anio") return pintarAnio(caja);
    if (!est.mes) { const h = new Date(); est.mes = new Date(h.getFullYear(), h.getMonth(), 1); }
    const m = est.mes, hoy = hoyClave();
    const dias = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const claves = Array.from({ length: dias }, (_, i) => claveDia(new Date(m.getFullYear(), m.getMonth(), i + 1)));
    const finde = k => [0, 6].includes(deClave(k).getDay());
    const m_ = movil();
    // horas del mes por máquina (para la columna de totales o el resumen de abajo en el móvil)
    const totales = Object.fromEntries(MAQUINAS.map(([n]) => {
      let horas = 0, conDatos = 0;
      for (const k of claves) { const h = CAL?.nodos?.[n]?.[k]?.horas || 0; if (h) { horas += h; conDatos++; } }
      return [n, [horas, conDatos]];
    }));
    const celdaMes = (n, nombre, k) => {
      const v = CAL?.nodos?.[n]?.[k], h = v?.horas || 0, futuro = k > hoy;
      const titulo = futuro ? "" : `${nombre} · ${diaLargo(k)}: ${h ? `${h.toLocaleString("es-ES")} h encendida${v?.aprox ? " (estimado)" : ""}` : "apagada"}`;
      return `<button type="button" class="cal-celda${h ? " on" : ""}${v?.aprox ? " aprox" : ""}${finde(k) ? " finde" : ""}${
        k === hoy ? " hoy" : ""}${k === est.dia && n === est.nodo ? " elegida" : ""}"
        style="--h:${Math.min(1, h / 24).toFixed(3)}" data-cal-nodo="${n}" data-cal-dia="${k}"
        ${futuro ? "disabled" : ""} title="${esc(titulo)}"></button>`;
    };
    // en el móvil, el mes en dos tramos (1-16 y 17-fin) para que quepa sin desplazar
    const trozos = m_ ? [claves.slice(0, 16), claves.slice(16)] : [claves];
    const columnas = m_ ? 16 : dias;
    const tablas = trozos.map(tr => {
      const cab = tr.map(k => {
        const d = deClave(k);
        return `<span class="cal-cabdia${finde(k) ? " finde" : ""}${k === hoy ? " hoy" : ""}">
          <small>${"DLMXJVS"[d.getDay()]}</small>${d.getDate()}</span>`;
      }).join("");
      const filas = MAQUINAS.map(([n, nombre]) => {
        const [horas, conDatos] = totales[n];
        return `<div class="cal-fila${n === est.nodo ? " actual" : ""}">
          <span class="cal-nombre">${nombre}</span>${tr.map(k => celdaMes(n, nombre, k)).join("")}
          ${m_ ? "" : `<span class="cal-total">${horas ? `${Math.round(horas)} h · ${conDatos} d` : "—"}</span>`}</div>`;
      }).join("");
      return `<div class="cal-tabla" style="--dias:${columnas}">
        <div class="cal-fila cal-encabezado"><span></span>${cab}${m_ ? "" : "<span></span>"}</div>
        ${filas}
      </div>`;
    }).join("");
    const resumen = m_ ? `<p class="cal-resumen">${MAQUINAS.map(([n, nombre]) => {
      const [horas, conDatos] = totales[n];
      return `<span><b>${nombre}</b> ${horas ? `${Math.round(horas)} h · ${conDatos} d` : "—"}</span>`;
    }).join("")}</p>` : "";
    const nombreMes = m.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    const esteMes = m.getFullYear() === new Date().getFullYear() && m.getMonth() === new Date().getMonth();
    caja.innerHTML = `
      <div class="cal-cab">
        ${SELECTOR_CAL()}
        <button type="button" class="dia-flecha" data-mes="-1" title="Mes anterior">‹</button>
        <strong>${nombreMes}</strong>
        <button type="button" class="dia-flecha" data-mes="1" title="Mes siguiente"${esteMes ? " disabled" : ""}>›</button>
        ${LEYENDA}
      </div>
      ${tablas}${resumen}`;
  }

  /* Año: por máquina, una rejilla de semanas (columnas) × días (filas, de lunes a domingo) */
  function pintarAnio(caja) {
    const hoy = hoyClave(), anio = est.anio || new Date().getFullYear();
    const ene1 = new Date(anio, 0, 1), dic31 = new Date(anio, 11, 31);
    const inicio = new Date(ene1); inicio.setDate(1 - ((ene1.getDay() + 6) % 7));      // el lunes de la 1.ª semana
    const semanas = Math.ceil(((dic31 - inicio) / 86400000 + 1) / 7);
    // etiquetas de los meses sobre la semana en la que empieza cada uno
    const meses = Array.from({ length: 12 }, (_, i) => {
      const col = Math.floor((new Date(anio, i, 1) - inicio) / 86400000 / 7) + 1;
      return `<span style="grid-column:${col}">${new Date(anio, i, 1).toLocaleDateString("es-ES", { month: "short" })}</span>`;
    }).join("");
    const bloques = movil() ? anioMovil(anio, hoy) : MAQUINAS.map(([n, nombre]) => {
      let celdas = "", horas = 0, dias = 0;
      for (let i = 0; i < semanas * 7; i++) {
        const d = new Date(inicio); d.setDate(inicio.getDate() + i);
        if (d.getFullYear() !== anio) { celdas += `<span class="anio-vacia"></span>`; continue; }
        const [html, h] = celda(n, nombre, claveDia(d), hoy, " anio");
        if (h) { horas += h; dias++; }
        celdas += html;
      }
      return `<div class="anio-maquina${n === est.nodo ? " actual" : ""}">
        <div class="anio-titulo"><span class="cal-nombre">${nombre}</span>
          <span class="cal-total">${horas ? `${Math.round(horas).toLocaleString("es-ES")} h en ${dias} días` : "sin datos"}</span></div>
        <div class="anio-meses" style="--semanas:${semanas}">${meses}</div>
        <div class="anio-rejilla" style="--semanas:${semanas}">${celdas}</div>
      </div>`;
    }).join("");
    caja.innerHTML = `
      <div class="cal-cab">
        ${SELECTOR_CAL()}
        <button type="button" class="dia-flecha" data-anio="-1" title="Año anterior">‹</button>
        <strong>${anio}</strong>
        <button type="button" class="dia-flecha" data-anio="1" title="Año siguiente"${anio >= new Date().getFullYear() ? " disabled" : ""}>›</button>
        ${LEYENDA}
      </div>
      <div class="anio-tabla">${bloques}</div>`;
  }

  // Año en el móvil: por máquina, una fila por mes y una columna por día (1-31)
  function anioMovil(anio, hoy) {
    const numeros = Array.from({ length: 31 }, (_, i) => `<span>${[1, 5, 10, 15, 20, 25, 30].includes(i + 1) ? i + 1 : ""}</span>`).join("");
    return MAQUINAS.map(([n, nombre]) => {
      let filas = "", horas = 0, dias = 0;
      for (let mes = 0; mes < 12; mes++) {
        const nd = new Date(anio, mes + 1, 0).getDate();
        filas += `<span class="anio-mes">${new Date(anio, mes, 1).toLocaleDateString("es-ES", { month: "short" }).replace(".", "")}</span>`;
        for (let d = 1; d <= 31; d++) {
          if (d > nd) { filas += `<span class="anio-vacia"></span>`; continue; }
          const [html, h] = celda(n, nombre, claveDia(new Date(anio, mes, d)), hoy, " anio");
          if (h) { horas += h; dias++; }
          filas += html;
        }
      }
      return `<div class="anio-maquina movil${n === est.nodo ? " actual" : ""}">
        <div class="anio-titulo"><span class="cal-nombre">${nombre}</span>
          <span class="cal-total">${horas ? `${Math.round(horas).toLocaleString("es-ES")} h en ${dias} días` : "sin datos"}</span></div>
        <div class="anio-dias"><span></span>${numeros}${filas}</div>
      </div>`;
    }).join("");
  }

  /* ---------------- eventos ---------------- */
  panel.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.classList.contains("cerrar-tarjeta")) return cerrar();
    if (b.dataset.vista) return cambiarVista(b.dataset.vista);
    if (b.dataset.horas) { est.horas = +b.dataset.horas; est.zoom = null; pintarCabecera(); return cargar(); }
    if (b.dataset.diaPaso) return moverDia(+b.dataset.diaPaso);
    if (b.hasAttribute("data-ahora")) { est.dia = null; est.zoom = null; pintarCabecera(); return cargar(); }
    if (b.hasAttribute("data-restablecer")) return restablecer();
    if (b.dataset.mes) { est.mes = new Date(est.mes.getFullYear(), est.mes.getMonth() + +b.dataset.mes, 1); return pintarCalendario(); }
    if (b.dataset.cal) { est.cal = b.dataset.cal; return pintarCalendario(); }
    if (b.dataset.anio) { est.anio = (est.anio || new Date().getFullYear()) + +b.dataset.anio; return pintarCalendario(); }
    if (b.dataset.calDia) {
      const dia = b.dataset.calDia === hoyClave() ? null : b.dataset.calDia;      // hoy → "ahora"
      if (b.dataset.calNodo !== est.nodo) return abrir(b.dataset.calNodo, { dia, vista: "graficas" });
      est.dia = dia; est.zoom = null; return cambiarVista("graficas");
    }
  });

  // Las tarjetas de nodo abren este panel (el clúster sigue con el de panel.js)
  filaNodos.addEventListener("click", e => {
    const t = e.target.closest(".nodo");
    if (!t || e.target.closest(".energia")) return;
    if (t.dataset.nodo === "cluster") { cerrar(); return; }
    e.stopPropagation();
    if (est.nodo === t.dataset.nodo && !panel.hidden) cerrar(); else abrir(t.dataset.nodo, { dia: null });
  }, true);
  filaNodos.addEventListener("keydown", e => {
    const t = e.target.closest?.(".nodo");
    if (!t || t.dataset.nodo === "cluster" || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault(); e.stopPropagation(); t.click();
  }, true);
  document.addEventListener("keydown", e => {
    if (!est.nodo || panel.hidden) return;
    if (e.key === "Escape") cerrar();
    if (est.vista === "graficas" && !e.target.closest("input, textarea, select")) {
      if (e.key === "ArrowLeft") moverDia(-1);
      if (e.key === "ArrowRight" && est.dia) moverDia(1);
    }
  });

  // Ancho al cambiar la ventana; colores al cambiar de tema o de paleta
  let tRes, eraMovil = movil();
  new ResizeObserver(() => {
    clearTimeout(tRes);
    tRes = setTimeout(() => {
      if (movil() !== eraMovil) {                           // cruza el corte: cambia la distribución
        eraMovil = movil();
        if (!est.nodo) return;
        return est.vista === "graficas" ? dibujar() : pintarCalendario();
      }
      graficos.forEach((g, k) => {
        const caja = $(`.graf[data-serie="${SERIES[k].clave}"] .graf-lienzo`, panel);
        if (caja) g.setSize({ width: Math.max(120, Math.floor(caja.getBoundingClientRect().width)), height: alto(k) });
      });
    }, 80);
  }).observe(panel);
  new MutationObserver(() => { if (graficos.length) dibujar(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-tema", "data-paleta", "data-acento", "style"] });

  /* Tiempo real: cada 20 s se añade el valor actual al final y el eje avanza hasta "ahora".
     (Beszel guarda un punto cada 10-20 min en los rangos largos; así el final nunca se queda atrás.) */
  async function enVivo() {
    if (!est.nodo || est.vista !== "graficas" || est.dia || est.zoom || !DATOS || !graficos.length) return;
    let m;
    try {
      const r = await fetch("/api/metricas", { credentials: "same-origin" });
      m = (await r.json())?.[est.nodo];
    } catch { return; }
    if (!m || m.cpu == null || !DATOS || est.dia || est.zoom) return;
    const ahora = Date.now() / 1000;
    const ultimo = DATOS.xs.length ? DATOS.xs.at(-1) : null;
    if (ultimo != null && ahora - ultimo < 15) return;
    // si desde el último dato ha pasado mucho más de lo normal, es un hueco: no se une con una recta
    const limite = Math.max(DATOS.paso * 2.5, 180);
    if (ultimo != null && ahora - ultimo > limite) {
      DATOS.xs.push((ultimo + ahora) / 2); DATOS.cols.forEach(c => c.push(null));
      HUECOS = HUECOS.filter(([a]) => a < ultimo).concat([[ultimo, ahora - 20]]);
    } else {
      HUECOS = HUECOS.filter(([, b]) => ultimo == null || b <= ultimo + 1);
    }
    DATOS.xs.push(ahora);
    SERIES.forEach((s, k) => DATOS.cols[k].push(m[s.clave] ?? null));
    DATOS.t1 = ahora; DATOS.t0 = ahora - est.horas * 3600;
    graficos.forEach((g, k) => {
      g.setData([DATOS.xs, DATOS.cols[k]], false);
      g.setScale("x", { min: DATOS.t0, max: DATOS.t1 });
      const et = $(`.graf[data-serie="${SERIES[k].clave}"] [data-valor]`, panel);
      if (et && !et.classList.contains("cursor")) ponerCifras(k);
    });
  }
  setInterval(enVivo, 20000);
  setInterval(() => { if (est.nodo && est.vista === "graficas" && !est.dia && !est.zoom) cargar(); }, 300000);
  setInterval(() => { CAL = null; }, 600000);
})();
