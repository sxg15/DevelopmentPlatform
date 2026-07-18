import { parseJsonResponse, requestJson } from './client.js';

export async function fetchCurrentUser() {
  const response = await fetch('/api/me', {
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    return null;
  }

  const payload = await parseJsonResponse(response);
  return payload.user || null;
}

export function fetchAppConfig() {
  return requestJson('/api/config');
}

export async function exchangeCodeForUser(code) {
  const payload = await requestJson('/api/auth/feishu', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  });
  return payload.user;
}

export async function createDebugSession() {
  const payload = await requestJson('/api/auth/debug', {
    method: 'POST',
  });
  return payload.user;
}
