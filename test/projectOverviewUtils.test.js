import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProjectOverviewData,
  normalizeProjectOverviewConfig,
} from '../shared/projectOverviewUtils.js';

const NOW = Date.parse('2026-07-17T04:00:00.000Z');
const CURRENT_USER = { openId: 'ou-me', name: '当前用户' };

test('project overview aggregates project and personal scopes with configured statuses', () => {
  const toolItems = {
    requirements: [
      createItem({
        recordId: 'req-1',
        status: '待处理',
        priority: 'P0',
        remainingDays: -1,
        assignees: [CURRENT_USER],
      }),
      createItem({
        recordId: 'req-2',
        status: '处理中',
        assignees: [{ openId: 'ou-other', name: '其他用户' }],
      }),
      createItem({
        recordId: 'req-acceptance',
        status: '待验收',
        assignees: [{ openId: 'ou-other', name: '其他用户' }],
      }),
    ],
    bugs: [
      createItem({
        recordId: 'bug-1',
        status: '未处理',
        priority: 'P1',
        assignees: [],
      }),
    ],
  };

  const project = buildProjectOverviewData({
    toolItems,
    currentUser: CURRENT_USER,
    scope: 'project',
    now: NOW,
  });
  const mine = buildProjectOverviewData({
    toolItems,
    currentUser: CURRENT_USER,
    scope: 'mine',
    now: NOW,
  });

  assert.equal(project.summary.active, 4);
  assert.equal(project.summary.waiting, 2);
  assert.equal(project.summary.processing, 2);
  assert.equal(project.summary.overdue, 1);
  assert.equal(project.summary.unassigned, 1);
  assert.equal(mine.summary.active, 1);
  assert.equal(mine.summary.overdue, 1);
});

test('acceptance status remains processing even when legacy config omits or misclassifies it', () => {
  const config = normalizeProjectOverviewConfig({
    statusGroups: {
      requirements: {
        waiting: ['待处理'],
        processing: ['处理中'],
        completed: ['已完成', '待验收'],
        blocked: ['已搁置'],
      },
      bugs: {
        waiting: ['未处理'],
        processing: ['修复中'],
        completed: ['已修复'],
        blocked: ['待验收'],
      },
    },
  });

  assert.deepEqual(config.statusGroups.requirements.processing, ['处理中', '待验收']);
  assert.equal(config.statusGroups.requirements.completed.includes('待验收'), false);
  assert.deepEqual(config.statusGroups.bugs.processing, ['修复中', '待验收']);
  assert.equal(config.statusGroups.bugs.blocked.includes('待验收'), false);
});

test('project overview identifies attachment, stale, deadline and priority risks', () => {
  const toolItems = {
    requirements: [
      createItem({
        recordId: 'req-risk',
        status: '处理中',
        priority: 'P1',
        proposedAt: NOW - 10 * 24 * 60 * 60 * 1000,
        remainingDays: 0.5,
        assignees: [CURRENT_USER],
        requiresSubmissionAttachment: true,
        submittedAttachments: [],
      }),
    ],
  };

  const result = buildProjectOverviewData({
    toolItems,
    currentUser: CURRENT_USER,
    now: NOW,
    config: normalizeProjectOverviewConfig({ staleDays: 7, dueSoonDays: 1 }),
  });

  assert.equal(result.summary.dueSoon, 1);
  assert.equal(result.summary.stale, 1);
  assert.equal(result.summary.missingAttachments, 1);
  assert.deepEqual(
    result.risks[0].riskKinds,
    ['dueSoon', 'stale', 'missingAttachment'],
  );
});

test('project overview counts completion transitions and builds the selected trend range', () => {
  const completedAt = Date.parse('2026-07-16T02:00:00.000Z');
  const toolItems = {
    requirements: [
      createItem({
        recordId: 'req-completed',
        status: '已完成',
        proposedAt: Date.parse('2026-07-15T02:00:00.000Z'),
        statusChangeLog: [
          {
            id: 'status-1',
            oldStatus: '处理中',
            newStatus: '已完成',
            changedAt: completedAt,
            operatorName: '当前用户',
          },
          {
            id: 'status-2',
            oldStatus: '已完成',
            newStatus: '关闭',
            changedAt: Date.parse('2026-07-16T03:00:00.000Z'),
            operatorName: '当前用户',
          },
        ],
      }),
    ],
  };

  const result = buildProjectOverviewData({
    toolItems,
    currentUser: CURRENT_USER,
    trendDays: 14,
    now: NOW,
  });

  assert.equal(result.summary.completedThisWeek, 1);
  assert.equal(result.trend.length, 14);
  assert.equal(result.trend.find((item) => item.date === '2026-07-15')?.created, 1);
  assert.equal(result.trend.find((item) => item.date === '2026-07-16')?.completed, 1);
});

test('project overview counts shared work in every assignee load and keeps missing tools', () => {
  const toolItems = {
    bugs: [
      createItem({
        recordId: 'bug-shared',
        status: '修复中',
        assignees: [
          CURRENT_USER,
          { openId: 'ou-other', name: '其他用户' },
        ],
      }),
    ],
  };

  const result = buildProjectOverviewData({
    toolItems,
    currentUser: CURRENT_USER,
    now: NOW,
    unavailableTools: [
      {
        toolId: 'feedback',
        label: '反馈列表',
        reason: 'notConfigured',
        message: '找不到项目反馈表',
      },
    ],
  });

  assert.equal(result.assigneeLoad.length, 2);
  assert.equal(result.assigneeLoad[0].total, 1);
  assert.equal(result.assigneeLoad[1].total, 1);
  assert.equal(result.unavailableTools[0].reason, 'notConfigured');
});

test('project overview sorts finite deadlines before risks without a deadline', () => {
  const toolItems = {
    requirements: [
      createItem({
        recordId: 'req-no-deadline',
        status: '待处理',
        remainingDays: null,
        assignees: [],
      }),
      createItem({
        recordId: 'req-with-deadline',
        status: '待处理',
        remainingDays: 2,
        assignees: [],
      }),
    ],
  };

  const result = buildProjectOverviewData({
    toolItems,
    currentUser: CURRENT_USER,
    now: NOW,
  });

  assert.deepEqual(result.risks.map((item) => item.recordId), [
    'req-with-deadline',
    'req-no-deadline',
  ]);
});

function createItem({
  recordId,
  status,
  priority = 'P2',
  proposedAt = NOW - 2 * 24 * 60 * 60 * 1000,
  remainingDays = 2,
  assignees = [CURRENT_USER],
  statusChangeLog = [],
  requiresSubmissionAttachment = false,
  submittedAttachments = [],
}) {
  return {
    recordId,
    itemId: recordId,
    title: `标题 ${recordId}`,
    itemStatus: status,
    requirementStatus: status,
    priority,
    proposedAt,
    expectedDays: 5,
    remainingDays,
    assignees,
    proposers: [{ openId: 'ou-proposer', name: '提出人' }],
    comments: [],
    statusChangeLog,
    requiresSubmissionAttachment,
    submittedAttachments,
  };
}
