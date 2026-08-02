import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestTaskService } from '../server/services/testTaskService.js';

const FIELD_NAMES = {
  taskId: '任务ID',
  title: '任务名称',
  content: '任务内容',
  createdAt: '创建时间',
  creator: '创建人',
  testers: '测试人员',
  status: '处理状态',
  statusChangeLog: '处理状态变动记录',
  comments: '留言',
  results: '测试结果记录',
  attachments: '附件',
  relatedFeedback: '关联反馈',
};

test('test task service enforces the administrator state machine and result revisions', async () => {
  const fixture = createFixture();
  const createResult = await fixture.service.create({
    ...fixture.request,
    title: '登录测试',
    items: [{ id: 'ABC234', content: '验证登录成功' }],
    clientMutationId: 'create-1',
  });
  assert.equal(createResult.task.status, '待测试');
  assert.equal(fixture.notifications[0].eventType, 'created');

  await assert.rejects(
    fixture.service.start({
      ...fixture.request,
      access: { ...fixture.request.access, isTestAdmin: false },
      recordId: createResult.task.recordId,
      testers: [{ openId: 'ou_tester', name: '测试员' }],
      clientMutationId: 'start-no-admin',
    }),
    /只有测试管理员/,
  );

  const started = await fixture.service.start({
    ...fixture.request,
    recordId: createResult.task.recordId,
    testers: [{ openId: 'ou_tester', name: '测试员' }],
    clientMutationId: 'start-1',
  });
  assert.equal(started.task.status, '测试中');
  assert.equal(started.task.testers[0].openId, 'ou_tester');

  await assert.rejects(
    fixture.service.saveResults({
      ...fixture.request,
      recordId: createResult.task.recordId,
      expectedRevision: 99,
      results: [{ itemId: 'ABC234', conclusion: '通过' }],
      clientMutationId: 'result-stale',
    }),
    (error) => Boolean(error.statusCode === 409 && error.publicDetails.task),
  );

  const saved = await fixture.service.saveResults({
    ...fixture.request,
    recordId: createResult.task.recordId,
    expectedRevision: started.task.results.revision,
    results: [{
      itemId: 'ABC234',
      conclusion: '登录按钮无响应',
      feedbackDraft: { title: '登录按钮异常', content: '登录按钮无响应' },
    }],
    clientMutationId: 'result-1',
  });
  assert.equal(saved.task.results.revision, started.task.results.revision + 1);
  assert.equal(saved.task.results.items[0].feedbackDraft.author.openId, 'ou_admin');
});

test('test task creation retries reuse the original record and notification', async () => {
  const fixture = createFixture();
  const payload = {
    ...fixture.request,
    title: '重复请求测试',
    items: [{ id: 'ABC234', content: '验证重复提交' }],
    clientMutationId: 'create-retry-1',
  };

  const created = await fixture.service.create(payload);
  const retried = await fixture.service.create(payload);

  assert.equal(retried.task.recordId, created.task.recordId);
  assert.equal(retried.duplicate, true);
  assert.equal(fixture.notifications.length, 1);
});

test('test task service preserves subtasks returned as Feishu rich text', async () => {
  const fixture = createFixture({ richTextJsonFields: true });
  const created = await fixture.service.create({
    ...fixture.request,
    title: '富文本读取测试',
    items: [
      { id: 'ABC234', content: '验证登录' },
      { id: 'DEF567', content: '验证退出' },
    ],
    clientMutationId: 'create-rich-text',
  });

  assert.equal(created.task.status, '待测试');
  assert.deepEqual(
    created.task.content.items.map((item) => item.content),
    ['验证登录', '验证退出'],
  );
  assert.deepEqual(
    created.task.results.items.map((item) => item.itemId),
    ['ABC234', 'DEF567'],
  );
});

test('completion persists feedback associations before changing status', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    ...fixture.request,
    title: '支付测试',
    items: [{ id: 'DEF567', content: '验证支付失败提示' }],
    clientMutationId: 'create-2',
  });
  const started = await fixture.service.start({
    ...fixture.request,
    recordId: created.task.recordId,
    testers: [{ openId: 'ou_tester', name: '测试员' }],
    clientMutationId: 'start-2',
  });
  const saved = await fixture.service.saveResults({
    ...fixture.request,
    recordId: created.task.recordId,
    expectedRevision: started.task.results.revision,
    results: [{
      itemId: 'DEF567',
      conclusion: '提示内容不正确',
      feedbackDraft: { title: '支付提示错误', content: '提示内容不正确' },
    }],
    clientMutationId: 'result-2',
  });

  fixture.failFeedback = true;
  await assert.rejects(
    fixture.service.complete({
      ...fixture.request,
      recordId: created.task.recordId,
      expectedRevision: saved.task.results.revision,
      clientMutationId: 'complete-fail',
    }),
    (error) => error.statusCode === 502 && error.publicDetails.feedbackFailures.length === 1,
  );
  let current = await fixture.service.read({
    ...fixture.request,
    recordId: created.task.recordId,
  });
  assert.equal(current.status, '测试中');

  fixture.failFeedback = false;
  const completed = await fixture.service.complete({
    ...fixture.request,
    recordId: created.task.recordId,
    expectedRevision: current.results.revision,
    clientMutationId: 'complete-2',
  });
  assert.equal(completed.task.status, '已完成');
  assert.equal(completed.task.relatedFeedback.items.length, 1);
  assert.equal(completed.task.results.items[0].feedbackDraft.feedbackRecordId, 'feedback-record-1');
});

test('completion retry submits only feedback drafts that are still unfinished', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    ...fixture.request,
    title: '多项反馈测试',
    items: [
      { id: 'GHJ789', content: '验证第一项' },
      { id: 'KLM234', content: '验证第二项' },
    ],
    clientMutationId: 'create-partial',
  });
  const started = await fixture.service.start({
    ...fixture.request,
    recordId: created.task.recordId,
    testers: [{ openId: 'ou_tester', name: '测试员' }],
    clientMutationId: 'start-partial',
  });
  const saved = await fixture.service.saveResults({
    ...fixture.request,
    recordId: created.task.recordId,
    expectedRevision: started.task.results.revision,
    results: [
      {
        itemId: 'GHJ789',
        conclusion: '第一项失败',
        feedbackDraft: { title: '第一项反馈', content: '第一项失败' },
      },
      {
        itemId: 'KLM234',
        conclusion: '第二项失败',
        feedbackDraft: { title: '第二项反馈', content: '第二项失败' },
      },
    ],
    clientMutationId: 'results-partial',
  });

  fixture.failedFeedbackItemIds.add('KLM234');
  await assert.rejects(
    fixture.service.complete({
      ...fixture.request,
      recordId: created.task.recordId,
      expectedRevision: saved.task.results.revision,
      clientMutationId: 'complete-partial-fail',
    }),
    (error) => error.statusCode === 502 && error.publicDetails.feedbackFailures.length === 1,
  );

  let current = await fixture.service.read({
    ...fixture.request,
    recordId: created.task.recordId,
  });
  assert.equal(current.status, '测试中');
  assert.equal(current.relatedFeedback.items.length, 1);
  assert.deepEqual(fixture.feedbackCalls, ['GHJ789', 'KLM234']);

  fixture.failedFeedbackItemIds.clear();
  const completed = await fixture.service.complete({
    ...fixture.request,
    recordId: created.task.recordId,
    expectedRevision: current.results.revision,
    clientMutationId: 'complete-partial-retry',
  });

  assert.equal(completed.task.status, '已完成');
  assert.equal(completed.task.relatedFeedback.items.length, 2);
  assert.deepEqual(fixture.feedbackCalls, ['GHJ789', 'KLM234', 'KLM234']);
});

function createFixture({ richTextJsonFields = false } = {}) {
  const records = [];
  let sequence = 0;
  let feedbackSuccessSequence = 0;
  const notifications = [];
  const fixture = {
    failFeedback: false,
    failedFeedbackItemIds: new Set(),
    feedbackCalls: [],
    notifications,
  };
  const context = {
    appToken: 'app',
    tableId: 'table',
    viewId: '',
    fieldNames: {},
    fields: [],
    status: 'exists',
  };
  const bitable = {
    async fetchRecords() {
      return structuredClone(records);
    },
    async fetchRecord(_token, _appToken, _tableId, recordId) {
      return structuredClone(records.find((record) => record.record_id === recordId) || null);
    },
    async createRecord(_token, _appToken, _tableId, fields) {
      const storedFields = structuredClone(fields);
      if (richTextJsonFields) {
        for (const fieldName of [FIELD_NAMES.content, FIELD_NAMES.results]) {
          storedFields[fieldName] = [{ type: 'text', text: storedFields[fieldName] }];
        }
      }
      const record = { record_id: `record-${++sequence}`, fields: storedFields };
      records.push(record);
      return structuredClone(record);
    },
    async updateRecord(_token, _appToken, _tableId, recordId, fields) {
      const record = records.find((item) => item.record_id === recordId);
      Object.assign(record.fields, structuredClone(fields));
      return structuredClone(record);
    },
    async deleteRecord(_token, _appToken, _tableId, recordId) {
      records.splice(records.findIndex((item) => item.record_id === recordId), 1);
    },
  };
  fixture.service = createTestTaskService({
    config: { idPrefix: 'T-', idDigits: 4, fieldNames: FIELD_NAMES },
    resolveContext: async () => context,
    bitable,
    queue: { run: async (_key, action) => action() },
    notify: async (eventType, recipients) => {
      notifications.push({ eventType, recipients });
      return [];
    },
    publish() {},
    createFeedback: async ({ resultItem }) => {
      fixture.feedbackCalls.push(resultItem.itemId);
      if (fixture.failFeedback || fixture.failedFeedbackItemIds.has(resultItem.itemId)) {
        throw new Error('反馈表写入失败');
      }
      feedbackSuccessSequence += 1;
      return {
        recordId: `feedback-record-${feedbackSuccessSequence}`,
        itemId: `F-${String(feedbackSuccessSequence).padStart(4, '0')}`,
        title: '反馈',
      };
    },
    now: (() => {
      let value = Date.parse('2026-08-02T00:00:00.000Z');
      return () => value += 1000;
    })(),
    randomId: () => 'fixed',
  });
  fixture.request = {
    token: 'token',
    project: { projectId: 'P-1', projectName: '项目一' },
    user: { openId: 'ou_admin', name: '测试管理员' },
    access: {
      isSuperAdmin: false,
      isTestAdmin: true,
      testAdministrators: [{ openId: 'ou_admin', name: '测试管理员' }],
      mentionableUsersByTool: {
        testTasks: [
          { openId: 'ou_tester', name: '测试员' },
          { openId: 'ou_admin', name: '测试管理员' },
        ],
      },
    },
  };
  return fixture;
}
