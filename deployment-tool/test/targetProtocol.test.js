import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TargetDiscoveryScanner } from '../src/main/core/discovery.js';
import { TargetAgent } from '../src/main/core/targetAgent.js';
import { TargetClient } from '../src/main/core/targetClient.js';

test('target protocol pairs a pinned client and protects authenticated status', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-target-protocol-'));
  const controlPort = await findFreePort();
  const agent = new TargetAgent({
    userDataDir: tempDir,
    appVersion: '0.1.0-test',
  });
  agent.settingsStore.update((settings) => {
    settings.controlPort = controlPort;
    settings.displayName = 'Protocol Test Target';
    return settings;
  });

  try {
    const local = await agent.start();
    const unpaired = new TargetClient({
      address: '127.0.0.1',
      port: controlPort,
      fingerprint: local.fingerprint,
    });
    await assert.rejects(() => unpaired.getStatus(), /连接凭据无效/);

    const paired = await unpaired.pair({
      code: local.pairingCode,
      clientId: 'client-protocol-test',
      clientName: 'Protocol Test Client',
    });
    assert.equal(paired.targetId, local.targetId);
    const client = new TargetClient({
      address: '127.0.0.1',
      port: controlPort,
      fingerprint: local.fingerprint,
      token: paired.token,
      targetId: paired.targetId,
    });
    const status = await client.getStatus();
    assert.equal(status.targetId, local.targetId);
    assert.equal(status.service.running, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const repeatedStatus = await client.getStatus();
    assert.equal(repeatedStatus.targetId, local.targetId);

    const invalidArtifactPath = path.join(tempDir, 'invalid-release.tgz');
    const invalidArtifact = Buffer.from('not-a-valid-tar-archive');
    fs.writeFileSync(invalidArtifactPath, invalidArtifact);
    await assert.rejects(
      client.uploadAndDeploy({
        outputPath: invalidArtifactPath,
        size: invalidArtifact.length,
        sha256: crypto.createHash('sha256').update(invalidArtifact).digest('hex'),
      }),
    );
    assert.deepEqual(fs.readdirSync(agent.deploymentStore.uploadsDir), []);
  } finally {
    await agent.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('target discovery falls back to bounded subnet probes when UDP returns no targets', async () => {
  const probed = [];
  const scanner = new TargetDiscoveryScanner({
    timeoutMs: 10,
    fallbackConcurrency: 2,
    getBroadcastAddresses: () => [],
    getFallbackAddresses: () => ['172.16.20.204', '172.16.20.205'],
    probe: async (address, port, options) => {
      probed.push({ address, port, timeoutMs: options.timeoutMs });
      if (address !== '172.16.20.205') {
        throw new Error('not a target');
      }
      return {
        targetId: 'target-fallback-test',
        displayName: 'Fallback Target',
        address,
        port,
      };
    },
  });
  const targets = await scanner.scan();
  assert.deepEqual(targets, [{
    targetId: 'target-fallback-test',
    displayName: 'Fallback Target',
    address: '172.16.20.205',
    port: 47322,
  }]);
  assert.equal(probed.length, 2);
  assert.ok(probed.every((entry) => entry.timeoutMs === 600));
});

test('target discovery keeps the higher-priority address when concurrent probes race', async () => {
  const scanner = new TargetDiscoveryScanner({
    timeoutMs: 10,
    fallbackConcurrency: 2,
    getBroadcastAddresses: () => [],
    getFallbackAddresses: () => ['172.16.20.205', '10.88.0.11'],
    probe: async (address, port) => {
      if (address === '172.16.20.205') {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        targetId: 'target-address-priority',
        displayName: 'Address Priority Target',
        address,
        port,
      };
    },
  });

  const targets = await scanner.scan();
  assert.equal(targets[0].address, '172.16.20.205');
});

test('stopping the target agent also stops its managed service', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-target-stop-'));
  let stopCount = 0;
  const agent = new TargetAgent({
    userDataDir: tempDir,
    appVersion: '0.1.0-test',
    serviceManager: {
      async stop() {
        stopCount += 1;
        return { stopped: true };
      },
    },
  });
  try {
    await agent.stop();
    assert.equal(stopCount, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('target startup performs one complete service status read', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-target-start-'));
  const controlPort = await findFreePort();
  let statusReads = 0;
  const agent = new TargetAgent({
    userDataDir: tempDir,
    appVersion: '0.1.0-test',
    serviceManager: {
      async getStatus() {
        statusReads += 1;
        return {
          pid: 0,
          running: false,
          healthy: false,
          health: null,
        };
      },
      async stop() {
        return { stopped: true };
      },
    },
  });
  agent.settingsStore.update((settings) => {
    settings.controlPort = controlPort;
    return settings;
  });
  try {
    await agent.start();
    assert.equal(statusReads, 1);
  } finally {
    await agent.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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
