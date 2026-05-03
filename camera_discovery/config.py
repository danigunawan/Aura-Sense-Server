from dataclasses import dataclass, field
from typing import List, Tuple
import os


@dataclass
class Config:
    # Discovery
    discovery_interval: int   = int(os.getenv('DISCOVERY_INTERVAL', '60'))
    discovery_timeout: float  = float(os.getenv('DISCOVERY_TIMEOUT', '5.0'))
    onvif_timeout: int        = int(os.getenv('ONVIF_TIMEOUT', '10'))

    # Retry
    max_retry_attempts: int   = int(os.getenv('MAX_RETRY_ATTEMPTS', '3'))
    retry_base_delay: float   = float(os.getenv('RETRY_BASE_DELAY', '1.0'))
    retry_backoff: float      = float(os.getenv('RETRY_BACKOFF', '2.0'))

    # Storage
    db_path: str              = os.getenv('DB_PATH', 'cameras.db')

    # Credentials tried in order against each discovered camera
    credentials: List[Tuple[str, str]] = field(default_factory=lambda: [
        ('admin', 'Reset@123'),
        ('admin', 'admin'),
        ('admin', 'Ashwani7*'),
        ('admin', 'Emerald98260**7'),
        ('admin', ''),
        ('root', 'root'),
        ('', ''),
    ])

    default_names: List[str] = field(default_factory=lambda: [
        'Entrance', 'Parking', 'Lobby', 'Hallway',
        'Stairwell', 'Rooftop', 'Perimeter', 'Loading Dock',
        'Server Room', 'Reception', 'Emergency Exit', 'Garage',
        'Side Gate', 'Warehouse', 'Office', 'Corridor',
    ])
