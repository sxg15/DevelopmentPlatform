import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProjectOverviewDisplayData } from '../src/ui/projectOverviewDisplayUtils.js';

test('overview display data tolerates malformed cached values', () => {
  const normalized = normalizeProjectOverviewDisplayData({
    generatedAt: 'invalid',
    historyNotice: { text: 'invalid React child' },
    summary: { active: '3', overdue: -2 },
    statusByTool: [
      {
        toolId: 'requirements',
        label: { text: 'invalid React child' },
        categories: 'invalid',
      },
      null,
    ],
    priorityDistribution: [{ priority: 'P1', count: '2' }],
    trend: [{ date: { value: 'invalid' }, created: '1', completed: null }],
    assigneeLoad: [{ name: ['invalid'], waiting: 2 }],
    risks: [{
      toolId: 'bugs',
      title: { text: 'invalid React child' },
      assignees: [{ name: { text: 'invalid' } }],
      riskKinds: 'overdue',
      riskLabels: [{ text: 'invalid' }],
    }],
    recentActivity: [{
      id: { value: 'invalid' },
      operatorName: { text: 'invalid' },
      text: ['invalid'],
      occurredAt: null,
    }],
    unavailableTools: 'invalid',
  }, 5000);

  assert.equal(normalized.generatedAt, 5000);
  assert.equal(normalized.historyNotice, '');
  assert.deepEqual(normalized.summary, {
    active: 3,
    waiting: 0,
    processing: 0,
    overdue: 0,
    unassigned: 0,
    completedThisWeek: 0,
  });
  assert.deepEqual(normalized.statusByTool, [{
    toolId: 'requirements',
    label: '未命名类型',
    categories: [],
  }]);
  assert.deepEqual(normalized.priorityDistribution, [{ priority: 'P1', count: 2 }]);
  assert.deepEqual(normalized.trend, [{ date: '', created: 1, completed: 0 }]);
  assert.deepEqual(normalized.assigneeLoad, [{
    name: '未命名人员',
    waiting: 2,
    processing: 0,
    overdue: 0,
  }]);
  assert.deepEqual(normalized.risks[0].riskKinds, []);
  assert.deepEqual(normalized.risks[0].riskLabels, []);
  assert.equal(normalized.risks[0].title, '未命名工作项');
  assert.equal(normalized.recentActivity[0].occurredAt, 0);
  assert.deepEqual(normalized.unavailableTools, []);
});
