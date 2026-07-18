export const CLIENT_ERROR_LIMITS = Object.freeze({
  diagnosticId: 80,
  source: 80,
  message: 1000,
  stack: 6000,
  componentStack: 4000,
  pagePath: 500,
  userAgent: 500,
});

const SENSITIVE_ASSIGNMENT_PATTERN = /((?:authorization|app[_-]?secret|access[_-]?token|tenant[_-]?access[_-]?token|refresh[_-]?token|session(?:[_-]?id)?|cookie)["']?\s*[:=]\s*)(["']?)[^,\s;"']+\2/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:code|token|access_?token|refresh_?token|tenant_?access_?token|app_?secret)=)[^&#\s]+/gi;

export function createClientDiagnosticId(now = Date.now(), randomValue = Math.random()) {
  const timestamp = Math.max(0, Number(now) || 0).toString(36);
  const random = Math.floor(Math.max(0, Math.min(0.999999999, Number(randomValue) || 0)) * 0xFFFFFF)
    .toString(36)
    .padStart(5, '0');
  return `client-${timestamp}-${random}`;
}

export function normalizeClientErrorPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const occurredAt = Number(source.occurredAt);

  return {
    diagnosticId: sanitizeSingleLine(source.diagnosticId, CLIENT_ERROR_LIMITS.diagnosticId),
    source: sanitizeSingleLine(source.source, CLIENT_ERROR_LIMITS.source) || 'unknown',
    message: sanitizeClientErrorText(source.message, CLIENT_ERROR_LIMITS.message) || '未知客户端异常',
    stack: sanitizeClientErrorText(source.stack, CLIENT_ERROR_LIMITS.stack, true),
    componentStack: sanitizeClientErrorText(
      source.componentStack,
      CLIENT_ERROR_LIMITS.componentStack,
      true,
    ),
    pagePath: sanitizePagePath(source.pagePath),
    userAgent: sanitizeSingleLine(source.userAgent, CLIENT_ERROR_LIMITS.userAgent),
    occurredAt: Number.isFinite(occurredAt) && occurredAt > 0 ? Math.floor(occurredAt) : 0,
  };
}

export function sanitizeClientErrorText(value, maxLength, preserveLines = false) {
  const limit = Math.max(0, Number(maxLength) || 0);
  if (limit === 0) {
    return '';
  }

  let text = String(value ?? '')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY_PATTERN, '$1[REDACTED]')
    .replace(/\u0000/g, '');

  text = preserveLines
    ? text
        .replace(/\r\n?/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim()
    : text.replace(/\s+/g, ' ').trim();

  return text.slice(0, limit);
}

function sanitizeSingleLine(value, maxLength) {
  return sanitizeClientErrorText(value, maxLength, false);
}

function sanitizePagePath(value) {
  let text = String(value ?? '').trim();
  if (!text) {
    return '';
  }

  try {
    text = new URL(text, 'http://client.local').pathname;
  } catch {
    text = text.split(/[?#]/, 1)[0];
  }

  return sanitizeSingleLine(text, CLIENT_ERROR_LIMITS.pagePath);
}
