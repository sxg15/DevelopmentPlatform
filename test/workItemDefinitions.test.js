import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEEDBACK_STATUSES,
  PROJECT_TOOL_DEFINITIONS,
  PROJECT_TOOL_GROUP_DEFINITIONS,
  REQUIREMENT_PRIORITIES,
  WORK_ITEM_ACCEPTANCE_STATUS,
  WORK_ITEM_TOOL_DEFINITIONS,
  getWorkItemAcceptanceStatus,
  getWorkItemProcessingStatuses,
  getWorkItemWaitingStatus,
  getWorkItemToolDefinition,
} from '../shared/workItemDefinitions.js';
import {
  getProjectToolIcon,
  hasProjectToolIcon,
} from '../src/ui/workspace/projectToolIcons.js';

test('project tools keep overview first and use unique identifiers', () => {
  assert.equal(PROJECT_TOOL_DEFINITIONS[0].id, 'overview');
  assert.equal(PROJECT_TOOL_DEFINITIONS[1].id, 'versions');
  assert.equal(PROJECT_TOOL_DEFINITIONS[2].id, 'aiPlans');
  assert.equal(
    new Set(PROJECT_TOOL_DEFINITIONS.map((tool) => tool.id)).size,
    PROJECT_TOOL_DEFINITIONS.length,
  );
  for (const tool of PROJECT_TOOL_DEFINITIONS) {
    assert.ok(tool.iconKey);
    assert.equal(hasProjectToolIcon(tool.iconKey), true);
  }
  for (const toolId of ['builds', 'review']) {
    const tool = PROJECT_TOOL_DEFINITIONS.find((item) => item.id === toolId);
    assert.equal(tool.disabled, true);
    assert.equal(tool.statusText, '开发中');
  }
  assert.ok(getProjectToolIcon('unknown-icon'));
});

test('project tools use the canonical navigation groups', () => {
  assert.deepEqual(
    PROJECT_TOOL_GROUP_DEFINITIONS.map((group) => [group.id, group.label]),
    [
      ['projectManagement', '项目管理'],
      ['aiWorkflow', 'AI工作流'],
      ['workItems', '工作事项'],
      ['qualityDelivery', '质量交付'],
    ],
  );
  assert.equal(PROJECT_TOOL_DEFINITIONS.find((tool) => tool.id === 'overview').groupId, undefined);
  assert.deepEqual(
    Object.fromEntries(PROJECT_TOOL_DEFINITIONS.map((tool) => [tool.id, tool.groupId || ''])),
    {
      overview: '',
      versions: 'projectManagement',
      aiPlans: 'aiWorkflow',
      requirements: 'workItems',
      bugs: 'workItems',
      testTasks: 'qualityDelivery',
      feedback: 'workItems',
      builds: 'qualityDelivery',
      review: 'qualityDelivery',
    },
  );
});

test('work item definitions provide stable route and item metadata', () => {
  assert.equal(WORK_ITEM_TOOL_DEFINITIONS.requirements.routeSegment, 'requirements');
  assert.equal(WORK_ITEM_TOOL_DEFINITIONS.bugs.itemIdKey, 'bugId');
  assert.equal(WORK_ITEM_TOOL_DEFINITIONS.feedback.supportsPriority, false);
  assert.equal(WORK_ITEM_TOOL_DEFINITIONS.testTasks.routeSegment, 'test-tasks');
  assert.equal(getWorkItemToolDefinition('unknown').toolId, 'requirements');
  assert.deepEqual(REQUIREMENT_PRIORITIES, ['P0', 'P1', 'P2', 'P3', 'P4']);
  assert.equal(WORK_ITEM_ACCEPTANCE_STATUS, '待验收');
  assert.deepEqual(getWorkItemProcessingStatuses('requirements'), ['处理中', '待验收']);
  assert.deepEqual(getWorkItemProcessingStatuses('bugs'), ['修复中', '待验收']);
  assert.deepEqual(getWorkItemProcessingStatuses('feedback'), []);
  assert.deepEqual(getWorkItemProcessingStatuses('testTasks'), ['测试中']);
  assert.equal(getWorkItemAcceptanceStatus('feedback'), '');
  assert.equal(getWorkItemWaitingStatus('feedback'), FEEDBACK_STATUSES.waiting);
});
