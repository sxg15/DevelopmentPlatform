import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ArtifactBuilder } from './artifactBuilder.js';
import { TargetDiscoveryScanner } from './discovery.js';
import { JsonStore } from './jsonStore.js';
import { SecureVault } from './secureVault.js';
import { TargetClient, probeTarget } from './targetClient.js';
import { normalizeSha256 } from '../../shared/validation.js';

export class DeveloperController extends EventEmitter {
  constructor({ userDataDir, safeStorage }) {
    super();
    this.userDataDir = path.resolve(userDataDir);
    this.settingsStore = new JsonStore(path.join(this.userDataDir, 'developer-settings.json'), {
      schemaVersion: 1,
      clientId: '',
      clientName: '',
      defaultTargetId: '',
      repositoryPath: '',
      targets: [],
    });
    this.vault = new SecureVault(path.join(this.userDataDir, 'credentials.json'), safeStorage);
    this.artifactBuilder = new ArtifactBuilder({
      cacheDir: path.join(this.userDataDir, 'cache'),
      tempDir: path.join(this.userDataDir, 'temp'),
    });
    this.discoveredTargets = new Map();
    this.jobs = new Map();
    this.operation = Promise.resolve();
    this.initializeIdentity();
  }

  initializeIdentity() {
    this.settingsStore.update((settings) => {
      settings.clientId = settings.clientId || `client-${crypto.randomUUID()}`;
      settings.clientName = settings.clientName || os.hostname() || '开发电脑';
      return settings;
    });
  }

  async getState({ refreshStatus = false } = {}) {
    const settings = this.settingsStore.read();
    let currentStatus = null;
    if (refreshStatus && settings.defaultTargetId) {
      try {
        currentStatus = await this.getClient(settings.defaultTargetId).getStatus();
      } catch (error) {
        currentStatus = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      mode: 'developer',
      clientId: settings.clientId,
      clientName: settings.clientName,
      defaultTargetId: settings.defaultTargetId,
      repositoryPath: settings.repositoryPath,
      targets: settings.targets.map((target) => ({
        ...target,
        paired: Boolean(this.getTargetToken(target.targetId)),
        discovered: this.discoveredTargets.has(target.targetId),
      })),
      discoveredTargets: [...this.discoveredTargets.values()],
      currentStatus,
      activeJobs: [...this.jobs.values()].filter((job) => job.status === 'running'),
    };
  }

  async scan() {
    const scanner = new TargetDiscoveryScanner();
    scanner.on('target', (target) => {
      this.discoveredTargets.set(target.targetId, target);
      this.emitState();
    });
    const targets = await scanner.scan();
    for (const target of targets) {
      this.discoveredTargets.set(target.targetId, target);
    }
    this.emitState();
    return targets;
  }

  async pairTarget(target, code) {
    const settings = this.settingsStore.read();
    const client = new TargetClient(target);
    const result = await client.pair({
      code,
      clientId: settings.clientId,
      clientName: settings.clientName,
    });
    if (result.fingerprint !== target.fingerprint) {
      throw new Error('配对响应的证书指纹不一致');
    }
    this.vault.set(`target:${result.targetId}`, result.token);
    const savedTarget = {
      targetId: result.targetId,
      displayName: result.displayName,
      address: target.address,
      port: Number(target.port),
      fingerprint: result.fingerprint,
      pairedAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
    };
    this.settingsStore.update((value) => {
      value.targets = value.targets.filter((item) => item.targetId !== savedTarget.targetId);
      value.targets.push(savedTarget);
      value.defaultTargetId = value.defaultTargetId || savedTarget.targetId;
      return value;
    });
    this.emitState();
    return savedTarget;
  }

  async probeTarget(address, port) {
    const target = await probeTarget(address, port);
    this.discoveredTargets.set(target.targetId, {
      ...target,
      discoveredAt: Date.now(),
      manual: true,
    });
    this.emitState();
    return target;
  }

  setDefaultTarget(targetId) {
    this.settingsStore.update((settings) => {
      if (!settings.targets.some((target) => target.targetId === targetId)) {
        throw new Error('目标端不存在');
      }
      settings.defaultTargetId = targetId;
      return settings;
    });
    this.emitState();
  }

  setRepositoryPath(repositoryPath) {
    this.settingsStore.update((settings) => {
      settings.repositoryPath = path.resolve(repositoryPath);
      return settings;
    });
    this.emitState();
  }

  forgetTarget(targetId) {
    this.settingsStore.update((settings) => {
      settings.targets = settings.targets.filter((target) => target.targetId !== targetId);
      if (settings.defaultTargetId === targetId) {
        settings.defaultTargetId = settings.targets[0]?.targetId || '';
      }
      return settings;
    });
    this.vault.delete(`target:${targetId}`);
    this.emitState();
  }

  async refreshTarget(targetId) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const client = this.getClient(resolvedTargetId);
    const status = await client.getStatus();
    this.settingsStore.update((settings) => {
      const target = settings.targets.find((item) => item.targetId === resolvedTargetId);
      if (target) {
        target.address = client.target.address;
        target.port = client.target.port;
        target.lastConnectedAt = new Date().toISOString();
      }
      return settings;
    });
    return status;
  }

  readLog(targetId, name, options) {
    return this.getClient(this.resolveTargetId(targetId)).readLog(name, options);
  }

  runTargetAction(targetId, action) {
    const client = this.getClient(this.resolveTargetId(targetId));
    if (action === 'start') {
      return client.startService();
    }
    if (action === 'stop') {
      return client.stopService();
    }
    if (action === 'restart') {
      return client.restartService();
    }
    if (action === 'rollback') {
      return client.rollback();
    }
    throw new Error('未知的远端操作');
  }

  getDebugConnection(targetId) {
    const client = this.getClient(this.resolveTargetId(targetId));
    return client.getDebugMetadata().then((metadata) => ({
      target: client.target,
      metadata,
    }));
  }

  createDeployJob(options = {}) {
    const jobId = crypto.randomUUID();
    const job = {
      jobId,
      status: 'running',
      phase: 'queued',
      message: '等待部署',
      targetId: options.targetId || this.settingsStore.read().defaultTargetId,
      sourcePath: path.resolve(options.sourcePath || this.settingsStore.read().repositoryPath || process.cwd()),
      sourceType: options.sourceType === 'publish' ? 'publish' : 'repository',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: null,
      logs: [],
      result: null,
      error: '',
    };
    if (!job.targetId) {
      throw new Error('尚未选择默认目标端');
    }
    this.jobs.set(jobId, job);
    this.runDeployJob(job).catch(() => {});
    this.emitState();
    return structuredClone(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error('部署任务不存在');
    }
    return structuredClone(job);
  }

  async runDeployJob(job) {
    let artifact;
    try {
      const onProgress = (progress) => this.updateJob(job, {
        phase: progress.phase,
        message: progress.message || job.message,
        progress,
      });
      const onOutput = ({ stream, text }) => {
        const lines = String(text || '').split(/\r?\n/).filter(Boolean);
        job.logs.push(...lines.map((line) => `${stream}: ${line}`));
        job.logs = job.logs.slice(-200);
        this.updateJob(job, {});
      };
      this.updateJob(job, {
        phase: 'build',
        message: job.sourceType === 'repository' ? '正在构建项目发布产物' : '正在检查已有发布产物',
      });
      artifact = job.sourceType === 'repository'
        ? await this.artifactBuilder.buildFromRepository(job.sourcePath, { onProgress, onOutput })
        : await this.artifactBuilder.buildFromPublish(job.sourcePath, { onProgress, onOutput });

      this.updateJob(job, {
        phase: 'upload',
        message: `正在上传 ${artifact.appVersion}`,
        progress: { uploadedBytes: 0, totalBytes: artifact.size },
      });
      const client = this.getClient(job.targetId);
      const result = await client.uploadAndDeploy(artifact, {
        onProgress: (progress) => this.updateJob(job, {
          phase: 'upload',
          message: `正在上传 ${artifact.appVersion}`,
          progress,
        }),
      });
      this.updateJob(job, {
        status: 'completed',
        phase: 'complete',
        message: `版本 ${artifact.appVersion} 已部署并通过远端检查`,
        result,
      });
      return result;
    } catch (error) {
      try {
        const client = this.getClient(job.targetId);
        for (const logName of ['stderr', 'client']) {
          const log = await client.readLog(logName, { limit: 128 * 1024 });
          const lines = String(log.text || '').split(/\r?\n/).filter(Boolean).slice(-40);
          job.logs.push(...lines.map((line) => `${logName}: ${line}`));
        }
        job.logs = job.logs.slice(-200);
      } catch {
        // Preserve the primary deployment failure when diagnostic retrieval is unavailable.
      }
      this.updateJob(job, {
        status: 'failed',
        phase: 'failed',
        message: '部署调试失败',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      artifact?.cleanup?.();
    }
  }

  getClient(targetId) {
    const settings = this.settingsStore.read();
    const savedTarget = settings.targets.find((item) => item.targetId === targetId);
    const discoveredTarget = this.discoveredTargets.get(targetId);
    const target = selectTargetConnection(savedTarget, discoveredTarget);
    if (!target) {
      throw new Error('找不到目标端');
    }
    const token = this.getTargetToken(targetId);
    if (!token) {
      throw new Error('目标端尚未配对');
    }
    return new TargetClient({ ...target, token });
  }

  resolveTargetId(targetId) {
    const resolved = String(targetId || this.settingsStore.read().defaultTargetId || '');
    if (!resolved) {
      throw new Error('尚未选择默认目标端');
    }
    return resolved;
  }

  getTargetToken(targetId) {
    try {
      return this.vault.get(`target:${targetId}`);
    } catch {
      return '';
    }
  }

  updateJob(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.emit('job', structuredClone(job));
    this.emitState();
  }

  emitState() {
    this.getState()
      .then((state) => this.emit('state', state))
      .catch(() => {});
  }
}

export function selectTargetConnection(savedTarget, discoveredTarget) {
  if (!savedTarget) {
    return discoveredTarget || null;
  }
  const savedFingerprint = normalizeSha256(savedTarget.fingerprint);
  const discoveredFingerprint = normalizeSha256(discoveredTarget?.fingerprint);
  if (
    discoveredTarget
    && savedFingerprint
    && discoveredFingerprint === savedFingerprint
  ) {
    return {
      ...savedTarget,
      address: discoveredTarget.address,
      port: Number(discoveredTarget.port),
    };
  }
  return savedTarget;
}
