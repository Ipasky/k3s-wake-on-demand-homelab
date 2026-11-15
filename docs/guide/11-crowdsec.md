# 11 · CrowdSec

[← 10 · NAS](10-nas.md) · [Guide index](README.md) · Next: [12 · Backups →](12-backups.md)

**CrowdSec** reads the logs of SSH, Traefik, Authelia and the firewall, recognises attacks (port
scans, brute force, web exploits, path probing) and bans the source IP in nftables. With only
WireGuard open to the internet, most of what it sees comes from **inside** the home network, which is
exactly the case worth catching: a compromised device next to your cluster.

It runs **on the Pi as a system package**, not in K3s: lighter, and with direct access to the host
logs and to nftables.

## 11.1 Install

```bash
curl -s https://install.crowdsec.net | sudo sh && sudo apt install -y crowdsec
sudo cscli collections install crowdsecurity/linux crowdsecurity/sshd crowdsecurity/traefik \
  crowdsecurity/base-http-scenarios crowdsecurity/http-cve crowdsecurity/iptables LePresidente/authelia
sudo cscli parsers install crowdsecurity/cri-logs
```

**Remove the default whitelist.** `crowdsecurity/whitelists` ignores every private IP. Sensible on a
datacenter server, wrong at home, where a compromised device on the LAN is a threat you want to see:
```bash
sudo cscli parsers remove crowdsecurity/whitelists --force
```
Whitelist only your own machines and the VPN instead, and tell CrowdSec where the container logs are
(the files in [`config/crowdsec/`](../../config/crowdsec), rendered with your addresses):
```powershell
.\deploy\desplegar.ps1 -Generar
scp privado\generado\config\crowdsec\*.yaml pi:/tmp/
```
```bash
sudo cp /tmp/acquis-hpc.yaml     /etc/crowdsec/acquis.d/hpc.yaml
sudo cp /tmp/whitelist-hpc.yaml  /etc/crowdsec/parsers/s02-enrich/whitelist-hpc.yaml
sudo systemctl restart crowdsec
sudo cscli metrics show acquisition          # every source with lines read and parsed
```
Traefik must log in JSON with the client's real IP: that is
[`k8s/traefik-config.yaml`](../../k8s/traefik-config.yaml) from [chapter 5](05-https.md#54-traefik-settings).
The firewall log comes from the rate-limited `log` rule of [chapter 2](02-firewall.md).

## 11.2 The bouncer: from detecting to blocking

```bash
sudo apt install -y crowdsec-firewall-bouncer-nftables
sudo grep -A3 nftables_hooks /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml   # input and forward
sudo cscli bouncers list
sudo nft list tables | grep crowdsec
```
Both hooks matter: `input` protects the Pi's own services, `forward` the ones published by K3s.

**The community blocklist is disabled on purpose.** A phone on mobile data often sits behind
carrier-grade NAT, sharing its public IP with many strangers; if one of them is on the list, *you* are
banned from your own VPN. Comment out `online_client` in `/etc/crowdsec/config.yaml`, restart, and
clear any imported decisions:
```bash
sudo cscli capi status                         # "no configuration for Central API"
sudo cscli decisions delete --origin CAPI
```

## 11.3 Test it

From a device at home **without** the VPN, run a port scan against the Pi. Within seconds:
```bash
sudo cscli alerts list
sudo cscli decisions list                      # the device is banned
sudo cscli decisions delete --ip 192.168.1.50  # unban
```
If a ban comes back right after removing it, the scan is still running.

To understand why a line did or did not match, test that single line (much faster than a whole file):
```bash
linea=$(grep -m1 nft-input-drop /var/log/kern.log)
sudo cscli explain --log "$linea" --type syslog
```

## 11.4 From the dashboard

The dashboard's Security view shows alerts, bans, a world map of origins and a **permanent forensic
history**; it can ban an IP (1 hour to 30 days, or permanently, with a reason) and unban it. It goes
through [`scripts/hpc-crowdsec`](../../scripts/hpc-crowdsec), a small root helper that accepts only a
few orders and **refuses to ban the cluster's own addresses**:
```bash
echo "raspberrypi ALL=(root) NOPASSWD: /usr/local/sbin/hpc-crowdsec" | sudo tee /etc/sudoers.d/30-hpc-crowdsec
sudo chmod 440 /etc/sudoers.d/30-hpc-crowdsec && sudo visudo -c
```

[← 10 · NAS](10-nas.md) · [Guide index](README.md) · Next: [12 · Backups →](12-backups.md)
