import { beginGlobalOperation } from './requestActivity.js';
import { getAuthenticationErrorCode } from '../../shared/authenticationErrorUtils.js';
import {
  expireAuthentication,
  getAuthenticationExpirationSnapshot,
} from './authenticationState.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const UPLOAD_REQUEST_TIMEOUT_MS = 180_000;

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
    error.status = response.status;
    throw error;
  }

  return payload;
}

export async function requestJson(url, options = {}) {
  const {
    detectAuthenticationExpiration = true,
    ...requestOptions
  } = options;
  if (detectAuthenticationExpiration && getAuthenticationExpirationSnapshot().expired) {
    throw createAuthenticationExpiredRequestError();
  }

  try {
    return await requestWithLifecycle(url, requestOptions, parseJsonResponse);
  } catch (error) {
    const authenticationCode = detectAuthenticationExpiration
      ? getAuthenticationErrorCode({
          status: error?.status,
          code: error?.payload?.code,
          message: error?.message,
        })
      : '';
    if (authenticationCode) {
      expireAuthentication({
        code: authenticationCode,
        message: error?.message,
      });
    }
    throw error;
  }
}

async function requestWithLifecycle(url, options, transformResponse) {
  const {
    timeoutMs,
    globalOperation,
    operationMessage,
    signal: externalSignal,
    ...fetchOptions
  } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const shouldBlockUi = globalOperation ?? isMutationMethod(method);
  const endGlobalOperation = shouldBlockUi
    ? beginGlobalOperation(operationMessage)
    : null;
  const controller = new AbortController();
  const normalizedTimeoutMs = normalizeTimeoutMs(
    timeoutMs,
    isUploadBody(fetchOptions.body) ? UPLOAD_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS,
  );
  let timeoutId = null;
  let externalAbortHandler = null;

  if (externalSignal) {
    externalAbortHandler = () => controller.abort(externalSignal.reason);
    if (externalSignal.aborted) {
      externalAbortHandler();
    } else {
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  try {
    const timeoutPromise = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(createRequestTimeoutError(method, normalizedTimeoutMs));
      }, normalizedTimeoutMs);
    });
    return await Promise.race([
      fetch(url, {
        credentials: 'same-origin',
        ...fetchOptions,
        method,
        signal: controller.signal,
      }).then(transformResponse),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
    endGlobalOperation?.();
  }
}

function isMutationMethod(method) {
  return method === 'POST'
    || method === 'PUT'
    || method === 'PATCH'
    || method === 'DELETE';
}

function isUploadBody(body) {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

function normalizeTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function createRequestTimeoutError(method, timeoutMs) {
  const error = new Error(isMutationMethod(method)
    ? '操作超时，请稍后重试'
    : '请求超时，请稍后重试');
  error.code = 'REQUEST_TIMEOUT';
  error.timeoutMs = timeoutMs;
  return error;
}

function createAuthenticationExpiredRequestError() {
  const error = new Error('登录信息已失效，请刷新页面重新登录');
  error.code = 'AUTH_EXPIRED';
  error.status = 401;
  return error;
}
