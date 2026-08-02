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
