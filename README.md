<a name="top"></a>
<h1 align="center">k3s-wake-on-demand-homelab</h1>

<p align="center">
  <b>An energy-efficient home cluster.</b><br>
  A Raspberry Pi 5 runs Kubernetes (K3s) 24/7 and wakes the power-hungry machines<br>
  (a CPU node and a GPU node that also serves as NAS) <b>only when there is work for them</b>.
</p>

<p align="center">
  <a href="docs/guide/README.md"><b>Installation guide</b></a> &nbsp;·&nbsp;
  <a href="docs/decisions.md"><b>Design decisions</b></a> &nbsp;·&nbsp;
  <a href="docs/lessons-learned.md"><b>Lessons learned</b></a> &nbsp;·&nbsp;
  <a href="#architecture"><b>Architecture</b></a>
</p>

<div align="center">

| Layer | Stack |
|:--|:--|
| **Platform** | [![K3s](https://img.shields.io/badge/K3s-Kubernetes-FFC61C?logo=k3s&logoColor=black)](https://k3s.io) [![Raspberry Pi 5](https://img.shields.io/badge/Raspberry%20Pi%205-control%20plane-A22846?logo=raspberrypi&logoColor=white)](https://www.raspberrypi.com) [![Ubuntu](https://img.shields.io/badge/Ubuntu-nodes-E95420?logo=ubuntu&logoColor=white)](https://ubuntu.com) [![Podman](https://img.shields.io/badge/Podman-image%20builds-892CA0?logo=podman&logoColor=white)](https://podman.io) [![NVIDIA](https://img.shields.io/badge/NVIDIA-CUDA-76B900?logo=nvidia&logoColor=white)](https://developer.nvidia.com/cuda-toolkit) |
| **Network & security** | [![WireGuard](https://img.shields.io/badge/WireGuard-VPN-88171A?logo=wireguard&logoColor=white)](https://www.wireguard.com) [![nftables](https://img.shields.io/badge/nftables-firewall-5A3E85?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xMiAzbDcgM3Y1YzAgNC41LTMgOC4yLTcgMTAtNC0xLjgtNy01LjUtNy0xMFY2eiIvPjxwYXRoIGQ9Ik05IDEybDIgMiA0LTQiLz48L3N2Zz4%3D)](https://wiki.nftables.org) [![CrowdSec](https://img.shields.io/badge/CrowdSec-IPS-1F2041?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjguNSIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjQuNSIvPjxwYXRoIGQ9Ik0xMiAxMmw1LTUiLz48Y2lyY2xlIGN4PSIxNi41IiBjeT0iMTUuNSIgcj0iMSIgZmlsbD0id2hpdGUiLz48L3N2Zz4%3D)](https://www.crowdsec.net) [![Traefik](https://img.shields.io/badge/Traefik-ingress-24A1C1?logo=traefikproxy&logoColor=white)](https://traefik.io/traefik/) [![Let's Encrypt](https://img.shields.io/badge/Let%27s%20Encrypt-TLS-003A70?logo=letsencrypt&logoColor=white)](https://letsencrypt.org) [![DuckDNS](https://img.shields.io/badge/DuckDNS-DNS-2E7D32?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik03IDE4aDEwLjVhNC41IDQuNSAwIDAgMCAuNS05IDYuNSA2LjUgMCAwIDAtMTIuNCAyQTMuNSAzLjUgMCAwIDAgNyAxOHoiLz48L3N2Zz4%3D)](https://www.duckdns.org) [![Authelia](https://img.shields.io/badge/Authelia-SSO%20%2B%20passkeys-113155?logo=authelia&logoColor=white)](https://www.authelia.com) |
| **Services** | [![FastAPI](https://img.shields.io/badge/FastAPI-dashboard-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com) [![Beszel](https://img.shields.io/badge/Beszel-metrics-3B4A5A?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik00IDIwVjEwTTEwIDIwVjRNMTYgMjB2LTdNMjIgMjBIMiIvPjwvc3ZnPg%3D%3D)](https://beszel.dev) [![restic](https://img.shields.io/badge/restic-backups-5B4636?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHg9IjMiIHk9IjQiIHdpZHRoPSIxOCIgaGVpZ2h0PSI1IiByeD0iMSIvPjxwYXRoIGQ9Ik01IDl2MTBhMSAxIDAgMCAwIDEgMWgxMmExIDEgMCAwIDAgMS0xVjkiLz48cGF0aCBkPSJNMTAgMTNoNCIvPjwvc3ZnPg%3D%3D)](https://restic.net) [![Immich](https://img.shields.io/badge/Immich-photos-4250AF?logo=immich&logoColor=white)](https://immich.app) [![FileBrowser](https://img.shields.io/badge/FileBrowser_Quantum-files-40668C?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0zIDcuNUEyLjUgMi41IDAgMCAxIDUuNSA1SDlsMiAyLjJoNy41QTIuNSAyLjUgMCAwIDEgMjEgOS43djcuOEEyLjUgMi41IDAgMCAxIDE4LjUgMjBoLTEzQTIuNSAyLjUgMCAwIDEgMyAxNy41eiIvPjwvc3ZnPg%3D%3D)](https://filebrowserquantum.com) [![Blender](https://img.shields.io/badge/Blender-rendering-E87D0D?logo=blender&logoColor=white)](https://www.blender.org) |

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

| **~35 s** | **1 port** | **every 3 days** | **1 push** |
|:--:|:--:|:--:|:--:|
| to wake a sleeping node | open to the internet | encrypted backups | to deploy an app |

</div>

<p align="center">
  <img src="docs/img/capturas/panel-pc.jpg" width="760"
       alt="The dashboard: every machine and app in the top bar, and the history charts of the Raspberry Pi">
</p>

---

## Contents

<table>
<tr>
<td valign="top" width="50%">

**The project**
- [About](#about)
- [Architecture](#architecture) · [technology by layer](#technology-by-layer)
- [How wake-on-demand works](#how-wake-on-demand-works)
- [Features](#features) · [the dashboard at a glance](#the-dashboard-at-a-glance) · [themes](#themes)
- [What runs on it](#what-runs-on-it)
- [Hardware](#hardware)

</td>
<td valign="top" width="50%">

**Using it**
- [Installation guide](#installation-guide)
- [Design decisions & lessons learned](#design-decisions--lessons-learned)
- [Quick start](#quick-start)
- [Repository layout](#repository-layout)
- [Roadmap](#roadmap)
- [License](#license)

</td>
</tr>
</table>

---

## About

I had two old desktop PCs gathering dust at home and a growing list of things I wanted a server for:
a private place for my photos and files, somewhere to run my own apps, and the occasional heavy job
such as a 3D render. I also wanted a real playground to learn the things that are hard to learn from
a book: **HPC scheduling, networking, Linux administration and security**, on hardware I could break
and fix myself.

Leaving two desktops on all day was not an option: they waste energy and wear out their disks for
work that only happens now and then. So the idea became a cluster that is **asleep most of the time**:
a Raspberry Pi 5 stays on as the brain, and the PCs are switched on only when there is work for them.

- A **job** submitted to K3s that needs a node wakes it up with Wake-on-LAN, runs, and the node powers
  off again once it has been idle for a while.
- **Opening a service** that lives on a sleeping node (the photo library, the file browser) wakes it
  automatically; a "waking up…" page redirects you about 35 seconds later.
- Everything else (VPN, single sign-on, dashboard, monitoring, backups, my own apps) runs on the Pi,
  which never sleeps.

It started as a classic HPC setup with **Slurm** and evolved into **Kubernetes (K3s)** once it also had
to run long-lived services; the reasons for that and every other choice are in the
[design decisions](docs/decisions.md).

---

## Architecture

![Architecture: a Raspberry Pi 5 running the control plane and services, and two sleeping nodes woken by Wake-on-LAN](docs/img/architecture.svg)

### Technology by layer

<details open>
<summary><b>What each piece does</b> (click to fold)</summary>
<br>

<table>
<thead><tr><th align="left">Layer</th><th align="left">Technology</th><th align="left">Role</th></tr></thead>
<tbody>
<tr><td rowspan="3" valign="top"><b>Network&nbsp;edge</b></td><td valign="top"><b>WireGuard</b></td><td>The only port open to the internet; everything else is reachable from the VPN or the home LAN only</td></tr>
<tr><td valign="top"><b>nftables</b></td><td>Default-deny firewall on every machine; K3s services only reachable through Traefik</td></tr>
<tr><td valign="top"><b>CrowdSec</b></td><td>Reads the SSH, Traefik and firewall logs, detects attacks and bans the source IPs</td></tr>
<tr><td rowspan="2" valign="top"><b>Ingress</b></td><td valign="top"><b>Traefik</b></td><td>Reverse proxy and HTTPS for every service (bundled with K3s)</td></tr>
<tr><td valign="top"><b>Let's&nbsp;Encrypt&nbsp;+&nbsp;DuckDNS</b></td><td>Free wildcard certificate via DNS-01: valid HTTPS without buying a domain or opening ports</td></tr>
<tr><td rowspan="1" valign="top"><b>Identity</b></td><td valign="top"><b>Authelia</b></td><td>One login for everything, with passkeys (WebAuthn) and two-factor for sensitive apps</td></tr>
<tr><td rowspan="1" valign="top"><b>Orchestration</b></td><td valign="top"><b>K3s</b></td><td>Lightweight Kubernetes: server on the Pi, agents on the nodes, tainted so only on-demand work lands there</td></tr>
<tr><td rowspan="2" valign="top"><b>Power</b></td><td valign="top"><b>nodo-controlador</b></td><td><i>Own.</i> Wakes a node when a pending job needs it, powers it off after an idle period</td></tr>
<tr><td valign="top"><b>despertador</b></td><td><i>Own.</i> The dashboard, plus a wake-on-access proxy for services on sleeping nodes</td></tr>
<tr><td rowspan="1" valign="top"><b>Apps</b></td><td valign="top"><b>Podman&nbsp;+&nbsp;git&nbsp;hook</b></td><td><i>Own.</i> <code>git push pi main</code> builds the image on the Pi and rolls it out to K3s</td></tr>
<tr><td rowspan="2" valign="top"><b>Monitoring</b></td><td valign="top"><b>Beszel</b></td><td>Metrics history of every machine</td></tr>
<tr><td valign="top"><b>smartmontools</b></td><td>Disk health checks, surfaced as alerts in the dashboard</td></tr>
<tr><td rowspan="1" valign="top"><b>Backups</b></td><td valign="top"><b>restic</b></td><td>Encrypted, deduplicated backups to a disk in the CPU node, woken for the occasion</td></tr>
</tbody>
</table>

</details>

> **Why these pieces and not others?** Every choice, and the alternatives that were rejected, is in
> [**Design decisions**](docs/decisions.md).

---

## How wake-on-demand works

![Sequence: you open a service on a sleeping node, the Pi wakes it with Wake-on-LAN, redirects you when it is ready, and powers it off after an idle period](docs/img/wake-on-demand.svg)

The same controller handles batch work: a K3s **Job** with the right `nodeSelector` and toleration
wakes the matching node (CPU or GPU), and the node sleeps again once the job is done.
→ Details in [guide · chapter 4](docs/guide/04-power.md) and [chapter 8](docs/guide/08-dashboard.md).

---

## Features

<table>
<tr>
<td valign="top" width="50%">

### Power management
- Nodes fully powered off (S5) and woken by Wake-on-LAN, not just suspended.
- Idle detection that is hard to fool: pending jobs, recent service traffic, open SSH sessions and a manual "hold" label all keep a node awake.
- Handles a real motherboard quirk: a node that switches itself back on after its first shutdown is watched and powered off again.

</td>
<td valign="top" width="50%">

### Security
- Nothing exposed to the internet except WireGuard; the services domain resolves to a **private** IP.
- Default-deny nftables on all machines, with separate rules for the K3s forward path.
- Single sign-on with passkeys; two-factor for apps with financial data.
- CrowdSec in protecting mode; your own devices and the VPN can never be banned.

</td>
</tr>
<tr>
<td valign="top" width="50%">

### Dashboard
*FastAPI backend + vanilla JS, no framework*
- A bar always on screen: every machine with its state, a hold lock and the power button, and every app with its health.
- Collapsible sections (nodes, apps, alerts, network, security, disks), each with a one-line status: the whole cluster fits on a phone screen.
- History charts per machine and a calendar of hours on per day; network traffic, VPN devices, a CrowdSec world map with a permanent forensic history.
- Installable on the phone (PWA), fully themeable.

</td>
<td valign="top" width="50%">

### Operations
- `git push pi main` deploys an app: build on the Pi (arm64), import into K3s, apply, wait for the rollout, **roll back automatically** if it fails.
- Encrypted backups every three days, with consistent SQLite dumps, retention and integrity checks.
- The whole configuration is plain files in this repository; private values stay in an ignored `config/local.env`, guarded by a pre-commit hook.

</td>
</tr>
</table>

### The dashboard at a glance

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/img/capturas/panel-apps-avisos.jpg" alt="Apps and alerts sections of the dashboard"><br>
<sub><b>Apps and alerts.</b> The health of every app, and the deployments made with <code>git push</code>.</sub>
</td>
<td width="50%" valign="top">
<img src="docs/img/capturas/panel-calendario.jpg" alt="Calendar with the hours each machine was on per day"><br>
<sub><b>Calendar.</b> Hours on per day and machine: the Pi never stops, the nodes only wake for work.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/img/capturas/panel-red.jpg" alt="Network section: traffic, connection quality, VPN devices and blocked traffic"><br>
<sub><b>Network.</b> Traffic, connection quality, VPN devices and what the firewall blocks.</sub>
</td>
<td width="50%" valign="top">
<img src="docs/img/capturas/panel-seguridad.jpg" alt="Security section: CrowdSec detections, world map and forensic history"><br>
<sub><b>Security.</b> CrowdSec detections, where attacks come from, and a forensic history that is never purged.</sub>
</td>
</tr>
</table>

<p align="center">
  <img src="docs/img/capturas/panel-mobil.jpg" width="250" alt="The dashboard on a phone, all sections folded">
  &nbsp;&nbsp;
  <img src="docs/img/capturas/panel-graficas-mobil.jpg" width="250" alt="History charts on a phone, stacked with one time axis"><br>
  <sub><b>On the phone.</b> Installable as an app; the same page rearranges itself to fit.</sub>
</p>

### Themes

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/img/capturas/tema-arena-claro.jpg" alt="Dashboard with the Arena theme in light mode"><br>
<sub><b>Arena</b> · light</sub>
</td>
<td width="50%" valign="top">
<img src="docs/img/capturas/tema-lima-oscuro.jpg" alt="Dashboard with the Lima palette in dark mode"><br>
<sub><b>Lima</b> · dark, with the drifting background of the palettes</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/img/capturas/tema-rojo-claro.jpg" alt="Security section with the Rojo palette in light mode"><br>
<sub><b>Rojo</b> · light</sub>
</td>
<td width="50%" valign="top">
<img src="docs/img/capturas/tema-sobrio-oscuro.jpg" alt="Dashboard with the Sobrio palette in dark mode, serif font"><br>
<sub><b>Sobrio</b> · dark, with a serif font</sub>
</td>
</tr>
</table>

<p align="center">
  <img src="docs/img/capturas/temas.jpg" width="250" alt="Appearance menu: built-in themes, palettes and light or dark mode">
  &nbsp;&nbsp;
  <img src="docs/img/capturas/temas-personalizacion.jpg" width="250" alt="Customisation: font, accent colour, cards, background, corners and saved themes"><br>
  <sub>Every theme has a light and a dark version, and everything can be tuned and saved as your own theme:
  font, accent, card opacity and blur, background (colour, gradient or image), corners and width.</sub>
</p>

---

## What runs on it

<table>
<thead><tr><th align="left">Service</th><th align="left">Node</th><th align="left">What for</th></tr></thead>
<tbody>
<tr><td valign="top"><b>Dashboard</b></td><td valign="top">Pi</td><td>Cluster status, power control, network and security views</td></tr>
<tr><td valign="top"><b>Authelia</b></td><td valign="top">Pi</td><td>Login portal for every service</td></tr>
<tr><td valign="top"><b>Beszel</b></td><td valign="top">Pi&nbsp;+&nbsp;agents</td><td>Metrics history</td></tr>
<tr><td valign="top"><b>Immich</b></td><td valign="top">GPU&nbsp;node</td><td>Photo library and phone backup; wakes the node when the app connects</td></tr>
<tr><td valign="top"><b>FileBrowser&nbsp;Quantum</b></td><td valign="top">GPU&nbsp;node</td><td>Files over HTTPS with single sign-on</td></tr>
<tr><td valign="top"><b><a href="https://github.com/Ipasky/ticket-scanner">ticket&#8209;scanner</a></b></td><td valign="top">Pi</td><td>My own app: scan receipts with AI, match them to bank transactions, see where the money goes</td></tr>
<tr><td valign="top"><i>your app here</i></td><td valign="top">Pi</td><td>Anything with a <code>Dockerfile</code> and its manifests, deployed with <code>git push</code></td></tr>
</tbody>
</table>

---

## Hardware

<table>
<thead><tr><th align="left">Machine</th><th align="left">Hardware</th><th align="left">Role</th><th align="center">Power</th></tr></thead>
<tbody>
<tr><td valign="top"><b>pi&#8209;master</b></td><td valign="top">Raspberry Pi 5, 8 GB, SSD over USB</td><td valign="top">Control plane and every always-on service</td><td valign="top" align="center">Always&nbsp;on</td></tr>
<tr><td valign="top"><b>faraday</b></td><td valign="top">Intel i5-4690, 16 GB</td><td valign="top">CPU node · backup disk</td><td valign="top" align="center">On&nbsp;demand</td></tr>
<tr><td valign="top"><b>mustang</b></td><td valign="top">Intel i7-7700K, 16 GB, NVIDIA GTX&nbsp;1050&nbsp;Ti</td><td valign="top">GPU node (CUDA) · NAS (3 TB)</td><td valign="top" align="center">On&nbsp;demand</td></tr>
</tbody>
</table>

A Blender Cycles test render (1080p, 128 samples) takes **83 s on the GPU node** and **328 s on the CPU
node**. Both are woken, used and put back to sleep automatically.

---

## Documentation

### Installation guide

A step-by-step guide to build the same cluster on your own hardware: **[start here](docs/guide/README.md)**.

<table>
<tr>
<td valign="top" width="50%">

**I · Foundations**

0. [Plan & prerequisites](docs/guide/00-plan.md)
1. [Prepare the machines](docs/guide/01-machines.md)
2. [Firewall](docs/guide/02-firewall.md)
3. [K3s](docs/guide/03-k3s.md)

</td>
<td valign="top" width="50%">

**II · Power & access**

4. [Wake-on-LAN & controller](docs/guide/04-power.md)
5. [Domain & HTTPS](docs/guide/05-https.md)
6. [VPN](docs/guide/06-vpn.md)
7. [Single sign-on](docs/guide/07-sso.md)

</td>
</tr>
<tr>
<td valign="top" width="50%">

**III · Services**

8. [The dashboard](docs/guide/08-dashboard.md)
9. [Monitoring](docs/guide/09-monitoring.md)
10. [NAS](docs/guide/10-nas.md)
11. [CrowdSec](docs/guide/11-crowdsec.md)

</td>
<td valign="top" width="50%">

**IV · Operations**

12. [Backups](docs/guide/12-backups.md)
13. [Deploying your apps](docs/guide/13-apps.md)

</td>
</tr>
</table>

### Design decisions & lessons learned

<table>
<thead><tr><th align="left">Document</th><th align="left">What you will find</th></tr></thead>
<tbody>
<tr><td valign="top"><a href="docs/decisions.md"><b>Design&nbsp;decisions</b></a></td><td>14 decisions: context, choice, rejected alternatives and consequences (K3s vs. Slurm, full power-off vs. suspend, Authelia vs. Authentik…)</td></tr>
<tr><td valign="top"><a href="docs/lessons-learned.md"><b>Lessons&nbsp;learned</b></a></td><td>About 45 real problems as <i>symptom → cause → fix</i>: hardware, firewall, K3s, security, storage, deployment</td></tr>
</tbody>
</table>

---

## Quick start

Every value that belongs to a specific installation (domain, IP and MAC addresses, user names) is
written in the files as an `@@MARKER@@`. Your values live in `config/local.env`, which git ignores:

```powershell
copy config\local.env.example config\local.env   # then edit it
git config core.hooksPath .githooks              # block commits that contain your private values
.\deploy\desplegar.ps1 -Probar                   # dry run: what would be sent where
.\deploy\desplegar.ps1                           # fill in the markers and install on every machine
.\deploy\desplegar.ps1 -Generar                  # render k8s/ and the firewall files to apply by hand
```

New here? Follow the [installation guide](docs/guide/README.md) from chapter 0.

---

## Repository layout

```
├── panel/            The dashboard: despertador.py (FastAPI) + static/ (UI)
├── scripts/          nodo · nodo-controlador · hpc-respaldo · desplegar-app · …
├── systemd/          Services and timers for those scripts
├── k8s/              K3s manifests: Traefik, Authelia, Immich, FileBrowser, dashboard route…
├── config/           nftables per machine · CrowdSec · *.example configuration files
├── docs/             Installation guide · design decisions · lessons learned · diagrams
├── tools/            Development helpers
├── .githooks/        Pre-commit guard against publishing private values
└── deploy/           desplegar.ps1 (from the admin PC: render, copy and install on each machine)
                      instalar.sh (runs on each machine: puts every file in place, reloads systemd)
```

> The code comments and the dashboard UI are in Spanish; the documentation is in English.

---

## Roadmap

- [x] Wake-on-demand nodes, power controller and wake-on-access
- [x] VPN, single sign-on, CrowdSec, encrypted backups, `git push` deploys
- [x] [Design decisions](docs/decisions.md), [lessons learned](docs/lessons-learned.md) and the [installation guide](docs/guide/README.md)
- [x] Dashboard screenshots
- [ ] Off-site copy of the backups (restic → cloud storage)
- [ ] Backups of the photo library
- [ ] Distributed Blender rendering across both nodes
- [ ] Small AI models on the GPU node
- [ ] Power consumption metering

---

## License

[MIT](LICENSE) © Isaac Pascual · Fonts: see [`panel/LICENCIAS-FUENTES.md`](panel/LICENCIAS-FUENTES.md)

<p align="right"><sub><a href="#top">↑ Back to top</a></sub></p>
