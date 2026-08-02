const FEISHU_H5_SDK_URL = 'https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js';
const FEISHU_USER_SCOPES = [];
const FEISHU_SDK_LOAD_TIMEOUT_MS = 8000;
const FEISHU_AUTH_REQUEST_TIMEOUT_MS = 15_000;

export async function waitForFeishuRuntime() {
  const isFeishuClient = isFeishuUserAgent();

  if (!window.h5sdk && !window.tt && !isFeishuClient) {
    return {
      available: false,
      message: '请在飞书客户端中打开',
    };
  }

  await ensureH5SdkScript();

  const sdkReady = await waitForH5SdkReady();
  const tt = window.tt;
  const hasRequestAccess = typeof tt?.requestAccess === 'function';
  const hasRequestAuthCode = typeof tt?.requestAuthCode === 'function';

  if (sdkReady && (hasRequestAccess || hasRequestAuthCode)) {
    return {
      available: true,
      requestAccess: hasRequestAccess ? tt.requestAccess.bind(tt) : null,
      requestAuthCode: hasRequestAuthCode ? tt.requestAuthCode.bind(tt) : null,
    };
  }

  if (isFeishuClient) {
    return {
      available: false,
      message: '飞书客户端能力未就绪，请刷新或检查网页应用配置',
    };
  }

  return {
    available: false,
    message: '请在飞书客户端中打开',
  };
}

export async function getFeishuAuthCode(feishuRuntime, appId) {
  if (feishuRuntime.requestAuthCode) {
    return requestAuthCode(feishuRuntime.requestAuthCode, appId);
  }

  try {
    if (feishuRuntime.requestAccess) {
      return await requestAccessCode(feishuRuntime.requestAccess, appId, FEISHU_USER_SCOPES);
    }
  } catch (error) {
    if (
      feishuRuntime.requestAccess
      && FEISHU_USER_SCOPES.length > 0
      && shouldRetryWithoutOptionalScopes(error)
    ) {
      return await requestAccessCode(feishuRuntime.requestAccess, appId, []);
    }

    throw error;
  }

  throw new Error('飞书客户端不支持当前免登接口');
}

function ensureH5SdkScript() {
  if (window.h5sdk || document.querySelector('script[data-feishu-h5-sdk="true"]')) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      resolve();
    };
    const script = document.createElement('script');
    const timeoutId = window.setTimeout(finish, FEISHU_SDK_LOAD_TIMEOUT_MS);
    script.src = FEISHU_H5_SDK_URL;
    script.async = true;
    script.dataset.feishuH5Sdk = 'true';
    script.onload = finish;
    script.onerror = finish;
    document.head.appendChild(script);
  });
}

function waitForH5SdkReady() {
  const maxWaitMs = 8000;
  const checkEveryMs = 150;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (available) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(available);
    };
    const timeoutId = window.setTimeout(() => finish(false), maxWaitMs);
    const check = () => {
      if (settled) {
        return;
      }
      if (typeof window.tt?.requestAccess === 'function' || typeof window.tt?.requestAuthCode === 'function') {
        finish(true);
        return;
      }

      if (typeof window.h5sdk?.ready === 'function') {
        window.h5sdk.ready(() => finish(true));
        return;
      }

      window.setTimeout(check, checkEveryMs);
    };

    check();
  });
}

function requestAccessCode(requestAccess, appId, scopeList = []) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => (value) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeoutId);
        callback(value);
      }
    };
    const timeoutId = window.setTimeout(
      finish(() => reject(new Error('飞书授权超时，请重新打开应用后重试'))),
      FEISHU_AUTH_REQUEST_TIMEOUT_MS,
    );

    try {
      requestAccess({
        appID: appId,
        scopeList,
        success: finish((result) => {
          const code = getCodeFromResult(result);
          if (!code) {
            reject(new Error('飞书没有返回授权码'));
            return;
          }
          resolve(code);
        }),
        fail: finish((error) => reject(createFeishuError(error))),
        complete: () => {},
      });
    } catch (error) {
      finish(reject)(error);
    }
  });
}

function requestAuthCode(requestAuthCodeApi, appId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => (value) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeoutId);
        callback(value);
      }
    };
    const timeoutId = window.setTimeout(
      finish(() => reject(new Error('飞书授权超时，请重新打开应用后重试'))),
      FEISHU_AUTH_REQUEST_TIMEOUT_MS,
    );

    try {
      requestAuthCodeApi({
        appId,
        success: finish((result) => {
          const code = getCodeFromResult(result);
          if (!code) {
            reject(new Error('飞书没有返回授权码'));
            return;
          }
          resolve(code);
        }),
        fail: finish((error) => reject(createFeishuError(error))),
        complete: () => {},
      });
    } catch (error) {
      finish(reject)(error);
    }
  });
}

function getCodeFromResult(result) {
  return result?.code || result?.authCode || result?.auth_code || '';
}

function createFeishuError(error) {
  const rawMessage = error?.errString || error?.errMsg || error?.message || '飞书授权失败';
  const message = normalizeFeishuAuthError(rawMessage, error?.errno);
  const feishuError = new Error(message);
  feishuError.errno = error?.errno;
  feishuError.rawMessage = rawMessage;
  return feishuError;
}

function shouldRetryWithoutOptionalScopes(error) {
  const message = `${error?.message || ''} ${error?.rawMessage || ''}`;
  return error?.errno === 2700002
    || message.includes('Authorization terminated unexpectedly')
    || message.includes('99991679');
}

function normalizeFeishuAuthError(message, errno) {
  if (errno === 2700002 || String(message).includes('Authorization terminated unexpectedly')) {
    return '飞书用户授权被中断，请关闭当前网页应用后重新打开';
  }
  return message;
}

function isFeishuUserAgent() {
  const userAgent = navigator.userAgent.toLowerCase();
  return userAgent.includes('feishu') || userAgent.includes('lark');
}
