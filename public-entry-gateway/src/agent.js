import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ENTRY_STATUS,
  decideEntry,
  normalizeClientIpHeader,
} from './entryDecision.js';
import {
  buildFeishuAuthorizationUrl,
  FeishuOAuthStateStore,
} from './feishuOAuth.js';
import { loadGatewayConfig } from './config.js';
import { GatewayHealthMonitor } from './healthMonitor.js';
import { SshTunnelManager } from './sshTunnelManager.js';
import { buildStatusPageHtml } from './statusPage.js';

export async function createGatewayAgent(config, options = {}) {
  const logger = options.logger || console;
  const monitor = options.monitor || new GatewayHealthMonitor(config);
  const tunnel = options.tunnel || new SshTunnelManager(config, { logger });
  const feishuOAuthStateStore =
    options.feishuOAuthStateStore || new FeishuOAuthStateStore();
  const server = http.createServer((request, response) => {
    handleEntryRequest(config, monitor, request, response, {
      feishuOAuthStateStore,
    }).catch((error) => {
      logger.error(error instanceof Error ? error.stack || error.message : String(error));
      if (!response.headersSent) {
        sendHtml(response, 500, '入口服务发生异常', '请稍后重试。');
      } else {
        response.destroy();
      }
    });
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

export async function handleEntryRequest(config, monitor, request, response, options = {}) {
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
    const oauthCallback = readFeishuOAuthCallback(request, config.publicEntry.baseUrl);
    if (oauthCallback) {
      const targetUrl = options.feishuOAuthStateStore?.consume(oauthCallback.state) || '';
      if (!targetUrl) {
        sendHtml(
          response,
          400,
          '登录请求已失效',
          '请关闭当前窗口后从飞书工作台重新打开开发平台。',
          request.method === 'HEAD',
        );
        return;
      }
      if (oauthCallback.error) {
        sendHtml(
          response,
          401,
          '飞书登录未完成',
          oauthCallback.errorDescription || '请关闭当前窗口后重新打开。',
          request.method === 'HEAD',
        );
        return;
      }
      if (!oauthCallback.code) {
        sendHtml(
          response,
          400,
          '飞书没有返回授权码',
          '请关闭当前窗口后重新打开。',
          request.method === 'HEAD',
        );
        return;
      }
      const destination = new URL(targetUrl);
      destination.searchParams.set('igpFeishuAuthCode', oauthCallback.code);
      destination.searchParams.set('igpFeishuOAuth', '1');
      sendRedirect(
        response,
        destination.toString(),
        '正在进入开发平台',
        request.method === 'HEAD',
      );
      return;
    }
    if (config.feishu.appId && isFeishuClientRequest(request)) {
      const stateStore =
        options.feishuOAuthStateStore || new FeishuOAuthStateStore();
      const state = stateStore.create(decision.location);
      const authorizationUrl = buildFeishuAuthorizationUrl({
        appId: config.feishu.appId,
        redirectUri: buildOAuthRedirectUri(config.publicEntry.baseUrl),
        scope: config.feishu.oauthScope,
        state,
      });
      sendRedirect(
        response,
        authorizationUrl,
        '正在连接飞书登录',
        request.method === 'HEAD',
      );
      return;
    }
    sendRedirect(
      response,
      decision.location,
      '正在进入开发平台',
      request.method === 'HEAD',
    );
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
    decision.status,
  );
}

function isFeishuClientRequest(request) {
  const userAgent = String(request.headers['user-agent'] || '').toLowerCase();
  return userAgent.includes('feishu') || userAgent.includes('lark');
}

function readFeishuOAuthCallback(request, publicBaseUrl) {
  try {
    const url = new URL(String(request.url || '/'), publicBaseUrl);
    const state = String(url.searchParams.get('state') || '');
    const code = String(url.searchParams.get('code') || '');
    const error = String(url.searchParams.get('error') || '');
    if (!state || (!code && !error)) {
      return null;
    }
    return {
      state,
      code,
      error,
      errorDescription: String(url.searchParams.get('error_description') || ''),
    };
  } catch {
    return null;
  }
}

function buildOAuthRedirectUri(publicBaseUrl) {
  const url = new URL(publicBaseUrl);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function sendRedirect(response, location, message, headOnly = false) {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(headOnly ? undefined : message);
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

function sendHtml(
  response,
  statusCode,
  title,
  message,
  headOnly = false,
  refresh = false,
  kind = 'generic',
) {
  const body = buildStatusPageHtml({
    statusCode,
    title,
    message,
    refresh,
    kind,
  });
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(headOnly ? undefined : body);
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
