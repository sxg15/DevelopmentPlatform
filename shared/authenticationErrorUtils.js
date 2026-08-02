export const AUTHENTICATION_ERROR_CODES = Object.freeze({
  SESSION_EXPIRED: 'AUTH_EXPIRED',
  FEISHU_AUTH_EXPIRED: 'FEISHU_AUTH_EXPIRED',
});

const AUTHENTICATION_ERROR_CODE_SET = new Set(Object.values(AUTHENTICATION_ERROR_CODES));

export function getAuthenticationErrorCode({ status, code, message } = {}) {
  const normalizedCode = String(code || '').trim();
  if (AUTHENTICATION_ERROR_CODE_SET.has(normalizedCode)) {
    return normalizedCode;
  }

  const normalizedMessage = String(message || '');
  if (normalizedMessage.includes('登录授权已失效')) {
    return AUTHENTICATION_ERROR_CODES.FEISHU_AUTH_EXPIRED;
  }

  if (Number(status) === 401) {
    return AUTHENTICATION_ERROR_CODES.SESSION_EXPIRED;
  }

  return '';
}

export function normalizeAuthenticationErrorResponse(status, payload) {
  const normalizedPayload = payload && typeof payload === 'object'
    ? payload
    : { message: String(payload || '身份验证失败') };
  const code = getAuthenticationErrorCode({
    status,
    code: normalizedPayload.code,
    message: normalizedPayload.message,
  });

  if (!code) {
    return {
      status: Number(status) || 500,
      payload: normalizedPayload,
    };
  }

  return {
    status: 401,
    payload: {
      ...normalizedPayload,
      code,
    },
  };
}
