import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOCK_FILE_NAME = 'web-backend.lock';

export function createBackendProcessController({
  rootDir,
  stateRoot,
  nodeExecutable,
  serverEntry,
  configPath = '',
  inspectProcess = inspectWindowsProcess,
  spawnProcess = spawn,
} = {}) {
  const normalizedRootDir = path.resolve(rootDir || process.cwd());
  const normalizedStateRoot = path.resolve(stateRoot || path.join(normalizedRootDir, 'runtime'));
  const normalizedNodeExecutable = path.resolve(nodeExecutable || process.execPath);
  const normalizedServerEntry = path.resolve(
    serverEntry || path.join(normalizedRootDir, 'server', 'index.js'),
  );
  const lockPath = path.join(normalizedStateRoot, LOCK_FILE_NAME);

  async function start() {
    const existing = readLock(lockPath);
    if (existing?.pid) {
      const processInfo = await inspectProcess(existing.pid);
      if (processInfo && matchesBackendProcess(processInfo, {
        nodeExecutable: normalizedNodeExecutable,
        serverEntry: normalizedServerEntry,
      })) {
        return { started: false, pid: existing.pid, alreadyRunning: true };
      }
      if (processInfo) {
        throw new Error('运行记录中的 PID 已被其他进程占用，拒绝启动');
      }
      removeLock(lockPath);
    }

    fs.mkdirSync(normalizedStateRoot, { recursive: true });
    const stdoutFd = fs.openSync(path.join(normalizedRootDir, 'server.log'), 'a');
    const stderrFd = fs.openSync(path.join(normalizedRootDir, 'server.err.log'), 'a');
    let child;
    try {
      child = spawnProcess(
        normalizedNodeExecutable,
        ['--disable-warning=ExperimentalWarning', normalizedServerEntry],
        {
          cwd: normalizedRootDir,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', stdoutFd, stderrFd],
          env: {
            ...process.env,
            NODE_ENV: 'production',
            ...(configPath ? { IGP_CONFIG_PATH: path.resolve(configPath) } : {}),
          },
        },
      );
      child.unref();
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }

    if (!child?.pid) {
      throw new Error('无法启动 Web 后端进程');
    }
    writeLock(lockPath, {
      schemaVersion: 1,
      pid: child.pid,
      rootDir: normalizedRootDir,
      nodeExecutable: normalizedNodeExecutable,
      serverEntry: normalizedServerEntry,
      startedAt: new Date().toISOString(),
    });
    return { started: true, pid: child.pid, alreadyRunning: false };
  }

  async function stop() {
    const existing = readLock(lockPath);
    if (!existing?.pid) {
      return { stopped: true, pid: 0, alreadyStopped: true };
    }
    const processInfo = await inspectProcess(existing.pid);
    if (!processInfo) {
      removeLock(lockPath);
      return { stopped: true, pid: existing.pid, alreadyStopped: true };
    }
    if (!matchesBackendProcess(processInfo, {
      nodeExecutable: normalizedNodeExecutable,
      serverEntry: normalizedServerEntry,
    })) {
      throw new Error('运行记录中的 PID 不属于当前 Web 后端，拒绝停止');
    }

    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      // The verified Windows process-tree fallback below handles inaccessible children.
    }
    if (!(await waitForExit(existing.pid, inspectProcess, 4_000))) {
      await runTaskkill(existing.pid);
      if (!(await waitForExit(existing.pid, inspectProcess, 2_000))) {
        throw new Error('Web 后端进程未能停止');
      }
    }
    removeLock(lockPath);
    return { stopped: true, pid: existing.pid, alreadyStopped: false };
  }

  return {
    getLockPath: () => lockPath,
    start,
    stop,
  };
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
  const result = await runCommand('powershell.exe', [
    '-NoProfile',
    '-Command',
    script,
  ], 5_000);
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

export function matchesBackendProcess(processInfo, { nodeExecutable, serverEntry }) {
  const commandLine = String(processInfo?.commandLine || '').replace(/\//g, '\\').toLowerCase();
  const expectedEntry = path.resolve(serverEntry).replace(/\//g, '\\').toLowerCase();
  return sameWindowsPath(processInfo?.executablePath, nodeExecutable)
    && commandLine.includes(expectedEntry);
}

async function runTaskkill(pid) {
  await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 5_000);
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} 执行超时`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: Number(code), stdout, stderr });
    });
  });
}

async function waitForExit(pid, inspectProcess, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await inspectProcess(pid))) {
      return true;
    }
    await wait(200);
  }
  return false;
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(lockPath, value) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const tempPath = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  fs.renameSync(tempPath, lockPath);
}

function removeLock(lockPath) {
  fs.rmSync(lockPath, { force: true });
}

function sameWindowsPath(left, right) {
  return path.resolve(String(left || '')).toLowerCase()
    === path.resolve(String(right || '')).toLowerCase();
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const controller = createBackendProcessController(options);
  const command = options.command;
  const operation = command === 'stop' ? controller.stop() : controller.start();
  operation
    .then((result) => {
      console.log(command === 'stop'
        ? `Web backend stopped (PID ${result.pid || 'none'}).`
        : result.alreadyRunning
          ? `Web backend is already running (PID ${result.pid}).`
          : `Web backend started (PID ${result.pid}).`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === 'start' || value === 'stop') {
      options.command = value;
      continue;
    }
    if (!value.startsWith('--')) {
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    options[key] = argumentsList[index + 1] || '';
    index += 1;
  }
  return options;
}
