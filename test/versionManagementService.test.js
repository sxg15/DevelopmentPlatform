import assert from 'node:assert/strict';
import test from 'node:test';

import { createBitableTableDataService } from '../server/services/bitableTableDataService.js';
import { createVersionManagementService } from '../server/services/versionManagementService.js';

const FIELD_NAMES = {
  versionNumber: '版本号',
  status: '状态',
  requirements: '已处理需求',
  bugs: '已处理Bug',
  feedback: '已处理反馈',
  statusHistory: '状态变动记录',
  comments: '留言',
  previousVersion: '上个版本',
  platform: '平台',
};

test('version creation obsoletes the occupied active slot', async () => {
  const harness = createHarness([
    createRecord('ver-old', '1.0.0', 'IGP', '测试开发'),
  ]);
  const service = harness.createService();

  const result = await service.createVersion('token', { projectId: 'P1' }, createUser(), {
    versionNumber: '1.1.0',
    platform: 'IGP',
    status: '测试开发',
    associations: {},
  });

  assert.equal(harness.getRecord('ver-old').fields.状态, '过时');
  assert.equal(result.version.versionNumber, '1.1.0');
  assert.equal(result.replacedVersion.recordId, 'ver-old');
});

test('failed target creation restores the exact occupied status and history', async () => {
  const oldRecord = createRecord('ver-old', '1.0.0', 'IGP', '测试开发');
  const originalHistory = oldRecord.fields.状态变动记录;
  const harness = createHarness([oldRecord], { failCreate: true });
  const service = harness.createService();

  await assert.rejects(
    service.createVersion('token', { projectId: 'P1' }, createUser(), {
      versionNumber: '1.1.0',
      platform: 'IGP',
      status: '测试开发',
      associations: {},
    }),
    /模拟创建失败/,
  );

  assert.equal(harness.getRecord('ver-old').fields.状态, '测试开发');
  assert.equal(harness.getRecord('ver-old').fields.状态变动记录, originalHistory);
});

test('concurrent first opens copy one project table and clean empty placeholders once', async () => {
  const harness = createHarness([
    { record_id: 'placeholder-1', fields: {} },
    { record_id: 'placeholder-2', fields: { 版本号: '' } },
  ], { projectNodeExists: false });
  const service = harness.createService();

  const [left, right] = await Promise.all([
    service.ensure('token', { projectId: 'P1' }, createUser()),
    service.ensure('token', { projectId: 'P1' }, createUser()),
  ]);

  assert.equal(harness.copyCount(), 1);
  assert.equal(harness.recordCount(), 0);
  assert.equal(left.created, true);
  assert.equal(right.existed, true);
});

test('overview reads a missing version table without provisioning it', async () => {
  const harness = createHarness([], { projectNodeExists: false });
  const service = harness.createService();

  const overview = await service.readOverview('token', 'P1');

  assert.equal(overview.initialized, false);
  assert.equal(harness.copyCount(), 0);
});

test('deletion is blocked while another version references the target', async () => {
  const first = createRecord('ver-1', '1.0.0', 'IGP', '过时');
  const second = createRecord('ver-2', '1.1.0', 'IGP', '测试开发');
  second.fields.上个版本 = JSON.stringify({
    version: 1,
    item: { recordId: 'ver-1', versionNumber: '1.0.0', platform: 'IGP' },
  });
  const harness = createHarness([first, second]);
  const service = harness.createService();

  await assert.rejects(
    service.deleteVersion('token', { projectId: 'P1' }, 'ver-1'),
    /仍引用/,
  );
  assert.equal(harness.recordCount(), 2);
});

test('version reads register the resolved Bitable table for realtime cache events', async () => {
  const contexts = [];
  const harness = createHarness([
    createRecord('ver-1', '1.0.0', 'IGP', '测试开发'),
  ]);
  const service = harness.createService({
    onTableContextResolved(context) {
      contexts.push(context);
    },
  });

  await service.readOne('token', { projectId: 'P1' }, 'ver-1');

  assert.deepEqual(contexts, [{
    appToken: 'app-token',
    tableId: 'table-1',
    viewId: '',
    fieldNames: FIELD_NAMES,
    projectId: 'P1',
    toolId: 'versions',
  }]);
});

test('version comments are idempotent and never expose mutation metadata', async () => {
  const harness = createHarness([
    createRecord('ver-1', '1.0.0', 'IGP', '测试开发'),
  ]);
  const service = harness.createService();
  const payload = {
    content: '请补充发布说明',
    mentionedUsers: [{ openId: 'ou-reviewer', name: 'Reviewer' }],
    clientMutationId: 'version-comment-1',
    mutationFingerprint: 'fingerprint-1',
    notifyMentioned: true,
  };

  const first = await service.createComment(
    'token',
    { projectId: 'P1' },
    createUser(),
    'ver-1',
    payload,
  );
  const duplicate = await service.createComment(
    'token',
    { projectId: 'P1' },
    createUser(),
    'ver-1',
    payload,
  );

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.comment.id, duplicate.comment.id);
  assert.equal(harness.getStoredComments('ver-1').length, 1);
  assert.equal('clientMutationId' in first.comment, false);
  assert.equal('mutationFingerprint' in first.version.comments[0], false);
  assert.equal('notifyMentioned' in duplicate.comment, false);

  await assert.rejects(
    service.createComment(
      'token',
      { projectId: 'P1' },
      createUser(),
      'ver-1',
      { ...payload, mutationFingerprint: 'fingerprint-2' },
    ),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /不同的版本留言/);
      return true;
    },
  );
  assert.equal(harness.getStoredComments('ver-1').length, 1);
});

test('partial Bitable update responses cannot make a real version look like an empty placeholder', async () => {
  const harness = createHarness([
    createRecord('ver-1', '1.0.0', 'IGP', '测试开发'),
  ], {
    cacheEnabled: true,
    partialUpdateResponse: true,
  });
  const service = harness.createService();

  const result = await service.createComment(
    'token',
    { projectId: 'P1' },
    createUser(),
    'ver-1',
    { content: '缓存回归验证' },
  );

  assert.equal(result.version.versionNumber, '1.0.0');
  await service.ensure('token', { projectId: 'P1' }, createUser());
  assert.equal(harness.recordCount(), 1);
  assert.equal(harness.getRecord('ver-1').fields.版本号, '1.0.0');
});

function createHarness(initialRecords, {
  failCreate = false,
  projectNodeExists = true,
  cacheEnabled = false,
  partialUpdateResponse = false,
} = {}) {
  const records = initialRecords.map(clone);
  const projectNode = {
    nodeToken: 'project-node',
    objToken: 'app-token',
    objType: 'bitable',
    title: 'P1',
  };
  let hasProjectNode = projectNodeExists;
  let copies = 0;

  const bitable = {
    async fetchTables() {
      return [{ table_id: 'table-1' }];
    },
    async fetchFields() {
      return createFields();
    },
    async fetchRecords() {
      return records.map(clone);
    },
    async createRecord(_token, _appToken, _tableId, fields) {
      if (failCreate) {
        throw new Error('模拟创建失败');
      }
      const record = { record_id: `ver-${records.length + 1}`, fields: clone(fields) };
      records.push(record);
      return clone(record);
    },
    async updateRecord(_token, _appToken, _tableId, recordId, fields) {
      const record = records.find((item) => item.record_id === recordId);
      if (!record) {
        throw new Error('记录不存在');
      }
      Object.assign(record.fields, clone(fields));
      return partialUpdateResponse
        ? { record_id: recordId, fields: clone(fields) }
        : clone(record);
    },
    async deleteRecord(_token, _appToken, _tableId, recordId) {
      const index = records.findIndex((item) => item.record_id === recordId);
      if (index >= 0) {
        records.splice(index, 1);
      }
    },
  };
  const wiki = {
    async findNodeByTitle() {
      return { nodeToken: 'parent-node', title: '版本管理' };
    },
    async getChildren() {
      return hasProjectNode ? [projectNode] : [];
    },
    async createNode() {
      return { nodeToken: 'parent-node', title: '版本管理' };
    },
    async copyNode() {
      copies += 1;
      hasProjectNode = true;
      return projectNode;
    },
  };

  return {
    createService(overrides = {}) {
      const gateway = cacheEnabled
        ? createBitableTableDataService({
            config: {
              enabled: true,
              freshTtlMs: 60_000,
              staleWhileRevalidateMs: 60_000,
              maxSnapshots: 8,
            },
            bitable,
          })
        : null;
      return createVersionManagementService({
        config: {
          wikiNodeToken: 'template-node',
          parentName: '版本管理',
          fieldNames: FIELD_NAMES,
        },
        bitable: gateway
          ? {
              createRecord: gateway.createRecord,
              deleteRecord: gateway.deleteRecord,
              fetchFields: bitable.fetchFields,
              fetchRecords: gateway.readRecords,
              fetchTables: bitable.fetchTables,
              updateRecord: gateway.updateRecord,
            }
          : bitable,
        wiki,
        loadCompletedWorkItemCandidates: async () => ({
          candidates: { requirements: [], bugs: [], feedback: [] },
          warnings: [],
        }),
        now: () => new Date('2026-07-18T00:00:00.000Z'),
        randomId: (() => {
          let sequence = 0;
          return () => `id-${sequence += 1}`;
        })(),
        ...overrides,
      });
    },
    getRecord(recordId) {
      return records.find((item) => item.record_id === recordId);
    },
    getStoredComments(recordId) {
      const value = records.find((item) => item.record_id === recordId)?.fields?.留言;
      return JSON.parse(value || '{"items":[]}').items || [];
    },
    recordCount() {
      return records.length;
    },
    copyCount() {
      return copies;
    },
  };
}

function createRecord(recordId, versionNumber, platform, status) {
  return {
    record_id: recordId,
    fields: {
      版本号: versionNumber,
      状态: status,
      平台: platform,
      已处理需求: JSON.stringify({ version: 1, items: [] }),
      已处理Bug: JSON.stringify({ version: 1, items: [] }),
      已处理反馈: JSON.stringify({ version: 1, items: [] }),
      上个版本: '',
      状态变动记录: JSON.stringify({
        version: 1,
        items: [{
          id: `${recordId}-history`,
          oldStatus: '',
          newStatus: status,
          changedAt: '2026-07-01T00:00:00.000Z',
          operatorOpenId: 'ou-admin',
          operatorName: '管理员',
          reason: '创建版本',
          automatic: false,
        }],
      }),
      留言: JSON.stringify({ version: 1, items: [] }),
    },
  };
}

function createFields() {
  return Object.values(FIELD_NAMES).map((fieldName) => ({
    field_name: fieldName,
    property: fieldName === '状态'
      ? { options: ['测试开发', '测试发布', '正式发布', '过时'].map((name) => ({ name })) }
      : fieldName === '平台'
        ? { options: ['IGP', 'Steam', '中国版', '无'].map((name) => ({ name })) }
        : {},
  }));
}

function createUser() {
  return { openId: 'ou-admin', name: '管理员' };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
