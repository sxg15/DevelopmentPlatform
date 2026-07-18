import { runtimeConfig } from '../config/runtimeConfig.js';

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
let tenantTokenCache = null;

export async function exchangeCodeForAccessToken(code) {
  const response = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: runtimeConfig.feishu.appId,
      client_secret: runtimeConfig.feishu.appSecret,
      code,
    }),
  });

  const payload = await readJson(response);
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.error_description || payload.msg || '飞书授权码换取失败');
  }

  const accessToken = payload.access_token || payload.data?.access_token;
  if (!accessToken) {
    throw new Error('飞书没有返回用户访问令牌');
  }

  return accessToken;
}

export async function fetchFeishuUser(accessToken) {
  const response = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '获取飞书用户信息失败');
  }

  const source = payload.data || payload;
  const name = source.name || source.en_name || source.email || '飞书用户';
  const avatarUrl =
    source.avatar_url || source.avatar_thumb || source.avatar_middle || source.avatar_big || '';

  return {
    name,
    avatarUrl,
    openId: source.open_id || source.openId || '',
    unionId: source.union_id || source.unionId || '',
    userId: source.user_id || source.userId || '',
    email: source.email || '',
  };
}

export async function getTenantAccessToken() {
  const now = Date.now();
  if (tenantTokenCache && tenantTokenCache.expiresAt > now + TOKEN_REFRESH_BUFFER_MS) {
    return tenantTokenCache.token;
  }

  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: runtimeConfig.feishu.appId,
      app_secret: runtimeConfig.feishu.appSecret,
    }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '获取飞书应用访问令牌失败');
  }

  const token = payload.tenant_access_token;
  if (!token) {
    throw new Error('飞书没有返回应用访问令牌');
  }

  const expireSeconds = Number(payload.expire || 7200);
  tenantTokenCache = {
    token,
    expiresAt: now + Math.max(expireSeconds - 120, 60) * 1000,
  };

  return token;
}

export async function fetchFeishuJson(url, options) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    const message = typeof options.normalizeError === 'function'
      ? options.normalizeError(payload)
      : payload.msg;
    throw new Error(message || options.errorMessage || '飞书请求失败');
  }

  return payload;
}

export async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
