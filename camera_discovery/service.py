"""
Camera discovery service — orchestrates scan → interrogate → persist → mediamtx sync.

Design: Prama-only closed system. No credential cycling, no RTSP probe fallback.
Cameras that don't match the allowed manufacturer are silently skipped (expected —
the local LAN may have non-Prama devices like routers, NAS, printers).
"""

import asyncio
import ipaddress
import logging
from typing import Optional

from config import Config
from database import CameraDB
from models import Camera, make_slug
import mediamtx_sync
import onvif_client
import subnet_scan
import wsdiscovery

log = logging.getLogger(__name__)


def _is_link_local(ip: str) -> bool:
    """RFC 3927 IPv4 link-local — 169.254.0.0/16."""
    return bool(ip) and ip.startswith("169.254.")


class DiscoveryService:
    def __init__(self, config: Config, db: CameraDB):
        self._cfg = config
        self._db  = db
        self._running = False
        # Serializes name/slug claim + initial upsert across concurrent
        # _process_device calls — without this, two cameras discovered in the
        # same cycle can read the same "used names" snapshot and both pick the
        # same default name (seen in production: two cameras both named
        # "Parking", which then collided as duplicate slugs in mediamtx.yml
        # and put mediamtx into a crash loop).
        self._assign_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def run_forever(self) -> None:
        """Continuous discovery loop. Runs until stop() is called."""
        self._running = True
        log.info("Discovery service started (interval=%ds)", self._cfg.discovery_interval)

        # Sync already-known cameras to mediamtx on startup (handles reboots).
        await self._sync_existing_to_mediamtx()

        while self._running:
            try:
                await self._run_cycle()
            except Exception as exc:
                log.error("Unexpected error in discovery cycle: %s", exc, exc_info=True)

            if self._running:
                log.info("Next scan in %ds", self._cfg.discovery_interval)
                await asyncio.sleep(self._cfg.discovery_interval)

    async def run_once(self) -> int:
        """Single scan cycle. Returns number of newly added cameras."""
        return await self._run_cycle()

    def stop(self) -> None:
        self._running = False

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _sync_existing_to_mediamtx(self) -> None:
        """Push all cameras already in DB to mediamtx at startup."""
        cameras = await self._db.get_online()
        if not cameras:
            return
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            mediamtx_sync.sync_all_cameras,
            cameras,
            self._cfg.mediamtx_api,
        )
        await loop.run_in_executor(
            None,
            mediamtx_sync.regenerate_yml,
            cameras,
            self._cfg.mediamtx_base_yml,
            self._cfg.mediamtx_yml,
        )

    async def _run_cycle(self) -> int:
        log.info("Starting discovery cycle (WS-Discovery + subnet sweep)…")

        # Run multicast WSD and subnet sweep concurrently.
        wsd_task   = wsdiscovery.scan(timeout=self._cfg.discovery_timeout)
        sweep_task = subnet_scan.scan(timeout=self._cfg.discovery_timeout)
        wsd_results, sweep_results = await asyncio.gather(wsd_task, sweep_task)

        # Dedupe by IP — WSD result wins (it carries proper endpoint UUID).
        by_ip = {d.ip_address: d for d in sweep_results}
        for d in wsd_results:
            by_ip[d.ip_address] = d
        devices = list(by_ip.values())

        log.info(
            "Discovery cycle: WSD=%d sweep=%d merged=%d",
            len(wsd_results), len(sweep_results), len(devices),
        )

        if not devices:
            log.info("No ONVIF devices found on the network")
            return 0

        tasks = [self._process_device(dev) for dev in devices]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        added  = sum(1 for r in results if r is True)
        errors = sum(1 for r in results if isinstance(r, Exception))

        log.info(
            "Scan complete — %d device(s) probed, %d new camera(s) added, %d error(s)",
            len(devices), added, errors,
        )

        # Regenerate YAML every cycle that found devices — runtime API and YAML
        # can diverge whenever a camera's IP changes (e.g. link-local→static
        # via reassert), and the comment above used to say "every cycle" but
        # the `added > 0` guard meant existing-camera updates never rewrote
        # the file. On the next mediamtx restart it'd reload stale URLs.
        cameras = await self._db.get_online()
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            mediamtx_sync.regenerate_yml,
            cameras,
            self._cfg.mediamtx_base_yml,
            self._cfg.mediamtx_yml,
        )

        return added

    async def _process_device(self, device) -> bool:
        """
        Interrogate one device and upsert into DB.
        Returns True if the camera was newly inserted.
        """
        from wsdiscovery import best_device_url
        host, port, url = best_device_url(device)

        log.info("Interrogating %s …", host)

        try:
            info = await onvif_client.interrogate(
                device               = device,
                username             = self._cfg.onvif_user,
                password             = self._cfg.onvif_pass,
                rtsp_user            = self._cfg.rtsp_user,
                rtsp_pass            = self._cfg.rtsp_pass,
                allowed_manufacturer = self._cfg.allowed_manufacturer,
                allowed_models       = self._cfg.allowed_models,
                timeout              = self._cfg.onvif_timeout,
                max_attempts         = self._cfg.max_retry_attempts,
                base_delay           = self._cfg.retry_base_delay,
                backoff              = self._cfg.retry_backoff,
                auto_configure_gop   = self._cfg.auto_configure_gop,
            )
        except onvif_client.CameraRejected as exc:
            # Camera fails the manufacturer/model allowlist. On the isolated cam segment
            # this is genuinely unexpected — log at INFO so the operator notices when a
            # newly-deployed camera ships with firmware reporting a different
            # Manufacturer string than the allowlist permits.
            log.info("Skipping %s: %s", host, exc)
            return False

        if info is None:
            msg = "ONVIF authentication failed — check CAMERA_ONVIF_USER / CAMERA_ONVIF_PASS"
            log.warning("%s: %s", host, msg)
            await self._db.log_event('auth_failed', msg, ip_address=host)
            return False

        # Serialize name/slug claim + DB publish so concurrent _process_device
        # calls in the same cycle never read the same "used names" set and
        # both pick the same default. Lock is held for DB ops only (~ms);
        # ONVIF interrogation above stays parallel.
        async with self._assign_lock:
            name = await self._assign_name(info.device_uuid)
            slug = await self._assign_slug(info.device_uuid, name)

            # Snapshot the prior row before any upsert — we need the camera's
            # last-known good IP to recover it from link-local fallback.
            prior = await self._db.get_by_uuid(info.device_uuid)
            prior_good_ip = (
                prior.ip_address
                if prior and prior.ip_address and not _is_link_local(prior.ip_address)
                else None
            )

            # Recovery short-circuit: camera fell back to link-local but we know
            # its prior good IP. Push that IP back via ONVIF and skip the rest of
            # this cycle. Do NOT upsert the link-local host into the DB — that
            # would clobber prior_good_ip and break retry on the next cycle if
            # this reassert call fails. Do NOT sync mediamtx either — any URL we'd
            # push would be link-local and become stale the moment the camera
            # reboots onto the target IP. The next discovery cycle will see the
            # camera at its restored address and upsert normally there.
            if _is_link_local(device.ip_address) and prior_good_ip and prior is not None:
                log.info(
                    "Camera '%s' on link-local %s — re-asserting prior %s; skipping DB/mediamtx until camera reboots",
                    prior.name, device.ip_address, prior_good_ip,
                )
                await self._reassert_ip(prior, device.ip_address, prior_good_ip)
                return False

            camera = Camera(
                device_uuid       = info.device_uuid,
                ip_address        = device.ip_address,
                port              = port,
                device_url        = url,
                manufacturer      = info.manufacturer,
                model             = info.model,
                serial_number     = info.serial_number,
                firmware_version  = info.firmware_version,
                rtsp_url          = info.rtsp_url,
                sub_rtsp_url      = info.sub_rtsp_url,
                profile_token     = info.profile_token,
                sub_profile_token = info.sub_profile_token,
                slug              = slug,
                name              = name,
                status            = 'online',
            )

            is_new = await self._db.upsert_camera(camera)

        if is_new:
            log.info(
                "NEW camera '%s' added — %s %s @ %s (slug: %s)",
                name, info.manufacturer, info.model, host, slug,
            )
            await self._db.log_event(
                'camera_added',
                f"Added '{name}' — {info.manufacturer} {info.model} @ {host}",
                camera_uuid = info.device_uuid,
                ip_address  = host,
            )
        else:
            log.info("Updated existing camera '%s' @ %s", name, host)

        # New camera with no prior IP — fall through to the pool flow if it's enabled.
        if is_new and self._cfg.static_ip_enabled:
            await self._assign_static_ip(camera, host)

        # Hot-add paths to running mediamtx (non-blocking, failures tolerated).
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            mediamtx_sync.sync_camera,
            camera,
            self._cfg.mediamtx_api,
        )

        return is_new

    async def _reassert_ip(self, camera: Camera, current_host: str, target_ip: str) -> None:
        """
        Push `target_ip` back onto a camera that's currently on a link-local
        address. Uses the camera's last-known prior IP — stable across the
        rest of the system (same slug, same recording history).
        """
        cfg = self._cfg
        # Gateway defaults to this host's camera-NIC IP (DISCOVERY_INTERFACE)
        # when the static-IP pool config isn't explicitly set for this deploy.
        import os as _os
        gateway = cfg.static_ip_gateway
        if gateway == '192.168.1.1':  # unconfigured default
            gateway = _os.getenv('DISCOVERY_INTERFACE', '').strip() or gateway

        log.info(
            "Re-asserting prior IP %s on camera '%s' (currently link-local %s, gw=%s)",
            target_ip, camera.name, current_host, gateway,
        )
        try:
            await onvif_client.set_static_ip(
                host       = current_host,
                port       = camera.port,
                username   = cfg.onvif_user,
                password   = cfg.onvif_pass,
                static_ip  = target_ip,
                prefix_len = cfg.static_ip_prefix,
                gateway    = gateway,
                dns        = cfg.static_ip_dns,
                timeout    = cfg.onvif_timeout,
            )
            await self._db.update_static_ip(camera.device_uuid, target_ip)
            await self._db.log_event(
                'static_ip_reasserted',
                f"Re-asserted {target_ip} on '{camera.name}' (was on link-local {current_host})",
                camera_uuid = camera.device_uuid,
                ip_address  = current_host,
            )
        except Exception as exc:
            log.error(
                "Failed to re-assert IP %s on camera '%s' @ %s: %s",
                target_ip, camera.name, current_host, exc,
            )

    async def _assign_name(self, device_uuid: str) -> str:
        existing = await self._db.get_by_uuid(device_uuid)
        if existing:
            return existing.name

        used  = set(await self._db.get_used_names())
        for candidate in self._cfg.default_names:
            if candidate not in used:
                return candidate

        n = len(used) + 1
        while f"Camera-{n}" in used:
            n += 1
        return f"Camera-{n}"

    async def _assign_static_ip(self, camera: Camera, current_host: str) -> None:
        """
        Pick the next free IP from the pool and push it to the camera via ONVIF.
        Stores the reserved IP in the DB immediately so concurrent assignments
        don't collide.  The camera reboots; the next scan cycle re-discovers it
        at the new address.
        """
        cfg = self._cfg
        try:
            static_ip = await self._next_free_ip()
        except ValueError as exc:
            log.error("Static IP pool exhausted: %s", exc)
            return

        # Reserve in DB before the ONVIF call so parallel assignments don't clash.
        await self._db.update_static_ip(camera.device_uuid, static_ip)

        log.info(
            "Assigning static IP %s/%d (gw=%s) to camera '%s' @ %s",
            static_ip, cfg.static_ip_prefix, cfg.static_ip_gateway,
            camera.name, current_host,
        )
        try:
            await onvif_client.set_static_ip(
                host       = current_host,
                port       = camera.port,
                username   = cfg.onvif_user,
                password   = cfg.onvif_pass,
                static_ip  = static_ip,
                prefix_len = cfg.static_ip_prefix,
                gateway    = cfg.static_ip_gateway,
                dns        = cfg.static_ip_dns,
                timeout    = cfg.onvif_timeout,
            )
            await self._db.log_event(
                'static_ip_assigned',
                f"Assigned static IP {static_ip} to '{camera.name}' (was {current_host})",
                camera_uuid = camera.device_uuid,
                ip_address  = current_host,
            )
        except Exception as exc:
            log.error(
                "Failed to set static IP on camera '%s' @ %s: %s",
                camera.name, current_host, exc,
            )
            # Release the reservation so it can be retried next cycle.
            await self._db.update_static_ip(camera.device_uuid, None)

    async def _next_free_ip(self) -> str:
        """Return the lowest IP in the pool not already assigned in the DB."""
        start  = ipaddress.IPv4Address(self._cfg.static_ip_start)
        end    = ipaddress.IPv4Address(self._cfg.static_ip_end)
        in_use = set(await self._db.get_assigned_static_ips())

        ip = start
        while ip <= end:
            candidate = str(ip)
            if candidate not in in_use:
                return candidate
            ip += 1

        raise ValueError(
            f"All IPs in pool {self._cfg.static_ip_start}–{self._cfg.static_ip_end} are taken"
        )

    async def _assign_slug(self, device_uuid: str, name: str) -> str:
        existing = await self._db.get_by_uuid(device_uuid)
        if existing and existing.slug:
            return existing.slug   # slug is immutable once assigned

        base = make_slug(name)
        used = set(await self._db.get_used_slugs())
        if base not in used:
            return base

        # Collision (two cameras with the same name) — append a number.
        n = 2
        while f"{base}-{n}" in used:
            n += 1
        return f"{base}-{n}"
