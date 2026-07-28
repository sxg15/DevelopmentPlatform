import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRelativeArchivePath, normalizeReleaseId, normalizeSha256 } from './validation.js';

export const DEPLOYMENT_MANIFEST_FILE = 'deployment-manifest.json';

export function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

export function collectFileEntries(rootDir, options = {}) {
  const excluded = new Set((options.excluded || []).map((item) => String(item).replaceAll('\\', '/')));
  const entries = [];
  walk(rootDir, '');
  return entries.sort((left, right) => left.path.localeCompare(right.path));

  function walk(currentDir, relativeDir) {
    for (const item of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${item.name}` : item.name;
      if (excluded.has(relativePath)) {
        continue;
      }
      const fullPath = path.join(currentDir, item.name);
      if (item.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (item.isFile()) {
        entries.push({
          path: relativePath,
          size: fs.statSync(fullPath).size,
          sha256: hashFile(fullPath),
        });
      }
    }
  }
}

export function createDeploymentManifest({
  releaseId,
  appVersion,
  dependencyVersion,
  files,
  createdAt = new Date().toISOString(),
}) {
  const normalizedReleaseId = normalizeReleaseId(releaseId);
  if (!normalizedReleaseId) {
    throw new Error('发布标识格式不正确');
  }

  const normalizedFiles = files.map((file) => ({
    path: normalizeRelativeArchivePath(file.path),
    size: Number(file.size),
    sha256: normalizeSha256(file.sha256),
  }));
  if (normalizedFiles.some((file) => (
    !file.path
    || !Number.isSafeInteger(file.size)
    || file.size < 0
    || !file.sha256
  ))) {
    throw new Error('发布文件清单无效');
  }
  if (new Set(normalizedFiles.map((file) => file.path)).size !== normalizedFiles.length) {
    throw new Error('发布文件清单包含重复路径');
  }
  if (normalizedFiles.some((file) => file.path.toLowerCase() === 'config.json')) {
    throw new Error('发布包不得包含目标运行配置');
  }

  return {
    schemaVersion: 1,
    releaseId: normalizedReleaseId,
    appVersion: String(appVersion || '0.0.0').trim() || '0.0.0',
    dependencyVersion: String(dependencyVersion || '').trim(),
    createdAt,
    files: normalizedFiles,
  };
}

export function validateDeploymentManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error('不支持的发布清单版本');
  }
  return createDeploymentManifest(manifest);
}

export function verifyExtractedFiles(rootDir, manifest) {
  const normalized = validateDeploymentManifest(manifest);
  const expectedPaths = new Set(normalized.files.map((file) => file.path));
  const actual = collectFileEntries(rootDir, {
    excluded: [DEPLOYMENT_MANIFEST_FILE],
  });
  if (actual.length !== normalized.files.length) {
    throw new Error('解压后的文件数量与发布清单不一致');
  }

  for (const actualFile of actual) {
    if (!expectedPaths.has(actualFile.path)) {
      throw new Error(`发布包包含未声明文件：${actualFile.path}`);
    }
  }
  for (const expected of normalized.files) {
    const filePath = path.join(rootDir, ...expected.path.split('/'));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`发布文件缺失：${expected.path}`);
    }
    if (fs.statSync(filePath).size !== expected.size || hashFile(filePath) !== expected.sha256) {
      throw new Error(`发布文件校验失败：${expected.path}`);
    }
  }
  return normalized;
}
