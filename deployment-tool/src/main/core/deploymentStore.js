import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import {
  DEPLOYMENT_MANIFEST_FILE,
  hashFile,
  verifyExtractedFiles,
} from '../../shared/manifest.js';
import {
  MAX_UPLOAD_BYTES,
  RELEASE_RETENTION_COUNT,
  UPLOAD_CHUNK_BYTES,
} from '../../shared/constants.js';
import {
  normalizeRelativeArchivePath,
  normalizeReleaseId,
  normalizeSha256,
} from '../../shared/validation.js';
import { JsonStore } from './jsonStore.js';

export class DeploymentStore {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir);
    this.stateDir = path.join(this.rootDir, 'state');
    this.releasesDir = path.join(this.rootDir, 'releases');
    this.uploadsDir = path.join(this.rootDir, 'uploads');
    this.runtimeDir = path.join(this.rootDir, 'runtime');
    this.stableNodePath = path.join(this.runtimeDir, 'node.exe');
    this.logsDir = path.join(this.stateDir, 'logs');
    this.configPath = path.join(this.stateDir, 'config.json');
    this.exampleConfigPath = path.join(this.stateDir, 'config.example.json');
    this.deploymentState = new JsonStore(path.join(this.stateDir, 'deployment.json'), {
      schemaVersion: 1,
      currentReleaseId: '',
      previousReleaseId: '',
      releases: [],
    });
    this.retentionCount = options.retentionCount || RELEASE_RETENTION_COUNT;
    this.initialize();
  }

  initialize() {
    for (const directory of [
      this.rootDir,
      this.stateDir,
      this.releasesDir,
      this.uploadsDir,
      this.runtimeDir,
      this.logsDir,
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    recoverStableNodeRuntime(this.stableNodePath);
    this.cleanupTransientArtifacts();
  }

  getState() {
    const state = this.deploymentState.read();
    return {
      ...state,
      configAvailable: fs.existsSync(this.configPath),
      currentReleasePath: state.currentReleaseId
        ? this.getReleasePath(state.currentReleaseId)
        : '',
    };
  }

  getReleasePath(releaseId) {
    const normalized = normalizeReleaseId(releaseId);
    if (!normalized) {
      throw new Error('发布标识无效');
    }
    return path.join(this.releasesDir, normalized);
  }

  ensureStableNodeRuntime(releaseId) {
    const releasePath = this.getReleasePath(releaseId);
    const sourcePath = path.join(releasePath, 'runtime', 'node.exe');
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error('部署版本缺少 Node 运行时');
    }
    const sourceHash = hashFile(sourcePath);
    if (
      fs.existsSync(this.stableNodePath)
      && fs.statSync(this.stableNodePath).isFile()
      && hashFile(this.stableNodePath) === sourceHash
    ) {
      return {
        path: this.stableNodePath,
        sha256: sourceHash,
        updated: false,
      };
    }

    const pendingPath = `${this.stableNodePath}.pending`;
    const rollbackPath = `${this.stableNodePath}.rollback`;
    fs.rmSync(pendingPath, { force: true });
    fs.copyFileSync(sourcePath, pendingPath);
    if (hashFile(pendingPath) !== sourceHash) {
      fs.rmSync(pendingPath, { force: true });
      throw new Error('固定 Node 运行时复制校验失败');
    }

    let movedCurrent = false;
    let activatedNew = false;
    try {
      fs.rmSync(rollbackPath, { force: true });
      if (fs.existsSync(this.stableNodePath)) {
        fs.renameSync(this.stableNodePath, rollbackPath);
        movedCurrent = true;
      }
      fs.renameSync(pendingPath, this.stableNodePath);
      activatedNew = true;
      if (hashFile(this.stableNodePath) !== sourceHash) {
        throw new Error('固定 Node 运行时激活校验失败');
      }
      fs.rmSync(rollbackPath, { force: true });
      return {
        path: this.stableNodePath,
        sha256: sourceHash,
        updated: true,
      };
    } catch (error) {
      if (activatedNew) {
        fs.rmSync(this.stableNodePath, { force: true });
      }
      if (movedCurrent && fs.existsSync(rollbackPath)) {
        fs.renameSync(rollbackPath, this.stableNodePath);
      }
      throw error;
    } finally {
      fs.rmSync(pendingPath, { force: true });
      if (fs.existsSync(this.stableNodePath)) {
        fs.rmSync(rollbackPath, { force: true });
      }
    }
  }

  importConfig(sourceConfigPath, { overwrite = false } = {}) {
    const resolvedSource = path.resolve(sourceConfigPath);
    if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) {
      throw new Error('找不到要导入的 config.json');
    }
    if (fs.existsSync(this.configPath) && !overwrite) {
      throw new Error('目标端已经存在运行配置');
    }
    JSON.parse(fs.readFileSync(resolvedSource, 'utf8'));
    fs.copyFileSync(resolvedSource, this.configPath);
    const exampleSource = path.join(path.dirname(resolvedSource), 'config.example.json');
    if (fs.existsSync(exampleSource)) {
      fs.copyFileSync(exampleSource, this.exampleConfigPath);
    }
  }

  createUpload(metadata) {
    const totalBytes = Number(metadata?.totalBytes);
    const sha256 = normalizeSha256(metadata?.sha256);
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error('上传文件大小无效');
    }
    if (!sha256) {
      throw new Error('上传文件校验值无效');
    }
    this.pruneReleases({ reserveSlots: 1 });
    const uploadId = crypto.randomUUID();
    const upload = {
      schemaVersion: 1,
      uploadId,
      totalBytes,
      sha256,
      chunkBytes: UPLOAD_CHUNK_BYTES,
      received: [],
      createdAt: new Date().toISOString(),
    };
    this.writeUploadState(upload);
    fs.writeFileSync(this.getUploadArchivePath(uploadId), '');
    return upload;
  }

  readUpload(uploadId) {
    return JSON.parse(fs.readFileSync(this.getUploadStatePath(uploadId), 'utf8'));
  }

  writeChunk(uploadId, index, body, expectedSha256) {
    const upload = this.readUpload(uploadId);
    const chunkIndex = Number(index);
    const chunkHash = normalizeSha256(expectedSha256);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || !chunkHash) {
      throw new Error('上传分块参数无效');
    }
    const expectedOffset = chunkIndex * upload.chunkBytes;
    const expectedLength = Math.min(upload.chunkBytes, upload.totalBytes - expectedOffset);
    if (expectedLength <= 0 || body.length !== expectedLength || hashBuffer(body) !== chunkHash) {
      throw new Error('上传分块校验失败');
    }

    const archivePath = this.getUploadArchivePath(uploadId);
    const descriptor = fs.openSync(archivePath, 'r+');
    try {
      fs.writeSync(descriptor, body, 0, body.length, expectedOffset);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    upload.received[chunkIndex] = chunkHash;
    this.writeUploadState(upload);
    return {
      uploadId,
      index: chunkIndex,
      receivedBytes: upload.received.reduce((total, hash, currentIndex) => (
        hash ? total + Math.min(upload.chunkBytes, upload.totalBytes - currentIndex * upload.chunkBytes) : total
      ), 0),
    };
  }

  async finalizeUpload(uploadId) {
    const upload = this.readUpload(uploadId);
    const expectedChunkCount = Math.ceil(upload.totalBytes / upload.chunkBytes);
    if (upload.received.filter(Boolean).length !== expectedChunkCount) {
      throw new Error('上传尚未完成');
    }
    const archivePath = this.getUploadArchivePath(uploadId);
    if (fs.statSync(archivePath).size !== upload.totalBytes || hashFile(archivePath) !== upload.sha256) {
      throw new Error('部署包整体校验失败');
    }

    const stagingDir = path.join(this.releasesDir, `.staging-${uploadId}`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
      await tar.x({
        cwd: stagingDir,
        file: archivePath,
        strict: true,
        preservePaths: false,
        filter(entryPath, entry) {
          if (entryPath === '.' || entryPath === './') {
            return entry.type === 'Directory';
          }
          const normalized = normalizeRelativeArchivePath(
            entry.type === 'Directory' ? entryPath.replace(/\/+$/, '') : entryPath,
          );
          if (!normalized || !['File', 'Directory'].includes(entry.type)) {
            throw new Error(`部署包包含不安全条目：${entryPath}`);
          }
          return true;
        },
      });
      const manifestPath = path.join(stagingDir, DEPLOYMENT_MANIFEST_FILE);
      if (!fs.existsSync(manifestPath)) {
        throw new Error('部署包缺少发布清单');
      }
      const manifest = verifyExtractedFiles(
        stagingDir,
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      );
      validateReleaseRuntime(stagingDir);
      const releasePath = this.getReleasePath(manifest.releaseId);
      if (fs.existsSync(releasePath)) {
        throw new Error('相同发布标识已经存在');
      }
      fs.renameSync(stagingDir, releasePath);
      this.registerRelease(manifest);
      this.removeUpload(uploadId);
      return manifest;
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  activateRelease(releaseId) {
    const normalized = normalizeReleaseId(releaseId);
    const releasePath = this.getReleasePath(normalized);
    if (!fs.existsSync(releasePath)) {
      throw new Error('要激活的发布不存在');
    }
    return this.deploymentState.update((state) => {
      const previous = state.currentReleaseId;
      state.currentReleaseId = normalized;
      state.previousReleaseId = previous && previous !== normalized ? previous : state.previousReleaseId;
      state.releases = state.releases.map((release) => (
        release.releaseId === normalized
          ? { ...release, activatedAt: new Date().toISOString() }
          : release
      ));
      return state;
    });
  }

  restoreActivation(currentReleaseId, previousReleaseId) {
    const current = normalizeReleaseId(currentReleaseId);
    const previous = previousReleaseId ? normalizeReleaseId(previousReleaseId) : '';
    if (!current || !fs.existsSync(this.getReleasePath(current))) {
      throw new Error('要恢复的发布不存在');
    }
    return this.deploymentState.update((state) => {
      state.currentReleaseId = current;
      state.previousReleaseId = previous;
      return state;
    });
  }

  rollback() {
    const state = this.getState();
    if (!state.previousReleaseId || !fs.existsSync(this.getReleasePath(state.previousReleaseId))) {
      throw new Error('没有可回滚的上一版本');
    }
    const next = state.previousReleaseId;
    const current = state.currentReleaseId;
    this.deploymentState.update((value) => {
      value.currentReleaseId = next;
      value.previousReleaseId = current;
      return value;
    });
    return next;
  }

  pruneReleases(options = {}) {
    const state = this.getState();
    const protectedIds = new Set([state.currentReleaseId, state.previousReleaseId].filter(Boolean));
    const reserveSlots = Math.max(
      0,
      Math.min(this.retentionCount, Number(options.reserveSlots) || 0),
    );
    const retainedLimit = Math.max(protectedIds.size, this.retentionCount - reserveSlots);
    const retainedUnprotectedCount = Math.max(0, retainedLimit - protectedIds.size);
    const removable = [...state.releases]
      .filter((release) => !protectedIds.has(release.releaseId))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(retainedUnprotectedCount);

    if (removable.length === 0) {
      return [];
    }
    const removedIds = new Set(removable.map((release) => release.releaseId));
    for (const releaseId of removedIds) {
      fs.rmSync(this.getReleasePath(releaseId), { recursive: true, force: true });
    }
    this.deploymentState.update((value) => {
      value.releases = value.releases.filter((release) => !removedIds.has(release.releaseId));
      return value;
    });
    return [...removedIds];
  }

  registerRelease(manifest) {
    this.deploymentState.update((state) => {
      state.releases = state.releases.filter((release) => release.releaseId !== manifest.releaseId);
      state.releases.push({
        releaseId: manifest.releaseId,
        appVersion: manifest.appVersion,
        dependencyVersion: manifest.dependencyVersion,
        createdAt: manifest.createdAt,
        installedAt: new Date().toISOString(),
      });
      return state;
    });
  }

  getUploadStatePath(uploadId) {
    return path.join(this.uploadsDir, `${normalizeUploadId(uploadId)}.json`);
  }

  getUploadArchivePath(uploadId) {
    return path.join(this.uploadsDir, `${normalizeUploadId(uploadId)}.tgz`);
  }

  writeUploadState(upload) {
    fs.writeFileSync(
      this.getUploadStatePath(upload.uploadId),
      `${JSON.stringify(upload, null, 2)}\n`,
      'utf8',
    );
  }

  removeUpload(uploadId) {
    fs.rmSync(this.getUploadStatePath(uploadId), { force: true });
    fs.rmSync(this.getUploadArchivePath(uploadId), { force: true });
  }

  cleanupTransientArtifacts() {
    for (const entry of fs.readdirSync(this.uploadsDir, { withFileTypes: true })) {
      fs.rmSync(path.join(this.uploadsDir, entry.name), {
        recursive: entry.isDirectory(),
        force: true,
      });
    }
    for (const entry of fs.readdirSync(this.releasesDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.staging-')) {
        fs.rmSync(path.join(this.releasesDir, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

export function validateReleaseRuntime(releaseDir) {
  for (const relativePath of [
    'runtime/node.exe',
    'server/index.js',
    'client/index.html',
    'node_modules/express/package.json',
  ]) {
    const filePath = path.join(releaseDir, ...relativePath.split('/'));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`部署版本缺少运行文件：${relativePath}`);
    }
  }
}

function normalizeUploadId(uploadId) {
  const value = String(uploadId || '');
  if (!/^[a-f0-9-]{36}$/i.test(value)) {
    throw new Error('上传标识无效');
  }
  return value;
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function recoverStableNodeRuntime(stableNodePath) {
  const pendingPath = `${stableNodePath}.pending`;
  const rollbackPath = `${stableNodePath}.rollback`;
  if (!fs.existsSync(stableNodePath) && fs.existsSync(rollbackPath)) {
    fs.renameSync(rollbackPath, stableNodePath);
  } else if (fs.existsSync(stableNodePath)) {
    fs.rmSync(rollbackPath, { force: true });
  }
  fs.rmSync(pendingPath, { force: true });
}
