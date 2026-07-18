import assert from 'node:assert/strict';
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

test('diagnostic IDs and server log entries remain searchable without identity data', () => {
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
  const logged = writeClientErrorLog(entry, { receivedAt: 3000 }, (message) => messages.push(message));
  assert.equal(logged.diagnosticId, 'client-known');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\[client-error\] /);
  assert.ok(!messages[0].includes('openId'));
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
