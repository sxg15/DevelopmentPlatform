import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const LOOPBACK_HOST = '127.0.0.1';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function createCodexApiBridge(options) {
  return new CodexApiBridge(options);
}

export class CodexApiBridge {
  constructor({
    apiBaseUrl,
    apiKey,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    bridgeToken = crypto.randomBytes(32).toString('base64url'),
    onDiagnostic = () => {},
  }) {
    this.upstreamBaseUrl = new URL(apiBaseUrl);
    this.apiKey = String(apiKey || '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.token = bridgeToken;
    this.tokenDigest = digestToken(bridgeToken);
    this.onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : () => {};
    this.server = null;
    this.startPromise = null;
    this.baseUrl = '';
    this.port = 0;
    this.sockets = new Set();
    this.upstreamRequests = new Set();
    this.allowedPaths = new Set([
      appendUrlPath(this.upstreamBaseUrl.pathname, 'responses'),
      appendUrlPath(this.upstreamBaseUrl.pathname, 'responses/compact'),
    ]);
  }

  async start() {
    if (this.server?.listening) {
      return this;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startServer().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startServer() {
    const server = http.createServer((request, response) => {
      this.handleRequest(request, response);
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => {
      socket.destroy();
    });

    await new Promise((resolve, reject) => {
      const handleError = (error) => {
        server.off('listening', handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.off('error', handleError);
        resolve();
      };
      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(0, LOOPBACK_HOST);
    });

    this.server = server;
    this.port = Number(server.address()?.port || 0);
    this.baseUrl = buildLoopbackBaseUrl(this.port, this.upstreamBaseUrl.pathname);
    return this;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.baseUrl = '';
    this.port = 0;
    for (const request of this.upstreamRequests) {
      request.destroy();
    }
    this.upstreamRequests.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (!server) {
      return;
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  handleRequest(request, response) {
    if (!this.isAuthorized(request)) {
      request.resume();
      sendBridgeResponse(response, 401, 'Unauthorized', {
        'WWW-Authenticate': 'Bearer realm="igp-codex-bridge"',
      });
      return;
    }
    if (String(request.headers.host || '').toLowerCase() !== `${LOOPBACK_HOST}:${this.port}`) {
      request.resume();
      sendBridgeResponse(response, 403, 'Forbidden');
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      sendBridgeResponse(response, 405, 'Method Not Allowed', {
        Allow: 'POST',
      });
      return;
    }

    let localUrl;
    try {
      localUrl = new URL(request.url || '/', `http://${LOOPBACK_HOST}:${this.port}`);
    } catch {
      request.resume();
      sendBridgeResponse(response, 400, 'Bad Request');
      return;
    }
    if (!this.allowedPaths.has(localUrl.pathname)) {
      request.resume();
      sendBridgeResponse(response, 404, 'Not Found');
      return;
    }

    const upstreamUrl = new URL(this.upstreamBaseUrl.origin);
    upstreamUrl.pathname = localUrl.pathname;
    upstreamUrl.search = localUrl.search;
    const transport = upstreamUrl.protocol === 'https:' ? https : http;
    const upstreamRequest = transport.request(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request.headers, upstreamUrl, this.apiKey),
    }, (upstreamResponse) => {
      if (Number(upstreamResponse.statusCode || 502) >= 400) {
        this.emitDiagnostic(createUpstreamDiagnostic({
          statusCode: upstreamResponse.statusCode,
          headers: upstreamResponse.headers,
        }));
      }
      const closeDownstream = () => {
        if (!response.destroyed) {
          response.destroy();
        }
      };
      upstreamResponse.on('aborted', closeDownstream);
      upstreamResponse.on('error', closeDownstream);
      response.writeHead(
        upstreamResponse.statusCode || 502,
        filterResponseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
    });
    this.upstreamRequests.add(upstreamRequest);
    upstreamRequest.once('close', () => this.upstreamRequests.delete(upstreamRequest));
    upstreamRequest.setTimeout(this.requestTimeoutMs, () => {
      upstreamRequest.destroy(new Error('Codex API bridge upstream request timed out'));
    });
    upstreamRequest.on('error', (error) => {
      this.emitDiagnostic(createTransportDiagnostic(error));
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendBridgeResponse(response, 502, 'Bad Gateway');
    });
    request.on('aborted', () => upstreamRequest.destroy());
    response.on('close', () => {
      if (!response.writableEnded) {
        upstreamRequest.destroy();
      }
    });
    request.pipe(upstreamRequest);
  }

  isAuthorized(request) {
    const authorization = String(request.headers.authorization || '');
    const match = authorization.match(/^Bearer ([A-Za-z0-9_-]+)$/);
    if (!match) {
      return false;
    }
    return crypto.timingSafeEqual(digestToken(match[1]), this.tokenDigest);
  }

  emitDiagnostic(diagnostic) {
    try {
      this.onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never interrupt a proxied request.
    }
  }
}

function appendUrlPath(basePath, suffix) {
  const normalizedBase = String(basePath || '/').replace(/\/+$/, '');
  return `${normalizedBase === '/' ? '' : normalizedBase}/${suffix}`;
}

function buildLoopbackBaseUrl(port, upstreamPath) {
  const normalizedPath = String(upstreamPath || '/').replace(/\/+$/, '');
  return `http://${LOOPBACK_HOST}:${port}${normalizedPath === '/' ? '' : normalizedPath}`;
}

function buildUpstreamHeaders(source, upstreamUrl, apiKey) {
  const headers = {};
  for (const [name, value] of Object.entries(source || {})) {
    const normalizedName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalizedName)
      || normalizedName === 'authorization'
      || normalizedName === 'host'
    ) {
      continue;
    }
    headers[name] = value;
  }
  headers.host = upstreamUrl.host;
  headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function filterResponseHeaders(source) {
  const headers = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return headers;
}

function digestToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest();
}

function createUpstreamDiagnostic({ statusCode, headers }) {
  const normalizedStatusCode = Number(statusCode) || 502;
  const upstreamCode = extractUpstreamErrorCode(headers);
  return {
    type: 'upstream_response',
    statusCode: normalizedStatusCode,
    category: getUpstreamResponseCategory(normalizedStatusCode, upstreamCode),
    upstreamCode,
    requestIdFingerprint: fingerprintRequestId(headers),
  };
}

function createTransportDiagnostic(error) {
  const code = String(error?.code || '').trim().toLowerCase().slice(0, 80);
  return {
    type: 'upstream_transport',
    statusCode: 0,
    category: code === 'etimedout' ? 'upstream_timeout' : 'upstream_connection_failure',
    upstreamCode: code,
    requestIdFingerprint: '',
  };
}

function extractUpstreamErrorCode(headers) {
  return normalizeDiagnosticToken(getHeaderValue(headers, [
    'x-error-code',
    'openai-error-code',
  ]));
}

function getUpstreamResponseCategory(statusCode, upstreamCode) {
  if (/model.*(not.*(found|available)|unavailable|unsupported)|unsupported.*model/.test(upstreamCode)) {
    return 'upstream_model_unavailable';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'upstream_authentication_failure';
  }
  if (statusCode === 429) {
    return 'upstream_rate_limited';
  }
  if (statusCode >= 500) {
    return 'upstream_gateway_failure';
  }
  if (statusCode >= 400) {
    return 'upstream_request_rejected';
  }
  return 'upstream_unexpected_response';
}

function normalizeDiagnosticToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 120);
}

function fingerprintRequestId(headers) {
  const requestId = getHeaderValue(headers, [
    'x-request-id',
    'request-id',
    'openai-request-id',
    'x-amzn-requestid',
  ]);
  return requestId
    ? crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 12)
    : '';
}

function getHeaderValue(headers, names) {
  for (const name of names) {
    const value = headers?.[name];
    const text = Array.isArray(value) ? value[0] : value;
    if (text) {
      return String(text);
    }
  }
  return '';
}

function sendBridgeResponse(response, statusCode, message, headers = {}) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    ...headers,
  });
  response.end(message);
}
