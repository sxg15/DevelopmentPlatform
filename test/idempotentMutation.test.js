import assert from 'node:assert/strict';
import test from 'node:test';

import { findIdempotentMutation } from '../server/runtime/idempotentMutation.js';
import { createMutationFingerprint } from '../server/runtime/mutationFingerprint.js';

test('mutation fingerprints are deterministic for normalized payloads', () => {
  const payload = {
    projectId: '50',
    toolId: 'requirements',
    recordId: 'record-1',
    content: '处理完成',
    notifyMentioned: false,
  };
  assert.equal(
    createMutationFingerprint(payload),
    createMutationFingerprint({ ...payload }),
  );
  assert.notEqual(
    createMutationFingerprint(payload),
    createMutationFingerprint({ ...payload, content: '另一条留言' }),
  );
});

test('idempotent mutations match the same actor and reject payload reuse', () => {
  const existing = {
    clientMutationId: 'mutation-1',
    mutationFingerprint: 'fingerprint-1',
    authorOpenId: 'ou-owner',
  };
  assert.equal(findIdempotentMutation({
    items: [existing],
    clientMutationId: 'mutation-1',
    mutationFingerprint: 'fingerprint-1',
    belongsToActor: (item) => item.authorOpenId === 'ou-owner',
  }), existing);
  assert.equal(findIdempotentMutation({
    items: [existing],
    clientMutationId: 'mutation-1',
    mutationFingerprint: 'fingerprint-1',
    belongsToActor: () => false,
  }), null);
  assert.throws(() => findIdempotentMutation({
    items: [existing],
    clientMutationId: 'mutation-1',
    mutationFingerprint: 'fingerprint-2',
    belongsToActor: () => true,
    conflictMessage: '留言幂等键冲突',
  }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /幂等键冲突/);
    return true;
  });
});
