import fs from 'node:fs';
import path from 'node:path';
import { LOG_READ_MAX_BYTES } from '../../shared/constants.js';

export function readLogChunk(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return {
      offset: 0,
      nextOffset: 0,
      size: 0,
      text: '',
      truncated: false,
    };
  }

  const size = fs.statSync(resolved).size;
  const requestedOffset = Number(options.offset);
  const tailBytes = Math.min(
    Math.max(1, Number(options.limit) || 128 * 1024),
    LOG_READ_MAX_BYTES,
  );
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
    ? Math.min(requestedOffset, size)
    : Math.max(0, size - tailBytes);
  const length = Math.min(tailBytes, size - offset);
  if (length <= 0) {
    return {
      offset,
      nextOffset: offset,
      size,
      text: '',
      truncated: offset > 0,
    };
  }

  const buffer = Buffer.allocUnsafe(length);
  const descriptor = fs.openSync(resolved, 'r');
  try {
    fs.readSync(descriptor, buffer, 0, length, offset);
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    offset,
    nextOffset: offset + length,
    size,
    text: buffer.toString('utf8'),
    truncated: offset > 0,
  };
}

export function rotateLogIfNeeded(filePath, maxBytes = 20 * 1024 * 1024) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= maxBytes) {
    return false;
  }
  const backupPath = `${filePath}.1`;
  fs.rmSync(backupPath, { force: true });
  fs.renameSync(filePath, backupPath);
  return true;
}

export function findStartupErrors(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => (
      /\b(?:error|exception|unhandled|fatal|eaddrinuse|syntaxerror|typeerror|referenceerror)\b/i.test(line)
      && !/^Debugger listening on /i.test(line)
    ));
}
