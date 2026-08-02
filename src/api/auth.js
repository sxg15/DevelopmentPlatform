import { requestJson } from './client.js';

export async function fetchCurrentUser() {
  try {
    const payload = await requestJson('/api/me', {
      detectAuthenticationExpiration: false,
    });
    return payload.user || null;
  } catch (error) {
    if (error?.status === 401) {
      return null;
    }
    throw error;
  }
}

export function fetchAppConfig() {
  return requestJson('/api/config');
}

export async function exchangeCodeForUser(code, options = {}) {
  const payload = await requestJson('/api/auth/feishu', {
    method: 'POST',
    detectAuthenticationExpiration: false,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      publicEntryOAuth: options.publicEntryOAuth === true,
    }),
  });
  return payload.user;
}

export async function createDebugSession() {
  const payload = await requestJson('/api/auth/debug', {
    method: 'POST',
    detectAuthenticationExpiration: false,
  });
  return payload.user;
}
