# 7 · Single sign-on

[← 6 · VPN](06-vpn.md) · [Guide index](README.md) · Next: [8 · The dashboard →](08-dashboard.md)

**Authelia** puts one login in front of every service: passkeys (Windows Hello, Face ID, a security
key…) as the main method, a password as fallback, and two-factor for the apps that deserve it.
Apps behind it receive the logged-in user in a header and need no login of their own.

It is one small container (Go + SQLite, ~30–60 MB of RAM), light enough for the Pi.

## 7.1 Secrets and users

```bash
kubectl create namespace auth
kubectl -n auth create secret generic authelia-secretos \
  --from-literal=session="$(openssl rand -base64 48 | tr -d '\n/+=')" \
  --from-literal=storage="$(openssl rand -base64 48 | tr -d '\n/+=')" \
  --from-literal=jwt="$(openssl rand -base64 48 | tr -d '\n/+=')"

# hash of a long fallback password
kubectl run authelia-hash --rm -it --restart=Never --image=ghcr.io/authelia/authelia:4.39 \
  -- authelia crypto hash generate argon2 --password 'a-long-password'
```
Write `/tmp/users.yml` with that hash:
```yaml
users:
  alice:                          # = USUARIO_AUTHELIA in local.env
    displayname: "Alice"
    email: alice@example.com
    password: "$argon2id$v=19$..."
```
```bash
kubectl -n auth create secret generic authelia-usuarios --from-file=users.yml=/tmp/users.yml
shred -u /tmp/users.yml
```

## 7.2 Deploy

[`k8s/authelia.yaml`](../../k8s/authelia.yaml) contains the configuration (a ConfigMap), a small
volume for its SQLite database and the route `https://auth.<your-domain>`.

```powershell
.\deploy\desplegar.ps1 -Generar
scp privado\generado\k8s\authelia.yaml pi:k8s/
```
```bash
kubectl apply -f ~/k8s/authelia.yaml
kubectl -n auth rollout status deploy/authelia
```
The **access policy** in the ConfigMap: deny by default, the portal itself open, `two_factor` for the
apps with financial data, `one_factor` (a passkey counts as one strong factor) for the rest. Adapt
the rules to your own subdomains.

Two details already in the manifest that save hours:
- `enableServiceLinks: false`: otherwise Kubernetes injects `AUTHELIA_*` variables that Authelia
  reads as configuration, and it refuses to start.
- No mail server: one-time codes are written to a file in the container (`/data/avisos.txt`).

## 7.3 First login and passkeys

1. Open `https://auth.<your-domain>` and log in with the user and password.
2. *Settings → Security → WebAuthn credentials → Add*. It asks for a one-time code, which you read
   from the file:
   ```bash
   kubectl -n auth exec deploy/authelia -- tail -25 /data/avisos.txt
   ```
   Use the **short code** of the last block. Every click on *Add* invalidates the previous code, and
   the link containing `revoke` cancels it.
3. Register a second passkey on another device, and an OTP app, as backups.
4. To avoid the code every time, add to the ConfigMap and re-apply:
   ```yaml
   identity_validation:
     elevated_session:
       skip_second_factor: true
   ```

> Passkeys are bound to the domain. Choose the domain before registering them.

## 7.4 Put a service behind the portal

**A service running in K3s**, e.g. [`k8s/middleware-beszel.yaml`](../../k8s/middleware-beszel.yaml):
a `forwardAuth` Middleware **in the service's own namespace** (Traefik does not cross namespaces) and
an `IngressRoute` that uses it:
```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata: { name: authelia, namespace: my-app }
spec:
  forwardAuth:
    address: http://authelia.auth.svc.cluster.local:9091/api/authz/forward-auth
    trustForwardHeader: true
    authResponseHeaders: [Remote-User, Remote-Groups, Remote-Email, Remote-Name]
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata: { name: my-app, namespace: my-app }
spec:
  entryPoints: [websecure]
  routes:
    - match: Host(`my-app.my-cluster.duckdns.org`)
      kind: Rule
      middlewares: [{ name: authelia }]
      services: [{ name: my-app, port: 8080 }]
  tls: {}
```

**A service running on the Pi outside K3s** (the dashboard of the next chapter): a `Service` without
selector plus an `EndpointSlice` pointing to the Pi's address and port, with the same middleware. See
[`k8s/panel.yaml`](../../k8s/panel.yaml).

**Then close the service's direct port** in the firewall, or anyone at home could skip the portal
and forge the `Remote-User` header. A process on the Pi is closed in `input`; a port published by K3s
goes through `forward` ([chapter 2](02-firewall.md#21-what-the-rules-do)).

## 7.5 Check

`https://my-app.<your-domain>` redirects to the portal and back after login; the direct port no longer
answers.

| Symptom | Cause |
|---|---|
| `CrashLoopBackOff`, "server.host/port can't both be configured" | `enableServiceLinks: false` missing |
| "the code challenge has been revoked" | another code was requested, or the `revoke` link was opened |
| "Rate Limit Exceeded" | too many attempts: `kubectl -n auth rollout restart deploy/authelia` |
| The passkey is "not found" after registering | a password manager captured it and it never reached the server |
| Windows does not offer Windows Hello | the account has no PIN configured |

[← 6 · VPN](06-vpn.md) · [Guide index](README.md) · Next: [8 · The dashboard →](08-dashboard.md)
