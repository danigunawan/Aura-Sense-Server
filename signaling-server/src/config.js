import 'dotenv/config';

export default Object.freeze({
  port:      parseInt(process.env.PORT      || '8080'),
  jwtSecret: process.env.JWT_SECRET         || 'dev-secret-change-in-prod',
  jwtExpiry: process.env.JWT_EXPIRY         || '24h',
  redis:   { url: process.env.REDIS_URL     || 'redis://localhost:6379' },
  ws: {
    maxPayload:   64 * 1024,  // 64 KB — plenty for SDP + ICE
    pingInterval: 25_000,     // keepalive probe interval
    pongTimeout:  10_000,     // terminate if no pong within this window
  },
  rateLimit: {
    messagesPerSecond: 30,    // per device
    connectionsPerIp:  50,    // prevent single-IP flooding
  },
});
