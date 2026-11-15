# Lessons learned

Real problems met while building and running the cluster, written as **symptom → cause → fix**.
Most of them cost hours; all of them are cheap to avoid once you know them.

**Contents:** [Hardware & power](#hardware--power) · [Firewall & networking](#firewall--networking) ·
[K3s](#k3s) · [Security](#security) · [Storage & backups](#storage--backups) ·
[Deployment & tooling](#deployment--tooling) · [Monitoring & dashboard](#monitoring--dashboard) ·
[Working habits](#working-habits)

---

## Hardware & power

**Wake-on-LAN does nothing, although the NIC is armed (`wol g`) and the MAC is right.**
Almost always the **ErP / EuP** power-saving option in the BIOS: it cuts power to the network card when
the machine is off. Disable it. Also arm the NIC again at every boot *and shutdown* with a small
systemd unit: the netplan `wakeonlan: true` setting did not persist on these machines.

**A node switches itself back on right after being powered off.**
Check `/proc/acpi/wakeup`: here the USB controller and the GPU slot were allowed to wake the machine.
A unit that leaves only the network card enabled fixed it.

**One board still powered itself on after the first shutdown following a network wake.**
Packet captures showed no magic packet: it was the board itself. The network card keeps a pending
"woken by LAN" flag and the board acts on it when powering off. Disabling Wake-on-LAN and arming it
again just before shutdown clears it (`rearmar-wol`). As a safety net, the shutdown script still
watches the node for 90 seconds and powers it off again if it comes back without anyone having
requested a service.

**A node kept waking up by itself, at night too.** Before changing anything, find out who sends the
magic packet: a listener on the Pi that logs every magic packet on the LAN (`vigilar-wol`) and a
wrapper that logs which process asked the Pi to send one. Here it was the photo library's phone app:
even with background backup off, it checks the server version now and then, and the wake-on-access
proxy took that connection as "the user opened the app". The fix was in the proxy, not in the phone:
read the request before waking, ignore those automatic paths, add quiet hours, and do not wake a node
that was put to sleep by hand a few minutes ago.

**After a power cut, Wake-on-LAN stopped working and a node showed "Press F1 to run SETUP".**
A dead **CMOS battery** (CR2032): the BIOS settings, including the ones that make Wake-on-LAN work,
were lost. Replace the battery in old desktops before trusting them to wake up unattended.

**Power cycling and hardware wear.**
CPU, board, RAM and SSD do not care. The **hard drive** does (it is rated for a limited number of
start/stop cycles): use an idle time long enough to group work, and watch `Start_Stop_Count` in SMART.

**An AMD card that cannot compute.**
An R9 380 (GCN 3) is not supported by Blender Cycles (HIP needs RDNA, OpenCL was removed in Blender
3.0) nor by PyTorch (no ROCm). It cannot be combined with the NVIDIA card in the same render either.
Check compute support before counting a GPU as a resource.

## Firewall & networking

**Never `flush ruleset` on a machine that runs K3s.**
It also deletes the rules K3s created. The ones of the service load balancer (`svclb`) are not
recreated, so services silently stopped answering on some addresses. Replace only your own table
(`table inet filter` + `delete table inet filter`). If it already happened, delete the `svclb` pods
so K3s recreates them.

**A port closed in `input` is still reachable.**
Services published by K3s are **forwarded** to the pod network, so they never hit the `input` chain.
Filter them in `forward`, matching the port the client asked for with `ct original proto-dst`.

**The admin PC lost SSH *and ping* to the Pi after a DHCP renewal.**
The PC got a new address that the firewall did not know, and the `output` chain was dropping the
replies. Two fixes: a **DHCP reservation** for every device the firewall trusts, and
`ct state established,related accept` at the top of `output`, so replies always go out while the Pi
still cannot *initiate* connections to the home network.

**The firewall log is full of noise.**
Almost everything blocked at home is broadcast/multicast chatter (mDNS, NetBIOS, IGMP, vendor
discovery). Drop it before the log rule with `meta pkttype { broadcast, multicast } drop`, and
rate-limit the log (`limit rate 30/second burst 60`), high enough for CrowdSec to still see a scan.

**Always change a firewall starting from the live file, with a rescue timer.**
An old saved copy once removed two rules that had been added later; the `diff` against the live file
before applying is what caught it. On headless machines, schedule an automatic rollback
(e.g. `systemd-run --on-active=5min`) before applying, and cancel it once you are still connected.

**"It works from home" may still be going through the VPN.**
With the VPN always on, the phone uses the tunnel even on the home Wi-Fi. To test what the home LAN
can reach, turn the VPN off: if a private service loads, something is open that should not be.
To test the VPN itself, use mobile data, not the home Wi-Fi.

## K3s

**Upgrade the server first.** A K3s server must never be older than its agents: upgrade the Pi, then
install agents with an explicit `INSTALL_K3S_VERSION`.

**`local-path` volumes cannot be created on tainted nodes.** The provisioner's helper pod does not
tolerate the `power=ondemand` taint. Use `hostPath` volumes for workloads pinned to those nodes, and
give them the `power`, `unreachable` and `not-ready` tolerations so they stay bound while the node
sleeps.

**Non-root containers and `hostPath`.** A container that does not run as root (FileBrowser) goes into
`CrashLoopBackOff` with "Permission denied" until the host folder is writable for its user.

**Authelia read its configuration from Kubernetes' own variables.** Kubernetes injects
`<SERVICE>_PORT_*` environment variables into every pod; Authelia treats `AUTHELIA_*` variables as
configuration and failed to start. Set `enableServiceLinks: false` in the pod spec.

**A PostgreSQL container stuck at 100 % CPU, never starting.** The database of the photo library
hung in `gosu`, the tool that switches from root to the `postgres` user. Some Ubuntu kernels give
containers a "stacked" AppArmor profile that drops signals between threads, and `gosu` waits forever
for one. Running only that container without AppArmor (`appArmorProfile: Unconfined`; it is not
exposed) fixed it; add a `pg_isready` probe so Kubernetes only sends traffic, and restarts it, based
on whether the database really answers. Check the other nodes' kernels too: the same image will hang
there.

**kubectl is root on every node.** Treat kubeconfig files like passwords.

**Watch the projects you depend on.** The original FileBrowser was archived with security issues
left unfixed, one of them in the proxy authentication this cluster uses. It was only reachable through
Traefik, so the impact was low, but an archived project gets no more fixes. Moving to an active fork
took one manifest, because the files are plain folders and the login lives in Authelia. Pin image
versions so updates happen on purpose.

## Security

**CrowdSec ignored every attack coming from the home network.** Its default
`crowdsecurity/whitelists` parser whitelists all private IP ranges. That is reasonable for a server in a
datacenter, wrong at home, where a compromised device on the LAN is exactly what you want to catch.
Remove it and whitelist only your own machines and the VPN subnet.

**"Unbanning does not work."** It usually does; the scan that caused the ban is still running and
gets the IP banned again a few seconds later.

**`cscli explain --file` on a whole log takes forever.** Test a parser with a single line instead:
`cscli explain --log "<one line>"`.

**Passkeys are bound to the domain.** Registering them on one domain and moving the portal to another
means registering them again. Windows Hello only shows up if the account has a PIN, and third-party
password managers may capture the credential without the server ever receiving it.

**Header-based single sign-on is only as safe as the network path.** If an app trusts a
`Remote-User` header, nothing but the reverse proxy may be able to reach it: close its port in the
firewall, or anyone could send the header themselves.

**Keep cluster scripts out of public repositories**, unless every installation-specific value is
replaced first. This repository does it with `@@MARKERS@@` and a pre-commit hook.

## Storage & backups

**A backup does not count until it has been restored.** The first restore test (`restic restore` of
an app database + `PRAGMA integrity_check`) is what turned "a backup job runs" into "there is a
backup".

**Copy SQLite databases with `.backup`, not `cp`.** A plain copy of a database in use can be
inconsistent; `sqlite3 db ".backup 'copy'"` is safe while the app writes, and makes the `-wal` /
`-shm` files unnecessary in the backup.

**Mount data disks with `nofail`** on machines that boot unattended: a dead disk must not keep the
node from booting.

**A single I/O error is not always a dying disk.** After heavy writes, check `dmesg` and
`UDMA_CRC_Error_Count` (a cable or connector problem) before blaming the drive. Pending sectors
that disappear after the area is rewritten were soft errors; reallocated sectors are not.

**Configuration files and inline comments.** systemd `EnvironmentFile`s do not support comments at
the end of a line: the comment becomes part of the value. The backup script's source list had the
same bug until it learned to strip them.

## Deployment & tooling

**Line endings.** Files edited on Windows need `\n` before Linux uses them. The deploy script converts
text files, and once converted the PNG icons too, corrupting them. Binary files must be copied
untouched.

**`systemctl edit` changes are lost on the next deploy** when the deploy script reinstalls the unit
files. Change the unit file in the repository instead.

**Work as the service user, not as root.** For root, `~` is `/root`: manifests saved in `~/k8s` ended up
outside the backups, and root's SSH keys are not the ones the power controller uses.

**`git push` to the Pi failed with "dubious ownership".** The bare repository had been created as root,
while the hook and Podman run as the normal user. Create deployment repositories as that user.

**Windows OpenSSH refused `~/.ssh/config`.** An orphaned account SID still had permissions on the
file. Reset its ACL (`icacls … /inheritance:r`, remove the SID, keep only your user and SYSTEM).

**PowerShell blocks downloaded scripts** even with the `RemoteSigned` policy: `Unblock-File`.

**A browser download of an existing file becomes `name (1).ext`**, which makes it easy to deploy an
old version. Check the content (`Select-String`) before deploying.

## Monitoring & dashboard

**Beszel aggregates history** (1, 10, 20, 120 and 480-minute buckets). Zooming out loses resolution,
and an "empty" short gap may be missing detail, not a stopped machine. A new Beszel user also sees no
systems until they are shared with it.

**Per-pod network traffic comes from the kubelet**:
`kubectl get --raw /api/v1/nodes/<node>/proxy/metrics/cadvisor` (`container_network_*_bytes_total`).
The counters reset when a pod restarts.

**Beszel thins out its history.** After a day it keeps a point every couple of hours, so a past day
looks empty or flat. The dashboard stores its own sample of every machine every 5 minutes (90 days in
SQLite, a few MB), which is what the charts of past days and the calendar use.

**A phone layout that fits in the browser's device emulator may not fit on the phone.** The emulator
had a few pixels more and slightly different text rendering; on the real phone the names were cut. Do
not size a row to the last pixel: leave margin, and let narrow cards switch to a tighter layout with a
container query (`@container`) instead of depending only on the screen width.

**The installed web app kept showing old CSS and JS after every deploy.** Without `Cache-Control`
headers, the phone browser reused its cached copies; clearing the *app's* storage in Android does not
help, because the installed web app uses the browser's cache. Sending `Cache-Control: no-cache`
makes the browser revalidate every time (a cheap `304` when nothing changed).

**A theme that sets its own background needs a light *and* a dark version.** Otherwise switching
mode changes the text and the cards but not the background, and the page becomes unreadable.

## Working habits

- Measure before deciding: wake time (~35 s), render times per node, real GPU throughput. Numbers
  settled several debates (S5 vs. suspend, which node renders what).
- Keep a written plan of what is decided and what is pending, and a runbook of *how* each piece is
  done. Both are private here; this repository is the cleaned-up result.
- When a large file has accumulated many patches, rewriting it cleanly (and checking that no function
  went missing) is safer than one more patch.
