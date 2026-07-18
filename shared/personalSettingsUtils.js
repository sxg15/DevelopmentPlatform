import {
  getWorkItemStatus,
  isWorkItemAssignedToUser,
} from './workItemRealtimeUtils.js';

export const DEFAULT_TODO_NOTIFICATION_TIME = '11:00';
export const DEFAULT_TODO_NOTIFICATION_TIME_ZONE = 'Asia/Shanghai';
export const TODO_NOTIFICATION_DISPLAY_LIMIT = 10;

export function isValidTodoNotificationTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}

export function normalizeTodoNotificationTime(
  value,
  fallback = DEFAULT_TODO_NOTIFICATION_TIME,
  timeZone = DEFAULT_TODO_NOTIFICATION_TIME_ZONE,
) {
  if (Array.isArray(value)) {
    return normalizeTodoNotificationTime(value[0], fallback, timeZone);
  }

  if (value && typeof value === 'object') {
    return normalizeTodoNotificationTime(
      value.value ?? value.text ?? value.timestamp ?? value.date ?? '',
      fallback,
      timeZone,
    );
  }

  const text = String(value ?? '').trim();
  if (isValidTodoNotificationTime(text)) {
    return text;
  }

  const timestamp = normalizeTimestamp(value);
  if (timestamp > 0) {
    return formatTimeInTimeZone(timestamp, timeZone);
  }

  return isValidTodoNotificationTime(fallback)
    ? String(fallback).trim()
    : DEFAULT_TODO_NOTIFICATION_TIME;
}

export function normalizePersonalNotificationSettings(value, options = {}) {
  const source = value?.notifications || value || {};
  return {
    receiveTodoNotifications: source.receiveTodoNotifications === true,
    todoNotificationTime: normalizeTodoNotificationTime(
      source.todoNotificationTime,
      options.defaultTime,
      options.timeZone,
    ),
  };
}

export function getZonedDateTimeParts(
  value = new Date(),
  timeZone = DEFAULT_TODO_NOTIFICATION_TIME_ZONE,
) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('无效的通知检查时间');
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function isTodoNotificationDue(settings, value = new Date(), timeZone) {
  const normalized = normalizePersonalNotificationSettings(settings, { timeZone });
  if (!normalized.receiveTodoNotifications) {
    return false;
  }

  return getZonedDateTimeParts(value, timeZone).time === normalized.todoNotificationTime;
}

export function buildTodoNotificationDedupeKey(user, value = new Date(), timeZone) {
  const userKey = [
    user?.openId,
    user?.open_id,
    user?.userId,
    user?.user_id,
    user?.id,
    user?.email,
    user?.name,
  ].map((item) => String(item || '').trim()).find(Boolean);
  const { dateKey } = getZonedDateTimeParts(value, timeZone);
  return `${userKey || 'unknown'}|${dateKey}`;
}

export function collectPendingTodoNotificationItems(sources, user, statusGroups = {}) {
  const result = [];

  for (const source of Array.isArray(sources) ? sources : []) {
    const toolId = String(source?.toolId || '').trim();
    const completedStatuses = new Set(
      (Array.isArray(statusGroups?.[toolId]?.completed) ? statusGroups[toolId].completed : [])
        .map((status) => String(status || '').trim())
        .filter(Boolean),
    );

    for (const item of Array.isArray(source?.items) ? source.items : []) {
      const status = getWorkItemStatus(item);
      if (!isWorkItemAssignedToUser(item, user) || completedStatuses.has(status)) {
        continue;
      }

      result.push({
        toolId,
        projectId: String(source?.project?.projectId || '').trim(),
        projectName: String(source?.project?.projectName || '未命名项目').trim() || '未命名项目',
        recordId: String(item?.recordId || '').trim(),
        itemId: String(item?.itemId || '').trim(),
        title: String(item?.title || '未命名事项').trim() || '未命名事项',
        status,
        remainingDays: normalizeNullableNumber(item?.remainingDays),
        proposedAt: normalizeTimestamp(item?.proposedAt),
      });
    }
  }

  return result.sort(compareTodoNotificationItems);
}

export function summarizeTodoNotificationItems(items, displayLimit = TODO_NOTIFICATION_DISPLAY_LIMIT) {
  const source = Array.isArray(items) ? items : [];
  const counts = {
    requirements: 0,
    bugs: 0,
    feedback: 0,
  };

  for (const item of source) {
    if (Object.hasOwn(counts, item?.toolId)) {
      counts[item.toolId] += 1;
    }
  }

  const limit = Math.max(1, Number(displayLimit) || TODO_NOTIFICATION_DISPLAY_LIMIT);
  return {
    total: source.length,
    counts,
    displayedItems: source.slice(0, limit),
    hiddenCount: Math.max(0, source.length - limit),
  };
}

function compareTodoNotificationItems(left, right) {
  const leftRemaining = getSortableRemainingDays(left?.remainingDays);
  const rightRemaining = getSortableRemainingDays(right?.remainingDays);
  if (leftRemaining !== rightRemaining) {
    return leftRemaining - rightRemaining;
  }

  const leftProposedAt = normalizeTimestamp(left?.proposedAt) || Number.MAX_SAFE_INTEGER;
  const rightProposedAt = normalizeTimestamp(right?.proposedAt) || Number.MAX_SAFE_INTEGER;
  if (leftProposedAt !== rightProposedAt) {
    return leftProposedAt - rightProposedAt;
  }

  return String(left?.title || '').localeCompare(String(right?.title || ''), 'zh-CN');
}

function getSortableRemainingDays(value) {
  const number = normalizeNullableNumber(value);
  return number === null ? Number.MAX_SAFE_INTEGER : number;
}

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number < 10_000_000_000 ? number * 1000 : number;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTimeInTimeZone(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}
