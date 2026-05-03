/**
 * Integration test for the full NVR ↔ viewer signaling flow.
 *
 * Requires a running Redis on localhost:6379.
 * Run with:  node --test test/signaling.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http   from 'node:http';
import { WebSocket } from 'ws';
import Redis  from 'ioredis';

const BASE_URL = 'http://localhost:18080';
const WS_URL   = 'ws://localhost:18080/signal';
const redis    = new Redis();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function registerDevice(deviceId, peerType) {
  const { randomBytes } = await import('node:crypto');
  const secret = randomBytes(32).toString('hex');
  await redis.hset(`device:${deviceId}`, { secret, peerType, createdAt: new Date().toISOString() });
  return secret;
}

async function getToken(deviceId, secret) {
  const body = JSON.stringify({ deviceId, secret });
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    const messages = [];

    ws.on('open',    ()    => resolve({ ws, messages }));
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('error',   reject);
  });
}

function waitForMessage(messages, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      const found = messages.find(m => m.type === type);
      if (found) {
        clearInterval(poll);
        resolve(found);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`Timeout waiting for message type "${type}"`));
      }
    }, 20);
  });
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let server;

before(async () => {
  process.env.PORT      = '18080';
  process.env.JWT_SECRET = 'test-secret-1234';
  process.env.REDIS_URL  = 'redis://localhost:6379';
  process.env.LOG_LEVEL  = 'silent';
  process.env.NODE_ENV   = 'test';

  const { default: srv } = await import('../src/server.js');
  server = srv;
  await new Promise(r => setTimeout(r, 200)); // let server bind
});

after(async () => {
  await redis.del('device:test-nvr', 'device:test-viewer');
  redis.disconnect();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('rejects unknown device', async () => {
    const result = await getToken('ghost-device', 'wrong-secret');
    assert.equal(result.error, 'invalid_credentials');
  });

  it('issues JWT for valid credentials', async () => {
    const secret = await registerDevice('test-nvr', 'nvr');
    const result = await getToken('test-nvr', secret);
    assert.ok(result.token, 'expected a token');
    assert.equal(typeof result.token, 'string');
  });
});

describe('Full WebRTC signaling flow', () => {
  it('completes offer/answer/ICE exchange between NVR and viewer', async () => {
    const nvrSecret    = await registerDevice('test-nvr', 'nvr');
    const viewerSecret = await registerDevice('test-viewer', 'viewer');

    const { token: nvrToken }    = await getToken('test-nvr', nvrSecret);
    const { token: viewerToken } = await getToken('test-viewer', viewerSecret);

    const { ws: nvrWs, messages: nvrMsgs }       = await connect(nvrToken);
    const { ws: viewerWs, messages: viewerMsgs } = await connect(viewerToken);

    // Both should receive "connected" confirmation
    await waitForMessage(nvrMsgs, 'connected');
    await waitForMessage(viewerMsgs, 'connected');

    // ── 1. Viewer requests stream ──
    viewerWs.send(JSON.stringify({ type: 'request-stream', nvrId: 'test-nvr', cameraId: 'cam-01' }));

    const joined = await waitForMessage(nvrMsgs, 'viewer-joined');
    assert.equal(joined.viewerId, 'test-viewer');
    assert.equal(joined.cameraId, 'cam-01');

    const { sessionId } = joined;

    // ── 2. NVR sends offer ──
    nvrWs.send(JSON.stringify({ type: 'offer', sessionId, sdp: 'v=0\r\n...fake-offer-sdp' }));

    const offer = await waitForMessage(viewerMsgs, 'offer');
    assert.equal(offer.sessionId, sessionId);
    assert.ok(offer.sdp.startsWith('v=0'));

    // ── 3. Viewer answers ──
    viewerWs.send(JSON.stringify({ type: 'answer', sessionId, sdp: 'v=0\r\n...fake-answer-sdp' }));

    const answer = await waitForMessage(nvrMsgs, 'answer');
    assert.equal(answer.sessionId, sessionId);

    // ── 4. ICE candidate exchange (bidirectional) ──
    const iceCandidate = { candidate: 'candidate:1 1 UDP 1234 192.168.1.2 5004 typ host', sdpMid: '0' };

    nvrWs.send(JSON.stringify({ type: 'ice-candidate', sessionId, candidate: iceCandidate }));
    viewerWs.send(JSON.stringify({ type: 'ice-candidate', sessionId, candidate: iceCandidate }));

    await waitForMessage(viewerMsgs, 'ice-candidate');
    await waitForMessage(nvrMsgs, 'ice-candidate');

    // ── 5. Viewer leaves ──
    viewerWs.send(JSON.stringify({ type: 'leave', sessionId }));

    const left = await waitForMessage(nvrMsgs, 'peer-left');
    assert.equal(left.sessionId, sessionId);

    nvrWs.close();
    viewerWs.close();
  });
});

describe('Error handling', () => {
  it('returns error on malformed JSON', async () => {
    const secret = await registerDevice('test-nvr', 'nvr');
    const { token } = await getToken('test-nvr', secret);
    const { ws, messages } = await connect(token);

    ws.send('not-json}}}');
    const err = await waitForMessage(messages, 'error');
    assert.equal(err.code, 'invalid_json');
    ws.close();
  });

  it('returns nvr_offline when NVR is not connected', async () => {
    const viewerSecret = await registerDevice('test-viewer', 'viewer');
    const { token } = await getToken('test-viewer', viewerSecret);
    const { ws, messages } = await connect(token);

    ws.send(JSON.stringify({ type: 'request-stream', nvrId: 'nonexistent-nvr', cameraId: 'cam-1' }));
    const err = await waitForMessage(messages, 'error');
    assert.equal(err.code, 'nvr_offline');
    ws.close();
  });
});
