import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ArtifactBuilder } from '../src/main/core/artifactBuilder.js';
import { TargetAgent } from '../src/main/core/targetAgent.js';
import { TargetClient } from '../src/main/core/targetClient.js';

const projectDir = path.resolve(import.meta.dirname, '../..');
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-lan-deploy-e2e-'));
const targetDir = path.join(smokeRoot, 'target');
const builderDir = path.join(smokeRoot, 'builder');
const controlPort = await findFreePort();
const appPort = await findFreePort();
const agent = new TargetAgent({
  userDataDir: targetDir,
  appVersion: 'e2e',
});
let artifact = null;

try {
  agent.settingsStore.update((settings) => {
    settings.controlPort = controlPort;
    settings.displayName = 'E2E Target';
    return settings;
  });
  fs.writeFileSync(agent.deploymentStore.configPath, `${JSON.stringify({
    server: {
      host: '127.0.0.1',
      port: appPort,
    },
    feishu: {
      appId: '',
      appSecret: '',
    },
    aiPlanning: {
      enabled: false,
    },
  }, null, 2)}\n`);
  const targetState = await agent.start();
  const pairingClient = new TargetClient({
    address: '127.0.0.1',
    port: controlPort,
    fingerprint: targetState.fingerprint,
  });
  const pairing = await pairingClient.pair({
    code: targetState.pairingCode,
    clientId: 'client-e2e-smoke',
    clientName: 'E2E Smoke',
  });
  const client = new TargetClient({
    address: '127.0.0.1',
    port: controlPort,
    fingerprint: targetState.fingerprint,
    targetId: pairing.targetId,
    token: pairing.token,
  });

  const builder = new ArtifactBuilder({
    cacheDir: path.join(builderDir, 'cache'),
    tempDir: path.join(builderDir, 'temp'),
  });
  artifact = await builder.buildFromRepository(projectDir, {
    onProgress(progress) {
      console.log(`[e2e] ${progress.phase}: ${progress.message || ''}`);
    },
    onOutput({ text }) {
      for (const line of String(text || '').split(/\r?\n/).filter(Boolean)) {
        console.log(`[e2e] ${line}`);
      }
    },
  });
  const deployed = await client.uploadAndDeploy(artifact, {
    onProgress(progress) {
      const percent = Math.round(progress.uploadedBytes / progress.totalBytes * 100);
      console.log(`[e2e] upload: ${percent}%`);
    },
  });
  if (
    deployed.manifest.appVersion !== artifact.appVersion
    || deployed.checks.health.version !== artifact.appVersion
    || !deployed.checks.ok
  ) {
    throw new Error('End-to-end deployment checks returned inconsistent versions');
  }
  const status = await client.getStatus();
  if (!status.service.running || !status.service.healthy) {
    throw new Error('Target service is not healthy after deployment');
  }
  await client.stopService();
  console.log(
    `[e2e] passed: ${artifact.appVersion}, release ${artifact.releaseId}, port ${appPort}`,
  );
} finally {
  artifact?.cleanup?.();
  await agent.serviceManager.stop({ force: true }).catch(() => {});
  await agent.stop().catch(() => {});
  fs.rmSync(smokeRoot, { recursive: true, force: true });
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
