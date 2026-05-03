"""
Camera discovery service — orchestrates scan → interrogate → persist.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from config import Config
from database import CameraDB
from models import Camera, DiscoveredDevice
import onvif_client
import rtsp_probe
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

    async def _run_cycle(self) -> int:
        log.info("Starting WS-Discovery scan…")
        devices = await wsdiscovery.scan(timeout=self._cfg.discovery_timeout)

        if not devices:
            log.info("No ONVIF devices found on this network segment")
            return 0

        # Fan-out: interrogate all devices concurrently
        tasks = [self._process_device(dev) for dev in devices]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        added = sum(1 for r in results if r is True)
        errors = sum(1 for r in results if isinstance(r, Exception))

        log.info("Scan complete — %d device(s) found, %d new, %d error(s)",
                 len(devices), added, errors)
        return added

    async def _process_device(self, device: DiscoveredDevice) -> bool:
        """
        Interrogate one device and upsert into DB.
        Returns True if the camera was newly inserted.
        Raises on unrecoverable error.
        """
        from wsdiscovery import best_device_url
        host, port, url = best_device_url(device)

        log.info("Interrogating %s …", host)

        info = await onvif_client.interrogate(
            device       = device,
            credentials  = self._cfg.credentials,
            timeout      = self._cfg.onvif_timeout,
            max_attempts = self._cfg.max_retry_attempts,
            base_delay   = self._cfg.retry_base_delay,
            backoff      = self._cfg.retry_backoff,
        )

        if info is None:
            log.warning("%s: ONVIF auth failed — falling back to RTSP probe", host)
            rtsp_result = await rtsp_probe.probe(host, self._cfg.credentials)

            if rtsp_result is None:
                msg = "Authentication failed for all credential pairs (ONVIF + RTSP)"
                log.warning("%s: %s", host, msg)
                await self._db.log_event('auth_failed', msg, ip_address=host)
                return False

            # Build a minimal Camera record from the RTSP probe result
            name = await self._assign_name(rtsp_result.device_uuid)
            camera = Camera(
                device_uuid      = rtsp_result.device_uuid,
                ip_address       = device.ip_address,
                port             = 554,
                device_url       = url,
                manufacturer     = '',
                model            = '',
                serial_number    = '',
                firmware_version = '',
                rtsp_url         = rtsp_result.rtsp_url,
                profile_token    = '',
                name             = name,
                username         = '',
                status           = 'online',
            )
            is_new = await self._db.upsert_camera(camera)
            if is_new:
                log.info("NEW camera added via RTSP probe: '%s' at %s", name, host)
                await self._db.log_event(
                    'camera_added',
                    f"Added '{name}' via RTSP probe @ {rtsp_result.rtsp_url.split('@')[-1]}",
                    camera_uuid = rtsp_result.device_uuid,
                    ip_address  = host,
                )
            return is_new

        name = await self._assign_name(info.device_uuid)

        camera = Camera(
            device_uuid      = info.device_uuid,
            ip_address       = device.ip_address,
            port             = port,
            device_url       = url,
            manufacturer     = info.manufacturer,
            model            = info.model,
            serial_number    = info.serial_number,
            firmware_version = info.firmware_version,
            rtsp_url         = info.rtsp_url,
            profile_token    = info.profile_token,
            name             = name,
            username         = info.username,
            status           = 'online',
        )

        is_new = await self._db.upsert_camera(camera)

        if is_new:
            log.info("NEW camera added: '%s' (%s) at %s", name, info.model or 'Unknown', host)
            await self._db.log_event(
                'camera_added',
                f"Added '{name}' — {info.manufacturer} {info.model} @ rtsp://{host}",
                camera_uuid = info.device_uuid,
                ip_address  = host,
            )
        else:
            log.info("Updated existing camera '%s' at %s", name, host)

        return is_new

    async def _assign_name(self, device_uuid: str) -> str:
        """
        Return the camera's existing name if it's already in the DB,
        otherwise pick the next unused default name, or fall back to Camera-N.
        """
        existing = await self._db.get_by_uuid(device_uuid)
        if existing:
            return existing.name

        used  = set(await self._db.get_used_names())
        names = self._cfg.default_names

        for candidate in names:
            if candidate not in used:
                return candidate

        # All default names taken — generate a numbered fallback
        n = len(used) + 1
        while f"Camera-{n}" in used:
            n += 1
        return f"Camera-{n}"
