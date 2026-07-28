import path from 'node:path';

export function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

export function normalizeName(value, fallback = '') {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return (text || fallback).slice(0, 80);
}

export function normalizeTargetId(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{5,63}$/.test(text) ? text : '';
}

export function normalizeReleaseId(value) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(text) ? text : '';
}

export function normalizeSha256(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

export function normalizeRelativeArchivePath(value) {
  const text = String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (
    !text
    || text.startsWith('/')
    || text.includes('\0')
    || text.split('/').some((part) => !part || part === '.' || part === '..')
    || path.win32.isAbsolute(text)
  ) {
    return '';
  }
  return text;
}

export function redactPathForDisplay(value) {
  const resolved = path.resolve(String(value || ''));
  return path.basename(resolved) || resolved;
}
