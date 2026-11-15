#!/usr/bin/env python3
"""
generar-paletas.py: trae las paletas del escáner de tiquets al panel del HPC.

Lee los tokens de color de ticket-scanner/src/public/index.html (la paleta
original y las de :root[data-paleta="…"][data-theme="light|dark"]) y escribe:

  panel/static/paletas.css   los tokens de cada paleta con prefijo --p-* (claro/oscuro)
  panel/static/paletas.js    nombres y muestras para la galería de temas del panel

Cómo encajan en el panel lo decide estilo.css (bloque "paletas del escáner"),
no este script. Se vuelve a lanzar cuando cambien las paletas del escáner:

  python tools/generar-paletas.py ../ticket-scanner/src/public/index.html
"""
import json, re, sys
from pathlib import Path

ORIGEN = Path(sys.argv[1] if len(sys.argv) > 1 else "../ticket-scanner/src/public/index.html")
DESTINO = Path(__file__).resolve().parent.parent / "panel" / "static"

TOKENS = ["fondo", "blob-1", "blob-2", "blob-3", "blob-4", "blob-5", "blob-6", "blob-opacidad",
          "grano-opacidad", "grano-mezcla", "vidrio", "vidrio-linea", "superficie-2", "borde",
          "borde-fuerte", "texto", "texto-2", "acento", "acento-texto", "finde-texto", "casilla",
          "casilla-borde", "g", "o", "r", "sombra", "radio"]
NOMBRES = {"original": "Cálida", "verde": "Verde", "magenta": "Magenta", "amarillo": "Amarillo",
           "rojo": "Rojo", "sobrio": "Sobrio", "lima": "Lima"}

html = ORIGEN.read_text(encoding="utf-8")
estilo = html[html.index("<style>"):html.index("</style>")]
estilo = re.sub(r"/\*.*?\*/", "", estilo, flags=re.S)

# Bloques de primer nivel o dentro de @media: selector { declaraciones }
SEL = re.compile(r'(:root(?:\[data-paleta="([a-z]+)"\])?(?:\[data-theme="(light|dark)"\])?)\s*\{([^{}]*)\}')
valores = {}            # (paleta, modo) -> {token: valor}
for m in SEL.finditer(estilo):
    # solo selectores exactos (sin :not, sin descendientes): mirar lo que hay justo antes
    antes = estilo[max(0, m.start() - 1):m.start()]
    if antes and antes not in " \n\t{}":
        continue
    paleta, modo, cuerpo = m.group(2) or "original", m.group(3), m.group(4)
    if paleta == "original" and modo is None:
        modos = ["light"]               # :root a secas = claro original
    elif modo is None:
        continue
    else:
        modos = [modo]
    for decl in cuerpo.split(";"):
        if ":" not in decl or not decl.strip().startswith("--"):
            continue
        k, v = decl.split(":", 1)
        k = k.strip()[2:]
        if k in TOKENS:
            for mo in modos:
                valores.setdefault((paleta, mo), {})[k] = " ".join(v.split())

base = {mo: valores[("original", mo)] for mo in ("light", "dark")}
faltan = [t for t in TOKENS if t not in base["light"]]
for mo in ("light", "dark"):
    for t in TOKENS:                    # el oscuro original hereda del claro lo que no define
        base[mo].setdefault(t, base["light"].get(t))
paletas = [p for p in NOMBRES if ("original" == p) or (p, "light") in valores]

def es_tinta(v):
    """¿El acento del escáner es tinta (casi negro/blanco) y no un color?"""
    v = v.strip()
    m = re.match(r"hsl\(\s*[\d.]+\s+([\d.]+)%\s+([\d.]+)%", v)
    if m:
        s, l = float(m.group(1)), float(m.group(2))
    elif re.match(r"#[0-9a-fA-F]{6}$", v):
        r, g, b = (int(v[i:i + 2], 16) / 255 for i in (1, 3, 5))
        mx, mn = max(r, g, b), min(r, g, b); l = (mx + mn) / 2 * 100
        s = 0 if mx == mn else (mx - mn) / (1 - abs(2 * l / 100 - 1)) * 100
    else:
        return True
    return s < 30 or l < 18 or l > 88

def css_valor(v):
    return re.sub(r"var\(--([a-z0-9-]+)\)", lambda m: f"var(--p-{m.group(1)})", v)

lineas = ["/* GENERADO por herramientas/generar-paletas.py a partir del escáner de tiquets.",
          "   No editar a mano: se sobrescribe. Cómo se usan estos tokens: estilo.css. */", ""]
muestras = []
for p in paletas:
    muestra = {"clave": p, "nombre": NOMBRES[p]}
    for mo, tema in (("light", "claro"), ("dark", "oscuro")):
        datos = dict(base[mo]) if p == "original" else dict(valores.get((p, mo), {}))
        sel = f'html[data-paleta]' if p == "original" else f'html[data-paleta="{p}"]'
        completo = {**base[mo], **datos}
        # Acento del panel (gráficas, enlaces, foco): el del escáner si es un color;
        # si es tinta, el color vivo del fin de semana de esa paleta.
        datos["acento-panel"] = "var(--finde-texto)" if es_tinta(completo["acento"]) else "var(--acento)"
        decl = "\n".join(f"  --p-{k}: {css_valor(v)};" for k, v in datos.items() if v)
        lineas += [f'{sel}[data-tema="{tema}"] {{', decl, "}", ""]
        muestra[tema] = {k: completo.get(k) for k in ("fondo", "blob-1", "blob-2", "blob-3")}
        muestra[tema]["acento"] = completo["finde-texto"] if es_tinta(completo["acento"]) else completo["acento"]
    muestras.append(muestra)

(DESTINO / "paletas.css").write_text("\n".join(lineas), encoding="utf-8", newline="\n")
(DESTINO / "paletas.js").write_text(
    "/* GENERADO por tools/generar-paletas.py, no editar a mano. */\n"
    "const PALETAS_ESCANER = " + json.dumps(muestras, ensure_ascii=False, indent=1) + ";\n",
    encoding="utf-8", newline="\n")
print("paletas:", ", ".join(paletas), "| tokens que no tiene la original:", faltan or "ninguno")
