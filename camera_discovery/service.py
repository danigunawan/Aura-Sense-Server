"""
Camera discovery service — orchestrates scan → interrogate → persist → mediamtx sync.

Design: Prama-only closed system. No credential cycling, no RTSP probe fallback.
Cameras that don't match the allowed manufacturer are silently skipped (expected —
the local LAN may have non-Prama devices like routers, NAS, printers).
"""

import asyncio
import logging
from typing import Optional

from config import Config
from database import CameraDB
from models import Camera, make_slug
import mediamtx_sync
import onvif_client
import wsdiscovery

log = logging.getLogger(__name__)


class DiscoveryService:
    def __init__(self, config: Config, db: CameraDB):
        self._cfg = config
        self._db  = db
        self._running = False

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
        log.info("Starting WS-Discovery scan…")
        devices = await wsdiscovery.scan(timeout=self._cfg.discovery_timeout)

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

        # Regenerate YAML after every cycle so restarts pick up any changes.
        if added > 0:
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
            # Not a Prama camera — expected on any LAN. Log at DEBUG to avoid noise.
            log.debug("Skipping %s: %s", host, exc)
            return False

        if info is None:
            msg = "ONVIF authentication failed — check CAMERA_ONVIF_USER / CAMERA_ONVIF_PASS"
            log.warning("%s: %s", host, msg)
            await self._db.log_event('auth_failed', msg, ip_address=host)
            return False

        name = await self._assign_name(info.device_uuid)
        slug = await self._assign_slug(info.device_uuid, name)

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

        # Hot-add paths to running mediamtx (non-blocking, failures tolerated).
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            mediamtx_sync.sync_camera,
            camera,
            self._cfg.mediamtx_api,
        )

        return is_new

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
