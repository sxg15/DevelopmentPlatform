import crypto from 'node:crypto';
import { normalizeClientErrorPayload } from '../../shared/clientErrorUtils.js';

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

export function writeClientErrorLog(payload, context = {}, logger = console.error) {
  const entry = createClientErrorLogEntry(payload, context);
  logger(`[client-error] ${JSON.stringify(entry)}`);
  return entry;
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
