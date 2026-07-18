import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createClientDiagnosticId,
  normalizeClientErrorPayload,
} from '../shared/clientErrorUtils.js';
import {
  createClientErrorRateLimiter,
  createClientErrorLogEntry,
  writeClientErrorLog,
} from '../server/runtime/clientErrorLog.js';

test('client error payloads remove secrets, queries, and excessive content', () => {
  const payload = normalizeClientErrorPayload({
    diagnosticId: 'client-test',
    source: 'react-error-boundary',
    message: 'request failed?code=secret-code&token=secret-token',
    stack: 'Authorization: Bearer secret-token\n{"access_token":"another-secret"}',
    componentStack: 'at ProjectOverview',
    pagePath: 'https://example.test/workspace?recordId=user-content#details',
    userAgent: 'Feishu WebView',
    occurredAt: 1234,
  });

  assert.equal(payload.diagnosticId, 'client-test');
  assert.equal(payload.pagePath, '/workspace');
  assert.equal(payload.occurredAt, 1234);
  assert.ok(!JSON.stringify(payload).includes('secret-code'));
  assert.ok(!JSON.stringify(payload).includes('secret-token'));
  assert.ok(!JSON.stringify(payload).includes('another-secret'));
  assert.match(payload.stack, /\[REDACTED\]/);
});

test('diagnostic IDs and server log entries remain searchable without identity data', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-client-error-log-'));
  const logFilePath = path.join(tempDir, 'nested', 'client-errors.log');
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(createClientDiagnosticId(1000, 0.5), 'client-rs-4zsov');

  const entry = createClientErrorLogEntry({
    diagnosticId: 'client-known',
    source: 'window-error',
    message: 'render failed',
    pagePath: '/workspace',
    occurredAt: 1000,
  }, {
    receivedAt: 2000,
    authenticated: true,
    userAgent: 'Test WebView',
  });

  assert.deepEqual(entry, {
    diagnosticId: 'client-known',
    source: 'window-error',
    message: 'render failed',
    stack: '',
    componentStack: '',
    pagePath: '/workspace',
    userAgent: 'Test WebView',
    occurredAt: 1000,
    receivedAt: 2000,
    authenticated: true,
  });

  const messages = [];
  const logged = writeClientErrorLog(
    entry,
    { receivedAt: 3000 },
    (message) => messages.push(message),
    { logFilePath },
  );
  assert.equal(logged.diagnosticId, 'client-known');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\[client-error\] /);
  assert.ok(!messages[0].includes('openId'));
  assert.equal(fs.existsSync(logFilePath), true);
  assert.equal(fs.readFileSync(logFilePath, 'utf8'), `${messages[0]}\n`);
});

test('client error files rotate and file failures do not break reporting', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-client-error-rotation-'));
  const logFilePath = path.join(tempDir, 'client-errors.log');
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  writeClientErrorLog({
    diagnosticId: 'client-first',
    source: 'window-error',
    message: 'first error',
    stack: 'x'.repeat(2000),
  }, {}, () => {}, { logFilePath, maxBytes: 500 });
  writeClientErrorLog({
    diagnosticId: 'client-second',
    source: 'window-error',
    message: 'second error',
  }, {}, () => {}, { logFilePath, maxBytes: 500 });

  assert.match(fs.readFileSync(`${logFilePath}.1`, 'utf8'), /client-first/);
  assert.match(fs.readFileSync(logFilePath, 'utf8'), /client-second/);

  const blockedParent = path.join(tempDir, 'blocked');
  fs.writeFileSync(blockedParent, 'not a directory', 'utf8');
  const messages = [];
  const entry = writeClientErrorLog({
    diagnosticId: 'client-write-failed',
    message: 'still return the normalized entry',
  }, {}, (message) => messages.push(message), {
    logFilePath: path.join(blockedParent, 'client-errors.log'),
  });

  assert.equal(entry.diagnosticId, 'client-write-failed');
  assert.equal(messages.length, 2);
  assert.match(messages[1], /^\[client-error-log-failed\] /);
});

test('client error reporting is rate limited per caller and resets by window', () => {
  let now = 1000;
  const allow = createClientErrorRateLimiter({
    limit: 2,
    windowMs: 1000,
    now: () => now,
  });

  assert.equal(allow('caller-a'), true);
  assert.equal(allow('caller-a'), true);
  assert.equal(allow('caller-a'), false);
  assert.equal(allow('caller-b'), true);

  now = 2000;
  assert.equal(allow('caller-a'), true);
});
