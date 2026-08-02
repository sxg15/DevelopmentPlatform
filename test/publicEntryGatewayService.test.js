import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPublicEntryGatewayService,
  readLatestAgentDiagnostic,
  resolveManagedGatewayContext,
} from '../server/services/publicEntryGatewayService.js';

test('public entry gateway only provisions inside a Windows managed runtime', () => {
  assert.equal(resolveManagedGatewayContext({
    sourceRoot: 'D:\\release',
    configPath: 'D:\\portable\\config.json',
    platform: 'win32',
  }), null);
  assert.equal(resolveManagedGatewayContext({
    sourceRoot: 'D:\\release',
    configPath: 'C:\\managed-runtime\\state\\config.json',
    platform: 'linux',
  }), null);
  const context = resolveManagedGatewayContext({
    sourceRoot: 'D:\\release',
    configPath: 'C:\\managed-runtime\\state\\config.json',
    platform: 'win32',
  });
  assert.match(context.stableGatewayDir, /managed-runtime[\\/]public-entry-gateway$/);
  assert.match(context.maintenanceFile, /state[\\/]public-entry-maintenance\.json$/);
});

test('managed startup preserves target-owned state and returns only the public key', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-public-entry-service-'));
  const releaseRoot = path.join(tempDir, 'release');
  const managedRoot = path.join(tempDir, 'managed-runtime');
  const sourceGateway = path.join(releaseRoot, 'public-entry-gateway');
  for (const relativePath of [
    'runtime/node.exe',
    'src/agent.js',
    'src/processController.js',
    'server/known_hosts',
  ]) {
    const filePath = path.join(sourceGateway, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, relativePath);
  }
  fs.writeFileSync(path.join(sourceGateway, 'server', 'known_hosts'), '47.100.74.169 ssh-ed25519 key\n');
  fs.writeFileSync(path.join(sourceGateway, 'config.example.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: 3100 },
    publicEntry: { relayToken: '' },
    localPlatform: {},
    ssh: {},
    deployment: {},
  }));

  const commands = [];
  const service = createPublicEntryGatewayService({
    sourceRoot: releaseRoot,
    configPath: path.join(managedRoot, 'state', 'config.json'),
    platform: 'win32',
    runProcess: async (command, args) => {
      commands.push({ command, args });
      if (String(command).toLowerCase().endsWith('ssh-keygen.exe')) {
        const keyPath = args[args.indexOf('-f') + 1];
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        fs.writeFileSync(keyPath, 'private');
        fs.writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAATEST igp-entry\n');
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  try {
    const result = await service.ensureStarted();
    assert.equal(result.ready, true);
    assert.equal(result.publicKey, 'ssh-ed25519 AAAATEST igp-entry');
    assert.equal(commands.some((item) => item.args.includes('start')), true);
    const runtimeConfig = JSON.parse(fs.readFileSync(
      path.join(managedRoot, 'public-entry-state', 'config.json'),
      'utf8',
    ));
    assert.equal(runtimeConfig.localPlatform.baseUrl, 'http://172.16.20.205:3000/');
    assert.equal(runtimeConfig.publicEntry.relayToken, '');
    assert.equal(
      runtimeConfig.deployment.maintenanceFile,
      path.join(managedRoot, 'state', 'public-entry-maintenance.json'),
    );
    const bootstrap = service.getBootstrapState();
    assert.equal('privateKey' in bootstrap, false);
    assert.equal('relayToken' in bootstrap, false);

    assert.equal(service.markMaintenance('upgrading'), true);
    const maintenancePath = path.join(
      managedRoot,
      'state',
      'public-entry-maintenance.json',
    );
    const activeMaintenance = JSON.parse(fs.readFileSync(maintenancePath, 'utf8'));
    assert.equal(activeMaintenance.active, true);
    assert.equal(activeMaintenance.phase, 'upgrading');
    assert.ok(Date.parse(activeMaintenance.updatedAt));

    assert.equal(service.clearMaintenance(), true);
    const clearedMaintenance = JSON.parse(fs.readFileSync(maintenancePath, 'utf8'));
    assert.equal(clearedMaintenance.active, false);
    assert.equal(clearedMaintenance.phase, '');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('managed startup does not replace the package when verified stop fails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-public-entry-stop-'));
  const releaseRoot = path.join(tempDir, 'release');
  const managedRoot = path.join(tempDir, 'managed-runtime');
  const sourceGateway = path.join(releaseRoot, 'public-entry-gateway');
  const stableGateway = path.join(managedRoot, 'public-entry-gateway');
  for (const relativePath of [
    'runtime/node.exe',
    'src/agent.js',
    'src/processController.js',
    'server/known_hosts',
  ]) {
    const sourcePath = path.join(sourceGateway, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, `new:${relativePath}`);
    const stablePath = path.join(stableGateway, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(stablePath), { recursive: true });
    fs.writeFileSync(stablePath, `old:${relativePath}`);
  }
  fs.writeFileSync(path.join(sourceGateway, 'config.example.json'), '{}');

  const service = createPublicEntryGatewayService({
    sourceRoot: releaseRoot,
    configPath: path.join(managedRoot, 'state', 'config.json'),
    platform: 'win32',
    runProcess: async (_command, args) => {
      if (args.includes('stop')) {
        throw new Error('verified stop failed');
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  try {
    const result = await service.ensureStarted();
    assert.equal(result.ready, false);
    assert.match(result.message, /verified stop failed/);
    assert.equal(
      fs.readFileSync(path.join(stableGateway, 'src', 'agent.js'), 'utf8'),
      'old:src/agent.js',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('public entry diagnostics return only the latest sanitized Agent line', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-public-entry-log-'));
  const logDir = path.join(tempDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, 'agent.log');
  const stderrPath = path.join(logDir, 'agent.err.log');
  fs.writeFileSync(stdoutPath, 'SSH tunnel started\n');
  fs.writeFileSync(
    stderrPath,
    [
      'Identity file C:\\Users\\Administrator\\secret\\id_ed25519 token=hidden-value',
      'SSH tunnel exited',
    ].join('\n'),
  );
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(stderrPath, future, future);
  try {
    const diagnostic = readLatestAgentDiagnostic(tempDir);
    assert.equal(diagnostic.includes('Administrator'), false);
    assert.equal(diagnostic.includes('hidden-value'), false);
    assert.match(diagnostic, /<path>/);
    assert.match(diagnostic, /token=<redacted>/);
    assert.match(diagnostic, /SSH tunnel exited/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
