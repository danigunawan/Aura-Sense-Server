# Camera Discovery Service — Quick Start

Scans the local network for ONVIF cameras, retrieves RTSP URLs, and stores them in SQLite.

## Prerequisites

- Python 3.11+
- Cameras must be on the same network segment (UDP multicast must not be blocked)

## Install

```bash
cd camera_discovery
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configure

```bash
cp ../.env.example .env   # or create manually
```

Minimum required variables (all have defaults for local dev):

| Variable             | Default        | Description                          |
|----------------------|----------------|--------------------------------------|
| `DB_PATH`            | `cameras.db`   | SQLite file path                     |
| `DISCOVERY_INTERVAL` | `60`           | Seconds between scans                |
| `DISCOVERY_TIMEOUT`  | `5.0`          | WS-Discovery listen window (seconds) |
| `ONVIF_TIMEOUT`      | `10`           | Per-request ONVIF timeout (seconds)  |
| `LOG_LEVEL`          | `info`         | `debug` \| `info` \| `warning`       |

## Run

```bash
# Continuous loop — runs forever, rescans every DISCOVERY_INTERVAL seconds
python3 main.py

# Single scan then exit — useful for cron or testing
python3 main.py --once

# Print all cameras currently in the database
python3 main.py --list
```

## Verify

After a scan, `--list` should show your cameras:

```
ID   Name                IP               Status       RTSP URL
1    Entrance            192.168.1.101    online       rtsp://admin:admin@192.168.1.101/stream1
2    Parking             192.168.1.102    online       rtsp://admin:****@192.168.1.102/stream1
```

If no cameras appear:
- Confirm cameras support ONVIF (most IP cameras do)
- Check that UDP port 3702 is not firewalled between host and cameras
- Try `DISCOVERY_TIMEOUT=10 python main.py --once` for slower cameras
- Enable debug logging: `LOG_LEVEL=debug python main.py --once`

## Custom credentials

If your cameras use non-default passwords, edit `config.py` → `credentials` list.
The service tries each pair in order and stops at the first that works.

## As a systemd service

```ini
# /etc/systemd/system/nvr-discovery.service
[Unit]
Description=AuraSense Camera Discovery
After=network-online.target
Wants=network-online.target

[Service]
User=nvr
WorkingDirectory=/opt/nvr/camera_discovery
EnvironmentFile=/opt/nvr/camera_discovery/.env
ExecStart=/opt/nvr/camera_discovery/.venv/bin/python3 main.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nvr-discovery
sudo journalctl -u nvr-discovery -f
```
