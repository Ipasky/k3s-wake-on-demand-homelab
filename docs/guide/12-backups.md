# 12 · Backups

[← 11 · CrowdSec](11-crowdsec.md) · [Guide index](README.md) · Next: [13 · Deploying your apps →](13-apps.md)

Three layers, each for a different kind of loss:

| What | Tool | Where | When |
|---|---|---|---|
| **Data** (app databases and files, SSO, dashboard history, cluster state) | [`hpc-respaldo`](../../scripts/hpc-respaldo) + **restic** | a dedicated disk in the CPU node | every 3 days |
| **Configuration** (files in `/etc`, manifests, cluster objects) | [`hpc-backup`](../../scripts/hpc-backup) + git | a git repository on the Pi, cloned to the admin PC | daily |
| **Secrets** (WireGuard keys, K3s token and database, certificates, tokens) | `hpc-backup --secretos` + GPG | an encrypted archive you copy off the Pi | after important changes |

## 12.1 Data: restic to a node that wakes up for it

**The disk** (on the CPU node), identified by model, with `nofail`:
```bash
DISK=/dev/disk/by-id/ata-...
sudo wipefs -a $DISK
sudo parted -s $DISK mklabel gpt mkpart respaldo ext4 0% 100% && sudo partprobe $DISK && sleep 2
sudo mkfs.ext4 -m 0 -L respaldo ${DISK}-part1
sudo mkdir -p /srv/respaldo
echo "LABEL=respaldo /srv/respaldo ext4 defaults,noatime,nofail,x-systemd.device-timeout=10s 0 2" | sudo tee -a /etc/fstab
sudo mount -a && sudo chown faraday:faraday /srv/respaldo
```

**The repository** (on the Pi). The password lives in `/etc/hpc-respaldo/clave`. **Without it the
backups cannot be read**, so keep a copy somewhere else:
```bash
sudo apt install -y restic sqlite3
sudo mkdir -p /etc/hpc-respaldo
sudo sh -c 'umask 077; openssl rand -base64 32 > /etc/hpc-respaldo/clave'
sudo hpc-respaldo --iniciar
```

**What to back up**: `/etc/hpc-respaldo/fuentes.conf`, from
[`config/hpc-respaldo-fuentes.example.conf`](../../config/hpc-respaldo-fuentes.example.conf). One line
per source: a K3s volume (`pvc <name> <namespace>/<pvc>`, its folder on disk is found automatically)
or a path on the Pi (`ruta <name> /path`). Missing sources are skipped with a warning.

**How a run works** (`hpc-respaldo.timer`, days 1, 4, 7… at 14:00, daytime on purpose because the node is
noisy):
1. Wake the CPU node and hold it with the `power-hold` label.
2. Dump every SQLite database with `.backup`, consistent even while the app writes.
3. `restic backup` over SFTP, then retention (10 last, 8 weekly, 12 monthly, 3 yearly) and a check
   that re-reads 2 % of the data.
4. Release the node, which goes back to sleep, and write `/var/lib/hpc-respaldo/estado.json` for the
   dashboard (it warns if the last run failed or is older than four days).

```bash
sudo hpc-respaldo              # run now
sudo hpc-respaldo --lista      # snapshots
```

**A backup only counts once it has been restored.** With the node awake:
```bash
sudo bash -c '
export RESTIC_PASSWORD_FILE=/etc/hpc-respaldo/clave
export RESTIC_REPOSITORY=sftp:faraday@192.168.1.21:/srv/respaldo/restic
restic -o "sftp.command=ssh -i /home/raspberrypi/.ssh/id_ed25519 faraday@192.168.1.21 -s sftp" \
  restore latest --target /tmp/restored --include /var/backups/hpc-respaldo/<source>'
sqlite3 /tmp/restored/.../app.db "PRAGMA integrity_check;"      # ok
```
Put restored databases back with the app stopped.

## 12.2 Configuration history in git

`hpc-backup` (daily at 3:00) copies the Pi's configuration, the manifests in `~/k8s`, an export of the
cluster objects and, if they are awake, the nodes' files into a git repository
(`/home/raspberrypi/hpc-config`), and commits only when something changed. You get a full history of
*what changed when*:
```bash
sudo apt install -y git jq sqlite3 gnupg
sudo hpc-backup
git -C ~/hpc-config log --oneline | head
```
Clone it read-only to the admin PC (`git clone raspberrypi@192.168.1.20:hpc-config`) and `git pull`
from time to time: a second copy away from the Pi. Never publish it: it is your real configuration.

## 12.3 Secrets

```bash
sudo hpc-backup --secretos       # asks for a password → ~/hpc-secretos/secretos-DATE.tar.gz.gpg
```
Copy the archive to the admin PC, and write the password down somewhere safe. To open it:
`gpg -d secretos-DATE.tar.gz.gpg | tar -xzf -`.

## 12.4 Not yet covered

- **Off-site copy**: everything above is in the same house. restic can also push to cloud storage
  (e.g. an S3-compatible bucket). Planned.
- **The photo library** is on the phone and on the NAS; adding it to restic needs a bigger target disk.

[← 11 · CrowdSec](11-crowdsec.md) · [Guide index](README.md) · Next: [13 · Deploying your apps →](13-apps.md)
