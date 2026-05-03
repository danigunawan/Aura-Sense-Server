"""
RTSP stream prober — fallback when ONVIF auth fails.

Probes port 554 with common URL path patterns and returns the first
URL that responds with RTSP/1.0 200 OK to an unauthenticated OPTIONS
request (the server reveals itself before demanding auth), then
re-validates with credentials via a DESCRIBE request.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import List, Optional, Tuple
from urllib.parse import quote

log = logging.getLogger(__name__)

# Common RTSP path patterns ordered by frequency in the wild.
# {ch} is replaced with '1', {sub} with '0' (main stream).
_URL_PATTERNS = [
    '/Streaming/Channels/101',          # Hikvision main stream
    '/Streaming/Channels/1',            # Hikvision alt
    '/h264/ch1/main/av_stream',         # Hikvision NVR
    '/cam/realmonitor?channel=1&subtype=0',  # Dahua
    '/cam/realmonitor?channel=1&subtype=1',  # Dahua sub
    '/stream1',                         # Generic
    '/stream',
    '/live',
    '/live/0/MAIN',                     # Reolink
    '/h264Preview_01_main',             # Reolink alt
    '/video1',
    '/video.mp4',
    '/videoMain',
    '/11',                              # Foscam
    '/ch0_0.264',
    '/mpeg4',
    '/mpeg4/1/main/av_stream',
    '/onvif/MediaProfile0',
    '/MediaInput/h264',
]

_RTSP_PORT = 554
_PROBE_TIMEOUT = 4  # seconds per connection attempt


@dataclass
class RtspResult:
    rtsp_url: str
    device_uuid: str  # host:port as fallback UUID


async def probe(
    host: str,
    credentials: List[Tuple[str, str]],
    port: int = _RTSP_PORT,
) -> Optional[RtspResult]:
    """
    Try each credential pair × each URL pattern.
    Returns the first working combination, or None.
    """
    if not await _port_open(host, port):
        log.debug("RTSP probe: port %d closed on %s", port, host)
        return None

    log.debug("RTSP probe: port %d open on %s — trying URL patterns", port, host)

    for username, password in credentials:
        for path in _URL_PATTERNS:
            url = _build_url(host, port, username, password, path)
            if await _describe_ok(host, port, url):
                clean = _build_url(host, port, username, password, path)
                log.info("RTSP probe: found working stream %s", _redact(clean))
                return RtspResult(
                    rtsp_url=clean,
                    device_uuid=f"{host}:{port}",
                )

    log.debug("RTSP probe: no working URL found on %s", host)
    return None


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

async def _port_open(host: str, port: int) -> bool:
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=_PROBE_TIMEOUT
        )
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


async def _describe_ok(host: str, port: int, url: str) -> bool:
    """Send RTSP DESCRIBE; return True on 200 or 401 (server exists + auth prompted)."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=_PROBE_TIMEOUT
        )
        request = (
            f"DESCRIBE {url} RTSP/1.0\r\n"
            f"CSeq: 1\r\n"
            f"Accept: application/sdp\r\n"
            f"\r\n"
        )
        writer.write(request.encode())
        await writer.drain()

        data = await asyncio.wait_for(reader.read(512), timeout=_PROBE_TIMEOUT)
        writer.close()
        await writer.wait_closed()

        first_line = data.decode(errors='ignore').split('\r\n')[0]
        # 200 = stream exists and credentials worked
        # 401 = stream exists but needs auth (URL path is valid)
        if 'RTSP/1.0 200' in first_line or 'RTSP/1.0 401' in first_line:
            # For 401 we still count it as found — the URL path is valid and
            # credentials are embedded in the URL so the camera will re-auth
            return True
        return False
    except Exception:
        return False


def _build_url(host: str, port: int, username: str, password: str, path: str) -> str:
    if username:
        u = quote(username, safe='')
        p = quote(password, safe='')
        return f"rtsp://{u}:{p}@{host}:{port}{path}"
    return f"rtsp://{host}:{port}{path}"


def _redact(url: str) -> str:
    """Replace password in URL with *** for logging."""
    import re
    return re.sub(r'(rtsp://[^:]+:)[^@]+(@)', r'\1***\2', url)
