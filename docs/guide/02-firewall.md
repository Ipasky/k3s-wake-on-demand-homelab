# 2 · Firewall

[← 1 · Prepare the machines](01-machines.md) · [Guide index](README.md) · Next: [3 · K3s →](03-k3s.md)

Every machine runs a **default-deny nftables** firewall. The rule set is the same idea on all of
them: accept what the cluster needs, accept the admin PC, drop everything else. And the cluster may
**not open connections to the rest of the home network**, so a compromised container cannot reach
your other devices.

The files are in [`config/nftables/`](../../config/nftables): `pi-master.conf` for the Pi,
`faraday.conf` and `mustang.conf` for the nodes. Render them with your addresses:

```powershell
.\deploy\desplegar.ps1 -Generar          # → privado\generado\config\nftables\*.conf
```

## 2.1 What the rules do

**On the Pi** (`pi-master.conf`):

| Chain | Accepts | Why |
|---|---|---|
| `input` | `udp/51820` from anywhere | WireGuard, the only door from the internet (chapter 6) |
| | Web (80/443) from the VPN, the admin PC and the phone | The services, all behind Traefik with TLS |
| | SSH from the VPN and the admin PC; `6443` (kubectl) from the admin PC | Administration |
| | K3s traffic from the nodes and the pod/service networks | The cluster itself |
| | **broadcast/multicast: dropped without logging** | Home-network noise (mDNS, NetBIOS…) |
| | the rest: **logged (rate-limited) and dropped** | CrowdSec reads this log (chapter 11) |
| `forward` | to the pods, only ports 80/443 from VPN / admin PC / phone | K3s services are *forwarded*, so they must be filtered here too |
| `output` | router, nodes, admin PC; replies to accepted traffic | The Pi can answer anyone it accepted… |
| | **anything else in the home LAN: dropped** | …but cannot start a conversation with your other devices |

**On the nodes** (`faraday.conf`, `mustang.conf`): SSH from the admin PC, everything from the other
cluster machines and the pod networks, the metrics agent from the Pi; outgoing traffic to the home
LAN is dropped the same way. The two files differ only in which machine is "the other node".

Two rules that matter more than they look:
- The files start with `table inet filter` + `delete table inet filter`, **never `flush ruleset`**.
  A full flush also deletes the rules K3s creates, and some are never recreated.
- K3s services are reached through the **forward** chain, matching the original port with
  `ct original proto-dst`. Closing a port only in `input` does not close a K3s service.

## 2.2 Apply it safely

A mistake in a firewall on a headless machine locks you out. Always apply with a **rescue timer**
that undoes the change after five minutes unless you cancel it. The rescue reloads the previous
file, which only replaces our own table; it never flushes the rules K3s created:

```powershell
scp privado\generado\config\nftables\pi-master.conf pi:/tmp/nftables.conf
```
```bash
sudo diff /etc/nftables.conf /tmp/nftables.conf          # read what changes
sudo nft -c -f /tmp/nftables.conf && echo "syntax OK"
sudo cp /etc/nftables.conf /etc/nftables.conf.bak
sudo cp /tmp/nftables.conf /etc/nftables.conf && sudo chmod 600 /etc/nftables.conf

sudo systemd-run --on-active=300 /usr/sbin/nft -f /etc/nftables.conf.bak   # rescue: note the run-rXXXX.timer name
sudo nft -f /etc/nftables.conf
```
Now check, **from a new SSH session**, that you can still get in (and, once K3s exists, that
`kubectl get nodes` works). If everything is fine, cancel the rescue and make it permanent:
```bash
sudo systemctl stop run-rXXXX.timer
sudo systemctl enable nftables
```
If you got locked out, wait five minutes: the timer reloads the previous rules and you can log in again.
(The very first time there is no previous file: then the rescue can be `nft delete table inet filter`,
which removes only our table.)

Repeat for each node with its own file.

> When you change the firewall later, **start from the live file on the machine** (or from this
> repository kept in sync with it), never from an old copy, and always `diff` before applying.

## 2.3 Check

```bash
sudo nft list ruleset | head -40                         # our table is loaded
journalctl -k -g "nft-input-drop" -n 20 --no-pager       # what is being dropped
```
From the admin PC, `ssh pi` works; from any other device at home, the Pi does not answer on SSH.

[← 1 · Prepare the machines](01-machines.md) · [Guide index](README.md) · Next: [3 · K3s →](03-k3s.md)
