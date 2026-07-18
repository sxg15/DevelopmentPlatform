export const WORK_ITEM_TIMELINE_PAGE_SIZE = 20;

export const WORK_ITEM_TIMELINE_FILTERS = Object.freeze([
  { id: 'all', label: '全部动态' },
  { id: 'key', label: '关键变动' },
  { id: 'comments', label: '留言' },
]);

export const WORK_ITEM_TIMELINE_EVENT_TYPES = Object.freeze({
  CREATED: 'created',
  STATUS_CHANGED: 'status-changed',
  ASSIGNEE_CHANGED: 'assignee-changed',
  ATTACHMENTS_CHANGED: 'attachments-changed',
  COMMENT_ADDED: 'comment-added',
});

const ASSIGNEE_CHANGE_PREFIX = '变更处理人：';
const ATTACHMENT_CHANGE_PREFIX = '提交附件变动：';

export function buildWorkItemTimelineEvents(toolConfig, record) {
  const source = record && typeof record === 'object' ? record : {};
  const itemLabel = String(toolConfig?.itemLabel || '事项').trim() || '事项';
  const events = [];
  let sourceOrder = 0;

  const createdAt = normalizeWorkItemTimelineTimestamp(source.proposedAt);
  if (createdAt) {
    const proposer = Array.isArray(source.proposers) ? source.proposers[0] : null;
    const actorName = getTimelineActorName(proposer);
    events.push({
      id: buildTimelineEventId('created', source.recordId || source.itemId, createdAt),
      type: WORK_ITEM_TIMELINE_EVENT_TYPES.CREATED,
      category: 'key',
      occurredAt: createdAt,
      actorName,
      title: `创建${itemLabel}`,
      summary: `${actorName}提交了${itemLabel}`,
      detail: '',
      sourceOrder: sourceOrder++,
    });
  }

  for (const change of normalizeTimelineArray(source.statusChangeLog)) {
    const occurredAt = normalizeWorkItemTimelineTimestamp(change?.changedAt);
    const newStatus = normalizeTimelineText(change?.newStatus);
    if (!occurredAt || !newStatus) {
      continue;
    }

    const actorName = getTimelineActorName({
      name: change?.operatorName,
      openId: change?.operatorOpenId,
    });
    events.push({
      id: buildTimelineEventId('status', change?.id, occurredAt, sourceOrder),
      type: WORK_ITEM_TIMELINE_EVENT_TYPES.STATUS_CHANGED,
      category: 'key',
      occurredAt,
      actorName,
      title: '处理状态变更',
      summary: `${actorName}变更了处理状态`,
      detail: normalizeTimelineText(change?.message),
      oldStatus: normalizeTimelineText(change?.oldStatus) || '未设置',
      newStatus,
      sourceOrder: sourceOrder++,
    });
  }

  for (const comment of normalizeTimelineArray(source.comments)) {
    const occurredAt = normalizeWorkItemTimelineTimestamp(comment?.createdAt);
    const content = normalizeTimelineText(comment?.content);
    if (!occurredAt || !content) {
      continue;
    }

    const classified = classifyWorkItemTimelineComment(content);
    const actorName = getTimelineActorName({
      name: comment?.authorName,
      openId: comment?.authorOpenId,
    });
    events.push({
      id: buildTimelineEventId('comment', comment?.id, occurredAt, sourceOrder),
      type: classified.type,
      category: classified.type === WORK_ITEM_TIMELINE_EVENT_TYPES.COMMENT_ADDED ? 'comments' : 'key',
      occurredAt,
      actorName,
      authorAvatarUrl: normalizeTimelineText(comment?.authorAvatarUrl),
      title: classified.title,
      summary: buildCommentEventSummary(classified.type, actorName),
      detail: classified.detail,
      sourceOrder: sourceOrder++,
    });
  }

  return sortWorkItemTimelineEvents(events);
}

export function classifyWorkItemTimelineComment(content) {
  const normalizedContent = normalizeTimelineText(content);

  if (normalizedContent.startsWith(ASSIGNEE_CHANGE_PREFIX)) {
    return {
      type: WORK_ITEM_TIMELINE_EVENT_TYPES.ASSIGNEE_CHANGED,
      title: '处理人变更',
      detail: normalizedContent.slice(ASSIGNEE_CHANGE_PREFIX.length).trim() || '处理人发生了变更',
    };
  }

  if (normalizedContent.startsWith(ATTACHMENT_CHANGE_PREFIX)) {
    return {
      type: WORK_ITEM_TIMELINE_EVENT_TYPES.ATTACHMENTS_CHANGED,
      title: '提交附件变更',
      detail: normalizedContent.slice(ATTACHMENT_CHANGE_PREFIX.length).trim() || '提交附件发生了变更',
    };
  }

  return {
    type: WORK_ITEM_TIMELINE_EVENT_TYPES.COMMENT_ADDED,
    title: '留言',
    detail: normalizedContent,
  };
}

export function filterWorkItemTimelineEvents(events, filterId = 'all') {
  const normalizedEvents = normalizeTimelineArray(events);
  if (filterId === 'key') {
    return normalizedEvents.filter((event) => event?.category === 'key');
  }
  if (filterId === 'comments') {
    return normalizedEvents.filter((event) => event?.category === 'comments');
  }
  return [...normalizedEvents];
}

export function sliceWorkItemTimelineEvents(events, visibleCount = WORK_ITEM_TIMELINE_PAGE_SIZE) {
  const normalizedCount = Number.isFinite(Number(visibleCount))
    ? Math.max(0, Math.floor(Number(visibleCount)))
    : WORK_ITEM_TIMELINE_PAGE_SIZE;
  return normalizeTimelineArray(events).slice(0, normalizedCount);
}

export function sortWorkItemTimelineEvents(events) {
  return normalizeTimelineArray(events)
    .map((event, stableIndex) => ({ event, stableIndex }))
    .sort((left, right) => (
      Number(right.event?.occurredAt || 0) - Number(left.event?.occurredAt || 0)
      || Number(left.event?.sourceOrder ?? left.stableIndex) - Number(right.event?.sourceOrder ?? right.stableIndex)
      || left.stableIndex - right.stableIndex
    ))
    .map(({ event }) => event);
}

export function normalizeWorkItemTimelineTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    const timestamp = value < 10000000000 ? value * 1000 : value;
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numericValue = Number(trimmed);
    if (Number.isFinite(numericValue)) {
      return normalizeWorkItemTimelineTimestamp(numericValue);
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  if (Array.isArray(value)) {
    return normalizeWorkItemTimelineTimestamp(value[0]);
  }

  if (typeof value === 'object') {
    return normalizeWorkItemTimelineTimestamp(value.timestamp || value.date || value.value || value.text);
  }

  return null;
}

export function formatWorkItemTimelineDateTime(timestamp) {
  const normalizedTimestamp = normalizeWorkItemTimelineTimestamp(timestamp);
  if (!normalizedTimestamp) {
    return '';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(normalizedTimestamp));
}

function buildCommentEventSummary(type, actorName) {
  if (type === WORK_ITEM_TIMELINE_EVENT_TYPES.ASSIGNEE_CHANGED) {
    return `${actorName}变更了处理人`;
  }
  if (type === WORK_ITEM_TIMELINE_EVENT_TYPES.ATTACHMENTS_CHANGED) {
    return `${actorName}变更了提交附件`;
  }
  return `${actorName}添加了留言`;
}

function getTimelineActorName(person) {
  return normalizeTimelineText(
    person?.name
    || person?.enName
    || person?.openId
    || person?.open_id
    || person?.id,
  ) || '未知用户';
}

function buildTimelineEventId(prefix, sourceId, occurredAt, fallbackIndex = 0) {
  const normalizedSourceId = normalizeTimelineText(sourceId);
  return `${prefix}:${normalizedSourceId || `${occurredAt}:${fallbackIndex}`}`;
}

function normalizeTimelineArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeTimelineText(value) {
  return String(value || '').trim();
}
