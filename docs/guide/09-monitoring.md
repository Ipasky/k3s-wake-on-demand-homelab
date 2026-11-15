# 9 · Monitoring

[← 8 · The dashboard](08-dashboard.md) · [Guide index](README.md) · Next: [10 · NAS →](10-nas.md)

Two light tools: **Beszel** for CPU, RAM, temperature, disk and network history of every machine, and
a small **SMART** check that warns only when a disk gets worse.

## 9.1 Beszel hub

The hub runs on the Pi in K3s; its web UI is published behind the portal at `metricas.<your-domain>`
([`k8s/middleware-beszel.yaml`](../../k8s/middleware-beszel.yaml), see
[chapter 7](07-sso.md#74-put-a-service-behind-the-portal)). Deploy the hub with its official
Kubernetes example (a Deployment with a small volume pinned to the Pi, port 8090), then:

```bash
kubectl apply -f ~/k8s/middleware-beszel.yaml
```
Create your admin account on first visit.

## 9.2 An agent on every machine

In the hub: **Add system** → name = hostname, host = the machine's IP, port `45876`. Copy the KEY and
TOKEN with the copy buttons, then on that machine install the **binary agent** (not the Docker one: on
the K3s machines Docker is not there and the agent belongs outside the cluster):
```bash
curl -sL https://get.beszel.dev -o /tmp/install-agent.sh && chmod +x /tmp/install-agent.sh
sudo /tmp/install-agent.sh -k "THE_KEY" -t "THE_TOKEN"
```
The hub connects to the agents (the firewall of the nodes already accepts `45876` from the Pi). A
sleeping node simply shows as down until it wakes.

> Fixing a wrong KEY/TOKEN without reinstalling: `sudo systemctl edit --full beszel-agent`, correct
> the `Environment=` lines, `daemon-reload` and restart. The KEY starts with `ssh-ed25519 AAAAC3…`.

## 9.3 Beszel as the dashboard's data source

1. Create a **read-only user** in Beszel.
2. Share the systems with it: in the hub's admin (`/_/`, PocketBase) → collection `systems` → each
   system → add the user to the `users` field. **Without this the API returns no systems.**
3. Give the credentials to the dashboard, in `/etc/default/despertador` (mode 600):
   ```ini
   BESZEL_URL=http://127.0.0.1:8090
   BESZEL_USUARIO='reader@example.com'
   BESZEL_CLAVE='the-password'
   ```
4. `sudo systemctl restart despertador` and check
   `curl -s http://127.0.0.1:8095/api/beszel/diagnostico | python3 -m json.tool`.

Beszel stores history in buckets (1, 10, 20, 120, 480 minutes): far in the past the charts lose
resolution; the dashboard requests finer data when you zoom in.

## 9.4 SMART checks

[`scripts/revisar-smart`](../../scripts/revisar-smart) runs daily on every machine, compares the
critical counters with the previous run and **only warns if one went up**: reallocated, pending and
offline-uncorrectable sectors, reported errors, CRC errors (cables) and the overall health.
`desplegar.ps1` installs it with its timer; tell it which disks to watch:

```bash
ls -l /dev/disk/by-id/ | grep -v part              # stable disk paths
sudo tee /etc/default/revisar-smart > /dev/null <<'EOF'
DISCOS="/dev/disk/by-id/ata-DISK1 /dev/disk/by-id/ata-DISK2"
OPCIONES=""          # "-d sat" for a disk behind a USB-SATA adapter (the Pi's SSD)
TEMA_NTFY=""         # optional ntfy.sh topic for a push notification
EOF
sudo revisar-smart                                 # the first run stores the reference
```

On the Pi, [`scripts/recoger-smart`](../../scripts/recoger-smart) collects the nodes' summaries every
hour (a sleeping node keeps its last known state) and the dashboard shows them, with an alert when a
counter grows.

```bash
sudo mkdir -p /var/lib/revisar-smart/remotos && sudo chown -R raspberrypi: /var/lib/revisar-smart/remotos
systemctl list-timers revisar-smart.timer recoger-smart.timer
curl -s http://127.0.0.1:8095/api/smart; echo
```

> For a disk that powers on and off with its node, also watch `Start_Stop_Count` from time to time:
> it tells you how many cycles the sleep schedule is costing.

[← 8 · The dashboard](08-dashboard.md) · [Guide index](README.md) · Next: [10 · NAS →](10-nas.md)
