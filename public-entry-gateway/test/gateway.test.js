import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ENTRY_STATUS,
  buildLocalRedirectUrl,
  decideEntry,
} from '../src/entryDecision.js';
import { normalizeGatewayConfig } from '../src/config.js';
import {
  buildFeishuAuthorizationUrl,
  FeishuOAuthStateStore,
} from '../src/feishuOAuth.js';
import { GatewayHealthMonitor, readMaintenanceState } from '../src/healthMonitor.js';
import { isClientIpAllowed, isIpInCidr, normalizeIpAddress } from '../src/ipUtils.js';
import { SshTunnelManager } from '../src/sshTunnelManager.js';
import { createGatewayAgent } from '../src/agent.js';

const TOKEN = 'a'.repeat(48);

test('gateway config keeps loopback listeners and resolves runtime paths', () => {
  const config = normalizeGatewayConfig({
    publicEntry: { relayToken: TOKEN },
    feishu: { appId: 'cli_test' },
    ssh: {
      identityFile: 'ssh/id_ed25519',
      knownHostsFile: 'ssh/known_hosts',
    },
  }, {
    configPath: 'C:\\gateway\\runtime-state\\config.json',
  });
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.feishu.appId, 'cli_test');
  assert.match(config.ssh.identityFile, /runtime-state[\\/]ssh[\\/]id_ed25519$/);
  assert.throws(
    () => normalizeGatewayConfig({
      server: { host: '0.0.0.0' },
      publicEntry: { relayToken: TOKEN },
    }),
    /回环地址/,
  );
});

test('relay token is optional when the loopback SSH tunnel is the trust boundary', () => {
  const config = normalizeGatewayConfig({});
  assert.equal(config.publicEntry.relayToken, '');
});

test('IP matching normalizes mapped IPv4 and supports CIDR allowlists', () => {
  assert.equal(normalizeIpAddress('::ffff:47.100.74.169'), '47.100.74.169');
  assert.equal(isClientIpAllowed('47.100.74.169', '47.100.74.169'), true);
  assert.equal(isClientIpAllowed('203.0.113.9', '47.100.74.169', ['203.0.113.0/24']), true);
  assert.equal(isClientIpAllowed('203.0.114.9', '47.100.74.169', ['203.0.113.0/24']), false);
  assert.equal(isIpInCidr('2001:db8::9', '2001:db8::/32'), true);
});

test('entry decision fails closed and redirects only to configured LAN origin', () => {
  const base = {
    relayToken: TOKEN,
    expectedRelayToken: TOKEN,
    clientIp: '47.100.74.169',
    agentPublicIp: '47.100.74.169',
    additionalAllowedCidrs: [],
    maintenance: { active: false },
    ready: true,
    localBaseUrl: 'http://172.16.20.205:3000/base/',
    publicBaseUrl: 'http://47.100.74.169/',
    requestTarget: '//evil.example/path?project=50',
  };
  const allowed = decideEntry(base);
  assert.equal(allowed.status, ENTRY_STATUS.REDIRECT);
  assert.equal(allowed.location, 'http://172.16.20.205:3000/base/path?project=50');
  assert.equal(decideEntry({ ...base, relayToken: 'invalid' }).statusCode, 403);
  assert.equal(decideEntry({
    ...base,
    relayToken: '',
    expectedRelayToken: '',
  }).statusCode, 302);
  assert.equal(decideEntry({ ...base, clientIp: '198.51.100.1' }).statusCode, 403);
  assert.equal(decideEntry({
    ...base,
    maintenance: { active: true, phase: 'rollback' },
  }).status, ENTRY_STATUS.MAINTENANCE);
  assert.equal(decideEntry({ ...base, ready: false }).status, ENTRY_STATUS.UNAVAILABLE);
});

test('redirect builder preserves path and query without accepting a supplied host', () => {
  assert.equal(buildLocalRedirectUrl({
    localBaseUrl: 'http://172.16.20.205:3000/',
    publicBaseUrl: 'http://47.100.74.169/',
    requestTarget: 'http://evil.example/projects/50?tool=bugs',
  }), 'http://172.16.20.205:3000/projects/50?tool=bugs');
});

test('stale maintenance markers are ignored only after backend readiness', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-entry-maintenance-'));
  const maintenancePath = path.join(tempDir, 'state.json');
  fs.writeFileSync(maintenancePath, JSON.stringify({
    active: true,
    phase: 'upgrading',
    updatedAt: '2026-08-02T00:00:00.000Z',
  }));
  try {
    const now = Date.parse('2026-08-02T01:00:00.000Z');
    assert.equal(readMaintenanceState(maintenancePath, now, 1000, false).active, true);
    const readyState = readMaintenanceState(maintenancePath, now, 1000, true);
    assert.equal(readyState.active, false);
    assert.equal(readyState.stale, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('failed public IP probes do not refresh the last successful result', async () => {
  let now = 1000;
  let shouldFail = false;
  const config = normalizeGatewayConfig({
    monitoring: {
      publicIpMaxAgeMs: 500,
    },
  });
  const monitor = new GatewayHealthMonitor(config, {
    now: () => now,
    fetchImpl: async () => {
      if (shouldFail) {
        throw new Error('probe unavailable');
      }
      return {
        ok: true,
        async text() {
          return '47.100.74.169';
        },
      };
    },
  });

  await monitor.refreshPublicIp();
  assert.equal(monitor.getStatus().publicIpFresh, true);
  assert.equal(monitor.state.publicIpCheckedAt, 1000);

  now = 2000;
  shouldFail = true;
  await monitor.refreshPublicIp();
  const status = monitor.getStatus();
  assert.equal(status.publicIp, '');
  assert.equal(status.publicIpFresh, false);
  assert.equal(status.publicIpCheckedAt, 1000);
  assert.equal(status.publicIpAttemptedAt, 2000);
  assert.equal(status.publicIpError, 'probe unavailable');
});

test('Feishu OAuth states are one-time, bounded and expiring', () => {
  let now = 1000;
  let seed = 0;
  const store = new FeishuOAuthStateStore({
    now: () => now,
    ttlMs: 500,
    maxStates: 2,
    randomBytesImpl: () => Buffer.alloc(24, ++seed),
  });

  const first = store.create('http://172.16.20.205:3000/first');
  assert.equal(store.consume(first), 'http://172.16.20.205:3000/first');
  assert.equal(store.consume(first), '');

  const expired = store.create('http://172.16.20.205:3000/expired');
  now = 1600;
  assert.equal(store.consume(expired), '');

  const authorizationUrl = new URL(buildFeishuAuthorizationUrl({
    appId: 'cli_test',
    redirectUri: 'http://47.100.74.169/',
    scope: 'contact:user.base:readonly',
    state: 'state-token',
  }));
  assert.equal(authorizationUrl.origin, 'https://accounts.feishu.cn');
  assert.equal(authorizationUrl.pathname, '/open-apis/authen/v1/authorize');
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'cli_test');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'http://47.100.74.169/');
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.get('scope'), 'contact:user.base:readonly');
  assert.equal(authorizationUrl.searchParams.get('state'), 'state-token');
});

test('SSH tunnel arguments are restricted, pinned and reverse-only', () => {
  const config = normalizeGatewayConfig({
    publicEntry: { relayToken: TOKEN },
    ssh: {
      executable: process.execPath,
      identityFile: process.execPath,
      knownHostsFile: process.execPath,
    },
  });
  const manager = new SshTunnelManager(config);
  const args = manager.buildArguments();
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('127.0.0.1:18080:127.0.0.1:3100'));
  assert.ok(args.includes(`UserKnownHostsFile="${config.ssh.knownHostsFile}"`));
  assert.equal(args.includes('-L'), false);
});

test('SSH tunnel reconnects after an unexpected exit', () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  let scheduled = null;
  const config = normalizeGatewayConfig({
    publicEntry: { relayToken: TOKEN },
    ssh: {
      executable: process.execPath,
      identityFile: process.execPath,
      knownHostsFile: process.execPath,
    },
  });
  const manager = new SshTunnelManager(config, {
    spawnProcess: () => child,
    setTimeoutImpl: (callback, delay) => {
      scheduled = { callback, delay, unref() {} };
      return scheduled;
    },
    logger: { log() {}, error() {} },
  });
  manager.start();
  child.emit('spawn');
  child.emit('close', 255);
  assert.equal(scheduled.delay, 1000);
});

test('HTTP agent returns redirect, forbidden and maintenance responses', async () => {
  const config = normalizeGatewayConfig({
    server: { port: 3199 },
    publicEntry: { relayToken: TOKEN },
    feishu: { appId: 'cli_test' },
    ssh: {
      executable: process.execPath,
      identityFile: process.execPath,
      knownHostsFile: process.execPath,
    },
  });
  const state = {
    publicIp: '47.100.74.169',
    publicIpFresh: true,
    ready: true,
    maintenance: { active: false },
  };
  const agent = await createGatewayAgent(config, {
    monitor: {
      async start() {},
      stop() {},
      getStatus: () => state,
    },
    tunnel: {
      start() {},
      async stop() {},
    },
    feishuOAuthStateStore: new FeishuOAuthStateStore(),
    logger: { log() {}, error() {} },
  });
  await agent.start();
  try {
    const redirect = await requestAgent(config.server.port, '/projects/50?tool=bugs', {
      'x-igp-relay-token': TOKEN,
      'x-igp-client-ip': '47.100.74.169',
    });
    assert.equal(redirect.statusCode, 302);
    assert.equal(
      redirect.headers.location,
      'http://172.16.20.205:3000/projects/50?tool=bugs',
    );

    const feishuLogin = await requestAgent(config.server.port, '/projects/50?tool=bugs', {
      'user-agent': 'Mozilla/5.0 Feishu/7.0',
      'x-igp-relay-token': TOKEN,
      'x-igp-client-ip': '47.100.74.169',
    });
    assert.equal(feishuLogin.statusCode, 302);
    const authorizationUrl = new URL(feishuLogin.headers.location);
    assert.equal(authorizationUrl.origin, 'https://accounts.feishu.cn');
    assert.equal(authorizationUrl.searchParams.get('client_id'), 'cli_test');
    assert.equal(
      authorizationUrl.searchParams.get('redirect_uri'),
      'http://47.100.74.169/',
    );
    assert.equal(
      authorizationUrl.searchParams.get('scope'),
      'contact:user.base:readonly',
    );
    const oauthState = authorizationUrl.searchParams.get('state');
    assert.ok(oauthState);

    const oauthCallback = await requestAgent(
      config.server.port,
      `/?code=auth-code&state=${encodeURIComponent(oauthState)}`,
      {
        'user-agent': 'Mozilla/5.0 Feishu/7.0 WebApp/appCenter',
        'x-igp-relay-token': TOKEN,
        'x-igp-client-ip': '47.100.74.169',
      },
    );
    assert.equal(oauthCallback.statusCode, 302);
    assert.equal(
      oauthCallback.headers.location,
      'http://172.16.20.205:3000/projects/50?tool=bugs&igpFeishuAuthCode=auth-code&igpFeishuOAuth=1',
    );

    const replayedCallback = await requestAgent(
      config.server.port,
      `/?code=auth-code&state=${encodeURIComponent(oauthState)}`,
      {
        'user-agent': 'Mozilla/5.0 Feishu/7.0 WebApp/appCenter',
        'x-igp-relay-token': TOKEN,
        'x-igp-client-ip': '47.100.74.169',
      },
    );
    assert.equal(replayedCallback.statusCode, 400);
    assert.match(replayedCallback.body, /登录请求已失效/);

    const forbidden = await requestAgent(config.server.port, '/', {
      'x-igp-relay-token': TOKEN,
      'x-igp-client-ip': '198.51.100.8',
    });
    assert.equal(forbidden.statusCode, 403);

    const forbiddenCallback = await requestAgent(config.server.port, '/?code=x&state=y', {
      'user-agent': 'Mozilla/5.0 Feishu/7.0 WebApp/appCenter',
      'x-igp-relay-token': TOKEN,
      'x-igp-client-ip': '198.51.100.8',
    });
    assert.equal(forbiddenCallback.statusCode, 403);

    state.maintenance = { active: true, phase: 'starting' };
    state.ready = false;
    const maintenance = await requestAgent(config.server.port, '/', {
      'x-igp-relay-token': TOKEN,
      'x-igp-client-ip': '47.100.74.169',
    });
    assert.equal(maintenance.statusCode, 503);
    assert.match(maintenance.body, /新版本正在启动/);
  } finally {
    await agent.stop();
  }
});

function requestAgent(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body,
      }));
    });
    request.once('error', reject);
    request.end();
  });
}
