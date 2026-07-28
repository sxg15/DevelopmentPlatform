import {
  WORK_ITEM_ACCEPTANCE_STATUS,
  getWorkItemProcessingStatuses as getSharedWorkItemProcessingStatuses,
} from '../../shared/workItemDefinitions.js';

const DEFAULT_EXPANDED_STATUSES = {
  requirements: new Set(['待处理', ...getSharedWorkItemProcessingStatuses('requirements')]),
  bugs: new Set(['未处理', ...getSharedWorkItemProcessingStatuses('bugs')]),
  feedback: new Set(['待处理', '处理中']),
};

const STATUS_ORDERS = {
  requirements: ['待处理', '处理中', WORK_ITEM_ACCEPTANCE_STATUS, '已完成', '已搁置', '已拒绝', '已处理', '关闭', '未设置状态'],
  bugs: ['未处理', '修复中', WORK_ITEM_ACCEPTANCE_STATUS, '已修复', '无法复现', '已搁置', '关闭', '未设置状态'],
  feedback: ['待处理', '处理中', '已完成', '已搁置', '已拒绝', '未设置状态'],
};

export const DEADLINE_FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'no-deadline', label: '未设置时限' },
  { value: 'remaining', label: '剩余 1 天以上' },
  { value: 'urgent', label: '1 天内到期' },
  { value: 'overdue', label: '已逾期' },
];

export function createEmptyWorkItemFilters() {
  return {
    query: '',
    statuses: [],
    priorities: [],
    assigneeKeys: [],
    proposerKeys: [],
    deadline: 'all',
    dateFrom: '',
    dateTo: '',
  };
}

export function getWorkItemStatus(item) {
  return String(item?.itemStatus || item?.requirementStatus || '未设置状态').trim() || '未设置状态';
}

export function isStatusGroupDefaultCollapsed(toolId, status) {
  const expandedStatuses = DEFAULT_EXPANDED_STATUSES[String(toolId || '').trim()] || new Set();
  return !expandedStatuses.has(String(status || '').trim());
}

export function compareWorkItemStatus(toolId, left, right) {
  const order = STATUS_ORDERS[String(toolId || '').trim()] || [];
  const leftStatus = String(left || '').trim();
  const rightStatus = String(right || '').trim();
  const leftIndex = order.indexOf(leftStatus);
  const rightIndex = order.indexOf(rightStatus);

  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex);
  }

  return leftStatus.localeCompare(rightStatus, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

export function isWorkItemWaitingForTime(toolId, item) {
  return getWorkItemStatus(item) === getWorkItemWaitingStatus(toolId);
}

export function getWorkItemWaitingStatus(toolId) {
  return String(toolId || '').trim() === 'bugs' ? '未处理' : '待处理';
}

export function getWorkItemProcessingStatus(toolId) {
  return getWorkItemProcessingStatuses(toolId)[0] || '处理中';
}

export function getWorkItemProcessingStatuses(toolId) {
  return getSharedWorkItemProcessingStatuses(toolId);
}

export function shouldShowWorkItemRemainingTime(toolId, item) {
  const expectedDays = Number(item?.expectedDays);
  const remainingDays = Number(item?.remainingDays);
  return isWorkItemWaitingForTime(toolId, item)
    && Number.isFinite(expectedDays)
    && expectedDays > 0
    && Number.isFinite(remainingDays);
}

export function getWorkItemDeadlineState(item) {
  const expectedDays = Number(item?.expectedDays);
  const remainingDays = Number(item?.remainingDays);
  if (!Number.isFinite(expectedDays) || expectedDays <= 0 || !Number.isFinite(remainingDays)) {
    return 'no-deadline';
  }

  if (remainingDays < 0) {
    return 'overdue';
  }

  if (remainingDays < 1) {
    return 'urgent';
  }

  return 'remaining';
}

export function getWorkItemPersonKey(person) {
  return String(
    person?.openId
      || person?.open_id
      || person?.unionId
      || person?.union_id
      || person?.userId
      || person?.user_id
      || person?.email
      || person?.id
      || person?.name
      || '',
  ).trim();
}

export function filterWorkItems(items, filters = createEmptyWorkItemFilters()) {
  const normalizedFilters = {
    ...createEmptyWorkItemFilters(),
    ...filters,
  };
  const query = String(normalizedFilters.query || '').trim().toLocaleLowerCase('zh-CN');
  const statuses = new Set(normalizedFilters.statuses || []);
  const priorities = new Set(normalizedFilters.priorities || []);
  const assigneeKeys = new Set(normalizedFilters.assigneeKeys || []);
  const proposerKeys = new Set(normalizedFilters.proposerKeys || []);
  const deadline = String(normalizedFilters.deadline || 'all');
  const dateFrom = parseDateBoundary(normalizedFilters.dateFrom, false);
  const dateTo = parseDateBoundary(normalizedFilters.dateTo, true);

  return (Array.isArray(items) ? items : []).filter((item) => {
    if (query && !buildSearchText(item).includes(query)) {
      return false;
    }

    if (statuses.size > 0 && !statuses.has(getWorkItemStatus(item))) {
      return false;
    }

    if (priorities.size > 0 && !priorities.has(String(item?.priority || '').trim())) {
      return false;
    }

    if (assigneeKeys.size > 0 && !hasPersonMatch(item?.assignees, assigneeKeys)) {
      return false;
    }

    if (proposerKeys.size > 0 && !hasPersonMatch(item?.proposers, proposerKeys)) {
      return false;
    }

    if (deadline !== 'all' && getWorkItemDeadlineState(item) !== deadline) {
      return false;
    }

    const proposedAt = Number(item?.proposedAt);
    if (dateFrom !== null && (!Number.isFinite(proposedAt) || proposedAt < dateFrom)) {
      return false;
    }

    if (dateTo !== null && (!Number.isFinite(proposedAt) || proposedAt > dateTo)) {
      return false;
    }

    return true;
  });
}

export function hasActiveWorkItemFilters(filters) {
  const normalizedFilters = {
    ...createEmptyWorkItemFilters(),
    ...filters,
  };
  return Boolean(
    String(normalizedFilters.query || '').trim()
    || hasActiveAdvancedWorkItemFilters(normalizedFilters),
  );
}

export function hasActiveAdvancedWorkItemFilters(filters) {
  const normalizedFilters = {
    ...createEmptyWorkItemFilters(),
    ...filters,
  };
  return Boolean(
    (normalizedFilters.statuses || []).length
    || (normalizedFilters.priorities || []).length
    || (normalizedFilters.assigneeKeys || []).length
    || (normalizedFilters.proposerKeys || []).length
    || normalizedFilters.deadline !== 'all'
    || normalizedFilters.dateFrom
    || normalizedFilters.dateTo,
  );
}

function buildSearchText(item) {
  return [
    item?.itemId,
    item?.feedbackId,
    item?.bugId,
    item?.requirementId,
    item?.title,
    item?.description,
    item?.channel,
  ]
    .map((value) => String(value || '').toLocaleLowerCase('zh-CN'))
    .join('\n');
}

function hasPersonMatch(people, wantedKeys) {
  return (Array.isArray(people) ? people : []).some((person) => wantedKeys.has(getWorkItemPersonKey(person)));
}

function parseDateBoundary(value, endOfDay) {
  const matched = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) {
    return null;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  const timestamp = new Date(year, month, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
