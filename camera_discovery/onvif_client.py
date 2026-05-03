"""
ONVIF camera interrogation.

All onvif-zeep calls are synchronous (zeep uses requests under the hood),
so every public function here runs inside a ThreadPoolExecutor.
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import List, Optional, Tuple
from urllib.parse import urlparse, urlunparse

import ssl
import urllib3
import requests
from requests.adapters import HTTPAdapter

import onvif
from onvif import ONVIFCamera
from onvif.exceptions import ONVIFError
from zeep.transports import Transport

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class _LaxSSLAdapter(HTTPAdapter):
    """Allows legacy cipher suites and rewrites http://host:443 → https://host:443."""
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.set_ciphers('DEFAULT:@SECLEVEL=0')
        kwargs['ssl_context'] = ctx
        return super().init_poolmanager(*args, **kwargs)

    def send(self, request, **kwargs):
        # onvif-zeep builds http://host:443/... — rewrite to https before sending
        if request.url.startswith('http://') and ':443/' in request.url:
            request.url = request.url.replace('http://', 'https://', 1)
        kwargs['verify'] = False
        return super().send(request, **kwargs)

from models import DiscoveredDevice
from retry import sync_retry

log = logging.getLogger(__name__)

_WSDL_DIR = os.path.join(os.path.dirname(os.path.dirname(onvif.__file__)), 'wsdl')
_EXECUTOR  = ThreadPoolExecutor(max_workers=16, thread_name_prefix='onvif')


@dataclass
class CameraInfo:
    device_uuid: str
    manufacturer: str
    model: str
    serial_number: str
    firmware_version: str
    rtsp_url: str
    profile_token: str
    username: str


async def interrogate(
    device: DiscoveredDevice,
    credentials: List[Tuple[str, str]],
    timeout: int = 10,
    max_attempts: int = 3,
    base_delay: float = 1.0,
    backoff: float = 2.0,
) -> Optional[CameraInfo]:
    """
    Try each credential pair against the device. Returns None if all fail.
    Runs blocking ONVIF calls in a thread executor.
    """
    from wsdiscovery import best_device_url
    host, port, url = best_device_url(device)

    loop = asyncio.get_running_loop()

    for username, password in credentials:
        try:
            info = await loop.run_in_executor(
                _EXECUTOR,
                _interrogate_sync,
                host, port, username, password, url,
                timeout, max_attempts, base_delay, backoff,
            )
            log.info("Authenticated %s as '%s'", host, username or '<empty>')
            return info
        except ONVIFError as exc:
            log.debug("Credential ('%s','%s') rejected by %s: %s", username, password, host, exc)
        except Exception as exc:
            log.debug("Failed to interrogate %s with ('%s','%s'): %s", host, username, password, exc)

    log.warning("All credentials exhausted for %s", host)
    return None


# -----------------------------------------------------------------------
# Blocking helpers (run inside executor threads)
# -----------------------------------------------------------------------

def _interrogate_sync(
    host: str,
    port: int,
    username: str,
    password: str,
    device_url: str,
    timeout: int,
    max_attempts: int,
    base_delay: float,
    backoff: float,
) -> CameraInfo:
    """Connect to a camera, gather device info and one RTSP URL."""

    session = requests.Session()
    session.verify = False
    adapter = _LaxSSLAdapter()
    session.mount('https://', adapter)
    session.mount('http://', adapter)   # catches http://host:443 before rewrite
    _transport = Transport(timeout=timeout, operation_timeout=timeout, session=session)

    @sync_retry(max_attempts=max_attempts, base_delay=base_delay, backoff=backoff,
                exceptions=(Exception,))
    def _connect() -> ONVIFCamera:
        return ONVIFCamera(host, port, username, password, _WSDL_DIR,
                           transport=_transport)

    cam = _connect()

    # --- Device info ---
    dev_info = cam.devicemgmt.GetDeviceInformation()

    # Stable UUID from endpoint reference; fall back to serial
    uuid_raw = _extract_uuid(device_url) or dev_info.SerialNumber or f"{host}:{port}"

    # --- Media profiles ---
    media      = cam.create_media_service()
    profiles   = media.GetProfiles()
    if not profiles:
        raise ONVIFError(f"No media profiles on {host}")

    # Prefer the first main-stream profile (typically highest resolution)
    profile       = profiles[0]
    profile_token = profile.token

    # --- RTSP stream URI ---
    stream_req = media.create_type('GetStreamUri')
    stream_req.StreamSetup = {
        'Stream': 'RTP-Unicast',
        'Transport': {'Protocol': 'RTSP'},
    }
    stream_req.ProfileToken = profile_token
    stream_uri = media.GetStreamUri(stream_req)
    rtsp_url   = _embed_credentials(stream_uri.Uri, username, password)

    return CameraInfo(
        device_uuid    = uuid_raw,
        manufacturer   = getattr(dev_info, 'Manufacturer', '') or '',
        model          = getattr(dev_info, 'Model', '') or '',
        serial_number  = getattr(dev_info, 'SerialNumber', '') or '',
        firmware_version = getattr(dev_info, 'FirmwareVersion', '') or '',
        rtsp_url       = rtsp_url,
        profile_token  = profile_token,
        username       = username,
    )


def _extract_uuid(text: str) -> Optional[str]:
    """Pull the uuid:... portion from an endpoint reference or XAddr."""
    import re
    m = re.search(r'uuid:([a-fA-F0-9\-]{32,})', text)
    return m.group(1) if m else None


def _embed_credentials(rtsp_url: str, username: str, password: str) -> str:
    """Return rtsp://user:pass@host:port/path. Skips if no credentials."""
    if not username:
        return rtsp_url
    parsed   = urlparse(rtsp_url)
    netloc   = f"{username}:{password}@{parsed.hostname}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))
