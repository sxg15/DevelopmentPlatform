import {
  createClientDiagnosticId,
  normalizeClientErrorPayload,
} from '../../shared/clientErrorUtils.js';
import { requestJson } from './client.js';

const REPORT_DEDUPLICATION_MS = 5000;
const recentReports = new Map();
let globalReportingInstalled = false;

export function reportClientError(error, details = {}) {
  const errorDetails = getErrorDetails(error);
  const payload = normalizeClientErrorPayload({
    diagnosticId: details.diagnosticId || createClientDiagnosticId(),
    source: details.source || 'unknown',
    message: errorDetails.message,
    stack: errorDetails.stack,
    componentStack: details.componentStack || '',
    pagePath: getCurrentPagePath(),
    userAgent: getUserAgent(),
    occurredAt: Date.now(),
  });

  if (isDuplicateReport(payload)) {
    return Promise.resolve({ skipped: true, diagnosticId: payload.diagnosticId });
  }

  try {
    return requestJson('/api/client-errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
      globalOperation: false,
      detectAuthenticationExpiration: false,
    }).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

export function installGlobalErrorReporting() {
  if (globalReportingInstalled || typeof window === 'undefined') {
    return;
  }
  globalReportingInstalled = true;

  window.addEventListener('error', (event) => {
    const error = event?.error;
    const message = error instanceof Error ? error.message : String(event?.message || '').trim();
    if (!message || isIgnoredBrowserError(message)) {
      return;
    }

    void reportClientError(error instanceof Error ? error : new Error(message), {
      source: 'window-error',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    void reportClientError(event?.reason, {
      source: 'unhandled-rejection',
    });
  });
}

function getErrorDetails(error) {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || '未知客户端异常',
      stack: error.stack || '',
    };
  }

  if (error && typeof error === 'object') {
    return {
      message: String(error.message || error.reason || error.name || '未知客户端异常'),
      stack: String(error.stack || ''),
    };
  }

  return {
    message: String(error || '未知客户端异常'),
    stack: '',
  };
}

function isDuplicateReport(payload) {
  const now = Date.now();
  const key = [payload.source, payload.message, payload.stack].join('|');
  const previousTime = recentReports.get(key);
  recentReports.set(key, now);

  if (recentReports.size > 50) {
    for (const [reportKey, reportTime] of recentReports) {
      if (now - reportTime > REPORT_DEDUPLICATION_MS) {
        recentReports.delete(reportKey);
      }
    }
  }

  return Number.isFinite(previousTime) && now - previousTime < REPORT_DEDUPLICATION_MS;
}

function getCurrentPagePath() {
  return typeof window !== 'undefined' ? window.location?.pathname || '/' : '';
}

function getUserAgent() {
  return typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
}

function isIgnoredBrowserError(message) {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('resizeobserver loop')
    || normalized.includes('script error.');
}
