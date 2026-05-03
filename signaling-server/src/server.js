/**
 * NVR WebRTC Signaling Server
 *
 * HTTP endpoints:
 *   POST /auth    { deviceId, secret }  →  { token }
 *   GET  /health                        →  { status, peers, sessions, uptime }
 *
 * WebSocket:
 *   ws://host:PORT/signal
 *   Authorization: Bearer <token>   (or ?token=<token> for clients that
 *                                    can't set headers, e.g. browser WS API)
 */

import http    from 'node:http';
import { WebSocketServer } from 'ws';
import Redis   from 'ioredis';
import config  from './config.js';
import log     from './logger.js';
import * as auth     from './auth.js';
import * as registry from './registry.js';
import * as session  from './session.js';
import * as router   from './router.js';
import * as pubsub   from './pubsub.js';

// ─── Redis ───────────────────────────────────────────────────────────────────

const redis = new Redis(config.redis.url);
redis.on('error', (err) => log.error({ err }, 'Redis connection error'));

pubsub.init(config.redis.url);

// ─── HTTP server (REST endpoints only) ───────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/auth') {
    return handleAuth(req, res);
  }
  if (req.method === 'GET' && req.url === '/health') {
    return handleHealth(req, res);
  }
  res.writeHead(404).end();
});

async function handleAuth(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let deviceId, secret;
  try {
    ({ deviceId, secret } = JSON.parse(body));
  } catch {
    return json(res, 400, { error: 'invalid_json' });
  }

  const device = await auth.validateDevice(redis, deviceId, secret);
  if (!device) {
    log.warn({ deviceId }, 'authentication failed');
    return json(res, 401, { error: 'invalid_credentials' });
  }

  const token = auth.issueToken(device.deviceId, device.peerType);
  log.info({ deviceId, peerType: device.peerType }, 'device authenticated');
  return json(res, 200, { token });
}

function handleHealth(_req, res) {
  json(res, 200, {
    status:   'ok',
    uptime:   Math.floor(process.uptime()),
    ...registry.stats(),
    sessions: session.size(),
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server:     httpServer,
  path:       '/signal',
  maxPayload: config.ws.maxPayload,
});

wss.on('connection', async (ws, req) => {
  // ── Resolve client IP (respects reverse proxy) ──
  const ip = (req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
    .split(',')[0].trim();

  // ── IP-level flood guard ──
  if (registry.ipCount(ip) >= config.rateLimit.connectionsPerIp) {
    log.warn({ ip }, 'connection rejected: too many from IP');
    ws.close(1008, 'too_many_connections');
    return;
  }
  registry.trackIp(ip);

  // ── Authentication ──
  const token   = auth.extractToken(req);
  const payload = token ? auth.verifyToken(token) : null;

  if (!payload?.deviceId) {
    ws.close(1008, 'unauthorized');
    registry.untrackIp(ip);
    return;
  }

  const { deviceId, peerType } = payload;

  // Gracefully replace existing connection (device reconnect)
  const existing = registry.get(deviceId);
  if (existing) {
    log.info({ deviceId }, 'replacing stale connection');
    existing.ws.close(1000, 'replaced_by_new_connection');
  }

  registry.register(deviceId, peerType, ip, ws);
  log.info({ deviceId, peerType, ip }, 'peer connected');

  // ── Per-device message rate limiter ──
  let msgBucket = 0;
  const bucketReset = setInterval(() => { msgBucket = 0; }, 1000);

  // ── Heartbeat ──
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Message handling ──
  ws.on('message', async (data) => {
    if (++msgBucket > config.rateLimit.messagesPerSecond) {
      registry.sendLocal(deviceId, JSON.stringify({ type: 'error', code: 'rate_limited' }));
      return;
    }
    try {
      await router.handle(deviceId, peerType, data.toString());
    } catch (err) {
      log.error({ err, deviceId }, 'unhandled error in message handler');
    }
  });

  // ── Disconnect ──
  ws.on('close', async (code, reason) => {
    clearInterval(bucketReset);
    registry.unregister(deviceId);
    registry.untrackIp(ip);
    await router.handleDisconnect(deviceId);
    log.info({ deviceId, code, reason: reason.toString() }, 'peer disconnected');
  });

  ws.on('error', (err) => {
    log.warn({ err, deviceId }, 'WebSocket error');
  });

  // Confirm successful connection
  ws.send(JSON.stringify({ type: 'connected', deviceId, peerType }));
});

// ─── Heartbeat sweep ──────────────────────────────────────────────────────────
// Detects and terminates zombie connections (TCP half-open, dead NAT entries)

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, config.ws.pingInterval);

wss.on('close', () => clearInterval(heartbeatTimer));

// ─── Startup ─────────────────────────────────────────────────────────────────

httpServer.listen(config.port, () => {
  log.info({ port: config.port }, 'signaling server listening');
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  log.info({ signal }, 'shutting down…');

  // Stop accepting new connections
  httpServer.close();

  // Close all WebSocket connections cleanly
  for (const ws of wss.clients) ws.close(1001, 'server_shutdown');

  pubsub.close();
  redis.disconnect();

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => log.fatal({ err }, 'uncaughtException'));
process.on('unhandledRejection', (err) => log.fatal({ err }, 'unhandledRejection'));
