# 6 · VPN

[← 5 · Domain and HTTPS](05-https.md) · [Guide index](README.md) · Next: [7 · Single sign-on →](07-sso.md)

**WireGuard** on the Pi is the only door from the internet: one UDP port forwarded by the router.
WireGuard does not answer packets that are not signed with a known key, so to a scanner the port
looks closed.

## 6.1 A name that follows your public IP

Home connections usually have a **dynamic** public IP. Create a **second** DuckDNS subdomain (e.g.
`my-home-vpn`) and let the Pi keep it up to date every five minutes:

```bash
sudo tee /etc/default/duckdns > /dev/null <<'EOF'
DOMINIO=my-home-vpn
TOKEN=your-token
EOF
sudo chmod 600 /etc/default/duckdns

sudo tee /etc/systemd/system/duckdns.service > /dev/null <<'EOF'
[Unit]
Description=Update the public IP in DuckDNS
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
DynamicUser=yes
EnvironmentFile=/etc/default/duckdns
ExecStart=/usr/bin/curl -fsS "https://www.duckdns.org/update?domains=${DOMINIO}&token=${TOKEN}&ip="
EOF
sudo tee /etc/systemd/system/duckdns.timer > /dev/null <<'EOF'
[Unit]
Description=Update DuckDNS every 5 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now duckdns.timer
journalctl -u duckdns -n 3 --no-pager           # OK (KO = wrong domain or token)
```

> Keep this name **private**: it is the one that leads to your home. The services domain of
> [chapter 5](05-https.md) only points to a private address and reveals nothing.

## 6.2 The server

```bash
sudo apt install -y wireguard qrencode
cd /etc/wireguard && sudo sh -c 'umask 077; wg genkey | tee server.key | wg pubkey > server.pub'

sudo tee /etc/wireguard/wg0.conf > /dev/null <<EOF
[Interface]
Address = 10.10.10.1/24
ListenPort = 51820
PrivateKey = $(sudo cat /etc/wireguard/server.key)
EOF
sudo chmod 600 /etc/wireguard/wg0.conf
sudo systemctl enable --now wg-quick@wg0
```
On the router, forward **UDP 51820 → 192.168.1.20**. Nothing else.

The Pi does not route VPN clients into the home network: the firewall of [chapter 2](02-firewall.md)
accepts what arrives on `wg0` for the Pi itself (web, the photo app port, SSH) and nothing more.

## 6.3 Add a device

```bash
CLIENT=phone ; CLIENT_IP=10.10.10.2               # next ones: .3, .4…
cd /etc/wireguard
sudo sh -c "umask 077; wg genkey | tee $CLIENT.key | wg pubkey > $CLIENT.pub"

sudo tee -a wg0.conf > /dev/null <<EOF

[Peer]
# $CLIENT
PublicKey = $(sudo cat $CLIENT.pub)
AllowedIPs = $CLIENT_IP/32
EOF
sudo systemctl restart wg-quick@wg0

cat > /tmp/$CLIENT.conf <<EOF
[Interface]
Address = $CLIENT_IP/32
PrivateKey = $(sudo cat $CLIENT.key)

[Peer]
PublicKey = $(sudo cat server.pub)
Endpoint = my-home-vpn.duckdns.org:51820
AllowedIPs = 10.10.10.0/24, 192.168.1.20/32
PersistentKeepalive = 25
EOF
qrencode -t ansiutf8 < /tmp/$CLIENT.conf          # scan it with the WireGuard app
rm /tmp/$CLIENT.conf
```

`AllowedIPs = 10.10.10.0/24, 192.168.1.20/32` is a **split tunnel** with a trick:
- Only traffic for the VPN subnet and **the Pi's LAN address** goes through the tunnel; everything
  else uses the phone's normal connection.
- Because the Pi's LAN address is routed through the tunnel, **the same address and the same links
  work at home and away**. The services domain resolves to `192.168.1.20` everywhere.
- The `/32` is deliberate: the device reaches the Pi, not the rest of your home network.

To revoke a device, delete its `[Peer]` block, restart `wg-quick@wg0` and delete its keys.

## 6.4 Check

Test **from mobile data**, not from the home Wi-Fi (at home the phone would reach the Pi without the
tunnel anyway):
```bash
sudo wg show            # "latest handshake" a few seconds ago for that device
```
and open `https://<anything>.my-cluster.duckdns.org` on the phone.

> If the public IP changes while the tunnel is up, toggle the tunnel off and on.

[← 5 · Domain and HTTPS](05-https.md) · [Guide index](README.md) · Next: [7 · Single sign-on →](07-sso.md)
