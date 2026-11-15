#!/usr/bin/env python3
"""
despertador: acceso a servicios que viven en nodos que duermen.

  GET /abrir/<servicio>     si el servicio está listo, redirige; si no, despierta su nodo
                            y muestra una página de espera que redirige sola al estar listo
  GET /api/servicio/<svc>   estado de un servicio (JSON, lo usa la página de espera)
  GET /api/nodos            estado de los nodos (JSON, para el widget customapi de Homepage)
  GET /                     lista de servicios

Además, por cada servicio abre un puerto en la Pi que reenvía las conexiones al nodo.
Si por ese puerto pasa tráfico real, marca la anotación power/last-activity en el nodo
para que el controlador de energía no lo duerma. Una conexión con el nodo dormido se
rechaza SIN despertarlo, salvo que el servicio tenga 'despertar_al_conectar: true'.
"""
import asyncio
import calendar
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
import yaml
import json
import glob
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

CONFIG = Path(os.environ.get("DESPERTADOR_CONFIG", "/etc/despertador/servicios.yaml"))
NODO_BIN = os.environ.get("NODO_BIN", "/usr/local/bin/nodo")
PUERTO_WEB = int(os.environ.get("PUERTO_WEB", "8095"))
UMBRAL_BYTES = int(os.environ.get("UMBRAL_BYTES", "20000"))   # bytes por minuto para contar como "uso"

# --- Beszel (métricas históricas). Credenciales en /etc/default/despertador ---
BESZEL_URL = os.environ.get("BESZEL_URL", "http://127.0.0.1:8090").rstrip("/")
BESZEL_USUARIO = os.environ.get("BESZEL_USUARIO", "")
BESZEL_CLAVE = os.environ.get("BESZEL_CLAVE", "")
CACHE_SEG = 20                      # segundos de caché para las métricas actuales
REPETIR_DESPERTAR = 240                                          # s antes de reenviar un despertar
MARGEN_TRAS_CAIDA = int(os.environ.get("MARGEN_TRAS_CAIDA", "120"))  # s sin despertar por conexión
                                                                     # tras perder el servicio
DEVNULL = asyncio.subprocess.DEVNULL

cfg = yaml.safe_load(CONFIG.read_text())
NODOS: dict = cfg.get("nodos", {})
SERVICIOS: dict = cfg["servicios"]
ENLACES: list = cfg.get("enlaces", [])      # accesos rápidos del panel
APPS: list = cfg.get("apps", [])            # aplicaciones propias desplegadas en K3s
PARES_VPN: dict = {str(k): v for k, v in (cfg.get("pares_vpn") or {}).items()}   # IP -> nombre
INTERFACES_RED: list = cfg.get("interfaces_red", ["eth0", "wg0"])

# Cuándo una conexión (p. ej. la app de Immich del móvil) NO debe despertar un nodo:
#   energia:
#     respetar_apagado_min: 20        # tras dormirlo desde el panel, durante 20 min
#     silencio: "00:30-08:00"         # y en esta franja horaria (hora de la Pi)
# Lo que se pide a propósito (botón de encender, abrir el servicio desde el panel) sí lo despierta.
ENERGIA: dict = cfg.get("energia") or {}
RESPETAR_APAGADO = int(ENERGIA.get("respetar_apagado_min", 20)) * 60
SILENCIO = str(ENERGIA.get("silencio", "") or "")
DORMIDO_A_MANO: dict = {}     # nodo -> cuándo se durmió desde el panel
DESPERTARES: dict = {}        # nodo -> {"cuando", "motivo"} del último despertar pedido por el panel o una conexión


def _en_silencio(ahora: float | None = None) -> bool:
    try:
        ini, fin = (int(h) * 60 + int(m) for h, m in (x.split(":") for x in SILENCIO.split("-")))
    except ValueError:
        return False
    t = time.localtime(ahora or time.time())
    minuto = t.tm_hour * 60 + t.tm_min
    return ini <= minuto < fin if ini <= fin else (minuto >= ini or minuto < fin)   # puede cruzar la medianoche


def motivo_para_no_despertar(nodo: str) -> str:
    """Por qué una conexión automática no debe despertar este nodo ahora ("" = sí puede)."""
    desde = DORMIDO_A_MANO.get(nodo, 0)
    if time.time() - desde < RESPETAR_APAGADO:
        return f"lo dormiste desde el panel hace {int((time.time() - desde) / 60)} min"
    if SILENCIO and _en_silencio():
        return f"horas de silencio ({SILENCIO})"
    return ""


class Estado:
    def __init__(self):
        self.bytes = 0
        self.conexiones = 0
        self.ultimo_trafico = 0.0     # cuándo pasó tráfico de verdad (para anotar la actividad con su hora real)
        self.despertando_desde = 0.0
        self.ultimo_ok = 0.0          # última vez que el servicio aceptó una conexión


ESTADO = {clave: Estado() for clave in SERVICIOS}


# ----------------------------- utilidades -----------------------------
async def ejecutar(*args) -> bool:
    try:
        p = await asyncio.create_subprocess_exec(*args, stdout=DEVNULL, stderr=DEVNULL)
        return await p.wait() == 0
    except FileNotFoundError:
        return False


async def ping(ip: str) -> bool:
    return await ejecutar("ping", "-c1", "-W1", ip)


def destino(svc) -> tuple[str, int]:
    host, puerto = svc["destino"].rsplit(":", 1)
    return host, int(puerto)


async def listo(svc) -> bool:
    """El servicio responde por HTTP con un código < 500."""
    host, puerto = destino(svc)
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(host, puerto), 2)
        ruta = svc.get("comprobacion", "/")
        w.write(f"GET {ruta} HTTP/1.0\r\nHost: {host}\r\n\r\n".encode())
        await w.drain()
        linea = await asyncio.wait_for(r.readline(), 3)
        w.close()
        return int(linea.split()[1]) < 500
    except Exception:
        return False


async def marcar_actividad(nodo: str, cuando: float | None = None):
    # "cuando" = la hora real del uso. El tráfico se anota por minutos y, sin esto, el del minuto
    # anterior a un apagado quedaba con hora posterior: `nodo` creía que alguien había pedido el
    # servicio y no volvía a apagar un nodo que se había reencendido solo.
    await ejecutar("kubectl", "annotate", "node", nodo,
                   f"power/last-activity={int(cuando or time.time())}", "--overwrite")


async def despertar(clave: str, motivo: str = ""):
    svc, st = SERVICIOS[clave], ESTADO[clave]
    if time.time() - st.despertando_desde < REPETIR_DESPERTAR:
        return
    st.despertando_desde = time.time()
    DORMIDO_A_MANO.pop(svc["nodo"], None)
    DESPERTARES[svc["nodo"]] = {"cuando": int(time.time()), "motivo": motivo or svc.get("nombre", clave)}
    print(f"[{clave}] despertando el nodo {svc['nodo']}" + (f" ({motivo})" if motivo else ""), flush=True)
    await marcar_actividad(svc["nodo"])
    try:
        await asyncio.create_subprocess_exec(NODO_BIN, "despertar", svc["nodo"],
                                             stdout=DEVNULL, stderr=DEVNULL,
                                             start_new_session=True)
    except FileNotFoundError:
        print(f"ERROR: no encuentro {NODO_BIN}", flush=True)


def url_publica(request: Request, svc) -> str:
    # Si el servicio se publica por Traefik (p. ej. https://archivos…), esa es su dirección;
    # si no, la misma IP por la que ha entrado el usuario (LAN o VPN) y su puerto.
    if svc.get("url"):
        return svc["url"]
    return f"http://{request.url.hostname}:{svc['puerto']}{svc.get('ruta', '/')}"


# ----------------------------- reenvío TCP -----------------------------
async def tuberia(origen, destino_w, st: Estado):
    try:
        while True:
            datos = await origen.read(65536)
            if not datos:
                break
            st.bytes += len(datos)
            st.ultimo_trafico = time.time()
            destino_w.write(datos)
            await destino_w.drain()
        if destino_w.can_write_eof():
            destino_w.write_eof()
    except Exception:
        pass


def _leer_peticion(datos: bytes) -> tuple[str, str, str]:
    """De lo primero que envía el cliente (HTTP, p. ej. Traefik → despertador): "MÉTODO ruta",
    la IP real (X-Forwarded-For, que añade Traefik) y el programa (User-Agent)."""
    try:
        lineas = datos.decode("latin-1").split("\r\n")
    except Exception:
        return "", "", ""
    primera = lineas[0].split(" ")
    if len(primera) < 2 or not primera[0].isalpha():
        return "", "", ""                       # no es HTTP (o va cifrado): no se puede mirar
    cab = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lineas[1:] if ":" in l)}
    return (f"{primera[0]} {primera[1][:100]}", cab.get("x-forwarded-for", "").split(",")[0].strip(),
            cab.get("user-agent", "")[:60])


async def cliente(reader, writer, clave: str):
    svc, st = SERVICIOS[clave], ESTADO[clave]
    host, puerto = destino(svc)
    try:
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(host, puerto), 3)
    except Exception:
        peticion = real = agente = ""
        if svc.get("despertar_al_conectar"):
            # Antes de decidir, se mira QUÉ pide (si es HTTP): una comprobación automática de la
            # app no debe despertar el nodo; abrir la galería o subir fotos, sí.
            try:
                peticion, real, agente = _leer_peticion(await asyncio.wait_for(reader.read(4096), 1.5))
            except Exception:
                pass
        writer.close()                      # nodo dormido o servicio caído: se rechaza
        if svc.get("despertar_al_conectar"):
            # p. ej. la app de Immich al abrirse (con la copia en segundo plano desactivada)
            quien = writer.get_extra_info("peername")
            origen = real or (f"{quien[0]}:{quien[1]}" if quien else "desconocido")
            if peticion:
                origen += f" · {peticion}" + (f" · {agente}" if agente else "")
            espera = time.time() - st.ultimo_ok
            if espera < MARGEN_TRAS_CAIDA:
                # reintentos sueltos justo después de apagar el nodo: se ignoran
                print(f"[{clave}] conexión desde {origen} ignorada "
                      f"(servicio caído hace {int(espera)} s)", flush=True)
                return
            ruta = peticion.split(" ", 1)[1] if " " in peticion else ""
            if ruta and any(ruta.startswith(r) for r in svc.get("no_despiertan", []) or []):
                print(f"[{clave}] conexión desde {origen} con el servicio caído: no lo despierto "
                      f"(comprobación automática)", flush=True)
                return
            no = motivo_para_no_despertar(svc["nodo"])
            if no:
                print(f"[{clave}] conexión desde {origen} con el servicio caído: no lo despierto ({no})", flush=True)
                return
            print(f"[{clave}] conexión desde {origen} con el servicio caído → despertar", flush=True)
            await despertar(clave, f"{agente or 'conexión'} pidió {ruta or svc.get('nombre', clave)}"
                                   f" desde {real or (quien[0] if quien else 'desconocido')}")
        return
    st.conexiones += 1
    st.ultimo_ok = time.time()
    try:
        await asyncio.gather(tuberia(reader, up_w, st), tuberia(up_r, writer, st))
    finally:
        st.conexiones -= 1
        for w in (writer, up_w):
            try:
                w.close()
            except Exception:
                pass


async def vigilar_actividad():
    while True:
        await asyncio.sleep(60)
        filas = []
        for clave, st in ESTADO.items():
            if st.bytes >= UMBRAL_BYTES:
                await marcar_actividad(SERVICIOS[clave]["nodo"], st.ultimo_trafico)
            if st.bytes:
                filas.append((clave, int(time.time()), st.bytes))
            st.bytes = 0
        if filas:
            try:
                await asyncio.to_thread(_guardar_filas, "INSERT OR REPLACE INTO apps VALUES (?, ?, ?)", filas)
            except Exception as e:
                print(f"[apps] no se pudo guardar: {e}", flush=True)


@asynccontextmanager
async def lifespan(app):
    servidores = []
    for clave, svc in SERVICIOS.items():
        s = await asyncio.start_server(lambda r, w, c=clave: cliente(r, w, c), "0.0.0.0", svc["puerto"])
        servidores.append(s)
        print(f"[{clave}] reenviando :{svc['puerto']} → {svc['destino']} (nodo {svc['nodo']})", flush=True)
    tarea = asyncio.create_task(vigilar_actividad())
    tareas_red = [asyncio.create_task(f()) for f in
                  (vigilar_trafico, vigilar_vpn, vigilar_conexion, vigilar_ip_publica, vigilar_pods,
                   vigilar_seguridad, vigilar_encendido, vigilar_metricas)]
    yield
    tarea.cancel()
    for t in tareas_red:
        t.cancel()
    for s in servidores:
        s.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def sin_copias_viejas(request: Request, call_next):
    """La página y sus ficheros se revalidan siempre (304 si no han cambiado).
    Sin esto el navegador del móvil se quedaba con estilo.css/panel.js viejos
    tras desplegar."""
    respuesta = await call_next(request)
    ruta = request.url.path
    if ruta == "/" or ruta.startswith(("/static/", "/v/")):
        respuesta.headers.setdefault("Cache-Control", "no-cache")
    return respuesta

ESTATICOS = Path(__file__).parent / "static"
if ESTATICOS.is_dir():
    app.mount("/static", StaticFiles(directory=ESTATICOS), name="static")

# El panel como app del móvil (PWA): el manifiesto y el service worker deben
# servirse desde la raíz para que su alcance sea todo el panel.
from fastapi.responses import FileResponse


@app.get("/manifest.webmanifest", include_in_schema=False)
async def manifiesto():
    return FileResponse(ESTATICOS / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse(ESTATICOS / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache"})


# Versiones anteriores del panel, para comparar o volver atrás:
#   /opt/despertador/versiones/v1/  ->  https://panel.../v/v1/
VERSIONES = Path(__file__).parent / "versiones"
if VERSIONES.is_dir():
    for carpeta in sorted(VERSIONES.iterdir()):
        if carpeta.is_dir() and (carpeta / "index.html").is_file():
            app.mount(f"/v/{carpeta.name}", StaticFiles(directory=carpeta, html=True), name=f"v-{carpeta.name}")


# ----------------------------- páginas y API -----------------------------
def svc_o_404(clave: str):
    if clave not in SERVICIOS:
        raise HTTPException(404, f"Servicio desconocido: {clave}")
    return SERVICIOS[clave]


@app.get("/abrir/{clave}")
async def abrir(clave: str, request: Request):
    svc = svc_o_404(clave)
    if await listo(svc):
        await marcar_actividad(svc["nodo"])
        return RedirectResponse(url_publica(request, svc), status_code=302)
    await despertar(clave, f"{svc.get('nombre', clave)} abierto desde el panel")
    return HTMLResponse(PAGINA_ESPERA.replace("{{CLAVE}}", clave)
                        .replace("{{NOMBRE}}", svc.get("nombre", clave))
                        .replace("{{NODO}}", svc["nodo"].capitalize()))


@app.get("/api/servicio/{clave}")
async def api_servicio(clave: str, request: Request):
    svc = svc_o_404(clave)
    ip = NODOS.get(svc["nodo"])
    esta_listo = await listo(svc)
    return {
        "servicio": clave,
        "nodo": svc["nodo"],
        "nodo_despierto": await ping(ip) if ip else None,
        "listo": esta_listo,
        "conexiones": ESTADO[clave].conexiones,
        "url": url_publica(request, svc),
    }


@app.get("/api/nodos")
async def api_nodos():
    nombres = list(NODOS)
    vivos = await asyncio.gather(*(ping(NODOS[n]) for n in nombres))
    return JSONResponse({n: ("despierto" if v else "dormido") for n, v in zip(nombres, vivos)})


# ============================ Beszel ============================
# Beszel guarda el histórico (CPU, RAM, disco, red, temperatura) en PocketBase.
# Aquí se consulta su API REST y se normaliza, porque los nombres de campo son
# abreviados y pueden cambiar entre versiones.

_sesion = {"token": "", "caduca": 0.0}
_cache = {"metricas": (0.0, {}), "sistemas": (0.0, {})}

CAMPOS = {                      # nombre nuestro -> posibles nombres en Beszel
    "cpu":         ["cpu"],
    "ram_pct":     ["mp"],
    "ram_total":   ["m"],
    "ram_usada":   ["mu"],
    "disco_pct":   ["dp"],
    "disco_total": ["d"],
    "disco_usado": ["du"],
    "swap_total":  ["s"],
    "swap_usada":  ["su"],
    "temp":        ["t", "temps"],
    "red":         ["b"],           # [subida, bajada] en bytes/s → se pasa a KB/s
    "carga":       ["la"],          # [1 min, 5 min, 15 min]
    "ventilador":  ["f"],           # {sensor: rpm}
}

# Sensores de temperatura preferidos (el resto, como los ADC de la Pi, engañan)
TEMP_PREFERIDAS = ("cpu", "package", "core", "tctl", "tdie", "k10temp", "coretemp", "soc")


def _peticion(ruta: str, datos: dict | None = None, token: str = "") -> dict:
    url = f"{BESZEL_URL}{ruta}"
    cuerpo = json.dumps(datos).encode() if datos is not None else None
    pet = urllib.request.Request(url, data=cuerpo, method="POST" if datos else "GET")
    pet.add_header("Content-Type", "application/json")
    if token:
        pet.add_header("Authorization", token)
    with urllib.request.urlopen(pet, timeout=8) as r:
        return json.loads(r.read())


async def _token() -> str:
    if _sesion["token"] and time.time() < _sesion["caduca"]:
        return _sesion["token"]
    if not (BESZEL_USUARIO and BESZEL_CLAVE):
        raise RuntimeError("faltan BESZEL_USUARIO / BESZEL_CLAVE en /etc/default/despertador")
    d = await asyncio.to_thread(_peticion, "/api/collections/users/auth-with-password",
                                {"identity": BESZEL_USUARIO, "password": BESZEL_CLAVE})
    _sesion["token"] = d["token"]
    _sesion["caduca"] = time.time() + 3000        # el token dura bastante más
    return _sesion["token"]


async def _consultar(coleccion: str, **params) -> list:
    t = await _token()
    q = urllib.parse.urlencode(params)
    d = await asyncio.to_thread(_peticion, f"/api/collections/{coleccion}/records?{q}", None, t)
    return d.get("items", [])


def _valor(datos: dict, campo: str):
    for clave in CAMPOS[campo]:
        if clave not in datos:
            continue
        v = datos[clave]
        if campo == "temp" and isinstance(v, dict):
            if not v:
                return None
            # primero un sensor de CPU; si no hay, el más caliente
            for nombre, grados in v.items():
                if any(p in nombre.lower() for p in TEMP_PREFERIDAS):
                    return round(grados, 1)
            return round(max(v.values()), 1)
        if campo == "red" and isinstance(v, (list, tuple)) and len(v) >= 2:
            return round((v[0] + v[1]) / 1024, 2)      # KB/s totales
        if campo == "carga" and isinstance(v, (list, tuple)) and v:
            return v[0]
        if campo == "ventilador" and isinstance(v, dict):
            return round(max(v.values())) if v else None
        return v
    return None


def _normalizar(stats: dict) -> dict:
    m = {c: _valor(stats, c) for c in CAMPOS}
    if m.get("cpu") is not None:
        m["cpu"] = round(m["cpu"], 1)
    return m


async def _sistemas() -> dict:
    """nombre del sistema -> id en Beszel (con caché)."""
    edad, datos = _cache["sistemas"]
    if time.time() - edad < 300 and datos:
        return datos
    items = await _consultar("systems", perPage=50, fields="id,name,status")
    datos = {i["name"]: i["id"] for i in items}
    _cache["sistemas"] = (time.time(), datos)
    return datos


@app.get("/api/metricas")
async def api_metricas():
    """Últimos valores de cada máquina + agregado del clúster."""
    edad, datos = _cache["metricas"]
    if time.time() - edad < CACHE_SEG and datos:
        return JSONResponse(datos)
    salida = {}
    try:
        for nombre, sid in (await _sistemas()).items():
            items = await _consultar("system_stats", perPage=1, sort="-created",
                                     filter=f"system='{sid}' && type='1m'")
            if items:
                salida[nombre] = _normalizar(items[0].get("stats", {}))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=503)

    # agregado del clúster: CPU media y RAM sumada de las máquinas con datos
    vivos = [m for m in salida.values() if m.get("cpu") is not None]
    if vivos:
        salida["cluster"] = {
            "cpu": round(sum(m["cpu"] for m in vivos) / len(vivos), 1),
            "ram_usada": round(sum(m.get("ram_usada") or 0 for m in vivos), 1),
            "ram_total": round(sum(m.get("ram_total") or 0 for m in vivos), 1),
            "maquinas": len(vivos),
        }
    _cache["metricas"] = (time.time(), salida)
    return JSONResponse(salida)


# Beszel solo guarda detalle fino del último día (luego, un punto cada 2 h y cada 8 h).
# El panel guarda su propia muestra cada 5 min durante 90 días para ver bien los días pasados.
METRICAS_PROPIAS = ("cpu", "temp", "ram_pct", "disco_pct", "red", "carga", "ram_usada", "ram_total")
RETENCION_METRICAS = 90 * 86400


def _guardar_metricas(filas):
    with _bd() as con:
        for col in ("ram_usada", "ram_total"):              # columnas añadidas después de crear la tabla
            try:
                con.execute(f"ALTER TABLE metricas ADD COLUMN {col} REAL")
            except sqlite3.OperationalError:
                pass                                        # ya existía
        con.executemany(f"INSERT OR REPLACE INTO metricas (nodo, t, {', '.join(METRICAS_PROPIAS)}) "
                        f"VALUES (?, ?, {', '.join('?' * len(METRICAS_PROPIAS))})", filas)
        con.execute("DELETE FROM metricas WHERE t < ?", (int(time.time()) - RETENCION_METRICAS,))


async def vigilar_metricas():
    """Cada 5 min, la última muestra de Beszel de cada máquina (si es reciente: un nodo dormido no cuenta)."""
    while True:
        try:
            filas, ahora = [], int(time.time())
            for nombre, sid in (await _sistemas()).items():
                items = await _consultar("system_stats", perPage=1, sort="-created",
                                         filter=f"system='{sid}' && type='1m'")
                if not items:
                    continue
                creado = calendar.timegm(time.strptime(str(items[0]["created"])[:19], "%Y-%m-%d %H:%M:%S"))
                if ahora - creado > 180:
                    continue
                m = _normalizar(items[0].get("stats", {}))
                filas.append((nombre, ahora - ahora % 300, *(m.get(c) for c in METRICAS_PROPIAS)))
            if filas:
                await asyncio.to_thread(_guardar_metricas, filas)
        except Exception as e:
            print(f"[métricas] no se pudo guardar: {e}", flush=True)
        await asyncio.sleep(300)


def _metricas_propias(maquina: str, desde: int, hasta: int) -> list:
    with _bd() as con:
        for col in ("ram_usada", "ram_total"):
            try:
                con.execute(f"ALTER TABLE metricas ADD COLUMN {col} REAL")
            except sqlite3.OperationalError:
                pass
        return con.execute(f"SELECT t, {', '.join(METRICAS_PROPIAS)} FROM metricas "
                           "WHERE nodo = ? AND t BETWEEN ? AND ? ORDER BY t", (maquina, desde, hasta)).fetchall()


@app.get("/api/historico/{maquina}")
async def api_historico(maquina: str, horas: int = 6, desde: int = 0, hasta: int = 0):
    """Series temporales para las gráficas: las últimas `horas`, o la ventana desde/hasta (epoch)."""
    ahora = int(time.time())
    if desde:
        hasta = min(hasta or ahora, ahora)
        horas = max(1, min(720, -(-(ahora - desde) // 3600)))
    else:
        horas = max(1, min(horas, 720))            # como mucho, un mes
        desde, hasta = ahora - horas * 3600, ahora
    # Más allá de un día, las muestras propias (5 min) valen más que las de Beszel (2 h u 8 h)
    if horas > 24:
        filas = await asyncio.to_thread(_metricas_propias, maquina, desde, hasta)
        if len(filas) >= 6:
            series = {"t": [time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(f[0])) for f in filas], "fuente": "panel"}
            for i, c in enumerate(METRICAS_PROPIAS, start=1):
                series[c] = [f[i] for f in filas]
            return JSONResponse(series)
    # Beszel agrega los datos: cuanto más lejos se mira, menos resolución hace falta.
    # (guarda alrededor de un mes de histórico)
    tipo = ("1m"   if horas <= 2   else
            "10m"  if horas <= 12  else
            "20m"  if horas <= 48  else
            "120m" if horas <= 168 else
            "480m")
    d_txt = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(desde))
    h_txt = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(hasta))
    try:
        sid = (await _sistemas()).get(maquina)
        if not sid:
            raise HTTPException(404, f"Beszel no conoce la máquina '{maquina}'")
        items = await _consultar("system_stats", perPage=500, sort="created",
                                 filter=f"system='{sid}' && type='{tipo}' && created>='{d_txt}' && created<='{h_txt}'")
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=503)

    series = {"t": [], "cpu": [], "temp": [], "ram_pct": [], "ram_usada": [], "ram_total": [],
              "disco_pct": [], "red": [], "carga": []}
    for it in items:
        m = _normalizar(it.get("stats", {}))
        series["t"].append(it.get("created", ""))
        for c in ("cpu", "temp", "ram_pct", "ram_usada", "ram_total", "disco_pct", "red", "carga"):
            series[c].append(m.get(c))
    return JSONResponse(series)


@app.get("/api/beszel/diagnostico")
async def api_beszel_diagnostico():
    """Muestra los campos tal cual los devuelve Beszel (para ajustar la traducción)."""
    try:
        sistemas = await _sistemas()
        salida = {"sistemas": list(sistemas)}
        if sistemas:
            sid = next(iter(sistemas.values()))
            items = await _consultar("system_stats", perPage=1, sort="-created", filter=f"system='{sid}'")
            if items:
                salida["ejemplo_stats"] = items[0].get("stats", {})
                salida["traducido"] = _normalizar(items[0].get("stats", {}))
        return JSONResponse(salida)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=503)


# ==================== acciones sobre los nodos ====================
# El panel está detrás de Authelia y el puerto 8095 no es accesible desde fuera
# del clúster, así que estas acciones solo las puede lanzar quien se ha identificado.

_acciones = {}          # nodo -> {"accion": ..., "desde": ts, "salida": str}


async def _lanzar_nodo(nodo: str, accion: str, forzar: bool = False):
    args = [NODO_BIN, accion, nodo] + (["-f"] if (accion == "dormir" and forzar) else [])
    p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                             stderr=asyncio.subprocess.STDOUT)
    salida, _ = await p.communicate()
    _acciones[nodo] = {"accion": accion, "desde": time.time(),
                       "salida": salida.decode(errors="replace")[-2000:], "codigo": p.returncode}


@app.post("/api/nodo/{nodo}/{accion}")
async def api_accion_nodo(nodo: str, accion: str, forzar: bool = False):
    if nodo not in NODOS:
        raise HTTPException(404, f"Nodo desconocido: {nodo}")
    if accion not in ("despertar", "dormir"):
        raise HTTPException(400, "Acción no válida")
    if nodo in _acciones and time.time() - _acciones[nodo]["desde"] < 20:
        return JSONResponse({"aceptada": False, "motivo": "hay una acción en curso"}, status_code=409)

    _acciones[nodo] = {"accion": accion, "desde": time.time(), "salida": "", "codigo": None}
    if accion == "dormir":
        DORMIDO_A_MANO[nodo] = time.time()          # las conexiones automáticas lo respetarán un rato
    else:
        DORMIDO_A_MANO.pop(nodo, None)
        DESPERTARES[nodo] = {"cuando": int(time.time()), "motivo": "botón de encender del panel"}
    asyncio.create_task(_lanzar_nodo(nodo, accion, forzar))   # en segundo plano: tarda minutos
    print(f"[{nodo}] acción '{accion}' solicitada desde el panel", flush=True)
    return {"aceptada": True, "nodo": nodo, "accion": accion}


@app.get("/api/nodo/{nodo}/accion")
async def api_estado_accion(nodo: str):
    """Cómo va la última acción pedida sobre ese nodo (lo consulta el panel)."""
    if nodo not in NODOS:
        raise HTTPException(404, f"Nodo desconocido: {nodo}")
    a = _acciones.get(nodo)
    vivo = await ping(NODOS[nodo])
    if not a:
        return {"nodo": nodo, "encendido": vivo, "accion": None}
    return {"nodo": nodo, "encendido": vivo, "accion": a["accion"],
            "segundos": int(time.time() - a["desde"]),
            "terminada": a["codigo"] is not None,
            "codigo": a["codigo"], "salida": a["salida"]}


# ==================== apagado del clúster ====================
# Apaga los nodos (y opcionalmente la propia Pi) tras una espera, con opción
# de cancelar mientras tanto.

_apagado = {"tarea": None, "cuando": 0.0, "incluir_pi": False, "estado": "inactivo"}


async def _apagar_cluster(espera: int, incluir_pi: bool):
    try:
        await asyncio.sleep(espera)
        _apagado["estado"] = "apagando"
        for n in NODOS:
            print(f"[clúster] apagando {n}", flush=True)
            p = await asyncio.create_subprocess_exec(NODO_BIN, "dormir", n, "-f",
                                                     stdout=DEVNULL, stderr=DEVNULL)
            await p.wait()
        if incluir_pi:
            print("[clúster] apagando la Pi", flush=True)
            await ejecutar("sudo", "-n", "/usr/sbin/poweroff")
        _apagado["estado"] = "hecho"
    except asyncio.CancelledError:
        _apagado["estado"] = "cancelado"
        print("[clúster] apagado cancelado", flush=True)


@app.post("/api/cluster/apagar")
async def api_cluster_apagar(minutos: int = 5, incluir_pi: bool = False):
    if _apagado["tarea"] and not _apagado["tarea"].done():
        return JSONResponse({"aceptada": False, "motivo": "ya hay un apagado programado"}, status_code=409)
    minutos = max(0, min(minutos, 120))
    _apagado.update(cuando=time.time() + minutos * 60, incluir_pi=incluir_pi, estado="programado")
    _apagado["tarea"] = asyncio.create_task(_apagar_cluster(minutos * 60, incluir_pi))
    print(f"[clúster] apagado programado en {minutos} min (incluir Pi: {incluir_pi})", flush=True)
    return {"aceptada": True, "minutos": minutos, "incluir_pi": incluir_pi}


@app.post("/api/cluster/cancelar")
async def api_cluster_cancelar():
    t = _apagado["tarea"]
    if t and not t.done():
        t.cancel()
        return {"cancelado": True}
    return {"cancelado": False, "motivo": "no había nada programado"}


@app.get("/api/cluster/apagado")
async def api_cluster_estado():
    t = _apagado["tarea"]
    activo = bool(t and not t.done())
    return {"activo": activo,
            "estado": _apagado["estado"],
            "restan": max(0, int(_apagado["cuando"] - time.time())) if activo else 0,
            "incluir_pi": _apagado["incluir_pi"]}


# ============================ avisos ============================
# Revisa todo lo que puede ir mal y lo devuelve ordenado por gravedad.
# Cada aviso recuerda cuándo se vio por primera vez ("desde").

HOME = Path("/home/raspberrypi")
CERTIFICADO = Path(os.environ.get("CERTIFICADO", str(HOME / "certs/hpc.crt")))
DIR_SECRETOS = Path(os.environ.get("DIR_SECRETOS", str(HOME / "hpc-secretos")))

# servicios que deben estar activos: (unidad, gravedad si no lo están, descripción)
SERVICIOS_CLAVE = [
    ("nodo-controlador.service", "critico", "Controlador de energía"),
    ("wg-quick@wg0.service",     "critico", "VPN (WireGuard)"),
    ("k3s.service",              "critico", "Kubernetes (K3s)"),
    ("duckdns.timer",            "aviso",   "Actualización del DDNS"),
    ("hpc-backup.timer",         "aviso",   "Copia de seguridad diaria"),
    ("revisar-smart.timer",      "aviso",   "Vigilancia de discos"),
    ("recoger-smart.timer",      "aviso",   "Recogida de datos de discos"),
]
ORDEN = {"critico": 0, "aviso": 1, "info": 2}
_vistos: dict = {}
_cache_avisos = {"t": 0.0, "datos": None}


async def _salida(*args, timeout: float = 8) -> tuple[int, str]:
    try:
        p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
        return p.returncode, out.decode(errors="replace").strip()
    except Exception:
        return 1, ""


def _aviso(clave, nivel, titulo, detalle="", origen=""):
    return {"clave": clave, "nivel": nivel, "titulo": titulo, "detalle": detalle, "origen": origen}


async def _revisar_servicios():
    salida = []
    for unidad, nivel, nombre in SERVICIOS_CLAVE:
        _, estado = await _salida("systemctl", "is-active", unidad)
        if estado != "active":
            salida.append(_aviso(f"svc:{unidad}", nivel, f"{nombre} no está activo",
                                 f"{unidad}: {estado or 'desconocido'}", "Sistema"))
    for unidad in ("duckdns.service", "hpc-backup.service", "revisar-smart.service", "recoger-smart.service"):
        _, fallo = await _salida("systemctl", "is-failed", unidad)
        if fallo == "failed":
            salida.append(_aviso(f"fallo:{unidad}", "aviso", f"La última ejecución de {unidad} falló",
                                 f"journalctl -u {unidad} -n 20", "Sistema"))
    return salida


async def _revisar_cluster(vivos: dict):
    salida = []
    cod, txt = await _salida("kubectl", "get", "nodes", "-o", "json")
    if cod != 0:
        return [_aviso("k8s:api", "critico", "No se puede consultar Kubernetes", "kubectl get nodes falló", "Clúster")]
    for n in json.loads(txt).get("items", []):
        nombre = n["metadata"]["name"]
        listo = any(c["type"] == "Ready" and c["status"] == "True"
                    for c in n.get("status", {}).get("conditions", []))
        if listo:
            continue
        if nombre not in NODOS:                     # la Pi (el máster)
            salida.append(_aviso(f"k8s:nodo:{nombre}", "critico", f"{nombre} no está Ready en K3s", "", "Clúster"))
        elif vivos.get(nombre):                     # encendido pero K3s no lo ve
            salida.append(_aviso(f"k8s:nodo:{nombre}", "aviso",
                                 f"{nombre.capitalize()} está encendido pero no está listo en K3s",
                                 "puede estar arrancando; si dura, revisar k3s-agent", "Clúster"))

    cod, txt = await _salida("kubectl", "get", "pods", "-A", "-o", "json")
    if cod == 0:
        malos = []
        for p in json.loads(txt).get("items", []):
            nodo = p.get("spec", {}).get("nodeName", "")
            if nodo in NODOS and not vivos.get(nodo):
                continue                            # su nodo duerme: es lo esperado
            for cs in p.get("status", {}).get("containerStatuses", []) or []:
                razon = (cs.get("state", {}).get("waiting") or {}).get("reason", "")
                if razon in ("CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError"):
                    malos.append(f"{p['metadata']['namespace']}/{p['metadata']['name']} ({razon})")
        if malos:
            salida.append(_aviso("k8s:pods", "aviso", f"{len(malos)} pod(s) con problemas",
                                 ", ".join(malos[:4]) + ("…" if len(malos) > 4 else ""), "Clúster"))
    return salida


async def _revisar_certificado():
    if not CERTIFICADO.is_file():
        return [_aviso("cert:falta", "aviso", "No se encuentra el certificado", str(CERTIFICADO), "Seguridad")]
    cod, txt = await _salida("openssl", "x509", "-enddate", "-noout", "-in", str(CERTIFICADO))
    if cod != 0 or "=" not in txt:
        return []
    import email.utils
    try:
        caduca = email.utils.parsedate_to_datetime(txt.split("=", 1)[1].replace(" GMT", " +0000")).timestamp()
    except Exception:
        return []
    dias = int((caduca - time.time()) / 86400)
    if dias < 14:
        return [_aviso("cert", "critico", f"El certificado caduca en {dias} días",
                       "acme.sh no lo está renovando: revisar su tarea programada", "Seguridad")]
    if dias < 25:
        return [_aviso("cert", "aviso", f"El certificado caduca en {dias} días",
                       "debería haberse renovado ya", "Seguridad")]
    return []


async def _revisar_copias():
    salida = []
    # Cuándo se EJECUTÓ la copia por última vez (el repositorio solo cambia si hay cambios,
    # así que la fecha del último commit no sirve para saber si la copia está al día).
    _, txt = await _salida("systemctl", "show", "hpc-backup.service", "-p", "ExecMainExitTimestamp",
                           "--value", "--timestamp=unix")
    _, codigo = await _salida("systemctl", "show", "hpc-backup.service", "-p", "ExecMainStatus", "--value")
    if txt.startswith("@"):
        horas = (time.time() - int(txt[1:])) / 3600
        if horas > 72:
            salida.append(_aviso("copia", "critico" if horas > 24 * 7 else "aviso",
                                 f"La copia no se ejecuta desde hace {int(horas / 24)} días",
                                 "revisar hpc-backup.timer", "Copias"))
        elif codigo not in ("", "0"):
            salida.append(_aviso("copia", "aviso", "La última copia terminó con error",
                                 "journalctl -u hpc-backup -n 30", "Copias"))
    else:
        salida.append(_aviso("copia", "info", "No consta ninguna ejecución de la copia",
                             "se lanza cada noche; o a mano con hpc-copia", "Copias"))

    if DIR_SECRETOS.is_dir():
        ficheros = list(DIR_SECRETOS.glob("*.gpg"))
        if ficheros:
            dias = (time.time() - max(f.stat().st_mtime for f in ficheros)) / 86400
            if dias > 60:
                salida.append(_aviso("secretos", "info", f"Los secretos cifrados tienen {int(dias)} días",
                                     "sudo hpc-backup --secretos y traerlos a Windows", "Copias"))
    return salida


def _revisar_discos():
    salida = []
    ficheros = [Path("/var/lib/revisar-smart/resumen.json")] + sorted(Path("/var/lib/revisar-smart/remotos").glob("*.json"))
    for f in ficheros:
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        if d.get("estado") != "ok":
            host = d.get("host", f.stem)
            nivel = "critico" if "FAILED" in d.get("detalle", "") else "aviso"
            salida.append(_aviso(f"smart:{host}", nivel, f"Aviso de disco en {host.capitalize()}",
                                 d.get("detalle", ""), "Discos"))
    return salida


async def _revisar_beszel():
    if not (BESZEL_USUARIO and BESZEL_CLAVE):
        return []
    try:
        await _token()
        return []
    except Exception as e:
        return [_aviso("beszel", "aviso", "No se puede consultar Beszel", str(e)[:120], "Telemetría")]


@app.get("/api/avisos")
async def api_avisos():
    if time.time() - _cache_avisos["t"] < 25 and _cache_avisos["datos"] is not None:
        return JSONResponse(_cache_avisos["datos"])

    nombres = list(NODOS)
    vivos = dict(zip(nombres, await asyncio.gather(*(ping(NODOS[n]) for n in nombres))))
    grupos = await asyncio.gather(_revisar_servicios(), _revisar_cluster(vivos),
                                  _revisar_certificado(), _revisar_copias(), _revisar_beszel(),
                                  _revisar_seguridad(), _revisar_respaldo(), _revisar_apps())
    avisos = [a for g in grupos for a in g] + _revisar_discos()

    t = _apagado.get("tarea")
    if t and not t.done():
        m = max(0, int(_apagado["cuando"] - time.time())) // 60
        avisos.append(_aviso("apagado", "info", f"Apagado del clúster programado en {m} min",
                             "incluye la Pi" if _apagado["incluir_pi"] else "solo los nodos", "Energía"))

    ahora = time.time()
    claves = {a["clave"] for a in avisos}
    for k in list(_vistos):
        if k not in claves:
            del _vistos[k]                          # resuelto: se olvida
    for a in avisos:
        a["desde"] = int(_vistos.setdefault(a["clave"], ahora))

    avisos.sort(key=lambda a: (ORDEN[a["nivel"]], -a["desde"]))
    datos = {"avisos": avisos,
             "resumen": {n: sum(1 for a in avisos if a["nivel"] == n) for n in ORDEN},
             "revisado": int(ahora)}
    _cache_avisos.update(t=ahora, datos=datos)
    return JSONResponse(datos)


# ============================== red ==============================
# El tráfico de cada interfaz se muestrea cada minuto y se guarda en SQLite
# (30 días), para poder revisar noches o días anteriores en el panel.
import sqlite3

DATOS_DIR = Path(os.environ.get("DATOS_DIR", str(Path(__file__).parent / "datos")))
BD_TRAFICO = DATOS_DIR / "trafico.sqlite3"
RETENCION_DIAS = int(os.environ.get("RETENCION_DIAS", "30"))
_ultimo_contador = {}


def _bd():
    DATOS_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(BD_TRAFICO, timeout=10)
    con.executescript("""
      CREATE TABLE IF NOT EXISTS trafico  (interfaz TEXT, t INTEGER, entrada REAL, salida REAL, PRIMARY KEY (interfaz, t));
      CREATE TABLE IF NOT EXISTS apps     (servicio TEXT, t INTEGER, bytes INTEGER, PRIMARY KEY (servicio, t));
      CREATE TABLE IF NOT EXISTS encendido (nodo TEXT, dia TEXT, minutos INTEGER, PRIMARY KEY (nodo, dia));
      CREATE TABLE IF NOT EXISTS metricas (nodo TEXT, t INTEGER, cpu REAL, temp REAL, ram_pct REAL, disco_pct REAL,
                                           red REAL, carga REAL, PRIMARY KEY (nodo, t));
      CREATE TABLE IF NOT EXISTS vpn      (ip TEXT, t INTEGER, conectado INTEGER, origen TEXT, rx INTEGER, tx INTEGER,
                                           PRIMARY KEY (ip, t));
      CREATE TABLE IF NOT EXISTS conexion (t INTEGER PRIMARY KEY, lat_router REAL, perdida_router REAL,
                                           lat_internet REAL, perdida_internet REAL, dns_ms REAL);
      CREATE TABLE IF NOT EXISTS ip_publica (t INTEGER PRIMARY KEY, ip TEXT);
      CREATE TABLE IF NOT EXISTS pods     (t INTEGER, ns TEXT, pod TEXT, rx REAL, tx REAL, PRIMARY KEY (t, ns, pod));

      -- Archivo forense de seguridad: NUNCA se purga (ver _purgar)
      CREATE TABLE IF NOT EXISTS seg_alertas (id INTEGER, t INTEGER, ip TEXT, escenario TEXT, pais TEXT, red TEXT,
                                              lat REAL, lon REAL, eventos INTEGER, PRIMARY KEY (id, t, ip));
      CREATE TABLE IF NOT EXISTS seg_acciones (t INTEGER, accion TEXT, ip TEXT, horas INTEGER, motivo TEXT);
      CREATE TABLE IF NOT EXISTS seg_cortafuegos (dia TEXT, ip TEXT, veces INTEGER, destinos TEXT,
                                                  primero INTEGER, ultimo INTEGER, PRIMARY KEY (dia, ip));
      CREATE TABLE IF NOT EXISTS seg_permanentes (ip TEXT PRIMARY KEY, t INTEGER, motivo TEXT);
      CREATE TABLE IF NOT EXISTS estado (clave TEXT PRIMARY KEY, valor TEXT);
      CREATE INDEX IF NOT EXISTS i_seg_alertas_ip ON seg_alertas (ip);
      CREATE INDEX IF NOT EXISTS i_seg_cf_ip ON seg_cortafuegos (ip);
    """)
    return con


def _leer_contadores(interfaz: str):
    base = Path(f"/sys/class/net/{interfaz}/statistics")
    try:
        return int((base / "rx_bytes").read_text()), int((base / "tx_bytes").read_text())
    except Exception:
        return None


def _guardar_muestras(filas):
    with _bd() as con:
        con.executemany("INSERT OR REPLACE INTO trafico VALUES (?, ?, ?, ?)", filas)


def _purgar():
    limite = int(time.time()) - RETENCION_DIAS * 86400
    with _bd() as con:
        for tabla in ("trafico", "apps", "vpn", "conexion", "pods"):
            con.execute(f"DELETE FROM {tabla} WHERE t < ?", (limite,))


async def vigilar_trafico():
    """Cada minuto, la velocidad media de cada interfaz (bytes/s de entrada y de salida)."""
    vueltas = 0
    while True:
        ahora = time.time()
        filas = []
        for i in INTERFACES_RED:
            c = _leer_contadores(i)
            previo = _ultimo_contador.get(i)
            if c and previo:
                dt = ahora - previo[0]
                if dt > 0 and c[0] >= previo[1] and c[1] >= previo[2]:        # sin reinicios de contador
                    filas.append((i, int(ahora), (c[0] - previo[1]) / dt, (c[1] - previo[2]) / dt))
            if c:
                _ultimo_contador[i] = (ahora, c[0], c[1])
        if filas:
            try:
                await asyncio.to_thread(_guardar_muestras, filas)
            except Exception as e:
                print(f"[red] no se pudo guardar el tráfico: {e}", flush=True)
        vueltas += 1
        if vueltas % 60 == 0:                                                   # una vez por hora
            await asyncio.to_thread(_purgar)
        await asyncio.sleep(60)


def _consultar_trafico(desde: int, hasta: int):
    tramo = hasta - desde
    paso = max(60, (tramo // 720) // 60 * 60)          # como mucho ~720 puntos por serie
    salida = {}
    with _bd() as con:
        primero = con.execute("SELECT MIN(t) FROM trafico").fetchone()[0]
        for i in INTERFACES_RED:
            filas = con.execute(
                """SELECT (t / ?) * ? AS b, AVG(entrada), AVG(salida), MAX(entrada), MAX(salida)
                   FROM trafico WHERE interfaz = ? AND t BETWEEN ? AND ?
                   GROUP BY b ORDER BY b""", (paso, paso, i, desde, hasta)).fetchall()
            salida[i] = {
                "existe": Path(f"/sys/class/net/{i}").exists(),
                "t": [f[0] for f in filas],
                "entrada": [round(f[1] / 1024, 2) for f in filas],        # KB/s (media del tramo)
                "salida": [round(f[2] / 1024, 2) for f in filas],
                "pico_entrada": [round(f[3] / 1024, 2) for f in filas],   # para no esconder picos
                "pico_salida": [round(f[4] / 1024, 2) for f in filas],
            }
    return {"desde": desde, "hasta": hasta, "paso": paso, "primero": primero, "interfaces": salida}


@app.get("/api/red/trafico")
async def api_red_trafico(desde: int = 0, hasta: int = 0):
    ahora = int(time.time())
    hasta = min(hasta or ahora, ahora)
    desde = desde or hasta - 6 * 3600
    desde = max(desde, hasta - 7 * 86400)               # como mucho una semana por petición
    try:
        return await asyncio.to_thread(_consultar_trafico, desde, hasta)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=503)


# ------------------- muestreos adicionales de red -------------------
import random
import re as _re
import socket


def _guardar_filas(sql, filas):
    with _bd() as con:
        con.executemany(sql, filas)


def inicio_de(periodo: str) -> int:
    """Marca de tiempo del comienzo de 'hoy' (medianoche local), 'semana' o 'mes'."""
    ahora = time.time()
    if periodo == "hoy":
        lt = time.localtime(ahora)
        return int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)))
    return int(ahora - (7 if periodo == "semana" else 30) * 86400)


async def _leer_wg():
    cod, txt = await _salida("sudo", "-n", "/usr/bin/wg", "show", "wg0", "dump")
    if cod != 0:
        return None
    pares = []
    for linea in txt.splitlines()[1:]:                  # la primera línea es la propia interfaz
        c = linea.split("\t")
        if len(c) < 8:
            continue
        ips = [x.split("/")[0] for x in c[3].split(",") if x]
        contacto = int(c[4] or 0)
        pares.append({"ip": ips[0] if ips else "?",
                      "origen": c[2] if c[2] != "(none)" else "",
                      "ultimo_contacto": contacto,
                      "conectado": contacto > 0 and time.time() - contacto < 180,
                      "recibido": int(c[5] or 0), "enviado": int(c[6] or 0)})
    return pares


async def vigilar_vpn():
    while True:
        pares = await _leer_wg()
        if pares:
            t = int(time.time())
            filas = [(p["ip"], t, int(p["conectado"]), p["origen"].rsplit(":", 1)[0], p["recibido"], p["enviado"])
                     for p in pares]
            try:
                await asyncio.to_thread(_guardar_filas, "INSERT OR REPLACE INTO vpn VALUES (?, ?, ?, ?, ?, ?)", filas)
            except Exception as e:
                print(f"[vpn] no se pudo guardar: {e}", flush=True)
        await asyncio.sleep(60)


async def _medir_ping(destino: str):
    cod, txt = await _salida("ping", "-n", "-q", "-c", "5", "-i", "0.2", "-W", "1", destino, timeout=10)
    perdida = _re.search(r"([\d.]+)% packet loss", txt)
    media = _re.search(r"= [\d.]+/([\d.]+)/", txt)
    return (float(media.group(1)) if media else None, float(perdida.group(1)) if perdida else 100.0)


async def _medir_dns():
    nombre = f"hpc-{random.randint(0, 10**9)}.example.com"      # nombre nuevo: obliga a preguntar fuera
    inicio = time.perf_counter()
    try:
        await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(nombre, None), 5)
    except (socket.gaierror, asyncio.TimeoutError, OSError):
        pass                                                     # NXDOMAIN también cuenta como respuesta
    return round((time.perf_counter() - inicio) * 1000, 1)


ROUTER = os.environ.get("ROUTER", "@@IP_ROUTER@@")
DESTINO_INTERNET = os.environ.get("DESTINO_INTERNET", "1.1.1.1")


async def vigilar_conexion():
    while True:
        (lr, pr), (li, pi), dns = await asyncio.gather(
            _medir_ping(ROUTER), _medir_ping(DESTINO_INTERNET), _medir_dns())
        try:
            await asyncio.to_thread(_guardar_filas, "INSERT OR REPLACE INTO conexion VALUES (?, ?, ?, ?, ?, ?)",
                                    [(int(time.time()), lr, pr, li, pi, dns)])
        except Exception as e:
            print(f"[conexión] no se pudo guardar: {e}", flush=True)
        await asyncio.sleep(60)


def _consultar_ip_publica():
    with urllib.request.urlopen("https://api.ipify.org", timeout=6) as r:
        return r.read().decode().strip()


async def vigilar_ip_publica():
    while True:
        try:
            ip = await asyncio.to_thread(_consultar_ip_publica)
            def guardar():
                with _bd() as con:
                    ultima = con.execute("SELECT ip FROM ip_publica ORDER BY t DESC LIMIT 1").fetchone()
                    if not ultima or ultima[0] != ip:                  # solo se apuntan los cambios
                        con.execute("INSERT INTO ip_publica VALUES (?, ?)", (int(time.time()), ip))
            await asyncio.to_thread(guardar)
        except Exception:
            pass
        await asyncio.sleep(600)


_METRICA_RED = _re.compile(r'^container_network_(receive|transmit)_bytes_total\{([^}]*)\}\s+([\d.e+]+)')


async def vigilar_pods():
    """Tráfico de cada pod según el kubelet (cAdvisor), cada 5 minutos, en los nodos encendidos."""
    while True:
        nodos = ["pi-master"] + [n for n in NODOS if await ping(NODOS[n])]
        t = int(time.time())
        acumulado = {}
        for nodo in nodos:
            cod, txt = await _salida("kubectl", "get", "--raw",
                                     f"/api/v1/nodes/{nodo}/proxy/metrics/cadvisor", timeout=20)
            if cod != 0:
                continue
            for linea in txt.splitlines():
                m = _METRICA_RED.match(linea)
                if not m:
                    continue
                etiquetas = dict(_re.findall(r'(\w+)="([^"]*)"', m.group(2)))
                if etiquetas.get("interface") != "eth0" or not etiquetas.get("pod"):
                    continue
                clave = (etiquetas.get("namespace", "?"), etiquetas["pod"])
                rx, tx = acumulado.get(clave, (0.0, 0.0))
                valor = float(m.group(3))
                acumulado[clave] = (valor, tx) if m.group(1) == "receive" else (rx, valor)
        if acumulado:
            filas = [(t, ns, pod, rx, tx) for (ns, pod), (rx, tx) in acumulado.items()]
            try:
                await asyncio.to_thread(_guardar_filas, "INSERT OR REPLACE INTO pods VALUES (?, ?, ?, ?, ?)", filas)
            except Exception as e:
                print(f"[pods] no se pudo guardar: {e}", flush=True)
        await asyncio.sleep(300)


def _suma_incrementos(valores):
    """Suma lo crecido en una serie de contadores acumulados (un reinicio vuelve a empezar de cero)."""
    total, previo = 0.0, None
    for v in valores:
        if previo is not None:
            total += v - previo if v >= previo else v
        previo = v
    return total


def _resumen_red():
    ahora = int(time.time())
    periodos = {p: inicio_de(p) for p in ("hoy", "semana", "mes")}
    out = {"consumo": {}, "pico_hoy": {}, "apps": {}, "vpn": {}, "ip_publica": None, "conexion": None}
    with _bd() as con:
        for i in INTERFACES_RED:
            out["consumo"][i] = {}
            for p, desde in periodos.items():
                e, s_ = con.execute("SELECT SUM(entrada), SUM(salida) FROM trafico WHERE interfaz=? AND t>=?",
                                    (i, desde)).fetchone()
                out["consumo"][i][p] = {"entrada": (e or 0) * 60, "salida": (s_ or 0) * 60}   # bytes
            fila = con.execute("SELECT entrada, t FROM trafico WHERE interfaz=? AND t>=? ORDER BY entrada DESC LIMIT 1",
                               (i, periodos["hoy"])).fetchone()
            out["pico_hoy"][i] = {"kbs": round(fila[0] / 1024, 1), "t": fila[1]} if fila else None

        for clave in SERVICIOS:
            out["apps"][clave] = {p: con.execute("SELECT COALESCE(SUM(bytes),0) FROM apps WHERE servicio=? AND t>=?",
                                                 (clave, d)).fetchone()[0] for p, d in periodos.items()}

        for (ip,) in con.execute("SELECT DISTINCT ip FROM vpn WHERE t>=?", (periodos["hoy"],)).fetchall():
            filas = con.execute("SELECT conectado, origen, rx, tx FROM vpn WHERE ip=? AND t>=? ORDER BY t",
                                (ip, periodos["hoy"])).fetchall()
            out["vpn"][ip] = {"minutos_hoy": sum(f[0] for f in filas),
                              "ips_hoy": len({f[1] for f in filas if f[1]}),
                              "datos_hoy": _suma_incrementos([f[2] for f in filas]) + _suma_incrementos([f[3] for f in filas])}

        ips = con.execute("SELECT t, ip FROM ip_publica ORDER BY t DESC LIMIT 10").fetchall()
        if ips:
            out["ip_publica"] = {"actual": ips[0][1], "desde": ips[0][0],
                                 "cambios_hoy": sum(1 for t, _ in ips if t >= periodos["hoy"])}

        c = con.execute("SELECT * FROM conexion ORDER BY t DESC LIMIT 1").fetchone()
        if c:
            out["conexion"] = dict(zip(("t", "lat_router", "perdida_router", "lat_internet", "perdida_internet", "dns_ms"), c))
    out["generado"] = ahora
    return out


@app.get("/api/red/resumen")
async def api_red_resumen():
    try:
        return await asyncio.to_thread(_resumen_red)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=503)


@app.get("/api/red/conexion")
async def api_red_conexion(horas: int = 24):
    desde = int(time.time()) - max(1, min(horas, 24 * 7)) * 3600
    def consultar():
        with _bd() as con:
            filas = con.execute("SELECT * FROM conexion WHERE t>=? ORDER BY t", (desde,)).fetchall()
        claves = ("t", "lat_router", "perdida_router", "lat_internet", "perdida_internet", "dns_ms")
        return {k: [f[i] for f in filas] for i, k in enumerate(claves)}
    return await asyncio.to_thread(consultar)


@app.get("/api/red/consumo_servicios")
async def api_consumo_servicios(periodo: str = "hoy"):
    """Qué consume más: namespaces del clúster (tráfico de sus pods) y apps servidas a través de la Pi."""
    desde = inicio_de(periodo if periodo in ("hoy", "semana", "mes") else "hoy")
    def consultar():
        por_ns = {}
        with _bd() as con:
            pods = con.execute("SELECT DISTINCT ns, pod FROM pods WHERE t>=?", (desde,)).fetchall()
            for ns, pod in pods:
                filas = con.execute("SELECT rx, tx FROM pods WHERE ns=? AND pod=? AND t>=? ORDER BY t",
                                    (ns, pod, desde)).fetchall()
                por_ns[ns] = por_ns.get(ns, 0) + _suma_incrementos([f[0] for f in filas]) \
                                                + _suma_incrementos([f[1] for f in filas])
            apps = {c: con.execute("SELECT COALESCE(SUM(bytes),0) FROM apps WHERE servicio=? AND t>=?",
                                   (c, desde)).fetchone()[0] for c in SERVICIOS}
        cluster = sorted(({"nombre": ns, "bytes": b} for ns, b in por_ns.items() if b > 0),
                         key=lambda x: -x["bytes"])
        vistas = sorted(({"nombre": SERVICIOS[c].get("nombre", c), "bytes": b} for c, b in apps.items() if b > 0),
                        key=lambda x: -x["bytes"])
        return {"periodo": periodo, "cluster": cluster[:8], "apps": vistas}
    return await asyncio.to_thread(consultar)


@app.get("/api/red/vpn")
async def api_red_vpn():
    """Pares de WireGuard. Nunca devuelve claves: solo nombre, IP, contacto y tráfico."""
    arriba = Path("/sys/class/net/wg0").exists()
    pares = await _leer_wg()
    if pares is None:
        return {"arriba": arriba, "error": "sin permiso para leer WireGuard (sudoers 20-wg-show)", "pares": []}
    for p in pares:
        p["nombre"] = PARES_VPN.get(p["ip"], "Sin nombre")
    pares.sort(key=lambda p: (not p["conectado"], p["ip"]))
    return {"arriba": arriba, "pares": pares}


# Orígenes conocidos de internet que llegan al cortafuegos sin ser un ataque.
# Se siguen registrando; solo se etiquetan para distinguirlos de lo desconocido.
import ipaddress as _ipaddress
ORIGENES_CONOCIDOS = [
    # Servidores del túnel de Cloudflare (si publicas algo con Cloudflare Tunnel): respuestas
    # QUIC tardías desde el puerto 7844 a conexiones que la Pi ya había dado por cerradas.
    ("cloudflare", "Túnel de Cloudflare", ["198.41.192.0/24", "198.41.200.0/24"]),
]
_REDES_CONOCIDAS = [(clave, nombre, _ipaddress.ip_network(r))
                    for clave, nombre, redes in ORIGENES_CONOCIDOS for r in redes]


def etiqueta_ip(ip: str):
    try:
        dir_ = _ipaddress.ip_address(ip)
    except ValueError:
        return None
    for clave, nombre, red in _REDES_CONOCIDAS:
        if dir_ in red:
            return {"clave": clave, "nombre": nombre}
    return None


@app.get("/api/red/bloqueos")
async def api_red_bloqueos(horas: int = 24):
    """Conexiones descartadas por el cortafuegos (líneas 'nft-...-drop' del journal del kernel)."""
    horas = max(1, min(horas, 168))
    cod, txt = await _salida("journalctl", "-k", "--since", f"-{horas}h", "-o", "short-unix",
                             "--no-pager", "-g", "nft-", timeout=15)
    if cod not in (0, 1):                               # 1 = no hay coincidencias
        return {"error": "sin acceso al journal (grupo systemd-journal)", "eventos": [], "top": []}
    eventos = []
    for linea in txt.splitlines():
        try:
            ts = float(linea.split(" ", 1)[0])
        except ValueError:
            continue
        campos = dict(par.split("=", 1) for par in linea.split() if "=" in par)
        cadena = "reenvío" if "forward-drop" in linea else "entrada"
        eventos.append({"t": int(ts), "cadena": cadena,
                        "origen": campos.get("SRC", "?"), "destino": campos.get("DST", ""),
                        "proto": campos.get("PROTO", ""), "puerto": campos.get("DPT", ""),
                        "interfaz": campos.get("IN", "")})
    eventos.sort(key=lambda e: -e["t"])

    # agrupado por IP de origen: una fila por dirección, con qué intentó y cuándo
    grupos = {}
    for e in eventos:
        g = grupos.setdefault(e["origen"], {"origen": e["origen"], "veces": 0, "primero": e["t"],
                                            "ultimo": e["t"], "destinos": {}, "cadenas": set()})
        g["veces"] += 1
        g["primero"] = min(g["primero"], e["t"])
        g["ultimo"] = max(g["ultimo"], e["t"])
        clave = f'{e["proto"]}/{e["puerto"]}' if e["puerto"] else e["proto"]
        g["destinos"][clave] = g["destinos"].get(clave, 0) + 1
        g["cadenas"].add(e["cadena"])
    lista = []
    for g in grupos.values():
        destinos = sorted(g["destinos"].items(), key=lambda x: -x[1])
        lista.append({**{k: g[k] for k in ("origen", "veces", "primero", "ultimo")},
                      "destinos": [d for d, _ in destinos[:3]],
                      "mas_destinos": max(0, len(destinos) - 3),
                      "cadenas": sorted(g["cadenas"])})
    # primero lo que viene de internet (lo que de verdad interesa), luego por insistencia
    import ipaddress
    def es_local(ip):
        try: return ipaddress.ip_address(ip).is_private
        except ValueError: return True
    # Orden: lo desconocido de internet primero, luego los orígenes conocidos, y al final lo local
    for g in lista:
        g["etiqueta"] = etiqueta_ip(g["origen"])
    lista.sort(key=lambda g: (es_local(g["origen"]), g["etiqueta"] is not None, -g["veces"], -g["ultimo"]))
    ahora = time.time()
    por_hora = [0] * min(horas, 24)
    for e in eventos:
        h = int((ahora - e["t"]) // 3600)
        if h < len(por_hora):
            por_hora[len(por_hora) - 1 - h] += 1                 # de más antiguo a más reciente
    return {"horas": horas, "total": len(eventos), "ips": len(lista), "grupos": lista[:25],
            "por_hora": por_hora, "eventos": eventos[:40]}


# ============================ seguridad (CrowdSec) ============================
# Todo pasa por el intermediario /usr/local/sbin/hpc-crowdsec (sudo acotado),
# que valida las IPs y nunca bloquea los equipos propios.
from datetime import datetime

INTERMEDIARIO_CS = os.environ.get("INTERMEDIARIO_CS", "/usr/local/sbin/hpc-crowdsec")
_cache_seg = {"t": 0.0, "datos": None}


def _fecha(txt):
    try:
        return int(datetime.fromisoformat(str(txt).replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0


def _segundos(duracion: str) -> int:
    """'3h59m40.2s' -> segundos (formato de duración de Go)."""
    total = 0.0
    for valor, unidad in _re.findall(r"([\d.]+)(h|ms|m|s)", duracion or ""):
        total += float(valor) * {"h": 3600, "m": 60, "s": 1, "ms": 0.001}[unidad]
    return int(total)


async def _cs(*args):
    cod, txt = await _salida("sudo", "-n", INTERMEDIARIO_CS, *args, timeout=60)
    if cod != 0:
        return None
    try:
        return json.loads(txt) if txt.strip() and txt.strip() != "null" else []
    except json.JSONDecodeError:
        return []


async def _resumen_seguridad():
    if time.time() - _cache_seg["t"] < 20 and _cache_seg["datos"] is not None:
        return _cache_seg["datos"]
    _, motor = await _salida("systemctl", "is-active", "crowdsec")
    _, portero = await _salida("systemctl", "is-active", "crowdsec-firewall-bouncer")
    alertas_raw = await _cs("alertas")
    decisiones_raw = await _cs("decisiones")
    ahora = time.time()

    datos = {"motor": motor == "active", "portero": portero == "active",
             "accesible": alertas_raw is not None,
             "modo": "protegiendo" if portero == "active" else "observando",
             "alertas": [], "decisiones": [], "escenarios": [], "paises": [], "puntos": [],
             "total_24h": 0, "total_7d": 0}
    if alertas_raw is None:
        _cache_seg.update(t=ahora, datos=datos)
        return datos

    alertas = []
    for a in alertas_raw or []:
        if str(a.get("scenario", "")).lower().startswith("manual"):
            continue                                 # un bloqueo manual no es una detección
        src = a.get("source") or {}
        alertas.append({
            "id": a.get("id"),
            "t": _fecha(a.get("created_at") or a.get("start_at")),
            "escenario": a.get("scenario", "?"),
            "ip": src.get("ip") or src.get("value") or "?",
            "pais": src.get("cn") or "",
            "red": src.get("as_name") or "",
            "lat": src.get("latitude"), "lon": src.get("longitude"),
            "eventos": a.get("events_count", 0),
            "bloqueada": bool(a.get("decisions")),
        })
    alertas.sort(key=lambda x: -x["t"])
    datos["alertas"] = alertas[:60]
    datos["total_24h"] = sum(1 for a in alertas if ahora - a["t"] < 86400)
    datos["total_7d"] = len(alertas)

    conteo = lambda clave: sorted(
        ({"nombre": k, "veces": v} for k, v in
         __import__("collections").Counter(a[clave] for a in alertas if a[clave]).items()),
        key=lambda x: -x["veces"])
    datos["escenarios"] = conteo("escenario")[:8]
    datos["paises"] = conteo("pais")[:8]

    puntos = {}
    for a in alertas:
        if a["lat"] is None or a["lon"] is None:
            continue
        clave = (round(float(a["lat"]), 1), round(float(a["lon"]), 1))
        p = puntos.setdefault(clave, {"lat": clave[0], "lon": clave[1], "veces": 0, "ips": set(), "pais": a["pais"]})
        p["veces"] += 1
        p["ips"].add(a["ip"])
    datos["puntos"] = [{**p, "ips": sorted(p["ips"])[:5]} for p in puntos.values()]

    permanentes = await asyncio.to_thread(_leer_permanentes)
    vistas = set()
    for grupo in decisiones_raw or []:
        for dcs in grupo.get("decisions") or []:
            ip = dcs.get("value")
            if ip in vistas:
                continue
            vistas.add(ip)
            motivo = dcs.get("scenario") or grupo.get("scenario", "")
            manual = str(motivo).lower().startswith("manual")
            datos["decisiones"].append({
                "ip": ip, "tipo": dcs.get("type", "ban"),
                "motivo": motivo.split(":", 1)[1].strip() if manual and ":" in motivo else motivo,
                "manual": manual or dcs.get("origin") == "cscli",
                "permanente": ip in permanentes,
                "restan": _segundos(dcs.get("duration", "")),
                "pais": (grupo.get("source") or {}).get("cn", ""),
            })
    datos["decisiones"].sort(key=lambda d: -d["restan"])
    _cache_seg.update(t=ahora, datos=datos)
    return datos


@app.get("/api/seguridad/resumen")
async def api_seguridad_resumen():
    return await _resumen_seguridad()


HORAS_PERMANENTE = 87600          # 10 años; el vigilante lo repone si CrowdSec lo perdiera


@app.post("/api/seguridad/bloquear")
async def api_seguridad_bloquear(ip: str, horas: int = 4, motivo: str = ""):
    """horas=0 -> veto permanente."""
    permanente = horas == 0
    duracion = HORAS_PERMANENTE if permanente else horas
    motivo = motivo.strip()[:80]
    cod, txt = await _salida("sudo", "-n", INTERMEDIARIO_CS, "bloquear", ip, str(duracion), motivo, timeout=60)
    _cache_seg["t"] = 0                                         # que el panel lo vea al momento
    if cod != 0:
        return JSONResponse({"ok": False, "motivo": txt or "no se pudo bloquear (¿IP propia o no válida?)"},
                            status_code=400)
    def registrar():
        with _bd() as con:
            con.execute("INSERT INTO seg_acciones VALUES (?, ?, ?, ?, ?)",
                        (int(time.time()), "vetar" if permanente else "bloquear", ip, duracion, motivo))
            if permanente:
                con.execute("INSERT OR REPLACE INTO seg_permanentes VALUES (?, ?, ?)", (ip, int(time.time()), motivo))
    await asyncio.to_thread(registrar)
    print(f"[seguridad] {'veto permanente' if permanente else f'bloqueo de {horas} h'} a {ip}", flush=True)
    return {"ok": True}


@app.post("/api/seguridad/desbloquear")
async def api_seguridad_desbloquear(ip: str):
    cod, txt = await _salida("sudo", "-n", INTERMEDIARIO_CS, "desbloquear", ip, timeout=60)
    _cache_seg["t"] = 0
    if cod != 0:
        return JSONResponse({"ok": False, "motivo": txt or "no se pudo desbloquear"}, status_code=400)
    def registrar():
        with _bd() as con:
            con.execute("DELETE FROM seg_permanentes WHERE ip = ?", (ip,))
            con.execute("INSERT INTO seg_acciones VALUES (?, ?, ?, ?, ?)", (int(time.time()), "desbloquear", ip, 0, ""))
    await asyncio.to_thread(registrar)
    print(f"[seguridad] desbloqueo manual de {ip}", flush=True)
    return {"ok": True}


def _leer_permanentes():
    try:
        with _bd() as con:
            return {ip for (ip,) in con.execute("SELECT ip FROM seg_permanentes")}
    except Exception:
        return set()


def _estado(clave, valor=None):
    with _bd() as con:
        if valor is None:
            f = con.execute("SELECT valor FROM estado WHERE clave = ?", (clave,)).fetchone()
            return f[0] if f else None
        con.execute("INSERT OR REPLACE INTO estado VALUES (?, ?)", (clave, str(valor)))


def _es_privada(ip):
    import ipaddress
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return True


async def _archivar_cortafuegos():
    """IPs de INTERNET que chocan con el cortafuegos, resumidas por día (el journal rota; esto no)."""
    desde = _estado("cortafuegos_hasta") or str(int(time.time()) - 86400)
    ahora = int(time.time())
    cod, txt = await _salida("journalctl", "-k", "--since", f"@{desde}", "--until", f"@{ahora}",
                             "-o", "short-unix", "--no-pager", "-g", "nft-", timeout=30)
    if cod not in (0, 1):
        return
    grupos = {}
    for linea in txt.splitlines():
        try:
            t = int(float(linea.split(" ", 1)[0]))
        except ValueError:
            continue
        c = dict(par.split("=", 1) for par in linea.split() if "=" in par)
        ip = c.get("SRC")
        if not ip or _es_privada(ip):
            continue
        dia = time.strftime("%Y-%m-%d", time.localtime(t))
        g = grupos.setdefault((dia, ip), {"veces": 0, "destinos": set(), "primero": t, "ultimo": t})
        g["veces"] += 1
        g["destinos"].add(f'{c.get("PROTO", "")}/{c.get("DPT", "")}'.rstrip("/"))
        g["primero"], g["ultimo"] = min(g["primero"], t), max(g["ultimo"], t)

    def guardar():
        with _bd() as con:
            for (dia, ip), g in grupos.items():
                previo = con.execute("SELECT veces, destinos, primero, ultimo FROM seg_cortafuegos WHERE dia=? AND ip=?",
                                     (dia, ip)).fetchone()
                destinos = set(g["destinos"])
                if previo:
                    destinos |= set(filter(None, previo[1].split(",")))
                    g["veces"] += previo[0]; g["primero"] = min(g["primero"], previo[2]); g["ultimo"] = max(g["ultimo"], previo[3])
                con.execute("INSERT OR REPLACE INTO seg_cortafuegos VALUES (?, ?, ?, ?, ?, ?)",
                            (dia, ip, g["veces"], ",".join(sorted(destinos))[:500], g["primero"], g["ultimo"]))
            con.execute("INSERT OR REPLACE INTO estado VALUES ('cortafuegos_hasta', ?)", (str(ahora),))
    await asyncio.to_thread(guardar)


async def _archivar_alertas():
    alertas = await _cs("alertas")
    if not alertas:
        return
    filas = []
    for a in alertas:
        if str(a.get("scenario", "")).lower().startswith("manual"):
            continue
        src = a.get("source") or {}
        filas.append((a.get("id") or 0, _fecha(a.get("created_at") or a.get("start_at")),
                      src.get("ip") or src.get("value") or "?", a.get("scenario", ""), src.get("cn") or "",
                      src.get("as_name") or "", src.get("latitude"), src.get("longitude"), a.get("events_count", 0)))
    await asyncio.to_thread(_guardar_filas, "INSERT OR IGNORE INTO seg_alertas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", filas)


async def _reponer_vetos():
    permanentes = await asyncio.to_thread(_leer_permanentes)
    if not permanentes:
        return
    activas = await _cs("decisiones")
    if activas is None:
        return                                        # CrowdSec no accesible: se reintentará
    vivas = {d.get("value") for g in activas for d in (g.get("decisions") or [])}
    for ip in permanentes - vivas:
        cod, _ = await _salida("sudo", "-n", INTERMEDIARIO_CS, "bloquear", ip, str(HORAS_PERMANENTE),
                               "veto permanente (repuesto)", timeout=60)
        print(f"[seguridad] veto de {ip} repuesto: {'ok' if cod == 0 else 'falló'}", flush=True)
        _cache_seg["t"] = 0


async def vigilar_seguridad():
    await asyncio.sleep(30)
    while True:
        for tarea in (_archivar_alertas, _archivar_cortafuegos, _reponer_vetos):
            try:
                await tarea()
            except Exception as e:
                print(f"[seguridad] {tarea.__name__}: {e}", flush=True)
        await asyncio.sleep(600)


def _historial(ip: str = "", limite: int = 200):
    filtro, args = ("WHERE ip = ?", (ip,)) if ip else ("", ())
    with _bd() as con:
        eventos = []
        for t, ip_, esc, pais, red, ev in con.execute(
                f"SELECT t, ip, escenario, pais, red, eventos FROM seg_alertas {filtro} ORDER BY t DESC LIMIT ?", (*args, limite)):
            eventos.append({"t": t, "tipo": "deteccion", "ip": ip_, "detalle": esc, "pais": pais, "red": red, "veces": ev})
        for t, acc, ip_, horas, motivo in con.execute(
                f"SELECT t, accion, ip, horas, motivo FROM seg_acciones {filtro} ORDER BY t DESC LIMIT ?", (*args, limite)):
            eventos.append({"t": t, "tipo": acc, "ip": ip_, "detalle": motivo, "horas": horas})
        for dia, ip_, veces, dest, primero, ultimo in con.execute(
                f"SELECT dia, ip, veces, destinos, primero, ultimo FROM seg_cortafuegos {filtro} ORDER BY ultimo DESC LIMIT ?",
                (*args, limite)):
            eventos.append({"t": ultimo, "tipo": "cortafuegos", "ip": ip_, "detalle": dest, "veces": veces,
                            "etiqueta": etiqueta_ip(ip_),
                            "dia": dia, "primero": primero})
        totales = {tabla: con.execute(f"SELECT COUNT(*) FROM {tabla}").fetchone()[0]
                   for tabla in ("seg_alertas", "seg_acciones", "seg_cortafuegos")}
        primero = con.execute("""SELECT MIN(t) FROM (SELECT MIN(t) t FROM seg_alertas UNION ALL
                                 SELECT MIN(t) FROM seg_acciones UNION ALL SELECT MIN(primero) FROM seg_cortafuegos)""").fetchone()[0]
    eventos.sort(key=lambda e: -e["t"])
    return {"ip": ip, "eventos": eventos[:limite], "totales": totales, "desde": primero}


@app.get("/api/seguridad/historial")
async def api_seguridad_historial(ip: str = "", limite: int = 200):
    return await asyncio.to_thread(_historial, ip.strip(), max(1, min(limite, 2000)))


@app.get("/api/seguridad/historial.csv")
async def api_seguridad_historial_csv():
    import csv, io
    datos = await asyncio.to_thread(_historial, "", 1_000_000)
    salida = io.StringIO()
    w = csv.writer(salida)
    w.writerow(["fecha", "tipo", "ip", "detalle", "pais", "red", "veces"])
    for e in datos["eventos"]:
        w.writerow([time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e["t"])), e["tipo"], e["ip"],
                    e.get("detalle", ""), e.get("pais", ""), e.get("red", ""), e.get("veces", "")])
    from fastapi import Response
    return Response(salida.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="historial-seguridad-{time.strftime("%Y%m%d")}.csv"'})


async def _revisar_respaldo():
    """Copias a Faraday (hpc-respaldo): última copia y aviso el día que toca."""
    salida = []
    _, existe = await _salida("systemctl", "list-unit-files", "hpc-respaldo.timer")
    if "hpc-respaldo.timer" not in existe:
        return salida
    try:
        e = json.loads(Path("/var/lib/hpc-respaldo/estado.json").read_text())
    except Exception:
        e = None
    if e is None:
        salida.append(_aviso("respaldo", "aviso", "Aún no hay ninguna copia en Faraday",
                             "sudo hpc-respaldo", "Copias"))
    else:
        dias = (time.time() - e.get("fecha", 0)) / 86400
        if e.get("estado") != "ok":
            salida.append(_aviso("respaldo", "critico", "La última copia a Faraday falló",
                                 e.get("mensaje", ""), "Copias"))
        elif dias > 4:
            salida.append(_aviso("respaldo", "critico" if dias > 7 else "aviso",
                                 f"La última copia a Faraday es de hace {int(dias)} días",
                                 "revisar hpc-respaldo.timer", "Copias"))
    _, prox = await _salida("systemctl", "show", "hpc-respaldo.timer", "-p", "NextElapseUSecRealtime",
                            "--value", "--timestamp=unix")
    if prox.startswith("@"):
        falta = int(prox[1:]) - time.time()
        if 0 < falta < 12 * 3600:
            hora = time.strftime("%H:%M", time.localtime(int(prox[1:])))
            salida.append(_aviso("respaldo:proxima", "info", f"Hoy a las {hora} hay copia de seguridad",
                                 "Faraday se encenderá unos minutos", "Copias"))
    return salida


async def _revisar_seguridad():
    try:
        d = await _resumen_seguridad()
    except Exception:
        return []
    salida = []
    _, instalado = await _salida("systemctl", "list-unit-files", "crowdsec.service")
    if "crowdsec.service" not in instalado:
        return []                                                # aún no instalado: nada que avisar
    if not d["motor"]:
        salida.append(_aviso("cs:motor", "critico", "CrowdSec no está activo", "systemctl status crowdsec", "Seguridad"))
    elif not d["accesible"]:
        salida.append(_aviso("cs:acceso", "aviso", "El panel no puede consultar CrowdSec",
                             "falta el permiso sudo del intermediario hpc-crowdsec", "Seguridad"))
    if d["total_24h"]:
        principal = d["escenarios"][0]["nombre"] if d["escenarios"] else ""
        salida.append(_aviso("cs:alertas", "aviso",
                             f"CrowdSec ha detectado {d['total_24h']} ataque(s) en 24 h",
                             principal.split("/")[-1], "Seguridad"))
    return salida


# ============================ aplicaciones propias ============================
# Para cada app de servicios.yaml (apps:): su estado en K3s, su último despliegue
# (git push pi main → despliegues.log) y un dato propio, leído DENTRO de su pod
# con su propio entorno (así no hay que dar al panel acceso a sus volúmenes).

BASE_APPS = Path("/home/raspberrypi/apps")
_cache_apps = {"t": 0.0, "datos": None}
_cache_dato = {}

# Consulta de solo lectura por app: comando dentro del contenedor que imprime JSON.
# Una app puede traer la suya en servicios.yaml (dato_cmd: [...]); si su JSON tiene
# "texto", el panel lo muestra tal cual como resumen de la tarjeta.
DATOS_APP = {
    "ticket-scanner": ["node", "-e", r"""
const D=require('/app/node_modules/better-sqlite3');
const db=new D(process.env.TICKETS_DB_PATH,{readonly:true,fileMustExist:true});
const d=new Date(), mes=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
const r=db.prepare("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(total_eur_centimos,total_centimos)),0) c FROM tickets WHERE substr(fecha_compra,1,7)=?").get(mes);
const t=db.prepare("SELECT COUNT(*) n, MAX(fecha_compra) u FROM tickets").get();
console.log(JSON.stringify({mes_n:r.n, mes_centimos:r.c, total:t.n, ultimo:t.u}));"""],
}


def _ultimo_despliegue(repo: str):
    log = BASE_APPS / repo / "despliegues.log"
    try:
        lineas = [l.split(None, 3) for l in log.read_text().splitlines() if l.strip()]
    except Exception:
        return None
    if not lineas:
        return None
    ok = [l for l in lineas if len(l) >= 4 and l[3] == "OK"]
    ult = lineas[-1]
    a_ts = lambda l: int(time.mktime(time.strptime(f"{l[0]} {l[1]}", "%Y-%m-%d %H:%M:%S")))
    return {"version": (ok[-1][2] if ok else None),
            "fecha": (a_ts(ok[-1]) if ok else None),
            "ultimo_resultado": ult[3] if len(ult) >= 4 else "?",
            "ultimo_intento": a_ts(ult),
            "despliegues": len(ok)}


async def _dato_app(app: dict, ns: str, dep: str):
    clave = app["clave"]
    cmd = app.get("dato_cmd") or DATOS_APP.get(clave)
    if not cmd:
        return None
    previo = _cache_dato.get(clave)
    if previo and time.time() - previo[0] < 300:
        return previo[1]
    cod, txt = await _salida("kubectl", "-n", ns, "exec", f"deploy/{dep}", "--", *cmd, timeout=20)
    dato = None
    if cod == 0:
        try:
            dato = json.loads(txt.strip().splitlines()[-1])
        except Exception:
            dato = None
    _cache_dato[clave] = (time.time(), dato)
    return dato


async def _estado_app(app: dict):
    ns = app.get("namespace", app["clave"])
    dep = app.get("deployment", app["clave"])
    info = {"clave": app["clave"], "nombre": app.get("nombre", app["clave"]), "url": app.get("url", ""),
            "icono": app.get("icono", ""), "app": app.get("app") or {},
            "namespace": ns, "listo": False, "reinicios": 0, "memoria_mb": None, "imagen": ""}
    cod, txt = await _salida("kubectl", "-n", ns, "get", "deploy", dep, "-o", "json")
    if cod == 0:
        d = json.loads(txt)
        info["listo"] = (d.get("status", {}).get("readyReplicas") or 0) >= 1
        info["imagen"] = d["spec"]["template"]["spec"]["containers"][0].get("image", "")
        sel = ",".join(f"{k}={v}" for k, v in d["spec"]["selector"].get("matchLabels", {}).items())
        cod, txt = await _salida("kubectl", "-n", ns, "get", "pods", "-l", sel, "-o", "json")
        if cod == 0:
            for p in json.loads(txt).get("items", []):
                for c in p.get("status", {}).get("containerStatuses", []) or []:
                    info["reinicios"] += c.get("restartCount", 0)
        cod, txt = await _salida("kubectl", "-n", ns, "top", "pod", "-l", sel, "--no-headers")
        if cod == 0 and txt:
            mem = 0
            for linea in txt.splitlines():
                campo = linea.split()[2] if len(linea.split()) > 2 else "0Mi"
                mem += int(_re.sub(r"\D", "", campo) or 0) * (1024 if campo.endswith("Gi") else 1)
            info["memoria_mb"] = mem
        info["dato"] = await _dato_app(app, ns, dep) if info["listo"] else None
    info["despliegue"] = _ultimo_despliegue(app.get("repo", app["clave"]))
    return info


@app.get("/api/apps")
async def api_apps():
    if time.time() - _cache_apps["t"] < 30 and _cache_apps["datos"] is not None:
        return _cache_apps["datos"]
    datos = await asyncio.gather(*(_estado_app(a) for a in APPS))
    _cache_apps.update(t=time.time(), datos=datos)
    return datos


# ----------------------------- calendario: horas encendido por día -----------------------------
def _sumar_minuto(nodos: list[str]):
    dia = time.strftime("%Y-%m-%d")                 # día local de la Pi
    with _bd() as con:
        con.executemany("INSERT INTO encendido VALUES (?, ?, 1) "
                        "ON CONFLICT (nodo, dia) DO UPDATE SET minutos = minutos + 1", [(n, dia) for n in nodos])


async def vigilar_encendido():
    """Cada minuto, qué nodos responden: suma un minuto encendido a su día (para el calendario)."""
    while True:
        try:
            vivos = await asyncio.gather(*(ping(ip) for ip in NODOS.values()))
            encendidos = ["pi-master"] + [n for n, v in zip(NODOS, vivos) if v]
            if encendidos:
                await asyncio.to_thread(_sumar_minuto, encendidos)
        except Exception as e:
            print(f"[calendario] no se pudo guardar: {e}", flush=True)
        await asyncio.sleep(60)


_cache_calendario = {"t": 0.0, "datos": None}


async def _estimar_con_beszel(nodo: str) -> dict:
    """Días anteriores a que el panel empezara a anotarlo: se estiman con los registros de Beszel
    (solo existen mientras el nodo está encendido). 2 h de resolución la última semana; 8 h antes."""
    sid = (await _sistemas()).get(nodo)
    if not sid:
        return {}
    horas: dict = {}
    for tipo, bloque, dias in (("480m", 8, 31), ("120m", 2, 7)):     # el detalle fino pisa al grueso
        desde = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() - dias * 86400))
        items = await _consultar("system_stats", perPage=500, sort="created",
                                 filter=f"system='{sid}' && type='{tipo}' && created>='{desde}'", fields="created")
        cuenta: dict = {}
        for it in items:
            try:
                t = calendar.timegm(time.strptime(str(it["created"])[:19], "%Y-%m-%d %H:%M:%S"))   # Beszel: UTC
            except (KeyError, ValueError):
                continue
            dia = time.strftime("%Y-%m-%d", time.localtime(t))
            cuenta[dia] = cuenta.get(dia, 0) + bloque
        horas.update({d: min(24, h) for d, h in cuenta.items()})
    return horas


@app.get("/api/calendario")
async def api_calendario():
    """Horas encendido por día y nodo: lo anotado por el panel y, antes de eso, la estimación de Beszel."""
    if time.time() - _cache_calendario["t"] < 300 and _cache_calendario["datos"] is not None:
        return _cache_calendario["datos"]
    def leer():
        with _bd() as con:
            return con.execute("SELECT nodo, dia, minutos FROM encendido").fetchall()
    filas = await asyncio.to_thread(leer)
    salida = {n: {} for n in ["pi-master", *NODOS]}
    primero = {}
    for nodo, dia, minutos in filas:
        if nodo in salida:
            salida[nodo][dia] = {"horas": round(minutos / 60, 1)}
            primero[nodo] = min(primero.get(nodo, dia), dia)
    for nodo in salida:
        try:
            for dia, h in (await _estimar_con_beszel(nodo)).items():
                if dia < primero.get(nodo, "9999"):           # solo antes de tener datos propios
                    salida[nodo][dia] = {"horas": h, "aprox": True}
        except Exception as e:
            print(f"[calendario] Beszel no respondió para {nodo}: {e}", flush=True)
    datos = {"nodos": salida, "hoy": time.strftime("%Y-%m-%d")}
    _cache_calendario.update(t=time.time(), datos=datos)
    return datos


# ----------------------------- cuándo dormirá cada nodo -----------------------------
ESTADO_CONTROLADOR = Path(os.environ.get("ESTADO_CONTROLADOR", "/run/nodo-controlador/estado.json"))


async def _retenciones() -> dict:
    """power-hold de cada nodo: si está puesto, hasta cuándo y quién lo puso."""
    cod, txt = await _salida("kubectl", "get", "nodes", "-o", "json")
    salida = {}
    if cod != 0:
        return salida
    for nd in json.loads(txt).get("items", []):
        m = nd.get("metadata", {})
        if m.get("name") not in NODOS:
            continue
        ann = m.get("annotations") or {}
        hasta = ann.get("power/hold-hasta", "")
        salida[m["name"]] = {
            "activo": (m.get("labels") or {}).get("power-hold") == "true",
            "hasta": int(hasta) if hasta.isdigit() else None,
            "por": ann.get("power/hold-por", ""),
        }
    return salida


@app.post("/api/retener/{nodo}")
async def api_retener(nodo: str, horas: int = 0):
    """Mantener encendido (power-hold): horas=0 hasta que lo sueltes; si no, caduca solo."""
    if nodo not in NODOS:
        raise HTTPException(404, f"Nodo desconocido: {nodo}")
    if not 0 <= horas <= 72:
        raise HTTPException(400, "entre 0 y 72 horas")
    ok = await ejecutar("kubectl", "label", "--overwrite", "node", nodo, "power-hold=true")
    if horas:
        await ejecutar("kubectl", "annotate", "--overwrite", "node", nodo,
                       f"power/hold-hasta={int(time.time()) + horas * 3600}", "power/hold-por=panel")
    else:
        await ejecutar("kubectl", "annotate", "--overwrite", "node", nodo, "power/hold-por=panel")
        await ejecutar("kubectl", "annotate", "node", nodo, "power/hold-hasta-")
    print(f"[{nodo}] retenido desde el panel {'hasta soltarlo' if not horas else f'{horas} h'}", flush=True)
    return {"ok": ok}


@app.post("/api/soltar/{nodo}")
async def api_soltar(nodo: str):
    if nodo not in NODOS:
        raise HTTPException(404, f"Nodo desconocido: {nodo}")
    if (await _retenciones()).get(nodo, {}).get("por") == "hpc-respaldo":
        return JSONResponse({"ok": False, "motivo": "lo retiene la copia de seguridad en curso"}, status_code=409)
    ok = await ejecutar("kubectl", "label", "node", nodo, "power-hold-")
    await ejecutar("kubectl", "annotate", "node", nodo, "power/hold-hasta-", "power/hold-por-")
    await marcar_actividad(nodo)              # 15 min de margen antes de que el controlador lo duerma
    print(f"[{nodo}] soltado desde el panel", flush=True)
    return {"ok": ok}


@app.get("/api/energia")
async def api_energia():
    """Lo que ve el controlador de energía: estado de cada nodo, qué lo retiene y cuándo dormirá."""
    retenciones = await _retenciones()
    try:
        datos = json.loads(ESTADO_CONTROLADOR.read_text())
    except (OSError, ValueError):
        return {"disponible": False, "nodos": {}, "despertares": DESPERTARES, "retenciones": retenciones,
                "no_despertar": {n: motivo_para_no_despertar(n) for n in NODOS}}
    # si el controlador lleva varias vueltas sin escribir, los datos ya no valen
    datos["disponible"] = time.time() - datos.get("revisado", 0) < 4 * datos.get("intervalo", 30)
    datos["ahora"] = int(time.time())
    datos["despertares"] = DESPERTARES
    datos["retenciones"] = retenciones
    datos["no_despertar"] = {n: motivo_para_no_despertar(n) for n in NODOS}
    return datos


# ----------------------------- lo que corre en K3s -----------------------------
_cache_pods = {"t": 0.0, "datos": None}


@app.get("/api/pods")
async def api_pods():
    """Todos los pods del clúster, con su nodo, estado y consumo (sección Nodos del panel)."""
    if time.time() - _cache_pods["t"] < 15 and _cache_pods["datos"] is not None:
        return _cache_pods["datos"]
    cod, txt = await _salida("kubectl", "get", "pods", "-A", "-o", "json", timeout=10)
    if cod != 0:
        raise HTTPException(503, "No se puede consultar Kubernetes")
    uso = {}
    cod, top = await _salida("kubectl", "top", "pod", "-A", "--no-headers", timeout=10)
    if cod == 0:
        for linea in top.splitlines():
            c = linea.split()
            if len(c) >= 4:
                uso[(c[0], c[1])] = (c[2], c[3])
    pods = []
    for p in json.loads(txt).get("items", []):
        m, sp, st = p.get("metadata", {}), p.get("spec", {}), p.get("status", {})
        conts = st.get("containerStatuses", []) or []
        estado = st.get("phase", "")
        for c in conts:
            espera = (c.get("state", {}).get("waiting") or {}).get("reason")
            if espera:
                estado = espera
                break
        if m.get("deletionTimestamp"):
            estado = "Terminating"
        cpu, mem = uso.get((m.get("namespace", ""), m.get("name", "")), (None, None))
        carga = None                                    # Deployment o StatefulSet que lo gestiona
        for o in m.get("ownerReferences", []) or []:
            if o.get("kind") == "StatefulSet":
                carga = {"tipo": "statefulset", "nombre": o.get("name", "")}
            elif o.get("kind") == "ReplicaSet":
                h = (m.get("labels") or {}).get("pod-template-hash", "")
                rs = o.get("name", "")
                if h and rs.endswith("-" + h):
                    carga = {"tipo": "deployment", "nombre": rs[:-len(h) - 1]}
        pods.append({
            "namespace": m.get("namespace", ""), "nombre": m.get("name", ""),
            "nodo": sp.get("nodeName", ""), "estado": estado,
            "listos": sum(1 for c in conts if c.get("ready")), "contenedores": len(sp.get("containers", [])),
            "reinicios": sum(c.get("restartCount", 0) for c in conts),
            "desde": st.get("startTime"), "cpu": cpu, "memoria": mem,
            "carga": carga if carga and m.get("namespace", "") not in NS_SISTEMA else None,
        })
    pods.sort(key=lambda x: (x["nodo"], x["namespace"], x["nombre"]))
    # lo que está parado a propósito (0 réplicas) no tiene pods, pero se puede volver a arrancar
    parados = []
    cod, txt = await _salida("kubectl", "get", "deployments,statefulsets", "-A", "-o", "json", timeout=10)
    if cod == 0:
        for d in json.loads(txt).get("items", []):
            m = d.get("metadata", {})
            if m.get("namespace") in NS_SISTEMA or (d.get("spec", {}).get("replicas") or 0) != 0:
                continue
            parados.append({"namespace": m.get("namespace"), "nombre": m.get("name"),
                            "tipo": d.get("kind", "").lower(),
                            "nodo": ((d["spec"].get("template", {}).get("spec", {}).get("nodeSelector") or {})
                                     .get("node-type", ""))})
    datos = {"pods": pods, "parados": parados}
    _cache_pods.update(t=time.time(), datos=datos)
    return datos


# Reiniciar, parar o arrancar una carga de tus namespaces (nunca los de sistema)
NS_SISTEMA = {"kube-system", "kube-public", "kube-node-lease"}
_NOMBRE_K8S = _re.compile(r"^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$")


@app.post("/api/carga/{accion}")
async def api_carga(accion: str, ns: str, tipo: str, nombre: str):
    if accion not in ("reiniciar", "parar", "arrancar") or tipo not in ("deployment", "statefulset"):
        raise HTTPException(400, "acción o tipo no válidos")
    if ns in NS_SISTEMA or not _NOMBRE_K8S.match(ns) or not _NOMBRE_K8S.match(nombre):
        raise HTTPException(400, "carga no permitida")
    obj = f"{tipo}/{nombre}"
    if accion == "reiniciar":
        cod, txt = await _salida("kubectl", "-n", ns, "rollout", "restart", obj, timeout=20)
    elif accion == "parar":
        # se guarda cuántas réplicas tenía para devolvérselas al arrancar
        cod, txt = await _salida("kubectl", "-n", ns, "get", obj, "-o", "jsonpath={.spec.replicas}")
        antes = txt if cod == 0 and txt.isdigit() and int(txt) > 0 else "1"
        await _salida("kubectl", "-n", ns, "annotate", obj, f"panel/replicas={antes}", "--overwrite")
        cod, txt = await _salida("kubectl", "-n", ns, "scale", obj, "--replicas=0", timeout=20)
    else:
        cod, txt = await _salida("kubectl", "-n", ns, "get", obj, "-o",
                                 "jsonpath={.metadata.annotations.panel/replicas}")
        replicas = txt if cod == 0 and txt.isdigit() and int(txt) > 0 else "1"
        cod, txt = await _salida("kubectl", "-n", ns, "scale", obj, f"--replicas={replicas}", timeout=20)
    _cache_pods["t"] = 0                                # que el panel lo vea al momento
    _cache_apps["t"] = 0
    print(f"[cargas] {accion} {ns}/{obj}: {'ok' if cod == 0 else 'falló'}", flush=True)
    if cod != 0:
        return JSONResponse({"ok": False, "motivo": "kubectl no pudo hacerlo"}, status_code=500)
    return {"ok": True}


async def _revisar_apps():
    salida = []
    if not APPS:
        return salida
    try:
        apps = await api_apps()
    except Exception:
        return salida
    for a in apps:
        if not a["listo"]:
            salida.append(_aviso(f"app:{a['clave']}", "critico", f"{a['nombre']} no está disponible",
                                 f"kubectl -n {a['namespace']} get pods", "Aplicaciones"))
        d = a.get("despliegue") or {}
        if d.get("ultimo_resultado") == "FALLÓ":
            salida.append(_aviso(f"app-despliegue:{a['clave']}", "aviso",
                                 f"El último despliegue de {a['nombre']} falló",
                                 "sigue en marcha la versión anterior", "Aplicaciones"))
    return salida


@app.get("/api/enlaces")
async def api_enlaces():
    """Accesos rápidos con su estado (configurados en servicios.yaml)."""
    async def estado(e):
        url = e["url"]
        try:
            trozo = url.split("://", 1)[1]
            host = trozo.split("/", 1)[0]
            puerto = int(host.split(":")[1]) if ":" in host else (443 if url.startswith("https") else 80)
            r, w = await asyncio.wait_for(asyncio.open_connection(host.split(":")[0], puerto), 3)
            w.close()
            return True
        except Exception:
            return False
    vivos = await asyncio.gather(*(estado(e) for e in ENLACES))
    return [{"nombre": e.get("nombre", e["url"]), "url": e["url"],
             "nota": e.get("nota", ""), "icono": e.get("icono", ""),
             "app": e.get("app") or {},
             "activo": v} for e, v in zip(ENLACES, vivos)]


@app.get("/api/servicios")
async def api_servicios():
    """Servicios configurados y si responden ahora mismo (lo usa el panel)."""
    claves = list(SERVICIOS)
    estados = await asyncio.gather(*(listo(SERVICIOS[c]) for c in claves))
    return [{"clave": c,
             "nombre": SERVICIOS[c].get("nombre", c),
             "nodo": SERVICIOS[c]["nodo"],
             "puerto": SERVICIOS[c]["puerto"],
             "icono": SERVICIOS[c].get("icono", ""),
             "app": SERVICIOS[c].get("app") or {},
             "listo": ok} for c, ok in zip(claves, estados)]


@app.get("/api/smart")
async def api_smart():
    """Estado SMART de las máquinas, para el panel (lo generan revisar-smart y recoger-smart)."""
    salida = {}
    ficheros = ["/var/lib/revisar-smart/resumen.json"] + sorted(
        glob.glob("/var/lib/revisar-smart/remotos/*.json"))
    for f in ficheros:
        try:
            d = json.loads(Path(f).read_text())
            host = d.get("host", Path(f).stem)
            estado = d.get("estado", "?")
            salida[host] = estado if estado == "ok" else f"{estado}: {d.get('detalle', '')}"[:80]
        except Exception:
            continue
    return JSONResponse(salida or {"smart": "sin datos"})


@app.get("/")
async def indice():
    pagina = ESTATICOS / "index.html"
    if pagina.is_file():
        return FileResponse(pagina)
    return HTMLResponse(_indice_simple())


def _indice_simple():
    filas = "".join(f'<li><a href="/abrir/{c}">{s.get("nombre", c)}</a> '
                    f'<small>({s["nodo"]})</small></li>' for c, s in SERVICIOS.items())  # noqa
    return f"<!doctype html><meta charset=utf-8><title>Despertador</title>" \
           f"<body style='font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:2rem'>" \
           f"<h1>Servicios bajo demanda</h1><ul>{filas}</ul>"


PAGINA_ESPERA = """<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Encendiendo {{NODO}}…</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family: system-ui, sans-serif; background:#0f172a; color:#e2e8f0; }
  .caja { text-align:center; padding:2rem; }
  .rueda { width:56px; height:56px; margin:0 auto 1.5rem; border-radius:50%;
           border:5px solid #334155; border-top-color:#38bdf8; animation: giro 1s linear infinite; }
  @keyframes giro { to { transform: rotate(360deg); } }
  h1 { font-size:1.4rem; margin:.2rem 0; }
  p  { color:#94a3b8; margin:.4rem 0; }
  .fase { color:#38bdf8; font-weight:600; }
</style></head>
<body><div class="caja">
  <div class="rueda"></div>
  <h1>Abriendo {{NOMBRE}}</h1>
  <p class="fase" id="fase">Encendiendo {{NODO}}…</p>
  <p><span id="t">0</span> s · suele tardar 1-2 minutos</p>
</div>
<script>
  const inicio = Date.now();
  setInterval(() => document.getElementById('t').textContent =
    Math.round((Date.now() - inicio) / 1000), 1000);
  async function comprobar() {
    try {
      const r = await fetch('/api/servicio/{{CLAVE}}', {cache: 'no-store'});
      const d = await r.json();
      if (d.listo) { document.getElementById('fase').textContent = '¡Listo! Abriendo…';
                     location.href = d.url; return; }
      document.getElementById('fase').textContent = d.nodo_despierto
        ? 'Nodo encendido, arrancando el servicio…' : 'Encendiendo {{NODO}}…';
    } catch (e) {}
    setTimeout(comprobar, 3000);
  }
  comprobar();
</script></body></html>"""


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PUERTO_WEB, log_level="warning")
