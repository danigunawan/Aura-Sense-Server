import os
from dotenv import load_dotenv

load_dotenv()


class _Config:
    port:                    int  = int(os.getenv('PORT', '8000'))
    db_path:                 str  = os.getenv('DB_PATH', '../camera_discovery/cameras.db')
    app_secret:              str  = os.getenv('APP_SECRET', 'dev-app-secret-change-in-prod')
    app_token_expiry_hours:  int  = int(os.getenv('APP_TOKEN_EXPIRY_HOURS', '24'))
    signaling_jwt_secret:    str  = os.getenv('SIGNALING_JWT_SECRET', 'dev-signaling-secret')
    signaling_url:           str  = os.getenv('SIGNALING_URL', 'wss://localhost:8080/signal')
    nvr_device_id:           str  = os.getenv('NVR_DEVICE_ID', 'nvr-001')
    redis_url:               str  = os.getenv('REDIS_URL', 'redis://localhost:6379')
    recordings_path:         str  = os.getenv('RECORDINGS_PATH', '/recordings')
    stream_session_ttl:      int  = int(os.getenv('STREAM_SESSION_TTL', '7200'))
    mediamtx_url:            str  = os.getenv('MEDIAMTX_URL', 'http://localhost:8889')
    mediamtx_hls_url:        str  = os.getenv('MEDIAMTX_HLS_URL', 'http://localhost:8888')
    log_level:               str  = os.getenv('LOG_LEVEL', 'info')
    # TURN server — optional; if unset, STUN-only (fine for dual-stack IPv6 networks)
    turn_url:                str  = os.getenv('TURN_URL', '')
    turn_username:           str  = os.getenv('TURN_USERNAME', '')
    turn_credential:         str  = os.getenv('TURN_CREDENTIAL', '')


config = _Config()
