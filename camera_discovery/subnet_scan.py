"""
Subnet sweep — finds ONVIF cameras that don't reply to multicast WS-Discovery.

Many budget OEMs (CP-Plus, Prama, Uniview-rebrands) ship with WSD multicast
disabled but still serve ONVIF over unicast HTTP. This module ARP/TCP-probes
the camera subnet for hosts with TCP port 80 open and returns them as
synthetic DiscoveredDevice entries; the service then runs the same ONVIF
interrogation pipeline used for WSD-discovered devices.

Auto-discovery is preserved: any new camera plugged into the camera NIC will
get a DHCP lease and be picked up on the next scan cycle — no static config.

Link-local recovery: cameras that lose their lease and fall back to
169.254.0.0/16 (RFC 3927 IPv4 link-local) won't appear in the configured
camera subnet. We additionally read the kernel ARP/neighbor table for the
camera NIC and probe any 169.254/* entries so the service can rediscover
and re-IP them. The /16 is too large to sweep blindly; relying on entries
the kernel has already learned (from the cameras' own ARP announces or
gratuitous ARP at boot) keeps it cheap.
"""

import asyncio
import ipaddress
import logging
import os
import socket
from typing import List, Set

from models import DiscoveredDevice

log = logging.getLogger(__name__)

DEFAULT_PORT     = 80
PROBE_TIMEOUT    = 0.4    # seconds per host
PARALLEL_PROBES  = 64


def _derive_subnet() -> str | None:
    """
    Derive the camera subnet to sweep.

    Preference order:
      1. CAMERA_NIC_SUBNET env var (CIDR, e.g. "10.42.0.0/24")
      2. DISCOVERY_INTERFACE env var (host IP) → assume /24
      3. None (caller should skip the sweep)
    """
    explicit = os.getenv("CAMERA_NIC_SUBNET", "").strip()
    if explicit:
        return explicit

    iface_ip = os.getenv("DISCOVERY_INTERFACE", "").strip()
    if iface_ip:
        try:
            net = ipaddress.IPv4Network(f"{iface_ip}/24", strict=False)
            return str(net)
        except ValueError:
            log.warning("DISCOVERY_INTERFACE=%s is not a valid IPv4 address", iface_ip)
    return None


async def _probe_host(ip: str, sem: asyncio.Semaphore) -> str | None:
    """Return ip if TCP :80 accepts a connection within PROBE_TIMEOUT, else None."""
    async with sem:
        try:
            fut = asyncio.open_connection(ip, DEFAULT_PORT)
            reader, writer = await asyncio.wait_for(fut, timeout=PROBE_TIMEOUT)
        except (OSError, asyncio.TimeoutError):
            return None
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass
        return ip


def _iface_for_ip(local_ip: str) -> str:
    """Return the interface name that has the given IPv4 bound, or '' if not found."""
    if not local_ip:
        return ""
    try:
        for _, name in socket.if_nameindex():
            try:
                import fcntl, struct
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                raw = fcntl.ioctl(
                    s.fileno(), 0x8915,  # SIOCGIFADDR
                    struct.pack('256s', name[:15].encode()),
                )
                s.close()
                if socket.inet_ntoa(raw[20:24]) == local_ip:
                    return name
            except OSError:
                continue
    except OSError:
        pass
    return ""


def _link_local_arp_targets() -> Set[str]:
    """
    Read /proc/net/arp for 169.254/16 entries with a valid MAC.

    The neighbor table is populated by any traffic on the wire, including
    the cameras' own gratuitous-ARP at boot — so even STALE entries are
    useful: they tell us a Hikvision/Prama camera at $ip exists on $iface.
    Filtering on MAC != 00:00:00:00:00:00 drops INCOMPLETE entries.
    Filtered to the camera NIC (derived from DISCOVERY_INTERFACE) so any
    stray 169.254 entries on the WAN side don't pollute the probe set.
    """
    cam_iface = _iface_for_ip(os.getenv("DISCOVERY_INTERFACE", "").strip())
    targets: Set[str] = set()
    try:
        with open("/proc/net/arp", "r") as fh:
            next(fh, None)  # skip header
            for line in fh:
                parts = line.split()
                if len(parts) < 6:
                    continue
                ip, _hwtype, _flags, mac, _mask, device = parts[:6]
                if cam_iface and device != cam_iface:
                    continue
                if not ip.startswith("169.254."):
                    continue
                if mac == "00:00:00:00:00:00":
                    continue
                targets.add(ip)
    except OSError as exc:
        log.debug("Could not read /proc/net/arp: %s", exc)
    return targets


async def scan(timeout: float = 5.0) -> List[DiscoveredDevice]:
    """
    Sweep the camera subnet for hosts with TCP :80 open and return them as
    DiscoveredDevice candidates. The local interface IP is excluded.

    Also probes any 169.254/16 hosts the kernel ARP table has learned on
    the camera NIC — recovers cameras that fell back to IPv4 link-local.
    """
    subnet_str = _derive_subnet()
    targets: List[str] = []
    subnet = None

    if subnet_str:
        try:
            subnet = ipaddress.IPv4Network(subnet_str, strict=False)
        except ValueError:
            log.warning("CAMERA_NIC_SUBNET=%s is not a valid CIDR — skipping sweep", subnet_str)
            subnet = None

    local_ip = os.getenv("DISCOVERY_INTERFACE", "").strip()

    if subnet is not None and subnet.num_addresses > 1024:
        log.warning(
            "Camera subnet %s has %d hosts — skipping primary sweep (too large)",
            subnet, subnet.num_addresses,
        )
    elif subnet is not None:
        targets.extend(str(h) for h in subnet.hosts() if str(h) != local_ip)

    # Add link-local targets the kernel has learned on the camera NIC.
    link_local = _link_local_arp_targets()
    if link_local:
        log.info("Link-local recovery: probing %d ARP-known 169.254/16 host(s)", len(link_local))
        targets.extend(sorted(link_local - set(targets)))

    if not targets:
        log.debug("Subnet sweep skipped: no targets (no DISCOVERY_INTERFACE / no ARP-learned link-local hosts)")
        return []

    log.info(
        "Subnet sweep: probing %d host(s) (subnet=%s) for ONVIF/HTTP",
        len(targets), subnet,
    )

    sem = asyncio.Semaphore(PARALLEL_PROBES)
    tasks = [_probe_host(ip, sem) for ip in targets]

    try:
        results = await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        log.warning("Subnet sweep timed out after %.1fs", timeout)
        return []

    alive = [r for r in results if isinstance(r, str)]
    log.info("Subnet sweep: %d host(s) replied on :%d", len(alive), DEFAULT_PORT)

    return [
        DiscoveredDevice(
            endpoint   = f"sweep-{ip}",
            xaddrs     = [f"http://{ip}/onvif/device_service"],
            ip_address = ip,
        )
        for ip in alive
    ]
