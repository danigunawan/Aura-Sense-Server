#!/usr/bin/env node
/**
 * Register a device (NVR or viewer app) in Redis.
 *
 * Usage:
 *   node scripts/register-device.js <deviceId> <peerType>
 *   node scripts/register-device.js nvr-001 nvr
 *   node scripts/register-device.js mobile-abc viewer
 *
 * Outputs the generated secret — store it securely on the device.
 * Re-running with the same deviceId rotates the secret.
 */

import { randomBytes }  from 'node:crypto';
import Redis            from 'ioredis';

const [,, deviceId, peerType = 'viewer'] = process.argv;

if (!deviceId) {
  console.error('Usage: node scripts/register-device.js <deviceId> <peerType>');
  process.exit(1);
}

if (!['nvr', 'viewer'].includes(peerType)) {
  console.error('peerType must be "nvr" or "viewer"');
  process.exit(1);
}

const redis  = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const secret = randomBytes(32).toString('hex');

await redis.hset(`device:${deviceId}`, {
  secret,
  peerType,
  createdAt: new Date().toISOString(),
});

console.log(JSON.stringify({ deviceId, secret, peerType }, null, 2));
console.error(`\nDevice registered. Store the secret securely — it cannot be recovered.`);

redis.disconnect();
