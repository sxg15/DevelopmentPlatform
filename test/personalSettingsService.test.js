import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPersonalSettingsFields,
  generateDevelopmentPlatformToken,
  isDevelopmentPlatformToken,
  normalizePersonalSettingsRecord,
  resolveDevelopmentPlatformUserFromRecords,
  validatePersonalSettingsSchema,
} from '../server/services/personalSettingsService.js';

const FIELD_NAMES = {
  user: '用户',
  receiveTodoNotifications: '接收待办事项通知',
  todoNotificationTime: '待办事项通知时间',
  developmentPlatformToken: '开发平台令牌',
};

function createContext() {
  return {
    config: {
      enabledValue: '允许',
      defaultTime: '11:00',
      timeZone: 'Asia/Shanghai',
      fieldNames: FIELD_NAMES,
    },
    fields: [
      { field_name: FIELD_NAMES.user, type: 11 },
      {
        field_name: FIELD_NAMES.receiveTodoNotifications,
        type: 3,
        property: { options: [{ name: '允许' }] },
      },
      { field_name: FIELD_NAMES.todoNotificationTime, type: 1 },
      { field_name: FIELD_NAMES.developmentPlatformToken, type: 1 },
    ],
  };
}

test('development platform tokens use a stable prefix and 256 bits of random input', () => {
  const token = generateDevelopmentPlatformToken(() => Buffer.alloc(32, 0xab));
  assert.match(token, /^igp_[A-Za-z0-9_-]{43}$/);
  assert.equal(isDevelopmentPlatformToken(token), true);
  assert.equal(isDevelopmentPlatformToken('igp_short'), false);
  assert.notEqual(generateDevelopmentPlatformToken(), generateDevelopmentPlatformToken());
});

test('development platform tokens resolve exactly one stable user without stale-token caching', () => {
  const oldToken = `igp_${'A'.repeat(43)}`;
  const newToken = `igp_${'B'.repeat(43)}`;
  const records = [{
    record_id: 'settings-1',
    fields: {
      [FIELD_NAMES.user]: [{
        id: 'ou_owner',
        open_id: 'ou_owner',
        user_id: 'user_owner',
        union_id: 'union_owner',
        email: 'owner@example.com',
        name: 'Owner',
      }],
      [FIELD_NAMES.developmentPlatformToken]: oldToken,
    },
  }];

  assert.deepEqual(
    resolveDevelopmentPlatformUserFromRecords(records, FIELD_NAMES, oldToken),
    {
      id: 'ou_owner',
      openId: 'ou_owner',
      userId: 'user_owner',
      unionId: 'union_owner',
      email: 'owner@example.com',
      name: 'Owner',
    },
  );
  assert.equal(
    resolveDevelopmentPlatformUserFromRecords(records, FIELD_NAMES, ''),
    null,
  );
  assert.equal(
    resolveDevelopmentPlatformUserFromRecords(records, FIELD_NAMES, 'igp_invalid'),
    null,
  );

  const regeneratedRecords = [{
    ...records[0],
    fields: {
      ...records[0].fields,
      [FIELD_NAMES.developmentPlatformToken]: newToken,
    },
  }];
  assert.equal(
    resolveDevelopmentPlatformUserFromRecords(regeneratedRecords, FIELD_NAMES, oldToken),
    null,
  );
  assert.equal(
    resolveDevelopmentPlatformUserFromRecords(regeneratedRecords, FIELD_NAMES, newToken)?.openId,
    'ou_owner',
  );
});

test('duplicate tokens or records without one stable user are rejected', () => {
  const token = `igp_${'C'.repeat(43)}`;
  const duplicateRecords = ['ou_first', 'ou_second'].map((openId, index) => ({
    record_id: `settings-${index}`,
    fields: {
      [FIELD_NAMES.user]: [{ id: openId, open_id: openId, name: openId }],
      [FIELD_NAMES.developmentPlatformToken]: token,
    },
  }));
  assert.equal(
    resolveDevelopmentPlatformUserFromRecords(duplicateRecords, FIELD_NAMES, token),
    null,
  );
  assert.equal(
    resolveDevelopmentPlatformUserFromRecords([{
      record_id: 'settings-name-only',
      fields: {
        [FIELD_NAMES.user]: [{ name: 'Only a name' }],
        [FIELD_NAMES.developmentPlatformToken]: token,
      },
    }], FIELD_NAMES, token),
    null,
  );
});

test('personal settings normalize the stored development platform token', () => {
  const context = createContext();
  assert.deepEqual(
    normalizePersonalSettingsRecord({
      fields: {
        [FIELD_NAMES.receiveTodoNotifications]: '允许',
        [FIELD_NAMES.todoNotificationTime]: '09:30',
        [FIELD_NAMES.developmentPlatformToken]: 'igp_test_token',
      },
    }, context.config),
    {
      receiveTodoNotifications: true,
      todoNotificationTime: '09:30',
      developmentPlatformToken: 'igp_test_token',
    },
  );
});

test('notification saves omit the token while new token records include it explicitly', () => {
  const context = createContext();
  const settings = {
    receiveTodoNotifications: false,
    todoNotificationTime: '11:00',
    developmentPlatformToken: 'igp_test_token',
  };
  const notificationFields = buildPersonalSettingsFields(
    context,
    { openId: 'ou_user', name: '测试用户' },
    settings,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      notificationFields,
      FIELD_NAMES.developmentPlatformToken,
    ),
    false,
  );

  const createdFields = buildPersonalSettingsFields(
    context,
    { openId: 'ou_user', name: '测试用户' },
    settings,
    {
      includeUser: true,
      includeDevelopmentPlatformToken: true,
    },
  );
  assert.equal(createdFields[FIELD_NAMES.developmentPlatformToken], 'igp_test_token');
});

test('personal settings schema requires a text development platform token field', () => {
  const context = createContext();
  assert.doesNotThrow(() => validatePersonalSettingsSchema(context));

  const invalidContext = createContext();
  invalidContext.fields = invalidContext.fields.map((field) => (
    field.field_name === FIELD_NAMES.developmentPlatformToken
      ? { ...field, type: 3 }
      : field
  ));
  assert.throws(
    () => validatePersonalSettingsSchema(invalidContext),
    /开发平台令牌.*文本字段/,
  );
});
