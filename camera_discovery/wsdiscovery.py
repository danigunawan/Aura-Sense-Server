"""
WS-Discovery scanner.

Sends a SOAP multicast probe to 239.255.255.250:3702 and collects
ProbeMatch responses from ONVIF NetworkVideoTransmitter devices.
Runs the blocking socket work in a thread executor.
"""

import asyncio
import fcntl
import logging
import os
import select
import socket
import struct
import time
import uuid
import xml.etree.ElementTree as ET
from typing import List
from urllib.parse import urlparse

from models import DiscoveredDevice

log = logging.getLogger(__name__)

MCAST_ADDR = '239.255.255.250'
MCAST_PORT = 3702
RECV_BUF   = 65535

_PROBE_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope
    xmlns:e="http://www.w3.org/2003/05/soap-envelope"
    xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
    xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:{msg_id}</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>"""

_NS = {
    'e': 'http://www.w3.org/2003/05/soap-envelope',
    'd': 'http://schemas.xmlsoap.org/ws/2005/04/discovery',
    'w': 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
}


def _get_interface_ips() -> List[str]:
    """Return all non-loopback IPv4 addresses on this host."""
    ips = []
    for _, iface_name in socket.if_nameindex():
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            raw = fcntl.ioctl(
                s.fileno(),
                0x8915,  # SIOCGIFADDR
                struct.pack('256s', iface_name[:15].encode()),
            )
            s.close()
            ip = socket.inet_ntoa(raw[20:24])
            if not ip.startswith('127.') and ip != '0.0.0.0':
                ips.append(ip)
        except OSError:
            pass
    return ips or ['0.0.0.0']


def _make_socket(local_ip: str) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 4)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF,
                    socket.inet_aton(local_ip))
    sock.setblocking(False)
    sock.bind((local_ip, 0))
    return sock


def _probe_sync(timeout: float) -> List[DiscoveredDevice]:
    """
    Send WS-Discovery probes on every local interface and collect
    ProbeMatch responses from all of them concurrently via select().
    """
    probe = _PROBE_TEMPLATE.format(msg_id=str(uuid.uuid4())).encode()
    seen_endpoints: set[str] = set()
    devices: List[DiscoveredDevice] = []

    iface_ips = _get_interface_ips()

    # If DISCOVERY_INTERFACE is set, restrict probes to that NIC only so
    # WS-Discovery multicast goes out the camera network interface, not the
    # internet-facing NIC.
    bind_ip = os.getenv("DISCOVERY_INTERFACE", "").strip()
    if bind_ip:
        if bind_ip in iface_ips:
            iface_ips = [bind_ip]
        else:
            log.warning(
                "DISCOVERY_INTERFACE=%s not in local IPs %s — scanning all interfaces",
                bind_ip, iface_ips,
            )

    log.debug("WS-Discovery scanning on interfaces: %s", iface_ips)

    sockets = []
    for ip in iface_ips:
        try:
            s = _make_socket(ip)
            s.sendto(probe, (MCAST_ADDR, MCAST_PORT))
            sockets.append(s)
        except OSError as exc:
            log.debug("Could not probe on %s: %s", ip, exc)

    if not sockets:
        return devices

    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            readable, _, _ = select.select(sockets, [], [], min(remaining, 0.5))
            for sock in readable:
                try:
                    data, (src_ip, _) = sock.recvfrom(RECV_BUF)
                except OSError:
                    continue
                device = _parse_probe_match(data, src_ip)
                if device and device.endpoint not in seen_endpoints:
                    seen_endpoints.add(device.endpoint)
                    devices.append(device)
                    log.debug("Discovered %s at %s", device.endpoint, src_ip)
    finally:
        for s in sockets:
            s.close()

    return devices


def _parse_probe_match(data: bytes, src_ip: str) -> DiscoveredDevice | None:
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        log.debug("Failed to parse WS-Discovery response from %s: %s", src_ip, exc)
        return None

    match_el = root.find('.//d:ProbeMatch', _NS)
    if match_el is None:
        return None

    xaddrs_el  = match_el.find('d:XAddrs', _NS)
    endpoint_el = match_el.find('w:EndpointReference/w:Address', _NS)

    if xaddrs_el is None or not xaddrs_el.text:
        return None

    xaddrs   = xaddrs_el.text.strip().split()
    endpoint = (endpoint_el.text or '').strip() if endpoint_el is not None else src_ip

    return DiscoveredDevice(endpoint=endpoint, xaddrs=xaddrs, ip_address=src_ip)


async def scan(timeout: float = 5.0) -> List[DiscoveredDevice]:
    """Async wrapper around the blocking WS-Discovery probe."""
    loop = asyncio.get_running_loop()
    devices = await loop.run_in_executor(None, _probe_sync, timeout)
    log.info("WS-Discovery found %d device(s)", len(devices))
    return devices


def best_device_url(device: DiscoveredDevice) -> tuple[str, int, str]:
    """
    Pick the best XAddr and return (host, port, full_url).
    Prefers http over https; falls back to https with correct default port.
    """
    http_urls  = [u for u in device.xaddrs if u.startswith('http://')]
    https_urls = [u for u in device.xaddrs if u.startswith('https://')]
    candidates = http_urls or https_urls or device.xaddrs

    parsed       = urlparse(candidates[0])
    host         = parsed.hostname or device.ip_address
    default_port = 443 if parsed.scheme == 'https' else 80
    port         = parsed.port or default_port
    return host, port, candidates[0]
