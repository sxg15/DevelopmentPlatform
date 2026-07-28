import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SERVICE_START_TIMEOUT_MS,
  TARGET_LOGS,
} from '../../shared/constants.js';
import { JsonStore } from './jsonStore.js';
import { findStartupErrors, readLogChunk, rotateLogIfNeeded } from './logReader.js';
import { runProcess } from './processRunner.js';

export class ServiceManager {
  constructor(deploymentStore, options = {}) {
    this.deploymentStore = deploymentStore;
    this.serviceState = new JsonStore(
      path.join(deploymentStore.stateDir, 'service.json'),
      {
        schemaVersion: 1,
        pid: 0,
        releaseId: '',
        startedAt: '',
        appPort: 0,
        inspectorPort: 0,
        runtimeSha256: '',
      },
    );
    this.startTimeoutMs = options.startTimeoutMs || SERVICE_START_TIMEOUT_MS;
    this.inspectProcess = options.inspectProcess || inspectWindowsProcess;
  }

  async getStatus({ includeHealth = true } = {}) {
    const state = this.serviceState.read();
    let processInfo = null;
    let processInspectionError = '';
    if (state.pid > 0) {
      try {
        processInfo = await this.inspectProcess(state.pid);
      } catch (error) {
        processInspectionError = error instanceof Error ? error.message : String(error);
      }
    }
    const running = Boolean(
      processInfo
      && processInfo.commandLine.toLowerCase().includes('server\\index.js'),
    );
    if (!running && state.pid && !processInspectionError) {
      this.clearServiceState();
    }
    let health = null;
    let healthError = '';
    if (running && includeHealth) {
      try {
        health = await fetchJson(`http://127.0.0.1:${state.appPort}/api/health`, 2000);
      } catch (error) {
        healthError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      ...state,
      pid: running || processInspectionError ? state.pid : 0,
      running,
      executablePath: running ? processInfo.executablePath : '',
      usesStableRuntime: Boolean(
        running
        && sameWindowsPath(processInfo.executablePath, this.deploymentStore.stableNodePath),
      ),
      healthy: Boolean(health?.ok),
      health,
      healthError,
      processInspectionError,
    };
  }

  async start(options = {}) {
    const existing = await this.getStatus({ includeHealth: false });
    if (existing.processInspectionError) {
      throw new Error(`无法确认现有服务进程状态：${existing.processInspectionError}`);
    }
    if (existing.running) {
      return this.waitForHealthy(
        existing,
        this.getReleaseAppVersion(existing.releaseId),
      );
    }

    const deployment = this.deploymentStore.getState();
    if (!deployment.currentReleaseId) {
      throw new Error('尚未激活任何部署版本');
    }
    if (!deployment.configAvailable) {
      throw new Error('目标端缺少持久化 config.json');
    }

    const releaseDir = this.deploymentStore.getReleasePath(deployment.currentReleaseId);
    const serverEntry = path.join(releaseDir, 'server', 'index.js');
    const config = JSON.parse(fs.readFileSync(this.deploymentStore.configPath, 'utf8'));
    const appPort = Number(config?.server?.port);
    if (!Number.isInteger(appPort) || appPort <= 0 || appPort > 65535) {
      throw new Error('config.json 中的服务端口无效');
    }
    await assertServicePortAvailable(appPort);
    const runtime = this.deploymentStore.ensureStableNodeRuntime(
      deployment.currentReleaseId,
    );
    const nodeExecutable = runtime.path;
    const expectedAppVersion = this.getReleaseAppVersion(deployment.currentReleaseId);
    const inspectorPort = options.debug === false ? 0 : await findFreePort();
    const stdoutPath = path.join(this.deploymentStore.logsDir, TARGET_LOGS.stdout);
    const stderrPath = path.join(this.deploymentStore.logsDir, TARGET_LOGS.stderr);
    rotateLogIfNeeded(stdoutPath);
    rotateLogIfNeeded(stderrPath);
    const stderrStart = fs.existsSync(stderrPath) ? fs.statSync(stderrPath).size : 0;
    const stdoutFd = fs.openSync(stdoutPath, 'a');
    const stderrFd = fs.openSync(stderrPath, 'a');

    const args = ['--disable-warning=ExperimentalWarning'];
    if (inspectorPort) {
      args.push(`--inspect=127.0.0.1:${inspectorPort}`);
    }
    args.push(serverEntry);

    let child;
    try {
      child = spawn(nodeExecutable, args, {
        cwd: releaseDir,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          IGP_CONFIG_PATH: this.deploymentStore.configPath,
          IGP_CLIENT_ERROR_LOG_PATH: path.join(
            this.deploymentStore.logsDir,
            TARGET_LOGS.client,
          ),
        },
      });
      child.unref();
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }

    this.serviceState.write({
      schemaVersion: 1,
      pid: child.pid,
      releaseId: deployment.currentReleaseId,
      startedAt: new Date().toISOString(),
      appPort,
      inspectorPort,
      runtimeSha256: runtime.sha256,
    });

    try {
      const status = await this.waitForHealthy(
        this.serviceState.read(),
        expectedAppVersion,
      );
      const newStderr = readLogChunk(stderrPath, {
        offset: stderrStart,
        limit: 512 * 1024,
      }).text;
      const startupErrors = findStartupErrors(newStderr);
      if (startupErrors.length > 0) {
        throw new Error(`服务启动日志包含错误：${startupErrors.slice(0, 3).join(' | ')}`);
      }
      return status;
    } catch (error) {
      await this.stop({ force: true });
      throw error;
    }
  }

  async stop(options = {}) {
    const state = this.serviceState.read();
    if (!state.pid) {
      return { stopped: true, pid: 0 };
    }
    let processInfo;
    try {
      processInfo = await this.inspectProcess(state.pid);
    } catch (error) {
      throw new Error(
        `无法确认服务进程状态：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!processInfo) {
      this.clearServiceState();
      return { stopped: true, pid: state.pid };
    }
    if (!processInfo.commandLine.toLowerCase().includes('server\\index.js')) {
      this.clearServiceState();
      throw new Error('服务 PID 已被其他进程占用，拒绝停止');
    }

    try {
      process.kill(state.pid, options.force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // taskkill below handles Windows process-tree termination.
    }
    if (!(await waitForProcessExit(state.pid, options.force ? 1000 : 4000))) {
      await runProcess('taskkill.exe', ['/PID', String(state.pid), '/T', '/F'], {
        rejectOnError: false,
      });
    }
    this.clearServiceState();
    return { stopped: true, pid: state.pid };
  }

  async restart(options = {}) {
    await this.stop();
    return this.start(options);
  }

  async runPostDeployChecks() {
    const status = await this.getStatus();
    if (!status.running || !status.healthy) {
      throw new Error('服务进程或健康检查未通过');
    }
    const deployment = this.deploymentStore.getState();
    if (status.releaseId !== deployment.currentReleaseId) {
      throw new Error('运行版本与激活版本不一致');
    }
    const activeRelease = deployment.releases.find(
      (release) => release.releaseId === deployment.currentReleaseId,
    );
    if (activeRelease?.appVersion && status.health?.version !== activeRelease.appVersion) {
      throw new Error(
        `健康检查版本不一致：期望 ${activeRelease.appVersion}，实际 ${status.health?.version || 'unknown'}`,
      );
    }
    const page = await fetchText(`http://127.0.0.1:${status.appPort}/`, 5000);
    if (!page.ok || !/<(?:html|div)\b/i.test(page.text)) {
      throw new Error('首页静态资源检查失败');
    }
    const stderr = readLogChunk(
      path.join(this.deploymentStore.logsDir, TARGET_LOGS.stderr),
      { limit: 256 * 1024 },
    );
    const errors = findStartupErrors(stderr.text);
      return {
        ok: true,
        releaseId: status.releaseId,
        appPort: status.appPort,
        inspectorPort: status.inspectorPort,
        executablePath: status.executablePath,
        usesStableRuntime: status.usesStableRuntime,
        health: status.health,
        pageStatus: page.status,
        startupErrors: errors.slice(-10),
    };
  }

  async getInspectorMetadata() {
    const status = await this.getStatus({ includeHealth: false });
    if (!status.running || !status.inspectorPort) {
      throw new Error('当前服务未启用 Node Inspector');
    }
    const targets = await fetchJson(`http://127.0.0.1:${status.inspectorPort}/json/list`, 2000);
    const target = Array.isArray(targets) ? targets[0] : null;
    if (!target?.webSocketDebuggerUrl) {
      throw new Error('无法读取 Node Inspector 元数据');
    }
    return {
      title: String(target.title || 'IGP Web Backend'),
      type: String(target.type || 'node'),
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
      inspectorPort: status.inspectorPort,
    };
  }

  async waitForHealthy(state, expectedAppVersion = '') {
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      let processInfo;
      try {
        processInfo = await this.inspectProcess(state.pid);
      } catch (error) {
        lastError = `进程状态查询失败：${error instanceof Error ? error.message : String(error)}`;
        await wait(500);
        continue;
      }
      if (!processInfo) {
        throw new Error('服务进程在健康检查完成前退出');
      }
      try {
        const health = await fetchJson(`http://127.0.0.1:${state.appPort}/api/health`, 1500);
        if (health?.ok) {
          if (!expectedAppVersion || health.version === expectedAppVersion) {
            return {
              ...state,
              running: true,
              healthy: true,
              health,
            };
          }
          lastError = `健康检查版本不一致：期望 ${expectedAppVersion}，实际 ${health.version || 'unknown'}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await wait(500);
    }
    throw new Error(`服务健康检查超时${lastError ? `：${lastError}` : ''}`);
  }

  getReleaseAppVersion(releaseId) {
    const release = this.deploymentStore.getState().releases.find(
      (item) => item.releaseId === releaseId,
    );
    return String(release?.appVersion || '');
  }

  clearServiceState() {
    this.serviceState.write({
      schemaVersion: 1,
      pid: 0,
      releaseId: '',
      startedAt: '',
      appPort: 0,
      inspectorPort: 0,
      runtimeSha256: '',
    });
  }
}

export async function inspectWindowsProcess(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return null;
  }
  const script = [
    `$item = Get-CimInstance Win32_Process -Filter "ProcessId = ${numericPid}"`,
    'if ($null -eq $item) { exit 3 }',
    '$item | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
  ].join('; ');
    const result = await runProcess('powershell.exe', [
    '-NoProfile',
    '-Command',
    script,
    ], {
      rejectOnError: false,
      timeoutMs: 5_000,
    });
  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      pid: Number(parsed.ProcessId),
      executablePath: String(parsed.ExecutablePath || ''),
      commandLine: String(parsed.CommandLine || ''),
    };
  } catch {
    return null;
  }
}

function sameWindowsPath(left, right) {
  return path.resolve(String(left || '')).toLowerCase()
    === path.resolve(String(right || '')).toLowerCase();
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function assertServicePortAvailable(port) {
  const server = net.createServer();
  server.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(
        `服务端口 ${port} 已被非部署工具管理的进程占用，请先在目标电脑停止该进程`,
      );
    }
    throw error;
  } finally {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await inspectWindowsProcess(pid))) {
      return true;
    }
    await wait(200);
  }
  return false;
}

async function fetchJson(url, timeoutMs) {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchText(url, timeoutMs) {
  const response = await fetchWithTimeout(url, timeoutMs);
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
