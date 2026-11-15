# 8 · The dashboard

[← 7 · Single sign-on](07-sso.md) · [Guide index](README.md) · Next: [9 · Monitoring →](09-monitoring.md)

The **despertador** ("waker") is a small FastAPI app on the Pi with two jobs:

1. **Wake on access.** For services that live on a sleeping node, it listens on a port of the Pi and
   forwards the traffic to the node. If the node is off, it wakes it and shows a "waking up…" page
   that redirects when the service is ready. Real traffic stamps the node as active, so the power
   controller does not switch it off while you use it.
2. **The dashboard** at `https://panel.<your-domain>`, installable on the phone: a bar that is always
   on screen with every machine (state, hold lock, power button) and every app, and collapsible
   sections for nodes, apps, alerts, network, security and disks (section 8.5).

Code: [`panel/despertador.py`](../../panel/despertador.py) and [`panel/static/`](../../panel/static).

## 8.1 Install

`desplegar.ps1` already did it: Python virtual environment in `/opt/despertador/venv`, the app in
`/opt/despertador`, the unit `despertador.service`, and (only if it did not exist)
`/etc/despertador/servicios.yaml`. Copy the example and adapt it **before** deploying, or edit the
installed one afterwards:

```powershell
copy config\servicios.example.yaml config\servicios.yaml     # ignored by git
.\deploy\desplegar.ps1 -Solo pi-master
```
```bash
systemctl status despertador --no-pager
journalctl -u despertador -n 20 --no-pager
```

## 8.2 `servicios.yaml`

```yaml
nodos:                              # nodes it may wake: name → IP
  faraday: 192.168.1.21
  mustang: 192.168.1.22

energia:                            # when an automatic connection must NOT wake a node
  respetar_apagado_min: 20          # for this long after you put it to sleep from the dashboard
  silencio: "00:30-08:00"           # nor in these hours (Pi time; may cross midnight)

servicios:                          # services on sleeping nodes
  nas:
    nombre: Photos (Immich)
    nodo: mustang
    puerto: 2283                    # port opened on the Pi
    destino: 192.168.1.22:30283     # NodePort of the service on the node
    comprobacion: /api/server/ping  # HTTP path that answers when the service is ready
    despertar_al_conectar: true     # a raw TCP connection wakes the node (for phone apps)
    no_despiertan:                  # requests the app makes on its own: they never wake the node
      - /api/server/version
    url: https://fotos.my-cluster.duckdns.org/      # through Traefik (chapter 10)
  archivos:
    nombre: Files (FileBrowser)
    nodo: mustang
    puerto: 8082
    destino: 192.168.1.22:30081
    comprobacion: /
    url: https://archivos.my-cluster.duckdns.org/   # open it through Traefik + SSO instead of the port

enlaces:                            # quick links on the home screen
  - nombre: Login portal
    url: https://auth.my-cluster.duckdns.org
    nota: Passkeys and sessions

pares_vpn:                          # names for the VPN devices in the network view
  10.10.10.2: Phone
interfaces_red: [eth0, wg0]

apps:                               # your own apps (chapter 13)
  - clave: ticket-scanner
    nombre: Ticket scanner
    url: https://tiquetscan.my-cluster.duckdns.org
    namespace: ticket-scanner
    deployment: ticket-scanner
    repo: ticket-scanner
```
After editing: `sudo systemctl restart despertador`.

**`despertar_al_conectar`** is meant for apps that cannot follow a web page (the photo library's phone
app). Anything that keeps retrying in the background will keep the node awake: disable background
sync in the phone app, and close browser tabs of those services when you are done.

Phone apps also check the server on their own now and then, even with background sync off. With the
node asleep, the despertador reads the first request of each connection (the real client IP comes
from Traefik's `X-Forwarded-For`) and does **not** wake the node when:
- the path starts with one of `no_despiertan` (find them in the despertador's log, which shows the
  request and the user agent of every connection that woke a node);
- it is within `silencio` hours;
- you put the node to sleep from the dashboard less than `respetar_apagado_min` minutes ago.

Opening the service or pressing the power button on the dashboard always wakes it.

## 8.3 Publish it behind the portal

The dashboard listens on the Pi, outside K3s. [`k8s/panel.yaml`](../../k8s/panel.yaml) gives K3s a
`Service` without selector, an `EndpointSlice` pointing to the Pi, the Authelia middleware and the
route `panel.<your-domain>`, plus an exception without login for the files that make it installable
(`/manifest.webmanifest`, `/sw.js`, the icons), which contain nothing private.

```powershell
.\deploy\desplegar.ps1 -Generar
scp privado\generado\k8s\panel.yaml pi:k8s/
```
```bash
kubectl apply -f ~/k8s/panel.yaml
```
The despertador's own port (8095) stays closed in the firewall: the only way in is through Traefik
and Authelia.

## 8.4 Data sources and permissions

| View | Source | One-time setup on the Pi |
|---|---|---|
| Node cards and charts | Beszel API ([chapter 9](09-monitoring.md)) | credentials in `/etc/default/despertador` |
| Power buttons, shutdown of the Pi | `nodo`, `poweroff` | `raspberrypi ALL=(root) NOPASSWD: /usr/sbin/poweroff` in `/etc/sudoers.d/10-poweroff` |
| VPN devices | `wg show` | `raspberrypi ALL=(root) NOPASSWD: /usr/bin/wg show wg0 dump` in `/etc/sudoers.d/20-wg-show` |
| Firewall blocks | the kernel log | `sudo usermod -aG systemd-journal raspberrypi` |
| Security | CrowdSec ([chapter 11](11-crowdsec.md)) | the `hpc-crowdsec` helper and its sudoers rule |
| Disks | SMART summaries (chapter 9) | |
| Backups | `/var/lib/hpc-respaldo/estado.json` ([chapter 12](12-backups.md)) | |
| Power state, countdown to sleep | the controller's `/run/nodo-controlador/estado.json` ([chapter 4](04-power.md)) | |
| Hold lock | the `power-hold` label and `power/hold-*` annotations | the Pi user's kubeconfig |
| Cluster card (pods, restart / stop / start) | `kubectl` | the Pi user's kubeconfig; system namespaces are read-only |

Every sudoers file: `sudo chmod 440 <file> && sudo visudo -c`. Restart the despertador after adding
the group.

Network history (traffic, connection quality, VPN time, per-service consumption) is kept for 30 days
in `/opt/despertador/datos/trafico.sqlite3`; the security history in the same database is never purged.
The same database keeps the dashboard's own metrics sample of every machine (every 5 minutes for
90 days: Beszel thins out its history after a day, so past days would otherwise show a point every few
hours) and the minutes each machine was on per day, for the calendar.

## 8.5 What it shows

- **Top bar, always on screen:** each machine with a state dot, the tinted card (on / off), the
  **hold lock** (keeps a node awake, the `power-hold` label of chapter 4) and the power button, plus a
  thin countdown to the moment the controller will put it to sleep. Next to them, every app and
  service with its health. Clicking a machine opens its charts.
- **Collapsible sections** (Nodes, Apps, Alerts, Network, Security, Disks), all folded at start. Each
  header shows a dot and a two-word status, so the whole cluster reads at a glance; an open section's
  header sticks to the top while you scroll through it.
- **Charts per machine** (CPU, temperature, RAM, load, network, disk) for the last 1, 6 or 24 hours or
  any past day, with the current value and the maximum of the range. Drag to zoom in, double-click to
  go back. Periods when the machine was off are shaded.
- **Calendar** (month and year): hours on per day for each machine. Click a day to see its charts.
- **Cluster card** inside Nodes: the pods of your own workloads, with restart, stop and start.

On a phone the same page rearranges itself: the three machines on one row, charts stacked and thin
with a single time axis, the month split in two halves.

**Previous versions.** Any folder `panel/versiones/<name>/` with an `index.html` is served at
`https://panel.<your-domain>/v/<name>/` (the previous dashboard is kept as `clasico`). `desplegar.ps1`
does not copy them: `scp -r panel\versiones\<name> pi:/opt/despertador/versiones/` and restart the
despertador, which mounts them at start.

## 8.6 On the phone

Open `https://panel.<your-domain>` and choose *Install app* (Android) or *Add to Home Screen*
(iPhone). A service can open its **native app** instead of the web page:
```yaml
    app:
      android: "intent://open#Intent;scheme=immich;package=app.alextran.immich;end"
      ios: "immich://"
```

## 8.7 Check

- Open a service on a sleeping node: the waiting page appears, the node boots, you are redirected.
  The log shows `despertando el nodo …` and the IP that caused it.
- `kubectl get node mustang -o jsonpath="{.metadata.annotations['power/last-activity']}"` moves while
  you use the service.

| Symptom | Cause |
|---|---|
| Node cards empty, "faltan BESZEL_USUARIO / BESZEL_CLAVE" | `/etc/default/despertador` missing or not loaded by the unit |
| Beszel diagnostics show `"sistemas": []` | the Beszel user has no systems shared with it (chapter 9) |
| Changes do not show after deploying | a browser cache from before the `no-cache` header: reload with Ctrl+F5 once |
| A card does not open | JavaScript error: open the browser console (F12) |
| The countdown bar never shows | the controller is not writing its state (`systemctl status nodo-controlador`) |
| A node wakes up at night by itself | an automatic request missing from `no_despiertan`: look for `→ despertar` in `journalctl -u despertador` |

[← 7 · Single sign-on](07-sso.md) · [Guide index](README.md) · Next: [9 · Monitoring →](09-monitoring.md)
