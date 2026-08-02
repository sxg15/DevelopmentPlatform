import fs from 'node:fs';
import { spawn } from 'node:child_process';

export class SshTunnelManager {
  constructor(config, options = {}) {
    this.config = config;
    this.spawnProcess = options.spawnProcess || spawn;
    this.setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
    this.logger = options.logger || console;
    this.child = null;
    this.restartTimer = null;
    this.stopping = false;
    this.restartAttempt = 0;
  }

  start() {
    this.validateFiles();
    this.stopping = false;
    this.spawnTunnel();
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      this.clearTimeoutImpl(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child?.pid) {
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // The verified child PID is handled by taskkill below when needed.
    }
    await waitForChildExit(child, 2500);
    if (child.exitCode === null && process.platform === 'win32') {
      await runTaskkill(child.pid);
    }
  }

  buildArguments() {
    const { ssh, server } = this.config;
    return [
      '-N',
      '-T',
      '-p',
      String(ssh.port),
      '-i',
      ssh.identityFile,
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      `ServerAliveInterval=${ssh.serverAliveIntervalSeconds}`,
      '-o',
      `ServerAliveCountMax=${ssh.serverAliveCountMax}`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${quoteSshOptionValue(ssh.knownHostsFile)}`,
      '-o',
      'LogLevel=ERROR',
      '-R',
      `${ssh.remoteBindHost}:${ssh.remoteBindPort}:${server.host}:${server.port}`,
      `${ssh.user}@${ssh.host}`,
    ];
  }

  validateFiles() {
    for (const [label, filePath] of [
      ['SSH 客户端', this.config.ssh.executable],
      ['SSH 私钥', this.config.ssh.identityFile],
      ['SSH 主机指纹文件', this.config.ssh.knownHostsFile],
    ]) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`${label}不存在：${filePath}`);
      }
    }
  }

  spawnTunnel() {
    if (this.stopping || this.child) {
      return;
    }
    const child = this.spawnProcess(
      this.config.ssh.executable,
      this.buildArguments(),
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.stdout?.on('data', (chunk) => this.logChunk('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.logChunk('stderr', chunk));
    child.on('error', (error) => {
      this.logger.error(`SSH 隧道启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
    child.on('spawn', () => {
      this.restartAttempt = 0;
      this.logger.log(`SSH 反向隧道已启动，PID ${child.pid}`);
    });
    child.on('close', (code) => {
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopping) {
        return;
      }
      this.restartAttempt += 1;
      const delayMs = Math.min(30_000, 1000 * (2 ** Math.min(5, this.restartAttempt - 1)));
      this.logger.error(`SSH 隧道已退出（${Number(code)}），${delayMs}ms 后重连`);
      this.restartTimer = this.setTimeoutImpl(() => {
        this.restartTimer = null;
        this.spawnTunnel();
      }, delayMs);
      this.restartTimer.unref?.();
    });
  }

  logChunk(channel, chunk) {
    const text = String(chunk || '').trim();
    if (text) {
      this.logger[channel === 'stderr' ? 'error' : 'log'](`[ssh] ${text.slice(0, 1000)}`);
    }
  }
}

function quoteSshOptionValue(value) {
  return `"${String(value || '').replaceAll('"', '\\"')}"`;
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function runTaskkill(pid) {
  const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise((resolve) => child.once('close', resolve));
}
