import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from '../server/config/normalizeConfig.js';
import { DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD } from '../shared/workItemAssignmentUtils.js';

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
  assert.equal(config.bitable.versionManagement.wikiNodeToken, 'UVqFwm4EIiBcoPkoz9JcOLNfnVg');
  assert.equal(config.bitable.versionManagement.fieldNames.statusHistory, '状态变动记录');
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
        },
      },
      versionManagement: {
        wikiNodeToken: 'wikcn_version',
        fieldNames: {
          versionNumber: '发布版本',
        },
      },
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
  assert.equal(config.bitable.versionManagement.wikiNodeToken, 'wikcn_version');
  assert.equal(config.bitable.versionManagement.fieldNames.versionNumber, '发布版本');
});
