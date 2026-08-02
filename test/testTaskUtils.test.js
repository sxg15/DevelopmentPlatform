import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEST_TASK_STATUSES,
  buildDefaultTestFeedbackTitle,
  buildTestTaskPermissions,
  createTestTaskContentDocument,
  createUniqueTestTaskItemId,
  getIncompleteTestTaskResultIds,
  isTestTaskActionableForUser,
  isValidTestTaskTransition,
  normalizeTestTaskContentDocument,
  normalizeTestTaskResultsDocument,
} from '../shared/testTaskUtils.js';

test('test task item IDs are short, stable, and unique within a task', () => {
  const values = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  const random = () => values.shift();
  const first = createUniqueTestTaskItemId([], random);
  const second = createUniqueTestTaskItemId([first], random);

  assert.equal(first, '222222');
  assert.equal(second.length, 6);
  assert.notEqual(first, second);
});

test('test task content and result JSON preserve immutable item IDs and revisions', () => {
  const content = createTestTaskContentDocument([
    { id: 'ABC234', content: '验证登录' },
    { id: 'DEF567', content: '验证退出' },
  ], 3);
  assert.equal(content.error, '');
  assert.equal(content.revision, 3);

  const results = normalizeTestTaskResultsDocument({
    version: 1,
    revision: 2,
    items: [{
      itemId: 'ABC234',
      conclusion: '通过',
      feedbackDraft: { title: '需要优化', content: '结论内容' },
    }],
  }, content);

  assert.equal(results.error, '');
  assert.deepEqual(results.items.map((item) => item.itemId), ['ABC234', 'DEF567']);
  assert.deepEqual(getIncompleteTestTaskResultIds(results), ['DEF567']);
});

test('test task JSON accepts Feishu rich-text field values', () => {
  const contentJson = JSON.stringify({
    version: 1,
    revision: 2,
    items: [
      { id: 'ABC234', content: '验证登录' },
      { id: 'DEF567', content: '验证退出' },
    ],
  });
  const content = normalizeTestTaskContentDocument([
    { type: 'text', text: contentJson.slice(0, 24) },
    { type: 'text', text: contentJson.slice(24) },
  ]);
  const results = normalizeTestTaskResultsDocument({
    type: 'text',
    text: JSON.stringify({
      version: 1,
      revision: 3,
      items: [
        { itemId: 'ABC234', conclusion: '通过' },
        { itemId: 'DEF567', conclusion: '通过' },
      ],
    }),
  }, content);

  assert.equal(content.error, '');
  assert.deepEqual(content.items.map((item) => item.id), ['ABC234', 'DEF567']);
  assert.equal(results.error, '');
  assert.deepEqual(results.items.map((item) => item.conclusion), ['通过', '通过']);
});

test('test task malformed documents and permissions fail closed', () => {
  assert.match(normalizeTestTaskContentDocument('{bad json').error, /JSON/);
  assert.deepEqual(buildTestTaskPermissions({
    status: TEST_TASK_STATUSES.testing,
    isTestAdmin: true,
  }), {
    canEditContent: false,
    canStart: false,
    canEditResults: true,
    canAdjustTesters: true,
    canComplete: true,
    canDelete: false,
  });
  assert.equal(isValidTestTaskTransition('待测试', '测试中'), true);
  assert.equal(isValidTestTaskTransition('待测试', '已完成'), false);
});

test('test administrators and assigned testers receive the expected pending scope', () => {
  const task = {
    status: '测试中',
    testers: [{ openId: 'ou_tester' }],
  };
  assert.equal(isTestTaskActionableForUser(task, { openId: 'ou_admin' }, {
    isTestAdmin: true,
  }), true);
  assert.equal(isTestTaskActionableForUser(task, { openId: 'ou_tester' }), true);
  assert.equal(isTestTaskActionableForUser(task, { openId: 'ou_other' }), false);
  assert.equal(buildDefaultTestFeedbackTitle('登录', '验证失败提示'), '【测试结论】登录-验证失败提示');
});
