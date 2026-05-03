from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass
class DiscoveredDevice:
    """Raw result from WS-Discovery before ONVIF interrogation."""
    endpoint: str          # urn:uuid:...
    xaddrs: list[str]      # device service URLs
    ip_address: str        # source IP of the probe response


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
    rtsp_url: str
    profile_token: str
    name: str
    username: str
    status: str
    created_at: Optional[datetime] = None
    last_seen: Optional[datetime]  = None
    last_error: Optional[str]      = None
    id: Optional[int]              = None
