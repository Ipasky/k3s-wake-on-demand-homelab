# Design decisions

Why the cluster is built the way it is. Each entry records the problem, what was chosen, what was
considered and rejected, and what the choice costs. They are written in the order the cluster was
built, so later decisions sometimes build on earlier ones.

| # | Decision | In one line |
|---|---|---|
| 1 | [Always-on Pi + sleeping nodes](#1-an-always-on-pi-and-nodes-that-sleep) | Only the cheap machine runs 24/7 |
| 2 | [Full power-off (S5) + Wake-on-LAN](#2-full-power-off-s5-and-wake-on-lan-not-suspend) | No suspend-to-RAM |
| 3 | [K3s instead of Slurm](#3-k3s-instead-of-slurm) | One scheduler for batch jobs *and* services |
| 4 | [Own power controller](#4-an-own-power-controller-on-top-of-k3s) | A few hundred lines of shell instead of an autoscaler |
| 5 | [Wake on access for services](#5-waking-nodes-when-a-service-is-opened) | Opening the photo library boots the node |
| 6 | [Nothing exposed but the VPN](#6-nothing-exposed-to-the-internet-except-wireguard) | WireGuard is the only open port |
| 7 | [A real certificate for a private domain](#7-a-real-https-certificate-for-a-domain-that-points-to-a-private-ip) | DuckDNS + DNS-01, pointing to a LAN IP |
| 8 | [Authelia for single sign-on](#8-authelia-for-single-sign-on) | Passkeys, one small container |
| 9 | [CrowdSec on the host](#9-crowdsec-on-the-host-not-in-the-cluster) | Not inside K3s |
| 10 | [Immich + FileBrowser Quantum as the NAS](#10-immich--filebrowser-quantum-as-the-nas-on-the-gpu-node) | Web-only, on the GPU node |
| 11 | [restic to a sleeping node](#11-restic-backups-to-a-disk-in-a-node-that-is-woken-for-it) | The backup target wakes up for the job |
| 12 | [`git push` deploys built on the Pi](#12-git-push-deploys-images-built-on-the-pi) | No registry, no CI service |
| 13 | [An own dashboard](#13-an-own-dashboard-instead-of-homepage) | Replaced Homepage |
| 14 | [Plain files + markers for configuration](#14-configuration-as-plain-files-with-markers-for-private-values) | One public repo, private values stay local |

---

### 1. An always-on Pi and nodes that sleep

**Context.** Two desktop PCs (an i5 and an i7 with a GTX 1050 Ti) are useful for rendering, small AI
models and storage, but they are idle most of the day. Left on, they waste tens of watts each and
wear out their hard drives.

**Decision.** A Raspberry Pi 5 is the only machine that is always on. It runs the control plane and
every light, always-needed service (VPN, SSO, dashboard, monitoring, small apps). The PCs are
treated as **resources that are switched on when there is work for them**.

**Alternatives.** Keeping one PC always on as the "server" (simpler, but it is exactly the waste the
project tries to avoid). Running everything on the Pi (not enough CPU/GPU for the heavy work).

**Consequences.** Anything that must answer at any time has to fit in the Pi's 8 GB of RAM and ARM
CPU, so the Pi services are chosen for being light (see 8, 9, 13). Everything that lives on a node
must tolerate a ~35 s start.

### 2. Full power-off (S5) and Wake-on-LAN, not suspend

**Context.** Nodes can sleep in suspend-to-RAM (S3) or be fully powered off (S5).

**Decision.** **S5** + Wake-on-LAN. Measured: ~35 s from the magic packet to the node being Ready in
K3s, ~3 s to power off.

**Alternatives.** S3 wakes faster (a few seconds) but still draws power, is less reliable across
drivers (especially with an NVIDIA card), and a node that fails to resume is harder to recover than
one that boots cleanly.

**Consequences.** Wake-on-LAN needed per-board work: disabling ErP in the BIOS of one node, and on the
other only allowing the network card to wake the machine (USB and the GPU slot were waking it up).
That board also turns itself back on after the first shutdown that follows a network wake; instead
of a risky BIOS update, the shutdown script watches the node for 90 s and powers it off again if
nobody asked for it. The hard drive is the component that suffers most from power cycles, so the
idle time is long enough to group work, and SMART counters (`Start_Stop_Count`) are watched.

### 3. K3s instead of Slurm

**Context.** The first attempt at this cluster used **Slurm**, the standard HPC scheduler. It handles
batch jobs well, but the cluster also has to run long-lived **services** (photo library, file
browser, web apps) and their networking, certificates and authentication.

**Decision.** **K3s**: a lightweight, certified Kubernetes distribution that runs comfortably on the
Pi as server, with the PCs as agents.

**Alternatives.** Slurm (batch only; services would need a second system next to it). Full
Kubernetes with kubeadm (heavier on the Pi, more moving parts). Docker Compose on each machine (no
scheduling across nodes, no common place to express "this needs a GPU").

**Consequences.** Batch work is a Kubernetes **Job** with a `nodeSelector` (`node-type: cpu|gpu`), a
toleration and, for the GPU, `runtimeClassName: nvidia`. The nodes carry a
`power=ondemand:NoExecute` taint, so nothing lands on them by accident and keeps them awake. The
bundled Traefik, local-path storage and service load balancer are reused instead of installed apart.

### 4. An own power controller on top of K3s

**Context.** Something has to decide *when* to wake and power off the nodes.

**Decision.** `nodo-controlador`, a small systemd service on the Pi. Every 30 s it looks at the
cluster: a pending pod that only fits on a sleeping node wakes it; a node with no jobs, no recent
service traffic, no open SSH sessions and no manual `power-hold=true` label is powered off after the
idle time.

**Alternatives.** The Kubernetes Cluster Autoscaler (built for cloud providers; adapting it to
Wake-on-LAN means writing a custom provider anyway). Slurm's power saving (see 3). Fixed schedules
(simple, but the nodes would be on when nobody needs them and off when someone does).

**Consequences.** Full control and very little code, at the price of maintaining it. One real bug
came from the environment: counting logged-in users with `who` stopped working on a recent Ubuntu
(no `utmp`), so a node could be powered off with an SSH session open; it now counts established SSH
connections instead.

### 5. Waking nodes when a service is opened

**Context.** The controller in 4 reacts to *jobs*. A service like the photo library has no pending
pod: it is simply unreachable while its node sleeps.

**Decision.** The **despertador** ("waker") on the Pi sits in front of those services. Opening one
while its node is down shows a "waking up…" page, sends the magic packet and redirects when the
service is healthy. For apps that cannot follow a web page (the phone app of the photo library), it
forwards the TCP port and can **wake the node on the first connection**. Real traffic stamps the
node as active, so it is not powered off while in use.

**Alternatives.** Keeping the NAS node always on (defeats 1). A fixed backup window for the phone
(photos would only sync at certain hours).

**Consequences.** Anything that retries in the background can keep a node awake (an open browser
tab of the photo library did exactly that once), so background sync on the phone is disabled and
the photos sync when the app is opened. Even so, the app checks the server on its own now and
then: the waker reads the first request of each connection and ignores those automatic paths, and it
also keeps quiet hours and does not wake a node you have just put to sleep by hand.

### 6. Nothing exposed to the internet except WireGuard

**Context.** The cluster holds personal photos and financial data.

**Decision.** The router forwards a **single UDP port to WireGuard**. Every service is reachable
only from the VPN or from known devices on the home LAN. Each machine runs a **default-deny
nftables** firewall; the nodes cannot initiate connections to the rest of the home network.

**Alternatives.** Publishing services with a reverse proxy on 443 (much larger attack surface).
Tailscale / ZeroTier (easier, but depends on a third party's coordination servers).

**Consequences.** WireGuard does not answer packets without a valid key, so from the internet the
house looks closed. K3s services are forwarded, not delivered to the host, so they are filtered in
the nftables **forward** chain too: closing a port only in `input` is not enough. The firewall files
never flush the whole ruleset, because that also deletes the rules K3s creates.

### 7. A real HTTPS certificate for a domain that points to a private IP

**Context.** Browsers, passkeys and PWAs need valid HTTPS, but the services are private and there
is no paid domain.

**Decision.** A free **DuckDNS** subdomain whose records point to the Pi's **private** LAN address,
and a **wildcard Let's Encrypt certificate** obtained with the **DNS-01** challenge (`acme.sh`),
installed as the default certificate of Traefik and renewed automatically.

**Alternatives.** A self-signed CA (every device must trust it, passkeys and phone apps complain).
HTTP-01 challenge (needs port 80 open to the internet). Buying a domain (works, but not needed).

**Consequences.** Valid HTTPS everywhere with no port open for it, and the public DNS reveals only a
private address. DuckDNS allows a single TXT record, so only the wildcard is requested, not the base
name.

### 8. Authelia for single sign-on

**Context.** Several web services, each with its own login, some of them handling sensitive data.

**Decision.** **Authelia** in front of everything through Traefik's `forwardAuth`: one login, with
**passkeys (WebAuthn)**, two-factor required for the apps with financial data, and the user passed
to the apps in a header (`Remote-User`) so they need no login of their own.

**Alternatives.** Authentik (feature-rich, but PostgreSQL + Redis, hundreds of MB on the Pi). Pocket
ID (OIDC only: would need an extra OAuth2 proxy, and its configuration is not a versionable file).

**Consequences.** One Go container with SQLite, ~30–60 MB of RAM, configured in YAML. Header-based
identity is only safe if the app is reachable **only** through Traefik, so the ports behind it are
closed in the firewall.

### 9. CrowdSec on the host, not in the cluster

**Context.** Visibility into attacks (SSH, web, port scans) and the ability to block them.

**Decision.** **CrowdSec** installed as a system package on the Pi, reading the journal, the
Traefik access log (JSON) and the firewall log, with the **nftables bouncer** to ban IPs. The
dashboard talks to it through a small root helper with a narrow `sudo` rule that refuses to ban the
cluster's own addresses.

**Alternatives.** Fail2ban (per-service rules, no shared scenarios). Running CrowdSec inside K3s
(more memory, harder access to host logs and to nftables).

**Consequences.** The default private-IP whitelist was removed on purpose: a compromised device at
home is one of the cases worth catching; only the cluster's own machines and the VPN are
whitelisted. The community blocklist is disabled, because a phone behind carrier-grade NAT can share
its public IP with someone on the list, which would lock the owner out of the VPN.

### 10. Immich + FileBrowser Quantum as the NAS, on the GPU node

**Context.** Phone photo backup and a place for files, without keeping a machine on.

**Decision.** The NAS lives on the **GPU node**, on a 3 TB disk mounted with `nofail` (the node must
boot even if the disk dies). **Immich** for photos (its machine-learning container uses the GPU for
faces and search) and **FileBrowser Quantum** for files, both **web-only**, woken on access (5).

**Alternatives.** Nextcloud (one app for everything, but heavy and weaker for photos). A NAS OS such
as TrueNAS or OpenMediaVault (would replace the node's operating system and take it out of the
cluster). SMB shares (mapped drives hang while the node sleeps). For the file browser: the original
FileBrowser (used at first, archived in September 2026), Filestash (polished, but single sign-on is a
paid feature, so it would mean a second login), copyparty (very capable, dense interface) and
OpenCloud (a full sync cloud, whose clients would keep waking the node).

**Consequences.** Immich's storage template keeps the files in plain `year/date` folders, readable
without Immich. Volumes use `hostPath`, because the local-path provisioner cannot reach tainted
nodes. FileBrowser Quantum serves the folders as they are, so switching file browser never touches
the files, and it takes the portal's login through the `Remote-User` header.

### 11. restic backups to a disk in a node that is woken for it

**Context.** The Pi holds the data that matters most (SSO, app databases, configuration, the
dashboard's history) on a single SSD.

**Decision.** **restic** over SFTP to a dedicated disk in the **CPU node**, every three days. The job
wakes the node, holds it awake with the `power-hold` label, dumps every SQLite database with
`.backup` (consistent even while in use), backs up, applies retention, verifies a sample of the
data and lets the node sleep again. The dashboard shows the result.

**Alternatives.** Daily backups (more power cycles of the target disk for little gain). rsync
snapshots (no encryption, no deduplication). Backing up to the same disk (does not survive the disk).

**Consequences.** Backups run in the afternoon on purpose: the node is in a living space and is
noisy. A backup only counts once it has been **restored**: the first restore test checked the
integrity of a real database. An off-site copy is still on the roadmap.

### 12. `git push` deploys, images built on the Pi

**Context.** Own apps (the [ticket scanner](https://github.com/Ipasky/ticket-scanner), others later)
need a simple way to go from code to running.

**Decision.** Each app has a bare repository on the Pi. A `post-receive` hook builds the **arm64**
image with **Podman** on the Pi, imports it into K3s, applies the app's manifests (filling in
markers such as the image tag or the domain from a file that only exists on the Pi), waits for the
rollout and **rolls back** if it fails. `origin` (GitHub) and `pi` (production) are separate remotes.

**Alternatives.** GitHub Actions + a registry (cross-building arm64 images, credentials for the
registry, and the cluster would pull from the internet). Docker on the Pi (a daemon running as root;
Podman is daemonless and rootless).

**Consequences.** Deploying is `git push pi main`; secrets never live in the app repositories (they
are created once as Kubernetes Secrets). The first build of an app is slow on the Pi; later builds
reuse the layer cache.

### 13. An own dashboard instead of Homepage

**Context.** The cluster started with **Homepage**, a popular dashboard. It shows services well, but
not what is specific here: nodes that sleep, waking them, power control, the network and security
picture.

**Decision.** A dashboard written from scratch, served by the despertador: **FastAPI** backend and
plain JavaScript, no framework or build step. Node metrics come from **Beszel**'s API; the rest from
the cluster, the firewall log, CrowdSec and the apps themselves.

**Alternatives.** Keep Homepage and extend it with custom widgets (limited to what its widgets can
show). Grafana (excellent for metrics, poor for actions like waking a node).

**Consequences.** More code to maintain, but every view answers a real question of this cluster;
it is installable on the phone and themeable. Homepage was removed from the cluster.

### 14. Configuration as plain files, with markers for private values

**Context.** The whole setup should be reproducible and public, without publishing the domain,
addresses or device names of a real home.

**Decision.** Every script, unit, manifest and firewall file lives in this repository. Values that
belong to an installation are written as `@@MARKER@@` and filled in from an ignored
`config/local.env` when deploying (`desplegar.ps1`). A **pre-commit hook** blocks any commit that
contains one of those values.

**Alternatives.** Ansible (the right tool for many machines; overkill for three). Two repositories,
private and public, kept in sync by hand (they drift).

**Consequences.** One repository for both running the cluster and showing it. Rendered output can be
compared byte by byte with what is installed, which is how the restructuring into this layout was
checked.
