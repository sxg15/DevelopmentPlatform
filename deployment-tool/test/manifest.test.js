import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectFileEntries,
  createDeploymentManifest,
  verifyExtractedFiles,
} from '../src/shared/manifest.js';
import {
  normalizeRelativeArchivePath,
  normalizeReleaseId,
  normalizeSha256,
} from '../src/shared/validation.js';

test('deployment manifest verifies declared files and excludes target configuration', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-manifest-'));
  try {
    fs.mkdirSync(path.join(rootDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'server', 'index.js'), 'console.log("ok");\n');
    const files = collectFileEntries(rootDir);
    const manifest = createDeploymentManifest({
      releaseId: '0.2.0-20260728120000-abcdef',
      appVersion: '0.2.0',
      dependencyVersion: 'lock-hash',
      files,
    });
    assert.equal(verifyExtractedFiles(rootDir, manifest).releaseId, manifest.releaseId);

    fs.writeFileSync(path.join(rootDir, 'config.json'), '{}\n');
    assert.throws(() => createDeploymentManifest({
      releaseId: '0.2.0-20260728120000-fedcba',
      appVersion: '0.2.0',
      files: collectFileEntries(rootDir),
    }), /不得包含目标运行配置/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('archive path and identifier normalization reject traversal and malformed hashes', () => {
  assert.equal(normalizeRelativeArchivePath('server/index.js'), 'server/index.js');
  assert.equal(normalizeRelativeArchivePath('../config.json'), '');
  assert.equal(normalizeRelativeArchivePath('server/../config.json'), '');
  assert.equal(normalizeRelativeArchivePath('C:\\secret.txt'), '');
  assert.equal(normalizeReleaseId('release-1.2.3'), 'release-1.2.3');
  assert.equal(normalizeReleaseId('../release'), '');
  assert.equal(normalizeSha256('a'.repeat(64)), 'a'.repeat(64));
  assert.equal(normalizeSha256('not-a-hash'), '');
});
