/**
 * Redis pub/sub bus for cross-instance message routing.
 *
 * Horizontal scaling strategy:
 *   - Each server instance subscribes to  signal:<deviceId>  for every peer
 *     it owns (handled via psubscribe on "signal:*").
 *   - route(targetId, msg) first tries local delivery; on miss it publishes
 *     to Redis so the instance that owns the connection picks it up.
 *   - No shared session state needed: sessions live on the instance that
 *     created them; the routing hop is transparent to clients.
 *
 * With Redis Cluster, prefix all keys with "{signal}" to ensure pub/sub
 * messages land on the same hash slot.
 */

import Redis from 'ioredis';
import log from './logger.js';
import * as registry from './registry.js';

const PREFIX = 'signal:';

let pub = null;  // dedicated publish connection
let sub = null;  // dedicated subscribe connection (must not issue commands)

export function init(redisUrl) {
  pub = new Redis(redisUrl, { lazyConnect: false });
  sub = new Redis(redisUrl, { lazyConnect: false });

  sub.psubscribe(`${PREFIX}*`, (err) => {
    if (err) log.error({ err }, 'pub/sub psubscribe failed');
    else     log.info('Redis pub/sub ready');
  });

  sub.on('pmessage', (_pattern, channel, raw) => {
    const deviceId = channel.slice(PREFIX.length);
    try {
      // sendLocal skips JSON.parse — deliver the raw string directly
      registry.sendLocal(deviceId, raw);
    } catch (err) {
      log.warn({ err, deviceId }, 'pub/sub delivery failed');
    }
  });

  sub.on('error', (err) => log.error({ err }, 'Redis subscriber error'));
  pub.on('error', (err) => log.error({ err }, 'Redis publisher error'));
}

/**
 * Route a message object to targetId.
 * Returns true if delivered locally, false if published to Redis.
 */
export async function route(targetId, msg) {
  const json = JSON.stringify(msg);

  if (registry.sendLocal(targetId, json)) return true;

  // Peer is on another instance (or offline) — publish and let them handle it
  await pub.publish(`${PREFIX}${targetId}`, json);
  return false;
}

export function close() {
  pub?.disconnect();
  sub?.disconnect();
}
