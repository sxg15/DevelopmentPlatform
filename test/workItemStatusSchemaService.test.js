import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORK_ITEM_ACCEPTANCE_OPTION_COLOR_ID,
  buildAcceptanceStatusFieldUpdate,
  createWorkItemStatusSchemaService,
} from '../server/services/workItemStatusSchemaService.js';

const REQUIREMENT_CONFIG = {
  toolId: 'requirements',
  itemLabel: '需求',
  parentName: '需求列表',
  notLinkedText: '需求列表没有关联多维表格',
  noTableText: '需求列表没有可读取的数据表',
  fieldNames: {
    status: '处理状态',
  },
};

const BUG_CONFIG = {
  toolId: 'bugs',
  itemLabel: 'Bug',
  parentName: 'Bug列表',
  notLinkedText: 'Bug列表没有关联多维表格',
  noTableText: 'Bug列表没有可读取的数据表',
  fieldNames: {
    status: '处理状态',
  },
};

test('status field update preserves existing options and inserts acceptance after processing', () => {
  const update = buildAcceptanceStatusFieldUpdate([
    createStatusField([
      { id: 'opt-waiting', name: '待处理', color: 1 },
      { id: 'opt-processing', name: '处理中', color: 7 },
      { id: 'opt-complete', name: '已完成', color: 4 },
    ]),
  ], REQUIREMENT_CONFIG);

  assert.equal(update.fieldId, 'fld-status');
  assert.deepEqual(
    update.body.property.options.map((option) => option.name),
    ['待处理', '处理中', '待验收', '已完成'],
  );
  assert.deepEqual(update.body.property.options[1], {
    id: 'opt-processing',
    name: '处理中',
    color: 7,
  });
  assert.deepEqual(update.body.property.options[2], {
    name: '待验收',
    color: WORK_ITEM_ACCEPTANCE_OPTION_COLOR_ID,
  });
});

test('status field update is idempotent and validates the field type', () => {
  assert.equal(
    buildAcceptanceStatusFieldUpdate([
      createStatusField([{ name: '处理中' }, { name: '待验收' }]),
    ], REQUIREMENT_CONFIG),
    null,
  );

  assert.throws(
    () => buildAcceptanceStatusFieldUpdate([], REQUIREMENT_CONFIG),
    /缺少“处理状态”字段/,
  );
  assert.throws(
    () => buildAcceptanceStatusFieldUpdate([{
      field_id: 'fld-status',
      field_name: '处理状态',
      type: 1,
      property: {},
    }], REQUIREMENT_CONFIG),
    /必须是单选类型/,
  );
});

test('concurrent status ensures update one table only once', async () => {
  let remoteFields = [createStatusField([{ name: '待处理' }, { name: '处理中' }])];
  let updateCount = 0;
  const service = createWorkItemStatusSchemaService({
    fetchFields: async () => structuredClone(remoteFields),
    fetchCachedFields: async () => structuredClone(remoteFields),
    updateField: async (_token, _appToken, _tableId, _fieldId, body) => {
      updateCount += 1;
      remoteFields = [createStatusField(body.property.options)];
    },
    invalidateFields() {},
  });

  const results = await Promise.all([
    service.ensureStatusOptions('token', { appToken: 'app-1', tableId: 'tbl-1' }, REQUIREMENT_CONFIG),
    service.ensureStatusOptions('token', { appToken: 'app-1', tableId: 'tbl-1' }, REQUIREMENT_CONFIG),
  ]);

  assert.equal(updateCount, 1);
  assert.equal(results.filter((result) => result.updated).length, 1);
  assert.equal(remoteFields[0].property.options.some((option) => option.name === '待验收'), true);
});

test('migration updates templates and project tables while continuing after one failure', async () => {
  const parents = {
    需求列表: { nodeToken: 'parent-requirements' },
    Bug列表: { nodeToken: 'parent-bugs' },
  };
  const children = {
    'parent-requirements': [
      { title: '模板', objToken: 'req-template', objType: 'bitable' },
      { title: 'P-1', objToken: 'req-project', objType: 'bitable' },
      { title: '说明', objToken: 'doc', objType: 'docx' },
    ],
    'parent-bugs': [
      { title: '模板', objToken: 'bug-template', objType: 'bitable' },
      { title: 'P-1', objToken: 'bug-project', objType: 'bitable' },
      { title: 'P-failed', objToken: 'bug-failed', objType: 'bitable' },
    ],
  };
  const fieldsByApp = new Map([
    ['req-template', [createStatusField([{ name: '待处理' }, { name: '处理中' }])]],
    ['req-project', [createStatusField([{ name: '待处理' }, { name: '处理中' }])]],
    ['bug-template', [createStatusField([{ name: '未处理' }, { name: '修复中' }])]],
    ['bug-project', [createStatusField([{ name: '未处理' }, { name: '修复中' }])]],
  ]);
  const service = createWorkItemStatusSchemaService({
    findParentNode: async (_token, title) => parents[title] || null,
    fetchChildNodes: async (_token, parentToken) => children[parentToken] || [],
    isBitableNode: (node) => node.objType === 'bitable',
    resolveTableContext: async (_token, node) => {
      if (node.objToken === 'bug-failed') {
        throw new Error('无法读取数据表');
      }
      return { appToken: node.objToken, tableId: 'tbl-main' };
    },
    fetchFields: async (_token, appToken) => structuredClone(fieldsByApp.get(appToken)),
    fetchCachedFields: async (_token, appToken) => structuredClone(fieldsByApp.get(appToken)),
    updateField: async (_token, appToken, _tableId, _fieldId, body) => {
      fieldsByApp.set(appToken, [createStatusField(body.property.options)]);
    },
    invalidateFields() {},
  });

  const summary = await service.migrateStatusOptions('token', [REQUIREMENT_CONFIG, BUG_CONFIG]);

  assert.deepEqual({
    scanned: summary.scanned,
    updated: summary.updated,
    unchanged: summary.unchanged,
    failed: summary.failed,
  }, {
    scanned: 5,
    updated: 4,
    unchanged: 0,
    failed: 1,
  });
  assert.equal(summary.failures[0].nodeTitle, 'P-failed');
  for (const appToken of ['req-template', 'req-project', 'bug-template', 'bug-project']) {
    assert.equal(
      fieldsByApp.get(appToken)[0].property.options.some((option) => option.name === '待验收'),
      true,
    );
  }
});

function createStatusField(options) {
  return {
    field_id: 'fld-status',
    field_name: '处理状态',
    type: 3,
    ui_type: 'SingleSelect',
    property: {
      options: structuredClone(options),
    },
  };
}
