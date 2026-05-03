/**
 * In-memory peer registry for this process instance.
 *
 * At 10k devices, a Map lookup is O(1) and ~negligible memory.
 * Cross-instance routing is handled by pubsub.js via Redis.
 *
 * Entry shape:  { ws, deviceId, peerType, ip, connectedAt }
 */

/** @type {Map<string, { ws: import('ws').WebSocket, deviceId: string, peerType: string, ip: string, connectedAt: number }>} */
const peers = new Map();

/** @type {Map<string, number>}  ip → active connection count */
const ipCounts = new Map();

export const register   = (deviceId, peerType, ip, ws) =>
  peers.set(deviceId, { ws, deviceId, peerType, ip, connectedAt: Date.now() });

export const unregister = (deviceId) => peers.delete(deviceId);
export const get        = (deviceId) => peers.get(deviceId);
export const has        = (deviceId) => peers.has(deviceId);
export const size       = ()         => peers.size;

export function trackIp(ip) {
  const n = (ipCounts.get(ip) ?? 0) + 1;
  ipCounts.set(ip, n);
  return n;
}

export function untrackIp(ip) {
  const n = Math.max(0, (ipCounts.get(ip) ?? 1) - 1);
  n === 0 ? ipCounts.delete(ip) : ipCounts.set(ip, n);
}

export const ipCount = (ip) => ipCounts.get(ip) ?? 0;

/** Send a pre-serialized JSON string directly to a local peer. */
export function sendLocal(deviceId, json) {
  const peer = peers.get(deviceId);
  if (peer?.ws.readyState === 1 /* OPEN */) {
    peer.ws.send(json);
    return true;
  }
  return false;
}

export function stats() {
  return {
    peers:       peers.size,
    nvrs:        [...peers.values()].filter(p => p.peerType === 'nvr').length,
    viewers:     [...peers.values()].filter(p => p.peerType === 'viewer').length,
    uniqueIps:   ipCounts.size,
  };
}
