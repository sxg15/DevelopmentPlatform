import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkItemRelationSchemaService } from '../server/services/workItemRelationSchemaService.js';

const REQUIREMENT_CONFIG = {
  toolId: 'requirements',
  itemLabel: '需求',
  parentName: '需求列表',
  notLinkedText: '需求列表没有关联多维表格',
  noTableText: '需求列表没有可读取的数据表',
  fieldNames: {
    relatedFeedback: '关联反馈',
    status: '处理状态',
  },
};

const FEEDBACK_CONFIG = {
  toolId: 'feedback',
  itemLabel: '反馈',
  parentName: '反馈列表',
  notLinkedText: '反馈列表没有关联多维表格',
  noTableText: '反馈列表没有可读取的数据表',
  fieldNames: {
    relatedItem: '关联项',
    status: '处理状态',
  },
};

test('relation migration adds fields and migrates unfinished feedback statuses idempotently', async () => {
  const parents = {
    需求列表: { nodeToken: 'parent-requirements' },
    反馈列表: { nodeToken: 'parent-feedback' },
  };
  const children = {
    'parent-requirements': [
      { title: '模板', objToken: 'req-template', objType: 'bitable' },
      { title: 'P-1', objToken: 'req-project', objType: 'bitable' },
    ],
    'parent-feedback': [
      { title: '模板', objToken: 'feedback-template', objType: 'bitable' },
      { title: 'P-1', objToken: 'feedback-project', objType: 'bitable' },
    ],
  };
  const fieldsByApp = new Map([
    ['req-template', []],
    ['req-project', []],
    ['feedback-template', []],
    ['feedback-project', []],
  ]);
  const recordsByApp = new Map([
    ['feedback-template', []],
    ['feedback-project', [
      { record_id: 'rec-waiting', fields: { 处理状态: '待处理' } },
      { record_id: 'rec-processing', fields: { 处理状态: '处理中' } },
      { record_id: 'rec-complete', fields: { 处理状态: '已完成' } },
    ]],
  ]);
  const service = createWorkItemRelationSchemaService({
    findParentNode: async (_token, title) => parents[title] || null,
    fetchChildNodes: async (_token, parentToken) => children[parentToken] || [],
    isBitableNode: (node) => node.objType === 'bitable',
    resolveTableContext: async (_token, node) => ({
      appToken: node.objToken,
      tableId: 'tbl-main',
    }),
    fetchFields: async (_token, appToken) => structuredClone(fieldsByApp.get(appToken)),
    ensureTextField: async (_token, appToken, _tableId, fieldName) => {
      fieldsByApp.get(appToken).push({
        field_id: `${appToken}-${fieldName}`,
        field_name: fieldName,
        type: 1,
        ui_type: 'Text',
      });
    },
    invalidateFields() {},
    fetchRecords: async (_token, context) => structuredClone(recordsByApp.get(context.appToken) || []),
    updateRecord: async (_token, appToken, _tableId, recordId, updates) => {
      const record = recordsByApp.get(appToken).find((item) => item.record_id === recordId);
      Object.assign(record.fields, updates);
    },
  });

  const first = await service.migrateSchemas('token', [
    REQUIREMENT_CONFIG,
    FEEDBACK_CONFIG,
  ]);
  const second = await service.migrateSchemas('token', [
    REQUIREMENT_CONFIG,
    FEEDBACK_CONFIG,
  ]);

  assert.equal(first.scanned, 4);
  assert.equal(first.updated, 4);
  assert.equal(first.migratedRecords, 2);
  assert.equal(second.updated, 0);
  assert.equal(second.migratedRecords, 0);
  assert.equal(fieldsByApp.get('req-project')[0].field_name, '关联反馈');
  assert.equal(fieldsByApp.get('feedback-project')[0].field_name, '关联项');
  assert.deepEqual(
    recordsByApp.get('feedback-project').map((record) => record.fields.处理状态),
    ['待分类', '待分类', '已完成'],
  );
});

test('relation schema refuses an existing non-text association field', async () => {
  const service = createWorkItemRelationSchemaService({
    fetchFields: async () => [{
      field_id: 'fld-related',
      field_name: '关联项',
      type: 3,
      ui_type: 'SingleSelect',
    }],
    ensureTextField: async () => {},
    invalidateFields() {},
  });

  await assert.rejects(
    service.ensureSchema(
      'token',
      { appToken: 'feedback', tableId: 'table' },
      FEEDBACK_CONFIG,
    ),
    /必须是文本类型/,
  );
});
