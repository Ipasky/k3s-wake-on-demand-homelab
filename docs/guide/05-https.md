# 5 · Domain and HTTPS

[← 4 · Power](04-power.md) · [Guide index](README.md) · Next: [6 · VPN →](06-vpn.md)

Browsers, passkeys and installable web apps need **valid HTTPS**. This chapter gets a free domain and
a real Let's Encrypt certificate for services that are **only reachable from home and the VPN**,
without buying a domain and without opening any port.

## How it works

- **DuckDNS** gives free subdomains. Its records can point to a **private** address, so
  `my-cluster.duckdns.org` and every name under it resolve to the Pi's LAN IP. Outside your network
  that address leads nowhere; at home and through the VPN it leads to the Pi.
- Let's Encrypt proves you own the domain with a **DNS-01** challenge: a temporary TXT record that
  `acme.sh` creates through the DuckDNS API. No port has to be reachable from the internet.
- The result is a **wildcard** certificate, `*.my-cluster.duckdns.org`, that Traefik serves for every
  service (`panel.`, `auth.`, `metricas.`…).

> DuckDNS allows a single TXT record per domain, so request **only the wildcard**: the base name
> itself is not used.

## 5.1 The domain

1. Sign in at duckdns.org and create a subdomain, e.g. `my-cluster`.
2. Set its IP **by hand** to the Pi's LAN address (`192.168.1.20`); do not run an updater for this
   one.
3. Copy your **token** and keep it secret: it controls all your DuckDNS domains.

Check: `nslookup panel.my-cluster.duckdns.org` returns `192.168.1.20`.

## 5.2 The certificate

On the Pi, as the normal user:
```bash
curl https://get.acme.sh | sh -s email=you@example.com
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt

export DuckDNS_Token='your-token'
~/.acme.sh/acme.sh --issue --dns dns_duckdns -d '*.my-cluster.duckdns.org' --dnssleep 120
```
Install it as a Kubernetes Secret, and tell `acme.sh` to refresh the Secret after every renewal:
```bash
mkdir -p ~/certs
~/.acme.sh/acme.sh --install-cert -d '*.my-cluster.duckdns.org' \
  --key-file       ~/certs/cluster.key \
  --fullchain-file ~/certs/cluster.crt \
  --reloadcmd "kubectl -n kube-system create secret tls cluster-wildcard \
      --cert=$HOME/certs/cluster.crt --key=$HOME/certs/cluster.key \
      --dry-run=client -o yaml | kubectl apply -f -"
```
`acme.sh` installs its own cron job: it renews every 60 days and runs the reload command.

## 5.3 Make it Traefik's default certificate

```bash
kubectl apply -f - <<'YAML'
apiVersion: traefik.io/v1alpha1
kind: TLSStore
metadata:
  name: default
  namespace: kube-system
spec:
  defaultCertificate:
    secretName: cluster-wildcard
YAML
```
Every `IngressRoute` with `tls: {}` now gets the wildcard certificate without further configuration.

## 5.4 Traefik settings

[`k8s/traefik-config.yaml`](../../k8s/traefik-config.yaml) adjusts the Traefik that K3s ships, without
reinstalling it:
- **JSON access log**: what CrowdSec reads to detect web attacks (chapter 11).
- **`externalTrafficPolicy: Local`**: Traefik sees the client's real IP instead of an internal one,
  needed for the access log, CrowdSec bans and Authelia's brute-force protection.

```powershell
.\deploy\desplegar.ps1 -Generar
scp privado\generado\k8s\traefik-config.yaml pi:k8s/
```
```bash
kubectl apply -f ~/k8s/traefik-config.yaml
```

## 5.5 Check

From a device at home (or on the VPN, after the next chapter), open any name under the domain:
Traefik answers `404` until a service exists, but the browser shows a **valid certificate**.

> The certificate and the `acme.sh` account (`~/.acme.sh`) are secrets: they go into the encrypted
> backup (chapter 12), never into git.

[← 4 · Power](04-power.md) · [Guide index](README.md) · Next: [6 · VPN →](06-vpn.md)
