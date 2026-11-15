/* ===========================================================
   Panel HPC
     · Reloj, tiempo, tema claro/oscuro y fondo
     · Estado de los nodos, métricas en vivo (Beszel) y discos
     · Panel de detalle con gráficas tipo trading (arrastre y ejes)
     · Acciones: encender/apagar nodos y apagado programado del clúster
     · Servicios bajo demanda y accesos rápidos
   =========================================================== */

const CIUDAD = { nombre: "@@CIUDAD_NOMBRE@@", lat: @@CIUDAD_LAT@@, lon: @@CIUDAD_LON@@ };   // config/local.env
const REFRESCO_MS = 30000;      // métricas, servicios y enlaces
const REFRESCO_NODOS_MS = 8000; // estado de los nodos (ping)

/* ------------------------- utilidades ------------------------- */
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const fmt = v => (v == null ? "—" : (Math.abs(v) >= 100 ? Math.round(v) : Number(v).toFixed(1)));

/* ------------- confirmaciones y avisos con el estilo del panel -------------
   preguntar(...) -> Promise<boolean>   ·   avisar(...) -> Promise<void>
   Sustituyen a confirm() y alert(), que el navegador dibuja a su manera.     */
function dialogoPregunta({ titulo, texto = "", aceptar = "Aceptar", cancelar = "Cancelar",
                           peligro = false, soloAviso = false, icono = null }) {
  const dlg = $("#dialogo-pregunta");
  if (!dlg) return Promise.resolve(soloAviso ? undefined : window.confirm(titulo));
  dlg.classList.toggle("peligro", peligro);
  dlg.classList.toggle("solo-aviso", soloAviso);
  $("#pregunta-titulo").textContent = titulo;
  $("#pregunta-texto").innerHTML = texto;
  $("#pregunta-texto").style.display = texto ? "" : "none";
  $("#pregunta-aceptar").textContent = aceptar;
  $("#pregunta-cancelar").textContent = cancelar;
  $("#pregunta-icono").innerHTML =
    `<svg class="ico"><use href="#${icono || (peligro ? "i-apagar" : soloAviso ? "i-app" : "i-encender")}"/></svg>`;

  return new Promise(resolver => {
    const terminar = valor => { dlg.close(); resolver(valor); };
    $("#pregunta-aceptar").onclick = () => terminar(soloAviso ? undefined : true);
    $("#pregunta-cancelar").onclick = () => terminar(false);
    dlg.onclick = e => { if (e.target === dlg) terminar(soloAviso ? undefined : false); };
    dlg.oncancel = e => { e.preventDefault(); terminar(soloAviso ? undefined : false); };  // tecla Escape
    dlg.showModal();
    $("#pregunta-aceptar").focus();
  });
}
const preguntar = (titulo, opciones = {}) => dialogoPregunta({ titulo, ...opciones });
const avisar = (titulo, texto = "") => dialogoPregunta({ titulo, texto, aceptar: "Entendido", soloAviso: true });

async function traer(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

/* --------------------------- reloj ---------------------------- */
function pintarReloj() {
  const ahora = new Date();
  $("#hora").textContent = ahora.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  $("#fecha").textContent = ahora.toLocaleDateString("es-ES",
    { weekday: "long", day: "numeric", month: "long" });
}

/* --------------------------- tiempo --------------------------- */
const ICONOS_TIEMPO = {          /* código de Open-Meteo -> icono del sprite */
  0: "i-sol", 1: "i-nubesol", 2: "i-nubesol", 3: "i-nube",
  45: "i-niebla", 48: "i-niebla",
  51: "i-lluvia", 53: "i-lluvia", 55: "i-lluvia",
  61: "i-lluvia", 63: "i-lluvia", 65: "i-lluvia",
  71: "i-nieve", 73: "i-nieve", 75: "i-nieve", 77: "i-nieve",
  80: "i-lluvia", 81: "i-lluvia", 82: "i-tormenta",
  85: "i-nieve", 86: "i-nieve", 95: "i-tormenta", 96: "i-tormenta", 99: "i-tormenta",
};

async function pintarTiempo() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${CIUDAD.lat}` +
                `&longitude=${CIUDAD.lon}&current=temperature_2m,weather_code&timezone=auto`;
    const d = await traer(url);
    $("#temp").textContent = `${Math.round(d.current.temperature_2m)}° ${CIUDAD.nombre}`;
    $(".icono-tiempo").innerHTML = `<use href="#${ICONOS_TIEMPO[d.current.weather_code] || "i-nube"}"/>`;
  } catch {
    $("#temp").textContent = CIUDAD.nombre;
  }
}

/* =========================== apariencia ===========================
   Todo el aspecto vive en un objeto de ajustes (AJ) que se guarda en el
   navegador y se traduce a variables CSS. Los temas son ajustes parciales
   que se mezclan sobre la base.                                            */

const ACENTOS = {
  azul: "#4f8cff", cian: "#2ec4d6", violeta: "#8b7cff", ambar: "#f0b429", grafito: "#9aa3b2",
};

const BASE = {
  modo: "oscuro",
  letra: "sans",                                   // sans (DM Sans) | serif (Pagella)
  paleta: null,                                    // clave de una paleta del escáner (paletas.js) o null
  preset: "grafito",                               // tema del panel elegido (null si se ha retocado)
  acento: "azul",
  acentoPropio: null,                              // "#rrggbb" si se elige uno a mano
  tarjeta: null,                                   // { color, opacidad, blur } o null = la del modo
  fondo: {
    tipo: "tema",                                  // tema | color | degradado | imagen
    color: "#0f1115",
    grad: { tipo: "lineal", angulo: 135, c1: "#1d2c52", c2: "#0f1115", c3: "#3a2152", usar3: false },
    img: null,
    oscurecer: 35,
  },
  radio: 10,
  anchoMax: 1440,
};

/* Temas del panel. Cada uno tiene versión oscura y clara: al cambiar de modo con
   un tema elegido se cambian también su fondo, tarjetas y acento. */
const PRESETS = [
  { clave: "grafito", nombre: "Grafito",
    oscuro: { muestra: "#15181d", ajustes: {} },
    claro:  { muestra: "#ededed", ajustes: {} } },
  { clave: "medianoche", nombre: "Medianoche",
    oscuro: { muestra: "#171333", ajustes: { acento: "violeta",
      fondo: { tipo: "degradado", grad: { tipo: "aurora", c1: "#3b2a8c", c2: "#0b0d17", c3: "#1e3a8a", usar3: true } } } },
    claro:  { muestra: "#e7e3f7", ajustes: { acento: "violeta",
      fondo: { tipo: "degradado", grad: { tipo: "aurora", c1: "#b9adf5", c2: "#eeecf7", c3: "#b4c8f2", usar3: true } } } } },
  { clave: "arena", nombre: "Arena",
    oscuro: { muestra: "#1b1814", ajustes: { acento: "ambar", fondo: { tipo: "color", color: "#1b1814" },
      tarjeta: { color: "#2a251e", opacidad: 72, blur: 18 } } },
    claro:  { muestra: "#efebe4", ajustes: { acento: "ambar", fondo: { tipo: "color", color: "#efebe4" } } } },
  { clave: "hielo", nombre: "Hielo",
    oscuro: { muestra: "#0d1a20", ajustes: { acento: "cian",
      fondo: { tipo: "degradado", grad: { tipo: "radial", c1: "#16404b", c2: "#0b1418", usar3: false } } } },
    claro:  { muestra: "#e3eef2", ajustes: { acento: "cian",
      fondo: { tipo: "degradado", grad: { tipo: "radial", c1: "#d3eef3", c2: "#e9eef2", usar3: false } } } } },
  { clave: "minimo", nombre: "Mínimo",
    oscuro: { muestra: "#0c0c0d", ajustes: { acento: "grafito", fondo: { tipo: "color", color: "#0c0c0d" },
      tarjeta: { color: "#19191b", opacidad: 92, blur: 0 } } },
    claro:  { muestra: "#f3f3f1", ajustes: { acentoPropio: "#5d6573", fondo: { tipo: "color", color: "#f3f3f1" },
      tarjeta: { color: "#ffffff", opacidad: 94, blur: 0 } } } },
];
const PRESET_POR_CLAVE = Object.fromEntries(PRESETS.map(p => [p.clave, p]));

// Colores de un tema en un modo (lo que cambia al pasar de claro a oscuro)
function coloresPreset(clave, modo) {
  const v = mezclar(BASE, PRESET_POR_CLAVE[clave][modo].ajustes);
  return { modo, acento: v.acento, acentoPropio: v.acentoPropio, tarjeta: v.tarjeta, fondo: v.fondo };
}

const clonar = o => JSON.parse(JSON.stringify(o));
function mezclar(base, cambios) {
  const r = clonar(base);
  for (const [k, v] of Object.entries(cambios || {})) {
    r[k] = (v && typeof v === "object" && !Array.isArray(v) && r[k] && typeof r[k] === "object")
      ? mezclar(r[k], v) : clonar(v);
  }
  return r;
}

const hexARgb = h => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

let AJ = clonar(BASE);

function cargarAjustes() {
  try {
    const guardado = JSON.parse(localStorage.getItem("apariencia"));
    if (guardado) return mezclar(BASE, guardado);
  } catch {}
  // primera vez con este sistema: se respetan modo y acento de la versión anterior
  const viejo = mezclar(BASE, {});
  if (localStorage.getItem("tema")) viejo.modo = localStorage.getItem("tema");
  if (ACENTOS[localStorage.getItem("acento")]) viejo.acento = localStorage.getItem("acento");
  else if (!localStorage.getItem("tema") && matchMedia("(prefers-color-scheme: light)").matches) viejo.modo = "claro";
  return viejo;
}

function guardarAjustes() {
  try { localStorage.setItem("apariencia", JSON.stringify(AJ)); }
  catch { avisar("No se pudo guardar", "La imagen de fondo es demasiado grande para el navegador."); }
}

function degradadoCSS(g) {
  const medio = g.usar3 ? `, ${g.c3}` : "";
  if (g.tipo === "radial") return `radial-gradient(circle at 30% 20%, ${g.c1}${medio}, ${g.c2})`;
  if (g.tipo === "aurora") {
    const segundo = g.usar3 ? g.c3 : g.c1;
    return [
      `radial-gradient(60% 55% at 12% 8%, ${g.c1}cc, transparent 70%)`,
      `radial-gradient(50% 50% at 88% 18%, ${segundo}aa, transparent 70%)`,
      `radial-gradient(70% 60% at 50% 115%, ${g.c1}77, transparent 70%)`,
    ].join(", ");
  }
  return `linear-gradient(${g.angulo}deg, ${g.c1}${medio}, ${g.c2})`;
}

function aplicarAjustes() {
  const raiz = document.documentElement, st = raiz.style;

  raiz.dataset.tema = AJ.modo;
  // botón de modo: luna en oscuro, sol en claro
  document.querySelector("#btn-tema use")?.setAttribute("href", AJ.modo === "claro" ? "#i-sol" : "#i-tema");
  raiz.dataset.letra = AJ.letra === "serif" ? "serif" : "sans";
  const paleta = AJ.paleta && PALETA_POR_CLAVE[AJ.paleta] ? AJ.paleta : null;
  if (paleta) raiz.dataset.paleta = paleta; else delete raiz.dataset.paleta;
  raiz.dataset.fondo = AJ.fondo.tipo;

  // acento
  if (AJ.acentoPropio) {
    raiz.dataset.acento = "propio";
    st.setProperty("--acento", AJ.acentoPropio);
    st.setProperty("--acento-rgb", hexARgb(AJ.acentoPropio).join(","));
  } else {
    raiz.dataset.acento = (paleta && AJ.acento === "paleta") ? "paleta" : (ACENTOS[AJ.acento] ? AJ.acento : "azul");
    st.removeProperty("--acento"); st.removeProperty("--acento-rgb");
    // las paletas dan el acento en hsl: se pasa a r,g,b para los rgba(var(--acento-rgb), …)
    if (raiz.dataset.acento === "paleta") st.setProperty("--acento-rgb", colorComputado("var(--acento)").join(","));
  }

  // tarjetas
  if (AJ.tarjeta) {
    st.setProperty("--superficie", `rgba(${hexARgb(AJ.tarjeta.color).join(",")}, ${AJ.tarjeta.opacidad / 100})`);
    st.setProperty("--desenfoque", `${AJ.tarjeta.blur}px`);
  } else {
    st.removeProperty("--superficie"); st.removeProperty("--desenfoque");
  }

  // fondo
  const f = AJ.fondo;
  if (f.tipo === "tema") {
    st.removeProperty("--fondo"); st.removeProperty("--fondo-img");
  } else if (f.tipo === "color") {
    st.setProperty("--fondo", f.color); st.setProperty("--fondo-img", "none");
  } else if (f.tipo === "degradado") {
    st.setProperty("--fondo", f.grad.c2); st.setProperty("--fondo-img", degradadoCSS(f.grad));
  } else if (f.tipo === "imagen" && f.img) {
    const o = f.oscurecer / 100;
    st.setProperty("--fondo", "#000");
    st.setProperty("--fondo-img", `linear-gradient(rgba(0,0,0,${o}), rgba(0,0,0,${o})), url(${f.img})`);
  }

  // forma y tamaño
  st.setProperty("--radio", `${AJ.radio}px`);
  st.setProperty("--radio-s", `${Math.round(AJ.radio * 0.7)}px`);
  st.setProperty("--ancho-max", AJ.anchoMax ? `${AJ.anchoMax}px` : "100000px");

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = `rgb(${colorComputado("var(--fondo)").join(",")})`;
}

/* Color CSS cualquiera (hsl, var…) → [r, g, b], leyéndolo del navegador */
function colorComputado(css) {
  let sonda = document.getElementById("sonda-color");
  if (!sonda) {
    sonda = document.createElement("span"); sonda.id = "sonda-color"; sonda.hidden = true;
    document.body.appendChild(sonda);
  }
  sonda.style.color = ""; sonda.style.color = css;
  const m = getComputedStyle(sonda).color.match(/[\d.]+/g) || [0, 0, 0];
  return m.slice(0, 3).map(n => Math.round(+n));
}

function cambiar(fn) { fn(AJ); aplicarAjustes(); guardarAjustes(); pintarControles(); pintarPresets(); }

function ponerModo(modo) {
  cambiar(a => {
    if (a.preset && PRESET_POR_CLAVE[a.preset] && !a.paleta) Object.assign(a, coloresPreset(a.preset, modo));
    a.modo = modo;
  });
}
function alternarTema() { ponerModo(AJ.modo === "oscuro" ? "claro" : "oscuro"); }
// Retocar colores a mano deja de seguir al tema (el modo ya no cambia su fondo)
const cambiarColor = fn => cambiar(a => { fn(a); a.preset = null; });

/* ---------------- paletas del escáner (paletas.js) ---------------- */
const PALETA_POR_CLAVE = Object.fromEntries((typeof PALETAS_ESCANER !== "undefined" ? PALETAS_ESCANER : []).map(p => [p.clave, p]));
if (typeof PALETAS_ESCANER === "undefined") window.PALETAS_ESCANER = [];

// Muestra para la galería: las tres primeras manchas sobre el fondo, en el modo actual
function muestraPaleta(clave, soloAcento = false) {
  const p = PALETA_POR_CLAVE[clave];
  if (!p) return soloAcento ? "#4f8cff" : "#15181d";
  const m = p[AJ.modo] || p.oscuro;
  if (soloAcento) return m.acento;
  return `radial-gradient(circle at 20% 25%, ${m["blob-1"]} 0 30%, transparent 55%),` +
         `radial-gradient(circle at 80% 75%, ${m["blob-3"]} 0 30%, transparent 55%), ${m["blob-2"]}`;
}

// Al elegir una paleta se conserva el modo (claro/oscuro) que hubiera
function ajustesPaleta(clave) {
  const sobrio = clave === "sobrio";
  return { modo: AJ.modo, paleta: clave, preset: null, acento: "paleta", letra: sobrio ? "serif" : "sans", radio: sobrio ? 8 : 14 };
}

/* ------------------ temas guardados por el usuario ------------------ */
const temasPropios = () => { try { return JSON.parse(localStorage.getItem("temasPropios")) || []; } catch { return []; } };
const guardarTemasPropios = l => localStorage.setItem("temasPropios", JSON.stringify(l));

function pintarPresets() {
  const caja = $("#presets");
  if (!caja) return;
  const propios = temasPropios();
  const boton = (nombre, muestra, acento, attrs, borrable) =>
    `<button class="preset" ${attrs}>
       <span class="muestra" style="background:${muestra};box-shadow:inset -8px 0 0 ${acento}"></span>
       ${nombre}${borrable ? '<span class="borrar" title="Borrar">×</span>' : ""}</button>`;
  const grupo = t => `<span class="presets-grupo">${t}</span>`;
  caja.innerHTML =
    grupo("Panel HPC") +
    PRESETS.map((p, i) => {
      const v = p[AJ.modo] || p.oscuro;
      return boton(p.nombre, v.muestra, v.ajustes.acentoPropio || ACENTOS[v.ajustes.acento || "azul"], `data-preset="${i}"`, false);
    }).join("") +
    grupo("Escáner de tiquets") +
    PALETAS_ESCANER.map(p => boton(p.nombre, muestraPaleta(p.clave), muestraPaleta(p.clave, true),
      `data-paleta="${p.clave}"`, false)).join("") +
    (propios.length ? grupo("Mis temas") : "") +
    propios.map((p, i) => {
      const a = p.ajustes;
      const muestra = a.paleta ? muestraPaleta(a.paleta)
        : a.fondo?.tipo === "color" ? a.fondo.color : (a.modo === "claro" ? "#ededed" : "#15181d");
      const acento = a.acentoPropio || ACENTOS[a.acento] || (a.paleta ? muestraPaleta(a.paleta, true) : "#4f8cff");
      return boton(p.nombre, muestra, acento, `data-propio="${i}"`, true);
    }).join("");

  $$(".preset[data-paleta]", caja).forEach(b => {
    b.classList.toggle("activo", AJ.paleta === b.dataset.paleta);
    b.onclick = () => { AJ = mezclar(BASE, ajustesPaleta(b.dataset.paleta)); cambiar(() => {}); };
  });
  $$(".preset[data-preset]", caja).forEach(b => {
    const p = PRESETS[+b.dataset.preset];
    b.classList.toggle("activo", !AJ.paleta && AJ.preset === p.clave);
    // se conserva el modo actual; el tema pone su versión clara u oscura
    b.onclick = () => { AJ = mezclar(BASE, { ...coloresPreset(p.clave, AJ.modo), preset: p.clave }); cambiar(() => {}); };
  });
  $$(".preset[data-propio]", caja).forEach(b => b.onclick = async e => {
    const lista = temasPropios(), i = +b.dataset.propio;
    if (e.target.classList.contains("borrar")) {
      if (await preguntar(`¿Borrar el tema "${lista[i].nombre}"?`, { aceptar: "Borrar", peligro: true }))
        { lista.splice(i, 1); guardarTemasPropios(lista); pintarPresets(); }
      return;
    }
    AJ = mezclar(BASE, lista[i].ajustes); cambiar(() => {});
  });
}

/* --------------- controles del panel: se leen de AJ --------------- */
function pintarControles() {
  const seg = (id, valor) => $$(`#${id} button`).forEach(b => b.classList.toggle("activo", b.dataset.valor === valor));
  const val = (id, v) => { const el = $(`#${id}`); if (el && el.value !== String(v)) el.value = v; };
  const salida = (id, texto) => { const o = $(`#${id}`)?.parentElement.querySelector("output"); if (o) o.textContent = texto; };

  seg("ctl-modo", AJ.modo);
  seg("ctl-letra", AJ.letra);
  $$(".acento-op[data-acento]").forEach(b =>
    b.classList.toggle("activo", !AJ.acentoPropio && b.dataset.acento === AJ.acento));
  $(".acento-op.propio")?.classList.toggle("activo", !!AJ.acentoPropio);

  const t = AJ.tarjeta || { color: AJ.modo === "claro" ? "#ffffff" : "#1a1d23", opacidad: AJ.modo === "claro" ? 72 : 62, blur: 18 };
  val("ctl-tarjeta-color", t.color);
  val("ctl-tarjeta-opacidad", t.opacidad); salida("ctl-tarjeta-opacidad", `${t.opacidad}%`);
  val("ctl-tarjeta-blur", t.blur);         salida("ctl-tarjeta-blur", `${t.blur}px`);

  const f = AJ.fondo;
  seg("ctl-fondo-tipo", f.tipo);
  $$(".subgrupo[data-fondo]").forEach(g => g.classList.toggle("visible", g.dataset.fondo === f.tipo));
  val("ctl-fondo-color", f.color);
  seg("ctl-grad-tipo", f.grad.tipo);
  val("ctl-grad-angulo", f.grad.angulo); salida("ctl-grad-angulo", `${f.grad.angulo}°`);
  val("ctl-grad-c1", f.grad.c1); val("ctl-grad-c2", f.grad.c2); val("ctl-grad-c3", f.grad.c3);
  $("#ctl-grad-usar3").checked = f.grad.usar3;
  $("#ctl-grad-c3").style.opacity = f.grad.usar3 ? 1 : .35;
  $("#ctl-grad-angulo").closest(".control").style.display = f.grad.tipo === "lineal" ? "" : "none";
  const vista = $("#vista-grad");
  if (vista) { vista.style.backgroundColor = f.grad.c2; vista.style.backgroundImage = degradadoCSS(f.grad); }
  val("ctl-img-oscurecer", f.oscurecer); salida("ctl-img-oscurecer", `${f.oscurecer}%`);

  val("ctl-radio", AJ.radio); salida("ctl-radio", `${AJ.radio}px`);
  val("ctl-ancho", AJ.anchoMax);
}

/* Reduce la imagen antes de guardarla: el navegador solo admite unos MB */
function reducirImagen(fichero) {
  return new Promise((ok, mal) => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, 1920 / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * escala); c.height = Math.round(img.height * escala);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL("image/jpeg", 0.82));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = mal;
    img.src = URL.createObjectURL(fichero);
  });
}

function prepararApariencia() {
  // acentos: los fijos + uno a elegir
  $("#acentos").innerHTML =
    `<button class="acento-op" data-acento="paleta" title="El de la paleta"></button>` +
    Object.entries(ACENTOS).map(([n, c]) =>
      `<button class="acento-op" data-acento="${n}" title="${n}" style="background:${c}"></button>`).join("") +
    `<label class="acento-op propio" title="Elegir color"><input type="color" id="ctl-acento-propio"></label>`;
  $$(".acento-op[data-acento]").forEach(b => b.onclick = () => cambiarColor(a => { a.acento = b.dataset.acento; a.acentoPropio = null; }));
  $("#ctl-acento-propio").oninput = e => cambiarColor(a => { a.acentoPropio = e.target.value; });

  const segmento = (id, fn) => $$(`#${id} button`).forEach(b => b.onclick = () => cambiar(a => fn(a, b.dataset.valor)));
  $$("#ctl-modo button").forEach(b => b.onclick = () => ponerModo(b.dataset.valor));
  segmento("ctl-letra", (a, v) => { a.letra = v; });
  segmento("ctl-fondo-tipo", (a, v) => { a.fondo.tipo = v; a.preset = null; });
  segmento("ctl-grad-tipo", (a, v) => { a.fondo.grad.tipo = v; a.preset = null; });

  const tarjeta = a => a.tarjeta || (a.tarjeta = {
    color: a.modo === "claro" ? "#ffffff" : "#1a1d23", opacidad: a.modo === "claro" ? 72 : 62, blur: 18 });
  $("#ctl-tarjeta-color").oninput    = e => cambiarColor(a => { tarjeta(a).color = e.target.value; });
  $("#ctl-tarjeta-opacidad").oninput = e => cambiarColor(a => { tarjeta(a).opacidad = +e.target.value; });
  $("#ctl-tarjeta-blur").oninput     = e => cambiarColor(a => { tarjeta(a).blur = +e.target.value; });
  $("#ctl-tarjeta-reset").onclick    = () => cambiarColor(a => { a.tarjeta = null; });

  $("#ctl-fondo-color").oninput = e => cambiarColor(a => { a.fondo.color = e.target.value; });
  $("#ctl-grad-angulo").oninput = e => cambiarColor(a => { a.fondo.grad.angulo = +e.target.value; });
  ["c1", "c2", "c3"].forEach(k => $(`#ctl-grad-${k}`).oninput = e => cambiarColor(a => { a.fondo.grad[k] = e.target.value; }));
  $("#ctl-grad-usar3").onchange = e => cambiarColor(a => { a.fondo.grad.usar3 = e.target.checked; });
  $("#ctl-img-oscurecer").oninput = e => cambiarColor(a => { a.fondo.oscurecer = +e.target.value; });
  $("#img-fondo").onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const datos = await reducirImagen(f);             // se guarda en el navegador, no se sube a la Pi
      cambiarColor(a => { a.fondo.img = datos; a.fondo.tipo = "imagen"; });
    } catch { avisar("No se pudo leer esa imagen", "Prueba con otro fichero (JPG o PNG)."); }
  };

  $("#ctl-radio").oninput = e => cambiar(a => { a.radio = +e.target.value; });
  $("#ctl-ancho").onchange = e => cambiar(a => { a.anchoMax = +e.target.value; });

  $("#guardar-tema").onclick = () => {
    const nombre = $("#nombre-tema").value.trim();
    if (!nombre) { $("#nombre-tema").focus(); return; }
    const lista = temasPropios().filter(t => t.nombre !== nombre);
    lista.push({ nombre, ajustes: clonar(AJ) });
    try { guardarTemasPropios(lista); }
    catch { avisar("No cabe en el navegador", "Prueba con una imagen de fondo más pequeña."); return; }
    $("#nombre-tema").value = "";
    pintarPresets();
  };
  $("#restablecer-apariencia").onclick = async () => {
    if (await preguntar("¿Volver al aspecto por defecto?",
                        { texto: "Tus temas guardados se conservan.", aceptar: "Restablecer" })) {
      AJ = clonar(BASE); cambiar(() => {});
    }
  };

  pintarPresets();
  pintarControles();
}

/* ------------------- navegación entre secciones ------------------- */
function prepararNavegacion() {
  const enlaces = $$(".navegacion a");
  const marcar = id => enlaces.forEach(a => a.classList.toggle("activo", a.dataset.seccion === id));
  const obs = new IntersectionObserver(entradas => {
    // la sección que ocupa la franja superior de la pantalla es la activa
    for (const e of entradas) if (e.isIntersecting) marcar(e.target.id);
  }, { rootMargin: "-35% 0px -60% 0px" });
  $$(".seccion").forEach(sec => obs.observe(sec));
}

/* el área "fuera" del contenido es el propio <dialog>: si el clic cae ahí, se cierra */
function cerrarAlPulsarFuera(dlg) {
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
}

/* ------------------------ estado de nodos --------------------- */
let ESTADOS_NODOS = {};

async function pintarNodos() {
  try {
    const estados = await traer("/api/nodos");
    ESTADOS_NODOS = estados;
    for (const [nombre, estado] of Object.entries(estados)) {
      const tarjeta = $(`.nodo[data-nodo="${nombre}"]`);
      if (!tarjeta) continue;
      const punto = $(".punto[data-estado]", tarjeta);
      if (punto) punto.className = `punto ${estado === "despierto" ? "verde" : "rojo"}`;
      tarjeta.dataset.encendido = estado === "despierto" ? "si" : "no";
    }
    const pi = $('.nodo[data-nodo="pi-master"] .punto[data-estado]');
    if (pi && !pi.classList.contains("verde")) pi.className = "punto verde";
    const piTarjeta = $('.nodo[data-nodo="pi-master"]');
    if (piTarjeta) piTarjeta.dataset.encendido = "si";

    // en la tarjeta del clúster: cuántas máquinas hay encendidas (la Pi siempre)
    const total = Object.keys(estados).length + 1;
    const on = Object.values(estados).filter(e => e === "despierto").length + 1;
    const enc = $('.nodo[data-nodo="cluster"] .valor[data-campo="encendidas"]');
    if (enc) enc.textContent = `${on}/${total} encendidas`;

    sincronizarBotones();
    sincronizarEnergia();
    pintarEstadoGeneral();
  } catch { /* se reintenta en el siguiente ciclo */ }
}

/* --------------------------- discos --------------------------- */
async function pintarDiscos(metricas) {
  const lista = $("#lista-discos");
  if (!lista) return;
  if (!metricas || metricas.error) { lista.innerHTML = "<li>Sin datos de disco</li>"; return; }
  lista.innerHTML = "";
  for (const [maquina, m] of Object.entries(metricas)) {
    if (maquina === "cluster" || m.disco_pct == null) continue;
    const pct = Math.round(m.disco_pct);
    const clase = pct >= 90 ? "critica" : pct >= 75 ? "alta" : "";
    const li = document.createElement("li");
    li.style.flexDirection = "column"; li.style.alignItems = "stretch";
    li.innerHTML = `<div style="display:flex;justify-content:space-between">
        <span class="maquina">${nombreBonito(maquina)}</span>
        <span class="estado">${fmt(m.disco_usado)} / ${fmt(m.disco_total)} GB · ${pct}%</span>
      </div><div class="barra ${clase}"><span style="width:${pct}%"></span></div>`;
    lista.appendChild(li);
  }
  if (!lista.children.length) lista.innerHTML = "<li>Sin datos de disco</li>";
}

/* -------------------------- métricas -------------------------- */
let ULTIMAS_METRICAS = {};

async function pintarMetricas() {
  let d;
  try { d = await traer("/api/metricas"); } catch { return; }
  ULTIMAS_METRICAS = d;
  if (d.error) return;

  for (const tarjeta of $$(".nodo")) {
    const m = d[tarjeta.dataset.nodo];
    const pon = (campo, texto) => {
      const el = $(`.valor[data-campo="${campo}"]`, tarjeta);
      if (el) el.textContent = texto;
    };
    if (!m) { pon("cpu", "—"); pon("temp", "—"); pon("ram", "—"); continue; }
    pon("cpu", m.cpu != null ? `${m.cpu}%` : "—");
    pon("temp", m.temp != null ? `${m.temp}°C` : "—");
    pon("ram", (m.ram_usada != null && m.ram_total != null)
      ? `${fmt(m.ram_usada)}/${fmt(m.ram_total)} GB` : "—");
  }
  pintarDiscos(d);
}

/* ------------------- iconos de las aplicaciones ------------------- */
/* Se puede fijar con "icono:" en servicios.yaml; si no, se deduce del nombre */
const ICONOS_APPS = [
  [/foto|immich|imag/i, "i-fotos"],
  [/archivo|file|nas|nube/i, "i-carpeta"],
  [/auth|portal|passkey|sesi/i, "i-llave"],
  [/beszel|telemetr|métric|metric|grafan/i, "i-grafica"],
  [/reserva|casa/i, "i-casa"],
  [/tiquet|ticket|gasto/i, "i-tiquet"],
];
function iconoPara(obj) {
  if (obj.icono) return obj.icono.startsWith("i-") ? obj.icono : `i-${obj.icono}`;
  const texto = `${obj.nombre} ${obj.clave || ""} ${obj.url || ""}`;
  return (ICONOS_APPS.find(([re]) => re.test(texto)) || [null, "i-app"])[1];
}
const cabApp = obj => `<span class="cab-app"><span class="icono-app"><svg class="ico"><use href="#${iconoPara(obj)}"/></svg></span>
  <span class="nombre">${obj.nombre}</span></span>`;

/* ------------------- abrir la app nativa en el móvil -------------------
   En servicios.yaml, cada servicio o acceso puede llevar:
     app:
       android: "intent://open#Intent;scheme=immich;package=app.alextran.immich;end"
       ios: "immich://"
   En Android se añade solo la vuelta a la web si la app no está instalada.     */
const PLATAFORMA = /Android/i.test(navigator.userAgent) ? "android"
                 : /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "ios" : "escritorio";

function enlacePara(obj, web) {
  const nativo = obj.app?.[PLATAFORMA];
  if (!nativo) return { href: web, nativo: false };
  if (PLATAFORMA === "android" && nativo.startsWith("intent:") && !nativo.includes("browser_fallback_url")) {
    const absoluta = new URL(web, location.href).href;
    return { href: nativo.replace(/;end;?$/, `;S.browser_fallback_url=${encodeURIComponent(absoluta)};end`), nativo: true };
  }
  return { href: nativo, nativo: true };
}

/* -------------------------- servicios ------------------------- */
/* ---------------- aplicaciones propias (desplegadas con git push) ---------------- */
const euros = c => (c / 100).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const diaCorto = iso => new Date(iso + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short" });

/* Una línea legible con el dato propio de cada app */
function resumenApp(a) {
  const d = a.dato;
  if (!a.listo) return "no disponible";
  if (!d) return "en marcha";
  if (a.clave === "ticket-scanner")
    return d.mes_n ? `${d.mes_n} tiquet${d.mes_n === 1 ? "" : "s"} este mes · ${euros(d.mes_centimos)}`
                   : `sin tiquets este mes · ${d.total} en total`;
  if (typeof d.texto === "string") return d.texto;          // resumen ya hecho por la app (dato_cmd)
  return "en marcha";
}

let APPS_DATOS = [];

async function pintarApps() {
  try { APPS_DATOS = await traer("/api/apps"); } catch { return; }
  const fila = $("#fila-apps");
  if (fila) {
    fila.innerHTML = "";
    for (const a of APPS_DATOS) {
      const enlace = document.createElement("a");
      enlace.className = "tarjeta vidrio servicio app-propia";
      const destino = enlacePara(a, a.url);
      enlace.href = destino.href;
      if (!destino.nativo) { enlace.target = "_blank"; enlace.rel = "noopener"; }
      enlace.innerHTML = `${cabApp(a)}
        <span class="pie"><span class="nota">${resumenApp(a)}</span>
        <span class="punto ${a.listo ? "verde" : "rojo"}"></span></span>`;
      fila.appendChild(enlace);
    }
  }
  const lista = $("#lista-apps");
  if (lista) {
    lista.innerHTML = APPS_DATOS.length ? APPS_DATOS.map(a => {
      const d = a.despliegue || {};
      const fallo = d.ultimo_resultado === "FALLÓ";
      return `<li>
        <span class="nombre-app"><span class="punto ${a.listo ? "verde" : "rojo"}"></span>${a.nombre}</span>
        <span class="dato-app">${resumenApp(a)}</span>
        <span class="col-app"><small>versión</small>${d.version || "—"}</span>
        <span class="col-app"><small>desplegada</small>${d.fecha ? hace(d.fecha) : "—"}</span>
        <span class="col-app ${fallo ? "mal" : ""}"><small>último push</small>${fallo ? "falló " + hace(d.ultimo_intento) : (d.ultimo_resultado ? "OK" : "—")}</span>
        <span class="col-app"><small>reinicios</small>${a.reinicios}</span>
        <span class="col-app"><small>memoria</small>${a.memoria_mb != null ? a.memoria_mb + " MB" : "—"}</span>
      </li>`;
    }).join("") : `<li class="mas">Ninguna aplicación configurada (sección <code>apps:</code> de servicios.yaml)</li>`;
  }
}

async function pintarServicios() {
  const fila = $("#fila-servicios");
  if (!fila) return;
  try {
    const servicios = await traer("/api/servicios");
    fila.innerHTML = "";
    for (const s of servicios) {
      const a = document.createElement("a");
      a.className = "tarjeta vidrio servicio";
      const destino = enlacePara(s, `/abrir/${s.clave}`);
      a.href = destino.href;
      if (!destino.nativo) { a.target = "_blank"; a.rel = "noopener"; }
      a.innerHTML = `${cabApp(s)}
        <span class="pie"><span>${nombreBonito(s.nodo)}</span>
        <span class="punto ${s.listo ? "verde" : "rojo"}"></span></span>`;
      fila.appendChild(a);
    }
  } catch { /* se reintenta */ }
}

async function pintarEnlaces() {
  const fila = $("#fila-enlaces");
  if (!fila) return;
  try {
    const enlaces = await traer("/api/enlaces");
    fila.innerHTML = "";
    for (const e of enlaces) {
      const a = document.createElement("a");
      a.className = "tarjeta vidrio servicio enlace";
      const destino = enlacePara(e, e.url);
      a.href = destino.href;
      if (!destino.nativo) { a.target = "_blank"; a.rel = "noopener"; }
      a.innerHTML = `${cabApp(e)}
        <span class="pie"><span class="nota">${e.nota || ""}</span>
        <span class="punto ${e.activo ? "verde" : "rojo"}"></span></span>`;
      fila.appendChild(a);
    }
  } catch { /* se reintenta */ }
}

/* =================== gráficas (estilo trading) ===================
   Eje X = tiempo real del rango pedido; los tramos sin datos (nodo parado)
   se sombrean. Arrastrar dentro mueve; arrastrar un eje lo estira.         */

// rango: amplitud mínima del eje Y (para no convertir una centésima en un escalón)
// techo: límite natural de la magnitud (los porcentajes no pasan de 100 ni bajan de 0)
const SERIES = [
  { clave: "cpu",       titulo: "CPU",         unidad: "%",     rango: 10,  suelo: 0, techo: 100 },
  { clave: "temp",      titulo: "Temperatura", unidad: "°C",    rango: 6,   suelo: 0 },
  { clave: "ram_pct",   titulo: "RAM",         unidad: "%",     rango: 10,  suelo: 0, techo: 100 },
  { clave: "disco_pct", titulo: "Disco",       unidad: "%",     rango: 10,  suelo: 0, techo: 100 },
  { clave: "red",       titulo: "Red",         unidad: " KB/s", rango: 10,  suelo: 0 },
  { clave: "carga",     titulo: "Carga",       unidad: "",      rango: 0.5, suelo: 0 },
];

/* Amplía el intervalo hasta el rango mínimo de la métrica, sin salirse de sus límites */
function ampliar(min, max, serie) {
  const falta = serie.rango - (max - min);
  if (falta > 0) { min -= falta / 2; max += falta / 2; }
  if (serie.suelo != null && min < serie.suelo) { max += serie.suelo - min; min = serie.suelo; }
  if (serie.techo != null && max > serie.techo) { min -= max - serie.techo; max = serie.techo; }
  if (serie.suelo != null) min = Math.max(serie.suelo, min);
  return [min, max];
}

/* Cuántos decimales pide un paso del eje (0.5 -> 1, 0.05 -> 2, 10 -> 0) */
const decimalesDe = paso => Math.max(0, Math.min(3, -Math.floor(Math.log10(paso) + 1e-9)));

const GEO = { W: 320, H: 132, ML: 38, MR: 8, MT: 10, MB: 30 };
let DATOS = null;              // histórico, con los tiempos ya en ms
let VENTANA = null;            // tramo visible en el eje X (común a todas)
let VENTANA_COMPLETA = null;   // el rango pedido (1 h, 6 h, 24 h)
let VENTANA_Y = {};            // escala vertical propia, si la has tocado
let RANGO_CARGADO = null;      // tramo que tenemos descargado del servidor
let cargandoMas = false;
let RESOLUCION = null;         // separación real entre muestras de lo descargado
const TOPE_HORAS = 720;        // un mes: lo que guarda Beszel
const AUTO_Y = {};             // la que se calcula sola, para poder volver

const hhmm = ms => new Date(ms).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
const ddmm = ms => new Date(ms).toLocaleDateString("es-ES", { day: "numeric", month: "short" });

/* En tramos largos la hora sola no dice nada: se añade el día debajo */
function etiquetaX(ms, rango) {
  if (rango <= 20 * 3600000) return [hhmm(ms), ""];             // menos de un día
  if (rango <= 4 * 86400000) return [hhmm(ms), ddmm(ms)];       // pocos días
  return [ddmm(ms), ""];                                        // semanas: solo la fecha
}

const fechaHora = ms => `${ddmm(ms)} ${hhmm(ms)}`;

function escalaBonita(min, max) {
  if (!isFinite(min) || !isFinite(max)) return { lo: 0, hi: 1, paso: 1 };
  if (max === min) max = min + 1;
  const mag = Math.pow(10, Math.floor(Math.log10((max - min) / 3 || 1)));
  const paso = [1, 2, 5, 10].map(m => m * mag).find(p => (max - min) / p <= 5) || mag * 10;
  return { lo: Math.floor(min / paso) * paso, hi: Math.ceil(max / paso) * paso, paso };
}

function dibujarGrafica(serie) {
  const { t0, t1 } = VENTANA;
  const { W, H, ML, MR, MT, MB } = GEO;
  const tiempos = DATOS.ms, valores = DATOS[serie.clave] || [];

  const dentro = [];
  for (let i = 0; i < tiempos.length; i++)
    if (tiempos[i] >= t0 && tiempos[i] <= t1 && valores[i] != null) dentro.push([tiempos[i], valores[i]]);

  const hayDatos = dentro.length >= 2;
  // sin puntos puede ser que el nodo estuviera parado... o que el tramo sea más
  // fino que la resolución descargada (al volver de un rango largo)
  const motivoVacio = () => (RESOLUCION && (t1 - t0) < RESOLUCION * 3)
    ? "ampliando detalle…" : "nodo parado";
  const vals = dentro.map(d => d[1]);
  // sin puntos en este tramo se conserva la última escala conocida, para poder seguir moviéndose
  const auto = hayDatos
    ? escalaBonita(...ampliar(Math.min(...vals), Math.max(...vals), serie))
    : (AUTO_Y[serie.clave] ? { ...AUTO_Y[serie.clave] } : { lo: 0, hi: 1 });
  if (hayDatos) AUTO_Y[serie.clave] = { lo: auto.lo, hi: auto.hi };
  const propia = VENTANA_Y[serie.clave];
  const lo = propia ? propia.lo : auto.lo;
  const hi = propia ? propia.hi : auto.hi;
  const paso = escalaBonita(lo, hi).paso;

  const ax = W - ML - MR, ay = H - MT - MB;
  const px = t => ML + ((t - t0) / (t1 - t0 || 1)) * ax;
  const py = v => MT + ay - ((v - lo) / (hi - lo || 1)) * ay;

  // separación normal entre muestras: lo que supere el doble y medio es un hueco
  const saltos = [];
  if (!hayDatos) {
    const bandaEntera = `<rect x="${ML}" y="${MT}" width="${ax}" height="${ay}" class="parado"/>`;
    DATOS._sinDatos = [[t0, t1]];
    let ejeYv = "";
    for (let v = Math.ceil(lo / paso) * paso; v <= hi + 1e-9; v += paso) {
      const y = py(v);
      ejeYv += `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${W - MR}" y2="${y.toFixed(1)}" class="malla"/>
                <text x="${ML - 5}" y="${(y + 3).toFixed(1)}" class="eje" text-anchor="end">${v.toFixed(decimalesDe(paso))}</text>`;
    }
    let ejeXv = "";
    for (let n = 0; n <= 3; n++) {
      const t = t0 + ((t1 - t0) * n) / 3;
      const anclaje = n === 0 ? "start" : n === 3 ? "end" : "middle";
      const [arriba, abajo] = etiquetaX(t, t1 - t0);
      ejeXv += `<text x="${px(t).toFixed(1)}" y="${H - 13}" class="eje" text-anchor="${anclaje}">${arriba}</text>`;
      if (abajo) ejeXv += `<text x="${px(t).toFixed(1)}" y="${H - 3}" class="eje tenue" text-anchor="${anclaje}">${abajo}</text>`;
    }
    return `<div class="grafica" data-serie="${serie.clave}">
      <div class="cab"><span class="titulo">${serie.titulo}</span>
        <span class="ultimo">—</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${ejeYv}${bandaEntera}
        <line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + ay}" class="malla"/>
        <text x="${ML + ax / 2}" y="${MT + ay / 2}" class="eje" text-anchor="middle">${motivoVacio()}</text>
        ${ejeXv}
      </svg></div>`;
  }
  for (let i = 1; i < dentro.length; i++) saltos.push(dentro[i][0] - dentro[i - 1][0]);
  saltos.sort((a, b) => a - b);
  const corte = (saltos[Math.floor(saltos.length / 2)] || 60000) * 2.5;

  const tramos = [[]], sinDatos = [];
  let anterior = null;
  if (dentro[0][0] - t0 > corte) sinDatos.push([t0, dentro[0][0]]);
  for (const [t, v] of dentro) {
    if (anterior !== null && t - anterior > corte) { tramos.push([]); sinDatos.push([anterior, t]); }
    tramos.at(-1).push(`${px(t).toFixed(1)},${py(v).toFixed(1)}`);
    anterior = t;
  }
  if (t1 - anterior > corte) sinDatos.push([anterior, t1]);
  DATOS._sinDatos = sinDatos;

  const bandas = sinDatos.map(([a, b]) =>
    `<rect x="${px(a).toFixed(1)}" y="${MT}" width="${Math.max(0, px(b) - px(a)).toFixed(1)}"
           height="${ay}" class="parado"/>`).join("");

  const utiles = tramos.filter(tr => tr.length > 1);
  const lineas = utiles.map(tr =>
    `<polyline points="${tr.join(" ")}" class="linea"/>`).join("");
  const areas = utiles.map(tr => {
    const x1 = tr[0].split(",")[0], x2 = tr.at(-1).split(",")[0];
    return `<polygon points="${x1},${MT + ay} ${tr.join(" ")} ${x2},${MT + ay}" class="area"/>`;
  }).join("");

  let ejeY = "";
  for (let v = Math.ceil(lo / paso) * paso; v <= hi + 1e-9; v += paso) {
    const y = py(v);
    ejeY += `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${W - MR}" y2="${y.toFixed(1)}" class="malla"/>
             <text x="${ML - 5}" y="${(y + 3).toFixed(1)}" class="eje" text-anchor="end">${v.toFixed(decimalesDe(paso))}</text>`;
  }
  let ejeX = "";
  const rango = t1 - t0;
  for (let n = 0; n <= 3; n++) {
    const t = t0 + (rango * n) / 3;
    const anclaje = n === 0 ? "start" : n === 3 ? "end" : "middle";
    const [arriba, abajo] = etiquetaX(t, rango);
    ejeX += `<text x="${px(t).toFixed(1)}" y="${H - 13}" class="eje" text-anchor="${anclaje}">${arriba}</text>`;
    if (abajo)
      ejeX += `<text x="${px(t).toFixed(1)}" y="${H - 3}" class="eje tenue" text-anchor="${anclaje}">${abajo}</text>`;
  }

  const recorte = `recorte-${serie.clave}`;
  return `<div class="grafica" data-serie="${serie.clave}">
    <div class="cab"><span class="titulo">${serie.titulo}</span>
      <span class="ultimo">${fmt(vals.at(-1))}${serie.unidad}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs><clipPath id="${recorte}">
        <rect x="${ML}" y="${MT}" width="${ax}" height="${ay}"/>
      </clipPath></defs>
      ${ejeY}
      <g clip-path="url(#${recorte})">${bandas}${areas}${lineas}</g>
      <line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + ay}" class="malla"/>
      ${ejeX}
    </svg>
  </div>`;
}

function dibujarGraficas() {
  const caja = $(".graficas", $("#detalle"));
  if (!caja || !DATOS) return;
  caja.innerHTML = SERIES.map(dibujarGrafica).join("");

  const pista = $("#pista-grafica");
  if (!pista) return;
  const intacto = VENTANA.t0 === VENTANA_COMPLETA.t0 && VENTANA.t1 === VENTANA_COMPLETA.t1
    && !Object.keys(VENTANA_Y).length;
  const parado = (DATOS._sinDatos || []).reduce((a, [x, y]) => a + (y - x), 0);
  const finos = !RESOLUCION || (VENTANA.t1 - VENTANA.t0) >= RESOLUCION * 3;
  const aviso = (parado > 60000 && finos)
    ? ` · <span class="leyenda-parado"></span> sin datos: ${Math.round(parado / 60000)} min (nodo parado)`
    : "";
  pista.innerHTML = (intacto
    ? "Arrastra para moverte · arrastra un eje para estirarlo · doble clic para restablecer"
    : `Mostrando ${fechaHora(VENTANA.t0)} – ${fechaHora(VENTANA.t1)} <button class="mini-boton" id="restablecer">Restablecer ejes</button>`)
    + aviso;
  const btn = $("#restablecer");
  if (btn) btn.onclick = restablecerEjes;
}

function limitarVentana() {
  const ahora = Date.now();
  const minimo = ahora - TOPE_HORAS * 3600000;          // hasta donde guarda Beszel
  // el ancho nunca supera todo el histórico disponible: al llegar, deja de estirarse
  const ancho = Math.max(60000, Math.min(VENTANA.t1 - VENTANA.t0, ahora - minimo));
  let t1 = Math.min(VENTANA.t1, ahora);                 // a la derecha, "ahora" es el tope
  let t0 = t1 - ancho;
  if (t0 < minimo) { t0 = minimo; t1 = t0 + ancho; }    // a la izquierda, el tope del mes
  VENTANA = { t0, t1 };
}

/* Separación típica entre muestras: dice qué detalle tenemos descargado */
function resolucionDe(ms) {
  if (!ms || ms.length < 3) return null;
  const d = [];
  for (let i = 1; i < ms.length; i++) d.push(ms[i] - ms[i - 1]);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)] || null;
}

/* Pide más histórico al retroceder, y datos más finos al ampliar */
async function asegurarDatos() {
  if (cargandoMas || !RANGO_CARGADO || !nodoActivo) return;
  const ahora = Date.now();
  const tramo = VENTANA.t1 - VENTANA.t0;
  const horasAtras = Math.max(1, Math.ceil((ahora - VENTANA.t0) / 3600000));

  // ¿nos hemos salido por la izquierda de lo descargado?
  const faltaAtras = VENTANA.t0 < RANGO_CARGADO.t0 + tramo * 0.1;
  // ¿hemos ampliado tanto que los datos que tenemos son demasiado gruesos?
  const pocoDetalle = RESOLUCION && tramo / RESOLUCION < 12;

  if (!faltaAtras && !pocoDetalle) return;

  const horas = Math.min(TOPE_HORAS, Math.ceil(horasAtras * 1.5));
  if (horas === RANGO_CARGADO.horas) return;                   // ya es lo que tenemos

  cargandoMas = true;
  const pista = $("#pista-grafica");
  if (pista) pista.insertAdjacentHTML("beforeend", ' <span class="cargando-mas">· cargando más histórico…</span>');
  const nombre = nodoActivo;
  try {
    const d = await traer(`/api/historico/${nombre}?horas=${horas}`);
    if (d.error || nodoActivo !== nombre) return;
    d.ms = d.t.map(x => new Date(String(x).replace(" ", "T").replace(/\.\d+/, "")).getTime());
    DATOS = d;
    RESOLUCION = resolucionDe(d.ms);
    RANGO_CARGADO = { t0: Date.now() - horas * 3600000, t1: Date.now(), horas };
  } catch { /* se reintentará al seguir desplazando */ }
  finally {
    cargandoMas = false;
    dibujarGraficas();
  }
}

function restablecerEjes() {
  VENTANA = { ...VENTANA_COMPLETA };
  VENTANA_Y = {};
  dibujarGraficas();
}

function prepararInteraccion(caja) {
  let arr = null;

  const zona = e => {
    const svg = e.target.closest("svg");
    const grafica = e.target.closest(".grafica");
    if (!svg || !grafica) return null;
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * GEO.W;
    const vy = ((e.clientY - r.top) / r.height) * GEO.H;
    return {
      clave: grafica.dataset.serie,
      donde: vx < GEO.ML ? "ejeY" : (vy > GEO.H - GEO.MB ? "ejeX" : "dentro"),
      anchoPx: (r.width * (GEO.W - GEO.ML - GEO.MR)) / GEO.W,
      altoPx:  (r.height * (GEO.H - GEO.MT - GEO.MB)) / GEO.H,
    };
  };

  caja.addEventListener("pointerdown", e => {
    const z = zona(e);
    if (!DATOS || !z) return;
    const y = VENTANA_Y[z.clave] || AUTO_Y[z.clave];
    arr = { ...z, x0: e.clientX, y0: e.clientY, ventana: { ...VENTANA }, escalaY: y ? { ...y } : null };
    caja.setPointerCapture(e.pointerId);
    caja.classList.add("arrastrando");
    e.preventDefault();
  });

  caja.addEventListener("pointermove", e => {
    if (!arr) return;
    const dx = e.clientX - arr.x0, dy = e.clientY - arr.y0;
    const ancho0 = arr.ventana.t1 - arr.ventana.t0;

    if (arr.donde === "ejeX") {                        // estirar o comprimir el tiempo
      const factor = Math.min(6, Math.max(0.15, 1 - (dx / arr.anchoPx) * 1.6));
      const centro = (arr.ventana.t0 + arr.ventana.t1) / 2;
      const ancho = Math.max(60000, ancho0 * factor);
      VENTANA = { t0: centro - ancho / 2, t1: centro + ancho / 2 };

    } else if (arr.donde === "ejeY" && arr.escalaY) {  // estirar o comprimir los valores
      const factor = Math.min(6, Math.max(0.15, 1 + (dy / arr.altoPx) * 1.6));
      const c = (arr.escalaY.lo + arr.escalaY.hi) / 2;
      const medio = ((arr.escalaY.hi - arr.escalaY.lo) * factor) / 2 || 0.5;
      VENTANA_Y[arr.clave] = { lo: c - medio, hi: c + medio };

    } else {                                           // mover libremente
      const desfase = -(dx / arr.anchoPx) * ancho0;
      VENTANA = { t0: arr.ventana.t0 + desfase, t1: arr.ventana.t1 + desfase };
      if (arr.escalaY) {
        const dv = (dy / arr.altoPx) * (arr.escalaY.hi - arr.escalaY.lo);
        VENTANA_Y[arr.clave] = { lo: arr.escalaY.lo + dv, hi: arr.escalaY.hi + dv };
      }
    }
    limitarVentana();
    dibujarGraficas();
    asegurarDatos();
  });

  const soltar = () => { arr = null; caja.classList.remove("arrastrando"); };
  caja.addEventListener("pointerup", soltar);
  caja.addEventListener("pointercancel", soltar);
  caja.addEventListener("dblclick", restablecerEjes);

  caja.addEventListener("wheel", e => {               // la rueda, por comodidad
    const z = zona(e);
    if (!DATOS || !z) return;
    e.preventDefault();
    const r = e.target.closest("svg").getBoundingClientRect();
    const izq = r.left + (r.width * GEO.ML) / GEO.W;
    const frac = Math.min(1, Math.max(0, (e.clientX - izq) / z.anchoPx));
    const centro = VENTANA.t0 + (VENTANA.t1 - VENTANA.t0) * frac;
    const ancho = Math.max(60000, (VENTANA.t1 - VENTANA.t0) * (e.deltaY > 0 ? 1.25 : 0.8));
    VENTANA = { t0: centro - ancho * frac, t1: centro + ancho * (1 - frac) };
    limitarVentana();
    dibujarGraficas();
    asegurarDatos();
  }, { passive: false });
}

/* ==================== Fase 2: el Inicio de un vistazo ==================== */

/* ---- avisos: alimentan la línea de estado y el panel del Centro de control ---- */
let ULTIMOS_AVISOS = null;
const NIVELES = { critico: "Crítico", aviso: "Aviso", info: "Info" };

function hace(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "ahora";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `hace ${Math.floor(s / 86400)} d`;
}

async function refrescarAvisos() {
  try { ULTIMOS_AVISOS = await traer("/api/avisos"); } catch { return; }
  pintarEstadoGeneral();
  pintarAvisos();
}

function pintarEstadoGeneral() {
  const caja = $("#estado-general");
  if (!caja) return;
  const total = Object.keys(ESTADOS_NODOS).length + 1;
  const on = Object.values(ESTADOS_NODOS).filter(e => e === "despierto").length + 1;
  const maquinas = `${on} de ${total} máquinas encendidas`;
  const punto = $(".punto", caja), texto = $(".texto", caja);

  const lista = ULTIMOS_AVISOS?.avisos || [];
  const importantes = lista.filter(a => a.nivel !== "info");
  const peor = importantes[0];
  if (!peor) {
    punto.className = "punto verde";
    const info = lista.find(a => a.nivel === "info");
    texto.innerHTML = `<strong>Todo correcto</strong> · ${maquinas}${info ? " · " + info.titulo.toLowerCase() : ""}`;
    return;
  }
  punto.className = `punto ${peor.nivel === "critico" ? "rojo" : "ambar"}`;
  const mas = importantes.length > 1 ? ` <a href="#centro" class="ver-avisos">y ${importantes.length - 1} más</a>` : "";
  texto.innerHTML = `<strong>${peor.titulo}</strong>${mas} · ${maquinas}`;
}

function pintarAvisos() {
  const lista = $("#lista-avisos"), resumen = $("#avisos-resumen");
  if (!lista || !ULTIMOS_AVISOS) return;
  const { avisos, resumen: r, revisado } = ULTIMOS_AVISOS;
  const total = avisos.filter(a => a.nivel !== "info").length;
  const maximo = Math.max(1, ...Object.values(r));

  resumen.innerHTML = `
    <div class="total">${total}</div>
    <div class="total-texto">${total === 1 ? "problema abierto" : "problemas abiertos"}</div>
    ${Object.entries(NIVELES).map(([n, nombre]) => `
      <div class="fila"><span>${nombre}</span>
        <div class="barra ${n}"><span style="width:${(r[n] / maximo) * 100}%"></span></div>
        <span class="n">${r[n]}</span></div>`).join("")}`;

  lista.innerHTML = avisos.length
    ? avisos.map(a => `
        <li class="${a.nivel}">
          <span class="nivel ${a.nivel}">${NIVELES[a.nivel]}</span>
          <div><div class="titulo">${a.titulo}</div>${a.detalle ? `<div class="detalle">${a.detalle}</div>` : ""}</div>
          <div class="cuando">${hace(a.desde)}<span class="origen">${a.origen}</span></div>
        </li>`).join("")
    : `<li class="vacio"><span class="punto verde"></span>Sin avisos: todo funciona como debe.</li>`;

  const rev = $("#avisos-revisado");
  if (rev) rev.textContent = `revisado ${hace(revisado)}`;
}

/* ---- encender y apagar desde la propia tarjeta ---- */
const accionesRapidas = {};

function sincronizarEnergia() {
  for (const t of $$(".nodo[data-nodo]")) {
    const b = $(".energia", t);
    if (!b) continue;
    const on = ESTADOS_NODOS[t.dataset.nodo] === "despierto";
    b.title = on ? "Apagar" : "Encender";
    b.innerHTML = `<svg class="ico"><use href="#${on ? "i-apagar" : "i-encender"}"/></svg>`;
    b.disabled = !!accionesRapidas[t.dataset.nodo];
  }
}

async function accionRapida(tarjeta) {
  const nombre = tarjeta.dataset.nodo;
  if (accionesRapidas[nombre]) return;
  const on = ESTADOS_NODOS[nombre] === "despierto";
  const accion = on ? "dormir" : "despertar";
  if (!await preguntar(`¿${on ? "Apagar" : "Encender"} ${nombreBonito(nombre)}?`, {
        texto: on ? "Se cerrarán los servicios que tenga en marcha." : "Tardará en torno a medio minuto.",
        aceptar: on ? "Apagar" : "Encender", peligro: on })) return;

  try {
    const r = await fetch(`/api/nodo/${nombre}/${accion}${on ? "?forzar=true" : ""}`, { method: "POST" });
    const d = await r.json();
    if (!d.aceptada) { avisar("No se pudo lanzar la acción", d.motivo || ""); return; }
  } catch { avisar("Error al contactar con el servidor"); return; }

  tarjeta.classList.add("ocupada");
  let nota = $(".nota-accion", tarjeta);
  if (!nota) { nota = document.createElement("div"); nota.className = "nota-accion"; tarjeta.appendChild(nota); }

  accionesRapidas[nombre] = setInterval(async () => {
    let d;
    try { d = await traer(`/api/nodo/${nombre}/accion`); } catch { return; }
    nota.textContent = d.terminada ? "" : `${d.accion === "despertar" ? "Encendiendo" : "Apagando"}… ${d.segundos} s`;
    if (d.terminada) {
      clearInterval(accionesRapidas[nombre]);
      delete accionesRapidas[nombre];
      tarjeta.classList.remove("ocupada");
      await pintarNodos();
      pintarMinis();
    }
  }, 2000);
  sincronizarEnergia();
}

function prepararEnergia() {
  for (const b of $$(".energia")) {
    b.addEventListener("click", e => {
      e.stopPropagation();                 // que no abra el panel de detalle
      accionRapida(b.closest(".nodo"));
    });
  }
}

/* ---- minigráfica de CPU (última hora) en cada tarjeta ---- */
async function pintarMinis() {
  for (const svg of $$(".minigrafica[data-mini]")) {
    const nombre = svg.closest(".nodo").dataset.nodo;
    let d;
    try { d = await traer(`/api/historico/${nombre}?horas=1`); } catch { continue; }
    const pares = (d.cpu || []).map((v, i) => [d.t[i], v]).filter(([, v]) => v != null);
    if (pares.length < 2) {
      svg.innerHTML = `<line x1="0" y1="24" x2="100" y2="24" class="vacia"/>`;
      continue;
    }
    const ms = pares.map(([t]) => new Date(String(t).replace(" ", "T").replace(/\.\d+/, "")).getTime());
    const t1 = Date.now(), t0 = t1 - 3600000;
    const max = Math.max(10, ...pares.map(([, v]) => v));          // escala mínima 0-10 %
    const px = t => ((t - t0) / (t1 - t0)) * 100;
    const py = v => 25 - (v / max) * 22;
    const puntos = pares.map(([, v], i) => `${px(ms[i]).toFixed(2)},${py(v).toFixed(2)}`).join(" ");
    const x0 = px(ms[0]).toFixed(2), x1 = px(ms.at(-1)).toFixed(2);
    svg.innerHTML = `<polygon points="${x0},26 ${puntos} ${x1},26" class="area"/>
                     <polyline points="${puntos}" class="linea"/>`;
  }
}

/* ============================== Red ============================== */
const fmtBytes = b => {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
};
const fmtVelocidad = kb => kb == null ? "—" : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB/s` : `${kb.toFixed(1)} KB/s`;
const esLocal = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip);
const NOMBRE_INTERFAZ = { eth0: "Red de casa (eth0)", wg0: "VPN (wg0)" };

async function pintarVpn() {
  const lista = $("#lista-pares"), punto = $("#punto-vpn"), texto = $("#texto-vpn");
  if (!lista) return;
  let d;
  try { d = await traer("/api/red/vpn"); } catch { return; }
  const conectados = d.pares.filter(p => p.conectado).length;
  if (punto) punto.className = `punto ${!d.arriba ? "rojo" : conectados ? "verde" : "acento"}`;
  if (texto) texto.textContent = !d.arriba ? "VPN caída" : conectados ? `VPN · ${conectados} conectado${conectados > 1 ? "s" : ""}` : "VPN activa";

  if (d.error) { lista.innerHTML = `<li><span class="sub">${d.error}</span></li>`; return; }
  lista.innerHTML = d.pares.length ? d.pares.map(p => {
      const hoy = RESUMEN_RED?.vpn?.[p.ip];
      const tiempo = hoy ? duracion(hoy.minutos_hoy * 60) : "—";
      return `
      <li>
        <span class="punto ${p.conectado ? "verde" : ""}"></span>
        <div><div class="nombre">${p.nombre}</div>
             <div class="sub">${p.ip}${p.origen ? " · desde " + p.origen.split(":")[0] : ""}</div>
             ${hoy ? `<div class="sub">hoy: ${tiempo} conectado · ${fmtBytes(hoy.datos_hoy)}${hoy.ips_hoy > 1 ? ` · <span class="raro">${hoy.ips_hoy} IPs distintas</span>` : ""}</div>` : ""}</div>
        <div class="datos">${p.conectado ? "conectado" : p.ultimo_contacto ? hace(p.ultimo_contacto) : "nunca"}</div>
      </li>`; }).join("")
    : `<li><span class="sub">No hay dispositivos dados de alta en la VPN</span></li>`;
}

/* ------------------- gráficas de tráfico -------------------
   Siempre visibles (aunque aún no haya datos), cursor con los valores al pasar
   el ratón o tocar, arrastre horizontal hacia el pasado (hasta 30 días) y
   modo "en directo" que sigue avanzando mientras miras el presente.       */
const RED = {
  ancho: 6 * 3600,        // segundos visibles
  t1: null,               // borde derecho (null = en directo)
  datos: null,            // última respuesta del servidor
  cargado: null,          // {desde, hasta} de lo descargado
  cargando: false,
};
const G_RED = { W: 320, H: 110, ML: 42, MR: 8, MT: 10, MB: 18 };

const ahoraS = () => Math.floor(Date.now() / 1000);
const ventanaRed = () => { const t1 = RED.t1 ?? ahoraS(); return { t0: t1 - RED.ancho, t1 }; };
const horaCorta = (t, largo) => {
  const d = new Date(t * 1000);
  const h = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  return largo ? `${d.toLocaleDateString("es-ES", { day: "numeric", month: "short" })} ${h}` : h;
};

function puntosVisibles(d, v) {
  const pico = RED.datos?.paso > 60;                     // agregado: se dibujan los picos, no la media
  const E = pico ? d.pico_entrada : d.entrada, S = pico ? d.pico_salida : d.salida;
  const out = [];
  for (let i = 0; i < d.t.length; i++) if (d.t[i] >= v.t0 && d.t[i] <= v.t1) out.push([d.t[i], E[i], S[i]]);
  return out;
}

function graficaRed(nombre, d, v) {
  if (!d?.existe) return "";
  const { W, H, ML, MR, MT, MB } = G_RED, ax = W - ML - MR, ay = H - MT - MB;
  const pts = puntosVisibles(d, v);
  const max = Math.max(1, ...pts.map(p => Math.max(p[1], p[2]))) * 1.12;
  const px = t => ML + ((t - v.t0) / (v.t1 - v.t0)) * ax;
  const py = x => MT + ay - (x / max) * ay;

  // tramos continuos (se cortan donde faltan muestras) y huecos sombreados
  const paso = RED.datos?.paso || 60, corte = paso * 2.5;
  const tramos = [], huecos = [];
  let actual = [], anterior = null;
  if (pts.length && pts[0][0] - v.t0 > corte) huecos.push([v.t0, pts[0][0]]);
  for (const p of pts) {
    if (anterior !== null && p[0] - anterior > corte) { tramos.push(actual); actual = []; huecos.push([anterior, p[0]]); }
    actual.push(p); anterior = p[0];
  }
  if (actual.length) tramos.push(actual);
  if (!pts.length) huecos.push([v.t0, v.t1]);
  else if (v.t1 - anterior > corte && v.t1 < ahoraS() - corte) huecos.push([anterior, v.t1]);

  const linea = (tr, k) => tr.map(p => `${px(p[0]).toFixed(1)},${py(p[k]).toFixed(1)}`).join(" ");
  const dibujo = tramos.filter(tr => tr.length > 1).map(tr => `
      <polygon points="${px(tr[0][0]).toFixed(1)},${MT + ay} ${linea(tr, 1)} ${px(tr.at(-1)[0]).toFixed(1)},${MT + ay}" class="area"/>
      <polyline points="${linea(tr, 1)}" class="entrada"/>
      <polyline points="${linea(tr, 2)}" class="salida"/>`).join("");
  const sombras = huecos.map(([a, b]) =>
    `<rect x="${px(a).toFixed(1)}" y="${MT}" width="${Math.max(0, px(b) - px(a)).toFixed(1)}" height="${ay}" class="hueco"/>`).join("");

  const largo = v.t1 - v.t0 > 20 * 3600;
  let ejeX = "";
  for (let n = 0; n <= 3; n++) {
    const t = v.t0 + ((v.t1 - v.t0) * n) / 3;
    ejeX += `<text x="${px(t).toFixed(1)}" y="${H - 4}" class="eje" text-anchor="${["start", "middle", "middle", "end"][n]}">${horaCorta(t, largo)}</text>`;
  }
  const ultimo = pts.at(-1);
  const enVivo = RED.t1 === null;

  return `<div class="grafica-red" data-interfaz="${nombre}">
    <div class="cab"><span>${NOMBRE_INTERFAZ[nombre] || nombre}</span>
      <span>${ultimo && enVivo ? `↓ <strong>${fmtVelocidad(ultimo[1])}</strong> · ↑ <strong>${fmtVelocidad(ultimo[2])}</strong>`
                               : `máx. <strong>${fmtVelocidad(Math.max(0, ...pts.map(p => p[1])))}</strong>`}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <line x1="${ML}" y1="${MT}" x2="${W - MR}" y2="${MT}" class="malla"/>
      <line x1="${ML}" y1="${MT + ay / 2}" x2="${W - MR}" y2="${MT + ay / 2}" class="malla"/>
      <line x1="${ML}" y1="${MT + ay}" x2="${W - MR}" y2="${MT + ay}" class="malla"/>
      <text x="${ML - 4}" y="${MT + 3}" class="eje" text-anchor="end">${fmtVelocidad(max).replace(" ", "")}</text>
      <text x="${ML - 4}" y="${MT + ay / 2 + 3}" class="eje" text-anchor="end">${fmtVelocidad(max / 2).replace(" ", "")}</text>
      <text x="${ML - 4}" y="${MT + ay + 3}" class="eje" text-anchor="end">0</text>
      ${sombras}${dibujo}
      ${pts.length ? "" : `<text x="${ML + ax / 2}" y="${MT + ay / 2}" class="eje" text-anchor="middle">${enVivo ? "reuniendo datos (una muestra por minuto)…" : "sin datos en este tramo"}</text>`}
      <g class="cursor" visibility="hidden">
        <line class="cursor-linea" y1="${MT}" y2="${MT + ay}"/>
        <circle class="p-entrada" r="3"/><circle class="p-salida" r="2.6"/>
      </g>
      ${ejeX}
    </svg>
    <div class="burbuja"></div>
  </div>`;
}

function dibujarRed() {
  const caja = $("#graficas-red");
  if (!caja || !RED.datos) return;
  const v = ventanaRed();
  caja.innerHTML = Object.entries(RED.datos.interfaces).map(([i, d]) => graficaRed(i, d, v)).join("")
    || `<div class="sin-datos">No hay interfaces que vigilar</div>`;
  const pista = $("#pista-red");
  if (pista) pista.innerHTML = RED.t1 === null
    ? "En directo · arrastra hacia la izquierda para ver el pasado"
    : `Mostrando ${horaCorta(v.t0, true)} – ${horaCorta(v.t1, true)} · <button class="enlace-pista" id="red-ahora">volver a ahora</button>`;
  $("#red-ahora")?.addEventListener("click", () => { RED.t1 = null; cargarRed(); });
}

async function cargarRed() {
  if (RED.cargando) return;
  RED.cargando = true;
  const v = ventanaRed();
  const desde = v.t0 - Math.floor(RED.ancho / 2);        // margen por la izquierda para poder arrastrar
  try {
    const d = await traer(`/api/red/trafico?desde=${desde}&hasta=${v.t1}`);
    if (!d.error) { RED.datos = d; RED.cargado = { desde, hasta: v.t1 }; }
  } catch { /* se reintenta */ }
  RED.cargando = false;
  dibujarRed();
}

/* Cursor: una línea vertical con los dos valores en todas las gráficas a la vez */
function moverCursorRed(clientX, svgRef) {
  if (!RED.datos) return;
  const v = ventanaRed(), { W, ML, MR, MT, H, MB } = G_RED, ax = W - ML - MR, ay = H - MT - MB;
  const r = svgRef.getBoundingClientRect();
  const x = ((clientX - r.left) / r.width) * W;
  if (x < ML || x > W - MR) { ocultarCursorRed(); return; }
  const t = v.t0 + ((x - ML) / ax) * (v.t1 - v.t0);

  for (const g of $$(".grafica-red")) {
    const d = RED.datos.interfaces[g.dataset.interfaz];
    const pts = d ? puntosVisibles(d, v) : [];
    const cursor = $(".cursor", g), burbuja = $(".burbuja", g);
    if (!pts.length) { cursor.setAttribute("visibility", "hidden"); burbuja.style.display = "none"; continue; }
    let mejor = pts[0];
    for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(mejor[0] - t)) mejor = p;
    if (Math.abs(mejor[0] - t) > (RED.datos.paso || 60) * 2.5) {       // cursor sobre un hueco
      cursor.setAttribute("visibility", "hidden"); burbuja.style.display = "none"; continue;
    }
    const max = Math.max(1, ...pts.map(p => Math.max(p[1], p[2]))) * 1.12;
    const cx = ML + ((mejor[0] - v.t0) / (v.t1 - v.t0)) * ax;
    const yE = MT + ay - (mejor[1] / max) * ay, yS = MT + ay - (mejor[2] / max) * ay;
    $(".cursor-linea", g).setAttribute("x1", cx); $(".cursor-linea", g).setAttribute("x2", cx);
    const [ce, cs] = $$("circle", g);
    ce.setAttribute("cx", cx); ce.setAttribute("cy", yE);
    cs.setAttribute("cx", cx); cs.setAttribute("cy", yS);
    cursor.setAttribute("visibility", "visible");

    burbuja.innerHTML = `<span class="h">${horaCorta(mejor[0], v.t1 - v.t0 > 20 * 3600)}</span>
      ↓ <strong>${fmtVelocidad(mejor[1])}</strong> · ↑ <strong>${fmtVelocidad(mejor[2])}</strong>`;
    burbuja.style.display = "block";
    const gr = g.getBoundingClientRect(), sr = $("svg", g).getBoundingClientRect();
    const xPx = sr.left - gr.left + (cx / W) * sr.width;
    const anchoB = burbuja.offsetWidth;
    burbuja.style.left = `${Math.min(gr.width - anchoB - 6, Math.max(6, xPx + 10))}px`;
  }
}
function ocultarCursorRed() {
  $$(".grafica-red .cursor").forEach(c => c.setAttribute("visibility", "hidden"));
  $$(".grafica-red .burbuja").forEach(b => b.style.display = "none");
}

function prepararRed() {
  const caja = $("#graficas-red");
  if (!caja) return;
  let arr = null;

  caja.addEventListener("pointerdown", e => {
    const svg = e.target.closest("svg");
    if (!svg) return;
    arr = { x0: e.clientX, t1: ventanaRed().t1, movido: false, ancho: svg.getBoundingClientRect().width };
    caja.setPointerCapture(e.pointerId);
    moverCursorRed(e.clientX, svg);                     // al tocar en el móvil también aparece
  });
  caja.addEventListener("pointermove", e => {
    const svg = e.target.closest("svg") || $("svg", caja);
    if (arr) {
      const dx = e.clientX - arr.x0;
      if (Math.abs(dx) > 4) arr.movido = true;
      if (arr.movido) {
        ocultarCursorRed();
        caja.classList.add("arrastrando");
        const plano = arr.ancho * (G_RED.W - G_RED.ML - G_RED.MR) / G_RED.W;
        const nuevo = Math.round(arr.t1 - (dx / plano) * RED.ancho);
        const limiteAtras = ahoraS() - 30 * 86400 + RED.ancho;
        RED.t1 = Math.max(limiteAtras, nuevo);
        if (RED.t1 >= ahoraS() - 60) RED.t1 = null;     // al llegar al presente, vuelve al directo
        dibujarRed();
        return;
      }
    }
    if (svg && e.pointerType === "mouse") moverCursorRed(e.clientX, svg);
  });
  const soltar = () => {
    if (arr?.movido) {
      caja.classList.remove("arrastrando");
      const v = ventanaRed();
      if (!RED.cargado || v.t0 < RED.cargado.desde || v.t1 > RED.cargado.hasta + 120) cargarRed();
    }
    arr = null;
  };
  caja.addEventListener("pointerup", soltar);
  caja.addEventListener("pointercancel", soltar);
  caja.addEventListener("pointerleave", e => { if (e.pointerType === "mouse" && !arr) ocultarCursorRed(); });

  $$("#rango-red button").forEach(b => b.onclick = () => {
    $$("#rango-red button").forEach(x => x.classList.toggle("activo", x === b));
    RED.ancho = +b.dataset.horas * 3600;
    RED.t1 = null;
    cargarRed();
  });
}

async function pintarTrafico() {
  if (RED.t1 === null) await cargarRed();               // en directo: se refresca solo
}

/* Qué es cada cosa, en lenguaje llano (los más habituales en una red de casa) */
const PUERTOS_CONOCIDOS = {
  "UDP/5353": "mDNS · anuncios de dispositivos", "UDP/137": "NetBIOS · nombres de Windows",
  "UDP/138": "NetBIOS · difusión de Windows", "UDP/1900": "SSDP · descubrimiento UPnP",
  "UDP/29810": "Descubrimiento del router TP-Link", "UDP/67": "DHCP", "UDP/68": "DHCP",
  "2": "IGMP · multidifusión del router", "UDP/5355": "LLMNR · nombres de Windows",
  "UDP/3702": "WS-Discovery · impresoras y Windows",
  "TCP/22": "SSH", "TCP/80": "Web (HTTP)", "TCP/443": "Web (HTTPS)", "TCP/3389": "Escritorio remoto",
  "TCP/445": "Compartición de Windows (SMB)", "TCP/23": "Telnet", "TCP/3306": "Base de datos MySQL",
};
const describir = d => PUERTOS_CONOCIDOS[d] || d.replace("/", " ");

let bloqueosAbiertos = false;

async function pintarBloqueos() {
  const lista = $("#lista-bloqueos"), total = $("#bloqueos-total"), barras = $("#bloqueos-hora");
  if (!lista) return;
  let d;
  try { d = await traer("/api/red/bloqueos?horas=24"); } catch { return; }
  if (d.error) { lista.innerHTML = `<li><span class="que">${d.error}</span></li>`; return; }
  if (total) total.textContent = `${d.total} · ${d.ips} IP${d.ips === 1 ? "" : "s"}`;

  // minigráfica de barras: bloqueos por hora en las últimas 24 h
  if (barras && d.por_hora) {
    const max = Math.max(1, ...d.por_hora), ancho = 240 / d.por_hora.length;
    barras.innerHTML = d.por_hora.map((n, i) => {
      const alto = n ? Math.max(2, (n / max) * 26) : 2;
      return `<rect x="${(i * ancho + 1).toFixed(1)}" y="${(28 - alto).toFixed(1)}" width="${(ancho - 2).toFixed(1)}"
                    height="${alto.toFixed(1)}" class="${n ? "" : "vacio"}"><title>${n} bloqueos</title></rect>`;
    }).join("");
  }

  if (!d.grupos.length) { lista.innerHTML = `<li class="mas">Nadie ha llamado a la puerta</li>`; return; }
  const visibles = bloqueosAbiertos ? d.grupos : d.grupos.slice(0, 6);
  lista.innerHTML = visibles.map(g => {
    const local = esLocal(g.origen);
    const conocido = g.etiqueta;                       // origen identificado (p. ej. Cloudflare)
    const clase = local ? "" : conocido ? "conocido" : "internet";
    const tipo = local ? "local" : conocido ? conocido.nombre : "internet";
    // A un origen conocido no se le ofrece "bloquear": bloquear Cloudflare cortaría lo publicado por su túnel
    const boton = local || conocido ? "" : ` <button class="accion-ip" data-bloquear="${g.origen}">bloquear</button>`;
    const que = conocido?.clave === "cloudflare"
      ? "Respuestas tardías del túnel (QUIC, puerto 7844). Inofensivo"
      : g.destinos.map(describir).join(" · ") + (g.mas_destinos ? ` +${g.mas_destinos}` : "");
    return `<li class="${clase}">
      <span class="ip">${g.origen}<small class="${conocido ? "etq-conocido" : ""}">${tipo}</small></span>
      <span class="veces">${g.veces}× · ${hace(g.ultimo)}${boton}</span>
      <span class="que">${que}</span>
    </li>`;
  }).join("") + (d.grupos.length > 6
    ? `<li class="mas"><button id="alternar-bloqueos">${bloqueosAbiertos ? "Ver menos" : `Ver las ${d.ips}`}</button></li>` : "");
  $("#alternar-bloqueos")?.addEventListener("click", () => { bloqueosAbiertos = !bloqueosAbiertos; pintarBloqueos(); });
}

/* ------------------- indicadores de red (resumen) ------------------- */
let RESUMEN_RED = null;

const duracion = seg => {
  const h = Math.floor(seg / 3600), m = Math.round((seg % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const NOMBRES_NS = {
  nas: "NAS (fotos y archivos)", auth: "Portal (Authelia)", beszel: "Telemetría (Beszel)",
  homepage: "Homepage", "kube-system": "Sistema de Kubernetes", panel: "Panel", prueba: "Pruebas",
};

async function pintarResumenRed() {
  const caja = $("#kpis-red");
  if (!caja) return;
  try { RESUMEN_RED = await traer("/api/red/resumen"); } catch { return; }
  const r = RESUMEN_RED, c = r.consumo || {}, cx = r.conexion;
  const tot = (i, p) => c[i] ? c[i][p].entrada + c[i][p].salida : 0;
  const pico = r.pico_hoy?.eth0;
  const minutosVpn = Object.values(r.vpn || {}).reduce((a, v) => a + v.minutos_hoy, 0);

  let calidad = "", latTexto = "—";
  if (cx && cx.lat_internet != null) {
    latTexto = `${Math.round(cx.lat_internet)} <small>ms</small>`;
    calidad = cx.perdida_internet > 5 || cx.lat_internet > 120 ? "mal"
            : cx.perdida_internet > 0 || cx.lat_internet > 60 ? "regular" : "bien";
  } else if (cx) { latTexto = "sin respuesta"; calidad = "mal"; }

  const kpi = (etq, val, sub, clase = "") =>
    `<div class="kpi ${clase}"><div class="etq">${etq}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
  caja.innerHTML = [
    kpi("Hoy · casa", `↓ ${fmtBytes(c.eth0?.hoy.entrada)}`, `↑ ${fmtBytes(c.eth0?.hoy.salida)}`),
    kpi("Hoy · VPN", `↓ ${fmtBytes(c.wg0?.hoy.entrada)}`, `↑ ${fmtBytes(c.wg0?.hoy.salida)}`),
    kpi("Últimos 30 días", fmtBytes(tot("eth0", "mes") + tot("wg0", "mes")),
        `casa ${fmtBytes(tot("eth0", "mes"))} · VPN ${fmtBytes(tot("wg0", "mes"))}`),
    kpi("Pico de hoy", pico ? fmtVelocidad(pico.kbs) : "—",
        pico ? `a las ${new Date(pico.t * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}` : "sin datos"),
    kpi("Latencia a internet", latTexto,
        cx ? `pérdida ${cx.perdida_internet ?? "—"} % · DNS ${cx.dns_ms ?? "—"} ms` : "midiendo…", calidad),
    kpi("Router", cx?.lat_router != null ? `${cx.lat_router.toFixed(1)} <small>ms</small>` : "—",
        cx ? `pérdida ${cx.perdida_router ?? "—"} %` : "midiendo…",
        cx && cx.perdida_router > 0 ? "regular" : ""),
    kpi("IP pública", r.ip_publica?.actual || "—",
        r.ip_publica ? `desde ${new Date(r.ip_publica.desde * 1000).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}` : "consultando…"),
    kpi("VPN hoy", minutosVpn ? duracion(minutosVpn * 60) : "0 min", "tiempo conectado en total"),
  ].join("");
}

let periodoConsumo = "hoy";
async function pintarConsumo() {
  const lista = $("#lista-consumo");
  if (!lista) return;
  let d;
  try { d = await traer(`/api/red/consumo_servicios?periodo=${periodoConsumo}`); } catch { return; }
  const fila = (nombre, bytes, max) => `<li><div class="fila"><span>${nombre}</span><span>${fmtBytes(bytes)}</span></div>
      <div class="barra"><span style="width:${(bytes / max) * 100}%"></span></div></li>`;
  const maxC = Math.max(1, ...d.cluster.map(x => x.bytes)), maxA = Math.max(1, ...d.apps.map(x => x.bytes));
  let html = d.cluster.length ? d.cluster.map(x => fila(NOMBRES_NS[x.nombre] || x.nombre, x.bytes, maxC)).join("")
                              : `<li class="mas">Aún sin datos (se mide cada 5 minutos)</li>`;
  if (d.apps.length) html += `<li class="separador">Apps abiertas a través de la Pi</li>` +
                             d.apps.map(x => fila(x.nombre, x.bytes, maxA)).join("");
  lista.innerHTML = html;
}

async function pintarConexion() {
  const caja = $("#grafica-conexion");
  if (!caja) return;
  let d;
  try { d = await traer("/api/red/conexion?horas=24"); } catch { return; }
  const W = 640, H = 90, ML = 36, MR = 8, MT = 8, MB = 16, ax = W - ML - MR, ay = H - MT - MB;
  const t1 = Math.floor(Date.now() / 1000), t0 = t1 - 86400;
  const vals = [...d.lat_internet, ...d.lat_router].filter(v => v != null);
  const max = Math.max(20, ...vals) * 1.15;
  const px = t => ML + ((t - t0) / (t1 - t0)) * ax, py = v => MT + ay - (v / max) * ay;
  const linea = serie => {
    const tramos = []; let tr = [], prev = null;
    d.t.forEach((t, i) => {
      if (serie[i] == null || (prev && t - prev > 180)) { if (tr.length > 1) tramos.push(tr); tr = []; }
      if (serie[i] != null) tr.push(`${px(t).toFixed(1)},${py(serie[i]).toFixed(1)}`);
      prev = t;
    });
    if (tr.length > 1) tramos.push(tr);
    return tramos.map(x => x.join(" "));
  };
  const perdidas = d.t.map((t, i) => d.perdida_internet[i] > 0
      ? `<circle cx="${px(t).toFixed(1)}" cy="${MT + ay}" r="${Math.min(3.5, 1.2 + d.perdida_internet[i] / 30)}" class="perdida"><title>${d.perdida_internet[i]} % de pérdida</title></circle>` : "").join("");
  const hora = t => new Date(t * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  const vacio = !d.t.length;
  caja.innerHTML = `<div class="grafica-conexion"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <line x1="${ML}" y1="${MT}" x2="${W - MR}" y2="${MT}" class="malla"/>
      <line x1="${ML}" y1="${MT + ay}" x2="${W - MR}" y2="${MT + ay}" class="malla"/>
      <text x="${ML - 4}" y="${MT + 3}" class="eje" text-anchor="end">${Math.round(max)} ms</text>
      <text x="${ML - 4}" y="${MT + ay + 3}" class="eje" text-anchor="end">0</text>
      ${linea(d.lat_router).map(p => `<polyline points="${p}" class="router"/>`).join("")}
      ${linea(d.lat_internet).map(p => `<polyline points="${p}" class="internet"/>`).join("")}
      ${perdidas}
      ${vacio ? `<text x="${ML + ax / 2}" y="${MT + ay / 2}" class="eje" text-anchor="middle">midiendo (una vez por minuto)…</text>` : ""}
      ${[0, 1, 2, 3, 4].map(n => { const t = t0 + (86400 * n) / 4;
        return `<text x="${px(t).toFixed(1)}" y="${H - 3}" class="eje" text-anchor="${["start", "middle", "middle", "middle", "end"][n]}">${hora(t)}</text>`; }).join("")}
    </svg></div>`;
}

/* ============================ Seguridad (CrowdSec) ============================ */
const ESCENARIOS = {
  "ssh-bf": "Fuerza bruta en SSH", "ssh-slow-bf": "Fuerza bruta lenta en SSH",
  "ssh-cve-2024-6387": "Exploit de OpenSSH (regreSSHion)",
  "iptables-scan-multi_ports": "Escaneo de puertos",
  "http-probing": "Rastreo de rutas web", "http-crawl-non_statics": "Rastreo agresivo de la web",
  "http-sensitive-files": "Busca ficheros sensibles", "http-backdoors-attempts": "Busca puertas traseras",
  "http-admin-interface-probing": "Busca paneles de administración", "http-bad-user-agent": "Herramienta de ataque conocida",
  "http-path-traversal-probing": "Recorrido de directorios", "http-sqli-probing": "Intentos de inyección SQL",
  "http-xss-probing": "Intentos de XSS", "http-open-proxy": "Uso como proxy abierto",
  "http-generic-bf": "Fuerza bruta en un login web", "http-wordpress-scan": "Escaneo de WordPress",
  "authelia-bf": "Fuerza bruta en el portal (Authelia)",
};
function nombreEscenario(completo) {
  const corto = String(completo || "").split("/").pop();
  if (ESCENARIOS[corto]) return ESCENARIOS[corto];
  if (/cve/i.test(corto)) return `Vulnerabilidad conocida (${corto.replace(/^http-/, "").toUpperCase()})`;
  return corto.replace(/[-_]/g, " ");
}
const nombrePais = (() => {
  let dn = null;
  try { dn = new Intl.DisplayNames(["es"], { type: "region" }); } catch {}
  return cc => { if (!cc) return "red local"; try { return dn ? dn.of(cc) : cc; } catch { return cc; } };
})();

function mapaSeguridad(puntos, alertas) {
  const M = MAPA_MUNDO;
  const recientes = new Set(alertas.filter(a => Date.now() / 1000 - a.t < 3600).map(a => a.ip));
  const max = Math.max(1, ...puntos.map(p => p.veces));
  const circulos = puntos.map(p => {
    const x = p.lon + 180, y = M.latNorte - p.lat;
    const r = 1.4 + Math.sqrt(p.veces / max) * 4;
    const reciente = p.ips.some(ip => recientes.has(ip));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" class="ataque ${reciente ? "reciente" : ""}">
      <title>${nombrePais(p.pais)} · ${p.veces} detección${p.veces > 1 ? "es" : ""}\n${p.ips.join(", ")}</title></circle>`;
  }).join("");
  // tu casa (CIUDAD), como referencia
  const casa = `<circle cx="${(CIUDAD.lon + 180).toFixed(1)}" cy="${(M.latNorte - CIUDAD.lat).toFixed(1)}" r="1.3" class="casa"><title>Tu casa</title></circle>`;
  const vacio = puntos.length ? "" :
    `<text x="${M.ancho / 2}" y="${M.alto - 6}" text-anchor="middle" class="vacio">Sin ataques geolocalizados en los últimos 7 días</text>`;
  return `<svg viewBox="0 0 ${M.ancho} ${M.alto}" preserveAspectRatio="xMidYMid meet">
      <path d="${M.camino}" class="tierra"/>${casa}${circulos}${vacio}</svg>`;
}

async function pintarSeguridad() {
  const panel = $("#panel-seguridad");
  if (!panel) return;
  let d;
  try { d = await traer("/api/seguridad/resumen"); } catch { return; }

  const punto = $("#punto-cs"), texto = $("#texto-cs"), aviso = $("#aviso-modo");
  if (!d.motor) {
    punto.className = "punto rojo"; texto.textContent = "CrowdSec inactivo";
  } else if (!d.accesible) {
    punto.className = "punto ambar"; texto.textContent = "CrowdSec · sin permiso de lectura";
  } else {
    punto.className = `punto ${d.modo === "protegiendo" ? "verde" : "acento"}`;
    texto.textContent = d.modo === "protegiendo" ? "CrowdSec · protegiendo" : "CrowdSec · observando";
  }
  aviso.hidden = d.modo === "protegiendo" || !d.motor;
  aviso.textContent = "Modo observación: CrowdSec detecta y registra, pero todavía no aplica los bloqueos en el cortafuegos.";

  const kpi = (etq, val, sub, clase = "") =>
    `<div class="kpi ${clase}"><div class="etq">${etq}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
  const pais = d.paises[0];
  $("#kpis-seg").innerHTML = [
    kpi("Detecciones · 24 h", d.total_24h, d.total_24h ? "revisa la lista" : "todo tranquilo", d.total_24h ? "regular" : ""),
    kpi("Detecciones · 7 días", d.total_7d, `${d.escenarios.length} tipo${d.escenarios.length === 1 ? "" : "s"} de ataque`),
    kpi("Bloqueados ahora", d.decisiones.length, d.modo === "protegiendo" ? "en el cortafuegos" : "registrados (sin aplicar)"),
    kpi("Origen más activo", pais ? nombrePais(pais.nombre) : "—", pais ? `${pais.veces} detección${pais.veces > 1 ? "es" : ""}` : "sin datos"),
  ].join("");

  $("#mapa-seg").innerHTML = mapaSeguridad(d.puntos, d.alertas);

  const maxE = Math.max(1, ...d.escenarios.map(e => e.veces));
  $("#lista-escenarios").innerHTML = d.escenarios.length
    ? d.escenarios.map(e => `<li><div class="fila"><span>${nombreEscenario(e.nombre)}</span><span>${e.veces}</span></div>
        <div class="barra"><span style="width:${(e.veces / maxE) * 100}%"></span></div></li>`).join("")
    : `<li class="mas">Ningún ataque detectado</li>`;

  const bloqueadas = new Set(d.decisiones.map(x => x.ip));
  $("#lista-detecciones").innerHTML = d.alertas.length
    ? d.alertas.slice(0, 8).map(a => `<li class="${esLocal(a.ip) ? "" : "internet"}">
        <span class="ip">${a.ip}<small>${nombrePais(a.pais)}</small></span>
        <span class="veces">${hace(a.t)} ${bloqueadas.has(a.ip)
            ? `<button class="accion-ip quitar" data-desbloquear="${a.ip}">desbloquear</button>`
            : `<button class="accion-ip" data-bloquear="${a.ip}">bloquear</button>`}</span>
        <span class="que">${nombreEscenario(a.escenario)} · ${a.eventos} evento${a.eventos === 1 ? "" : "s"}${a.red ? " · " + a.red : ""}</span>
      </li>`).join("")
    : `<li class="mas">Sin detecciones en los últimos 7 días</li>`;

  $("#lista-decisiones").innerHTML = d.decisiones.length
    ? d.decisiones.slice(0, 10).map(x => `<li class="${esLocal(x.ip) ? "" : "internet"}">
        <span class="ip">${x.ip}<small>${nombrePais(x.pais)}</small></span>
        <span class="veces">${x.permanente ? `<span class="etiqueta-mini permanente">permanente</span>` : `quedan ${duracionLarga(x.restan)}`}
          <button class="accion-ip quitar" data-desbloquear="${x.ip}">quitar</button></span>
        <span class="que">${x.manual ? `Manual${x.motivo && x.motivo !== "bloqueo desde el panel" ? " · " + x.motivo : ""}` : nombreEscenario(x.motivo)}</span>
      </li>`).join("")
    : `<li class="mas">Ninguna IP bloqueada</li>`;
}

const duracionLarga = seg => seg >= 2 * 86400 ? `${Math.round(seg / 86400)} días` : duracion(seg);

async function bloquearIp(ip, horas, motivo = "") {
  if (!ip) return false;
  const cuanto = horas === 0 ? "De forma permanente, hasta que lo quites tú."
    : `Durante ${horas >= 24 ? horas / 24 + " día" + (horas >= 48 ? "s" : "") : horas + " h"}.`;
  const ok = await preguntar(horas === 0 ? `¿Vetar ${ip} para siempre?` : `¿Bloquear ${ip}?`, {
    texto: `${cuanto} Tus propios equipos nunca se bloquean.`,
    aceptar: horas === 0 ? "Vetar" : "Bloquear", peligro: true });
  if (!ok) return false;
  try {
    const r = await fetch(`/api/seguridad/bloquear?ip=${encodeURIComponent(ip)}&horas=${horas}&motivo=${encodeURIComponent(motivo)}`,
                          { method: "POST" });
    const d = await r.json();
    if (!d.ok) { avisar("No se pudo bloquear", d.motivo || ""); return false; }
  } catch { avisar("Error al contactar con el servidor"); return false; }
  pintarSeguridad(); pintarHistorial();
  return true;
}

async function desbloquearIp(ip) {
  if (!await preguntar(`¿Quitar el bloqueo de ${ip}?`, { aceptar: "Quitar bloqueo" })) return;
  try {
    const r = await fetch(`/api/seguridad/desbloquear?ip=${encodeURIComponent(ip)}`, { method: "POST" });
    const d = await r.json();
    if (!d.ok) { avisar("No se pudo quitar el bloqueo", d.motivo || ""); return; }
  } catch { avisar("Error al contactar con el servidor"); return; }
  pintarSeguridad(); pintarHistorial();
}

const TIPOS_HISTORIAL = { deteccion: "detección", cortafuegos: "cortafuegos", bloquear: "bloqueo",
                          vetar: "veto", desbloquear: "desbloqueo" };

async function pintarHistorial(ip = $("#buscar-ip")?.value.trim() || "") {
  const lista = $("#lista-historial");
  if (!lista) return;
  let d;
  try { d = await traer(`/api/seguridad/historial?ip=${encodeURIComponent(ip)}&limite=100`); } catch { return; }
  const t = d.totales || {};
  const tot = $("#historial-totales");
  if (tot) tot.textContent = `${t.seg_alertas || 0} detecciones · ${t.seg_cortafuegos || 0} registros del cortafuegos · ` +
    `${t.seg_acciones || 0} acciones${d.desde ? " · desde " + new Date(d.desde * 1000).toLocaleDateString("es-ES") : ""}`;
  const fecha = ts => new Date(ts * 1000).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit",
                                                                    hour: "2-digit", minute: "2-digit" });
  const detalle = e => {
    if (e.tipo === "deteccion") return `${nombreEscenario(e.detalle)} · ${e.veces} eventos${e.pais ? " · " + nombrePais(e.pais) : ""}${e.red ? " · " + e.red : ""}`;
    if (e.tipo === "cortafuegos" && e.etiqueta)
      return `${e.etiqueta.nombre} · ${e.veces} respuesta${e.veces === 1 ? "" : "s"} tardía${e.veces === 1 ? "" : "s"} el ${e.dia} (inofensivo)`;
    if (e.tipo === "cortafuegos") return `${e.veces} intento${e.veces === 1 ? "" : "s"} el ${e.dia} · ${(e.detalle || "").split(",").map(describir).join(", ")}`;
    if (e.tipo === "vetar") return `permanente${e.detalle ? " · " + e.detalle : ""}`;
    if (e.tipo === "bloquear") return `${e.horas} h${e.detalle ? " · " + e.detalle : ""}`;
    return e.detalle || "";
  };
  lista.innerHTML = d.eventos.length ? d.eventos.map(e => `
      <li><span class="fecha">${fecha(e.t)}</span>
        <span class="tipo-h ${e.etiqueta ? "conocido" : e.tipo}">${e.etiqueta ? e.etiqueta.nombre.split(" ").pop() : (TIPOS_HISTORIAL[e.tipo] || e.tipo)}</span>
        <button class="ip-enlace" data-historial-ip="${e.ip}" title="Ver todo lo de esta IP">${e.ip}</button>
        <span class="det" title="${detalle(e).replace(/"/g, "&quot;")}">${detalle(e)}</span></li>`).join("")
    : `<li><span class="det">${ip ? `No hay nada registrado de ${ip}` : "El historial está vacío por ahora"}</span></li>`;
}

function prepararSeguridad() {
  $("#boton-buscar-ip")?.addEventListener("click", () => pintarHistorial());
  $("#buscar-ip")?.addEventListener("keydown", e => { if (e.key === "Enter") pintarHistorial(); });
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-historial-ip]");
    if (!b) return;
    $("#buscar-ip").value = b.dataset.historialIp;
    pintarHistorial();
  });
  // botones de bloquear/desbloquear en cualquier lista (seguridad y bloqueos de red)
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-bloquear], [data-desbloquear]");
    if (!b) return;
    if (b.dataset.bloquear) bloquearIp(b.dataset.bloquear, 4);
    else desbloquearIp(b.dataset.desbloquear);
  });
  $("#boton-bloquear")?.addEventListener("click", () => {
    const ip = $("#ip-bloquear").value.trim();
    if (!/^[0-9a-fA-F:.]+$/.test(ip)) { avisar("Escribe una IP válida", "Por ejemplo 203.0.113.7"); return; }
    const motivo = $("#motivo-bloquear").value.trim();
    if (motivo && !/^[\p{L}\p{N} .,:;()/_-]{0,80}$/u.test(motivo)) {
      avisar("Motivo no válido", "Usa solo letras, números y puntuación básica."); return;
    }
    bloquearIp(ip, +$("#horas-bloquear").value, motivo).then(ok => {
      if (ok) { $("#ip-bloquear").value = ""; $("#motivo-bloquear").value = ""; }
    });
  });
}

/* ============ acciones sobre los nodos (encender / apagar) ============ */
const vigilando = {};

function botonesNodo(nombre) {
  const encendido = ESTADOS_NODOS[nombre] === "despierto";
  return `<div class="acciones">
      <button class="boton-accion encender" data-accion="despertar" ${encendido ? "disabled" : ""}>
        <svg class="ico"><use href="#i-encender"/></svg>Encender</button>
      <button class="boton-accion apagar" data-accion="dormir" ${encendido ? "" : "disabled"}>
        <svg class="ico"><use href="#i-apagar"/></svg>Apagar</button>
      <span class="estado-accion" data-estado-accion></span>
    </div>`;
}

function sincronizarBotones() {
  const panel = $("#detalle");
  if (!nodoActivo || !panel) return;
  const encendido = ESTADOS_NODOS[nodoActivo] === "despierto";
  const ocupado = !!$(".rueda-mini", panel);
  const enc = $('.boton-accion[data-accion="despertar"]', panel);
  const apa = $('.boton-accion[data-accion="dormir"]', panel);
  if (enc) enc.disabled = encendido || ocupado;
  if (apa) apa.disabled = !encendido || ocupado;
}

async function pedirAccion(nombre, accion, panel) {
  const verbo = accion === "despertar" ? "encender" : "apagar";
  if (!await preguntar(`¿${verbo[0].toUpperCase() + verbo.slice(1)} ${nombreBonito(nombre)}?`, {
        texto: accion === "dormir" ? "Se cerrarán los servicios que tenga en marcha." : "Tardará en torno a medio minuto.",
        aceptar: verbo[0].toUpperCase() + verbo.slice(1), peligro: accion === "dormir" })) return;

  const aviso = $("[data-estado-accion]", panel);
  $$(".boton-accion", panel).forEach(b => b.disabled = true);
  aviso.innerHTML = `<span class="rueda-mini"></span> Enviando la orden…`;
  try {
    const r = await fetch(`/api/nodo/${nombre}/${accion}${accion === "dormir" ? "?forzar=true" : ""}`,
                          { method: "POST" });
    const d = await r.json();
    if (!d.aceptada) { aviso.textContent = d.motivo || "No se pudo lanzar"; sincronizarBotones(); return; }
  } catch {
    aviso.textContent = "Error al contactar con el servidor";
    sincronizarBotones();
    return;
  }
  vigilarAccion(nombre, panel);
}

function vigilarAccion(nombre, panel) {
  clearInterval(vigilando[nombre]);
  const aviso = $("[data-estado-accion]", panel);
  vigilando[nombre] = setInterval(async () => {
    let d;
    try { d = await traer(`/api/nodo/${nombre}/accion`); } catch { return; }
    if (!aviso.isConnected) { clearInterval(vigilando[nombre]); return; }
    const verbo = d.accion === "despertar" ? "Encendiendo" : "Apagando";
    aviso.innerHTML = d.terminada
      ? (d.codigo === 0 ? "Listo." : "Terminó con avisos (mira el registro).")
      : `<span class="rueda-mini"></span> ${verbo} ${nombreBonito(nombre)}… ${d.segundos} s`;
    if (d.terminada) {
      clearInterval(vigilando[nombre]);
      await pintarNodos();
      setTimeout(async () => { await pintarNodos(); }, 5000);
    }
  }, 2000);
}

/* ================== apagado programado del clúster ================== */
async function estadoApagado() {
  const caja = $("#estado-apagado");
  try {
    const d = await traer("/api/cluster/apagado");
    if (!caja) return d;
    if (d.activo) {
      const m = Math.floor(d.restan / 60), s = d.restan % 60;
      caja.innerHTML = `<span class="rueda-mini"></span> Apagado programado: ${m} min ${s} s`;
    } else {
      caja.textContent = { hecho: "El clúster se ha apagado.",
                           cancelado: "Apagado cancelado.",
                           apagando: "Apagando…" }[d.estado] || "";
    }
    return d;
  } catch { return null; }
}

function prepararApagado() {
  const dlg = $("#dialogo-apagado");
  if (!dlg) return;
  let reloj = null;
  const vigilar = () => { clearInterval(reloj); reloj = setInterval(estadoApagado, 1000); };

  cerrarAlPulsarFuera(dlg);
  dlg.addEventListener("close", () => clearInterval(reloj));
  $("#btn-apagar-cluster").onclick = () => { dlg.showModal(); estadoApagado(); vigilar(); };
  $("#cerrar-apagado").onclick = () => dlg.close();

  $("#confirmar-apagado").onclick = async () => {
    const min = +$("#minutos-apagado").value;
    const pi = $("#incluir-pi").checked;
    const texto = pi
      ? `Se apagarán los nodos Y LA PI dentro de ${min} min. La Pi habrá que encenderla a mano. ¿Seguro?`
      : `Se apagarán los nodos de cómputo dentro de ${min} min. ¿Seguro?`;
    if (!await preguntar("¿Programar el apagado?", { texto, aceptar: "Programar", peligro: true })) return;
    await fetch(`/api/cluster/apagar?minutos=${min}&incluir_pi=${pi}`, { method: "POST" });
    estadoApagado(); vigilar();
  };
  $("#cancelar-apagado").onclick = async () => {
    await fetch("/api/cluster/cancelar", { method: "POST" });
    estadoApagado();
  };
}

/* ============ panel de detalle único (abre, cambia y cierra) ============
   Las tarjetas no se mueven: solo cambia la altura de este panel.          */

const ANIM = 400;                 // ms, debe coincidir con la transición del CSS
let nodoActivo = null;
let horasActivas = 6;

const nombreBonito = n => ({ "cluster": "Clúster HPC", "pi-master": "Pi-master",
  "faraday": "Faraday", "mustang": "Mustang" }[n] || n);

function ajustarAlto(fijar = true) {
  const caja = $("#detalle-caja");
  caja.style.height = $("#detalle").offsetHeight + "px";
  clearTimeout(caja._t);
  if (fijar) caja._t = setTimeout(() => { if (nodoActivo) caja.style.height = "auto"; }, ANIM);
}

function cerrarDetalle() {
  const caja = $("#detalle-caja");
  clearTimeout(caja._t);
  caja.style.height = $("#detalle").offsetHeight + "px";
  void caja.offsetHeight;
  requestAnimationFrame(() => { caja.style.height = "0px"; });
  nodoActivo = null;
  DATOS = null;
  $$(".nodo").forEach(t => t.classList.remove("seleccionada"));
  setTimeout(() => { if (!nodoActivo) $("#detalle").innerHTML = ""; }, ANIM);
}

async function pintarSmart() {
  const lista = $("#lista-smart");
  if (!lista) return;
  try {
    const d = await traer("/api/smart");
    lista.innerHTML = "";
    for (const [maquina, estado] of Object.entries(d)) {
      const ok = estado === "ok";
      const li = document.createElement("li");
      li.innerHTML = `<span class="maquina">${nombreBonito(maquina)}</span>
        <span class="estado ${ok ? "" : "mal"}">${ok ? "SMART correcto" : estado}</span>
        <span class="punto ${ok ? "verde" : "ambar"}"></span>`;
      lista.appendChild(li);
    }
    if (!lista.children.length) lista.innerHTML = "<li>Sin datos todavía</li>";
  } catch { lista.innerHTML = "<li>No se pudo consultar el estado</li>"; }
}

async function abrirDetalle(nombre, horas = horasActivas) {
  const caja = $("#detalle-caja");
  const panel = $("#detalle");
  const yaAbierto = !!nodoActivo;
  nodoActivo = nombre;
  horasActivas = horas;
  $$(".nodo").forEach(t => t.classList.toggle("seleccionada", t.dataset.nodo === nombre));

  if (yaAbierto) {
    const viejo = $(".contenido-detalle", panel);
    if (viejo) { viejo.classList.add("cambiando"); await new Promise(r => setTimeout(r, 150)); }
    caja.style.height = panel.offsetHeight + "px";
    clearTimeout(caja._t);
  } else {
    caja.style.height = "0px";
  }

  const conBotones = nombre !== "cluster" && nombre !== "pi-master";
  panel.innerHTML = `<div class="contenido-detalle cambiando">
      <div class="cab-detalle">
        <h2>${nombreBonito(nombre)}</h2>
        <button class="cerrar-tarjeta" title="Cerrar"><svg class="ico"><use href="#i-cerrar"/></svg></button>
      </div>
      ${conBotones ? botonesNodo(nombre) : ""}
      <div class="rango">
        ${[1, 6, 24].map(h => `<button data-horas="${h}" class="${h === horas ? "activo" : ""}">${h} h</button>`).join("")}
      </div>
      <div class="pista" id="pista-grafica"></div>
      <div class="graficas"><div class="grafica"><div class="sin-datos">Cargando…</div></div></div>
    </div>`;

  $$(".rango button", panel).forEach(b => b.onclick = () => abrirDetalle(nombre, +b.dataset.horas));
  $(".cerrar-tarjeta", panel).onclick = cerrarDetalle;
  $$(".boton-accion", panel).forEach(b => b.onclick = () => pedirAccion(nombre, b.dataset.accion, panel));
  requestAnimationFrame(() => $(".contenido-detalle", panel).classList.remove("cambiando"));
  ajustarAlto();

  const graficas = $(".graficas", panel);

  if (nombre === "cluster") {
    const m = ULTIMAS_METRICAS.cluster;
    graficas.innerHTML = m
      ? `<div class="grafica"><div class="cab"><span class="titulo">CPU media</span>
           <span class="ultimo">${m.cpu}%</span></div></div>
         <div class="grafica"><div class="cab"><span class="titulo">RAM del clúster</span>
           <span class="ultimo">${fmt(m.ram_usada)}/${fmt(m.ram_total)} GB</span></div></div>
         <div class="grafica"><div class="cab"><span class="titulo">Máquinas con datos</span>
           <span class="ultimo">${m.maquinas}</span></div></div>`
      : `<div class="grafica"><div class="sin-datos">Sin métricas todavía</div></div>`;
    graficas.insertAdjacentHTML("afterend",
      `<div class="bloque-detalle"><h3>Salud de los discos (SMART)</h3>
         <ul class="lista-discos" id="lista-smart"><li class="cargando">Cargando…</li></ul></div>`);
    ajustarAlto();
    await pintarSmart();
    if (nodoActivo === nombre) { ajustarAlto(); if (!yaAbierto) mostrarEntero(caja); }
    return;
  }

  try {
    const d = await traer(`/api/historico/${nombre}?horas=${horas}`);
    if (d.error) throw new Error(d.error);
    if (nodoActivo !== nombre) return;          // se cambió de nodo mientras cargaba
    d.ms = d.t.map(x => new Date(String(x).replace(" ", "T").replace(/\.\d+/, "")).getTime());
    DATOS = d;
    const ahora = Date.now();
    VENTANA_COMPLETA = { t0: ahora - horas * 3600000, t1: ahora };
    VENTANA = { ...VENTANA_COMPLETA };
    VENTANA_Y = {};
    RANGO_CARGADO = { t0: VENTANA_COMPLETA.t0, t1: ahora, horas };
    RESOLUCION = resolucionDe(d.ms);
    dibujarGraficas();
    prepararInteraccion(graficas);
  } catch {
    graficas.innerHTML = `<div class="grafica"><div class="sin-datos">
      Sin histórico (¿la máquina está dormida o Beszel no la conoce?)</div></div>`;
  }
  if (nodoActivo === nombre) { ajustarAlto(); if (!yaAbierto) mostrarEntero(caja); }
}

/* Tras la animación de apertura, desplaza lo mínimo para que el panel quede a la vista
   (si ya se ve entero, no se mueve nada). Respeta la cabecera fija (scroll-padding). */
function mostrarEntero(caja) {
  setTimeout(() => {
    const r = caja.getBoundingClientRect();
    if (r.bottom > window.innerHeight || r.top < 0) caja.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 450);
}

function prepararDesplegables() {
  for (const tarjeta of $$(".nodo")) {
    const alternar = () => {
      if (nodoActivo === tarjeta.dataset.nodo) cerrarDetalle();
      else abrirDetalle(tarjeta.dataset.nodo);
    };
    tarjeta.addEventListener("click", alternar);
    tarjeta.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternar(); }
    });
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && nodoActivo) cerrarDetalle(); });
  addEventListener("resize", () => { if (nodoActivo) ajustarAlto(); });
}

/* ---------------------------- inicio -------------------------- */
function iniciar() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  AJ = cargarAjustes();
  aplicarAjustes();
  prepararApariencia();
  prepararNavegacion();

  $("#btn-tema").onclick = alternarTema;
  const dlg = $("#dialogo-fondo");
  cerrarAlPulsarFuera(dlg);
  $("#btn-fondo").onclick = () => { pintarControles(); dlg.showModal(); };
  $("#cerrar-fondo").onclick = () => dlg.close();

  prepararDesplegables();
  prepararApagado();
  prepararEnergia();

  pintarReloj(); setInterval(pintarReloj, 1000);
  pintarTiempo(); setInterval(pintarTiempo, 15 * 60 * 1000);

  const refrescar = () => { pintarNodos(); pintarMetricas(); pintarServicios(); pintarEnlaces(); refrescarAvisos(); };
  refrescar();
  pintarMinis(); setInterval(pintarMinis, 60000);
  const refrescarRed = async () => { await pintarResumenRed(); pintarVpn(); pintarBloqueos(); pintarConexion(); };
  refrescarRed(); setInterval(refrescarRed, 60000);
  pintarConsumo(); setInterval(pintarConsumo, 300000);
  $$("#rango-consumo button").forEach(b => b.onclick = () => {
    $$("#rango-consumo button").forEach(x => x.classList.toggle("activo", x === b));
    periodoConsumo = b.dataset.periodo; pintarConsumo();
  });
  prepararRed();
  pintarApps(); setInterval(pintarApps, 60000);
  prepararSeguridad();
  pintarSeguridad(); setInterval(pintarSeguridad, 60000);
  pintarHistorial();
  cargarRed(); setInterval(pintarTrafico, 60000);
  setInterval(refrescar, REFRESCO_MS);
  setInterval(pintarNodos, REFRESCO_NODOS_MS);
}

document.addEventListener("DOMContentLoaded", iniciar);

// El contenido que pasa por debajo de la cabecera se desvanece antes de tocarla
(() => {
  const cab = document.querySelector(".cabecera"), principal = document.querySelector("main");
  if (!cab || !principal) return;
  let pendiente = false;
  const recortar = () => {
    pendiente = false;
    const corte = cab.getBoundingClientRect().bottom + 2 - principal.getBoundingClientRect().top;
    principal.style.setProperty("--corte", `${Math.round(corte)}px`);
  };
  const pedir = () => { if (!pendiente) { pendiente = true; requestAnimationFrame(recortar); } };
  addEventListener("scroll", pedir, { passive: true });
  addEventListener("resize", pedir);
  recortar();
})();
