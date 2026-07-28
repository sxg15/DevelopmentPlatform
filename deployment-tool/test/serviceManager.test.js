import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { DeploymentStore } from '../src/main/core/deploymentStore.js';
import {
  inspectWindowsProcess,
  ServiceManager,
} from '../src/main/core/serviceManager.js';

test('service manager starts, verifies, and stops the managed Windows process', {
  timeout: 30_000,
  skip: process.platform !== 'win32',
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-service-manager-'));
  const store = new DeploymentStore(tempDir);
  const manager = new ServiceManager(store, { startTimeoutMs: 15_000 });
  const releaseId = 'service-test-release';
  const releaseDir = store.getReleasePath(releaseId);
  const appPort = await findFreePort();
  try {
    fs.mkdirSync(path.join(releaseDir, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'server'), { recursive: true });
    copyOrLink(process.execPath, path.join(releaseDir, 'runtime', 'node.exe'));
    fs.writeFileSync(path.join(releaseDir, 'server', 'index.js'), `
      import http from 'node:http';
      import fs from 'node:fs';
      const config = JSON.parse(fs.readFileSync(process.env.IGP_CONFIG_PATH, 'utf8'));
      const server = http.createServer((request, response) => {
        response.setHeader('content-type', request.url === '/api/health' ? 'application/json' : 'text/html');
        response.end(request.url === '/api/health'
          ? JSON.stringify({ ok: true, version: '9.9.9' })
          : '<!doctype html><div id="root">ok</div>');
      });
      server.listen(config.server.port, '127.0.0.1');
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => server.close(() => process.exit(0)));
      }
    `);
    fs.writeFileSync(store.configPath, JSON.stringify({
      server: { host: '127.0.0.1', port: appPort },
    }));
    store.registerRelease({
      releaseId,
      appVersion: '9.9.9',
      dependencyVersion: 'test',
      createdAt: new Date().toISOString(),
    });
    store.activateRelease(releaseId);

    const started = await manager.start();
    assert.equal(started.healthy, true);
    assert.equal(started.releaseId, releaseId);
    assert.equal(started.runtimeSha256.length, 64);
    assert.equal(fs.existsSync(store.stableNodePath), true);
    const status = await manager.getStatus();
    const processInfo = await inspectWindowsProcess(started.pid);
    assert.equal(status.usesStableRuntime, true);
    assert.equal(
      path.resolve(status.executablePath).toLowerCase(),
      path.resolve(store.stableNodePath).toLowerCase(),
    );
    assert.notEqual(
      path.resolve(processInfo.executablePath).toLowerCase(),
      path.resolve(releaseDir, 'runtime', 'node.exe').toLowerCase(),
    );
    const checks = await manager.runPostDeployChecks();
    assert.equal(checks.health.version, '9.9.9');
    assert.equal(checks.pageStatus, 200);
    assert.ok(checks.inspectorPort > 0);
    assert.equal(checks.usesStableRuntime, true);
    assert.equal(
      path.resolve(checks.executablePath).toLowerCase(),
      path.resolve(store.stableNodePath).toLowerCase(),
    );
    await manager.stop();
    assert.equal((await manager.getStatus()).running, false);
  } finally {
    await manager.stop({ force: true }).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('service manager rejects an application port owned by an unmanaged process', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-service-port-'));
  const store = new DeploymentStore(tempDir);
  const manager = new ServiceManager(store);
  const occupiedServer = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', resolve);
    });
    const appPort = occupiedServer.address().port;
    fs.writeFileSync(store.configPath, JSON.stringify({
      server: { host: '127.0.0.1', port: appPort },
    }));
    fs.mkdirSync(store.getReleasePath('occupied-port-release'), { recursive: true });
    store.registerRelease({
      releaseId: 'occupied-port-release',
      appVersion: '9.9.9',
      dependencyVersion: 'test',
      createdAt: new Date().toISOString(),
    });
    store.activateRelease('occupied-port-release');

    await assert.rejects(
      manager.start(),
      new RegExp(`服务端口 ${appPort} 已被非部署工具管理的进程占用`),
    );
  } finally {
    await new Promise((resolve) => occupiedServer.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('service manager waits for the active release version in health checks', {
  timeout: 30_000,
  skip: process.platform !== 'win32',
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-service-version-'));
  const store = new DeploymentStore(tempDir);
  const manager = new ServiceManager(store, { startTimeoutMs: 2500 });
  const releaseId = 'version-mismatch-release';
  const releaseDir = store.getReleasePath(releaseId);
  const appPort = await findFreePort();
  try {
    fs.mkdirSync(path.join(releaseDir, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'server'), { recursive: true });
    copyOrLink(process.execPath, path.join(releaseDir, 'runtime', 'node.exe'));
    fs.writeFileSync(path.join(releaseDir, 'server', 'index.js'), `
      import http from 'node:http';
      import fs from 'node:fs';
      const config = JSON.parse(fs.readFileSync(process.env.IGP_CONFIG_PATH, 'utf8'));
      const server = http.createServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, version: '1.0.0' }));
      });
      server.listen(config.server.port, '127.0.0.1');
    `);
    fs.writeFileSync(store.configPath, JSON.stringify({
      server: { host: '127.0.0.1', port: appPort },
    }));
    store.registerRelease({
      releaseId,
      appVersion: '2.0.0',
      dependencyVersion: 'test',
      createdAt: new Date().toISOString(),
    });
    store.activateRelease(releaseId);

    await assert.rejects(
      manager.start(),
      /健康检查版本不一致：期望 2\.0\.0，实际 1\.0\.0/,
    );
  } finally {
    await manager.stop({ force: true }).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('service status remains available when a running process has no health response', {
  timeout: 30_000,
  skip: process.platform !== 'win32',
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-service-unhealthy-'));
  const store = new DeploymentStore(tempDir);
  const manager = new ServiceManager(store);
  const serverDir = path.join(tempDir, 'server');
  const serverEntry = path.join(serverDir, 'index.js');
  const appPort = await findFreePort();
  let child = null;
  try {
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(serverEntry, 'setInterval(() => {}, 1000);');
    child = spawn(process.execPath, [serverEntry], {
      windowsHide: true,
      stdio: 'ignore',
    });
    manager.serviceState.write({
      schemaVersion: 1,
      pid: child.pid,
      releaseId: 'unhealthy-release',
      startedAt: new Date().toISOString(),
      appPort,
      inspectorPort: 0,
    });

    const status = await manager.getStatus();
    assert.equal(status.running, true);
    assert.equal(status.healthy, false);
    assert.equal(status.health, null);
    assert.ok(status.healthError);
  } finally {
    await manager.stop({ force: true }).catch(() => {});
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('service status preserves the recorded pid when process inspection times out', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-service-inspection-'));
  const inspectionError = Object.assign(new Error('powershell.exe 执行超时（5000ms）'), {
    code: 'PROCESS_TIMEOUT',
  });
  const store = new DeploymentStore(tempDir);
  const manager = new ServiceManager(store, {
    inspectProcess: async () => {
      throw inspectionError;
    },
  });
  try {
    manager.serviceState.write({
      schemaVersion: 1,
      pid: 43210,
      releaseId: 'inspection-timeout-release',
      startedAt: new Date().toISOString(),
      appPort: 3000,
      inspectorPort: 0,
      runtimeSha256: 'a'.repeat(64),
    });

    const status = await manager.getStatus();
    assert.equal(status.pid, 43210);
    assert.equal(status.running, false);
    assert.match(status.processInspectionError, /执行超时/);
    assert.equal(manager.serviceState.read().pid, 43210);
    await assert.rejects(
      manager.start(),
      /无法确认现有服务进程状态/,
    );
    await assert.rejects(
      manager.stop(),
      /无法确认服务进程状态/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function copyOrLink(source, destination) {
  try {
    fs.linkSync(source, destination);
  } catch {
    fs.copyFileSync(source, destination);
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
