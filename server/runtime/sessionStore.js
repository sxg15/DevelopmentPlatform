import crypto from 'node:crypto';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const sessions = new Map();

export function createSession(user, userAccessToken = '') {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    user,
    userAccessToken,
    createdAt: Date.now(),
  });
  return sessionId;
}

export function getSession(request) {
  cleanupSessions();
  const sessionId = getSessionId(request);
  if (!sessionId) {
    return null;
  }
  return sessions.get(sessionId) || null;
}

export function deleteSession(sessionId) {
  if (sessionId) {
    sessions.delete(sessionId);
  }
}

export function getSessionId(request) {
  return parseCookies(request?.headers?.cookie).igp_session || '';
}

export function parseCookies(cookieHeader = '') {
  return String(cookieHeader || '').split(';').reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) {
      return cookies;
    }
    cookies[rawName] = decodeURIComponent(rawValue.join('='));
    return cookies;
  }, {});
}

export function buildSessionCookie(sessionId) {
  const maxAge = SESSION_TTL_MS / 1000;
  return [
    `igp_session=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function buildClearSessionCookie() {
  return [
    'igp_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}
