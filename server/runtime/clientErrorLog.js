import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeClientErrorPayload } from '../../shared/clientErrorUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLIENT_ERROR_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const clientErrorLogFilePath = path.resolve(__dirname, '../../logs/client-errors.log');

export function createClientErrorLogEntry(payload, context = {}) {
  const normalized = normalizeClientErrorPayload({
    ...payload,
    userAgent: context.userAgent || payload?.userAgent || '',
  });

  return {
    ...normalized,
    diagnosticId: normalized.diagnosticId || `server-${crypto.randomUUID().slice(0, 8)}`,
    receivedAt: Number.isFinite(Number(context.receivedAt))
      ? Math.floor(Number(context.receivedAt))
      : Date.now(),
    authenticated: Boolean(context.authenticated),
  };
}

export function writeClientErrorLog(payload, context = {}, logger = console.error, options = {}) {
  const entry = createClientErrorLogEntry(payload, context);
  const message = `[client-error] ${JSON.stringify(entry)}`;

  try {
    logger(message);
  } catch {
    // Local persistence must remain available if a custom console logger fails.
  }

  const writeResult = appendClientErrorLogLine(message, options);
  if (!writeResult.ok) {
    try {
      logger(`[client-error-log-failed] ${writeResult.message}`);
    } catch {
      // Logging failures must never break the client error report endpoint.
    }
  }

  return entry;
}

export function appendClientErrorLogLine(message, options = {}) {
  const logFilePath = path.resolve(String(options.logFilePath || clientErrorLogFilePath));
  const configuredMaxBytes = Number(options.maxBytes);
  const maxBytes = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? Math.floor(configuredMaxBytes)
    : DEFAULT_CLIENT_ERROR_LOG_MAX_BYTES;
  const line = `${String(message || '').replace(/\r?\n/g, ' ')}\n`;

  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    rotateClientErrorLogIfNeeded(logFilePath, Buffer.byteLength(line, 'utf8'), maxBytes);
    fs.appendFileSync(logFilePath, line, 'utf8');
    return { ok: true, logFilePath };
  } catch (error) {
    return {
      ok: false,
      logFilePath,
      message: error instanceof Error ? error.message : '写入客户端异常日志失败',
    };
  }
}

export function createClientErrorRateLimiter(options = {}) {
  const limit = Math.max(1, Number(options.limit) || 20);
  const windowMs = Math.max(1000, Number(options.windowMs) || 60 * 1000);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const clients = new Map();

  return function allowClientErrorReport(clientKey) {
    const key = String(clientKey || 'unknown').slice(0, 200);
    const timestamp = Number(now());
    const current = clients.get(key);

    if (!current || timestamp - current.startedAt >= windowMs) {
      clients.set(key, { startedAt: timestamp, count: 1 });
      cleanupExpiredClients(clients, timestamp, windowMs);
      return true;
    }

    current.count += 1;
    return current.count <= limit;
  };
}

function rotateClientErrorLogIfNeeded(logFilePath, incomingBytes, maxBytes) {
  if (!fs.existsSync(logFilePath)) {
    return;
  }

  const currentSize = fs.statSync(logFilePath).size;
  if (currentSize + incomingBytes <= maxBytes) {
    return;
  }

  const backupPath = `${logFilePath}.1`;
  fs.rmSync(backupPath, { force: true });
  fs.renameSync(logFilePath, backupPath);
}

function cleanupExpiredClients(clients, timestamp, windowMs) {
  if (clients.size <= 500) {
    return;
  }

  for (const [key, entry] of clients) {
    if (timestamp - entry.startedAt >= windowMs) {
      clients.delete(key);
    }
  }
}
