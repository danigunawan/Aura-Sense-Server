"""
Syncs discovered cameras to mediamtx — both runtime (API) and persistent (YAML).

Two-phase sync on every new or updated camera:
  1. Runtime: POST to mediamtx REST API to add paths immediately (no restart needed).
  2. Persistent: Rewrite mediamtx.yml so paths survive mediamtx restarts.

Both phases are failure-tolerant — mediamtx may be starting up or temporarily down.
"""

import logging
import os
from typing import List

import requests

log = logging.getLogger(__name__)

_API_TIMEOUT  = 5   # seconds for mediamtx REST calls
_WRITE_RETRIES = 2


def sync_all_cameras(cameras: List, mediamtx_api: str) -> None:
    """Hot-add all camera paths to a running mediamtx instance."""
    for cam in cameras:
        if cam.rtsp_url and cam.sub_rtsp_url and cam.slug:
            _upsert_path(cam.slug,           cam.rtsp_url,     always_on=True,  api=mediamtx_api)
            _upsert_path(f"{cam.slug}-sub",  cam.sub_rtsp_url, always_on=True,  api=mediamtx_api)


def sync_camera(cam, mediamtx_api: str) -> None:
    """Hot-add one camera's main and sub paths to a running mediamtx instance."""
    if not (cam.rtsp_url and cam.sub_rtsp_url and cam.slug):
        log.warning("Camera %s missing slug/rtsp_url — skipping mediamtx sync", cam.name)
        return
    _upsert_path(cam.slug,           cam.rtsp_url,     always_on=True, api=mediamtx_api)
    _upsert_path(f"{cam.slug}-sub",  cam.sub_rtsp_url, always_on=True, api=mediamtx_api)


def remove_camera(slug: str, mediamtx_api: str) -> None:
    """Remove a camera's paths from mediamtx (called when camera is deleted from DB)."""
    _delete_path(slug,          api=mediamtx_api)
    _delete_path(f"{slug}-sub", api=mediamtx_api)


def regenerate_yml(cameras: List, base_yml_path: str, output_yml_path: str) -> None:
    """
    Rewrite mediamtx.yml = global base config + generated camera path block.

    Written atomically (tmp → rename) so mediamtx never reads a partial file.
    Safe to call frequently — only the path block changes.
    """
    try:
        with open(base_yml_path) as f:
            base = f.read().rstrip()
    except OSError as exc:
        log.error("Cannot read mediamtx base config %s: %s", base_yml_path, exc)
        return

    active = [c for c in cameras if c.rtsp_url and c.sub_rtsp_url and c.slug]
    paths_block = _build_paths_block(active)
    full = f"{base}\n\npaths:\n{paths_block}\n"

    tmp = output_yml_path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            f.write(full)
        os.replace(tmp, output_yml_path)
        log.info(
            "mediamtx.yml regenerated: %d camera(s), %d paths",
            len(active), len(active) * 2,
        )
    except OSError as exc:
        log.error("Cannot write mediamtx config %s: %s", output_yml_path, exc)
        try:
            os.unlink(tmp)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _build_paths_block(cameras: List) -> str:
    if not cameras:
        # Valid YAML with no paths
        return '  ~:\n    source: ""\n'

    # Defensive dedupe — mediamtx refuses to load a YAML with duplicate mapping
    # keys ("mapping key X already defined") and goes into a crash loop, taking
    # down live view and recording for every camera, not just the duplicate.
    # _assign_slug should make this impossible, but on rare DB corruption /
    # manual SQL edits we've seen it happen — so we never trust the input here.
    # First slug wins; subsequent collisions are logged loudly and dropped from
    # the YAML (their tile in the dashboard will show as no-stream, which is
    # better UX than the entire NVR going dark).
    lines = []
    emitted: set[str] = set()
    for cam in cameras:
        if cam.slug in emitted:
            log.error(
                "mediamtx.yml: duplicate slug '%s' (camera id=%s name=%r) — "
                "skipping to keep mediamtx from crashing. Rename the camera "
                "in the dashboard to give it a unique slug.",
                cam.slug, getattr(cam, 'id', '?'), cam.name,
            )
            continue
        emitted.add(cam.slug)
        for path_name, url in [
            (cam.slug,           cam.rtsp_url),
            (f"{cam.slug}-sub",  cam.sub_rtsp_url),
        ]:
            lines += [
                f'  {path_name}:',
                f'    source: "{_yml_str(url)}"',
                f'    rtspTransport: tcp',
                f'    sourceOnDemand: false',
            ]
    return '\n'.join(lines)


def _yml_str(s: str) -> str:
    """Escape a string for embedding inside YAML double quotes."""
    return s.replace('\\', '\\\\').replace('"', '\\"')


def _upsert_path(name: str, source: str, always_on: bool, api: str) -> None:
    body = {
        'source': source,
        'rtspTransport': 'tcp',
        'sourceOnDemand': not always_on,
    }
    # Try PATCH first (path already exists), then POST (new path).
    for method, endpoint in [
        ('patch', f'{api}/v3/config/paths/patch/{name}'),
        ('post',  f'{api}/v3/config/paths/add/{name}'),
    ]:
        try:
            fn   = getattr(requests, method)
            resp = fn(endpoint, json=body, timeout=_API_TIMEOUT)
            if resp.status_code in (200, 201, 204):
                log.debug("mediamtx path '%s' synced via %s", name, method.upper())
                return
            if resp.status_code == 404 and method == 'patch':
                continue   # path not yet created, fall through to POST
            log.warning(
                "mediamtx %s %s → %d: %s",
                method.upper(), endpoint, resp.status_code, resp.text[:120],
            )
            return
        except requests.exceptions.ConnectionError:
            log.debug(
                "mediamtx API not reachable — path '%s' will be loaded from YAML on next start",
                name,
            )
            return
        except Exception as exc:
            log.warning("mediamtx API error for path '%s': %s", name, exc)
            return


def _delete_path(name: str, api: str) -> None:
    try:
        resp = requests.delete(f'{api}/v3/config/paths/delete/{name}', timeout=_API_TIMEOUT)
        if resp.status_code == 200:
            log.info("mediamtx path '%s' removed", name)
        elif resp.status_code == 404:
            pass   # already gone, no action needed
        else:
            log.warning("mediamtx path delete '%s' → %d", name, resp.status_code)
    except requests.exceptions.ConnectionError:
        log.debug("mediamtx API not reachable — path '%s' removal deferred", name)
    except Exception as exc:
        log.warning("mediamtx path delete error for '%s': %s", name, exc)
