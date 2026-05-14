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


async def _cmd_push_addressing(camera_id: int) -> None:
    """
    Push a static IP from the configured pool onto one camera (by DB id) via
    ONVIF SetNetworkInterfaces, then reboot it. Idempotent: if a static IP was
    already reserved for this camera, it gets re-asserted; otherwise the next
    free IP in CAMERA_STATIC_IP_POOL_* is allocated and recorded in the DB.

    Intended for the Settings → Cameras admin button, used to drag a camera
    that's stuck on 169.254/16 link-local back onto the camera subnet.
    """
    import ipaddress
    from config import Config
    from database import CameraDB
    import onvif_client

    cfg = Config()
    if not cfg.onvif_pass:
        print("ERROR: CAMERA_ONVIF_PASS not set.", file=sys.stderr)
        sys.exit(1)

    db = CameraDB(cfg.db_path)
    await db.connect()
    try:
        async with db._db.execute(
            "SELECT device_uuid, ip_address, port, name, static_ip "
            "FROM cameras WHERE id = ?",
            (camera_id,),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            print(f"ERROR: camera id {camera_id} not found", file=sys.stderr)
            sys.exit(1)

        current_host  = row['ip_address']
        port          = row['port']
        device_uuid   = row['device_uuid']
        name          = row['name']
        prior_static  = row['static_ip']

        if prior_static:
            # Reassert what was already reserved — idempotent retry.
            target_ip = prior_static
            allocated_now = False
            print(f"Re-asserting saved static {target_ip} on '{name}' @ {current_host}")
        else:
            start  = ipaddress.IPv4Address(cfg.static_ip_start)
            end    = ipaddress.IPv4Address(cfg.static_ip_end)
            in_use = set(await db.get_assigned_static_ips())
            target_ip = None
            ip = start
            while ip <= end:
                cand = str(ip)
                if cand not in in_use:
                    target_ip = cand
                    break
                ip += 1
            if target_ip is None:
                print(
                    f"ERROR: pool {cfg.static_ip_start}–{cfg.static_ip_end} exhausted "
                    f"(reserve more or reclaim unused)",
                    file=sys.stderr,
                )
                sys.exit(1)
            # Reserve before the ONVIF call so concurrent pushes don't collide.
            await db.update_static_ip(device_uuid, target_ip)
            allocated_now = True
            print(f"Allocated {target_ip} for '{name}' @ {current_host}")

        # Same gateway-fallback rule as service._reassert_ip: when the pool
        # config wasn't customised (still 192.168.1.1), fall back to the NVR's
        # camera-NIC IP so we don't push an unreachable gateway onto cameras.
        gateway = cfg.static_ip_gateway
        if gateway == '192.168.1.1':
            gateway = os.getenv('DISCOVERY_INTERFACE', '').strip() or gateway

        try:
            await onvif_client.set_static_ip(
                host       = current_host,
                port       = port,
                username   = cfg.onvif_user,
                password   = cfg.onvif_pass,
                static_ip  = target_ip,
                prefix_len = cfg.static_ip_prefix,
                gateway    = gateway,
                dns        = cfg.static_ip_dns,
                timeout    = cfg.onvif_timeout,
            )
        except Exception as exc:
            # Only release a reservation we made *this* call — leaving a prior
            # reservation in place lets the next retry reuse the same IP.
            if allocated_now:
                await db.update_static_ip(device_uuid, None)
            print(f"ERROR: ONVIF set_static_ip on {current_host}: {exc}", file=sys.stderr)
            sys.exit(1)

        await db.log_event(
            'static_ip_pushed',
            f"Pushed static IP {target_ip} to '{name}' (was {current_host}) via admin action",
            camera_uuid = device_uuid,
            ip_address  = current_host,
        )
        print(
            f"OK: pushed {target_ip}/{cfg.static_ip_prefix} (gw {gateway}) to '{name}'. "
            f"Camera is rebooting; it will reappear at the new address within ~60 s."
        )
    finally:
        await db.close()


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
    mode.add_argument('--push-addressing', metavar='CAMERA_ID', type=int,
                      help='Push a static IP from the pool to one camera (by DB id) and exit')
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

    if args.push_addressing is not None:
        asyncio.run(_cmd_push_addressing(args.push_addressing))
        sys.exit(0)

    asyncio.run(_cmd_run(args))


if __name__ == '__main__':
    main()
