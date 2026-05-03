/**
 * Message router — validates, dispatches, and relays all signaling messages.
 *
 * Message protocol (all messages are JSON):
 *
 *  Viewer → Server
 *    { type: "request-stream",  nvrId, cameraId }
 *    { type: "answer",          sessionId, sdp }
 *    { type: "ice-candidate",   sessionId, candidate }
 *    { type: "leave",           sessionId }
 *
 *  NVR → Server
 *    { type: "offer",           sessionId, sdp }
 *    { type: "ice-candidate",   sessionId, candidate }
 *    { type: "leave",           sessionId }
 *
 *  Server → Client (routed)
 *    { type: "viewer-joined",   sessionId, viewerId, cameraId }
 *    { type: "offer",           sessionId, sdp }
 *    { type: "answer",          sessionId, sdp }
 *    { type: "ice-candidate",   sessionId, candidate }
 *    { type: "peer-left",       sessionId, reason? }
 *    { type: "error",           code }
 */

import log from './logger.js';
import * as registry from './registry.js';
import * as session  from './session.js';
import * as pubsub   from './pubsub.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export async function handle(deviceId, peerType, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return error(deviceId, 'invalid_json');
  }

  if (typeof msg.type !== 'string') return error(deviceId, 'missing_type');

  log.debug({ deviceId, peerType, type: msg.type }, '→ message received');

  switch (msg.type) {
    case 'request-stream': return onRequestStream(deviceId, peerType, msg);
    case 'offer':          return onOffer(deviceId, peerType, msg);
    case 'answer':         return onAnswer(deviceId, peerType, msg);
    case 'ice-candidate':  return onIceCandidate(deviceId, msg);
    case 'leave':          return onLeave(deviceId, msg);
    default:               return error(deviceId, `unknown_type`);
  }
}

/** Called when a WebSocket closes — tears down all associated sessions. */
export async function handleDisconnect(deviceId) {
  const active = session.getByPeer(deviceId);

  await Promise.all(active.map(async (sess) => {
    const targetId = session.otherPeer(sess, deviceId);
    await pubsub.route(targetId, { type: 'peer-left', sessionId: sess.sessionId, reason: 'disconnected' });
    session.remove(sess.sessionId);
  }));

  if (active.length > 0)
    log.info({ deviceId, cleaned: active.length }, 'sessions torn down on disconnect');
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/** Viewer asks to watch a camera on a specific NVR. */
async function onRequestStream(viewerId, peerType, msg) {
  if (peerType !== 'viewer') return error(viewerId, 'forbidden');

  const { nvrId, cameraId } = msg;
  if (!nvrId || !cameraId)   return error(viewerId, 'missing_nvrId_or_cameraId');

  const sessionId = session.create(nvrId, viewerId, cameraId);

  const reached = await pubsub.route(nvrId, {
    type: 'viewer-joined',
    sessionId,
    viewerId,
    cameraId,
  });

  if (!reached) {
    session.remove(sessionId);
    return error(viewerId, 'nvr_offline');
  }

  log.info({ viewerId, nvrId, cameraId, sessionId }, 'stream session created');
}

/** NVR sends SDP offer to the requesting viewer. */
async function onOffer(nvrId, peerType, { sessionId, sdp }) {
  if (peerType !== 'nvr')                  return error(nvrId, 'forbidden');
  if (!sdp || !sessionId)                  return error(nvrId, 'missing_sdp_or_sessionId');

  const sess = session.get(sessionId);
  if (!sess || sess.nvrId !== nvrId)       return error(nvrId, 'session_not_found');

  await pubsub.route(sess.viewerId, { type: 'offer', sessionId, sdp });
}

/** Viewer sends SDP answer back to the NVR. */
async function onAnswer(viewerId, peerType, { sessionId, sdp }) {
  if (peerType !== 'viewer')                  return error(viewerId, 'forbidden');
  if (!sdp || !sessionId)                     return error(viewerId, 'missing_sdp_or_sessionId');

  const sess = session.get(sessionId);
  if (!sess || sess.viewerId !== viewerId)    return error(viewerId, 'session_not_found');

  await pubsub.route(sess.nvrId, { type: 'answer', sessionId, sdp });
}

/** Bidirectional ICE candidate relay — no peerType restriction. */
async function onIceCandidate(deviceId, { sessionId, candidate }) {
  if (!sessionId || !candidate) return; // silently drop malformed

  const sess = session.get(sessionId);
  if (!sess) return; // session may have ended — normal race condition

  const targetId = session.otherPeer(sess, deviceId);
  await pubsub.route(targetId, { type: 'ice-candidate', sessionId, candidate });
}

/** Either peer signals intent to end the session. */
async function onLeave(deviceId, { sessionId }) {
  if (!sessionId) return;

  const sess = session.get(sessionId);
  if (!sess) return;

  const targetId = session.otherPeer(sess, deviceId);
  await pubsub.route(targetId, { type: 'peer-left', sessionId });
  session.remove(sessionId);

  log.info({ deviceId, sessionId }, 'session ended by peer');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function error(deviceId, code) {
  registry.sendLocal(deviceId, JSON.stringify({ type: 'error', code }));
}
