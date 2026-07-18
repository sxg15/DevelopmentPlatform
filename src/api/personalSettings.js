import { requestJson } from './client.js';

export async function fetchPersonalSettings() {
  const payload = await requestJson('/api/me/settings');
  return payload.settings;
}

export async function updatePersonalSettings(settings) {
  const payload = await requestJson('/api/me/settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ notifications: settings }),
  });
  return payload.settings;
}
