import {
  FEEDBACK_LEGACY_ACTIVE_STATUSES,
  FEEDBACK_LEGACY_COMPLETED_STATUSES,
  FEEDBACK_STATUSES,
  getWorkItemAcceptanceStatus,
  getWorkItemProcessingStatuses,
} from './workItemDefinitions.js';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PROJECT_OVERVIEW_TOOL_ORDER = ['requirements', 'bugs', 'testTasks', 'feedback'];
export const PROJECT_OVERVIEW_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'];

export const DEFAULT_PROJECT_OVERVIEW_CONFIG = {
  cacheTtlMs: 45 * 1000,
  staleDays: 7,
  dueSoonDays: 1,
  statusGroups: {
    requirements: {
      waiting: ['待处理'],
      processing: getWorkItemProcessingStatuses('requirements'),
      completed: ['已完成', '已处理', '关闭'],
      blocked: ['已搁置', '已拒绝'],
    },
    bugs: {
      waiting: ['未处理'],
      processing: getWorkItemProcessingStatuses('bugs'),
      completed: ['已修复', '关闭'],
      blocked: ['无法复现', '已搁置'],
    },
    testTasks: {
      waiting: ['待测试'],
      processing: ['测试中'],
      completed: ['已完成'],
      blocked: [],
    },
    feedback: {
      waiting: [FEEDBACK_STATUSES.waiting],
      processing: [],
      completed: [
        FEEDBACK_STATUSES.convertedToRequirement,
        FEEDBACK_STATUSES.convertedToBug,
        FEEDBACK_STATUSES.replied,
        ...FEEDBACK_LEGACY_COMPLETED_STATUSES,
      ],
      blocked: [],
    },
  },
};

const TOOL_LABELS = {
  requirements: '需求',
  bugs: 'Bug',
  testTasks: '测试任务',
  feedback: '反馈',
};

const STATUS_CATEGORY_LABELS = {
  waiting: '待处理',
  processing: '处理中',
  completed: '已完成',
  blocked: '阻塞',
  other: '其他活跃',
};

const RISK_LABELS = {
  unassigned: '未分配',
  overdue: '已逾期',
  dueSoon: '即将到期',
  stale: '长期无进展',
  missingAttachment: '缺少附件',
  highPriority: '高优先级待处理',
};

export function normalizeProjectOverviewConfig(value = {}) {
  return {
    cacheTtlMs: normalizePositiveNumber(value.cacheTtlMs, DEFAULT_PROJECT_OVERVIEW_CONFIG.cacheTtlMs),
    staleDays: normalizePositiveNumber(value.staleDays, DEFAULT_PROJECT_OVERVIEW_CONFIG.staleDays),
    dueSoonDays: normalizePositiveNumber(value.dueSoonDays, DEFAULT_PROJECT_OVERVIEW_CONFIG.dueSoonDays),
    statusGroups: Object.fromEntries(PROJECT_OVERVIEW_TOOL_ORDER.map((toolId) => [
      toolId,
      normalizeStatusGroups(
        value.statusGroups?.[toolId],
        DEFAULT_PROJECT_OVERVIEW_CONFIG.statusGroups[toolId],
        toolId,
      ),
    ])),
  };
}

export function buildProjectOverviewData({
  toolItems = {},
  currentUser = null,
  scope = 'project',
  trendDays = 30,
  config = DEFAULT_PROJECT_OVERVIEW_CONFIG,
  now = Date.now(),
  unavailableTools = [],
} = {}) {
  const normalizedConfig = normalizeProjectOverviewConfig(config);
  const normalizedScope = scope === 'mine' ? 'mine' : 'project';
  const normalizedTrendDays = [14, 30, 90].includes(Number(trendDays)) ? Number(trendDays) : 30;
  const currentUserKeys = buildUserKeySet(currentUser);
  const preparedItems = [];

  for (const toolId of PROJECT_OVERVIEW_TOOL_ORDER) {
    const groups = normalizedConfig.statusGroups[toolId];
    const sourceItems = Array.isArray(toolItems[toolId]) ? toolItems[toolId] : [];
    for (const item of sourceItems) {
      if (
        normalizedScope === 'mine'
        && item?.isMine !== true
        && !hasMatchingUser(item?.assignees, currentUserKeys)
      ) {
        continue;
      }
      preparedItems.push(prepareOverviewItem(toolId, item, groups, normalizedConfig, now));
    }
  }

  const summary = buildSummary(preparedItems, normalizedConfig, now);
  const statusByTool = buildStatusByTool(preparedItems, toolItems, normalizedConfig);
  const priorityDistribution = PROJECT_OVERVIEW_PRIORITIES.map((priority) => ({
    priority,
    count: preparedItems.filter(
      (item) => item.active && !['feedback', 'testTasks'].includes(item.toolId) && item.priority === priority,
    ).length,
  }));
  const trend = buildTrend(preparedItems, normalizedTrendDays, now);
  const assigneeLoad = buildAssigneeLoad(preparedItems);
  const risks = buildRisks(preparedItems);
  const recentActivity = buildRecentActivity(preparedItems);

  return {
    generatedAt: now,
    scope: normalizedScope,
    trendDays: normalizedTrendDays,
    summary,
    statusByTool,
    priorityDistribution,
    trend,
    assigneeLoad,
    risks,
    recentActivity,
    unavailableTools: normalizeUnavailableTools(unavailableTools),
    historyNotice: '完成趋势和最近动态仅统计开发平台已记录的状态变化与留言。',
  };
}

function prepareOverviewItem(toolId, item, groups, config, now) {
  const status = String(item?.itemStatus || item?.requirementStatus || '未设置状态').trim() || '未设置状态';
  const category = getStatusCategory(status, groups);
  const active = ['waiting', 'processing', 'other'].includes(category);
  const proposedAt = normalizeTimestamp(item?.proposedAt);
  const expectedDays = normalizeNumber(item?.expectedDays);
  const remainingDays = normalizeNumber(item?.remainingDays);
  const assignees = normalizePeople(item?.assignees);
  const proposers = normalizePeople(item?.proposers);
  const comments = normalizeComments(item?.comments);
  const statusChangeLog = normalizeStatusChanges(item?.statusChangeLog);
  const lastActivityAt = Math.max(
    proposedAt || 0,
    ...comments.map((comment) => comment.createdAt || 0),
    ...statusChangeLog.map((change) => change.changedAt || 0),
  );
  const staleThreshold = now - config.staleDays * DAY_MS;
  const overdue = active && expectedDays !== null && expectedDays > 0 && remainingDays !== null && remainingDays < 0;
  const dueSoon = active
    && expectedDays !== null
    && expectedDays > 0
    && remainingDays !== null
    && remainingDays >= 0
    && remainingDays < config.dueSoonDays;
  const stale = category === 'processing' && lastActivityAt > 0 && lastActivityAt < staleThreshold;
  const priority = PROJECT_OVERVIEW_PRIORITIES.includes(String(item?.priority || '').trim())
    ? String(item.priority).trim()
    : '';
  const missingAttachment = toolId === 'requirements'
    && Boolean(item?.requiresSubmissionAttachment)
    && (!Array.isArray(item?.submittedAttachments) || item.submittedAttachments.length === 0)
    && category !== 'blocked';

  return {
    toolId,
    toolLabel: TOOL_LABELS[toolId] || toolId,
    recordId: String(item?.recordId || '').trim(),
    itemId: String(item?.itemId || item?.taskId || item?.feedbackId || item?.requirementId || '').trim(),
    title: String(item?.title || `未命名${TOOL_LABELS[toolId] || '工作项'}`).trim(),
    status,
    category,
    active,
    priority,
    proposedAt,
    expectedDays,
    remainingDays,
    assignees,
    proposers,
    comments,
    statusChangeLog,
    lastActivityAt,
    overdue,
    dueSoon,
    stale,
    missingAttachment,
    statusGroups: groups,
  };
}

function buildSummary(items, config, now) {
  const completedThisWeekIds = new Set();
  const weekStart = startOfShanghaiWeek(now);

  for (const item of items) {
    if (item.statusChangeLog.some((change) => (
      change.changedAt >= weekStart
      && isCompletedTransition(change, item.statusGroups)
    ))) {
      completedThisWeekIds.add(`${item.toolId}:${item.recordId || item.itemId || item.title}`);
    }
  }

  return {
    active: items.filter((item) => item.active).length,
    waiting: items.filter((item) => item.category === 'waiting').length,
    processing: items.filter((item) => item.category === 'processing').length,
    overdue: items.filter((item) => item.overdue).length,
    dueSoon: items.filter((item) => item.dueSoon).length,
    unassigned: items.filter((item) => (
      item.active
      && item.assignees.length === 0
      && !(item.toolId === 'testTasks' && item.category === 'waiting')
    )).length,
    completedThisWeek: completedThisWeekIds.size,
    highPriority: items.filter(
      (item) => item.active && ['P0', 'P1'].includes(item.priority),
    ).length,
    missingAttachments: items.filter((item) => item.missingAttachment).length,
    stale: items.filter((item) => item.stale).length,
    staleDays: config.staleDays,
  };
}

function buildStatusByTool(items, sourceToolItems, config) {
  return PROJECT_OVERVIEW_TOOL_ORDER
    .filter((toolId) => Object.prototype.hasOwnProperty.call(sourceToolItems, toolId))
    .map((toolId) => {
      const toolItems = items.filter((item) => item.toolId === toolId);
      const groups = config.statusGroups[toolId];
      return {
        toolId,
        label: TOOL_LABELS[toolId] || toolId,
        total: toolItems.length,
        categories: ['waiting', 'processing', 'completed', 'blocked', 'other'].map((key) => ({
          key,
          label: STATUS_CATEGORY_LABELS[key],
          count: toolItems.filter((item) => item.category === key).length,
          statuses: getCategoryStatuses(toolItems, key, groups),
        })),
      };
    });
}

function buildTrend(items, trendDays, now) {
  const endDay = startOfShanghaiDay(now);
  const startDay = endDay - (trendDays - 1) * DAY_MS;
  const buckets = new Map();

  for (let index = 0; index < trendDays; index += 1) {
    const timestamp = startDay + index * DAY_MS;
    const date = formatShanghaiDateKey(timestamp);
    buckets.set(date, { date, created: 0, completed: 0 });
  }

  for (const item of items) {
    if (item.proposedAt >= startDay && item.proposedAt < endDay + DAY_MS) {
      const bucket = buckets.get(formatShanghaiDateKey(item.proposedAt));
      if (bucket) {
        bucket.created += 1;
      }
    }

    for (const change of item.statusChangeLog) {
      if (
        change.changedAt < startDay
        || change.changedAt >= endDay + DAY_MS
        || !isCompletedTransition(change, item.statusGroups)
      ) {
        continue;
      }
      const bucket = buckets.get(formatShanghaiDateKey(change.changedAt));
      if (bucket) {
        bucket.completed += 1;
      }
    }
  }

  return [...buckets.values()];
}

function buildAssigneeLoad(items) {
  const loadByUser = new Map();

  for (const item of items.filter((candidate) => candidate.active)) {
    const seen = new Set();
    for (const assignee of item.assignees) {
      const key = getPrimaryUserKey(assignee);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const load = loadByUser.get(key) || {
        userKey: key,
        name: assignee.name || '未命名用户',
        avatarUrl: assignee.avatarUrl || '',
        waiting: 0,
        processing: 0,
        overdue: 0,
        total: 0,
      };
      load.total += 1;
      if (item.category === 'waiting') {
        load.waiting += 1;
      }
      if (item.category === 'processing') {
        load.processing += 1;
      }
      if (item.overdue) {
        load.overdue += 1;
      }
      loadByUser.set(key, load);
    }
  }

  return [...loadByUser.values()]
    .sort((left, right) => (
      right.total - left.total
      || right.overdue - left.overdue
      || left.name.localeCompare(right.name, 'zh-Hans-CN')
    ))
    .slice(0, 8);
}

function buildRisks(items) {
  return items
    .map((item) => {
      const riskKinds = [];
      let score = 0;
      const highPriority = ['P0', 'P1'].includes(item.priority);

      if (
        item.active
        && item.assignees.length === 0
        && !(item.toolId === 'testTasks' && item.category === 'waiting')
      ) {
        riskKinds.push('unassigned');
        score = Math.max(score, 100);
      }
      if (item.overdue) {
        riskKinds.push('overdue');
        score = Math.max(score, highPriority ? 95 : 90);
      }
      if (item.dueSoon) {
        riskKinds.push('dueSoon');
        score = Math.max(score, highPriority ? 80 : 70);
      }
      if (item.stale) {
        riskKinds.push('stale');
        score = Math.max(score, 60);
      }
      if (item.missingAttachment) {
        riskKinds.push('missingAttachment');
        score = Math.max(score, 50);
      }
      if (item.category === 'waiting' && highPriority) {
        riskKinds.push('highPriority');
        score = Math.max(score, 40);
      }

      if (riskKinds.length === 0) {
        return null;
      }

      return {
        toolId: item.toolId,
        toolLabel: item.toolLabel,
        recordId: item.recordId,
        itemId: item.itemId,
        title: item.title,
        priority: item.priority,
        status: item.status,
        assignees: item.assignees,
        remainingDays: item.remainingDays,
        proposedAt: item.proposedAt,
        lastActivityAt: item.lastActivityAt,
        riskKinds,
        riskLabels: riskKinds.map((kind) => RISK_LABELS[kind]),
        score,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.score - left.score
      || compareNullableNumbers(left.remainingDays, right.remainingDays)
      || comparePriority(left.priority, right.priority)
      || compareNullableNumbers(left.proposedAt, right.proposedAt)
    ))
    .slice(0, 50);
}

function buildRecentActivity(items) {
  const activities = [];

  for (const item of items) {
    if (item.proposedAt) {
      const proposer = item.proposers[0] || {};
      activities.push({
        id: `created:${item.toolId}:${item.recordId}:${item.proposedAt}`,
        type: 'created',
        occurredAt: item.proposedAt,
        operatorName: proposer.name || '未知用户',
        toolId: item.toolId,
        toolLabel: item.toolLabel,
        recordId: item.recordId,
        itemId: item.itemId,
        title: item.title,
        text: `提交了${item.toolLabel}`,
      });
    }

    for (const change of item.statusChangeLog) {
      activities.push({
        id: `status:${item.toolId}:${item.recordId}:${change.id || change.changedAt}`,
        type: 'status',
        occurredAt: change.changedAt,
        operatorName: change.operatorName || '未知用户',
        toolId: item.toolId,
        toolLabel: item.toolLabel,
        recordId: item.recordId,
        itemId: item.itemId,
        title: item.title,
        text: `将处理状态从“${change.oldStatus || '未设置'}”变更为“${change.newStatus || '未设置'}”`,
      });
    }

    for (const comment of item.comments) {
      activities.push({
        id: `comment:${item.toolId}:${item.recordId}:${comment.id || comment.createdAt}`,
        type: 'comment',
        occurredAt: comment.createdAt,
        operatorName: comment.authorName || '未知用户',
        toolId: item.toolId,
        toolLabel: item.toolLabel,
        recordId: item.recordId,
        commentId: comment.id,
        itemId: item.itemId,
        title: item.title,
        text: comment.content || '添加了留言',
      });
    }
  }

  return activities
    .filter((activity) => activity.occurredAt > 0)
    .sort((left, right) => right.occurredAt - left.occurredAt)
    .slice(0, 20);
}

function getCategoryStatuses(items, category, groups) {
  const counts = new Map();
  for (const item of items) {
    if (item.category !== category) {
      continue;
    }
    counts.set(item.status, (counts.get(item.status) || 0) + 1);
  }

  const configuredOrder = [
    ...(groups[category] || []),
    ...[...counts.keys()].filter((status) => !(groups[category] || []).includes(status)),
  ];
  return configuredOrder
    .filter((status, index, values) => counts.has(status) && values.indexOf(status) === index)
    .map((name) => ({ name, count: counts.get(name) || 0 }));
}

function getStatusCategory(status, groups) {
  for (const category of ['waiting', 'processing', 'completed', 'blocked']) {
    if (groups[category].includes(status)) {
      return category;
    }
  }
  return 'other';
}

function isCompletedTransition(change, groups) {
  return groups.completed.includes(change.newStatus)
    && !groups.completed.includes(change.oldStatus);
}

function normalizeStatusGroups(value, fallback, toolId) {
  const groups = Object.fromEntries(['waiting', 'processing', 'completed', 'blocked'].map((key) => [
    key,
    normalizeStringArray(value?.[key], fallback[key]),
  ]));
  if (toolId === 'feedback') {
    const explicitStatuses = [
      FEEDBACK_STATUSES.waiting,
      FEEDBACK_STATUSES.convertedToRequirement,
      FEEDBACK_STATUSES.convertedToBug,
      FEEDBACK_STATUSES.replied,
    ];
    for (const key of ['waiting', 'processing', 'completed', 'blocked']) {
      groups[key] = groups[key].filter((status) => !explicitStatuses.includes(status));
    }
    groups.waiting = [...new Set([
      FEEDBACK_STATUSES.waiting,
      FEEDBACK_LEGACY_ACTIVE_STATUSES[0],
      ...groups.waiting,
    ])];
    groups.processing = [...new Set([
      FEEDBACK_LEGACY_ACTIVE_STATUSES[1],
      ...groups.processing,
    ])];
    groups.completed = [...new Set([
      FEEDBACK_STATUSES.convertedToRequirement,
      FEEDBACK_STATUSES.convertedToBug,
      FEEDBACK_STATUSES.replied,
      ...FEEDBACK_LEGACY_COMPLETED_STATUSES,
      ...groups.completed,
    ])];
    return groups;
  }
  const acceptanceStatus = getWorkItemAcceptanceStatus(toolId);
  if (!acceptanceStatus) {
    return groups;
  }

  for (const key of ['waiting', 'completed', 'blocked']) {
    groups[key] = groups[key].filter((status) => status !== acceptanceStatus);
  }
  groups.processing = [...new Set([...groups.processing, acceptanceStatus])];
  return groups;
}

function normalizeStringArray(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizePeople(value) {
  return (Array.isArray(value) ? value : [])
    .map((person) => ({
      openId: String(person?.openId || person?.open_id || person?.id || '').trim(),
      userId: String(person?.userId || person?.user_id || '').trim(),
      unionId: String(person?.unionId || person?.union_id || '').trim(),
      email: String(person?.email || '').trim(),
      name: String(person?.name || person?.en_name || '').trim(),
      avatarUrl: String(person?.avatarUrl || person?.avatar_url || '').trim(),
    }))
    .filter((person) => getPrimaryUserKey(person));
}

function normalizeComments(value) {
  return (Array.isArray(value) ? value : [])
    .map((comment) => ({
      id: String(comment?.id || '').trim(),
      authorName: String(comment?.authorName || comment?.author_name || '').trim(),
      createdAt: normalizeTimestamp(comment?.createdAt || comment?.created_at),
      content: String(comment?.content || '').trim(),
    }))
    .filter((comment) => comment.createdAt || comment.content);
}

function normalizeStatusChanges(value) {
  return (Array.isArray(value) ? value : [])
    .map((change) => ({
      id: String(change?.id || '').trim(),
      oldStatus: String(change?.oldStatus || change?.old_status || '').trim(),
      newStatus: String(change?.newStatus || change?.new_status || '').trim(),
      changedAt: normalizeTimestamp(change?.changedAt || change?.changed_at),
      operatorName: String(change?.operatorName || change?.operator_name || '').trim(),
    }))
    .filter((change) => change.changedAt || change.newStatus);
}

function normalizeUnavailableTools(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      toolId: String(item?.toolId || '').trim(),
      label: String(item?.label || TOOL_LABELS[item?.toolId] || '').trim(),
      reason: String(item?.reason || 'unavailable').trim(),
      message: String(item?.message || '').trim(),
    }))
    .filter((item) => item.toolId);
}

function buildUserKeySet(user) {
  return new Set([
    user?.openId,
    user?.open_id,
    user?.userId,
    user?.user_id,
    user?.unionId,
    user?.union_id,
    user?.email,
    user?.id,
    user?.name,
  ].map((item) => String(item || '').trim()).filter(Boolean));
}

function getPrimaryUserKey(user) {
  return [
    user?.openId,
    user?.open_id,
    user?.userId,
    user?.user_id,
    user?.unionId,
    user?.union_id,
    user?.email,
    user?.id,
    user?.name,
  ].map((item) => String(item || '').trim()).find(Boolean) || '';
}

function hasMatchingUser(people, wantedKeys) {
  if (wantedKeys.size === 0) {
    return false;
  }
  return (Array.isArray(people) ? people : []).some((person) => (
    [...buildUserKeySet(person)].some((key) => wantedKeys.has(key))
  ));
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function startOfShanghaiDay(value) {
  const shifted = new Date(Number(value) + SHANGHAI_OFFSET_MS);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - SHANGHAI_OFFSET_MS;
}

function startOfShanghaiWeek(value) {
  const dayStart = startOfShanghaiDay(value);
  const shifted = new Date(dayStart + SHANGHAI_OFFSET_MS);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  return dayStart - daysSinceMonday * DAY_MS;
}

function formatShanghaiDateKey(value) {
  return new Date(Number(value) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function comparePriority(left, right) {
  const leftIndex = PROJECT_OVERVIEW_PRIORITIES.indexOf(left);
  const rightIndex = PROJECT_OVERVIEW_PRIORITIES.indexOf(right);
  return (leftIndex === -1 ? PROJECT_OVERVIEW_PRIORITIES.length : leftIndex)
    - (rightIndex === -1 ? PROJECT_OVERVIEW_PRIORITIES.length : rightIndex);
}

function compareNullableNumbers(left, right) {
  const leftMissing = left === null || left === undefined || left === '';
  const rightMissing = right === null || right === undefined || right === '';
  if (leftMissing || rightMissing) {
    if (leftMissing !== rightMissing) {
      return leftMissing ? 1 : -1;
    }
    return 0;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftValid = Number.isFinite(leftNumber);
  const rightValid = Number.isFinite(rightNumber);
  if (leftValid && rightValid) {
    return leftNumber - rightNumber;
  }
  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return 0;
}
