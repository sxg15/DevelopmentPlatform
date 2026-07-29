import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVELOPMENT_PLATFORM_MCP_TOOL_IDS } from '../server/mcp/developmentPlatformMcpServer.js';
import { createDevelopmentPlatformMcpService } from '../server/services/developmentPlatformMcpService.js';

const CURRENT_USER = {
  openId: 'ou_current',
  email: 'current@example.com',
};

function createService(overrides = {}) {
  const projects = [{
    projectId: '50',
    projectName: '开发平台',
    allowedTools: [
      { id: 'overview', label: '项目总览' },
      { id: 'requirements', label: '需求列表' },
      { id: 'bugs', label: 'Bug列表' },
      { id: 'aiPlans', label: 'AI方案' },
    ],
    mentionableUsersByTool: {
      requirements: [{ openId: 'ou_user', name: '用户' }],
    },
    aiPlanning: {
      enabled: true,
      supportedToolIds: ['requirements', 'bugs'],
      unavailableReason: '',
    },
  }];
  const callbacks = {
    statusGroups: {
      requirements: { completed: ['已完成'] },
      bugs: { completed: ['已修复'] },
      feedback: { completed: ['已处理'] },
    },
    async listAccessibleProjects() {
      return projects;
    },
    async loadProjectWorkItems({ toolId }) {
      if (toolId === 'bugs') {
        throw new Error('D:\\secret\\root failed');
      }
      return [
        {
          recordId: 'record-current',
          itemId: 'R-001',
          title: '当前需求',
          description: '需要处理',
          itemStatus: '处理中',
          remainingDays: 1,
          proposedAt: 2,
          assignees: [{ openId: CURRENT_USER.openId }],
        },
        {
          recordId: 'record-completed',
          itemId: 'R-002',
          title: '已完成需求',
          itemStatus: '已完成',
          assignees: [{ email: CURRENT_USER.email }],
        },
        {
          recordId: 'record-other',
          itemId: 'R-003',
          title: '他人需求',
          itemStatus: '处理中',
          assignees: [{ openId: 'ou_other' }],
        },
      ];
    },
    async loadWorkItemDetail(args) {
      return { detail: args.recordId };
    },
    async loadProjectOverview(args) {
      return { overview: args.scope };
    },
    async loadProjectVersionOverview(args) {
      return { versionProject: args.projectId };
    },
    aiPlanService: {
      async getMyPendingReview() {
        return { pending: 'detail' };
      },
      async listMyPendingReviews() {
        return { pending: 'list' };
      },
      async getMyApprovedPlan() {
        return { approved: 'detail' };
      },
      async listMyApprovedPlans() {
        return { approved: 'list' };
      },
    },
    async addWorkItemComment(args) {
      return { mutation: args.clientMutationId };
    },
    async submitAiPlanForReview(args) {
      return { submission: args.clientMutationId };
    },
    async addVersionComment(args) {
      return { versionComment: args.clientMutationId };
    },
    async updateWorkItemStatus(args) {
      return { status: args.newStatus };
    },
    ...overrides,
  };
  return createDevelopmentPlatformMcpService(callbacks);
}

test('MCP project and work item reads sanitize access data and filter current assignments', async () => {
  const service = createService();
  const authContext = { token: 'tenant', user: CURRENT_USER };

  const projectResult = await service.execute({
    toolName: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_ACCESSIBLE_PROJECTS,
    authContext,
    arguments: { limit: 20, offset: 0 },
  });
  assert.equal(projectResult.total, 1);
  assert.equal(projectResult.projects[0].projectId, '50');
  assert.equal('mentionableUsersByTool' in projectResult.projects[0], false);

  const itemResult = await service.execute({
    toolName: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_MY_WORK_ITEMS,
    authContext,
    arguments: {
      includeCompleted: false,
      statuses: [],
      search: '',
      limit: 20,
      offset: 0,
    },
  });
  assert.deepEqual(itemResult.items.map((item) => item.itemId), ['R-001']);
  assert.equal(itemResult.warnings.length, 1);
  assert.match(itemResult.warnings[0], /开发平台.*Bug列表读取失败/);
  assert.doesNotMatch(itemResult.warnings[0], /secret|root/i);
});

test('MCP work item filters support completion, status, search and pagination', async () => {
  const service = createService();
  const authContext = { token: 'tenant', user: CURRENT_USER };
  const result = await service.execute({
    toolName: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_MY_WORK_ITEMS,
    authContext,
    arguments: {
      projectId: '50',
      toolId: 'requirements',
      includeCompleted: true,
      statuses: ['已完成'],
      search: 'R-002',
      limit: 1,
      offset: 0,
    },
  });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].recordId, 'record-completed');
  assert.equal(result.hasMore, false);
});

test('MCP dispatcher routes read and write tools to their owning callbacks', async () => {
  const service = createService();
  const authContext = { token: 'tenant', user: CURRENT_USER };
  const detail = await service.execute({
    toolName: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_WORK_ITEM_DETAIL,
    authContext,
    arguments: {
      projectId: '50',
      toolId: 'requirements',
      recordId: 'record-1',
    },
  });
  assert.equal(detail.detail, 'record-1');

  const mutation = await service.execute({
    toolName: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.ADD_WORK_ITEM_COMMENT,
    authContext,
    arguments: {
      projectId: '50',
      toolId: 'requirements',
      recordId: 'record-1',
      content: '处理中',
      mentionedUserOpenIds: [],
      notifyMentioned: false,
      clientMutationId: 'mutation-1',
    },
  });
  assert.equal(mutation.mutation, 'mutation-1');
});
