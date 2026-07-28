import { requestJson } from './client.js';

export async function fetchPersonalSettings() {
  const payload = await requestJson('/api/me/settings');
  return {
    settings: payload.settings,
    mcp: payload.mcp,
  };
}

export async function ensurePersonalSettingsRecord() {
  const payload = await requestJson('/api/me/settings/ensure', {
    method: 'POST',
  });
  return {
    created: payload.created === true,
  };
}

export async function updatePersonalSettings(settings) {
  const payload = await requestJson('/api/me/settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      notifications: {
        receiveTodoNotifications: settings.receiveTodoNotifications === true,
        todoNotificationTime: settings.todoNotificationTime,
      },
    }),
  });
  return payload.settings;
}

export async function regenerateDevelopmentPlatformToken() {
  const payload = await requestJson('/api/me/settings/token/regenerate', {
    method: 'POST',
  });
  return payload.settings;
}
