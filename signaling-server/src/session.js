/**
 * WebRTC session tracker.
 *
 * A session represents one viewer watching one camera on one NVR.
 * Created when a viewer sends "request-stream", removed on "leave"
 * or when either peer disconnects.
 *
 * Shape: { sessionId, nvrId, viewerId, cameraId, createdAt }
 */

import { v4 as uuidv4 } from 'uuid';

/** @type {Map<string, { sessionId:string, nvrId:string, viewerId:string, cameraId:string, createdAt:number }>} */
const sessions = new Map();

export function create(nvrId, viewerId, cameraId) {
  const sessionId = uuidv4();
  sessions.set(sessionId, { sessionId, nvrId, viewerId, cameraId, createdAt: Date.now() });
  return sessionId;
}

export const get    = (sessionId) => sessions.get(sessionId);
export const remove = (sessionId) => sessions.delete(sessionId);
export const size   = ()          => sessions.size;

/** Return all sessions involving a given device (as either NVR or viewer). */
export function getByPeer(deviceId) {
  const result = [];
  for (const s of sessions.values()) {
    if (s.nvrId === deviceId || s.viewerId === deviceId) result.push(s);
  }
  return result;
}

/** Given a session and one of its peer IDs, return the other peer's ID. */
export function otherPeer(session, deviceId) {
  return session.nvrId === deviceId ? session.viewerId : session.nvrId;
}
