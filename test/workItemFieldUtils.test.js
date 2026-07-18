import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDisplayFields,
  isAttachmentField,
  normalizeAttachmentItems,
  normalizeEditableFeedbackContactInfo,
  parseFeedbackContactInfoForClient,
} from '../src/ui/work-items/workItemFieldUtils.js';

test('display fields retain schema order and append unknown visible values', () => {
  const fields = [
    { fieldName: '处理状态', index: 2 },
    { fieldName: '需求名称', index: 1 },
  ];
  const rawFields = {
    需求名称: '导出报表',
    处理状态: '处理中',
    内部字段: '隐藏',
    补充说明: '需要按项目筛选',
  };

  assert.deepEqual(
    buildDisplayFields(fields, rawFields, ['内部字段']).map((field) => field.fieldName),
    ['需求名称', '处理状态', '补充说明'],
  );
});

test('attachment values use the work item attachment proxy when only a token exists', () => {
  const [attachment] = normalizeAttachmentItems(
    [{ file_token: 'file-token', name: 'design.png', size: 2048 }],
    'project-1',
    { routeSegment: 'bugs' },
  );

  assert.equal(attachment.fileToken, 'file-token');
  assert.equal(attachment.name, 'design.png');
  assert.equal(
    attachment.url,
    '/api/projects/project-1/bugs/attachments/file-token?name=design.png',
  );
});

test('detail field checks use the default requirement tool definition safely', () => {
  assert.equal(isAttachmentField({ fieldName: '标题', type: 1 }, []), false);

  const [attachment] = normalizeAttachmentItems(
    [{ file_token: 'default-token', name: 'default.png' }],
    'project-1',
  );
  assert.equal(
    attachment.url,
    '/api/projects/project-1/requirements/attachments/default-token?name=default.png',
  );
});

test('feedback contact info supports stored JSON and editable normalization', () => {
  const parsed = parseFeedbackContactInfoForClient(JSON.stringify({
    isFeishuUser: true,
    feishuUserId: 'ou_123',
    phone: '13800000000',
    allowDeveloperFollowUp: true,
  }));

  assert.deepEqual(parsed, {
    valid: true,
    isFeishuUser: true,
    feishuUserId: 'ou_123',
    phone: '13800000000',
    email: '',
    allowDeveloperFollowUp: true,
  });
  assert.deepEqual(normalizeEditableFeedbackContactInfo(parsed), {
    isFeishuUser: true,
    feishuUserId: 'ou_123',
    phone: '13800000000',
    email: '',
    allowDeveloperFollowUp: true,
  });
});
