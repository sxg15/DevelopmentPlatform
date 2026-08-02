import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareWorkItemStatus,
  createEmptyWorkItemFilters,
  filterWorkItems,
  hasActiveAdvancedWorkItemFilters,
  getWorkItemProcessingStatuses,
  isStatusGroupDefaultCollapsed,
  shouldShowWorkItemRemainingTime,
} from '../src/ui/workItemListUtils.js';

const items = [
  {
    itemId: 'R-0001',
    title: '登录优化',
    description: '优化登录页加载时间',
    priority: 'P1',
    requirementStatus: '待处理',
    assignees: [{ openId: 'u-alice', name: 'Alice' }],
    proposers: [{ openId: 'u-bob', name: 'Bob' }],
    expectedDays: 3,
    remainingDays: 2,
    proposedAt: new Date(2026, 6, 1).getTime(),
  },
  {
    itemId: 'B-0001',
    title: '支付异常',
    description: '支付接口偶发超时',
    priority: 'P0',
    requirementStatus: '未处理',
    assignees: [{ openId: 'u-bob', name: 'Bob' }],
    proposers: [{ openId: 'u-alice', name: 'Alice' }],
    expectedDays: 1,
    remainingDays: -0.2,
    proposedAt: new Date(2026, 6, 3).getTime(),
  },
];

test('each tool uses its own default expanded statuses', () => {
  assert.equal(isStatusGroupDefaultCollapsed('requirements', '待处理'), false);
  assert.equal(isStatusGroupDefaultCollapsed('requirements', '待验收'), false);
  assert.equal(isStatusGroupDefaultCollapsed('requirements', '已拒绝'), true);
  assert.equal(isStatusGroupDefaultCollapsed('bugs', '未处理'), false);
  assert.equal(isStatusGroupDefaultCollapsed('bugs', '待验收'), false);
  assert.equal(isStatusGroupDefaultCollapsed('bugs', '已修复'), true);
  assert.equal(isStatusGroupDefaultCollapsed('feedback', '待分类'), false);
  assert.equal(isStatusGroupDefaultCollapsed('feedback', '已拒绝'), true);
});

test('remaining time is only visible for the waiting status of each tool', () => {
  assert.equal(shouldShowWorkItemRemainingTime('requirements', items[0]), true);
  assert.equal(shouldShowWorkItemRemainingTime('requirements', { ...items[0], requirementStatus: '处理中' }), false);
  assert.equal(shouldShowWorkItemRemainingTime('bugs', items[1]), true);
  assert.equal(shouldShowWorkItemRemainingTime('bugs', { ...items[1], requirementStatus: '修复中' }), false);
});

test('filtering intersects search, people, deadline and date conditions', () => {
  const filters = {
    ...createEmptyWorkItemFilters(),
    query: '支付',
    assigneeKeys: ['u-bob'],
    deadline: 'overdue',
    dateFrom: '2026-07-02',
    dateTo: '2026-07-04',
  };
  assert.deepEqual(filterWorkItems(items, filters), [items[1]]);
});

test('search text does not count as an advanced filter', () => {
  assert.equal(hasActiveAdvancedWorkItemFilters(createEmptyWorkItemFilters()), false);
  assert.equal(hasActiveAdvancedWorkItemFilters({ ...createEmptyWorkItemFilters(), query: '支付' }), false);
  assert.equal(hasActiveAdvancedWorkItemFilters({ ...createEmptyWorkItemFilters(), statuses: ['待处理'] }), true);
  assert.equal(hasActiveAdvancedWorkItemFilters({ ...createEmptyWorkItemFilters(), deadline: 'urgent' }), true);
});

test('related-item filter matches the current assignee and requested workflow state', () => {
  const pendingFilters = {
    ...createEmptyWorkItemFilters(),
    assigneeKeys: ['u-alice'],
    statuses: ['待处理'],
  };
  const urgentFilters = {
    ...pendingFilters,
    deadline: 'urgent',
  };
  const bugPendingFilters = {
    ...createEmptyWorkItemFilters(),
    assigneeKeys: ['u-bob'],
    statuses: ['未处理'],
  };
  const urgentRequirement = {
    ...items[0],
    remainingDays: 0.5,
  };

  assert.deepEqual(filterWorkItems(items, pendingFilters), [items[0]]);
  assert.deepEqual(filterWorkItems([urgentRequirement, items[1]], urgentFilters), [urgentRequirement]);
  assert.deepEqual(filterWorkItems(items, bugPendingFilters), [items[1]]);
  assert.deepEqual(filterWorkItems(items, createEmptyWorkItemFilters()), items);
});

test('status sorting follows each list workflow', () => {
  assert.deepEqual(getWorkItemProcessingStatuses('requirements'), ['处理中', '待验收']);
  assert.deepEqual(getWorkItemProcessingStatuses('bugs'), ['修复中', '待验收']);
  assert.ok(compareWorkItemStatus('requirements', '处理中', '已完成') < 0);
  assert.ok(compareWorkItemStatus('requirements', '处理中', '待验收') < 0);
  assert.ok(compareWorkItemStatus('requirements', '待验收', '已完成') < 0);
  assert.ok(compareWorkItemStatus('bugs', '修复中', '已修复') < 0);
  assert.ok(compareWorkItemStatus('bugs', '修复中', '待验收') < 0);
  assert.ok(compareWorkItemStatus('bugs', '待验收', '已修复') < 0);
  assert.ok(compareWorkItemStatus('feedback', '待分类', '已转需求') < 0);
});
