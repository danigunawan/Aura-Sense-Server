import re
from dataclasses import dataclass
from datetime import datetime
from typing import Optional


def make_slug(name: str) -> str:
    """Stable, URL-safe slug for mediamtx path names and recording directories."""
    return re.sub(r'[^a-z0-9-]', '', name.lower().replace(' ', '-'))


@dataclass
class DiscoveredDevice:
    """Raw result from WS-Discovery before ONVIF interrogation."""
    endpoint: str       # urn:uuid:...
    xaddrs: list[str]   # ONVIF device service URLs
    ip_address: str     # source IP from probe response


@dataclass
class Camera:
    device_uuid: str
    ip_address: str
    port: int
    device_url: str
    manufacturer: str
    model: str
    serial_number: str
    firmware_version: str
    rtsp_url: str           # H264 main stream — live view, WebRTC
    sub_rtsp_url: str       # H265 sub stream  — recording, zero transcode
    profile_token: str      # main stream ONVIF profile token
    sub_profile_token: str  # sub stream ONVIF profile token
    slug: str               # mediamtx path name, e.g. "entrance"
    name: str               # human-readable label
    status: str
    static_ip: Optional[str]       = None  # assigned static IP, None if still on DHCP
    tls_fingerprint: Optional[str] = None  # SHA-256 cert fingerprint if camera uses RTSPS
    created_at: Optional[datetime] = None
    last_seen: Optional[datetime]  = None
    last_error: Optional[str]      = None
    id: Optional[int]              = None
