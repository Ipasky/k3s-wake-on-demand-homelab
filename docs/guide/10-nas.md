# 10 · NAS

[← 9 · Monitoring](09-monitoring.md) · [Guide index](README.md) · Next: [11 · CrowdSec →](11-crowdsec.md)

Photos and files live on a hard drive in a node that sleeps. **Immich** backs up the phone's photos
(its machine-learning container uses the GPU for faces and search) and **FileBrowser Quantum** gives web
access to files with single sign-on. Both are web-only: network drives (SMB) hang while the node
sleeps.

## 10.1 Prepare the data disk (on the node)

```bash
ls -l /dev/disk/by-id/ | grep <MODEL>              # always by id, never by sdX
DISK=/dev/disk/by-id/ata-...

sudo smartctl -H -A $DISK | grep -E "overall-health|Reallocated|Current_Pending|Offline_Uncorrectable|UDMA_CRC"
```
A second-hand disk deserves a full write first (several hours): it confirms the disk accepts writes
and turns "pending" sectors into either good or reallocated ones.
```bash
sudo apt install -y tmux && tmux new -s disk
sudo dd if=/dev/zero of=$DISK bs=16M status=progress oflag=direct      # Ctrl+B, D to detach
```
Partition, format and mount with **`nofail`**: the node must boot even if the disk dies:
```bash
sudo parted -s $DISK mklabel gpt mkpart nas ext4 0% 100%
sudo partprobe $DISK && sleep 2
sudo mkfs.ext4 -L nas -m 0 ${DISK}-part1
sudo mkdir -p /srv/nas
UUID=$(sudo blkid -s UUID -o value ${DISK}-part1)
echo "UUID=$UUID /srv/nas ext4 defaults,noatime,nofail,x-systemd.device-timeout=30s 0 2" | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a && df -h /srv/nas
```
Data on the HDD, databases on the node's SSD:
```bash
sudo mkdir -p /srv/nas/fotos /srv/nas/archivos
sudo mkdir -p /var/lib/immich/postgres /var/lib/immich/ml-cache /var/lib/filebrowser-quantum
sudo chown 1000:1000 /var/lib/filebrowser-quantum /srv/nas/archivos   # FileBrowser runs as user 1000
```

## 10.2 Deploy

Keep the node awake while you work on it: `kubectl label node mustang power-hold=true`.

[`k8s/immich.yaml`](../../k8s/immich.yaml) and [`k8s/filebrowser.yaml`](../../k8s/filebrowser.yaml)
pin everything to the GPU node with the toleration of the `power` taint **and** of `unreachable` /
`not-ready`, so the pods stay bound to the node while it sleeps instead of being rescheduled. Volumes
are `hostPath` (the local-path provisioner cannot reach tainted nodes).

```powershell
.\deploy\desplegar.ps1 -Generar
scp privado\generado\k8s\immich.yaml privado\generado\k8s\filebrowser.yaml pi:k8s/
```
```bash
sed -i "s/CAMBIA-ESTA-CONTRASENA/$(openssl rand -base64 24 | tr -d '/+=')/" ~/k8s/immich.yaml   # database password
kubectl apply -f ~/k8s/immich.yaml -f ~/k8s/filebrowser.yaml
kubectl get pods -n nas -w
```

| Pod | Data |
|---|---|
| `immich-server` (NodePort 30283) | photos on the HDD |
| `immich-db` (PostgreSQL with vector search) | SSD |
| `immich-redis` (Valkey) | |
| `immich-ml` (CUDA, `runtimeClassName: nvidia`) | model cache on the SSD |
| `filebrowser` (FileBrowser Quantum, NodePort 30081) | files on the HDD, its database on the SSD |

> **`immich-db` stuck at 100 % CPU and PostgreSQL never starting?** Some Ubuntu kernels give containers
> a "stacked" AppArmor profile that drops signals between threads, and `gosu` (the step from root to the
> `postgres` user) spins forever. The manifest already runs that one container without AppArmor
> (`appArmorProfile: Unconfined`; it is not exposed to anything) and marks it ready only when
> `pg_isready` answers. Remove the exception once your kernel is fixed (Launchpad #2172531). On an
> Immich deployed before, add it with `kubectl patch` instead of applying the manifest again, so the
> database password in the cluster is not replaced:
> ```bash
> kubectl -n nas patch deploy immich-db --type=json -p='[{"op":"add","path":"/spec/template/spec/containers/0/securityContext","value":{"appArmorProfile":{"type":"Unconfined"}}}]'
> ```

Then add both to `servicios.yaml` ([chapter 8](08-dashboard.md#82-serviciosyaml)) so the Pi wakes the
node when they are opened.

## 10.3 First start

**Immich:** create the admin account, and **before uploading anything** enable the **storage
template**: files are then stored as `library/<user>/<year>/<date>/…`, readable and recoverable
without Immich.

**Immich over HTTPS.** Publish it through Traefik with the domain's certificate
([`k8s/fotos.yaml`](../../k8s/fotos.yaml)): Traefik → the despertador on the Pi (port 2283) → Immich
on the node, so opening it still wakes the node.
```powershell
scp privado\generado\k8s\fotos.yaml pi:k8s/
```
```bash
kubectl apply -f ~/k8s/fotos.yaml
```
There is **no Authelia** in front of it, on purpose: the phone app talks to Immich's API and cannot
go through a login portal, and Immich has its own login. Instead, a Traefik `ipAllowList` only admits
the home network and the VPN (the domain points to a private IP anyway, so from outside it is not
even reachable; this is a second barrier).

On the phone app: server `https://fotos.<your-domain>`, **foreground backup on, background backup
off** (otherwise the phone would wake the node all day). Never enable "delete originals from the
phone". Even with background backup off, the app checks the server now and then on its own; those
requests are listed in `no_despiertan` and quiet hours apply ([chapter 8](08-dashboard.md#82-serviciosyaml)),
so they do not wake the node.

Once the phone and the PC use the HTTPS address, close the direct port (2283) in the Pi's firewall
to everything but the cluster: Traefik reaches it from the pod network.

**FileBrowser Quantum with single sign-on.** Publish it through Traefik and Authelia
([`k8s/archivos.yaml`](../../k8s/archivos.yaml): a selector-less Service pointing at the despertador's
port on the Pi, which wakes the node):
```bash
kubectl apply -f ~/k8s/archivos.yaml
```
There is no login of its own to set up. The `config.yaml` in the manifest's ConfigMap turns off
password login and turns on **proxy authentication**: Quantum trusts the `Remote-User` header that
Traefik fills in with the Authelia user, creates that user on the first visit, and makes the user named
in `adminUsername` (`USUARIO_AUTHELIA` in `local.env`) the administrator. Open
`https://archivos.<your-domain>` and you are in.

Then close the direct port (8082) in the Pi's firewall: header authentication is only safe when
nothing but Traefik can reach the app.

> Why Quantum and not the original FileBrowser: the original project was archived in September 2026
> with known issues left unfixed, one of them in its proxy authentication. Quantum is an active fork
> with the same model (plain folders on disk) and a more modern interface. Pin its version in the
> manifest and update it on purpose.

Release the node: `kubectl label node mustang power-hold-`.

## 10.4 Maintenance

```bash
sudo smartctl -A $DISK | grep -E "Reallocated|Current_Pending|Start_Stop_Count"
kubectl rollout restart deploy/immich-server deploy/immich-ml -n nas      # update (tag: release)
```
Photos live on the phone and on the NAS: two copies. Add a third (chapter 12) before uploading
anything that exists nowhere else.

[← 9 · Monitoring](09-monitoring.md) · [Guide index](README.md) · Next: [11 · CrowdSec →](11-crowdsec.md)
