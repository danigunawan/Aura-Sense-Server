from dataclasses import dataclass, field
from typing import List
import os


@dataclass
class Config:
    # Discovery timing
    discovery_interval: int   = int(os.getenv('DISCOVERY_INTERVAL', '60'))
    discovery_timeout: float  = float(os.getenv('DISCOVERY_TIMEOUT', '5.0'))
    onvif_timeout: int        = int(os.getenv('ONVIF_TIMEOUT', '10'))

    # Retry
    max_retry_attempts: int   = int(os.getenv('MAX_RETRY_ATTEMPTS', '3'))
    retry_base_delay: float   = float(os.getenv('RETRY_BASE_DELAY', '1.0'))
    retry_backoff: float      = float(os.getenv('RETRY_BACKOFF', '2.0'))

    # Storage
    db_path: str              = os.getenv('DB_PATH', 'cameras.db')

    # Single credential pair — all Prama cameras are pre-configured to these values.
    # Set via environment or .env file; never hardcode here.
    onvif_user: str           = os.getenv('CAMERA_ONVIF_USER', 'admin')
    onvif_pass: str           = os.getenv('CAMERA_ONVIF_PASS', '')
    rtsp_user: str            = os.getenv('CAMERA_RTSP_USER', 'admin')
    rtsp_pass: str            = os.getenv('CAMERA_RTSP_PASS', '')

    # Manufacturer allowlist (case-insensitive prefix match).
    # Prama cameras may report "Prama", "Uniview", or "Hikvision" depending on OEM batch.
    # Run `python main.py --probe` to discover what your cameras actually report.
    # Set to empty string '' to accept any manufacturer (useful for first-time probing only).
    allowed_manufacturer: str = os.getenv('CAMERA_ALLOWED_MANUFACTURER', 'Prama')

    # Optional model substring allowlist — comma-separated, case-insensitive.
    # Leave empty to accept all models from the allowed manufacturer.
    # Example: CAMERA_ALLOWED_MODELS=2MP Bullet,2MP Dome,4MP Bullet,4MP Dome
    allowed_models: List[str] = field(default_factory=lambda: [
        m.strip() for m in os.getenv('CAMERA_ALLOWED_MODELS', '').split(',') if m.strip()
    ])

    # mediamtx integration — discovery regenerates the YAML and hot-adds paths via API.
    mediamtx_api: str         = os.getenv('MEDIAMTX_API', 'http://127.0.0.1:9997')
    mediamtx_base_yml: str    = os.getenv(
        'MEDIAMTX_BASE_YML',
        '/home/aura/Documents/aurasense/mediamtx-conf/mediamtx-base.yml',
    )
    mediamtx_yml: str         = os.getenv(
        'MEDIAMTX_YML',
        '/home/aura/Documents/aurasense/mediamtx-conf/mediamtx.yml',
    )

    # Set GOP length on newly discovered cameras via ONVIF for sub-second WebRTC start.
    # Value is frames (25 = 1 s at 25 fps). Set to 0 to skip auto-configuration.
    auto_configure_gop: int   = int(os.getenv('CAMERA_AUTO_CONFIGURE_GOP', '25'))

    default_names: List[str] = field(default_factory=lambda: [
        'Entrance', 'Parking', 'Lobby', 'Hallway',
        'Stairwell', 'Rooftop', 'Perimeter', 'Loading Dock',
        'Server Room', 'Reception', 'Emergency Exit', 'Garage',
        'Side Gate', 'Warehouse', 'Office', 'Corridor',
    ])
