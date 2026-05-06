from __future__ import annotations
from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field


# ── Auth ─────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type:   str = "bearer"
    expires_in:   int              # seconds

class CreateUserRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8)
    role:     Literal["admin", "viewer"] = "viewer"


# ── Cameras ──────────────────────────────────────────────────────────────────

class CameraResponse(BaseModel):
    id:           int
    name:         str
    ip_address:   str
    manufacturer: str
    model:        str
    status:       Literal["online", "offline", "error"]
    last_seen:    datetime
    model_config  = {"from_attributes": True}

class CameraDetailResponse(CameraResponse):
    port:             int
    serial_number:    str
    firmware_version: str
    # rtsp_url omitted — never expose raw RTSP credentials to clients

class CameraListResponse(BaseModel):
    items:    list[CameraResponse]
    total:    int
    page:     int
    limit:    int
    has_more: bool


# ── Live streams ──────────────────────────────────────────────────────────────

class StreamUrlsResponse(BaseModel):
    camera_id:   int
    name:        str
    webrtc_url:  str        # WHEP endpoint for WebRTC playback
    hls_url:     str        # HLS fallback
    rtsp_url:    str        # for VLC / NVR client / recording service
    stream_key:  str        # path name on mediamtx (e.g. "entrance")
    ice_servers: list[dict] = []  # RTCIceServer objects for Android RTCConfiguration

class StreamResponse(BaseModel):
    session_id:    str            # ephemeral viewer device ID
    signaling_url: str            # WSS URL to connect to
    token:         str            # JWT to authenticate with signaling server
    nvr_device_id: str            # pass as nvrId in request-stream message
    camera_id:     str            # pass as cameraId in request-stream message
    expires_at:    datetime


# ── Clips / Playback ──────────────────────────────────────────────────────────

class ClipResponse(BaseModel):
    id:               int
    camera_id:        int
    camera_name:      str
    start_time:       datetime
    end_time:         datetime
    duration_seconds: float
    size_bytes:       int
    download_url:     str         # pre-signed raw H.265 MP4, expires in 1 hour
    play_url:         str         # pre-signed H.264 transcoded stream, expires in 1 hour

class ClipListResponse(BaseModel):
    items:    list[ClipResponse]
    total:    int
    page:     int
    limit:    int
    has_more: bool


# ── Device status ─────────────────────────────────────────────────────────────

class DeviceStatusResponse(BaseModel):
    camera_id:    int
    name:         str
    ip_address:   str
    manufacturer: str
    model:        str
    status:       str
    last_seen:    datetime
    last_error:   Optional[str]

class SystemStatusResponse(BaseModel):
    total_cameras:  int
    online:         int
    offline:        int
    error:          int
    active_streams: int
    uptime_seconds: int


# ── Settings / management ─────────────────────────────────────────────────────

class UpdateCameraRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)

class ScanStatusResponse(BaseModel):
    state:      Literal["idle", "running", "done", "error"]
    last_scan:  Optional[datetime]
    last_found: int = 0             # new cameras added in last scan

class UserResponse(BaseModel):
    id:         int
    username:   str
    role:       Literal["admin", "viewer"]
    created_at: datetime


# ── Generic ───────────────────────────────────────────────────────────────────

class MessageResponse(BaseModel):
    message: str

class ErrorResponse(BaseModel):
    detail: str
