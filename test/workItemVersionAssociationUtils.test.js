import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORK_ITEM_COMPLETION_TRANSITIONS,
  buildWorkItemVersionAssociationConfirmation,
  getVersionAssociationOperationForTransition,
  getWorkItemCompletionTransition,
  normalizeWorkItemVersionAssociationDecision,
} from '../shared/workItemVersionAssociationUtils.js';

test('requirements and bugs cross configured completed-status boundaries', () => {
  assert.equal(getWorkItemCompletionTransition({
    toolId: 'requirements',
    currentStatus: '处理中',
    newStatus: '已处理',
    completedStatuses: ['已处理', '关闭'],
  }), WORK_ITEM_COMPLETION_TRANSITIONS.ENTER);
  assert.equal(getWorkItemCompletionTransition({
    toolId: 'bugs',
    currentStatus: '已修复',
    newStatus: '修复中',
    completedStatuses: ['已修复', '关闭'],
  }), WORK_ITEM_COMPLETION_TRANSITIONS.LEAVE);
  assert.equal(getWorkItemCompletionTransition({
    toolId: 'bugs',
    currentStatus: '已修复',
    newStatus: '关闭',
    completedStatuses: ['已修复', '关闭'],
  }), WORK_ITEM_COMPLETION_TRANSITIONS.NONE);
  assert.equal(getWorkItemCompletionTransition({
    toolId: 'feedback',
    currentStatus: '处理中',
    newStatus: '已完成',
    completedStatuses: ['已完成'],
  }), WORK_ITEM_COMPLETION_TRANSITIONS.NONE);
});

test('completion transitions map to association operations', () => {
  assert.equal(
    getVersionAssociationOperationForTransition(WORK_ITEM_COMPLETION_TRANSITIONS.ENTER),
    'associate',
  );
  assert.equal(
    getVersionAssociationOperationForTransition(WORK_ITEM_COMPLETION_TRANSITIONS.LEAVE),
    'unlink',
  );
  assert.equal(
    getVersionAssociationOperationForTransition(WORK_ITEM_COMPLETION_TRANSITIONS.NONE),
    '',
  );
});

test('version association decisions require explicit valid selections', () => {
  assert.deepEqual(normalizeWorkItemVersionAssociationDecision({
    operation: 'associate',
    apply: true,
    versionRecordIds: ['ver-1', 'ver-1', ' ver-2 '],
  }, { expectedOperation: 'associate' }), {
    operation: 'associate',
    apply: true,
    versionRecordIds: ['ver-1', 'ver-2'],
  });
  assert.deepEqual(normalizeWorkItemVersionAssociationDecision({
    operation: 'unlink',
    apply: false,
    versionRecordIds: [],
  }, { expectedOperation: 'unlink' }), {
    operation: 'unlink',
    apply: false,
    versionRecordIds: [],
  });
  assert.throws(() => normalizeWorkItemVersionAssociationDecision({
    operation: 'unlink',
    apply: true,
    versionRecordIds: [],
  }), /至少一个版本/);
  assert.throws(() => normalizeWorkItemVersionAssociationDecision({
    operation: 'associate',
    apply: false,
    versionRecordIds: ['ver-1'],
  }), /不能提交版本记录/);
  assert.throws(() => normalizeWorkItemVersionAssociationDecision({
    operation: 'unlink',
    apply: false,
    versionRecordIds: [],
  }, { expectedOperation: 'associate' }), /不匹配/);
});

test('confirmation details expose only safe version snapshots', () => {
  assert.deepEqual(buildWorkItemVersionAssociationConfirmation({
    operation: 'associate',
    currentStatus: '处理中',
    requestedStatus: '已处理',
    versions: [{
      recordId: 'ver-1',
      versionNumber: '1.2.0',
      platform: 'IGP',
      status: '测试开发',
      comments: ['hidden'],
    }],
  }), {
    confirmationType: 'version_association',
    confirmField: 'versionAssociationDecision',
    operation: 'associate',
    currentStatus: '处理中',
    requestedStatus: '已处理',
    versions: [{
      recordId: 'ver-1',
      versionNumber: '1.2.0',
      platform: 'IGP',
      status: '测试开发',
    }],
  });
});
