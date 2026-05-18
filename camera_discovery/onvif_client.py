"""
ONVIF camera interrogation for a closed, single-brand system.

All cameras share identical ONVIF credentials (no cycling).
On success, returns both the main stream (H264) and sub stream (H265) RTSP URIs.
Cameras not matching the allowed manufacturer are rejected before any further work.

All zeep/requests calls are synchronous, so every public entry point runs inside
a ThreadPoolExecutor.
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote, urlparse, urlunparse

import requests
import ssl
import urllib3
from requests.adapters import HTTPAdapter

import onvif
from onvif import ONVIFCamera
from onvif.exceptions import ONVIFError
from zeep.transports import Transport

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from models import DiscoveredDevice
from retry import sync_retry

log = logging.getLogger(__name__)

_WSDL_DIR = os.path.join(os.path.dirname(os.path.dirname(onvif.__file__)), 'wsdl')
_EXECUTOR  = ThreadPoolExecutor(max_workers=16, thread_name_prefix='onvif')


class CameraRejected(Exception):
    """Camera does not meet allowlist criteria — not an error, skip silently."""


@dataclass
class CameraInfo:
    device_uuid: str
    manufacturer: str
    model: str
    serial_number: str
    firmware_version: str
    rtsp_url: str           # H264 main stream
    sub_rtsp_url: str       # H265 sub stream
    profile_token: str      # main stream ONVIF profile token
    sub_profile_token: str  # sub stream ONVIF profile token
    tls_fingerprint: Optional[str] = None  # set when camera uses RTSPS


class _LaxSSLAdapter(HTTPAdapter):
    """Accepts legacy cipher suites; rewrites http://host:443 → https://host:443."""
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode    = ssl.CERT_NONE
        ctx.set_ciphers('DEFAULT:@SECLEVEL=0')
        kwargs['ssl_context'] = ctx
        return super().init_poolmanager(*args, **kwargs)

    def send(self, request, **kwargs):
        if request.url.startswith('http://') and ':443/' in request.url:
            request.url = request.url.replace('http://', 'https://', 1)
        kwargs['verify'] = False
        return super().send(request, **kwargs)


async def interrogate(
    device: DiscoveredDevice,
    username: str,
    password: str,
    rtsp_user: str,
    rtsp_pass: str,
    allowed_manufacturer: list[str],
    allowed_models: list[str],
    timeout: int           = 10,
    max_attempts: int      = 3,
    base_delay: float      = 1.0,
    backoff: float         = 2.0,
    auto_configure_gop: int = 0,
) -> Optional[CameraInfo]:
    """
    Interrogate one device using a single credential pair.

    Raises CameraRejected if the camera's manufacturer/model is not in the allowlist.
    Returns None on auth failure or unrecoverable ONVIF error.
    """
    from wsdiscovery import best_device_url
    host, port, url = best_device_url(device)

    loop = asyncio.get_running_loop()
    try:
        info = await loop.run_in_executor(
            _EXECUTOR,
            _interrogate_sync,
            host, port, username, password, rtsp_user, rtsp_pass, url,
            allowed_manufacturer, allowed_models,
            timeout, max_attempts, base_delay, backoff,
            auto_configure_gop,
        )
        return info
    except CameraRejected:
        raise
    except ONVIFError as exc:
        log.warning("ONVIF auth failed for %s: %s", host, exc)
        return None
    except Exception as exc:
        log.warning("Failed to interrogate %s: %s", host, exc)
        return None


# ---------------------------------------------------------------------------
# Blocking helpers (run inside executor threads)
# ---------------------------------------------------------------------------

def _interrogate_sync(
    host: str,
    port: int,
    username: str,
    password: str,
    rtsp_user: str,
    rtsp_pass: str,
    device_url: str,
    allowed_manufacturer: list[str],
    allowed_models: list[str],
    timeout: int,
    max_attempts: int,
    base_delay: float,
    backoff: float,
    auto_configure_gop: int,
) -> CameraInfo:
    session = requests.Session()
    session.verify = False
    adapter = _LaxSSLAdapter()
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    transport = Transport(timeout=timeout, operation_timeout=timeout, session=session)

    @sync_retry(max_attempts=max_attempts, base_delay=base_delay, backoff=backoff,
                exceptions=(Exception,))
    def _connect() -> ONVIFCamera:
        return ONVIFCamera(host, port, username, password, _WSDL_DIR,
                           transport=transport)

    cam = _connect()

    # --- Device info and allowlist check ---
    dev_info = cam.devicemgmt.GetDeviceInformation()
    manufacturer = getattr(dev_info, 'Manufacturer', '') or ''
    model        = getattr(dev_info, 'Model', '') or ''

    _check_allowlist(host, manufacturer, model, allowed_manufacturer, allowed_models)

    # Stable UUID: endpoint reference URN → serial number → host:port fallback
    uuid_raw = _extract_uuid(device_url) or dev_info.SerialNumber or f"{host}:{port}"

    # --- Media profiles ---
    media    = cam.create_media_service()
    profiles = media.GetProfiles()
    if not profiles:
        raise ONVIFError(f"No media profiles on {host}")

    main_profile = profiles[0]
    sub_profile  = profiles[1] if len(profiles) > 1 else profiles[0]

    log.debug(
        "%s profiles: main=%s sub=%s",
        host,
        _profile_label(main_profile),
        _profile_label(sub_profile),
    )

    # --- RTSP URIs (credentials come from env, not from ONVIF auth) ---
    rtsp_url     = _get_stream_uri(media, main_profile.token, rtsp_user, rtsp_pass)
    sub_rtsp_url = _get_stream_uri(media, sub_profile.token,  rtsp_user, rtsp_pass)

    # --- Optional: set short GOP for low-latency WebRTC start ---
    # Apply to both profiles: main feeds the dashboard/desktop player, sub feeds
    # the Android grid and recording. Without this, low-motion sub streams emit
    # an IDR every several seconds and WebRTC viewers see a black cell until
    # the next keyframe arrives.
    if auto_configure_gop > 0:
        _try_set_gop(media, main_profile, auto_configure_gop, host)
        if sub_profile.token != main_profile.token:
            _try_set_gop(media, sub_profile, auto_configure_gop, host)

    # Detect RTSPS: probe TLS on the RTSP port. If the camera uses TLS (some
    # brands like CP Plus require it), upgrade rtsp:// → rtsps:// and capture
    # the cert fingerprint so mediamtx can validate without a CA chain.
    rtsp_port = 554
    tls_fp = _probe_rtsp_tls(host, rtsp_port)
    if tls_fp:
        rtsp_url     = rtsp_url.replace('rtsp://', 'rtsps://', 1)
        sub_rtsp_url = sub_rtsp_url.replace('rtsp://', 'rtsps://', 1)
        log.info("%s: RTSPS detected (fingerprint %s…)", host, tls_fp[:11])

    log.info(
        "Authenticated %s (%s %s) — main=%s sub=%s",
        host, manufacturer, model,
        _redact_url(rtsp_url), _redact_url(sub_rtsp_url),
    )

    return CameraInfo(
        device_uuid       = uuid_raw,
        manufacturer      = manufacturer,
        model             = model,
        serial_number     = getattr(dev_info, 'SerialNumber', '') or '',
        firmware_version  = getattr(dev_info, 'FirmwareVersion', '') or '',
        rtsp_url          = rtsp_url,
        sub_rtsp_url      = sub_rtsp_url,
        profile_token     = main_profile.token,
        sub_profile_token = sub_profile.token,
        tls_fingerprint   = tls_fp,
    )


async def set_system_time(
    host: str,
    port: int,
    username: str,
    password: str,
    timeout: int = 10,
) -> None:
    """Push current UTC time to the camera via ONVIF SetSystemDateAndTime.

    Uses DateTimeType="Manual" so the camera doesn't try to reach an NTP server
    it can't see on the isolated cam subnet. Existing TimeZone and
    DaylightSavings settings are preserved — we only correct the clock, the
    OSD/UI display continues to render in local time.
    """
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        _EXECUTOR,
        _set_system_time_sync,
        host, port, username, password, timeout,
    )


def _set_system_time_sync(
    host: str,
    port: int,
    username: str,
    password: str,
    timeout: int,
) -> None:
    from datetime import datetime, timezone

    session = requests.Session()
    session.verify = False
    adapter = _LaxSSLAdapter()
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    transport = Transport(timeout=timeout, operation_timeout=timeout, session=session)

    cam = ONVIFCamera(host, port, username, password, _WSDL_DIR, transport=transport)

    # Preserve existing TZ/DST. ONVIF requires DaylightSavings even in Manual.
    dst = False
    tz_tz = ''
    try:
        cur = cam.devicemgmt.GetSystemDateAndTime()
        dst = bool(getattr(cur, 'DaylightSavings', False))
        tz_obj = getattr(cur, 'TimeZone', None)
        if tz_obj is not None:
            tz_tz = getattr(tz_obj, 'TZ', '') or ''
    except Exception as exc:
        log.debug("%s: GetSystemDateAndTime failed, using defaults (%s)", host, exc)

    now = datetime.now(timezone.utc)
    req = cam.devicemgmt.create_type('SetSystemDateAndTime')
    req.DateTimeType    = 'Manual'
    req.DaylightSavings = dst
    if tz_tz:
        req.TimeZone = {'TZ': tz_tz}
    req.UTCDateTime = {
        'Date': {'Year': now.year, 'Month': now.month, 'Day': now.day},
        'Time': {'Hour': now.hour, 'Minute': now.minute, 'Second': now.second},
    }
    cam.devicemgmt.SetSystemDateAndTime(req)
    log.info("%s: system time set to %sZ (tz=%s, dst=%s)",
             host, now.strftime('%Y-%m-%dT%H:%M:%S'), tz_tz or '-', dst)


async def set_static_ip(
    host: str,
    port: int,
    username: str,
    password: str,
    static_ip: str,
    prefix_len: int,
    gateway: str,
    dns: str,
    timeout: int = 10,
) -> None:
    """
    Assign a static IPv4 address to the camera via ONVIF SetNetworkInterfaces
    and reboot it so the change takes effect.  The camera will be unreachable
    for ~30–60 s while it reboots; the next discovery cycle will find it at
    its new address.

    Raises on failure so the caller can log and skip without crashing.
    """
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        _EXECUTOR,
        _set_static_ip_sync,
        host, port, username, password,
        static_ip, prefix_len, gateway, dns, timeout,
    )


def _set_static_ip_sync(
    host: str,
    port: int,
    username: str,
    password: str,
    static_ip: str,
    prefix_len: int,
    gateway: str,
    dns: str,
    timeout: int,
) -> None:
    session = requests.Session()
    session.verify = False
    adapter = _LaxSSLAdapter()
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    transport = Transport(timeout=timeout, operation_timeout=timeout, session=session)

    cam = ONVIFCamera(host, port, username, password, _WSDL_DIR, transport=transport)

    # ── Find the first wired Ethernet interface token ──────────────────────
    interfaces = cam.devicemgmt.GetNetworkInterfaces()
    token = None
    for iface in interfaces:
        # Pick the first enabled wired interface (skip loopback / disabled)
        if getattr(iface, 'Enabled', True) and getattr(iface, 'token', None):
            hw = getattr(iface, 'Info', None)
            if hw and getattr(hw, 'HwAddress', None):
                # Prefer interfaces that have a real MAC (i.e. real NICs)
                token = iface.token
                break
            elif token is None:
                token = iface.token  # fallback: first interface found

    if token is None:
        raise RuntimeError(f"{host}: no network interface found via ONVIF")

    # ── Build SetNetworkInterfaces request ─────────────────────────────────
    # NB: the schema for IPv4NetworkInterfaceSetConfiguration is FLAT
    # ({Enabled, Manual, DHCP}). The nested `Config` wrapper that appears in
    # the Get-side response type does NOT exist here — passing it triggers a
    # zeep validation error ("The ReferenceToken type doesn't accept
    # collections as value") before any SOAP is sent.
    req = cam.devicemgmt.create_type('SetNetworkInterfaces')
    req.InterfaceToken = token
    req.NetworkInterface = {
        'Enabled': True,
        'IPv4': {
            'Enabled': True,
            'Manual': [{'Address': static_ip, 'PrefixLength': prefix_len}],
            'DHCP': False,
        },
    }

    # Optional: set default gateway and DNS (best-effort — some cameras ignore these)
    try:
        gw_req = cam.devicemgmt.create_type('SetNetworkDefaultGateway')
        gw_req.IPv4Address = [gateway]
        cam.devicemgmt.SetNetworkDefaultGateway(gw_req)
    except Exception as exc:
        log.debug("%s: SetNetworkDefaultGateway skipped (%s)", host, exc)

    try:
        dns_req = cam.devicemgmt.create_type('SetDNS')
        dns_req.FromDHCP = False
        dns_req.DNSManual = [{'Type': 'IPv4', 'IPv4Address': dns}]
        cam.devicemgmt.SetDNS(dns_req)
    except Exception as exc:
        log.debug("%s: SetDNS skipped (%s)", host, exc)

    result = cam.devicemgmt.SetNetworkInterfaces(req)
    log.info(
        "%s: static IP %s/%d set (token=%s, reboot_needed=%s)",
        host, static_ip, prefix_len, token,
        getattr(result, 'RebootNeeded', '?'),
    )

    # Reboot so the new address takes effect
    try:
        cam.devicemgmt.SystemReboot()
        log.info("%s: reboot triggered — camera will return at %s", host, static_ip)
    except Exception as exc:
        # Some cameras close the connection mid-reboot; this is expected.
        log.debug("%s: reboot response error (likely mid-reboot disconnect): %s", host, exc)


def _check_allowlist(
    host: str,
    manufacturer: str,
    model: str,
    allowed_manufacturer: list[str],
    allowed_models: list[str],
) -> None:
    """Raise CameraRejected if this camera is not from the approved brand/model set."""
    if allowed_manufacturer:
        mfr_lower = manufacturer.lower()
        if not any(mfr_lower.startswith(m.lower()) for m in allowed_manufacturer):
            raise CameraRejected(
                f"{host}: manufacturer '{manufacturer}' not in allowlist "
                f"{allowed_manufacturer}"
            )

    if allowed_models:
        model_lower = model.lower()
        if not any(m.lower() in model_lower for m in allowed_models):
            raise CameraRejected(
                f"{host}: model '{model}' not in allowed_models {allowed_models}"
            )


def _get_stream_uri(media, profile_token: str, username: str, password: str) -> str:
    req = media.create_type('GetStreamUri')
    req.StreamSetup = {
        'Stream': 'RTP-Unicast',
        'Transport': {'Protocol': 'RTSP'},
    }
    req.ProfileToken = profile_token
    uri = media.GetStreamUri(req)
    return _embed_credentials(_strip_onvif_params(uri.Uri), username, password)


def _probe_rtsp_tls(host: str, port: int = 554) -> Optional[str]:
    """Return SHA-256 fingerprint (colon-hex) if the port speaks TLS, else None."""
    import ssl, socket, hashlib
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((host, port), timeout=3) as raw:
            with ctx.wrap_socket(raw, server_hostname=host) as tls:
                cert_der = tls.getpeercert(binary_form=True)
        return hashlib.sha256(cert_der).hexdigest()
    except Exception:
        return None


def _strip_onvif_params(url: str) -> str:
    """Remove ONVIF-only query params (proto=Onvif, unicast=true) that break plain RTSP."""
    from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse
    parsed = urlparse(url)
    _ONVIF_PARAMS = {'proto', 'unicast'}
    qs = [(k, v) for k, v in parse_qsl(parsed.query) if k.lower() not in _ONVIF_PARAMS]
    return urlunparse(parsed._replace(query=urlencode(qs)))


def _try_set_gop(media, profile, gop: int, host: str) -> None:
    """Set GovLength (GOP/I-frame interval) on the given profile's encoder configuration."""
    try:
        vec = profile.VideoEncoderConfiguration
        if vec is None:
            return
        vec.GovLength = gop
        media.SetVideoEncoderConfiguration({
            'Configuration': vec,
            'ForcePersistence': True,
        })
        log.info("%s: set GOP to %d frames on profile %s", host, gop, profile.token)
    except Exception as exc:
        log.debug("%s: GOP auto-configure skipped (%s)", host, exc)


def _profile_label(profile) -> str:
    try:
        vec = profile.VideoEncoderConfiguration
        if vec:
            res = vec.Resolution
            enc = vec.Encoding
            return f"{enc} {res.Width}x{res.Height}"
    except Exception:
        pass
    return profile.token


def _extract_uuid(text: str) -> Optional[str]:
    import re
    m = re.search(r'uuid:([a-fA-F0-9\-]{32,})', text)
    return m.group(1) if m else None


def _embed_credentials(rtsp_url: str, username: str, password: str) -> str:
    """Return rtsp://user:pass@host:port/path with properly URL-encoded credentials."""
    if not username:
        return rtsp_url
    parsed = urlparse(rtsp_url)
    u = quote(username, safe='')
    p = quote(password, safe='')
    netloc = f"{u}:{p}@{parsed.hostname}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def _redact_url(url: str) -> str:
    import re
    return re.sub(r'(rtsp://[^:]+:)[^@]+(@)', r'\1***\2', url)
