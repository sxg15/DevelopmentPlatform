import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as tar from 'tar';
import {
  DEPLOYMENT_MANIFEST_FILE,
  collectFileEntries,
  createDeploymentManifest,
  hashFile,
} from '../src/shared/manifest.js';
import { DeploymentStore } from '../src/main/core/deploymentStore.js';

test('deployment store accepts a verified upload, activates releases, and rolls back', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-deployment-store-'));
  const sourceDir = path.join(tempDir, 'source');
  const archivePath = path.join(tempDir, 'release.tgz');
  const runtimeDir = path.join(tempDir, 'runtime');
  try {
    createFakeRelease(sourceDir, '0.2.0-20260728123000-aabbcc', '0.2.0');
    await tar.c({
      cwd: sourceDir,
      file: archivePath,
      gzip: true,
      portable: true,
      noMtime: true,
    }, ['.']);

    const store = new DeploymentStore(runtimeDir);
    const archive = fs.readFileSync(archivePath);
    const upload = store.createUpload({
      totalBytes: archive.length,
      sha256: crypto.createHash('sha256').update(archive).digest('hex'),
    });
    store.writeChunk(
      upload.uploadId,
      0,
      archive,
      crypto.createHash('sha256').update(archive).digest('hex'),
    );
    const installed = await store.finalizeUpload(upload.uploadId);
    assert.equal(installed.appVersion, '0.2.0');
    store.activateRelease(installed.releaseId);
    assert.equal(store.getState().currentReleaseId, installed.releaseId);

    const secondId = '0.2.1-20260728130000-ddeeff';
    createFakeRelease(path.join(tempDir, 'second'), secondId, '0.2.1');
    fs.cpSync(path.join(tempDir, 'second'), store.getReleasePath(secondId), { recursive: true });
    store.registerRelease(JSON.parse(
      fs.readFileSync(path.join(tempDir, 'second', DEPLOYMENT_MANIFEST_FILE), 'utf8'),
    ));
    store.activateRelease(secondId);
    assert.equal(store.getState().previousReleaseId, installed.releaseId);
    assert.equal(store.rollback(), installed.releaseId);
    assert.equal(store.getState().currentReleaseId, installed.releaseId);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deployment store rejects an upload with the wrong chunk checksum', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-deployment-chunk-'));
  try {
    const store = new DeploymentStore(tempDir);
    const body = Buffer.from('release');
    const upload = store.createUpload({
      totalBytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    });
    assert.throws(
      () => store.writeChunk(upload.uploadId, 0, body, 'a'.repeat(64)),
      /上传分块校验失败/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deployment store keeps one stable Node executable across release changes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-stable-runtime-'));
  try {
    const store = new DeploymentStore(tempDir);
    const firstRelease = store.getReleasePath('runtime-release-a');
    const secondRelease = store.getReleasePath('runtime-release-b');
    fs.mkdirSync(path.join(firstRelease, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(secondRelease, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(firstRelease, 'runtime', 'node.exe'), 'node-runtime-a');
    fs.writeFileSync(path.join(secondRelease, 'runtime', 'node.exe'), 'node-runtime-b');

    const first = store.ensureStableNodeRuntime('runtime-release-a');
    assert.equal(first.path, store.stableNodePath);
    assert.equal(first.updated, true);
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'node-runtime-a');

    const unchanged = store.ensureStableNodeRuntime('runtime-release-a');
    assert.equal(unchanged.path, first.path);
    assert.equal(unchanged.updated, false);
    assert.equal(unchanged.sha256, first.sha256);

    const second = store.ensureStableNodeRuntime('runtime-release-b');
    assert.equal(second.path, first.path);
    assert.equal(second.updated, true);
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(fs.readFileSync(second.path, 'utf8'), 'node-runtime-b');
    assert.equal(fs.existsSync(`${store.stableNodePath}.pending`), false);
    assert.equal(fs.existsSync(`${store.stableNodePath}.rollback`), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deployment store restores an interrupted stable runtime replacement', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-stable-runtime-recovery-'));
  const runtimeDir = path.join(tempDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'node.exe.rollback'), 'previous-node');
  fs.writeFileSync(path.join(runtimeDir, 'node.exe.pending'), 'partial-node');
  try {
    const store = new DeploymentStore(tempDir);
    assert.equal(fs.readFileSync(store.stableNodePath, 'utf8'), 'previous-node');
    assert.equal(fs.existsSync(`${store.stableNodePath}.pending`), false);
    assert.equal(fs.existsSync(`${store.stableNodePath}.rollback`), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deployment store clears interrupted uploads and staging directories on startup', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-transient-cleanup-'));
  const uploadsDir = path.join(tempDir, 'uploads');
  const releasesDir = path.join(tempDir, 'releases');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(path.join(releasesDir, '.staging-interrupted'), { recursive: true });
  fs.mkdirSync(path.join(releasesDir, 'valid-release'), { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, 'interrupted.json'), '{}');
  fs.writeFileSync(path.join(uploadsDir, 'interrupted.tgz'), 'partial');
  fs.writeFileSync(path.join(releasesDir, '.staging-interrupted', 'partial.txt'), 'partial');
  fs.writeFileSync(path.join(releasesDir, 'valid-release', 'keep.txt'), 'keep');
  try {
    new DeploymentStore(tempDir);
    assert.deepEqual(fs.readdirSync(uploadsDir), []);
    assert.equal(fs.existsSync(path.join(releasesDir, '.staging-interrupted')), false);
    assert.equal(fs.existsSync(path.join(releasesDir, 'valid-release', 'keep.txt')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('creating an upload reserves release space without pruning current or rollback versions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-release-reserve-'));
  try {
    const store = new DeploymentStore(tempDir, { retentionCount: 5 });
    for (let index = 1; index <= 5; index += 1) {
      const releaseId = `release-${index}`;
      fs.mkdirSync(store.getReleasePath(releaseId), { recursive: true });
      store.registerRelease({
        releaseId,
        appVersion: `1.0.${index}`,
        dependencyVersion: 'dependency',
        createdAt: `2026-07-28T00:0${index}:00.000Z`,
      });
    }
    store.activateRelease('release-4');
    store.activateRelease('release-5');

    const body = Buffer.from('new-release');
    store.createUpload({
      totalBytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    });

    const state = store.getState();
    assert.equal(state.releases.length, 4);
    assert.equal(state.currentReleaseId, 'release-5');
    assert.equal(state.previousReleaseId, 'release-4');
    assert.equal(fs.existsSync(store.getReleasePath('release-1')), false);
    assert.equal(fs.existsSync(store.getReleasePath('release-4')), true);
    assert.equal(fs.existsSync(store.getReleasePath('release-5')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createFakeRelease(rootDir, releaseId, appVersion) {
  const files = {
    'runtime/node.exe': 'node',
    'server/index.js': 'console.log("server");\n',
    'client/index.html': '<!doctype html><div id="root"></div>\n',
    'node_modules/express/package.json': '{"name":"express"}\n',
    'package.json': `${JSON.stringify({ version: appVersion })}\n`,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  const manifest = createDeploymentManifest({
    releaseId,
    appVersion,
    dependencyVersion: 'dependency',
    files: collectFileEntries(rootDir),
  });
  fs.writeFileSync(
    path.join(rootDir, DEPLOYMENT_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  assert.equal(hashFile(path.join(rootDir, 'package.json')).length, 64);
}
