import { DEVELOPMENT_PLATFORM_MCP_TOOL_IDS } from '../mcp/developmentPlatformMcpServer.js';
import { isAssignedToStableUser } from './mcpAiPlanService.js';
import { getWorkItemToolDefinition } from '../../shared/workItemDefinitions.js';

const WORK_ITEM_TOOL_IDS = Object.freeze(['requirements', 'bugs', 'feedback']);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_OFFSET = 5000;

export class McpToolExecutionError extends Error {
  constructor(code, message, publicDetails = null) {
    super(message);
    this.mcpCode = code;
    this.publicDetails = publicDetails;
  }
}

export function createDevelopmentPlatformMcpService({
  statusGroups = {},
  listAccessibleProjects,
  loadProjectWorkItems,
  loadWorkItemDetail,
  loadProjectOverview,
  loadProjectVersionOverview,
  aiPlanService,
  addWorkItemComment,
  submitAiPlanForReview,
  setAiPlanApplied,
  addVersionComment,
  updateWorkItemStatus,
}) {
  const dependencies = [
    listAccessibleProjects,
    loadProjectWorkItems,
    loadWorkItemDetail,
    loadProjectOverview,
    loadProjectVersionOverview,
    addWorkItemComment,
    submitAiPlanForReview,
    setAiPlanApplied,
    addVersionComment,
    updateWorkItemStatus,
  ];
  if (dependencies.some((dependency) => typeof dependency !== 'function') || !aiPlanService) {
    throw new Error('开发平台 MCP 服务依赖不完整');
  }

  async function execute({ toolName, authContext, arguments: args }) {
    const context = {
      token: authContext.token,
      user: authContext.user,
    };
    switch (toolName) {
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_ACCESSIBLE_PROJECTS:
        return listProjects(context, args);
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_MY_WORK_ITEMS:
        return listMyWorkItems(context, args);
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_WORK_ITEM_DETAIL:
        return loadWorkItemDetail({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_PROJECT_OVERVIEW:
        return loadProjectOverview({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_PROJECT_VERSION_OVERVIEW:
        return loadProjectVersionOverview({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_MY_PENDING_AI_PLAN_REVIEWS:
        return args.operation === 'detail'
          ? aiPlanService.getMyPendingReview({
              ...context,
              submissionId: args.submissionId,
            })
          : aiPlanService.listMyPendingReviews({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_MY_APPROVED_AI_PLANS:
        return args.operation === 'detail'
          ? aiPlanService.getMyApprovedPlan({
              ...context,
              submissionId: args.submissionId,
            })
          : aiPlanService.listMyApprovedPlans({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.SET_AI_PLAN_APPLIED:
        return setAiPlanApplied({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.ADD_WORK_ITEM_COMMENT:
        return addWorkItemComment({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.SUBMIT_AI_PLAN_FOR_REVIEW:
        return submitAiPlanForReview({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.ADD_VERSION_COMMENT:
        return addVersionComment({ ...context, ...args });
      case DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.UPDATE_WORK_ITEM_STATUS:
        return updateWorkItemStatus({ ...context, ...args });
      default:
        throw new McpToolExecutionError('invalid_argument', '未知 MCP 工具');
    }
  }

  async function listProjects(context, args) {
    const projects = await listAccessibleProjects(context);
    const serialized = (Array.isArray(projects) ? projects : [])
      .map(serializeAccessibleProject);
    return buildPage('projects', serialized, args.limit, args.offset);
  }

  async function listMyWorkItems(context, args) {
    const projects = await listAccessibleProjects(context);
    const normalizedProjectId = String(args.projectId || '').trim();
    const normalizedToolId = String(args.toolId || '').trim();
    const selectedStatuses = new Set(
      (Array.isArray(args.statuses) ? args.statuses : [])
        .map((status) => String(status || '').trim())
        .filter(Boolean),
    );
    const search = String(args.search || '').trim().toLocaleLowerCase('zh-CN');
    const tasks = [];

    for (const project of Array.isArray(projects) ? projects : []) {
      if (normalizedProjectId && project.projectId !== normalizedProjectId) {
        continue;
      }
      const allowedToolIds = new Set(
        (Array.isArray(project.allowedTools) ? project.allowedTools : [])
          .map((tool) => String(tool?.id || '').trim()),
      );
      for (const toolId of WORK_ITEM_TOOL_IDS) {
        if (
          allowedToolIds.has(toolId)
          && (!normalizedToolId || normalizedToolId === toolId)
        ) {
          tasks.push({ project, toolId });
        }
      }
    }

    const results = await mapWithConcurrency(tasks, 4, async ({ project, toolId }) => {
      try {
        return {
          project,
          toolId,
          items: await loadProjectWorkItems({
            ...context,
            project,
            toolId,
          }),
          warning: '',
        };
      } catch {
        const tool = getWorkItemToolDefinition(toolId);
        return {
          project,
          toolId,
          items: [],
          warning: `${project.projectName || project.projectId}的${tool.listLabel}读取失败，已跳过该范围`,
        };
      }
    });

    const items = results.flatMap(({ project, toolId, items: source }) => (
      (Array.isArray(source) ? source : []).flatMap((item) => {
        if (!isAssignedToStableUser(item?.assignees, context.user)) {
          return [];
        }
        const status = getWorkItemStatus(item);
        if (!args.includeCompleted && getCompletedStatusSet(statusGroups, toolId).has(status)) {
          return [];
        }
        if (selectedStatuses.size > 0 && !selectedStatuses.has(status)) {
          return [];
        }
        const serialized = serializeWorkItemSummary(project, toolId, item);
        if (search && !buildWorkItemSearchText(serialized).includes(search)) {
          return [];
        }
        return [serialized];
      })
    )).sort(compareWorkItemSummaries);

    return {
      ...buildPage('items', items, args.limit, args.offset),
      warnings: results.map((result) => result.warning).filter(Boolean),
    };
  }

  return { execute };
}

function serializeAccessibleProject(project) {
  return {
    projectId: String(project?.projectId || ''),
    projectName: String(project?.projectName || ''),
    allowedTools: (Array.isArray(project?.allowedTools) ? project.allowedTools : [])
      .map((tool) => ({
        id: String(tool?.id || ''),
        label: String(tool?.label || ''),
      }))
      .filter((tool) => tool.id),
    aiPlanning: {
      enabled: project?.aiPlanning?.enabled === true,
      supportedToolIds: (Array.isArray(project?.aiPlanning?.supportedToolIds)
        ? project.aiPlanning.supportedToolIds
        : []).map((toolId) => String(toolId || '')).filter(Boolean),
      unavailableReason: String(project?.aiPlanning?.unavailableReason || ''),
    },
  };
}

function serializeWorkItemSummary(project, toolId, item) {
  const tool = getWorkItemToolDefinition(toolId);
  return {
    projectId: String(project?.projectId || ''),
    projectName: String(project?.projectName || ''),
    toolId,
    toolName: tool.itemLabel,
    recordId: String(item?.recordId || ''),
    itemId: String(item?.itemId || ''),
    title: String(item?.title || tool.unnamedTitle),
    description: String(item?.description || '').slice(0, 2000),
    status: getWorkItemStatus(item),
    priority: String(item?.priority || ''),
    proposedAt: item?.proposedAt || null,
    expectedDays: item?.expectedDays ?? null,
    remainingDays: item?.remainingDays ?? null,
  };
}

function buildWorkItemSearchText(item) {
  return [
    item.projectName,
    item.toolName,
    item.itemId,
    item.title,
    item.description,
    item.status,
    item.priority,
  ].join('\n').toLocaleLowerCase('zh-CN');
}

function compareWorkItemSummaries(left, right) {
  const remainingDifference = sortableRemainingDays(left.remainingDays)
    - sortableRemainingDays(right.remainingDays);
  if (remainingDifference !== 0) {
    return remainingDifference;
  }
  const proposedDifference = sortableTimestamp(left.proposedAt)
    - sortableTimestamp(right.proposedAt);
  if (proposedDifference !== 0) {
    return proposedDifference;
  }
  return String(left.title).localeCompare(String(right.title), 'zh-CN');
}

function sortableRemainingDays(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function sortableTimestamp(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function getWorkItemStatus(item) {
  return String(
    item?.itemStatus
    || item?.requirementStatus
    || item?.status
    || '',
  ).trim();
}

function getCompletedStatusSet(statusGroups, toolId) {
  return new Set(
    (Array.isArray(statusGroups?.[toolId]?.completed)
      ? statusGroups[toolId].completed
      : [])
      .map((status) => String(status || '').trim())
      .filter(Boolean),
  );
}

function buildPage(key, items, limitValue, offsetValue) {
  const limit = normalizeInteger(limitValue, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = normalizeInteger(offsetValue, 0, 0, MAX_OFFSET);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    total: items.length,
    offset,
    limit,
    hasMore: nextOffset < items.length,
    nextOffset: nextOffset < items.length ? nextOffset : null,
    [key]: page,
  };
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, number));
}

async function mapWithConcurrency(items, maxConcurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({
    length: Math.min(Math.max(1, maxConcurrency), items.length),
  }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
