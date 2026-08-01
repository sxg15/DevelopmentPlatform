import {
  AI_PLAN_STATUSES,
  AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS,
  normalizeAiPlanSourceReferences,
} from '../../shared/aiPlanningDefinitions.js';
import { getWorkItemToolDefinition } from '../../shared/workItemDefinitions.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_OFFSET = 5000;

export class McpAiPlanNotFoundError extends Error {
  constructor() {
    super('AI 计划不存在或不再属于当前用户');
    this.code = 'MCP_AI_PLAN_NOT_FOUND';
  }
}

export function createMcpAiPlanService({
  repository,
  listAccessibleProjects,
  loadProjectWorkItems,
  maxConcurrency = 4,
}) {
  if (!repository || typeof repository.listApprovedSubmissionsForProjects !== 'function') {
    throw new Error('MCP AI 计划服务缺少仓储');
  }
  if (typeof listAccessibleProjects !== 'function' || typeof loadProjectWorkItems !== 'function') {
    throw new Error('MCP AI 计划服务缺少项目数据加载器');
  }

  async function listMyApprovedPlans({
    token,
    user,
    projectId = '',
    toolId = '',
    limit = DEFAULT_LIMIT,
    offset = 0,
  }) {
    const normalizedLimit = normalizeInteger(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const normalizedOffset = normalizeInteger(offset, 0, 0, MAX_OFFSET);
    const projectContexts = await loadEligibleProjectContexts({
      token,
      user,
      projectId,
      toolId,
    });
    if (projectContexts.length === 0) {
      return buildListResult([], [], normalizedLimit, normalizedOffset);
    }

    const projectIds = projectContexts.map((context) => context.project.projectId);
    const requestedTools = toolId ? [toolId] : AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS;
    const submissions = repository.listApprovedSubmissionsForProjects({
      projectIds,
      toolIds: requestedTools,
    }).filter((submission) => (
      submission.status === AI_PLAN_STATUSES.APPROVED
      && projectContexts.some((context) => (
        context.project.projectId === submission.projectId
        && context.toolIds.has(submission.toolId)
      ))
    ));

    const contextsByProjectId = new Map(
      projectContexts.map((context) => [context.project.projectId, context]),
    );
    const groups = groupSubmissions(submissions);
    const loadedGroups = await mapWithConcurrency(groups, maxConcurrency, async (group) => {
      const context = contextsByProjectId.get(group.projectId);
      try {
        const items = await loadProjectWorkItems(
          token,
          context.project,
          user,
          group.toolId,
        );
        return {
          ...group,
          context,
          itemsByRecordId: new Map(
            (Array.isArray(items) ? items : [])
              .map((item) => [String(item?.recordId || '').trim(), item])
              .filter(([recordId]) => recordId),
          ),
          warning: '',
        };
      } catch {
        return {
          ...group,
          context,
          itemsByRecordId: new Map(),
          warning: buildLoadWarning(context.project, group.toolId),
        };
      }
    });

    const warnings = loadedGroups.map((group) => group.warning).filter(Boolean);
    const plans = loadedGroups.flatMap((group) => (
      group.warning
        ? []
        : group.submissions.flatMap((submission) => {
            const workItem = group.itemsByRecordId.get(submission.recordId);
            return workItem && isAssignedToStableUser(workItem.assignees, user)
              ? [serializeMcpAiPlan(submission, group.context.project, workItem)]
              : [];
          })
    )).sort(compareMcpAiPlans);

    return buildListResult(plans, warnings, normalizedLimit, normalizedOffset);
  }

  async function getMyApprovedPlan({ token, user, submissionId }) {
    const normalizedSubmissionId = String(submissionId || '').trim();
    const submission = normalizedSubmissionId
      ? repository.getSubmission(normalizedSubmissionId)
      : null;
    if (!submission || submission.status !== AI_PLAN_STATUSES.APPROVED) {
      throw new McpAiPlanNotFoundError();
    }

    const [context] = await loadEligibleProjectContexts({
      token,
      user,
      projectId: submission.projectId,
      toolId: submission.toolId,
    });
    if (!context) {
      throw new McpAiPlanNotFoundError();
    }

    let items;
    try {
      items = await loadProjectWorkItems(
        token,
        context.project,
        user,
        submission.toolId,
      );
    } catch {
      throw new McpAiPlanNotFoundError();
    }
    const workItem = (Array.isArray(items) ? items : []).find(
      (item) => String(item?.recordId || '').trim() === submission.recordId,
    );
    if (!workItem || !isAssignedToStableUser(workItem.assignees, user)) {
      throw new McpAiPlanNotFoundError();
    }

    return {
      operation: 'detail',
      plan: {
        ...serializeMcpAiPlan(submission, context.project, workItem),
        markdown: String(submission.markdown || ''),
        sourceReferences: normalizeAiPlanSourceReferences(submission.sourceReferences),
      },
    };
  }

  async function listMyPendingReviews({
    token,
    user,
    projectId = '',
    toolId = '',
    limit = DEFAULT_LIMIT,
    offset = 0,
  }) {
    const normalizedLimit = normalizeInteger(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const normalizedOffset = normalizeInteger(offset, 0, 0, MAX_OFFSET);
    const projectContexts = await loadEligibleProjectContexts({
      token,
      user,
      projectId,
      toolId,
    });
    if (projectContexts.length === 0) {
      return buildPendingReviewListResult([], [], normalizedLimit, normalizedOffset);
    }

    const submissions = projectContexts.flatMap((context) => repository.listSubmissions({
      projectId: context.project.projectId,
      allowedToolIds: [...context.toolIds],
      toolId,
      status: AI_PLAN_STATUSES.PENDING_REVIEW,
    }));
    const contextsByProjectId = new Map(
      projectContexts.map((context) => [context.project.projectId, context]),
    );
    const groups = groupSubmissions(submissions);
    const loadedGroups = await mapWithConcurrency(groups, maxConcurrency, async (group) => {
      const context = contextsByProjectId.get(group.projectId);
      try {
        const items = await loadProjectWorkItems(
          token,
          context.project,
          user,
          group.toolId,
        );
        return {
          ...group,
          context,
          itemsByRecordId: new Map(
            (Array.isArray(items) ? items : [])
              .map((item) => [String(item?.recordId || '').trim(), item])
              .filter(([recordId]) => recordId),
          ),
          warning: '',
        };
      } catch {
        return {
          ...group,
          context,
          itemsByRecordId: new Map(),
          warning: buildLoadWarning(context.project, group.toolId),
        };
      }
    });

    const warnings = loadedGroups.map((group) => group.warning).filter(Boolean);
    const plans = loadedGroups.flatMap((group) => (
      group.warning
        ? []
        : group.submissions.flatMap((submission) => {
            const workItem = group.itemsByRecordId.get(submission.recordId) || null;
            return canReviewSubmission(group.context.project, workItem, user)
              ? [serializeMcpAiPlan(submission, group.context.project, workItem)]
              : [];
          })
    )).sort(comparePendingReviews);

    return buildPendingReviewListResult(
      plans,
      warnings,
      normalizedLimit,
      normalizedOffset,
    );
  }

  async function getMyPendingReview({ token, user, submissionId }) {
    const normalizedSubmissionId = String(submissionId || '').trim();
    const submission = normalizedSubmissionId
      ? repository.getSubmission(normalizedSubmissionId)
      : null;
    if (!submission || submission.status !== AI_PLAN_STATUSES.PENDING_REVIEW) {
      throw new McpAiPlanNotFoundError();
    }

    const [context] = await loadEligibleProjectContexts({
      token,
      user,
      projectId: submission.projectId,
      toolId: submission.toolId,
    });
    if (!context) {
      throw new McpAiPlanNotFoundError();
    }

    let items;
    try {
      items = await loadProjectWorkItems(
        token,
        context.project,
        user,
        submission.toolId,
      );
    } catch {
      throw new McpAiPlanNotFoundError();
    }
    const workItem = (Array.isArray(items) ? items : []).find(
      (item) => String(item?.recordId || '').trim() === submission.recordId,
    ) || null;
    if (!canReviewSubmission(context.project, workItem, user)) {
      throw new McpAiPlanNotFoundError();
    }

    return {
      operation: 'detail',
      plan: {
        ...serializeMcpAiPlan(submission, context.project, workItem),
        markdown: String(submission.markdown || ''),
        sourceReferences: normalizeAiPlanSourceReferences(submission.sourceReferences),
        revisions: repository.listSubmissionRevisions(submission.rootSubmissionId)
          .map((revision) => ({
            submissionId: revision.id,
            revision: revision.revision,
            status: revision.status,
            title: revision.title,
            summary: revision.summary,
            revisionAuthorName: revision.revisionAuthorName,
            submittedAt: revision.submittedAt,
            reviewedAt: revision.reviewedAt,
            reviewReason: revision.reviewReason,
          })),
      },
    };
  }

  async function loadEligibleProjectContexts({ token, user, projectId, toolId }) {
    const normalizedProjectId = String(projectId || '').trim();
    const normalizedToolId = String(toolId || '').trim();
    const projects = await listAccessibleProjects(token, user);
    return (Array.isArray(projects) ? projects : [])
      .filter((project) => !normalizedProjectId || project.projectId === normalizedProjectId)
      .map((project) => ({
        project,
        toolIds: getEligibleProjectToolIds(project),
      }))
      .filter((context) => (
        context.toolIds.size > 0
        && (!normalizedToolId || context.toolIds.has(normalizedToolId))
      ));
  }

  return {
    getMyApprovedPlan,
    getMyPendingReview,
    listMyApprovedPlans,
    listMyPendingReviews,
  };
}

export function isAssignedToStableUser(assignees, user) {
  const userKeys = buildStableUserKeySet(user);
  if (userKeys.size === 0) {
    return false;
  }
  return (Array.isArray(assignees) ? assignees : []).some((assignee) => (
    [...buildStableUserKeySet(assignee)].some((key) => userKeys.has(key))
  ));
}

function getEligibleProjectToolIds(project) {
  if (project?.aiPlanning?.enabled !== true) {
    return new Set();
  }
  const allowedToolIds = new Set(
    (Array.isArray(project.allowedTools) ? project.allowedTools : [])
      .map((tool) => String(tool?.id || '').trim())
      .filter(Boolean),
  );
  const supportedToolIds = new Set(
    (Array.isArray(project.aiPlanning.supportedToolIds)
      ? project.aiPlanning.supportedToolIds
      : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  return new Set(AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS.filter(
    (toolId) => allowedToolIds.has(toolId) && supportedToolIds.has(toolId),
  ));
}

function groupSubmissions(submissions) {
  const groups = new Map();
  for (const submission of submissions) {
    const key = `${submission.projectId}\u0000${submission.toolId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        projectId: submission.projectId,
        toolId: submission.toolId,
        submissions: [],
      });
    }
    groups.get(key).submissions.push(submission);
  }
  return [...groups.values()];
}

function serializeMcpAiPlan(submission, project, workItem) {
  const tool = getWorkItemToolDefinition(submission.toolId);
  return {
    submissionId: submission.id,
    projectId: submission.projectId,
    projectName: String(project?.projectName || submission.projectName || ''),
    toolId: submission.toolId,
    toolName: tool.itemLabel,
    recordId: submission.recordId,
    workItemExists: Boolean(workItem),
    workItemId: String(workItem?.itemId || submission.workItemId || ''),
    workItemTitle: String(workItem?.title || submission.workItemTitle || ''),
    workItemStatus: String(
      workItem?.itemStatus
      || workItem?.requirementStatus
      || workItem?.status
      || '',
    ),
    title: String(submission.title || ''),
    summary: String(submission.summary || ''),
    revision: Number(submission.revision || 0),
    authorName: String(submission.authorName || ''),
    revisionAuthorName: String(submission.revisionAuthorName || submission.authorName || ''),
    reviewerName: String(submission.reviewedByName || ''),
    approvedAt: String(submission.reviewedAt || submission.submittedAt || ''),
    applied: submission.applied === true,
    appliedAt: String(submission.appliedAt || ''),
    appliedByName: String(submission.appliedByName || ''),
    submittedAt: String(submission.submittedAt || ''),
  };
}

function canReviewSubmission(project, workItem, user) {
  return Boolean(
    project?.isSuperAdmin
    || project?.isDevelopmentSuperAdmin
    || (
      workItem
      && isAssignedToStableUser(workItem.assignees, user)
    ),
  );
}

function buildListResult(plans, warnings, limit, offset) {
  const page = plans.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    operation: 'list',
    total: plans.length,
    offset,
    limit,
    hasMore: nextOffset < plans.length,
    nextOffset: nextOffset < plans.length ? nextOffset : null,
    plans: page,
    warnings,
  };
}

function buildPendingReviewListResult(plans, warnings, limit, offset) {
  const result = buildListResult(plans, warnings, limit, offset);
  return {
    ...result,
    plans: result.plans,
  };
}

function compareMcpAiPlans(left, right) {
  const timeDifference = parseTimestamp(right.approvedAt) - parseTimestamp(left.approvedAt);
  if (timeDifference !== 0) {
    return timeDifference;
  }
  return String(left.submissionId).localeCompare(String(right.submissionId));
}

function comparePendingReviews(left, right) {
  const timeDifference = parseTimestamp(right.submittedAt) - parseTimestamp(left.submittedAt);
  if (timeDifference !== 0) {
    return timeDifference;
  }
  return String(left.submissionId).localeCompare(String(right.submissionId));
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildStableUserKeySet(user) {
  const entries = [
    ['openId', user?.openId || user?.open_id],
    ['userId', user?.userId || user?.user_id],
    ['unionId', user?.unionId || user?.union_id],
    ['email', String(user?.email || '').toLowerCase()],
  ];
  return new Set(entries
    .map(([type, value]) => {
      const normalized = String(value || '').trim();
      return normalized ? `${type}:${normalized}` : '';
    })
    .filter(Boolean));
}

function buildLoadWarning(project, toolId) {
  const tool = getWorkItemToolDefinition(toolId);
  const projectName = String(project?.projectName || project?.projectId || '未知项目');
  return `${projectName}的${tool.listLabel}读取失败，已跳过该范围`;
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
