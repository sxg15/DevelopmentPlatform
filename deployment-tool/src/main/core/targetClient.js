import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UPLOAD_CHUNK_BYTES } from '../../shared/constants.js';
import { normalizeSha256 } from '../../shared/validation.js';

export class TargetClient extends EventEmitter {
  constructor(target) {
    super();
    this.target = {
      address: String(target.address || ''),
      port: Number(target.port),
      fingerprint: normalizeSha256(target.fingerprint),
      token: String(target.token || ''),
      targetId: String(target.targetId || ''),
    };
  }

  pair({ code, clientId, clientName }) {
    return this.request('POST', '/api/v1/pair', {
      body: { code, clientId, clientName },
      authenticated: false,
    });
  }

  getStatus() {
    return this.request('GET', '/api/v1/status');
  }

  readLog(name, options = {}) {
    const query = new URLSearchParams({
      name,
      offset: String(options.offset ?? ''),
      limit: String(options.limit ?? ''),
    });
    return this.request('GET', `/api/v1/logs?${query}`);
  }

  startService() {
    return this.request('POST', '/api/v1/service/start', { body: {} });
  }

  stopService() {
    return this.request('POST', '/api/v1/service/stop', { body: {} });
  }

  restartService() {
    return this.request('POST', '/api/v1/service/restart', { body: {} });
  }

  rollback() {
    return this.request('POST', '/api/v1/releases/rollback', { body: {} });
  }

  getDebugMetadata() {
    return this.request('GET', '/api/v1/debug');
  }

  async uploadAndDeploy(artifact, options = {}) {
    let upload = null;
    upload = await this.request('POST', '/api/v1/uploads', {
      body: {
        totalBytes: artifact.size,
        sha256: artifact.sha256,
      },
    });
    try {
      const descriptor = fs.openSync(path.resolve(artifact.outputPath), 'r');
      try {
        const totalChunks = Math.ceil(artifact.size / UPLOAD_CHUNK_BYTES);
        for (let index = 0; index < totalChunks; index += 1) {
          const offset = index * UPLOAD_CHUNK_BYTES;
          const length = Math.min(UPLOAD_CHUNK_BYTES, artifact.size - offset);
          const buffer = Buffer.allocUnsafe(length);
          fs.readSync(descriptor, buffer, 0, length, offset);
          const chunkSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
          await this.request(
            'PUT',
            `/api/v1/uploads/${encodeURIComponent(upload.uploadId)}/chunks/${index}`,
            {
              rawBody: buffer,
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-Chunk-Sha256': chunkSha256,
              },
            },
          );
          const progress = {
            phase: 'upload',
            currentChunk: index + 1,
            totalChunks,
            uploadedBytes: offset + length,
            totalBytes: artifact.size,
          };
          options.onProgress?.(progress);
          this.emit('progress', progress);
        }
      } finally {
        fs.closeSync(descriptor);
      }
      const result = await this.request(
        'POST',
        `/api/v1/uploads/${encodeURIComponent(upload.uploadId)}/finalize`,
        { body: {}, timeoutMs: 15 * 60 * 1000 },
      );
      upload = null;
      return result;
    } catch (error) {
      if (upload?.uploadId) {
        await this.request(
          'DELETE',
          `/api/v1/uploads/${encodeURIComponent(upload.uploadId)}`,
          { timeoutMs: 30_000 },
        ).catch(() => {});
      }
      throw error;
    }
  }

  request(method, requestPath, options = {}) {
    const body = options.rawBody
      || (options.body === undefined ? null : Buffer.from(JSON.stringify(options.body)));
    const headers = {
      Accept: 'application/json',
      ...(body ? { 'Content-Length': String(body.length) } : {}),
      ...(options.rawBody ? {} : body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };
    if (options.authenticated !== false && this.target.token) {
      headers.Authorization = `Bearer ${this.target.token}`;
    }

    return new Promise((resolve, reject) => {
      const request = https.request({
        hostname: this.target.address,
        port: this.target.port,
        method,
        path: requestPath,
        headers,
        rejectUnauthorized: false,
        agent: false,
        timeout: options.timeoutMs || 60_000,
      }, (response) => {
        try {
          verifyPeerFingerprint(response.socket, this.target.fingerprint);
        } catch (error) {
          response.destroy(error);
          reject(error);
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let payload = {};
          try {
            payload = text ? JSON.parse(text) : {};
          } catch {
            reject(new Error('目标端返回了无效响应'));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(payload.message || `目标端请求失败：HTTP ${response.statusCode}`));
            return;
          }
          resolve(payload);
        });
      });
      request.on('timeout', () => request.destroy(new Error('目标端请求超时')));
      request.on('error', reject);
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }
}

export function verifyPeerFingerprint(socket, expectedFingerprint) {
  const normalizedExpected = normalizeSha256(expectedFingerprint);
  const certificate = socket.getPeerCertificate?.();
  const actual = String(certificate?.fingerprint256 || '').replaceAll(':', '').toLowerCase();
  if (!normalizedExpected || actual !== normalizedExpected) {
    throw new Error('目标端证书指纹与已配对记录不一致');
  }
}

export function probeTarget(address, port, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: String(address || ''),
      port: Number(port),
      method: 'GET',
      path: '/api/v1/identity',
      rejectUnauthorized: false,
      agent: false,
      timeout: options.timeoutMs || 5000,
    }, (response) => {
      const certificate = response.socket.getPeerCertificate?.();
      const fingerprint = String(certificate?.fingerprint256 || '')
        .replaceAll(':', '')
        .toLowerCase();
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (response.statusCode !== 200 || payload.fingerprint !== fingerprint) {
            throw new Error('目标端身份响应校验失败');
          }
          resolve({
            ...payload,
            address: String(address || ''),
            port: Number(port),
            fingerprint,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('连接目标端超时')));
    request.on('error', reject);
    request.end();
  });
}
