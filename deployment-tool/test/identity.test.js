import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAccessToken,
  createPairingCode,
  ensureTargetIdentity,
  hashAccessToken,
  timingSafeTokenMatch,
} from '../src/main/core/identity.js';

test('target identity persists its certificate fingerprint and token hashes compare safely', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-target-identity-'));
  try {
    const first = await ensureTargetIdentity(tempDir, { displayName: 'Test Target' });
    const second = await ensureTargetIdentity(tempDir, {});
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.targetId, second.targetId);
    assert.equal(first.fingerprint.length, 64);

    const token = createAccessToken();
    const hash = hashAccessToken(token);
    assert.equal(timingSafeTokenMatch(token, hash), true);
    assert.equal(timingSafeTokenMatch(`${token}x`, hash), false);
    assert.match(createPairingCode(1).code, /^\d{6}$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
