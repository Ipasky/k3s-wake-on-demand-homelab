# 0 · Plan and prerequisites

[← Guide index](README.md) · Next: [1 · Prepare the machines →](01-machines.md)

Before installing anything, decide **which machine does what** and **which address each one gets**.
Almost every later step refers back to this plan.

## Hardware

| Role | What it needs | Used here |
|---|---|---|
| **Control plane** (always on) | 64-bit ARM or x86, **8 GB RAM** recommended, an **SSD** (not a microSD card: K3s writes constantly) | Raspberry Pi 5, 8 GB, SSD over a SATA-USB adapter |
| **CPU node** (on demand) | Any desktop with **Wake-on-LAN** in the BIOS and a wired network card | Intel i5-4690, 16 GB |
| **GPU node** (on demand) | Same, plus an **NVIDIA** card if you want CUDA (Blender Cycles, PyTorch) | Intel i7-7700K, 16 GB, GTX 1050 Ti |
| Network | A router where you can set **DHCP reservations** and **forward one UDP port** | |

Notes:
- The nodes must be on a **cable**: Wake-on-LAN over Wi-Fi is unreliable or unsupported.
- Check that a GPU can actually compute before counting on it: older AMD cards are supported neither
  by Blender Cycles nor by PyTorch (see [lessons learned](../lessons-learned.md#hardware--power)).
- One node can be the NAS: give it a separate data disk (HDD) for photos and files.
- One node can hold the backups: give it another separate disk.

## Address plan

Give every machine and every device the firewall must trust a **fixed address** via a DHCP
reservation on the router (chapter 1). Write them down now:

| Device | Example | Why it needs a fixed address |
|---|---|---|
| Router | `192.168.1.1` | Gateway, DNS |
| Raspberry Pi | `192.168.1.20` | Everything points to it |
| CPU node | `192.168.1.21` | The Pi wakes it and talks to it |
| GPU node | `192.168.1.22` | Same |
| Admin PC | `192.168.1.100` | The only machine allowed to SSH and run `kubectl` from the LAN |
| Your phone on the home Wi-Fi | `192.168.1.101` | Optional: lets it reach the services at home without the VPN |
| VPN subnet | `10.10.10.0/24` | Addresses inside the WireGuard tunnel (the Pi is `.1`) |

## Accounts and names

- A **DuckDNS** account (free, sign in with GitHub/Google). You will create **two subdomains** in
  chapters 5 and 6: one that follows your **public** IP (the VPN endpoint) and one that points to the
  Pi's **private** IP (the services).
- One Linux user per machine. Here the user is named like the machine (`raspberrypi`, `faraday`,
  `mustang`), which makes SSH commands readable.

## Clone the repository and fill in your values

On the admin PC:

```powershell
git clone https://github.com/Ipasky/k3s-wake-on-demand-homelab.git
cd k3s-wake-on-demand-homelab
copy config\local.env.example config\local.env
notepad config\local.env          # write your addresses, domain, users and city
git config core.hooksPath .githooks
```

`config/local.env` is ignored by git. Every `@@MARKER@@` in the repository is filled in from it when
you deploy (`.\deploy\desplegar.ps1`) or render the manifests (`.\deploy\desplegar.ps1 -Generar`), and the
pre-commit hook stops you from ever committing one of those values.

## What you will have at the end

- The Pi answering at `https://panel.<your-domain>` with single sign-on, from home and through the VPN.
- Nodes powered off most of the time, woken automatically by jobs or by opening a service on them.
- Only one port open on the router.
- Encrypted backups every few days, and your own apps deployed with `git push`.

[← Guide index](README.md) · Next: [1 · Prepare the machines →](01-machines.md)
