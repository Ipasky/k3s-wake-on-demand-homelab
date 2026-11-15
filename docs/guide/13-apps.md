# 13 · Deploying your apps

[← 12 · Backups](12-backups.md) · [Guide index](README.md)

Your own apps go from code to running with **`git push pi main`**: the Pi builds the image, rolls it
out to K3s and rolls it back if it does not start. No registry, no CI service, no Docker daemon.

Example of an app deployed this way: [**ticket-scanner**](https://github.com/Ipasky/ticket-scanner)
(see its `Dockerfile` and `deploy/` folder).

## 13.1 How it works

```
git push pi main
   └─ bare repo on the Pi  ~/git/<app>.git  →  hook post-receive
        └─ desplegar-app <app>
             1. extract the pushed commit
             2. podman build  → arm64 image  localhost/<app>:<commit>
             3. import it into K3s (containerd)
             4. render deploy/*.yaml: __IMAGEN__ and your __MARKERS__ from ~/apps/<app>/local.conf
             5. kubectl apply, wait for the rollout
             6. failed? → show the pod's last log lines and roll back to the previous version
```
Only `main` is deployed. Each attempt is logged in `~/apps/<app>/despliegues.log`, which the dashboard
reads for its *Apps* view (version, date, result of the last push, restarts, memory).

## 13.2 Prepare the Pi (once)

```bash
sudo apt install -y podman
grep raspberrypi /etc/subuid /etc/subgid        # rootless Podman needs these ranges
echo "raspberrypi ALL=(root) NOPASSWD: /usr/local/sbin/importar-imagen" | sudo tee /etc/sudoers.d/40-importar-imagen
sudo chmod 440 /etc/sudoers.d/40-importar-imagen && sudo visudo -c
```
[`desplegar-app`](../../scripts/desplegar-app) and [`importar-imagen`](../../scripts/importar-imagen)
are installed by `desplegar.ps1`. The second one is the only thing that runs as root: it imports an
image archive into K3s and nothing else.

## 13.3 A new app

**On the Pi, as the normal user** (not root, otherwise pushes fail with *dubious ownership*):
```bash
desplegar-app --crear my-app
```
**In the app's repository** (on your PC):
```powershell
git remote add pi pi:git/my-app.git      # "pi" = the SSH alias from chapter 1
```
Keep the remotes separate: `origin` is GitHub (publish the code), `pi` is production (deploy it).

**What the repository needs:**

| File | Content |
|---|---|
| `Dockerfile` | How to build the image. It is built on the Pi, so it must work on arm64 |
| `.dockerignore` | Keep `.env`, keys and data out of the image |
| `deploy/desplegar.conf` | `NAMESPACE=my-app` and `DEPLOYMENT=my-app` |
| `deploy/*.yaml` | Manifests with `image: __IMAGEN__` and `imagePullPolicy: Never`, **no secrets** |

Values that belong to your installation, such as the domain, are written as markers in the manifests
(``Host(`my-app.__DOMINIO__`)``) and filled in from a file that only exists on the Pi:
```bash
echo "DOMINIO=my-cluster.duckdns.org" > ~/apps/my-app/local.conf
```
If a marker has no value, nothing is deployed. This way the app's public repository never contains
your domain.

**Secrets** are created once by hand on the Pi:
```bash
kubectl create namespace my-app
kubectl -n my-app create secret generic my-app-env --from-file=.env=/tmp/my-app.env
shred -u /tmp/my-app.env
```
And if the app lives under your domain, give it a rule in Authelia's access policy
([chapter 7](07-sso.md)) and its route in the manifests.

## 13.4 Day to day

```bash
git push pi main                          # deploy
```
In VS Code: *··· → Push to… → pi* (the *Sync* button goes to `origin`). The build output appears in the
push itself. To deploy the last commit again without changes: `desplegar-app my-app --otra-vez` on the
Pi. The last three images of each app are kept; older ones are removed.

To show the app on the dashboard, add it to the `apps:` section of `servicios.yaml`
([chapter 8](08-dashboard.md#82-serviciosyaml)). With a `dato_cmd` (a read-only command run inside
the pod that prints JSON, e.g. `{"texto": "3 receipts this month"}`), its card shows a live summary.

| Symptom | Cause |
|---|---|
| `dubious ownership` on push | the repository was created as root: `sudo chown -R raspberrypi: ~/git ~/apps` |
| "falta Dockerfile / desplegar.conf" | the repository does not follow the contract above |
| "faltan valores en local.conf" | a `__MARKER__` in the manifests has no value on the Pi |
| It does not start and rolls back | the push output shows the pod's last log lines |

---

That's the whole cluster. For the reasoning behind each piece, see [design decisions](../decisions.md);
for what went wrong along the way, [lessons learned](../lessons-learned.md).

[← 12 · Backups](12-backups.md) · [Guide index](README.md)
