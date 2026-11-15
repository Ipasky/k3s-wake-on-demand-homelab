#!/usr/bin/env bash
#
# instalar.sh: instala en esta máquina los ficheros del clúster que encuentre en la carpeta
#
#   sudo ./instalar.sh
#
# Coloca cada fichero en su sitio con sus permisos, recarga systemd y reinicia lo que toque.
# Respeta la configuración existente: nunca sobrescribe /etc/default/* ni /etc/despertador/*,
# y conserva las MAC del script 'nodo'.
#
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "Ejecútalo con sudo" >&2; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
USUARIO="$(stat -c '%U' "$DIR")"          # dueño de la carpeta = usuario normal de la máquina
HOST="$(hostname)"
cambios=(); recargar=0

hay(){ [[ -f "$DIR/$1" ]]; }
poner(){ # origen modo destino
  sed -i 's/\r$//' "$DIR/$1"
  install -m "$2" "$DIR/$1" "$3" && cambios+=("$3")
}
solo_si_falta(){ # origen destino
  if [[ -e "$2" ]]; then echo "   · $2 ya existe, se conserva"; else
    sed -i 's/\r$//' "$DIR/$1"; install -m 644 "$DIR/$1" "$2"; cambios+=("$2 (nuevo)"); fi
}

echo "== Instalando en $HOST (usuario: $USUARIO) =="

# ---------- scripts ----------
if hay nodo; then
  mac_f=$(grep -oE '\[faraday\]="[0-9a-fA-F:]{17}"' /usr/local/bin/nodo 2>/dev/null | grep -oE '[0-9a-fA-F:]{17}')
  mac_m=$(grep -oE '\[mustang\]="[0-9a-fA-F:]{17}"' /usr/local/bin/nodo 2>/dev/null | grep -oE '[0-9a-fA-F:]{17}')
  poner nodo 755 /usr/local/bin/nodo
  [[ -n "${mac_f:-}" ]] && sed -i "s/\[faraday\]=\"\"/[faraday]=\"$mac_f\"/" /usr/local/bin/nodo
  [[ -n "${mac_m:-}" ]] && sed -i "s/\[mustang\]=\"\"/[mustang]=\"$mac_m\"/" /usr/local/bin/nodo
  echo "   · MAC conservadas: ${mac_f:--} / ${mac_m:--}"
fi
hay nodo-controlador && poner nodo-controlador 755 /usr/local/bin/nodo-controlador
hay hpc-backup       && poner hpc-backup       755 /usr/local/bin/hpc-backup
hay hpc-copia        && poner hpc-copia        755 /usr/local/bin/hpc-copia
hay revisar-smart    && poner revisar-smart    755 /usr/local/bin/revisar-smart
hay recoger-smart    && poner recoger-smart    755 /usr/local/bin/recoger-smart
hay hpc-crowdsec     && poner hpc-crowdsec     755 /usr/local/sbin/hpc-crowdsec   # intermediario del panel (root)
hay desplegar-app    && poner desplegar-app    755 /usr/local/bin/desplegar-app   # git push pi main → K3s
hay importar-imagen  && poner importar-imagen  755 /usr/local/sbin/importar-imagen # solo importa imágenes (root)
hay hpc-respaldo     && poner hpc-respaldo     755 /usr/local/bin/hpc-respaldo    # copias a Faraday (restic)
hay rearmar-wol      && poner rearmar-wol      755 /usr/local/sbin/rearmar-wol    # nodos: WoL limpio al apagar
hay vigilar-wol      && poner vigilar-wol      755 /usr/local/sbin/vigilar-wol    # Pi: anota cada paquete de despertar
hay wakeonlan-registro && poner wakeonlan-registro 755 /usr/local/bin/wakeonlan  # Pi: anota quién pide cada despertar

# ---------- despertador ----------
if hay despertador.py; then
  mkdir -p /opt/despertador /etc/despertador
  chown "$USUARIO:" /opt/despertador
  sed -i 's/\r$//' "$DIR/despertador.py"
  install -m 644 -o "$USUARIO" "$DIR/despertador.py" /opt/despertador/despertador.py
  cambios+=("/opt/despertador/despertador.py")
  if [[ ! -d /opt/despertador/venv ]]; then
    echo "   · creando entorno de Python (primera vez)..."
    apt-get install -y -qq python3-venv >/dev/null
    sudo -u "$USUARIO" python3 -m venv /opt/despertador/venv
    sudo -u "$USUARIO" /opt/despertador/venv/bin/pip install -q fastapi uvicorn pyyaml
  fi
fi
hay servicios.yaml && { mkdir -p /etc/despertador; solo_si_falta servicios.yaml /etc/despertador/servicios.yaml; }
hay hpc-respaldo-fuentes.conf && { mkdir -p /etc/hpc-respaldo; solo_si_falta hpc-respaldo-fuentes.conf /etc/hpc-respaldo/fuentes.conf; }

# ---------- portal web (carpeta static) ----------
if [[ -d "$DIR/static" ]]; then
  mkdir -p /opt/despertador/static
  for f in "$DIR"/static/*; do
    [[ -f "$f" ]] || continue
    case "$f" in
      *.png|*.jpg|*.jpeg|*.ico|*.webp|*.woff2) ;;      # binarios: tal cual
      *) sed -i 's/\r$//' "$f" ;;
    esac
    install -m 644 -o "$USUARIO" "$f" "/opt/despertador/static/$(basename "$f")"
    cambios+=("/opt/despertador/static/$(basename "$f")")
  done
fi

# ---------- configuraciones (nunca se pisan) ----------
hay nodo-controlador.env && solo_si_falta nodo-controlador.env /etc/default/nodo-controlador
hay revisar-smart.env    && solo_si_falta revisar-smart.env    /etc/default/revisar-smart

# ---------- unidades de systemd ----------
for u in "$DIR"/*.service "$DIR"/*.timer; do
  [[ -e "$u" ]] || continue
  n="$(basename "$u")"
  sed -i 's/\r$//' "$u"
  install -m 644 "$u" "/etc/systemd/system/$n" && { cambios+=("/etc/systemd/system/$n"); recargar=1; }
done

if (( recargar )); then
  systemctl daemon-reload
  for u in "$DIR"/*.timer; do
    [[ -e "$u" ]] || continue
    systemctl enable --now "$(basename "$u")" >/dev/null 2>&1 && echo "   · temporizador activado: $(basename "$u")"
  done
  # en los nodos: WoL limpio al apagar (servicio sin temporizador, se activa aquí)
  if [[ -e "$DIR/rearmar-wol.service" ]]; then
    systemctl enable --now rearmar-wol.service >/dev/null 2>&1 && echo "   · activado: rearmar-wol.service"
  fi
  # en la Pi: el registro de paquetes de despertar
  if [[ -e "$DIR/vigilar-wol.service" ]]; then
    systemctl enable vigilar-wol.service >/dev/null 2>&1 && systemctl restart vigilar-wol.service \
      && echo "   · activado: vigilar-wol.service"
  fi
fi

# ---------- reinicios ----------
for s in nodo-controlador despertador; do
  systemctl is-enabled "$s" >/dev/null 2>&1 && { systemctl restart "$s"; echo "   · reiniciado: $s"; }
done

echo
if (( ${#cambios[@]} )); then printf 'Instalado:\n'; printf '   %s\n' "${cambios[@]}"
else echo "No había nada que instalar en $DIR"; fi
