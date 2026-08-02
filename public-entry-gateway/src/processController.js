import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOCK_FILE_NAME = 'public-entry-gateway.lock';

export function createGatewayProcessController({
  rootDir,
  stateRoot,
  nodeExecutable,
  agentEntry,
  configPath,
  inspectProcess = inspectWindowsProcess,
  spawnProcess = spawn,
} = {}) {
  const resolvedRoot = path.resolve(rootDir || process.cwd());
  const resolvedStateRoot = path.resolve(stateRoot || path.join(resolvedRoot, 'runtime-state'));
  const resolvedNode = path.resolve(nodeExecutable || process.execPath);
  const resolvedEntry = path.resolve(agentEntry || path.join(resolvedRoot, 'src', 'agent.js'));
  const resolvedConfig = path.resolve(configPath || path.join(resolvedStateRoot, 'config.json'));
  const lockPath = path.join(resolvedStateRoot, LOCK_FILE_NAME);

  async function start() {
    const existing = readJson(lockPath);
    if (existing?.pid) {
      const processInfo = await inspectProcess(existing.pid);
      if (processInfo && matchesGatewayProcess(processInfo, resolvedNode, resolvedEntry)) {
        return { started: false, alreadyRunning: true, pid: existing.pid };
      }
      if (processInfo) {
        throw new Error('运行记录中的 PID 已被其他进程占用，拒绝启动');
      }
      fs.rmSync(lockPath, { force: true });
    }
    if (!fs.existsSync(resolvedConfig)) {
      throw new Error(`缺少运行配置：${resolvedConfig}`);
    }
    fs.mkdirSync(path.join(resolvedStateRoot, 'logs'), { recursive: true });
    const stdoutFd = fs.openSync(path.join(resolvedStateRoot, 'logs', 'agent.log'), 'a');
    const stderrFd = fs.openSync(path.join(resolvedStateRoot, 'logs', 'agent.err.log'), 'a');
    let child;
    try {
      child = spawnProcess(resolvedNode, [resolvedEntry], {
        cwd: resolvedRoot,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          IGP_PUBLIC_ENTRY_CONFIG_PATH: resolvedConfig,
        },
      });
      child.unref();
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    if (!child?.pid) {
      throw new Error('无法启动公网入口 Agent');
    }
    writeJson(lockPath, {
      schemaVersion: 1,
      pid: child.pid,
      nodeExecutable: resolvedNode,
      agentEntry: resolvedEntry,
      startedAt: new Date().toISOString(),
    });
    return { started: true, alreadyRunning: false, pid: child.pid };
  }

  async function stop() {
    const existing = readJson(lockPath);
    if (!existing?.pid) {
      return { stopped: true, alreadyStopped: true, pid: 0 };
    }
    const processInfo = await inspectProcess(existing.pid);
    if (!processInfo) {
      fs.rmSync(lockPath, { force: true });
      return { stopped: true, alreadyStopped: true, pid: existing.pid };
    }
    if (!matchesGatewayProcess(processInfo, resolvedNode, resolvedEntry)) {
      throw new Error('运行记录中的 PID 不属于公网入口 Agent，拒绝停止');
    }
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      // The verified process tree fallback below handles inaccessible processes.
    }
    if (!(await waitForExit(existing.pid, inspectProcess, 4000))) {
      await runTaskkill(existing.pid);
      if (!(await waitForExit(existing.pid, inspectProcess, 2000))) {
        throw new Error('公网入口 Agent 未能停止');
      }
    }
    fs.rmSync(lockPath, { force: true });
    return { stopped: true, alreadyStopped: false, pid: existing.pid };
  }

  return { start, stop };
}

export function matchesGatewayProcess(processInfo, nodeExecutable, agentEntry) {
  const commandLine = String(processInfo?.commandLine || '').replace(/\//g, '\\').toLowerCase();
  return sameWindowsPath(processInfo?.executablePath, nodeExecutable)
    && commandLine.includes(path.resolve(agentEntry).replace(/\//g, '\\').toLowerCase());
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
  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', script], 5000);
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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  fs.renameSync(tempPath, filePath);
}

function sameWindowsPath(left, right) {
  return path.resolve(String(left || '')).toLowerCase()
    === path.resolve(String(right || '')).toLowerCase();
}

async function waitForExit(pid, inspectProcess, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await inspectProcess(pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function runTaskkill(pid) {
  await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 5000);
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
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: Number(code), stdout, stderr });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const controller = createGatewayProcessController(options);
  const operation = options.command === 'stop' ? controller.stop() : controller.start();
  operation
    .then((result) => {
      console.log(options.command === 'stop'
        ? result.alreadyStopped
          ? 'Public entry gateway is already stopped.'
          : `Public entry gateway stopped (PID ${result.pid}).`
        : result.alreadyRunning
          ? `Public entry gateway is already running (PID ${result.pid}).`
          : `Public entry gateway started (PID ${result.pid}).`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === 'start' || value === 'stop') {
      options.command = value;
      continue;
    }
    if (!value.startsWith('--')) {
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    options[key] = args[index + 1] || '';
    index += 1;
  }
  return options;
}
