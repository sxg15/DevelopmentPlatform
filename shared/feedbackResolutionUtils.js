import { FEEDBACK_STATUSES } from './workItemDefinitions.js';

export const FEEDBACK_RESOLUTION_TYPES = Object.freeze({
  requirements: 'requirements',
  bugs: 'bugs',
  reply: 'reply',
});

export const FEEDBACK_RESOLUTION_FINAL_STATUSES = Object.freeze({
  [FEEDBACK_RESOLUTION_TYPES.requirements]: FEEDBACK_STATUSES.convertedToRequirement,
  [FEEDBACK_RESOLUTION_TYPES.bugs]: FEEDBACK_STATUSES.convertedToBug,
  [FEEDBACK_RESOLUTION_TYPES.reply]: FEEDBACK_STATUSES.replied,
});

export function getFeedbackResolutionStatus(type) {
  return FEEDBACK_RESOLUTION_FINAL_STATUSES[String(type || '').trim()] || '';
}

export function normalizeFeedbackRelatedItemDocument(value) {
  const parsed = parseVersionedDocument(value);
  if (!parsed.present) {
    return {
      version: 1,
      type: '',
      recordId: '',
      itemId: '',
      title: '',
      linkedAt: 0,
      linkedBy: null,
      error: '',
    };
  }

  const type = String(parsed.value?.type || '').trim();
  const recordId = String(parsed.value?.recordId || '').trim();
  const itemId = String(parsed.value?.itemId || '').trim();
  const title = String(parsed.value?.title || '').trim();
  const linkedAt = normalizeTimestamp(parsed.value?.linkedAt);
  const linkedBy = normalizePerson(parsed.value?.linkedBy);
  const validationError = !Object.values(FEEDBACK_RESOLUTION_TYPES).slice(0, 2).includes(type)
    ? '关联项类型无效'
    : !recordId
      ? '关联项缺少记录 ID'
      : !itemId
        ? '关联项缺少工作项 ID'
        : !linkedAt
          ? '关联项缺少关联时间'
          : '';

  return {
    version: 1,
    type,
    recordId,
    itemId,
    title,
    linkedAt,
    linkedBy,
    error: parsed.error || validationError,
  };
}

export function normalizeRelatedFeedbackDocument(value) {
  const parsed = parseVersionedDocument(value);
  if (!parsed.present) {
    return {
      version: 1,
      recordId: '',
      feedbackId: '',
      title: '',
      proposers: [],
      linkedAt: 0,
      linkedBy: null,
      error: '',
    };
  }

  const recordId = String(parsed.value?.recordId || '').trim();
  const feedbackId = String(parsed.value?.feedbackId || '').trim();
  const title = String(parsed.value?.title || '').trim();
  const proposers = normalizePeople(parsed.value?.proposers);
  const linkedAt = normalizeTimestamp(parsed.value?.linkedAt);
  const linkedBy = normalizePerson(parsed.value?.linkedBy);
  const validationError = !recordId
    ? '关联反馈缺少记录 ID'
    : !feedbackId
      ? '关联反馈缺少反馈 ID'
      : !linkedAt
        ? '关联反馈缺少关联时间'
        : '';

  return {
    version: 1,
    recordId,
    feedbackId,
    title,
    proposers,
    linkedAt,
    linkedBy,
    error: parsed.error || validationError,
  };
}

export function createFeedbackRelatedItemDocument({
  type,
  recordId,
  itemId,
  title,
  linkedAt = Date.now(),
  linkedBy,
}) {
  const document = normalizeFeedbackRelatedItemDocument({
    version: 1,
    type,
    recordId,
    itemId,
    title,
    linkedAt,
    linkedBy,
  });
  if (document.error) {
    throw new Error(document.error);
  }
  return stripDocumentError(document);
}

export function createRelatedFeedbackDocument({
  recordId,
  feedbackId,
  title,
  proposers,
  linkedAt = Date.now(),
  linkedBy,
}) {
  const document = normalizeRelatedFeedbackDocument({
    version: 1,
    recordId,
    feedbackId,
    title,
    proposers,
    linkedAt,
    linkedBy,
  });
  if (document.error) {
    throw new Error(document.error);
  }
  return stripDocumentError(document);
}

export function serializeFeedbackResolutionDocument(document) {
  return JSON.stringify(stripDocumentError(document));
}

function parseVersionedDocument(value) {
  const text = normalizeBitableTextValue(value);
  if (!text) {
    return { value: {}, error: '', present: false };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && !isBitableTextFragment(value)) {
    if (Number(value.version || 1) !== 1) {
      return {
        value,
        error: `不支持的 JSON 文档版本：${value.version}`,
        present: true,
      };
    }
    return { value, error: '', present: true };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: {}, error: 'JSON 文档必须是对象', present: true };
    }
    if (Number(parsed.version || 1) !== 1) {
      return {
        value: parsed,
        error: `不支持的 JSON 文档版本：${parsed.version}`,
        present: true,
      };
    }
    return { value: parsed, error: '', present: true };
  } catch {
    return { value: {}, error: 'JSON 文档格式错误', present: true };
  }
}

function normalizeBitableTextValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeBitableTextValue).join('');
  }
  if (value && typeof value === 'object') {
    if (!isBitableTextFragment(value)) {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return normalizeBitableTextValue(value.text ?? value.value ?? '');
  }
  return String(value ?? '').trim();
}

function isBitableTextFragment(value) {
  return Object.hasOwn(value, 'text') || Object.hasOwn(value, 'value');
}

function normalizePeople(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizePerson)
    .filter(Boolean);
}

function normalizePerson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const person = {
    openId: String(value.openId || value.open_id || '').trim(),
    userId: String(value.userId || value.user_id || '').trim(),
    unionId: String(value.unionId || value.union_id || '').trim(),
    email: String(value.email || '').trim(),
    name: String(value.name || '').trim(),
  };
  return Object.values(person).some(Boolean) ? person : null;
}

function normalizeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function stripDocumentError(document) {
  const { error: _error, ...value } = document || {};
  return value;
}
