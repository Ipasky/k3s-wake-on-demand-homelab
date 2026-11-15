# 1 · Prepare the machines

[← 0 · Plan](00-plan.md) · [Guide index](README.md) · Next: [2 · Firewall →](02-firewall.md)

Ubuntu Server on every machine, fixed addresses, SSH with keys only, and the BIOS settings that make
Wake-on-LAN work.

## 1.1 The Raspberry Pi

1. Flash **Ubuntu Server LTS (arm64)** to the **SSD** with Raspberry Pi Imager. In its settings, set
   the hostname (`pi-master`), the user (`raspberrypi`) and enable SSH.
2. Boot from the SSD and update:
   ```bash
   sudo apt update && sudo apt full-upgrade -y
   sudo timedatectl set-timezone Europe/Madrid      # your Region/City
   sudo apt install -y nftables smartmontools sqlite3
   ```
3. **Memory cgroups** (required by K3s): append to the single line of `/boot/firmware/cmdline.txt`
   ```
   cgroup_memory=1 cgroup_enable=memory
   ```
   and reboot.
4. Check the SSD's health. USB-SATA adapters need `-d sat`:
   ```bash
   sudo smartctl -d sat -H /dev/sda
   ```

## 1.2 The nodes

**BIOS (once, with a monitor).** Names vary by vendor; on ASUS boards:
- *Advanced → APM Configuration →* **Power On By PCI-E: Enabled** (this *is* Wake-on-LAN).
- **ErP Ready: Disabled**. With ErP on, the network card has no power when the PC is off and
  Wake-on-LAN silently does nothing.
- Boot the Ubuntu USB stick in **UEFI** mode.

**Ubuntu Server LTS (amd64).**
- Identify the system SSD by size and model, never by `sdX`: `lsblk -d -o NAME,SIZE,ROTA,MODEL`.
- Network via **DHCP**, **LVM yes**, disk encryption **no** (an encrypted node cannot boot
  unattended), and **grow the `ubuntu-lv` volume** to the whole disk; the installer leaves it at
  100 GB.
- Hostname and user = the node's name (`faraday`, `mustang`). Tick **Install OpenSSH server**.

Then:
```bash
sudo apt update && sudo apt full-upgrade -y
sudo timedatectl set-timezone Europe/Madrid
sudo apt install -y nftables ethtool smartmontools
```

## 1.3 Fixed addresses

On the router, create a **DHCP reservation** (MAC → IP) for every machine in your
[address plan](00-plan.md#address-plan), including the admin PC and, if you want, your phone.
- A machine's MAC: `ip -o link | grep -v 'lo:'` (Linux), `getmac /v` (Windows).
- For the phone, use the MAC of **your home Wi-Fi network**: phones randomise it per network by
  default, so make it fixed for this network in the phone's Wi-Fi settings.
- If the reserved address is still "taken" by an old MAC, delete that entry or restart the router.

Do not continue until every machine has its planned address: the firewall in chapter 2 trusts
addresses, not names.

## 1.4 SSH with keys only

**From the admin PC** to every machine:
```powershell
ssh-keygen -t ed25519 -C "admin-pc"            # once, if you have no key yet
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh raspberrypi@192.168.1.20 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
ssh -o BatchMode=yes raspberrypi@192.168.1.20 hostname   # must answer without asking anything
```
Repeat for `faraday@192.168.1.21` and `mustang@192.168.1.22`.

A short alias file saves typing, `%USERPROFILE%\.ssh\config`:
```
Host pi
    HostName 192.168.1.20
    User raspberrypi
Host faraday
    HostName 192.168.1.21
    User faraday
Host mustang
    HostName 192.168.1.22
    User mustang
```
> If Windows OpenSSH says *Bad permissions* for this file, an orphaned account still has rights on
> it: `icacls config /inheritance:r`, remove that SID, keep only your user and SYSTEM.

**From the Pi** to the nodes (the power controller and the backup job use this key, so create it as
the normal user, not as root):
```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
ssh-copy-id faraday@192.168.1.21
ssh-copy-id mustang@192.168.1.22
```

**Then disable passwords**, on each machine, keeping one session open in case something goes wrong:
```bash
printf 'PasswordAuthentication no\nPermitRootLogin no\nKbdInteractiveAuthentication no\n' | \
  sudo tee /etc/ssh/sshd_config.d/99-hardening.conf
sudo sshd -t && sudo systemctl reload ssh
```
Open a **new** session to check it still works before closing the old one.

## 1.5 Deploy the scripts once

From the repository folder on the admin PC:
```powershell
.\deploy\desplegar.ps1 -Probar      # dry run: what goes to which machine
.\deploy\desplegar.ps1              # copies and installs; asks for sudo on each machine
```
It installs the scripts, systemd units and the dashboard. Services that depend on later chapters
(K3s, WireGuard…) simply have nothing to do yet; you will run it again as you go.

[← 0 · Plan](00-plan.md) · [Guide index](README.md) · Next: [2 · Firewall →](02-firewall.md)
