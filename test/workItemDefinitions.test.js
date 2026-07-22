import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_TOOL_DEFINITIONS,
  REQUIREMENT_PRIORITIES,
  WORK_ITEM_TOOL_DEFINITIONS,
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
  assert.ok(getProjectToolIcon('unknown-icon'));
});

test('work item definitions provide stable route and item metadata', () => {
  assert.equal(WORK_ITEM_TOOL_DEFINITIONS.requirements.routeSegment, 'requirements');
  assert.equal(WORK_ITEM_TOOL_DEFINITIONS.bugs.itemIdKey, 'bugId');
  assert.equal(WORK_ITEM_TOOL_DEFINITIONS.feedback.supportsPriority, false);
  assert.equal(getWorkItemToolDefinition('unknown').toolId, 'requirements');
  assert.deepEqual(REQUIREMENT_PRIORITIES, ['P0', 'P1', 'P2', 'P3', 'P4']);
});
