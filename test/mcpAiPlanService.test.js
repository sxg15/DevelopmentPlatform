import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_PLAN_STATUSES } from '../shared/aiPlanningDefinitions.js';
import {
  McpAiPlanNotFoundError,
  createMcpAiPlanService,
  isAssignedToStableUser,
} from '../server/services/mcpAiPlanService.js';

const CURRENT_USER = {
  openId: 'ou_current',
  userId: 'user_current',
  unionId: 'union_current',
  email: 'current@example.com',
  name: '同名用户',
};

function createProject(projectId, toolIds, enabled = true) {
  return {
    projectId,
    projectName: `项目 ${projectId}`,
    allowedTools: toolIds.map((id) => ({ id })),
    aiPlanning: {
      enabled,
      supportedToolIds: toolIds,
    },
  };
}

function createSubmission(overrides = {}) {
  return {
    id: 'plan-1',
    projectId: 'P1',
    projectName: '项目 P1',
    toolId: 'requirements',
    recordId: 'record-1',
    workItemId: 'REQ-001',
    workItemTitle: '旧标题',
    title: '方案一',
    summary: '摘要',
    markdown: '# 方案一',
    sourceReferences: [],
    revision: 1,
    authorName: '提交人',
    revisionAuthorName: '提交人',
    reviewedByName: '审核人',
    reviewedAt: '2026-07-28T08:00:00.000Z',
    applied: false,
    appliedAt: '',
    appliedByName: '',
    submittedAt: '2026-07-28T07:00:00.000Z',
    status: AI_PLAN_STATUSES.APPROVED,
    ...overrides,
  };
}

function createService({
  submissions,
  projects = [createProject('P1', ['requirements', 'bugs'])],
  itemsByGroup,
}) {
  const repository = {
    listApprovedSubmissionsForProjects() {
      return submissions;
    },
    listSubmissions({ projectId, allowedToolIds, toolId = '', status = '' }) {
      return submissions.filter((submission) => (
        submission.projectId === projectId
        && allowedToolIds.includes(submission.toolId)
        && (!toolId || submission.toolId === toolId)
        && (!status || submission.status === status)
      ));
    },
    listSubmissionRevisions(rootSubmissionId) {
      return submissions.filter((submission) => (
        (submission.rootSubmissionId || submission.id) === rootSubmissionId
      )).sort((left, right) => right.revision - left.revision);
    },
    getSubmission(submissionId) {
      return submissions.find((submission) => submission.id === submissionId) || null;
    },
  };
  return createMcpAiPlanService({
    repository,
    async listAccessibleProjects() {
      return projects;
    },
    async loadProjectWorkItems(_token, project, _user, toolId) {
      const value = itemsByGroup[`${project.projectId}/${toolId}`];
      if (value instanceof Error) {
        throw value;
      }
      return value || [];
    },
  });
}

test('stable assignee matching never falls back to names', () => {
  assert.equal(isAssignedToStableUser([{
    openId: 'ou_other',
    name: CURRENT_USER.name,
  }], CURRENT_USER), false);
  assert.equal(isAssignedToStableUser([{
    unionId: CURRENT_USER.unionId,
    name: 'Different',
  }], CURRENT_USER), true);
});

test('MCP AI plan list returns approved plans currently assigned to the user with pagination', async () => {
  const submissions = [
    createSubmission({
      id: 'plan-latest',
      recordId: 'record-latest',
      reviewedAt: '2026-07-28T10:00:00.000Z',
      applied: true,
      appliedAt: '2026-07-28T11:00:00.000Z',
      appliedByName: '当前处理人',
    }),
    createSubmission({
      id: 'plan-older',
      recordId: 'record-older',
      reviewedAt: '2026-07-28T09:00:00.000Z',
    }),
    createSubmission({
      id: 'plan-pending',
      recordId: 'record-pending',
      status: AI_PLAN_STATUSES.PENDING_REVIEW,
    }),
    createSubmission({
      id: 'plan-same-name',
      recordId: 'record-same-name',
    }),
    createSubmission({
      id: 'plan-deleted',
      recordId: 'record-missing',
    }),
    createSubmission({
      id: 'plan-disabled',
      projectId: 'P2',
      recordId: 'record-disabled',
    }),
  ];
  const service = createService({
    submissions,
    projects: [
      createProject('P1', ['requirements']),
      createProject('P2', ['requirements'], false),
    ],
    itemsByGroup: {
      'P1/requirements': [
        {
          recordId: 'record-latest',
          itemId: 'REQ-002',
          title: '最新需求',
          itemStatus: '处理中',
          assignees: [{ openId: CURRENT_USER.openId }],
        },
        {
          recordId: 'record-older',
          itemId: 'REQ-001',
          title: '较早需求',
          itemStatus: '待验收',
          assignees: [{ email: CURRENT_USER.email }],
        },
        {
          recordId: 'record-pending',
          assignees: [{ openId: CURRENT_USER.openId }],
        },
        {
          recordId: 'record-same-name',
          assignees: [{ openId: 'ou_other', name: CURRENT_USER.name }],
        },
      ],
    },
  });

  const firstPage = await service.listMyApprovedPlans({
    token: 'tenant',
    user: CURRENT_USER,
    limit: 1,
    offset: 0,
  });
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextOffset, 1);
  assert.deepEqual(firstPage.plans.map((plan) => plan.submissionId), ['plan-latest']);
  assert.equal(firstPage.plans[0].workItemTitle, '最新需求');
  assert.equal(firstPage.plans[0].workItemStatus, '处理中');
  assert.equal(firstPage.plans[0].applied, true);
  assert.equal(firstPage.plans[0].appliedByName, '当前处理人');
  assert.equal(firstPage.plans[0].appliedAt, '2026-07-28T11:00:00.000Z');
  assert.equal('markdown' in firstPage.plans[0], false);

  const secondPage = await service.listMyApprovedPlans({
    token: 'tenant',
    user: CURRENT_USER,
    limit: 1,
    offset: 1,
    projectId: 'P1',
    toolId: 'requirements',
  });
  assert.deepEqual(secondPage.plans.map((plan) => plan.submissionId), ['plan-older']);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.nextOffset, null);
});

test('MCP AI plan list partially succeeds with sanitized warnings', async () => {
  const service = createService({
    submissions: [
      createSubmission({ id: 'plan-good', projectId: 'P1', recordId: 'record-good' }),
      createSubmission({ id: 'plan-failed', projectId: 'P2', recordId: 'record-failed' }),
    ],
    projects: [
      createProject('P1', ['requirements']),
      createProject('P2', ['requirements']),
    ],
    itemsByGroup: {
      'P1/requirements': [{
        recordId: 'record-good',
        assignees: [{ userId: CURRENT_USER.userId }],
      }],
      'P2/requirements': new Error('D:\\secret\\project-root failed'),
    },
  });

  const result = await service.listMyApprovedPlans({
    token: 'tenant',
    user: CURRENT_USER,
  });
  assert.deepEqual(result.plans.map((plan) => plan.submissionId), ['plan-good']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /项目 P2.*需求列表读取失败/);
  assert.doesNotMatch(result.warnings[0], /secret|project-root/i);
});

test('MCP AI plan detail rechecks access, current assignment and source references', async () => {
  const submission = createSubmission({
    id: 'plan-detail',
    markdown: '# 完整方案',
    sourceReferences: [
      {
        rootId: 'main',
        relativePath: 'src/app.js',
        startLine: 2,
        endLine: 5,
        note: '入口',
      },
      {
        rootId: 'main',
        relativePath: '../secret.txt',
        startLine: 1,
        endLine: 1,
      },
    ],
  });
  let assignees = [{ openId: CURRENT_USER.openId }];
  const service = createService({
    submissions: [submission],
    itemsByGroup: {
      get 'P1/requirements'() {
        return [{
          recordId: 'record-1',
          itemId: 'REQ-001',
          title: '当前标题',
          itemStatus: '待验收',
          assignees,
        }];
      },
    },
  });

  const detail = await service.getMyApprovedPlan({
    token: 'tenant',
    user: CURRENT_USER,
    submissionId: 'plan-detail',
  });
  assert.equal(detail.plan.markdown, '# 完整方案');
  assert.equal(detail.plan.workItemTitle, '当前标题');
  assert.equal(detail.plan.sourceReferences.length, 1);

  assignees = [{ openId: 'ou_reassigned' }];
  await assert.rejects(
    service.getMyApprovedPlan({
      token: 'tenant',
      user: CURRENT_USER,
      submissionId: 'plan-detail',
    }),
    McpAiPlanNotFoundError,
  );
});

test('MCP pending review list allows current assignees and project administrators', async () => {
  const submissions = [
    createSubmission({
      id: 'pending-assignee',
      recordId: 'record-assignee',
      status: AI_PLAN_STATUSES.PENDING_REVIEW,
      submittedAt: '2026-07-29T10:00:00.000Z',
    }),
    createSubmission({
      id: 'pending-other',
      recordId: 'record-other',
      status: AI_PLAN_STATUSES.PENDING_REVIEW,
      submittedAt: '2026-07-29T09:00:00.000Z',
    }),
  ];
  const service = createService({
    submissions,
    itemsByGroup: {
      'P1/requirements': [
        {
          recordId: 'record-assignee',
          assignees: [{ openId: CURRENT_USER.openId }],
        },
        {
          recordId: 'record-other',
          assignees: [{ openId: 'ou_other' }],
        },
      ],
    },
  });

  const result = await service.listMyPendingReviews({
    token: 'tenant',
    user: CURRENT_USER,
  });
  assert.deepEqual(result.plans.map((plan) => plan.submissionId), ['pending-assignee']);

  const adminService = createService({
    submissions,
    projects: [{
      ...createProject('P1', ['requirements']),
      isDevelopmentSuperAdmin: true,
    }],
    itemsByGroup: {
      'P1/requirements': [],
    },
  });
  const adminResult = await adminService.listMyPendingReviews({
    token: 'tenant',
    user: CURRENT_USER,
  });
  assert.deepEqual(
    adminResult.plans.map((plan) => plan.submissionId),
    ['pending-assignee', 'pending-other'],
  );
  assert.equal(adminResult.plans[0].workItemExists, false);
});

test('MCP pending review detail rechecks review permission and returns revisions', async () => {
  const pending = createSubmission({
    id: 'pending-detail',
    status: AI_PLAN_STATUSES.PENDING_REVIEW,
    rootSubmissionId: 'root-1',
    markdown: '# 待审核方案',
  });
  const older = createSubmission({
    id: 'older-detail',
    status: AI_PLAN_STATUSES.REJECTED,
    rootSubmissionId: 'root-1',
    revision: 0,
  });
  let assignees = [{ openId: CURRENT_USER.openId }];
  const service = createService({
    submissions: [pending, older],
    itemsByGroup: {
      get 'P1/requirements'() {
        return [{
          recordId: 'record-1',
          assignees,
        }];
      },
    },
  });

  const detail = await service.getMyPendingReview({
    token: 'tenant',
    user: CURRENT_USER,
    submissionId: pending.id,
  });
  assert.equal(detail.plan.markdown, '# 待审核方案');
  assert.equal(detail.plan.revisions.length, 2);

  assignees = [{ openId: 'ou_other' }];
  await assert.rejects(
    service.getMyPendingReview({
      token: 'tenant',
      user: CURRENT_USER,
      submissionId: pending.id,
    }),
    McpAiPlanNotFoundError,
  );
});
