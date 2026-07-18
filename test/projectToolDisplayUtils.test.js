import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProjectToolPendingCount,
  isProjectToolPendingCountTool,
  normalizeRelatedWorkItemCounts,
} from '../src/ui/workspace/projectToolDisplayUtils.js';

test('project tool counts normalize all three work item tools defensively', () => {
  assert.deepEqual(normalizeRelatedWorkItemCounts({
    'project-a': {
      requirements: 3,
      bugs: '2',
      feedback: -1,
    },
    '': { requirements: 9 },
  }), {
    'project-a': {
      requirements: 3,
      bugs: 2,
      feedback: 0,
    },
  });
  assert.deepEqual(normalizeRelatedWorkItemCounts([]), {});
});

test('project tool pending badges only support requirement, Bug, and feedback tools', () => {
  const counts = { requirements: 4, bugs: 2, feedback: 1, versions: 8 };

  assert.equal(getProjectToolPendingCount(counts, 'requirements'), 4);
  assert.equal(getProjectToolPendingCount(counts, 'bugs'), 2);
  assert.equal(getProjectToolPendingCount(counts, 'feedback'), 1);
  assert.equal(getProjectToolPendingCount(counts, 'versions'), 0);
  assert.equal(isProjectToolPendingCountTool('feedback'), true);
  assert.equal(isProjectToolPendingCountTool('overview'), false);
});
