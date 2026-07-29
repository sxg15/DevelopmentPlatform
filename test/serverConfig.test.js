import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../server/config/normalizeConfig.js';
import { DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD } from '../shared/workItemAssignmentUtils.js';

test('packaged example config includes the development platform AI project preset', () => {
  const exampleConfig = JSON.parse(
    fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'),
  );
  const project = exampleConfig.aiPlanning.projects.find((entry) => entry.projectId === '50');

  assert.ok(project);
  assert.equal(project.enabled, true);
  assert.equal(project.preludePrompt, '');
  assert.deepEqual(project.roots, [{
    id: 'main',
    path: 'D:\\DevelopmentPlatformProject',
    profile: 'auto',
  }]);
});

test('server config normalization preserves workflow field defaults', () => {
  const config = normalizeConfig({});

  assert.equal(config.server.host, '0.0.0.0');
  assert.equal(config.server.port, 3000);
  assert.equal(
    config.knowledgeBase.requirementsFieldNames.requiresSubmissionAttachment,
    '需要提交附件',
  );
  assert.equal(
    config.knowledgeBase.requirementsFieldNames.submittedAttachments,
    '提交附件',
  );
  assert.equal(
    config.bitable.projectPermission.fieldNames.developmentSuperAdmins,
    DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD,
  );
  assert.equal(config.bitable.personalSettings.wikiNodeToken, 'PDcJwzNTIiJHzNkcM0Gc3Cy1nRd');
  assert.equal(config.bitable.personalSettings.defaultTime, '11:00');
  assert.equal(
    config.bitable.personalSettings.fieldNames.todoNotificationTime,
    '待办事项通知时间',
  );
  assert.equal(
    config.bitable.personalSettings.fieldNames.developmentPlatformToken,
    '开发平台令牌',
  );
  assert.equal(config.bitable.versionManagement.wikiNodeToken, 'UVqFwm4EIiBcoPkoz9JcOLNfnVg');
  assert.equal(config.bitable.versionManagement.fieldNames.statusHistory, '状态变动记录');
  assert.equal(config.aiPlanning.enabled, true);
  assert.equal(config.aiPlanning.codex.model, 'gpt-5.6-sol');
  assert.equal(config.aiPlanning.codex.apiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(config.aiPlanning.codex.reasoningEffort, 'high');
  assert.equal(config.aiPlanning.codex.requestTimeoutMs, 600000);
  assert.equal(config.aiPlanning.attachments.enabled, true);
  assert.equal(config.aiPlanning.attachments.maxFiles, 10);
  assert.equal(config.aiPlanning.attachments.maxFileBytes, 20 * 1024 * 1024);
  assert.equal(config.aiPlanning.attachments.maxTotalBytes, 50 * 1024 * 1024);
  assert.equal(config.aiPlanning.notifications.enabled, true);
});

test('server config normalization accepts custom work item and permission fields', () => {
  const config = normalizeConfig({
    server: { port: 4100 },
    knowledgeBase: {
      requirementsFieldNames: {
        requiresSubmissionAttachment: '是否交付附件',
        submittedAttachments: '交付附件',
      },
    },
    bitable: {
      projectPermission: {
        fieldNames: {
          developmentSuperAdmins: '研发负责人',
        },
      },
      personalSettings: {
        wikiNodeToken: 'wikcn_custom',
        defaultTime: '09:30',
        fieldNames: {
          todoNotificationTime: '提醒时间',
          developmentPlatformToken: '访问令牌',
        },
      },
      versionManagement: {
        wikiNodeToken: 'wikcn_version',
        fieldNames: {
          versionNumber: '发布版本',
        },
      },
    },
    aiPlanning: {
      enabled: true,
      codex: {
        model: 'codex-custom',
        apiBaseUrl: 'https://example.test/v1/',
        apiKey: 'not-a-real-key',
        maxConcurrentRuns: 5,
      },
      projects: [{
        projectId: 'P1',
        preludePrompt: '  Follow the project architecture.\nPrefer existing services.  ',
        roots: [{ id: 'main', path: 'D:\\Projects\\P1', profile: 'unity' }],
      }],
    },
  });

  assert.equal(config.server.port, 4100);
  assert.equal(config.webApp.publicBaseUrl, 'http://127.0.0.1:4100/');
  assert.equal(
    config.knowledgeBase.requirementsFieldNames.requiresSubmissionAttachment,
    '是否交付附件',
  );
  assert.equal(
    config.bitable.projectPermission.fieldNames.developmentSuperAdmins,
    '研发负责人',
  );
  assert.equal(config.bitable.personalSettings.wikiNodeToken, 'wikcn_custom');
  assert.equal(config.bitable.personalSettings.defaultTime, '09:30');
  assert.equal(config.bitable.personalSettings.fieldNames.todoNotificationTime, '提醒时间');
  assert.equal(config.bitable.personalSettings.fieldNames.developmentPlatformToken, '访问令牌');
  assert.equal(config.bitable.versionManagement.wikiNodeToken, 'wikcn_version');
  assert.equal(config.bitable.versionManagement.fieldNames.versionNumber, '发布版本');
  assert.equal(config.aiPlanning.enabled, true);
  assert.equal(config.aiPlanning.codex.model, 'codex-custom');
  assert.equal(config.aiPlanning.codex.apiBaseUrl, 'https://example.test/v1');
  assert.equal(config.aiPlanning.codex.maxConcurrentRuns, 5);
  assert.equal(
    config.aiPlanning.projects[0].preludePrompt,
    'Follow the project architecture.\nPrefer existing services.',
  );
  assert.equal(config.aiPlanning.projects[0].roots[0].profile, 'unity');
});

test('runtime config and client error logs honor managed deployment paths', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-managed-runtime-'));
  try {
    const configPath = path.join(tempDir, 'persistent-config.json');
    const logPath = path.join(tempDir, 'persistent-logs', 'client-errors.log');
    fs.writeFileSync(configPath, JSON.stringify({
      server: { host: '127.0.0.1', port: 43123 },
      aiPlanning: { enabled: false },
    }));

    const runtimeOutput = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import('./server/config/runtimeConfig.js').then((m) => console.log(m.runtimeConfig.server.port))",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        IGP_CONFIG_PATH: configPath,
      },
      encoding: 'utf8',
    }).trim();
    assert.equal(runtimeOutput, '43123');

    const logOutput = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import('./server/runtime/clientErrorLog.js').then((m) => console.log(m.clientErrorLogFilePath))",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        IGP_CLIENT_ERROR_LOG_PATH: logPath,
      },
      encoding: 'utf8',
    }).trim();
    assert.equal(path.resolve(logOutput), path.resolve(logPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
