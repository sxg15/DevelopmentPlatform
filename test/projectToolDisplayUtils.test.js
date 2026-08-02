import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProjectToolPendingCount,
  isProjectToolPendingCountTool,
  normalizeRelatedWorkItemCounts,
} from '../src/ui/workspace/projectToolDisplayUtils.js';

test('project tool counts normalize all four work item tools defensively', () => {
  assert.deepEqual(normalizeRelatedWorkItemCounts({
    'project-a': {
      requirements: 3,
      bugs: '2',
      testTasks: '4',
      feedback: -1,
    },
    '': { requirements: 9 },
  }), {
    'project-a': {
      requirements: 3,
      bugs: 2,
      testTasks: 4,
      feedback: 0,
    },
  });
  assert.deepEqual(normalizeRelatedWorkItemCounts([]), {});
});

test('project tool pending badges support work item and test task tools', () => {
  const counts = { requirements: 4, bugs: 2, testTasks: 3, feedback: 1, versions: 8 };

  assert.equal(getProjectToolPendingCount(counts, 'requirements'), 4);
  assert.equal(getProjectToolPendingCount(counts, 'bugs'), 2);
  assert.equal(getProjectToolPendingCount(counts, 'feedback'), 1);
  assert.equal(getProjectToolPendingCount(counts, 'testTasks'), 3);
  assert.equal(getProjectToolPendingCount(counts, 'versions'), 0);
  assert.equal(isProjectToolPendingCountTool('feedback'), true);
  assert.equal(isProjectToolPendingCountTool('testTasks'), true);
  assert.equal(isProjectToolPendingCountTool('overview'), false);
});
