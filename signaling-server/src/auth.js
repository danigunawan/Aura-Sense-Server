/**
 * Authentication layer.
 *
 * Two-step flow:
 *   1. POST /auth  { deviceId, secret }  →  { token: JWT }
 *   2. WebSocket connects with  Authorization: Bearer <token>
 *
 * Device records are stored in Redis as hashes:
 *   device:<deviceId>  →  { secret, peerType, createdAt }
 *
 * peerType is either "nvr" or "viewer".
 */

import jwt from 'jsonwebtoken';
import config from './config.js';

export function issueToken(deviceId, peerType) {
  return jwt.sign({ deviceId, peerType }, config.jwtSecret, {
    expiresIn: config.jwtExpiry,
    algorithm: 'HS256',
  });
}

/** Returns decoded payload or null on any error. */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

/**
 * Look up the device in Redis and validate the shared secret.
 * Returns { deviceId, peerType } or null.
 */
export async function validateDevice(redis, deviceId, secret) {
  if (!deviceId || !secret) return null;

  const record = await redis.hgetall(`device:${deviceId}`);
  if (!record?.secret) return null;

  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(record.secret);
  const provided = Buffer.from(secret);
  if (expected.length !== provided.length) return null;

  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  if (diff !== 0) return null;

  return { deviceId, peerType: record.peerType || 'viewer' };
}

/** Extract Bearer token from Authorization header or ?token= query param. */
export function extractToken(req) {
  const header = req.headers['authorization'];
  if (header?.startsWith('Bearer ')) return header.slice(7);

  const url = new URL(req.url, 'http://x');
  return url.searchParams.get('token') ?? null;
}
