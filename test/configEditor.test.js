import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfigEditorStore } from '../server/config/configEditorStore.js';
import {
  applyConfigUpdate,
  createEditableConfig,
  validateConfigDocument,
} from '../server/config/configEditorUtils.js';

test('config editor redacts secrets while reporting configured state', () => {
  const result = createEditableConfig({
    feishu: {
      appId: 'app-id',
      appSecret: 'feishu-secret',
    },
    aiPlanning: {
      codex: {
        apiKey: 'codex-secret',
      },
    },
  });

  assert.equal(result.config.feishu.appSecret, '');
  assert.equal(result.config.aiPlanning.codex.apiKey, '');
  assert.equal(result.config.aiPlanning.codex.maxConcurrentRuns, 6);
  assert.equal(result.config.aiPlanning.codex.maxConcurrentRunsPerUser, 0);
  assert.equal(result.config.aiPlanning.codex.maxConcurrentRunsPerProject, 4);
  assert.equal(result.config.aiPlanning.assistant.enabled, true);
  assert.equal(result.config.aiPlanning.assistant.model, 'gpt-5.6-luna');
  assert.equal(result.config.aiPlanning.assistant.reasoningEffort, 'none');
  assert.equal(result.config.aiPlanning.assistant.fallbackModel, 'gpt-5.6-terra');
  assert.equal(result.config.aiPlanning.assistant.fallbackReasoningEffort, 'low');
  assert.equal(result.config.aiPlanning.assistant.requestTimeoutMs, 15_000);
  assert.equal(result.secretState['feishu.appSecret'], true);
  assert.equal(result.secretState['aiPlanning.codex.apiKey'], true);
});

test('config editor updates preserve unknown keys and apply explicit secret actions', () => {
  const current = {
    feishu: {
      appId: 'old-app',
      appSecret: 'existing-secret',
      futureSetting: 'keep-me',
    },
    aiPlanning: {
      codex: {
        apiKey: 'existing-key',
      },
    },
    futureSection: {
      enabled: true,
    },
  };

  const next = applyConfigUpdate(current, {
    feishu: {
      appId: 'new-app',
      appSecret: '',
    },
    aiPlanning: {
      codex: {
        apiKey: '',
      },
    },
  }, {
    'feishu.appSecret': { action: 'keep' },
    'aiPlanning.codex.apiKey': { action: 'replace', value: 'replacement-key' },
  });

  assert.equal(next.feishu.appId, 'new-app');
  assert.equal(next.feishu.appSecret, 'existing-secret');
  assert.equal(next.feishu.futureSetting, 'keep-me');
  assert.equal(next.aiPlanning.codex.apiKey, 'replacement-key');
  assert.deepEqual(next.futureSection, { enabled: true });
});

test('config editor allows incomplete disabled AI settings but validates enabled workspaces', () => {
  const disabled = createEditableConfig({}).config;
  disabled.aiPlanning.enabled = false;
  disabled.aiPlanning.projects = [{
    projectId: '',
    enabled: true,
    roots: [],
  }];
  assert.deepEqual(
    validateConfigDocument(disabled).filter((error) => error.path.startsWith('aiPlanning.')),
    [],
  );

  disabled.aiPlanning.enabled = true;
  assert.equal(disabled.aiPlanning.codex.model, 'gpt-5.6-sol');
  assert.equal(disabled.aiPlanning.codex.apiBaseUrl, 'https://api.openai.com/v1');
  const enabledErrors = validateConfigDocument(disabled);
  assert.ok(enabledErrors.some((error) => error.path === 'aiPlanning.codex.apiKey'));
  assert.ok(enabledErrors.some((error) => error.path.endsWith('.projectId')));
  assert.ok(enabledErrors.some((error) => error.path.endsWith('.roots')));
});

test('config editor aligns portable form validation with runtime configuration rules', () => {
  const config = createEditableConfig({}).config;
  config.updates.manifestUrl = 'http://example.test/manifest.json';
  config.knowledgeBase.requirementsIdDigits = 0;
  config.bitable.personalSettings.defaultTime = '25:10';
  config.bitable.projectPermission.fieldNames.permissionUsers = '研发';
  config.bitable.cache.eventDebounceMs = 0;
  config.aiPlanning.assistant.retentionDays = 0;
  config.aiPlanning.assistant.model = '';
  config.aiPlanning.assistant.fallbackModel = '';
  config.aiPlanning.assistant.requestTimeoutMs = 0;

  const errors = validateConfigDocument(config);
  assert.ok(errors.some((error) => error.path === 'updates.manifestUrl'));
  assert.ok(errors.some((error) => error.path === 'knowledgeBase.requirementsIdDigits'));
  assert.ok(errors.some((error) => error.path === 'bitable.personalSettings.defaultTime'));
  assert.ok(errors.some((error) => (
    error.path === 'bitable.projectPermission.fieldNames.permissionUsers'
  )));
  assert.ok(errors.some((error) => error.path === 'bitable.cache.eventDebounceMs'));
  assert.ok(errors.some((error) => error.path === 'aiPlanning.assistant.retentionDays'));
  assert.ok(errors.some((error) => error.path === 'aiPlanning.assistant.model'));
  assert.ok(errors.some((error) => error.path === 'aiPlanning.assistant.fallbackModel'));
  assert.ok(errors.some((error) => error.path === 'aiPlanning.assistant.requestTimeoutMs'));
});

test('config editor validates AI concurrency limits and legacy defaults', () => {
  const legacy = createEditableConfig({
    aiPlanning: {
      codex: {
        maxConcurrentRuns: 3,
      },
    },
  }).config;
  assert.equal(legacy.aiPlanning.codex.maxConcurrentRuns, 6);
  assert.equal(legacy.aiPlanning.codex.maxConcurrentRunsPerUser, 0);
  assert.equal(legacy.aiPlanning.codex.maxConcurrentRunsPerProject, 4);

  legacy.aiPlanning.codex.maxConcurrentRuns = 4;
  legacy.aiPlanning.codex.maxConcurrentRunsPerUser = 5;
  legacy.aiPlanning.codex.maxConcurrentRunsPerProject = 6;
  let errors = validateConfigDocument(legacy);
  assert.ok(errors.some((error) => (
    error.path === 'aiPlanning.codex.maxConcurrentRunsPerUser'
    && error.message.includes('不能超过')
  )));
  assert.ok(errors.some((error) => (
    error.path === 'aiPlanning.codex.maxConcurrentRunsPerProject'
    && error.message.includes('不能超过')
  )));

  legacy.aiPlanning.codex.maxConcurrentRunsPerUser = -1;
  errors = validateConfigDocument(legacy);
  assert.ok(errors.some((error) => (
    error.path === 'aiPlanning.codex.maxConcurrentRunsPerUser'
    && error.message.includes('非负整数')
  )));
});

test('config editor validates enabled AI roots against the local filesystem', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-config-editor-root-'));
  try {
    const config = createEditableConfig({}).config;
    config.aiPlanning = {
      enabled: true,
      codex: {
        model: 'codex-test',
        apiBaseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        reasoningEffort: 'high',
        requestTimeoutMs: 60_000,
        maxConcurrentRuns: 2,
        maxConcurrentRunsPerUser: 0,
        maxConcurrentRunsPerProject: 2,
      },
      projects: [{
        projectId: 'PROJECT-001',
        enabled: true,
        roots: [{
          id: 'main',
          path: tempDir,
          profile: 'auto',
        }],
      }],
    };

    assert.deepEqual(validateConfigDocument(config, {
      checkDirectory: (directoryPath) => fs.statSync(directoryPath).isDirectory(),
    }), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('config editor store saves transactionally, creates a backup, and detects conflicts', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-config-editor-store-'));
  try {
    const initial = {
      server: { host: '127.0.0.1', port: 3100 },
      feishu: { appId: 'app-id', appSecret: 'original-secret' },
      aiPlanning: { enabled: false },
      futureSection: { value: 7 },
    };
    fs.writeFileSync(
      path.join(rootDir, 'config.json'),
      `${JSON.stringify(initial, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'config.example.json'),
      `${JSON.stringify({ server: { port: 3000 } }, null, 2)}\n`,
      'utf8',
    );

    const store = createConfigEditorStore(rootDir);
    const loaded = store.read();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.config.feishu.appSecret, '');
    loaded.config.server.port = 3200;

    const saved = store.save({
      revision: loaded.revision,
      config: loaded.config,
      secretChanges: {
        'feishu.appSecret': { action: 'keep' },
        'aiPlanning.codex.apiKey': { action: 'keep' },
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(fs.existsSync(path.join(rootDir, 'config.json.bak')), true);

    const persisted = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
    assert.equal(persisted.server.port, 3200);
    assert.equal(persisted.feishu.appSecret, 'original-secret');
    assert.equal(persisted.aiPlanning.codex.maxConcurrentRuns, 6);
    assert.equal(persisted.aiPlanning.codex.maxConcurrentRunsPerUser, 0);
    assert.equal(persisted.aiPlanning.codex.maxConcurrentRunsPerProject, 4);
    assert.deepEqual(persisted.futureSection, { value: 7 });

    const conflict = store.save({
      revision: loaded.revision,
      config: loaded.config,
      secretChanges: {},
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'CONFIG_CHANGED');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('config editor round-trips the per-project AI prelude prompt', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-config-editor-prompt-'));
  try {
    fs.writeFileSync(
      path.join(rootDir, 'config.json'),
      `${JSON.stringify({
        server: { host: '127.0.0.1', port: 3000 },
        aiPlanning: {
          enabled: false,
          projects: [{
            projectId: '50',
            enabled: true,
            preludePrompt: 'Original project prompt',
            roots: [],
          }],
        },
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'config.example.json'),
      `${JSON.stringify({ server: { port: 3000 } }, null, 2)}\n`,
      'utf8',
    );

    const store = createConfigEditorStore(rootDir);
    const loaded = store.read();
    assert.equal(loaded.ok, true);
    assert.equal(
      loaded.config.aiPlanning.projects[0].preludePrompt,
      'Original project prompt',
    );

    loaded.config.aiPlanning.projects[0].preludePrompt = [
      'Follow the target project conventions.',
      'Reuse the existing service layer.',
    ].join('\n');
    const saved = store.save({
      revision: loaded.revision,
      config: loaded.config,
      secretChanges: {
        'feishu.appSecret': { action: 'keep' },
        'aiPlanning.codex.apiKey': { action: 'keep' },
      },
    });
    assert.equal(saved.ok, true);

    const persisted = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
    assert.equal(
      persisted.aiPlanning.projects[0].preludePrompt,
      'Follow the target project conventions.\nReuse the existing service layer.',
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('config editor reports an enabled AI configuration without project mappings on load', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-config-editor-ai-errors-'));
  try {
    fs.writeFileSync(
      path.join(rootDir, 'config.json'),
      `${JSON.stringify({
        server: { host: '127.0.0.1', port: 3000 },
        feishu: { appId: 'app-id', appSecret: 'app-secret' },
        aiPlanning: {
          enabled: true,
          codex: {
            model: 'codex-test',
            apiBaseUrl: 'https://example.test/v1',
            apiKey: 'codex-secret',
          },
          projects: [],
        },
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'config.example.json'),
      `${JSON.stringify({ server: { port: 3000 } }, null, 2)}\n`,
      'utf8',
    );

    const loaded = createConfigEditorStore(rootDir).read();
    assert.equal(loaded.ok, true);
    assert.ok(loaded.errors.some((error) => error.path === 'aiPlanning.projects'));
    assert.equal(loaded.config.feishu.appSecret, '');
    assert.equal(loaded.config.aiPlanning.codex.apiKey, '');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('config editor renders missing AI project mappings as an actionable inline error', () => {
  const source = fs.readFileSync('config-editor/main.jsx', 'utf8');
  assert.match(source, /data-field-path="aiPlanning\.projects"/);
  assert.match(source, /添加项目映射/);
  assert.match(source, /payload\.errors/);
  assert.match(source, /AI 前置提示词/);
  assert.match(source, /preludePrompt/);
});

test('packaged config launchers use persistent managed target configuration', () => {
  const source = fs.readFileSync('scripts/build.ps1', 'utf8');

  assert.match(source, /\.\.\\\.\.\\state\\deployment\.json/);
  assert.match(source, /set "CONFIG_ROOT=%CD%"/);
  assert.match(source, /set "ASSETS_ROOT=%CD%"/);
  assert.match(source, /\.\.\\\.\.\\runtime\\node\.exe/);
  assert.match(source, /--root "%CONFIG_ROOT%" --assets-root "%ASSETS_ROOT%"/);
  assert.match(source, /stopConfigEditor\.js" --root "%CONFIG_ROOT%"/);
});

test('config editor server separates configuration and asset roots', {
  timeout: 10_000,
}, async () => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-config-editor-config-root-'));
  const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-config-editor-assets-root-'));
  const token = 'separate-root-test-token';
  const marker = '<main>separate asset root</main>';
  const lockPath = path.join(configRoot, 'runtime', 'config-editor.lock');
  let stderr = '';
  let child;

  try {
    fs.writeFileSync(
      path.join(configRoot, 'config.json'),
      `${JSON.stringify({
        server: { host: '127.0.0.1', port: 3210 },
        aiPlanning: { enabled: false },
      }, null, 2)}\n`,
      'utf8',
    );
    fs.mkdirSync(path.join(assetsRoot, 'config-editor'), { recursive: true });
    fs.writeFileSync(
      path.join(assetsRoot, 'config-editor', 'index.html'),
      marker,
      'utf8',
    );

    child = spawn(
      process.execPath,
      [
        path.resolve('server/config/configEditorServer.js'),
        '--root',
        configRoot,
        '--assets-root',
        assetsRoot,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          IGP_CONFIG_EDITOR_NO_BROWSER: '1',
          IGP_CONFIG_EDITOR_PORT: '0',
          IGP_CONFIG_EDITOR_TOKEN: token,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const metadata = await waitForEditorMetadata(lockPath, child, () => stderr);
    const pageResponse = await fetch(metadata.url);
    assert.equal(pageResponse.status, 200);
    assert.equal(await pageResponse.text(), marker);

    const configResponse = await fetch(new URL('/api/config', metadata.url), {
      headers: {
        'X-Config-Editor-Token': token,
      },
    });
    assert.equal(configResponse.status, 200);
    const configPayload = await configResponse.json();
    assert.equal(configPayload.ok, true);
    assert.equal(configPayload.config.server.port, 3210);

    const shutdownResponse = await fetch(new URL('/api/shutdown', metadata.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: new URL(metadata.url).origin,
        'X-Config-Editor-Token': token,
      },
      body: '{}',
    });
    assert.equal(shutdownResponse.status, 200);
    await waitForChildExit(child, 5_000);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(path.join(assetsRoot, 'runtime')), false);
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await waitForChildExit(child, 2_000).catch(() => {});
    }
    fs.rmSync(configRoot, { recursive: true, force: true });
    fs.rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test('config editor store can recover malformed JSON from the example config', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-config-editor-recovery-'));
  try {
    fs.writeFileSync(path.join(rootDir, 'config.json'), '{ invalid json', 'utf8');
    fs.writeFileSync(
      path.join(rootDir, 'config.example.json'),
      `${JSON.stringify({ server: { host: '127.0.0.1', port: 3000 } }, null, 2)}\n`,
      'utf8',
    );

    const store = createConfigEditorStore(rootDir);
    const broken = store.read();
    assert.equal(broken.ok, false);
    assert.equal(broken.code, 'CONFIG_JSON_INVALID');

    const recovered = store.recover('example');
    assert.equal(recovered.ok, true);
    assert.equal(store.read().ok, true);
    assert.ok(
      fs.readdirSync(rootDir).some((fileName) => fileName.startsWith('config.invalid-')),
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

async function waitForEditorMetadata(lockPath, child, readStderr, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Configuration editor exited early: ${readStderr()}`);
    }
    try {
      const metadata = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (metadata?.url) {
        return metadata;
      }
    } catch {
      // The lock is written before the server URL is available.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for configuration editor: ${readStderr()}`);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', handleExit);
      reject(new Error('Timed out waiting for configuration editor process to exit'));
    }, timeoutMs);
    const handleExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', handleExit);
  });
}
