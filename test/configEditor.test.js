import assert from 'node:assert/strict';
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
  assert.equal(disabled.aiPlanning.codex.model, '5.6sol');
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

  const errors = validateConfigDocument(config);
  assert.ok(errors.some((error) => error.path === 'updates.manifestUrl'));
  assert.ok(errors.some((error) => error.path === 'knowledgeBase.requirementsIdDigits'));
  assert.ok(errors.some((error) => error.path === 'bitable.personalSettings.defaultTime'));
  assert.ok(errors.some((error) => (
    error.path === 'bitable.projectPermission.fieldNames.permissionUsers'
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
