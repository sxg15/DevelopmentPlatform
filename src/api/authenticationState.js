const listeners = new Set();
let snapshot = createSnapshot();

export function expireAuthentication({ code = '', message = '' } = {}) {
  if (snapshot.expired) {
    return;
  }
  snapshot = Object.freeze({
    expired: true,
    code: String(code || '').trim(),
    message: String(message || '').trim(),
    detectedAt: Date.now(),
  });
  publish();
}

export function clearAuthenticationExpiration() {
  if (!snapshot.expired) {
    return;
  }
  snapshot = createSnapshot();
  publish();
}

export function subscribeAuthenticationExpiration(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuthenticationExpirationSnapshot() {
  return snapshot;
}

function publish() {
  for (const listener of listeners) {
    listener();
  }
}

function createSnapshot() {
  return Object.freeze({
    expired: false,
    code: '',
    message: '',
    detectedAt: 0,
  });
}
