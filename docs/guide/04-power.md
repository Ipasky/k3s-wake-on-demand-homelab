# 4 · Power: Wake-on-LAN and the controller

[← 3 · K3s](03-k3s.md) · [Guide index](README.md) · Next: [5 · Domain and HTTPS →](05-https.md)

Three pieces make the nodes sleep and wake on their own:

| Piece | Where | What it does |
|---|---|---|
| `wol.service` / `rearmar-wol.service` | each node | Arms the network card for Wake-on-LAN at every boot **and shutdown** |
| [`nodo`](../../scripts/nodo) | Pi | `nodo despertar`, `dormir`, `estado`: wake, power off, status |
| [`nodo-controlador`](../../scripts/nodo-controlador) | Pi | Watches the cluster and calls `nodo` when a job needs a node, or a node has been idle |

## 4.1 Arm Wake-on-LAN on each node

Find the wired interface (`ip route get 192.168.1.1` → `dev …`) and create a unit that arms it.
`ethtool` runs both on start **and on stop**: on some cards the setting is lost on shutdown, and the
netplan `wakeonlan: true` option did not persist.

```bash
IFACE=eno1                                # your interface
sudo tee /etc/systemd/system/wol.service > /dev/null <<EOF
[Unit]
Description=Arm Wake-on-LAN
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/ethtool -s $IFACE wol g
ExecStop=/usr/sbin/ethtool -s $IFACE wol g

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now wol.service
sudo ethtool $IFACE | grep Wake-on        # Wake-on: g
sudo ethtool -P $IFACE                    # permanent MAC → MAC_FARADAY / MAC_MUSTANG in local.env
```

## 4.2 If a node switches itself back on

Some boards let USB or the PCIe slot wake the machine too. List the wake sources:
```bash
cat /proc/acpi/wakeup                     # lines with *enabled
```
Leave only the network card. Example where the USB controller (`XHC`) and the GPU slot (`PEG0`)
were waking the node up:
```bash
sudo tee /usr/local/sbin/only-lan-wakes.sh > /dev/null <<'EOF'
#!/bin/sh
for d in XHC PEG0; do
  grep -Eq "^$d[[:space:]].*\*enabled" /proc/acpi/wakeup && echo "$d" > /proc/acpi/wakeup
done
exit 0
EOF
sudo chmod +x /usr/local/sbin/only-lan-wakes.sh
sudo tee /etc/systemd/system/only-lan-wakes.service > /dev/null <<'EOF'
[Unit]
Description=Only the network card may wake the machine
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/only-lan-wakes.sh
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now only-lan-wakes.service
```
If a node *still* comes back on after a shutdown and no packet reaches it (check with `tcpdump`), the
`nodo` script handles it: after powering a node off it watches it for 90 s and powers it off again if
it returns without anybody having asked for it.

## 4.3 Let the Pi power the nodes off

The Pi powers a node off over SSH (key from [chapter 1](01-machines.md#14-ssh-with-keys-only)), so
the node's user may run exactly one command without a password:
```bash
# on each node
echo "faraday ALL=(root) NOPASSWD: /usr/sbin/poweroff" | sudo tee /etc/sudoers.d/10-poweroff
sudo chmod 440 /etc/sudoers.d/10-poweroff && sudo visudo -c
```

## 4.4 Try `nodo`

`desplegar.ps1` already installed it with your IPs and MACs (`@@IP_*@@`, `@@MAC_*@@`). As the
**normal user** on the Pi (the controller runs as that user and uses its SSH key):
```bash
nodo estado                     # ping + K3s state of every node
nodo dormir faraday             # cordon + power off, waits until it is really off
nodo despertar faraday          # one magic packet, waits for Ready, uncordon (~35 s)
```
`nodo dormir` refuses if the node runs services (e.g. the NAS); `-f` forces it.

## 4.5 The controller

```bash
sudo apt install -y jq
sudo systemctl enable --now nodo-controlador
journalctl -u nodo-controlador -f
```
Its settings are in `/etc/default/nodo-controlador` (installed once from
[`config/nodo-controlador.env`](../../config/nodo-controlador.env), never overwritten afterwards):

| Setting | Default | Meaning |
|---|---|---|
| `INTERVAL` | 30 | Seconds between checks |
| `IDLE_MIN` | 15 | Idle minutes before powering a node off |
| `WAKE_GRACE` | 300 | Seconds a freshly woken node is left alone |
| `DRY_RUN` | 1 | `1` = only log what it *would* do. Set `0` when you trust it |

> Comments in that file must be on their own line: systemd does not support `VAR=value  # comment`.
> If the log at start-up shows values you did not set, it is not reading the file.

**What wakes a node:** a `Pending` pod of a **Job** (or with the annotation `power/wake: "true"`)
that tolerates the `power` taint and whose `nodeSelector` matches the node.

**What keeps it awake:** a running job, the label `power-hold=true`, recent service traffic
(annotation `power/last-activity`, set by the dashboard in chapter 8) or an open SSH session.
The dashboard's lock button sets and removes the same label (with an optional expiry in the
annotation `power/hold-hasta`); while a backup runs, the backup holds the node and the lock cannot
release it.

```bash
kubectl label node faraday power-hold=true      # keep it on while you work on it
kubectl label node faraday power-hold-          # release it
```

## 4.6 Check the whole loop

Submit the [job template](03-k3s.md#36-the-job-template) with `node-type: cpu` and a short command
(`sleep 60`). With the node off, the controller log shows it waking it up; the job runs; after
`IDLE_MIN` minutes the node powers off again.

| Symptom | Likely cause |
|---|---|
| Node does not wake although the NIC shows `Wake-on: g` and the MAC is right | **ErP** still enabled in the BIOS |
| `Wake-on: d` after a reboot | `wol.service` missing or disabled |
| Asks for a password when powering off | the Pi user's SSH key or the sudoers rule is missing |
| A pending job does not wake anything | not a Job, no `power` toleration, or no matching `nodeSelector` |
| A node never sleeps | `power-hold`, an open SSH session, or a job stuck in `Running` |
| A node switches itself back on after the first shutdown that follows a network wake | the board reacts to a pending "woken by LAN" flag: use `rearmar-wol` (below) |
| A node wakes up and nobody knows why | on the Pi: `journalctl -u vigilar-wol` (every magic packet seen on the LAN, from any device) and `journalctl -t wakeonlan` (which process asked the Pi to send one) |

**`rearmar-wol`.** `desplegar.ps1` installs [`scripts/rearmar-wol`](../../scripts/rearmar-wol) and its
unit on each node. It does what `wol.service` does at boot and, at shutdown, disables Wake-on-LAN and
arms it again: that clears the pending wake flag some boards act on when powering off. It replaces
`wol.service` (disable that one if you created it by hand).

**Who woke the node.** Two helpers on the Pi, also installed by `desplegar.ps1`:
[`vigilar-wol`](../../scripts/vigilar-wol) listens on the Pi's network card and logs every magic packet
on the LAN (a sleeping node drops out of the switch's table, so packets for it reach the Pi too), and
[`wakeonlan-registro`](../../scripts/wakeonlan-registro), installed as `/usr/local/bin/wakeonlan`,
logs the chain of processes behind each packet the Pi sends before sending it.

[← 3 · K3s](03-k3s.md) · [Guide index](README.md) · Next: [5 · Domain and HTTPS →](05-https.md)
