export async function parseJsonResponse(response) {
  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.message || '请求失败');
    error.payload = payload;
    throw error;
  }

  return payload;
}

export function requestJson(url, options = {}) {
  return fetch(url, {
    credentials: 'same-origin',
    ...options,
  }).then(parseJsonResponse);
}
