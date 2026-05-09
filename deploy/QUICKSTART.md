# AuraSense NVR — Customer Machine Setup

Scripted deployment for **Intel i3 4th gen, 4 GB RAM, 500 GB system HDD, 4 TB recording HDD, two Ethernet ports**.

---

## Before You Start (Manual — Cannot Be Scripted)

### 1. BIOS Settings
Boot into BIOS (Del or F2 at POST) and set:

| Setting | Value |
|---|---|
| AC Power Loss Recovery | **Power On** |
| Sleep / S-states | Disabled |
| Secure Boot | Disabled |
| Fast Boot | Disabled |
| Intel SpeedStep | Disabled |
| Hyper-Threading | Enabled |

### 2. Flash Ubuntu 24.04.2 LTS Server
Download: `ubuntu-24.04.2-live-server-amd64.iso`

Flash to USB:
```bash
sudo dd if=ubuntu-24.04.2-live-server-amd64.iso of=/dev/sdX bs=4M status=progress oflag=sync
```
Or use [Balena Etcher](https://etcher.balena.io) on Windows/Mac.

### 3. Install Ubuntu

During the installer:

- **Username:** `aura` / **Hostname:** `aurasense-nvr`
- **OpenSSH server:** ✓ Check this
- **Snaps:** Deselect everything
- **Network:** Configure both NICs:
  - NIC 1 (internet port): DHCP — leave as-is
  - NIC 2 (camera port): Static `10.42.0.1/24`, no gateway
- **Storage (500 GB system drive)** — Custom layout:

| Partition | Size | Mount |
|---|---|---|
| ESP | 1 GB | `/boot/efi` |
| Boot | 2 GB | `/boot` |
| Root | 60 GB | `/` |
| Var | 80 GB | `/var` |
| Home | 300 GB | `/home` |
| Swap | rest (~57 GB) | swap |

- **Leave the 4 TB drive completely untouched** — scripts handle it.

---

## Running the Scripts

SSH into the machine after OS install, then:

```bash
# Clone the repo
git clone https://github.com/ashwaniemd-wq/Aura-Sense-Server.git /home/aura/Documents/aurasense

# Run the master installer (as root)
cd /home/aura/Documents/aurasense
sudo bash deploy/install-all.sh
```

The script will prompt for **4 values** at the start — everything else is auto-detected:

| Prompt | Example |
|---|---|
| Camera NIC static IP | `10.42.0.1` (default) |
| Camera subnet | `10.42.0.0/24` (default) |
| Camera ONVIF/RTSP password | `YourCameraPass` |
| Git repository URL | auto-filled (already cloned) |
| Cloudflare domain | `site1.aurasense.com` |

---

## What Each Phase Does

| Phase | Script | Notes |
|---|---|---|
| 00 | `00-netplan.sh` | Dual-NIC static IP + prevents boot stall if camera cable unplugged |
| 01 | `01-calibrate.sh` | Microcode, CPU governor, kernel tuning, disable sleep — **reboots** |
| 02 | `02-prerequisites.sh` | Python 3.11, Node.js 20, Redis, FFmpeg, Chromium, cage |
| 03 | `03-deploy.sh` | Venvs, npm install, dashboard build, `.env`, systemd services |
| 04 | `04-hdd-setup.sh` | Partition + format 4 TB HDD, mount with `nofail` fstab entry |
| 05 | `05-kiosk.sh` | TTY1 autologin + cage Wayland kiosk service |
| 06 | `06-firewall.sh` | UFW — RTSP locked to camera NIC, API/HLS/WebRTC open |
| 07 | `07-cloudflare.sh` | cloudflared tunnel, DNS routes, systemd service |
| 08 | `08-verify.sh` | Full health check with pass/fail report |

> **Phase 01 reboots the machine.** SSH back in and re-run `install-all.sh`. Press **S** to skip phase 01 and continue from phase 02.

Each phase can be skipped individually by pressing **S** when prompted.

---

## After Installation

```bash
# Reboot and verify everything auto-starts
sudo reboot

# SSH back in, then:
sudo bash /home/aura/Documents/aurasense/deploy/08-verify.sh
```

Expected output: all checks green, 0 failures.

Then connect cameras to the **camera NIC port**. Within ~60 seconds, cameras appear automatically — no manual configuration needed.

Check discovery:
```bash
curl -s http://127.0.0.1:9997/v3/paths/list | python3 -m json.tool
```

---

## Running Individual Scripts

Any script can be run standalone after the initial config is saved:

```bash
# Re-run verification
sudo bash deploy/08-verify.sh

# Reconfigure firewall only
sudo bash deploy/06-firewall.sh

# Set up Cloudflare tunnel (after getting the domain)
sudo bash deploy/07-cloudflare.sh
```

Config is saved to `deploy/.config` after first run — subsequent scripts load it without re-prompting. Delete `.config` to re-enter all values.

---

## Services

All services start automatically on boot under `aurasense.target`:

| Service | What it does |
|---|---|
| `aurasense-mediamtx` | RTSP relay — all camera streams |
| `aurasense-discovery` | ONVIF scanner — finds cameras, updates mediamtx |
| `aurasense-api` | REST API + serves dashboard on port 8000 |
| `aurasense-recording` | FFmpeg segment recorder → 4 TB HDD |
| `aurasense-watchdog` | Health monitor → `/run/aurasense/health.json` |
| `aurasense-kiosk` | Chromium kiosk display (if monitor connected) |
| `cloudflared` | Remote access tunnel |

Logs:
```bash
journalctl -u aurasense-mediamtx -f
journalctl -u aurasense-api -f
journalctl -u aurasense-discovery -f
journalctl -u aurasense-recording -f
```

Restart all:
```bash
sudo systemctl restart aurasense.target
```

---

## Network Layout

```
Internet ←→ NIC 1 (DHCP)     ←→ Cloudflare tunnel → Android app
Cameras  ←→ NIC 2 (10.42.0.1) ←→ mediamtx → recording HDD
```

- Port 8000 — API + dashboard
- Port 8554 — RTSP (camera NIC only)
- Port 8888 — HLS streaming
- Port 8889 — WebRTC
- Port 9997 — mediamtx internal API (localhost only)
