/* ============================================================================
   Prueba de distribución (se sirve en /v/compacto/)
   Usa el panel.js de siempre; esto solo añade:
     - la barra de acceso rápido de la cabecera (nodos y apps),
     - secciones plegables que recuerdan cuáles dejaste abiertas,
     - la lista de pods del clúster en la sección Nodos,
     - la marca de la sección actual en la navegación.
   ========================================================================== */
(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const plural = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`;

  const raiz = document.documentElement, cab = $(".cabecera");
  const filaNodos = $("#fila-nodos"), rejillaApps = $("#apps .rejilla-apps");
  if (!cab || !filaNodos) return;

  /* ---------------- secciones plegables ---------------- */
  // Al entrar, todo plegado (a propósito: la vista inicial siempre limpia)
  const bloques = $$("details.bloque");
  for (const d of bloques) {
    d.open = false;
    d.addEventListener("toggle", () => {
      if (d.open) dispatchEvent(new Event("resize"));     // las gráficas recalculan su tamaño
      if (d.open && (d.dataset.bloque === "nodos" || d.dataset.bloque === "pods")) pintarPods();
      pedir();
    });
  }
  const abrir = id => { const d = $(`#${id} details.bloque`); if (d && !d.open) d.open = true; };

  // Los enlaces a secciones las abren (el "#centro" de los avisos lleva a Avisos)
  document.addEventListener("click", e => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const pedido = a.getAttribute("href").slice(1);
    const id = pedido === "centro" ? "avisos" : pedido;
    const destino = document.getElementById(id);
    if (!destino) return;
    e.preventDefault();
    abrir(id);
    if (e.detail > 0) a.blur();                             // con el ratón, sin anillo de foco
    irA(destino);
  });

  /* Lleva la sección justo al tope (donde se engancha su cabecera). Al abrirla, ella y las de
     encima pueden cambiar de alto mientras baja (gráficas, mapa, datos que llegan), así que al
     terminar se comprueba y se corrige; si no, se quedaba a medias y no se marcaba en la barra. */
  function irA(destino) {
    const tope = () => parseFloat(getComputedStyle(raiz).getPropertyValue("--tope-seccion")) || 0;
    const ir = () => scrollTo({ top: Math.max(0, destino.getBoundingClientRect().top + scrollY - tope()), behavior: "smooth" });
    let intentos = 0, t;
    const comprobar = () => {
      clearTimeout(t);
      const falta = destino.getBoundingClientRect().top - tope();
      const alFinal = innerHeight + scrollY >= raiz.scrollHeight - 4;
      if (Math.abs(falta) > 3 && !(falta > 0 && alFinal) && intentos++ < 3) esperar();
    };
    const esperar = () => {
      ir();
      if ("onscrollend" in window) addEventListener("scrollend", comprobar, { once: true });
      t = setTimeout(comprobar, 900);                       // por si el navegador no tiene scrollend
    };
    requestAnimationFrame(esperar);                         // tras abrirla: ya tiene su alto
  }

  /* ---------------- resúmenes en las cabeceras plegadas ---------------- */
  let PODS = null, PARADOS = [];
  const RESUMENES = {
    pods() {
      if (!PODS) return null;
      const propios = PODS.filter(p => !SISTEMA.has(p.namespace));
      const mal = propios.filter(p => estadoPod(p) === "rojo").length;
      const raros = propios.filter(p => estadoPod(p) === "ambar").length;
      return [mal ? "rojo" : raros || PARADOS.length ? "ambar" : "verde", plural(propios.length, "pod")];
    },
    // En las cabeceras de las secciones: un punto (el estado) y dos o tres palabras, todas iguales
    nodos() {
      const on = $('.nodo[data-nodo="cluster"] [data-campo="encendidas"]', filaNodos)?.textContent.match(/\d+\/\d+/)?.[0];
      if (!on) return null;
      const mal = PODS?.some(p => estadoPod(p) === "rojo");
      return [mal ? "ambar" : "verde", `${on} nodos`];
    },
    apps() {
      const p = rejillaApps ? $$("a.servicio .pie .punto", rejillaApps) : [];
      if (!p.length) return null;
      const ok = p.filter(x => x.classList.contains("verde")).length;
      return [ok === p.length ? "verde" : "ambar", `${ok}/${p.length} apps`];
    },
    avisos() {
      const li = $$("#lista-avisos li");
      if (!li.length || li[0].classList.contains("cargando")) return null;
      const c = li.filter(x => x.classList.contains("critico")).length;
      const a = li.filter(x => x.classList.contains("aviso")).length;
      return [c ? "rojo" : a ? "ambar" : "verde", plural(c + a, "aviso")];
    },
    red() {
      const punto = $("#punto-vpn")?.className || "";
      if (!punto || punto === "punto") return null;
      const caida = /rojo/.test(punto), rara = /ambar/.test(punto);
      return [caida ? "rojo" : rara ? "ambar" : "verde", caida ? "VPN caída" : "VPN activa"];
    },
    seguridad() {
      const punto = $("#punto-cs")?.className || "";
      if (!punto || punto === "punto") return null;
      if (/rojo/.test(punto)) return ["rojo", "Sin protección"];
      if (/ambar/.test(punto)) return ["ambar", "Observando"];
      return ["verde", "Protegido"];
    },
    almacenamiento() {
      const li = $$("#lista-discos li:not(.cargando)");
      if (!li.length) return null;
      const mal = $$("#lista-discos .estado.mal").length;
      return mal ? ["rojo", `${plural(mal, "disco")} mal`] : ["verde", "Discos OK"];
    },
  };
  function pintarResumenes() {
    for (const caja of $$("[data-resumen]")) {
      const r = RESUMENES[caja.dataset.resumen]?.();
      const html = r ? `<span class="punto ${r[0]}"></span>${esc(r[1])}` : "";
      if (caja.innerHTML !== html) caja.innerHTML = html;
    }
  }

  /* ---------------- barra de acceso rápido ---------------- */
  const CORTO = { "Clúster HPC": "Clúster" };
  const MOVIL = { "Pi-master": "Pi" };                 // nombre aún más corto en la barra del móvil
  let ultimo = "";
  function construirBarra() {
    const nodos = $$(".nodo:not([data-nodo=\"cluster\"])", filaNodos).map(t => {
      const nombre = $("h2", t)?.textContent.trim() || "";
      const punto = $(".tarjeta-cab .punto", t)?.className || "punto";
      // estado de la tarjeta entera (prueba): encendido / apagado, según el punto
      const tono = /verde/.test(punto) ? "encendido" : /rojo/.test(punto) ? "apagado" : "";
      const clases = ["bc-nodo", tono, t.classList.contains("seleccionada") && "seleccionada",
                      t.classList.contains("ocupada") && "ocupada"].filter(Boolean).join(" ");
      const boton = $(".energia", t) ? botonesNodo(t, "bc") : "";
      return `<div class="${clases}" data-nodo="${esc(t.dataset.nodo)}" data-encendido="${esc(t.dataset.encendido || "")}"
        role="button" tabindex="0" title="Ver ${esc(nombre)}">
        <span class="${esc(punto)}"></span><span class="bc-nombre"${MOVIL[nombre] ? ` data-corto="${esc(MOVIL[nombre])}"` : ""}>${esc(CORTO[nombre] || nombre)}</span>
        ${boton ? `<span class="bc-cuenta" data-cuenta="${esc(t.dataset.nodo)}"></span>` : ""}${boton}</div>`;
    }).join("");
    const apps = rejillaApps ? $$("a.servicio", rejillaApps).map(a => {
      const completo = $(".nombre", a)?.textContent || "";
      const fuera = a.target ? ` target="${esc(a.target)}" rel="noopener"` : "";
      return `<a class="bc-app" href="${esc(a.getAttribute("href"))}"${fuera} title="${esc(completo)}">
        <span class="icono-app">${$(".icono-app", a)?.innerHTML || ""}
          <span class="${esc($(".pie .punto", a)?.className || "punto")}"></span></span>
        <span class="bc-app-nombre">${esc(completo.replace(/\s*\(.*\)\s*$/, ""))}</span></a>`;
    }).join("") : "";
    const todo = nodos + "|" + apps;
    if (todo === ultimo) return;
    ultimo = todo;
    $("#bc-nodos").innerHTML = nodos;
    $("#bc-apps").innerHTML = apps;
    $("#bc-apps").hidden = !apps;
    pintarCuentas();
  }

  const barra = $(".barra-rapida");
  barra.addEventListener("click", e => {
    if (accionNodo(e)) return;
    const chip = e.target.closest(".bc-nodo");
    if (!chip) return;
    // abre la sección Nodos con las gráficas de ese nodo
    abrir("nodos");
    const tarjeta = $(`.nodo[data-nodo="${CSS.escape(chip.dataset.nodo)}"]`, filaNodos);
    if (tarjeta && !tarjeta.classList.contains("seleccionada")) tarjeta.click();
    setTimeout(() => ($(".graf-panel:not([hidden])") || $("#detalle-caja"))?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  });
  barra.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("bc-nodo")) { e.preventDefault(); e.target.click(); }
  });

  /* ---------------- el clúster, en una línea discreta ---------------- */
  // Los datos del clúster van en la cabecera del bloque desplegable "Clúster" (con los pods dentro)
  const tarjetaCluster = $('.nodo[data-nodo="cluster"]', filaNodos);
  function pintarLineaCluster() {
    const caja = $("#cl-datos");
    if (!tarjetaCluster || !caja) return;
    const v = c => $(`[data-campo="${c}"]`, tarjetaCluster)?.textContent.trim() || "—";
    const html = `<span>CPU ${esc(v("cpu"))}</span><span>RAM ${esc(v("ram"))}</span><span>${esc(v("encendidas"))}</span>`;
    if (caja.innerHTML !== html) caja.innerHTML = html;
  }

  /* ---------------- cuándo dormirá cada nodo (lo dice el controlador) ---------------- */
  let ENERGIA = null, desfase = 0;
  async function traerEnergia() {
    try {
      const r = await fetch("/api/energia", { credentials: "same-origin" });
      if (!r.ok) return;
      ENERGIA = await r.json();
      desfase = (ENERGIA.ahora || Date.now() / 1000) - Date.now() / 1000;   // por si los relojes no cuadran
    } catch { /* se reintenta */ }
    pintarEnergia();
    ultimo = "";            // la barra de arriba también (el candado depende de esto)
    construirBarra();
    pintarCuentas();
  }
  const reloj = seg => {
    seg = Math.max(0, Math.round(seg));
    const h = Math.floor(seg / 3600), m = Math.floor(seg % 3600 / 60), s = seg % 60;
    return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m}:${String(s).padStart(2, "0")}`;
  };
  function cuenta(nodo) {
    // → [clase, texto largo, texto corto, fracción que queda (0-1) o null, texto de la tarjeta]
    if (nodo === "pi-master") return ["", "La Pi no se apaga nunca: es el plano de control", "", null, "Siempre encendida"];
    if (!ENERGIA) return null;
    if (!ENERGIA.disponible) return ["aviso", "El controlador de energía no está informando", "", null, "Sin datos del controlador"];
    const e = ENERGIA.nodos?.[nodo];
    if (!e) return null;
    const ahora = Date.now() / 1000 + desfase;
    const queda = e.duerme_a != null ? e.duerme_a - ahora : null;
    const total = (ENERGIA.reposo_min || 15) * 60;
    const min = Math.max(1, Math.ceil(queda / 60));
    switch (e.estado) {
      case "dormido": {
        const no = ENERGIA.no_despertar?.[nodo];
        return no ? ["", `Dormido. Las conexiones automáticas no lo despiertan ahora: ${no}`, "", null, "Dormido · no se despierta solo"]
                  : ["", "Dormido: se despierta al usarlo", "", null, "Dormido"];
      }
      case "despertando": return ["", `Despertando${e.motivo ? `: ${e.motivo}` : ""}`, "…", null, "Despertando…"];
      case "apagando":    return ["", "Apagándose", "…", null, "Apagándose…"];
      case "retenido":    return ["aviso", `No se dormirá mientras siga así: ${e.motivo}`, "retenido", null, `Retenido · ${e.motivo}`];
      case "ocioso":      return ["", `Se dormirá en ${reloj(queda)} si sigue sin uso`, reloj(queda), Math.min(1, queda / total),
                                  `Se duerme en ${reloj(queda)}`];
      case "ocupado":     return ["", `En uso (${e.motivo}); se dormiría en unos ${min} min`, `~${min} min`, null,
                                  `En uso · ~${min} min`];
    }
    return ["", e.motivo || e.estado, "", null, e.motivo || e.estado];
  }
  function pintarCuentas() {
    for (const t of $$('.nodo:not([data-nodo="cluster"])', filaNodos)) {
      let barra = $(".barra-cuenta", t);
      if (!barra) { barra = document.createElement("span"); barra.className = "barra-cuenta"; barra.innerHTML = "<i></i>"; t.appendChild(barra); }
      const c = cuenta(t.dataset.nodo);
      barra.hidden = c?.[3] == null;
      if (c?.[3] != null) barra.firstChild.style.width = `${(c[3] * 100).toFixed(1)}%`;
    }
    for (const el of $$("[data-cuenta-larga]")) {
      const c = cuenta(el.dataset.cuentaLarga);
      const fila = el.closest(".energia-fila");
      el.textContent = c?.[1] || "…";
      fila?.classList.toggle("aviso", c?.[0] === "aviso");
      const barra = fila && $(".ef-barra i", fila);
      if (barra) { barra.parentElement.hidden = c?.[3] == null; if (c?.[3] != null) barra.style.width = `${(c[3] * 100).toFixed(1)}%`; }
    }
    for (const el of $$("[data-cuenta]")) {
      const c = cuenta(el.dataset.cuenta);
      el.textContent = c?.[2] || "";
      el.className = `bc-cuenta ${c?.[0] || ""}`;
      // la misma cuenta como barra fina en la ficha (en el móvil sustituye al texto)
      el.closest(".bc-nodo")?.style.setProperty("--queda", c?.[3] != null ? c[3].toFixed(3) : "0");
      el.title = c?.[1] || "";
    }
  }
  /* ---------------- candado (mantener encendido) y encendido/apagado en cada nodo ----------------
     Los mismos dos botones en la barra de arriba y en las tarjetas de la sección Nodos.
       candado abierto: se duerme solo cuando no se usa · cerrado: retenido (power-hold)
       encendido: el botón de siempre de panel.js, con su confirmación                           */
  const horaCorta = t => new Date(t * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  function estadoCandado(n) {
    const r = ENERGIA?.retenciones?.[n] || {};
    if (r.activo && r.por === "hpc-respaldo") return { cerrado: true, bloqueado: true, titulo: "Lo retiene la copia de seguridad en curso" };
    if (r.activo) return { cerrado: true, titulo: `Retenido ${r.hasta ? `hasta las ${horaCorta(r.hasta)}` : "hasta que lo sueltes"} · pulsa para soltar` };
    return { cerrado: false, titulo: "Se duerme solo cuando no se usa · pulsa para mantenerlo encendido" };
  }
  function botonesNodo(t, pre) {
    const n = t.dataset.nodo, c = estadoCandado(n), on = t.dataset.encendido === "si";
    const d = ENERGIA?.despertares?.[n];
    const extra = d ? ` · último despertar: ${d.motivo} (${horaCorta(d.cuando)})` : "";
    return `<span class="${pre}-botones">
      <button type="button" class="nodo-boton candado${c.cerrado ? " cerrado" : ""}" data-candado="${esc(n)}"
        ${c.bloqueado ? "disabled" : ""} title="${esc(c.titulo)}"><svg class="ico"><use href="#${c.cerrado ? "i-candado" : "i-candado-abierto"}"/></svg></button>
      <button type="button" class="nodo-boton energia-boton ${on ? "apagar" : "encender"}" data-energia-de="${esc(n)}"
        ${t.classList.contains("ocupada") ? "disabled" : ""} title="${esc((on ? "Apagar" : "Encender") + extra)}"><svg class="ico"><use href="#i-encender"/></svg></button>
    </span>`;
  }
  // Devuelve true si el clic era en uno de estos botones (y lo atiende)
  function accionNodo(e) {
    const b = e.target.closest(".nodo-boton");
    if (!b) return false;
    e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
    if (b.disabled) return true;
    if (b.dataset.energiaDe) {
      $(`.nodo[data-nodo="${CSS.escape(b.dataset.energiaDe)}"] .energia`, filaNodos)?.click();
      return true;
    }
    const n = b.dataset.candado, cerrado = b.classList.contains("cerrado");
    $$(`.nodo-boton[data-candado="${CSS.escape(n)}"]`).forEach(x => { x.disabled = true; });
    fetch(cerrado ? `/api/soltar/${n}` : `/api/retener/${n}?horas=0`, { method: "POST", credentials: "same-origin" })
      .catch(() => {}).finally(traerEnergia);
    return true;
  }
  // En las tarjetas de la sección Nodos: los dos botones arriba a la derecha
  function pintarEnergia() {
    for (const t of $$('.nodo[data-nodo="faraday"], .nodo[data-nodo="mustang"]', filaNodos)) {
      const cab = $(".tarjeta-cab", t);
      if (!cab) continue;
      const html = botonesNodo(t, "tn");
      if (cab._botones !== html) {
        cab._botones = html;
        $(".tn-botones", cab)?.remove();
        cab.insertAdjacentHTML("beforeend", html);
      }
    }
  }
  filaNodos.addEventListener("click", accionNodo, true);   // antes que abrir las gráficas de la tarjeta

  traerEnergia();
  setInterval(traerEnergia, 15000);
  setInterval(pintarCuentas, 1000);

  /* ---------------- pods del clúster ---------------- */
  const SISTEMA = new Set(["kube-system", "kube-public", "kube-node-lease"]);
  const ORDEN = ["pi-master", "faraday", "mustang"];
  const NOMBRES = { "pi-master": "Pi-master", faraday: "Faraday", mustang: "Mustang" };
  function estadoPod(p) {
    if (/BackOff|Err|Fail|Invalid/i.test(p.estado)) return "rojo";
    if (p.estado === "Succeeded" || p.estado === "Completed" || p.estado === "Parado") return "gris";
    if (p.estado === "Running" && p.listos === p.contenedores) return "verde";
    return "ambar";
  }
  const corto = n => n.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{5}$/, "");
  function edad(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!iso || !isFinite(s)) return "—";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} d`;
  }
  async function pintarPods() {
    const caja = $("#lista-pods");
    if (!caja) return;
    try {
      const r = await fetch("/api/pods", { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status);
      const datos = await r.json();
      PODS = datos.pods || [];
      PARADOS = datos.parados || [];
    } catch {
      if (!PODS) caja.innerHTML = `<p class="cargando">No se puede consultar Kubernetes ahora.</p>`;
      return;
    }
    const sistema = $("#pods-sistema")?.checked;
    const lista = PODS.filter(p => sistema || !SISTEMA.has(p.namespace));
    $("#pods-total").textContent = `${lista.length}${sistema ? "" : ` · ${PODS.length - lista.length} de sistema ocultos`}`;
    const grupos = {};
    for (const n of ORDEN) grupos[n] = [];                 // los tres nodos siempre, aunque no tengan pods
    for (const p of lista) (grupos[p.nodo || "sin nodo"] ||= []).push(p);
    const deSistema = n => PODS.filter(p => p.nodo === n && SISTEMA.has(p.namespace)).length;
    const nodos = Object.keys(grupos).sort((a, b) => (ORDEN.indexOf(a) + 1 || 99) - (ORDEN.indexOf(b) + 1 || 99));
    const fila = (p, acciones) => {
      const e = estadoPod(p);
      return `<li class="${e}">
        <span class="pod-nombre" title="${esc(p.namespace)}/${esc(p.nombre)}"><span class="punto ${e}"></span>${esc(corto(p.nombre))}${
          e === "verde" ? "" : `<span class="pod-estado ${e}">${esc(p.estado)}</span>`}</span>
        <span class="pod-ns">${esc(p.namespace)}</span>
        <span class="pod-col">${esc(p.cpu ?? "—")}</span>
        <span class="pod-col">${esc(p.memoria ?? "—")}</span>
        <span class="pod-col${p.reinicios > 10 ? " muchos" : ""}">${p.reinicios ?? ""}</span>
        <span class="pod-col">${p.desde ? edad(p.desde) : ""}</span>
        <span class="pod-acciones">${acciones}</span>
      </li>`;
    };
    const cabecera = `<div class="pods-cabecera"><span>Servicio</span><span>Namespace</span><span>CPU</span>
      <span>Memoria</span><span>Reinicios</span><span>Desde hace</span><span></span></div>`;
    caja.innerHTML = cabecera + nodos.map(n => {
      const tarjeta = $(`.nodo[data-nodo="${CSS.escape(n)}"]`, filaNodos);
      const duerme = tarjeta?.dataset.encendido === "no";
      const vacio = n === "faraday" ? "sin pods propios · solo trabaja cuando lanzas un Job" : "sin pods propios";
      return `<div class="grupo-pods${duerme ? " dormido" : ""}">
        <h4><span class="${esc($(".tarjeta-cab .punto", tarjeta || document.createElement("i"))?.className || "punto")}"></span>
          ${esc(NOMBRES[n] || n)} <small>${grupos[n].length ? plural(grupos[n].length, "pod") : vacio}${
            !sistema && deSistema(n) ? ` · ${deSistema(n)} de sistema` : ""}${duerme ? " · dormido" : ""}</small></h4>
        ${grupos[n].length ? `<ul>${grupos[n].map(p => fila(p, p.carga ? botones(p.namespace, p.carga, ["reiniciar", "parar"]) : "")).join("")}</ul>` : ""}
      </div>`;
    }).join("") + (PARADOS.length ? `<div class="grupo-pods parados">
        <h4><span class="punto gris"></span>Parados <small>${plural(PARADOS.length, "servicio")} sin arrancar</small></h4>
        <ul>${PARADOS.map(c => fila({ namespace: c.namespace, nombre: c.nombre, estado: "Parado" , listos: 0, contenedores: 1 },
              botones(c.namespace, c, ["arrancar"])).replace('class="ambar"', 'class="gris"')).join("")}</ul></div>` : "");
    pintarResumenes();
  }
  $("#pods-sistema")?.addEventListener("change", pintarPods);

  /* ---------------- reiniciar, parar y arrancar servicios ----------------
     Primer toque: el botón pide confirmación. Segundo toque (en 4 s): se hace.   */
  const ACCIONES = {
    reiniciar: { icono: "i-reiniciar", texto: "Reiniciar", hecho: "reiniciando…" },
    parar:     { icono: "i-parar",     texto: "Parar",     hecho: "parando…" },
    arrancar:  { icono: "i-arrancar",  texto: "Arrancar",  hecho: "arrancando…" },
  };
  function botones(ns, carga, lista) {
    return lista.map(a => `<button type="button" class="accion-carga ${a}" data-accion="${a}" data-ns="${esc(ns)}"
      data-tipo="${esc(carga.tipo)}" data-nombre="${esc(carga.nombre)}" title="${ACCIONES[a].texto} ${esc(carga.nombre)}">
      <svg class="ico"><use href="#${ACCIONES[a].icono}"/></svg><span>¿${ACCIONES[a].texto.toLowerCase()}?</span></button>`).join("");
  }
  $("#lista-pods")?.addEventListener("click", async e => {
    const b = e.target.closest(".accion-carga");
    if (!b || b.disabled) return;
    if (!b.classList.contains("confirmar")) {
      $$(".accion-carga.confirmar").forEach(x => x.classList.remove("confirmar"));
      b.classList.add("confirmar");
      clearTimeout(b._t);
      b._t = setTimeout(() => b.classList.remove("confirmar"), 4000);
      return;
    }
    clearTimeout(b._t);
    const { accion, ns, tipo, nombre } = b.dataset;
    b.disabled = true;
    b.classList.remove("confirmar");
    b.classList.add("trabajando");
    b.lastElementChild.textContent = ACCIONES[accion].hecho;
    try {
      const q = new URLSearchParams({ ns, tipo, nombre });
      const r = await fetch(`/api/carga/${accion}?${q}`, { method: "POST", credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status);
    } catch {
      b.classList.replace("trabajando", "fallo");
      b.lastElementChild.textContent = "no se pudo";
      setTimeout(pintarPods, 4000);
      return;
    }
    setTimeout(pintarPods, 1500);
    setTimeout(pintarPods, 8000);
  });
  pintarPods();
  setInterval(() => { if ($("#nodos details.bloque")?.open || !PODS) pintarPods(); }, 30000);

  /* ---------------- sección actual en la navegación ---------------- */
  const enlaces = $$(".navegacion a");
  const secciones = enlaces.map(a => document.getElementById(a.dataset.seccion)).filter(Boolean);
  /* Cabeceras de sección enganchadas: con una sección abierta, al bajar su cabecera se queda
     arriba (bajo la cabecera fija en el ordenador; arriba del todo en el móvil, donde la cabecera
     se va con el scroll) en versión reducida, y su contenido pasa por debajo. */
  // Hueco entre la barra de arriba y la cabecera enganchada (el espaciado de siempre). Se mide
  // una vez: es la distancia natural entre la barra y la primera sección, con tope de 10 px.
  let hueco = null;
  // Capa fija que tapa lo que sube por encima del tope. Lleva una copia del fondo de la página
  // (incluidas las manchas animadas de las paletas), así la barra de arriba y la cabecera
  // enganchada, que son de vidrio, se ven sobre el mismo fondo que el resto de tarjetas.
  const tapa = document.createElement("div");
  tapa.className = "tapa"; tapa.setAttribute("aria-hidden", "true");
  const manchas = document.querySelector(".manchas");
  if (manchas) tapa.appendChild(manchas.cloneNode(true));
  document.body.appendChild(tapa);
  let topePrevio = -1;
  function colocar() {
    const borde = cab.getBoundingClientRect().bottom;
    if (hueco === null && scrollY < 2 && bloques[0])
      hueco = Math.max(0, Math.min(10, Math.round(bloques[0].getBoundingClientRect().top - borde)));
    // La franja de arriba (hasta el tope) la tapa una capa fija con el fondo de la página,
    // por encima del contenido y por debajo de la barra. Solo cambia si cambia la barra, nunca
    // en cada paso del scroll: así no hay fotogramas de retraso y no se ve nada por encima.
    const tope = Math.round(borde) + (hueco ?? 8);
    if (tope !== topePrevio) {
      topePrevio = tope;
      raiz.style.setProperty("--tope-seccion", `${tope}px`);
      raiz.style.scrollPaddingTop = `${tope + 54}px`;
    }
    for (const d of bloques) {
      if (d.classList.contains("sub-bloque")) continue;
      const sum = d.firstElementChild;
      if (!sum) continue;
      const r = d.getBoundingClientRect(), ya = sum.classList.contains("pegado");
      // con margen distinto para entrar y para salir: así no oscila en los bordes
      const pegada = d.open && r.top < tope - 1 && r.bottom > tope + (ya ? 2 : 40);
      if (ya !== pegada) {
        sum.classList.toggle("pegado", pegada);
        if (pegada) raiz.style.setProperty("--alto-pegado", `${Math.round(sum.offsetHeight)}px`);
      }
      // Al final del bloque la cabecera ya va empujada hacia arriba: es lo último que queda de la
      // tarjeta, así que toma también sus esquinas redondeadas de abajo.
      // En cuanto lo que queda de tarjeta por debajo es menos que el radio de sus esquinas, la
      // cabecera pasa a ser el cierre: esquinas redondeadas abajo, y ese resto se tapa.
      const radio = parseFloat(getComputedStyle(raiz).getPropertyValue("--radio")) || 14;
      const final = pegada && r.bottom - sum.getBoundingClientRect().bottom < radio + 2;
      if (sum.classList.contains("final") !== final) sum.classList.toggle("final", final);
    }
    let activa = secciones[0];
    for (const s of secciones) if (s.getBoundingClientRect().top <= borde + 40) activa = s;
    const alFinal = innerHeight + scrollY >= raiz.scrollHeight - 4;
    const ultima = secciones.at(-1);
    if (alFinal && scrollY > 0 && ultima && ultima.getBoundingClientRect().top < innerHeight) activa = ultima;
    if (activa) enlaces.forEach(a => a.classList.toggle("activo", a.dataset.seccion === activa.id));
  }
  let pendiente = false;
  function pedir() {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => { pendiente = false; colocar(); });
  }
  addEventListener("scroll", pedir, { passive: true });
  addEventListener("resize", pedir);
  new ResizeObserver(pedir).observe(cab);

  // Se reconstruye cuando panel.js actualiza las tarjetas
  let pendienteBarra = false;
  const alCambiar = () => {
    if (pendienteBarra) return;
    pendienteBarra = true;
    requestAnimationFrame(() => { pendienteBarra = false; construirBarra(); pintarLineaCluster(); pintarEnergia(); pintarResumenes(); });
  };
  const mo = new MutationObserver(alCambiar);
  const opciones = { subtree: true, childList: true, characterData: true, attributes: true,
                     attributeFilter: ["class", "data-encendido"] };
  for (const el of [filaNodos, rejillaApps, $("#lista-avisos"), $("#lista-discos")]) if (el) mo.observe(el, opciones);

  construirBarra(); pintarLineaCluster(); pintarResumenes(); colocar();
})();
