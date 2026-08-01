import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decorateRoleState } from '../src/main/core/appState.js';
import { createReleaseId, validatePublishDirectory } from '../src/main/core/artifactBuilder.js';
import { selectTargetConnection } from '../src/main/core/developerController.js';
import { JsonStore } from '../src/main/core/jsonStore.js';
import { findStartupErrors, readLogChunk, rotateLogIfNeeded } from '../src/main/core/logReader.js';
import {
  listBroadcastAddresses,
  listLocalSubnetCandidates,
} from '../src/main/core/network.js';
import { resolveNpmInvocation } from '../src/main/core/npmRunner.js';
import {
  runProcess,
  terminateActiveProcesses,
} from '../src/main/core/processRunner.js';
import { resolveStartupMode } from '../src/main/core/startupMode.js';

test('json store merges defaults and atomically overwrites existing state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-json-store-'));
  try {
    const store = new JsonStore(path.join(tempDir, 'state.json'), {
      nested: { enabled: true, count: 1 },
      value: 'default',
    });
    assert.deepEqual(store.read(), {
      nested: { enabled: true, count: 1 },
      value: 'default',
    });
    store.write({ nested: { count: 2 } });
    assert.deepEqual(store.read(), {
      nested: { enabled: true, count: 2 },
      value: 'default',
    });
    store.update((current) => {
      current.value = 'updated';
      return current;
    });
    assert.equal(store.read().value, 'updated');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('log reader tails, rotates, and identifies startup failures', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-log-reader-'));
  const filePath = path.join(tempDir, 'server.err.log');
  try {
    fs.writeFileSync(filePath, 'Debugger listening on ws://127.0.0.1\nTypeError: failed\n');
    const result = readLogChunk(filePath, { limit: 1024 });
    assert.match(result.text, /TypeError/);
    assert.deepEqual(findStartupErrors(result.text), ['TypeError: failed']);
    assert.equal(rotateLogIfNeeded(filePath, 1), true);
    assert.equal(fs.existsSync(`${filePath}.1`), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('artifact utility validates portable output and creates stable release identifiers', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-publish-validation-'));
  try {
    for (const relativePath of [
      'client/index.html',
      'server/index.js',
      'server/runtime/backendProcessController.js',
      'runtime/node.exe',
      'runtime/npm/bin/npm-cli.js',
      'runtime/dependency-version.txt',
      'EnsureDependencies.ps1',
      'package.json',
      'package-lock.json',
    ]) {
      const filePath = path.join(tempDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'x');
    }
    assert.doesNotThrow(() => validatePublishDirectory(tempDir));
    assert.match(
      createReleaseId('0.2.0', new Date('2026-07-28T04:05:06Z')),
      /^0\.2\.0-20260728040506-[a-f0-9]{6}$/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('network discovery always includes the global IPv4 broadcast address', () => {
  assert.ok(listBroadcastAddresses().includes('255.255.255.255'));
});

test('subnet discovery includes peers across a /23 network without probing the local address', () => {
  const candidates = listLocalSubnetCandidates({
    networkInterfaces: {
      Linker: [{
        family: 'IPv4',
        internal: false,
        address: '10.88.0.10',
        netmask: '255.255.255.0',
        mac: '00:00:00:00:00:00',
      }],
      Ethernet: [{
        family: 'IPv4',
        internal: false,
        address: '172.16.20.134',
        netmask: '255.255.254.0',
        mac: 'e8:9c:25:9b:51:33',
      }],
    },
  });
  assert.ok(candidates.includes('172.16.20.205'));
  assert.ok(candidates.includes('172.16.21.254'));
  assert.equal(candidates.includes('172.16.20.134'), false);
  assert.equal(candidates.includes('172.16.20.0'), false);
  assert.equal(candidates.includes('172.16.21.255'), false);
  assert.ok(candidates.indexOf('172.16.20.205') < candidates.indexOf('10.88.0.11'));
});

test('startup command mode overrides persisted mode and invalid values are ignored', () => {
  assert.equal(resolveStartupMode('developer', 'target'), 'target');
  assert.equal(resolveStartupMode('target', ''), 'target');
  assert.equal(resolveStartupMode('invalid', 'developer'), 'developer');
  assert.equal(resolveStartupMode('invalid', 'invalid'), '');
});

test('role state events retain the application mode and reject stale role updates', () => {
  assert.deepEqual(
    decorateRoleState({ mode: 'developer', activeJobs: [] }, 'developer', true),
    {
      mode: 'developer',
      activeJobs: [],
      appMode: 'developer',
      openAtLogin: true,
    },
  );
  assert.equal(
    decorateRoleState({ mode: 'target' }, 'developer', false),
    null,
  );
});

test('closing the main window requests a full application shutdown', () => {
  const mainSource = fs.readFileSync(
    new URL('../src/main/main.js', import.meta.url),
    'utf8',
  );
  const closeHandlerStart = mainSource.indexOf("mainWindow.on('close'");
  assert.ok(closeHandlerStart >= 0);
  assert.match(
    mainSource.slice(closeHandlerStart, closeHandlerStart + 350),
    /requestApplicationQuit\(\)/,
  );
  assert.doesNotMatch(mainSource, /mainWindow\.hide\(\)/);
});

test('startup registers IPC before loading the renderer and reports initialization failures', () => {
  const mainSource = fs.readFileSync(
    new URL('../src/main/main.js', import.meta.url),
    'utf8',
  );
  const readyHandlerStart = mainSource.indexOf('app.whenReady().then');
  const readyHandler = mainSource.slice(readyHandlerStart, readyHandlerStart + 1800);
  assert.match(
    readyHandler,
    /registerIpcHandlers\(\);\s+createMainWindow\(\);/,
  );
  assert.match(readyHandler, /startConfiguredRoleSafely\(\)/);
  assert.match(mainSource, /if \(startupError\) \{\s+return buildStartupFailureState\(startupError\);/);

  const rendererSource = fs.readFileSync(
    new URL('../src/renderer/main.jsx', import.meta.url),
    'utf8',
  );
  assert.match(rendererSource, /state\.initializing/);
  assert.match(rendererSource, /state\.startupError/);
});

test('paired targets use a newly discovered address only when the certificate matches', () => {
  const fingerprint = 'a'.repeat(64);
  const saved = {
    targetId: 'target-test',
    address: '10.88.0.11',
    port: 47322,
    fingerprint,
  };
  assert.deepEqual(
    selectTargetConnection(saved, {
      targetId: 'target-test',
      address: '172.16.20.205',
      port: 47322,
      fingerprint,
    }),
    {
      ...saved,
      address: '172.16.20.205',
    },
  );
  assert.equal(
    selectTargetConnection(saved, {
      targetId: 'target-test',
      address: '192.168.1.20',
      port: 47322,
      fingerprint: 'b'.repeat(64),
    }).address,
    '10.88.0.11',
  );
});

test('npm runner bypasses Windows command shims and launches the npm CLI', async () => {
  const invocation = resolveNpmInvocation(['--version']);
  if (process.platform === 'win32') {
    assert.equal(path.extname(invocation.command).toLowerCase(), '.exe');
    assert.match(invocation.args[0], /npm-cli\.js$/i);
  }
  const result = await runProcess(invocation.command, invocation.args);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('active child processes are terminated during application shutdown', {
  timeout: 10_000,
}, async () => {
  const running = runProcess(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await terminateActiveProcesses();
  await assert.rejects(running);
});

test('process runner terminates commands that exceed their timeout', {
  timeout: 10_000,
}, async () => {
  await assert.rejects(
    runProcess(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], {
      timeoutMs: 100,
    }),
    (error) => error?.code === 'PROCESS_TIMEOUT' && /执行超时/.test(error.message),
  );
});
