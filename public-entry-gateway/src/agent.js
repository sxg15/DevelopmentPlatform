import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ENTRY_STATUS,
  decideEntry,
  normalizeClientIpHeader,
} from './entryDecision.js';
import { loadGatewayConfig } from './config.js';
import { GatewayHealthMonitor } from './healthMonitor.js';
import { SshTunnelManager } from './sshTunnelManager.js';

export async function createGatewayAgent(config, options = {}) {
  const logger = options.logger || console;
  const monitor = options.monitor || new GatewayHealthMonitor(config);
  const tunnel = options.tunnel || new SshTunnelManager(config, { logger });
  const server = http.createServer((request, response) => {
    try {
      handleEntryRequest(config, monitor, request, response);
    } catch (error) {
      logger.error(error instanceof Error ? error.stack || error.message : String(error));
      sendHtml(response, 500, '入口服务发生异常', '请稍后重试。');
    }
  });

  return {
    async start() {
      await monitor.start();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.server.port, config.server.host, resolve);
      });
      try {
        tunnel.start();
      } catch (error) {
        await new Promise((resolve) => server.close(resolve));
        monitor.stop();
        throw error;
      }
      logger.log(`IGP 公网入口 Agent 已启动：http://${config.server.host}:${config.server.port}`);
    },
    async stop() {
      await tunnel.stop();
      monitor.stop();
      await new Promise((resolve) => server.close(resolve));
    },
    server,
    monitor,
    tunnel,
  };
}

export function handleEntryRequest(config, monitor, request, response) {
  applySecurityHeaders(response);
  if (!['GET', 'HEAD'].includes(String(request.method || ''))) {
    response.setHeader('Allow', 'GET, HEAD');
    sendHtml(response, 405, '请求方式不受支持', '请从飞书网页应用重新打开。', request.method === 'HEAD');
    return;
  }
  const monitorStatus = monitor.getStatus();
  const decision = decideEntry({
    relayToken: request.headers['x-igp-relay-token'],
    expectedRelayToken: config.publicEntry.relayToken,
    clientIp: normalizeClientIpHeader(request.headers['x-igp-client-ip']),
    agentPublicIp: monitorStatus.publicIp,
    additionalAllowedCidrs: config.accessControl.additionalAllowedCidrs,
    maintenance: monitorStatus.maintenance,
    ready: monitorStatus.ready && monitorStatus.publicIpFresh,
    localBaseUrl: config.localPlatform.baseUrl,
    publicBaseUrl: config.publicEntry.baseUrl,
    requestTarget: request.url,
  });

  if (decision.status === ENTRY_STATUS.REDIRECT) {
    if (config.feishu.appId && isFeishuClientRequest(request)) {
      sendFeishuAuthBridge(
        response,
        config.feishu.appId,
        decision.location,
        request.method === 'HEAD',
      );
      return;
    }
    response.statusCode = 302;
    response.setHeader('Location', decision.location);
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(request.method === 'HEAD' ? undefined : '正在进入开发平台');
    return;
  }
  const title = decision.status === ENTRY_STATUS.FORBIDDEN
    ? '当前网络不可访问'
    : decision.status === ENTRY_STATUS.MAINTENANCE
      ? '系统维护中'
      : '服务暂不可用';
  sendHtml(
    response,
    decision.statusCode,
    title,
    decision.message,
    request.method === 'HEAD',
    decision.statusCode === 503,
  );
}

function isFeishuClientRequest(request) {
  const userAgent = String(request.headers['user-agent'] || '').toLowerCase();
  return userAgent.includes('feishu') || userAgent.includes('lark');
}

function sendFeishuAuthBridge(response, appId, targetUrl, headOnly = false) {
  const serializedAppId = serializeInlineScriptValue(appId);
  const serializedTargetUrl = serializeInlineScriptValue(targetUrl);
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>开发平台</title>
<style>
html,body{margin:0;min-height:100%;font-family:Arial,"Microsoft YaHei",sans-serif;background:#f5f7fa;color:#1f2329}
body{display:grid;place-items:center}
main{width:min(520px,calc(100% - 40px));text-align:center}
h1{margin:0 0 12px;font-size:22px;font-weight:650}
p{margin:0;color:#646a73;font-size:15px;line-height:1.7}
</style>
</head>
<body>
<main><h1>正在登录开发平台</h1><p id="status">正在连接飞书，请稍候。</p></main>
<script src="https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js"></script>
<script>
(async () => {
  const appId = ${serializedAppId};
  const targetUrl = ${serializedTargetUrl};
  const status = document.getElementById('status');
  const runtimeDeadline = Date.now() + 10000;
  const attemptTimeoutMs = 8000;
  const totalTimeoutMs = 22000;
  let requested = false;
  let completed = false;
  const totalTimeoutId = window.setTimeout(() => {
    fail({ message: '飞书登录超时，请关闭当前窗口后重新打开' });
  }, totalTimeoutMs);

  function fail(error) {
    if (completed) {
      return;
    }
    completed = true;
    window.clearTimeout(totalTimeoutId);
    const raw = error && (error.errString || error.errMsg || error.message);
    status.textContent = raw
      ? '飞书登录失败：' + String(raw).slice(0, 160)
      : '飞书登录能力未就绪，请关闭当前窗口后重新打开。';
  }

  function finish(result) {
    if (completed) {
      return;
    }
    const code = result && (result.code || result.authCode || result.auth_code);
    if (!code) {
      fail({ message: '飞书没有返回授权码' });
      return;
    }
    completed = true;
    window.clearTimeout(totalTimeoutId);
    const destination = new URL(targetUrl);
    destination.searchParams.set('igpFeishuAuthCode', code);
    window.location.replace(destination.toString());
  }

  function describeError(error, fallback) {
    return error && (error.errString || error.errMsg || error.message)
      ? error
      : { message: fallback };
  }

  function requestCode(methodName) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback) => (value) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        callback(value);
      };
      const timeoutId = window.setTimeout(
        settle(() => reject({ message: methodName + ' 接口无响应' })),
        attemptTimeoutMs,
      );
      const options = methodName === 'requestAccess'
        ? {
            appID: appId,
            scopeList: [],
            success: settle(resolve),
            fail: settle(reject),
            complete() {},
          }
        : {
            appId,
            success: settle(resolve),
            fail: settle(reject),
            complete() {},
          };
      try {
        window.tt[methodName](options);
      } catch (error) {
        settle(reject)(error);
      }
    });
  }

  async function login() {
    const methods = [];
    if (typeof window.tt.requestAccess === 'function') {
      methods.push('requestAccess');
    }
    if (typeof window.tt.requestAuthCode === 'function') {
      methods.push('requestAuthCode');
    }
    if (methods.length === 0) {
      throw new Error('飞书客户端不支持当前免登接口');
    }

    let lastError = null;
    for (const methodName of methods) {
      status.textContent = methodName === 'requestAccess'
        ? '正在向飞书申请登录授权，请稍候。'
        : '正在尝试备用登录方式，请稍候。';
      try {
        const result = await requestCode(methodName);
        finish(result);
        return;
      } catch (error) {
        lastError = describeError(error, methodName + ' 调用失败');
      }
    }
    fail(lastError);
  }

  function tryLogin() {
    if (requested || completed) {
      return;
    }
    if (
      window.tt
      && (
        typeof window.tt.requestAccess === 'function'
        || typeof window.tt.requestAuthCode === 'function'
      )
    ) {
      requested = true;
      login().catch(fail);
      return;
    }
    if (Date.now() >= runtimeDeadline) {
      fail();
      return;
    }
    window.setTimeout(tryLogin, 150);
  }

  if (window.h5sdk && typeof window.h5sdk.error === 'function') {
    window.h5sdk.error((error) => {
      if (!requested) {
        fail(describeError(error, '飞书 SDK 初始化失败'));
      }
    });
  }
  if (window.h5sdk && typeof window.h5sdk.ready === 'function') {
    window.h5sdk.ready(tryLogin);
  }
  tryLogin();
})().catch((error) => {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = '飞书登录失败：' + String(error && error.message || error).slice(0, 160);
  }
});
</script>
</body>
</html>`;
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline' https://lf-scm-cn.feishucdn.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
  response.end(headOnly ? undefined : body);
}

function serializeInlineScriptValue(value) {
  return JSON.stringify(String(value || '')).replaceAll('<', '\\u003c');
}

function applySecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
}

function sendHtml(response, statusCode, title, message, headOnly = false, refresh = false) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const refreshTag = refresh ? '<meta http-equiv="refresh" content="5">' : '';
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshTag}
<title>${safeTitle}</title>
<style>
html,body{margin:0;min-height:100%;font-family:Arial,"Microsoft YaHei",sans-serif;background:#f5f7fa;color:#1f2329}
body{display:grid;place-items:center}
main{width:min(520px,calc(100% - 40px));text-align:center}
h1{margin:0 0 12px;font-size:24px;font-weight:650}
p{margin:0;color:#646a73;font-size:15px;line-height:1.7}
</style>
</head>
<body><main><h1>${safeTitle}</h1><p>${safeMessage}</p></main></body>
</html>`;
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(headOnly ? undefined : body);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadGatewayConfig();
  const agent = await createGatewayAgent(config);
  const shutdown = async () => {
    try {
      await agent.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await agent.start();
}
