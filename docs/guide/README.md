# Installation guide

A step-by-step guide to build the same cluster: a Raspberry Pi that is always on and nodes that
sleep until there is work for them. It is written for **one Pi + one or more desktop PCs** on a home
network; nothing in it depends on the exact hardware used here.

Follow the chapters in order: each one assumes the previous ones are done.

| # | Chapter | You end up with |
|---|---|---|
| 0 | [Plan and prerequisites](00-plan.md) | Hardware list, address plan, the values for `config/local.env` |
| 1 | [Prepare the machines](01-machines.md) | Ubuntu on every machine, fixed addresses, key-only SSH, Wake-on-LAN enabled in the BIOS |
| 2 | [Firewall](02-firewall.md) | Default-deny nftables on every machine, applied safely |
| 3 | [K3s](03-k3s.md) | A cluster: server on the Pi, agents on the nodes, GPU support |
| 4 | [Power: Wake-on-LAN and the controller](04-power.md) | Nodes that wake for jobs and power off when idle |
| 5 | [Domain and HTTPS](05-https.md) | A free domain and a wildcard certificate, with no port open |
| 6 | [VPN](06-vpn.md) | WireGuard: the only door from the internet |
| 7 | [Single sign-on](07-sso.md) | Authelia with passkeys in front of every service |
| 8 | [The dashboard](08-dashboard.md) | The despertador: dashboard + wake on access |
| 9 | [Monitoring](09-monitoring.md) | Beszel metrics and SMART disk checks |
| 10 | [NAS](10-nas.md) | Immich and FileBrowser on a sleeping node |
| 11 | [CrowdSec](11-crowdsec.md) | Attack detection and automatic bans |
| 12 | [Backups](12-backups.md) | restic to a node that wakes up for it, configuration history in git |
| 13 | [Deploying your apps](13-apps.md) | `git push pi main` |

## Conventions

- Commands are for **Ubuntu Server LTS** on every machine, run as the normal user with `sudo`.
- PowerShell blocks are for the **admin PC** (Windows); any OS with an SSH client works the same way.
- The example values are the ones in [`config/local.env.example`](../../config/local.env.example):

  | Name | Example | Marker in the repository |
  |---|---|---|
  | Domain | `my-cluster.duckdns.org` | `@@DOMINIO@@` |
  | Raspberry Pi (`pi-master`) | `192.168.1.20` | `@@IP_PI@@` |
  | CPU node (`faraday`) | `192.168.1.21` | `@@IP_FARADAY@@` |
  | GPU node (`mustang`) | `192.168.1.22` | `@@IP_MUSTANG@@` |
  | Admin PC | `192.168.1.100` | `@@IP_ADMIN@@` |
  | Phone on the home Wi-Fi | `192.168.1.101` | `@@IP_MOVIL@@` |
  | Router | `192.168.1.1` | `@@IP_ROUTER@@` |
  | Home LAN / VPN subnet | `192.168.1.0/24` / `10.10.10.0/24` | `@@RED_CASA@@` / `@@RED_VPN@@` |

- Node names (`pi-master`, `faraday`, `mustang`) are the ones used in the scripts; rename them if you
  like, but consistently.
