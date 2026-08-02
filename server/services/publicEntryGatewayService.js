import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const GATEWAY_DIRECTORY_NAME = 'public-entry-gateway';
const GATEWAY_STATE_DIRECTORY_NAME = 'public-entry-state';

export function createPublicEntryGatewayService(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
  const configPath = path.resolve(
    options.configPath
      || process.env.IGP_CONFIG_PATH
      || path.join(sourceRoot, 'config', 'config.json'),
  );
  const runProcess = options.runProcess || runChildProcess;
  const appId = String(options.appId || '').trim();
  const context = resolveManagedGatewayContext({
    sourceRoot,
    configPath,
    platform: options.platform || process.platform,
  });
  let lastResult = {
    enabled: Boolean(context),
    ready: false,
    publicKey: '',
    publicEntryUrl: 'http://47.100.74.169/',
    message: context ? '公网入口 Agent 尚未初始化' : '当前不是 Windows 托管部署',
  };

  async function ensureStarted() {
    if (!context) {
      return lastResult;
    }
    try {
      validateSourcePackage(context.sourceGatewayDir);
      await stopExistingGateway(context, runProcess);
      replaceGatewayPackage(context);
      await ensureGatewayState(context, runProcess, appId);
      await startGateway(context, runProcess);
      lastResult = {
        enabled: true,
        ready: true,
        publicKey: readPublicKey(context.publicKeyPath),
        publicEntryUrl: 'http://47.100.74.169/',
        localBaseUrl: 'http://172.16.20.205:3000/',
        message: '公网入口 Agent 已启动',
      };
    } catch (error) {
      lastResult = {
        enabled: true,
        ready: false,
        publicKey: safeReadPublicKey(context.publicKeyPath),
        publicEntryUrl: 'http://47.100.74.169/',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return lastResult;
  }

  function getBootstrapState() {
    if (!context) {
      return lastResult;
    }
    return {
      ...lastResult,
      publicKey: safeReadPublicKey(context.publicKeyPath),
      agentDiagnostic: readLatestAgentDiagnostic(context.gatewayStateDir),
    };
  }

  function markMaintenance(phase = 'upgrading') {
    if (!context) {
      return false;
    }
    writeJsonTransaction(context.maintenanceFile, {
      active: true,
      phase: String(phase || 'upgrading'),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  function clearMaintenance() {
    if (!context) {
      return false;
    }
    writeJsonTransaction(context.maintenanceFile, {
      active: false,
      phase: '',
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  return {
    context,
    ensureStarted,
    getBootstrapState,
    markMaintenance,
    clearMaintenance,
  };
}

export function resolveManagedGatewayContext({ sourceRoot, configPath, platform }) {
  if (platform !== 'win32') {
    return null;
  }
  const stateDir = path.dirname(path.resolve(configPath));
  if (path.basename(stateDir).toLowerCase() !== 'state') {
    return null;
  }
  const managedRoot = path.dirname(stateDir);
  if (path.basename(managedRoot).toLowerCase() !== 'managed-runtime') {
    return null;
  }
  const sourceGatewayDir = path.join(path.resolve(sourceRoot), GATEWAY_DIRECTORY_NAME);
  const stableGatewayDir = path.join(managedRoot, GATEWAY_DIRECTORY_NAME);
  const gatewayStateDir = path.join(managedRoot, GATEWAY_STATE_DIRECTORY_NAME);
  return {
    sourceGatewayDir,
    stableGatewayDir,
    gatewayStateDir,
    maintenanceFile: path.join(stateDir, 'public-entry-maintenance.json'),
    configPath: path.join(gatewayStateDir, 'config.json'),
    privateKeyPath: path.join(gatewayStateDir, 'ssh', 'id_ed25519'),
    publicKeyPath: path.join(gatewayStateDir, 'ssh', 'id_ed25519.pub'),
    knownHostsPath: path.join(gatewayStateDir, 'ssh', 'known_hosts'),
  };
}

function validateSourcePackage(sourceDir) {
  for (const relativePath of [
    'runtime/node.exe',
    'src/agent.js',
    'src/processController.js',
    'config.example.json',
    'server/known_hosts',
  ]) {
    const filePath = path.join(sourceDir, ...relativePath.split('/'));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`公网入口发布包缺少 ${relativePath}`);
    }
  }
}

async function stopExistingGateway(context, runProcess) {
  const runtime = path.join(context.stableGatewayDir, 'runtime', 'node.exe');
  const controller = path.join(context.stableGatewayDir, 'src', 'processController.js');
  if (!fs.existsSync(runtime) || !fs.existsSync(controller)) {
    return;
  }
  await runProcess(runtime, buildControllerArguments(context, runtime, 'stop'), {
    timeoutMs: 10_000,
  });
}

function replaceGatewayPackage(context) {
  const parentDir = path.dirname(context.stableGatewayDir);
  const tempDir = `${context.stableGatewayDir}.${process.pid}.${Date.now()}.pending`;
  const rollbackDir = `${context.stableGatewayDir}.${process.pid}.${Date.now()}.rollback`;
  fs.mkdirSync(parentDir, { recursive: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.cpSync(context.sourceGatewayDir, tempDir, { recursive: true, force: true });
  let movedCurrent = false;
  try {
    if (fs.existsSync(context.stableGatewayDir)) {
      fs.renameSync(context.stableGatewayDir, rollbackDir);
      movedCurrent = true;
    }
    fs.renameSync(tempDir, context.stableGatewayDir);
    fs.rmSync(rollbackDir, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (movedCurrent && !fs.existsSync(context.stableGatewayDir) && fs.existsSync(rollbackDir)) {
      fs.renameSync(rollbackDir, context.stableGatewayDir);
    }
    throw error;
  }
}

async function ensureGatewayState(context, runProcess, appId) {
  fs.mkdirSync(path.dirname(context.privateKeyPath), { recursive: true });
  fs.copyFileSync(
    path.join(context.stableGatewayDir, 'server', 'known_hosts'),
    context.knownHostsPath,
  );
  if (!fs.existsSync(context.privateKeyPath) || !fs.existsSync(context.publicKeyPath)) {
    const sshKeygen = path.join(
      process.env.WINDIR || 'C:\\Windows',
      'System32',
      'OpenSSH',
      'ssh-keygen.exe',
    );
    await runProcess(sshKeygen, [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'igp-entry@172.16.20.205',
      '-f',
      context.privateKeyPath,
    ], {
      timeoutMs: 15_000,
    });
  }
  writeGatewayConfig(context, appId);
}

function writeGatewayConfig(context, appId) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(context.configPath, 'utf8'));
  } catch {
    config = JSON.parse(fs.readFileSync(
      path.join(context.stableGatewayDir, 'config.example.json'),
      'utf8',
    ));
  }
  config.publicEntry = {
    ...(config.publicEntry || {}),
    baseUrl: 'http://47.100.74.169/',
    clientIpProbeUrl: 'http://47.100.74.169/__igp/client-ip',
    relayToken: '',
  };
  config.localPlatform = {
    ...(config.localPlatform || {}),
    baseUrl: 'http://172.16.20.205:3000/',
    healthUrl: 'http://127.0.0.1:3000/api/health',
  };
  config.feishu = {
    ...(config.feishu || {}),
    appId,
  };
  config.ssh = {
    ...(config.ssh || {}),
    executable: path.join(
      process.env.WINDIR || 'C:\\Windows',
      'System32',
      'OpenSSH',
      'ssh.exe',
    ),
    host: '47.100.74.169',
    port: 22,
    user: 'igp-entry',
    identityFile: context.privateKeyPath,
    knownHostsFile: context.knownHostsPath,
    remoteBindHost: '127.0.0.1',
    remoteBindPort: 18080,
  };
  config.deployment = {
    ...(config.deployment || {}),
    maintenanceFile: context.maintenanceFile,
  };
  writeJsonTransaction(context.configPath, config);
}

async function startGateway(context, runProcess) {
  const runtime = path.join(context.stableGatewayDir, 'runtime', 'node.exe');
  await runProcess(runtime, buildControllerArguments(context, runtime, 'start'), {
    timeoutMs: 10_000,
  });
}

function buildControllerArguments(context, runtime, command) {
  return [
    path.join(context.stableGatewayDir, 'src', 'processController.js'),
    command,
    '--root',
    context.stableGatewayDir,
    '--state-root',
    context.gatewayStateDir,
    '--node-exe',
    runtime,
    '--agent-entry',
    path.join(context.stableGatewayDir, 'src', 'agent.js'),
    '--config-path',
    context.configPath,
  ];
}

function readPublicKey(filePath) {
  const value = fs.readFileSync(filePath, 'utf8').trim();
  if (!value.startsWith('ssh-ed25519 ')) {
    throw new Error('公网入口 SSH 公钥格式无效');
  }
  return value;
}

function safeReadPublicKey(filePath) {
  try {
    return readPublicKey(filePath);
  } catch {
    return '';
  }
}

export function readLatestAgentDiagnostic(stateDir) {
  const candidates = [
    path.join(stateDir, 'logs', 'agent.log'),
    path.join(stateDir, 'logs', 'agent.err.log'),
  ].flatMap((filePath) => {
    try {
      return [{
        filePath,
        modifiedAt: fs.statSync(filePath).mtimeMs,
      }];
    } catch {
      return [];
    }
  }).sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of candidates) {
    const lines = readLastNonemptyLines(candidate.filePath);
    if (lines.length) {
      return sanitizeAgentDiagnostic(lines.join(' | '));
    }
  }
  return '';
}

function readLastNonemptyLines(filePath) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, 8192);
  if (!length) {
    return [];
  }
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
    return buffer.toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-5);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sanitizeAgentDiagnostic(value) {
  return String(value || '')
    .replace(
      /[A-Za-z]:\\.*?(?=\s+(?:token|password|secret)=|$)/gi,
      '<path>',
    )
    .replace(/\bssh-ed25519\s+[A-Za-z0-9+/=]+/g, 'ssh-ed25519 <redacted>')
    .replace(/\b(token|password|secret)=\S+/gi, '$1=<redacted>')
    .slice(0, 500);
}

function writeJsonTransaction(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const rollbackPath = `${filePath}.${process.pid}.${Date.now()}.rollback`;
  let movedCurrent = false;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, rollbackPath);
      movedCurrent = true;
    }
    fs.renameSync(tempPath, filePath);
    fs.rmSync(rollbackPath, { force: true });
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    if (movedCurrent && !fs.existsSync(filePath) && fs.existsSync(rollbackPath)) {
      fs.renameSync(rollbackPath, filePath);
    }
    throw error;
  }
}

function runChildProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} 执行超时`));
    }, options.timeoutMs || 10_000);
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
      const result = { code: Number(code), stdout, stderr };
      if (result.code !== 0 && options.rejectOnError !== false) {
        reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} 执行失败`));
        return;
      }
      resolve(result);
    });
  });
}
