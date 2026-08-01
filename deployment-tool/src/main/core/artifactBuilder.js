import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import {
  DEPLOYMENT_MANIFEST_FILE,
  collectFileEntries,
  createDeploymentManifest,
  hashFile,
} from '../../shared/manifest.js';
import { resolveNpmInvocation } from './npmRunner.js';
import { runProcess } from './processRunner.js';

const REQUIRED_PUBLISH_FILES = [
  'client/index.html',
  'server/index.js',
  'server/runtime/backendProcessController.js',
  'runtime/node.exe',
  'runtime/npm/bin/npm-cli.js',
  'runtime/dependency-version.txt',
  'EnsureDependencies.ps1',
  'package.json',
  'package-lock.json',
];

const REQUIRED_PRODUCTION_DEPENDENCIES = [
  'express/package.json',
  '@larksuiteoapi/node-sdk/package.json',
  '@openai/codex/package.json',
  '@openai/codex-win32-x64/package.json',
  '@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
];

const EXCLUDED_ROOT_NAMES = new Set([
  'config.json',
  'config.json.bak',
  'node_modules',
  'server.log',
  'server.err.log',
  'logs',
]);

export class ArtifactBuilder {
  constructor({ cacheDir, tempDir } = {}) {
    this.cacheDir = path.resolve(cacheDir || path.join(os.tmpdir(), 'igp-lan-deploy-cache'));
    this.tempDir = path.resolve(tempDir || path.join(os.tmpdir(), 'igp-lan-deploy-builds'));
  }

  async buildFromRepository(repositoryDir, options = {}) {
    const resolvedRepository = path.resolve(repositoryDir);
    const npm = resolveNpmInvocation(['run', 'build']);
    await runProcess(npm.command, npm.args, {
      cwd: resolvedRepository,
      onOutput: options.onOutput,
    });
    return this.buildFromPublish(path.join(resolvedRepository, 'Publish'), options);
  }

  async buildFromPublish(publishDir, options = {}) {
    const resolvedPublish = path.resolve(publishDir);
    validatePublishDirectory(resolvedPublish);
    fs.mkdirSync(this.tempDir, { recursive: true });
    const buildRoot = fs.mkdtempSync(path.join(this.tempDir, 'artifact-'));
    const stagingDir = path.join(buildRoot, 'staging');
    const outputPath = path.join(buildRoot, 'igp-release.tgz');

    try {
      options.onProgress?.({ phase: 'copy', message: '正在复制发布产物' });
      copyPublishTree(resolvedPublish, stagingDir);

      const dependencyVersion = fs.readFileSync(
        path.join(stagingDir, 'runtime', 'dependency-version.txt'),
        'utf8',
      ).trim();
      await this.ensureOfflineDependencies(stagingDir, dependencyVersion, options);

      const packageJson = JSON.parse(fs.readFileSync(path.join(stagingDir, 'package.json'), 'utf8'));
      const releaseId = createReleaseId(packageJson.version);
      options.onProgress?.({ phase: 'manifest', message: '正在生成文件校验清单' });
      const files = collectFileEntries(stagingDir, {
        excluded: [DEPLOYMENT_MANIFEST_FILE],
      });
      const manifest = createDeploymentManifest({
        releaseId,
        appVersion: packageJson.version,
        dependencyVersion,
        files,
      });
      fs.writeFileSync(
        path.join(stagingDir, DEPLOYMENT_MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );

      options.onProgress?.({ phase: 'archive', message: '正在压缩离线部署包' });
      await tar.c({
        cwd: stagingDir,
        file: outputPath,
        gzip: true,
        portable: true,
        noMtime: true,
      }, ['.']);

      const stats = fs.statSync(outputPath);
      return {
        releaseId,
        appVersion: manifest.appVersion,
        dependencyVersion,
        outputPath,
        sha256: hashFile(outputPath),
        size: stats.size,
        manifest,
        cleanup: () => fs.rmSync(buildRoot, { recursive: true, force: true }),
      };
    } catch (error) {
      fs.rmSync(buildRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async ensureOfflineDependencies(stagingDir, dependencyVersion, options = {}) {
    const cacheRoot = path.join(this.cacheDir, 'dependencies', dependencyVersion);
    const cachedNodeModules = path.join(cacheRoot, 'node_modules');
    if (areProductionDependenciesReady(cachedNodeModules)) {
      options.onProgress?.({ phase: 'dependencies', message: '正在复用离线依赖缓存' });
      fs.cpSync(cachedNodeModules, path.join(stagingDir, 'node_modules'), {
        recursive: true,
        force: true,
      });
      return;
    }

    options.onProgress?.({ phase: 'dependencies', message: '正在准备离线生产依赖' });
    await runProcess('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(stagingDir, 'EnsureDependencies.ps1'),
      '-RootDir',
      stagingDir,
    ], {
      cwd: stagingDir,
      onOutput: options.onOutput,
    });
    if (!areProductionDependenciesReady(path.join(stagingDir, 'node_modules'))) {
      throw new Error('生产依赖准备完成后仍有文件缺失');
    }

    const tempCache = `${cacheRoot}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(tempCache, { recursive: true });
    try {
      fs.cpSync(path.join(stagingDir, 'node_modules'), path.join(tempCache, 'node_modules'), {
        recursive: true,
        force: true,
      });
      fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      fs.renameSync(tempCache, cacheRoot);
    } finally {
      fs.rmSync(tempCache, { recursive: true, force: true });
    }
  }
}

export function validatePublishDirectory(publishDir) {
  for (const relativePath of REQUIRED_PUBLISH_FILES) {
    const filePath = path.join(publishDir, ...relativePath.split('/'));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`发布产物缺少文件：${relativePath}`);
    }
  }
}

export function createReleaseId(version, now = new Date()) {
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  const nonce = crypto.randomBytes(3).toString('hex');
  return `${String(version || '0.0.0').replace(/[^a-zA-Z0-9._-]/g, '_')}-${timestamp}-${nonce}`;
}

function copyPublishTree(sourceDir, destinationDir) {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    filter(source) {
      if (path.resolve(source) === path.resolve(sourceDir)) {
        return true;
      }
      const relative = path.relative(sourceDir, source);
      const first = relative.split(path.sep)[0];
      return !EXCLUDED_ROOT_NAMES.has(first);
    },
  });
}

function areProductionDependenciesReady(nodeModulesDir) {
  return REQUIRED_PRODUCTION_DEPENDENCIES.every((relativePath) => {
    const filePath = path.join(nodeModulesDir, ...relativePath.split('/'));
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  });
}
