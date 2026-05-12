#!/usr/bin/env python3
"""
AuraSense camera discovery service.

Usage:
    python main.py                  # continuous loop
    python main.py --once           # single scan, then exit
    python main.py --list           # print DB contents and exit
    python main.py --probe          # discover all cameras, print device info, no DB write
                                    # use this first to find what your cameras report as
                                    # manufacturer/model before setting CAMERA_ALLOWED_*

Environment variables (see config.py for all options):
    CAMERA_ONVIF_USER       ONVIF username (default: admin)
    CAMERA_ONVIF_PASS       ONVIF password (required)
    CAMERA_RTSP_USER        RTSP username embedded in stream URLs (default: admin)
    CAMERA_RTSP_PASS        RTSP password embedded in stream URLs (required)
    CAMERA_ALLOWED_MANUFACTURER  Prama  (case-insensitive prefix — skip others)
    CAMERA_ALLOWED_MODELS   Optional comma-separated model substrings
    DISCOVERY_INTERVAL      60 (seconds between scans)
"""

import argparse
import asyncio
import logging
import os
import signal
import sys

from dotenv import load_dotenv

load_dotenv()


def _setup_logging() -> None:
    level = os.getenv('LOG_LEVEL', 'INFO').upper()
    logging.basicConfig(
        level=level,
        format='%(asctime)s %(levelname)-8s %(name)s: %(message)s',
        datefmt='%Y-%m-%dT%H:%M:%S',
    )
    if level != 'DEBUG':
        for noisy in ('zeep', 'urllib3', 'asyncio'):
            logging.getLogger(noisy).setLevel(logging.WARNING)


async def _cmd_list(db_path: str) -> None:
    from database import CameraDB
    db = CameraDB(db_path)
    await db.connect()
    cameras = await db.get_all()
    await db.close()

    if not cameras:
        print("No cameras in database.")
        return

    fmt = "{:<4} {:<18} {:<28} {:<12} {:<15} {}"
    print(fmt.format("ID", "Name", "Model", "Status", "IP", "Slug"))
    print("-" * 100)
    for cam in cameras:
        model = f"{cam.manufacturer} {cam.model}".strip() or "Unknown"
        print(fmt.format(cam.id, cam.name, model[:27], cam.status, cam.ip_address, cam.slug))


async def _cmd_probe() -> None:
    """Discover all ONVIF cameras on the network, print device info, skip allowlist."""
    from config import Config
    import wsdiscovery
    import onvif_client

    cfg = Config()

    if not cfg.onvif_pass:
        print("ERROR: Set CAMERA_ONVIF_PASS before probing.", file=sys.stderr)
        sys.exit(1)

    print("Probing network for ONVIF devices (no allowlist filter)…\n")
    devices = await wsdiscovery.scan(timeout=cfg.discovery_timeout)

    if not devices:
        print("No ONVIF devices found.")
        return

    print(f"Found {len(devices)} device(s). Querying ONVIF info…\n")
    fmt = "{:<15} {:<20} {:<30} {:<14} {}"
    print(fmt.format("IP", "Manufacturer", "Model", "Serial", "Firmware"))
    print("-" * 100)

    tasks = [
        onvif_client.interrogate(
            device               = dev,
            username             = cfg.onvif_user,
            password             = cfg.onvif_pass,
            rtsp_user            = cfg.rtsp_user,
            rtsp_pass            = cfg.rtsp_pass,
            allowed_manufacturer = [],   # no filter in probe mode
            allowed_models       = [],
            timeout              = cfg.onvif_timeout,
            max_attempts         = 2,
        )
        for dev in devices
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    for dev, result in zip(devices, results):
        ip = dev.ip_address
        if isinstance(result, Exception) or result is None:
            print(fmt.format(ip, "AUTH FAILED", "-", "-", "-"))
        else:
            print(fmt.format(
                ip,
                result.manufacturer[:19],
                result.model[:29],
                result.serial_number[:13],
                result.firmware_version[:20],
            ))

    print("\nTip: set CAMERA_ALLOWED_MANUFACTURER=<Manufacturer> in your .env file.")


async def _cmd_sync_time(target: str) -> None:
    """Push current UTC time to one camera (HOST or HOST:PORT) via ONVIF."""
    from config import Config
    import onvif_client

    cfg = Config()
    if not cfg.onvif_pass:
        print("ERROR: CAMERA_ONVIF_PASS not set.", file=sys.stderr)
        sys.exit(1)

    host, _, port_s = target.partition(':')
    port = int(port_s) if port_s else 80
    try:
        await onvif_client.set_system_time(host, port, cfg.onvif_user, cfg.onvif_pass)
        print(f"Time synced to {host}:{port}")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


async def _cmd_run(args: argparse.Namespace) -> None:
    from config import Config
    from database import CameraDB
    from service import DiscoveryService

    cfg = Config()

    if not cfg.onvif_pass:
        print("ERROR: CAMERA_ONVIF_PASS is not set. Cannot authenticate with cameras.",
              file=sys.stderr)
        sys.exit(1)

    db = CameraDB(cfg.db_path)
    await db.connect()
    service = DiscoveryService(cfg, db)

    if args.once:
        added = await service.run_once()
        print(f"Scan complete — {added} new camera(s) added.")
        await db.close()
        return

    loop = asyncio.get_running_loop()

    def _shutdown(sig: signal.Signals) -> None:
        logging.getLogger('main').info("Received %s — shutting down…", sig.name)
        service.stop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _shutdown, sig)

    try:
        await service.run_forever()
    finally:
        await db.close()
        logging.getLogger('main').info("Discovery service stopped.")


def main() -> None:
    _setup_logging()

    parser = argparse.ArgumentParser(description='AuraSense ONVIF camera discovery service')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--once',  action='store_true', help='Run one scan cycle and exit')
    mode.add_argument('--list',  action='store_true', help='Print cameras in DB and exit')
    mode.add_argument('--probe', action='store_true',
                      help='Discover cameras without allowlist filter — use for first-time setup')
    mode.add_argument('--sync-time', metavar='HOST:PORT',
                      help='Push current UTC time to one camera via ONVIF and exit')
    args = parser.parse_args()

    if args.list:
        from config import Config
        asyncio.run(_cmd_list(Config().db_path))
        sys.exit(0)

    if args.probe:
        asyncio.run(_cmd_probe())
        sys.exit(0)

    if args.sync_time:
        asyncio.run(_cmd_sync_time(args.sync_time))
        sys.exit(0)

    asyncio.run(_cmd_run(args))


if __name__ == '__main__':
    main()
