import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PAIRING_CODE_TTL_MS,
  PROTOCOL_VERSION,
  TARGET_CONTROL_PORT,
  TARGET_LOGS,
} from '../../shared/constants.js';
import { normalizeName, normalizePort } from '../../shared/validation.js';
import { appendAuditEntry } from './auditLog.js';
import { DeploymentStore } from './deploymentStore.js';
import { TargetDiscoveryResponder } from './discovery.js';
import {
  createAccessToken,
  createPairingCode,
  ensureTargetIdentity,
  hashAccessToken,
  timingSafeTokenMatch,
} from './identity.js';
import { JsonStore } from './jsonStore.js';
import { readLogChunk } from './logReader.js';
import { listLanIPv4Addresses } from './network.js';
import { ServiceManager } from './serviceManager.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class TargetAgent extends EventEmitter {
  constructor({
    userDataDir,
    deploymentRoot,
    appVersion,
    serviceManager,
  }) {
    super();
    this.userDataDir = path.resolve(userDataDir);
    this.appVersion = String(appVersion || '0.0.0');
    this.settingsStore = new JsonStore(path.join(this.userDataDir, 'target-settings.json'), {
      schemaVersion: 1,
      targetId: '',
      displayName: '',
      controlPort: TARGET_CONTROL_PORT,
      pairingEnabled: true,
      pairedClients: [],
    });
    this.deploymentRoot = path.resolve(
      deploymentRoot || path.join(this.userDataDir, 'managed-runtime'),
    );
    this.deploymentStore = new DeploymentStore(this.deploymentRoot);
    this.serviceManager = serviceManager || new ServiceManager(this.deploymentStore);
    this.identity = null;
    this.pairing = null;
    this.server = null;
    this.discovery = null;
    this.debugWebSocketServer = new WebSocketServer({ noServer: true });
    this.operation = Promise.resolve();
    this.pairAttempts = new Map();
    this.pairingTimer = null;
  }

  async start() {
    if (this.server) {
      return this.getLocalState();
    }
    const settings = this.settingsStore.read();
    this.identity = await ensureTargetIdentity(
      path.join(this.userDataDir, 'identity'),
      settings,
    );
    this.settingsStore.update((value) => {
      value.targetId = this.identity.targetId;
      value.displayName = this.identity.displayName;
      value.controlPort = normalizePort(value.controlPort, TARGET_CONTROL_PORT);
      return value;
    });
    if (settings.pairingEnabled !== false) {
      this.refreshPairingCode({ emit: false });
    }

    this.server = https.createServer({
      key: this.identity.key,
      cert: this.identity.cert,
      minVersion: 'TLSv1.2',
    }, (request, response) => {
      this.handleRequest(request, response).catch((error) => {
        sendJson(response, 500, {
          message: error instanceof Error ? error.message : '目标端发生异常',
        });
      });
    });
    this.server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head).catch(() => socket.destroy());
    });
    const port = this.settingsStore.read().controlPort;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '0.0.0.0', resolve);
    });

    this.discovery = new TargetDiscoveryResponder(() => this.getAnnouncement());
    this.discovery.start();
    this.pairingTimer = setInterval(() => {
      const settingsNow = this.settingsStore.read();
      if (settingsNow.pairingEnabled && !this.getPairingCode()) {
        this.refreshPairingCode();
      }
    }, 30_000);
    this.pairingTimer.unref();
    return this.getLocalState();
  }

  async stop() {
    this.discovery?.stop();
    this.discovery = null;
    clearInterval(this.pairingTimer);
    this.pairingTimer = null;
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    await this.operation.catch(() => {});
    await this.serviceManager.stop();
    for (const client of this.debugWebSocketServer.clients) {
      client.terminate();
    }
  }

  getAnnouncement() {
    const settings = this.settingsStore.read();
    return {
      targetId: this.identity.targetId,
      displayName: settings.displayName,
      port: settings.controlPort,
      fingerprint: this.identity.fingerprint,
      toolVersion: this.appVersion,
      pairingAvailable: Boolean(settings.pairingEnabled && this.getPairingCode()),
    };
  }

  async getLocalState(options = {}) {
    const settings = this.settingsStore.read();
    const service = await this.serviceManager.getStatus({
      includeHealth: options.includeHealth !== false,
    });
    return {
      mode: 'target',
      protocolVersion: PROTOCOL_VERSION,
      targetId: this.identity?.targetId || settings.targetId,
      displayName: settings.displayName,
      controlPort: settings.controlPort,
      fingerprint: this.identity?.fingerprint || '',
      addresses: listLanIPv4Addresses(),
      pairingEnabled: settings.pairingEnabled,
      pairingCode: this.getPairingCode(),
      pairedClients: settings.pairedClients.map(({ tokenHash, ...client }) => client),
      deployment: this.deploymentStore.getState(),
      service,
    };
  }

  setPairingEnabled(enabled) {
    this.settingsStore.update((settings) => {
      settings.pairingEnabled = Boolean(enabled);
      return settings;
    });
    if (enabled) {
      this.refreshPairingCode();
    } else {
      this.pairing = null;
    }
    this.emitState();
  }

  refreshPairingCode(options = {}) {
    this.pairing = createPairingCode();
    if (options.emit !== false) {
      this.emitState();
    }
    return this.pairing.code;
  }

  getPairingCode() {
    const settings = this.settingsStore.read();
    if (
      !settings.pairingEnabled
      || !this.pairing
      || Date.now() - this.pairing.createdAt >= PAIRING_CODE_TTL_MS
    ) {
      return '';
    }
    return this.pairing.code;
  }

  revokeClient(clientId) {
    this.settingsStore.update((settings) => {
      settings.pairedClients = settings.pairedClients.filter((client) => client.clientId !== clientId);
      return settings;
    });
    this.emitState();
  }

  importExistingConfig(publishDir) {
    const sourceDir = path.resolve(publishDir);
    this.deploymentStore.importConfig(path.join(sourceDir, 'config.json'));
    const examplePath = path.join(sourceDir, 'config.example.json');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, this.deploymentStore.exampleConfigPath);
    }
    this.emitState();
  }

  readLocalLog(name, options) {
    return this.readLog(name, options);
  }

  async runLocalAction(action) {
    return this.queueOperation(async () => {
      if (action === 'start') {
        return this.serviceManager.start();
      }
      if (action === 'stop') {
        return this.serviceManager.stop();
      }
      if (action === 'restart') {
        return this.serviceManager.restart();
      }
      if (action === 'rollback') {
        await this.serviceManager.stop();
        const releaseId = this.deploymentStore.rollback();
        const service = await this.serviceManager.start();
        return { releaseId, service };
      }
      throw new Error('未知的目标端操作');
    });
  }

  async handleRequest(request, response) {
    applySecurityHeaders(response);
    const requestUrl = new URL(request.url || '/', `https://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && requestUrl.pathname === '/api/v1/identity') {
      sendJson(response, 200, {
        protocolVersion: PROTOCOL_VERSION,
        targetId: this.identity.targetId,
        displayName: this.settingsStore.read().displayName,
        fingerprint: this.identity.fingerprint,
        pairingAvailable: Boolean(this.getPairingCode()),
      });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/pair') {
      await this.handlePair(request, response);
      return;
    }

    const client = this.authenticate(request);
    if (!client) {
      sendJson(response, 401, { message: '连接凭据无效' });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/v1/status') {
      sendJson(response, 200, await this.buildRemoteStatus());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/v1/logs') {
      sendJson(response, 200, this.readLog(requestUrl.searchParams.get('name'), {
        offset: requestUrl.searchParams.get('offset'),
        limit: requestUrl.searchParams.get('limit'),
      }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/uploads') {
      const upload = this.deploymentStore.createUpload(await readJson(request));
      this.audit(client, 'upload-create', 'ok', { message: upload.uploadId });
      sendJson(response, 201, upload);
      return;
    }

    const uploadDeleteMatch = requestUrl.pathname.match(/^\/api\/v1\/uploads\/([^/]+)$/);
    if (request.method === 'DELETE' && uploadDeleteMatch) {
      this.deploymentStore.removeUpload(uploadDeleteMatch[1]);
      this.audit(client, 'upload-remove', 'ok', { message: uploadDeleteMatch[1] });
      sendJson(response, 200, { ok: true });
      return;
    }

    const chunkMatch = requestUrl.pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/chunks\/(\d+)$/);
    if (request.method === 'PUT' && chunkMatch) {
      const upload = this.deploymentStore.readUpload(chunkMatch[1]);
      const body = await readBody(request, upload.chunkBytes);
      const result = this.deploymentStore.writeChunk(
        chunkMatch[1],
        chunkMatch[2],
        body,
        request.headers['x-chunk-sha256'],
      );
      sendJson(response, 200, result);
      return;
    }

    const finalizeMatch = requestUrl.pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/finalize$/);
    if (request.method === 'POST' && finalizeMatch) {
      const result = await this.queueOperation(() => this.finalizeAndDeploy(finalizeMatch[1], client));
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/service/start') {
      const result = await this.queueOperation(() => this.serviceManager.start());
      this.audit(client, 'service-start', 'ok');
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/service/stop') {
      const result = await this.queueOperation(() => this.serviceManager.stop());
      this.audit(client, 'service-stop', 'ok');
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/service/restart') {
      const result = await this.queueOperation(() => this.serviceManager.restart());
      this.audit(client, 'service-restart', 'ok');
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/releases/rollback') {
      const result = await this.queueOperation(async () => {
        await this.serviceManager.stop();
        const releaseId = this.deploymentStore.rollback();
        const service = await this.serviceManager.start();
        const checks = await this.serviceManager.runPostDeployChecks();
        return { releaseId, service, checks };
      });
      this.audit(client, 'release-rollback', 'ok', { releaseId: result.releaseId });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/v1/debug') {
      const metadata = await this.serviceManager.getInspectorMetadata();
      sendJson(response, 200, {
        ...metadata,
        webSocketDebuggerUrl: `wss://${request.headers.host}/api/v1/debug/socket`,
      });
      return;
    }
    sendJson(response, 404, { message: 'Not found' });
  }

  async handlePair(request, response) {
    const remoteAddress = String(request.socket.remoteAddress || '');
    if (!this.allowPairAttempt(remoteAddress)) {
      sendJson(response, 429, { message: '配对尝试过于频繁' });
      return;
    }
    const settings = this.settingsStore.read();
    const payload = await readJson(request);
    const pairingCode = this.getPairingCode();
    if (!settings.pairingEnabled || !pairingCode || String(payload?.code || '') !== pairingCode) {
      sendJson(response, 403, { message: '配对码无效或已过期' });
      return;
    }
    const clientId = normalizeClientId(payload?.clientId);
    if (!clientId) {
      sendJson(response, 400, { message: '开发端标识无效' });
      return;
    }
    const token = createAccessToken();
    const client = {
      clientId,
      clientName: normalizeName(payload?.clientName, '开发电脑'),
      tokenHash: hashAccessToken(token),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.settingsStore.update((value) => {
      value.pairedClients = value.pairedClients.filter((item) => item.clientId !== clientId);
      value.pairedClients.push(client);
      return value;
    });
    this.refreshPairingCode();
    this.audit(client, 'pair', 'ok');
    sendJson(response, 201, {
      targetId: this.identity.targetId,
      displayName: settings.displayName,
      fingerprint: this.identity.fingerprint,
      token,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  authenticate(request) {
    const authorization = String(request.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token) {
      return null;
    }
    const settings = this.settingsStore.read();
    const client = settings.pairedClients.find((item) => timingSafeTokenMatch(token, item.tokenHash));
    if (!client) {
      return null;
    }
    const now = new Date().toISOString();
    if (!client.lastSeenAt || Date.now() - Date.parse(client.lastSeenAt) > 60_000) {
      this.settingsStore.update((value) => {
        const current = value.pairedClients.find((item) => item.clientId === client.clientId);
        if (current) {
          current.lastSeenAt = now;
        }
        return value;
      });
    }
    return client;
  }

  async buildRemoteStatus() {
    const state = await this.getLocalState();
    return {
      protocolVersion: PROTOCOL_VERSION,
      targetId: state.targetId,
      displayName: state.displayName,
      toolVersion: this.appVersion,
      fingerprint: state.fingerprint,
      addresses: state.addresses,
      deployment: state.deployment,
      service: state.service,
    };
  }

  async finalizeAndDeploy(uploadId, client) {
    const before = this.deploymentStore.getState();
    const manifest = await this.deploymentStore.finalizeUpload(uploadId);
    this.audit(client, 'release-install', 'ok', { releaseId: manifest.releaseId });
    let stopped = false;
    try {
      await this.serviceManager.stop();
      stopped = true;
      this.deploymentStore.activateRelease(manifest.releaseId);
      const service = await this.serviceManager.start();
      const checks = await this.serviceManager.runPostDeployChecks();
      this.deploymentStore.pruneReleases();
      this.audit(client, 'release-deploy', 'ok', { releaseId: manifest.releaseId });
      this.emitState();
      return { manifest, service, checks };
    } catch (error) {
      if (before.currentReleaseId) {
        this.deploymentStore.restoreActivation(before.currentReleaseId, before.previousReleaseId);
        if (stopped) {
          try {
            await this.serviceManager.start();
          } catch {
            // Preserve the original deployment failure.
          }
        }
      }
      this.audit(client, 'release-deploy', 'failed', {
        releaseId: manifest.releaseId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.emitState();
      throw error;
    }
  }

  async handleUpgrade(request, socket, head) {
    const requestUrl = new URL(request.url || '/', `https://${request.headers.host || 'localhost'}`);
    if (requestUrl.pathname !== '/api/v1/debug/socket') {
      socket.destroy();
      return;
    }
    const client = this.authenticate(request);
    if (!client) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const metadata = await this.serviceManager.getInspectorMetadata();
    this.debugWebSocketServer.handleUpgrade(request, socket, head, (downstream) => {
      const upstream = new WebSocket(metadata.webSocketDebuggerUrl);
      upstream.on('open', () => {
        downstream.on('message', (data, binary) => upstream.send(data, { binary }));
        upstream.on('message', (data, binary) => downstream.send(data, { binary }));
      });
      const closeBoth = () => {
        if (downstream.readyState < WebSocket.CLOSING) {
          downstream.close();
        }
        if (upstream.readyState < WebSocket.CLOSING) {
          upstream.close();
        }
      };
      downstream.on('close', closeBoth);
      downstream.on('error', closeBoth);
      upstream.on('close', closeBoth);
      upstream.on('error', closeBoth);
      this.audit(client, 'debug-attach', 'ok');
    });
  }

  readLog(name, options) {
    const fileName = TARGET_LOGS[name] || '';
    if (!fileName) {
      throw new Error('日志类型无效');
    }
    return {
      name,
      ...readLogChunk(path.join(this.deploymentStore.logsDir, fileName), options),
    };
  }

  queueOperation(task) {
    const run = this.operation.then(task, task);
    this.operation = run.catch(() => {});
    return run.finally(() => this.emitState());
  }

  audit(client, action, outcome, details = {}) {
    appendAuditEntry(
      path.join(this.deploymentStore.logsDir, TARGET_LOGS.audit),
      {
        action,
        outcome,
        clientId: client?.clientId,
        clientName: client?.clientName,
        ...details,
      },
    );
  }

  allowPairAttempt(address) {
    const now = Date.now();
    const attempts = (this.pairAttempts.get(address) || []).filter((item) => now - item < 60_000);
    attempts.push(now);
    this.pairAttempts.set(address, attempts);
    return attempts.length <= 8;
  }

  emitState() {
    this.getLocalState()
      .then((state) => this.emit('state', state))
      .catch(() => {});
  }
}

function normalizeClientId(value) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,99}$/.test(text) ? text : '';
}

function readJson(request) {
  return readBody(request, MAX_JSON_BODY_BYTES).then((body) => {
    try {
      return JSON.parse(body.toString('utf8') || '{}');
    } catch {
      throw new Error('请求 JSON 格式无效');
    }
  });
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  if (response.headersSent) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

function applySecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}
