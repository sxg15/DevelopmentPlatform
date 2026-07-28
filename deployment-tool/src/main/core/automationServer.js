import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AUTOMATION_HOST } from '../../shared/constants.js';

const MAX_BODY_BYTES = 256 * 1024;

export class AutomationServer {
  constructor({ controller, metadataPath }) {
    this.controller = controller;
    this.metadataPath = path.resolve(metadataPath);
    this.token = crypto.randomBytes(32).toString('base64url');
    this.server = null;
  }

  async start() {
    if (this.server) {
      return this.readMetadata();
    }
    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        sendJson(response, 500, {
          message: error instanceof Error ? error.message : '自动化服务异常',
        });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, AUTOMATION_HOST, resolve);
    });
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const metadata = {
      schemaVersion: 1,
      pid: process.pid,
      host: AUTOMATION_HOST,
      port,
      token: this.token,
      startedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.metadataPath), { recursive: true });
    fs.writeFileSync(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return metadata;
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    fs.rmSync(this.metadataPath, { force: true });
  }

  readMetadata() {
    return JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
  }

  async handleRequest(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      request.socket.remoteAddress !== '127.0.0.1'
      && request.socket.remoteAddress !== '::1'
      && request.socket.remoteAddress !== '::ffff:127.0.0.1'
    ) {
      sendJson(response, 403, { message: '自动化接口只允许本机访问' });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      sendJson(response, 401, { message: '自动化凭据无效' });
      return;
    }
    const requestUrl = new URL(request.url || '/', `http://${AUTOMATION_HOST}`);
    if (request.method === 'POST' && requestUrl.pathname === '/v1/deploy') {
      const payload = await readJson(request);
      const job = this.controller.createDeployJob({
        targetId: String(payload.targetId || ''),
        sourcePath: String(payload.sourcePath || ''),
        sourceType: payload.sourceType === 'publish' ? 'publish' : 'repository',
      });
      sendJson(response, 202, job);
      return;
    }
    const jobMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (request.method === 'GET' && jobMatch) {
      sendJson(response, 200, this.controller.getJob(jobMatch[1]));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/state') {
      sendJson(response, 200, await this.controller.getState());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/target/status') {
      sendJson(
        response,
        200,
        await this.controller.refreshTarget(requestUrl.searchParams.get('targetId')),
      );
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/v1/target/log') {
      sendJson(response, 200, await this.controller.readLog(
        requestUrl.searchParams.get('targetId'),
        requestUrl.searchParams.get('name'),
        {
          limit: Number(requestUrl.searchParams.get('limit')) || 256 * 1024,
        },
      ));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/target/action') {
      const payload = await readJson(request);
      sendJson(
        response,
        200,
        await this.controller.runTargetAction(payload.targetId, payload.action),
      );
      return;
    }
    sendJson(response, 404, { message: 'Not found' });
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('自动化请求过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('自动化请求 JSON 无效'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  if (response.headersSent) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}
