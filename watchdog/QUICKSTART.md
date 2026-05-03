# AuraSense Watchdog & Recovery

## What it does

| Concern | Handled by |
|---|---|
| Service crashes | systemd `Restart=always` — immediate restart |
| Camera RTSP drop | mediamtx built-in retry loop |
| FFmpeg encoder stall | watchdog detects → `systemctl restart aurasense-parking-encoder` |
| Power loss recovery | `After=network-online.target`, unlimited restarts |
| Boot ordering | `Requires=` and `After=` chains prevent races |
| Debug logs | All services → journald, queryable with `journalctl` |

## Install

```bash
sudo bash /home/aura/Documents/aurasense/systemd/install.sh

# Start everything
sudo systemctl start aurasense.target
```

## First-time: enable network-online.target

On Ubuntu with NetworkManager (required for `After=network-online.target`):

```bash
sudo systemctl enable NetworkManager-wait-online.service
```

## Useful commands

```bash
# Status of all AuraSense services
sudo systemctl status aurasense-*

# Live logs
journalctl -u aurasense-watchdog -f
journalctl -u aurasense-mediamtx -f
journalctl -u aurasense-parking-encoder -f
journalctl -u aurasense-api -f

# All services, last hour
journalctl -u 'aurasense-*' --since -1h

# Stream health snapshot (written by watchdog every 30 s)
cat /run/aurasense/health.json | python3 -m json.tool

# Restart a single service
sudo systemctl restart aurasense-parking-encoder

# Restart everything
sudo systemctl restart aurasense.target
```

## Recovery behaviour

### Camera goes offline (network cut / camera reboots)
- mediamtx retries the RTSP connection continuously
- Watchdog logs `path 'entrance' not ready` every 30 s
- When camera comes back: mediamtx reconnects automatically, watchdog logs recovery

### FFmpeg encoder crashes (parking stream)
- systemd restarts it after 15 s
- If it fails twice in a row (60 s), the watchdog issues a second restart
- The 15 s delay gives mediamtx time to be fully ready first

### mediamtx crashes
- systemd restarts it in 10 s
- Parking encoder loses its publish target → exits → systemd restarts it 15 s later
- Watchdog detects parking publisher missing → waits one extra poll (30 s grace), then restarts encoder if mediamtx is already back

### Power loss / full reboot
1. systemd waits for `network-online.target` (NetworkManager reports link up)
2. `aurasense-mediamtx` starts — begins connecting to cameras (retries until they boot)
3. `aurasense-api` starts — waits for Redis, then opens HTTP
4. `aurasense-parking-encoder` starts 15 s after mediamtx — NVR likely still booting, will retry
5. `aurasense-watchdog` starts last — begins monitoring

IP cameras take 30–90 s to boot after power. `StartLimitIntervalSec=0` means systemd never gives up retrying.

## Watchdog health file

`/run/aurasense/health.json` is written every 30 s:

```json
{
  "timestamp": "2026-05-03T09:00:00+00:00",
  "mediamtx": "ok",
  "api_gateway": "ok",
  "paths": {
    "entrance": "ready",
    "lobby": "ready",
    "parking": "ready"
  },
  "issues": []
}
```

This file is in `/run/` (tmpfs) so it is cleared on reboot — intentional.
