#!/usr/bin/env python3
"""
Entry point for the camera discovery service.

Usage:
    python main.py                  # continuous loop
    python main.py --once           # single scan then exit
    python main.py --list           # print DB contents and exit

Environment variables (see config.py for all options):
    DB_PATH               cameras.db
    DISCOVERY_INTERVAL    60          seconds between scans
    DISCOVERY_TIMEOUT     5.0         WS-Discovery listen window (seconds)
    ONVIF_TIMEOUT         10          per-request ONVIF timeout (seconds)
    MAX_RETRY_ATTEMPTS    3
    RETRY_BASE_DELAY      1.0
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
    # Silence noisy zeep/urllib internals unless DEBUG is set
    if level != 'DEBUG':
        for noisy in ('zeep', 'urllib3', 'asyncio'):
            logging.getLogger(noisy).setLevel(logging.WARNING)


async def _list_cameras(db_path: str) -> None:
    from database import CameraDB
    db = CameraDB(db_path)
    await db.connect()
    cameras = await db.get_all()
    await db.close()

    if not cameras:
        print("No cameras in database.")
        return

    fmt = "{:<4} {:<18} {:<20} {:<12} {:<15} {}"
    print(fmt.format("ID", "Name", "Model", "Status", "IP", "RTSP URL"))
    print("-" * 100)
    for cam in cameras:
        model = f"{cam.manufacturer} {cam.model}".strip() or "Unknown"
        print(fmt.format(cam.id, cam.name, model[:19], cam.status, cam.ip_address, cam.rtsp_url))


async def _run(args: argparse.Namespace) -> None:
    from config import Config
    from database import CameraDB
    from service import DiscoveryService

    cfg = Config()
    db  = CameraDB(cfg.db_path)
    await db.connect()

    service = DiscoveryService(cfg, db)

    if args.once:
        added = await service.run_once()
        print(f"Scan complete — {added} new camera(s) added.")
        await db.close()
        return

    # Register signal handlers for graceful shutdown
    loop = asyncio.get_running_loop()

    def _shutdown(sig: signal.Signals) -> None:
        logging.getLogger('main').info("Received %s — shutting down…", sig.name)
        service.stop()
        # Allow the run_forever coroutine to exit naturally on next iteration

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _shutdown, sig)

    try:
        await service.run_forever()
    finally:
        await db.close()
        logging.getLogger('main').info("Discovery service stopped.")


def main() -> None:
    _setup_logging()

    parser = argparse.ArgumentParser(description='ONVIF camera discovery service')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--once', action='store_true', help='Run one scan cycle and exit')
    mode.add_argument('--list', action='store_true', help='Print cameras in DB and exit')
    args = parser.parse_args()

    if args.list:
        from config import Config
        asyncio.run(_list_cameras(Config().db_path))
        sys.exit(0)

    asyncio.run(_run(args))


if __name__ == '__main__':
    main()
