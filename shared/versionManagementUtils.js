export const VERSION_MANAGEMENT_TOOL_ID = 'versions';

export const VERSION_STATUSES = Object.freeze([
  '测试开发',
  '测试发布',
  '正式发布',
  '过时',
]);

export const VERSION_ACTIVE_STATUSES = Object.freeze([
  '测试开发',
  '测试发布',
  '正式发布',
]);

export const VERSION_PLATFORMS = Object.freeze([
  'IGP',
  'Steam',
  '中国版',
  '无',
]);

export const VERSION_ASSOCIATION_TOOL_IDS = Object.freeze([
  'requirements',
  'bugs',
  'feedback',
]);

export const DEFAULT_VERSION_FIELD_NAMES = Object.freeze({
  versionNumber: '版本号',
  status: '状态',
  requirements: '已处理需求',
  bugs: '已处理Bug',
  feedback: '已处理反馈',
  statusHistory: '状态变动记录',
  comments: '留言',
  previousVersion: '上个版本',
  platform: '平台',
});

const VERSION_DOCUMENT_VERSION = 1;

export function normalizeVersionFieldNames(value = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_VERSION_FIELD_NAMES).map(([key, fallback]) => [
      key,
      String(value?.[key] || fallback).trim() || fallback,
    ]),
  );
}

export function canManageVersions({ isSuperAdmin, isDevelopmentSuperAdmin } = {}) {
  return Boolean(isSuperAdmin || isDevelopmentSuperAdmin);
}

export function normalizeVersionRecord(record, fieldNames = DEFAULT_VERSION_FIELD_NAMES) {
  const fields = record?.fields && typeof record.fields === 'object' ? record.fields : {};
  const names = normalizeVersionFieldNames(fieldNames);
  const recordId = String(record?.record_id || record?.recordId || record?.id || '').trim();
  const versionNumber = normalizeVersionCellText(fields[names.versionNumber]);
  const status = normalizeVersionCellText(fields[names.status]);
  const platform = normalizeVersionCellText(fields[names.platform]);
  const requirementsDocument = parseVersionAssociationDocument(fields[names.requirements]);
  const bugsDocument = parseVersionAssociationDocument(fields[names.bugs]);
  const feedbackDocument = parseVersionAssociationDocument(fields[names.feedback]);
  const previousVersionDocument = parsePreviousVersionDocument(fields[names.previousVersion]);
  const statusHistoryDocument = parseVersionStatusHistoryDocument(fields[names.statusHistory]);
  const commentsDocument = parseVersionCommentsDocument(fields[names.comments]);
  const warnings = [
    buildDocumentWarning(recordId, names.requirements, requirementsDocument),
    buildDocumentWarning(recordId, names.bugs, bugsDocument),
    buildDocumentWarning(recordId, names.feedback, feedbackDocument),
    buildDocumentWarning(recordId, names.previousVersion, previousVersionDocument),
    buildDocumentWarning(recordId, names.statusHistory, statusHistoryDocument),
    buildDocumentWarning(recordId, names.comments, commentsDocument),
  ].filter(Boolean);

  return {
    recordId,
    versionNumber,
    status,
    platform,
    requirements: requirementsDocument.items,
    bugs: bugsDocument.items,
    feedback: feedbackDocument.items,
    previousVersion: previousVersionDocument.item,
    statusHistory: statusHistoryDocument.items,
    comments: commentsDocument.items,
    warnings,
    parseErrors: {
      requirements: requirementsDocument.error,
      bugs: bugsDocument.error,
      feedback: feedbackDocument.error,
      previousVersion: previousVersionDocument.error,
      statusHistory: statusHistoryDocument.error,
      comments: commentsDocument.error,
    },
  };
}

export function isEmptyVersionRecord(version) {
  return !String(version?.versionNumber || '').trim();
}

export function parseVersionAssociationDocument(value, { throwOnInvalid = false } = {}) {
  return parseItemsDocument(value, normalizeAssociationSnapshot, {
    label: '版本关联工作项',
    throwOnInvalid,
  });
}

export function parsePreviousVersionDocument(value, { throwOnInvalid = false } = {}) {
  const text = normalizeVersionCellText(value).trim();
  if (!text) {
    return { version: VERSION_DOCUMENT_VERSION, item: null, error: '' };
  }

  try {
    const parsed = JSON.parse(text);
    const item = normalizePreviousVersionSnapshot(parsed?.item ?? parsed);
    if (!item) {
      throw new Error('上个版本字段缺少有效的版本记录ID');
    }
    return { version: VERSION_DOCUMENT_VERSION, item, error: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : '上个版本字段不是合法 JSON';
    if (throwOnInvalid) {
      throw new Error(message.includes('上个版本') ? message : '上个版本字段不是合法 JSON');
    }
    return { version: VERSION_DOCUMENT_VERSION, item: null, error: '上个版本字段不是合法 JSON' };
  }
}

export function parseVersionStatusHistoryDocument(value, { throwOnInvalid = false } = {}) {
  return parseItemsDocument(value, normalizeVersionStatusChange, {
    label: '状态变动记录',
    throwOnInvalid,
  });
}

export function parseVersionCommentsDocument(value, { throwOnInvalid = false } = {}) {
  return parseItemsDocument(value, normalizeVersionComment, {
    label: '留言',
    throwOnInvalid,
  });
}

export function serializeVersionItemsDocument(items) {
  return JSON.stringify({
    version: VERSION_DOCUMENT_VERSION,
    items: Array.isArray(items) ? items : [],
  });
}

export function serializePreviousVersionDocument(item) {
  return item
    ? JSON.stringify({ version: VERSION_DOCUMENT_VERSION, item })
    : '';
}

export function buildAssociationSnapshots(selectedRecordIds, candidates) {
  const candidateMap = new Map(
    (Array.isArray(candidates) ? candidates : [])
      .map((candidate) => [String(candidate?.recordId || '').trim(), candidate])
      .filter(([recordId]) => Boolean(recordId)),
  );
  const seen = new Set();
  const snapshots = [];

  for (const selectedRecordId of Array.isArray(selectedRecordIds) ? selectedRecordIds : []) {
    const recordId = String(selectedRecordId || '').trim();
    if (!recordId || seen.has(recordId)) {
      continue;
    }
    const candidate = candidateMap.get(recordId);
    if (!candidate || !candidate.completed) {
      throw new Error('只能关联当前已完成或已关闭的工作项');
    }
    seen.add(recordId);
    snapshots.push({
      recordId,
      itemId: String(candidate.itemId || '').trim(),
      title: String(candidate.title || '').trim() || '未命名工作项',
    });
  }

  return snapshots;
}

export function validateVersionIdentity({
  versions,
  recordId = '',
  versionNumber,
  platform,
}) {
  const normalizedNumber = String(versionNumber || '').trim();
  const normalizedPlatform = String(platform || '').trim();
  if (!normalizedNumber) {
    throw new Error('版本号不能为空');
  }
  if (normalizedNumber.length > 100) {
    throw new Error('版本号不能超过100字');
  }
  if (!VERSION_PLATFORMS.includes(normalizedPlatform)) {
    throw new Error('平台不在可选范围内');
  }

  const duplicate = (Array.isArray(versions) ? versions : []).find((version) => (
    version.recordId !== recordId
    && version.platform === normalizedPlatform
    && version.versionNumber.toLocaleLowerCase('zh-CN') === normalizedNumber.toLocaleLowerCase('zh-CN')
  ));
  if (duplicate) {
    throw new Error('同一平台内版本号不能重复');
  }
}

export function validateVersionStatus(status) {
  const normalizedStatus = String(status || '').trim();
  if (!VERSION_STATUSES.includes(normalizedStatus)) {
    throw new Error('版本状态不在可选范围内');
  }
  return normalizedStatus;
}

export function findActiveVersionConflict(versions, {
  recordId = '',
  platform,
  status,
}) {
  if (!VERSION_ACTIVE_STATUSES.includes(status)) {
    return null;
  }

  return (Array.isArray(versions) ? versions : []).find((version) => (
    version.recordId !== recordId
    && version.platform === platform
    && version.status === status
  )) || null;
}

export function validatePreviousVersionReference(versions, {
  recordId = '',
  previousRecordId = '',
}) {
  const normalizedPreviousId = String(previousRecordId || '').trim();
  if (!normalizedPreviousId) {
    return null;
  }
  if (normalizedPreviousId === recordId) {
    throw new Error('上个版本不能引用当前版本');
  }

  const source = Array.isArray(versions) ? versions : [];
  const previous = source.find((version) => version.recordId === normalizedPreviousId);
  if (!previous) {
    throw new Error('上个版本不存在');
  }

  const previousByRecordId = new Map(source.map((version) => [
    version.recordId,
    String(version.previousVersion?.recordId || '').trim(),
  ]));
  previousByRecordId.set(recordId, normalizedPreviousId);
  const visited = new Set();
  let currentId = recordId;
  while (currentId) {
    if (visited.has(currentId)) {
      throw new Error('上个版本引用不能形成循环');
    }
    visited.add(currentId);
    currentId = previousByRecordId.get(currentId) || '';
  }

  return {
    recordId: previous.recordId,
    versionNumber: previous.versionNumber,
    platform: previous.platform,
  };
}

export function buildVersionStatusChange({
  id,
  oldStatus = '',
  newStatus,
  changedAt,
  operator,
  reason,
  automatic = false,
}) {
  return {
    id: String(id || '').trim(),
    oldStatus: String(oldStatus || '').trim(),
    newStatus: validateVersionStatus(newStatus),
    changedAt: normalizeIsoDate(changedAt),
    operatorOpenId: String(operator?.openId || operator?.open_id || '').trim(),
    operatorName: String(operator?.name || operator?.openId || '系统').trim(),
    reason: String(reason || '').trim(),
    automatic: Boolean(automatic),
  };
}

export function buildVersionComment({
  id,
  author,
  content,
  mentionedUsers = [],
  createdAt,
}) {
  const normalizedContent = String(content || '').trim();
  if (!normalizedContent) {
    throw new Error('留言内容不能为空');
  }

  const users = normalizeMentionedUsers(mentionedUsers);
  return {
    id: String(id || '').trim(),
    authorOpenId: String(author?.openId || author?.open_id || '').trim(),
    authorName: String(author?.name || author?.openId || '').trim(),
    authorAvatarUrl: String(author?.avatarUrl || author?.avatar_url || '').trim(),
    createdAt: normalizeIsoDate(createdAt),
    content: normalizedContent,
    mentionedOpenIds: users.map((user) => user.openId),
    mentionedUsers: users,
  };
}

export function buildVersionOverview(versions, { recentLimit = 6 } = {}) {
  const normalizedVersions = (Array.isArray(versions) ? versions : [])
    .filter((version) => !isEmptyVersionRecord(version));
  const platforms = VERSION_PLATFORMS.map((platform) => ({
    platform,
    active: Object.fromEntries(VERSION_ACTIVE_STATUSES.map((status) => [
      status,
      toOverviewVersionSnapshot(
        normalizedVersions.find((version) => version.platform === platform && version.status === status),
      ),
    ])),
  }));
  const recentFormalReleases = normalizedVersions
    .flatMap((version) => version.statusHistory
      .filter((change) => change.newStatus === '正式发布')
      .map((change) => ({
        recordId: version.recordId,
        versionNumber: version.versionNumber,
        platform: version.platform,
        releasedAt: change.changedAt,
        operatorName: change.operatorName,
      })))
    .sort((left, right) => Date.parse(right.releasedAt) - Date.parse(left.releasedAt))
    .slice(0, Math.max(1, Number(recentLimit) || 6));

  return {
    initialized: true,
    platforms,
    recentFormalReleases,
  };
}

function toOverviewVersionSnapshot(version) {
  if (!version) {
    return null;
  }
  return {
    recordId: version.recordId,
    versionNumber: version.versionNumber,
    platform: version.platform,
    status: version.status,
  };
}

export function normalizeVersionCellText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeVersionCellText).filter(Boolean).join('');
  }
  if (typeof value === 'object') {
    return normalizeVersionCellText(
      value.text
      ?? value.name
      ?? value.value
      ?? value.label
      ?? value.link
      ?? '',
    );
  }
  return '';
}

function parseItemsDocument(value, itemNormalizer, { label, throwOnInvalid }) {
  const text = normalizeVersionCellText(value).trim();
  if (!text) {
    return { version: VERSION_DOCUMENT_VERSION, items: [], error: '' };
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.items)) {
      throw new Error(`${label}字段缺少 items 数组`);
    }
    return {
      version: VERSION_DOCUMENT_VERSION,
      items: parsed.items.map(itemNormalizer).filter(Boolean),
      error: '',
    };
  } catch {
    const message = `${label}字段不是合法 JSON`;
    if (throwOnInvalid) {
      throw new Error(message);
    }
    return { version: VERSION_DOCUMENT_VERSION, items: [], error: message };
  }
}

function normalizeAssociationSnapshot(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const recordId = String(item.recordId || item.record_id || '').trim();
  if (!recordId) {
    return null;
  }
  return {
    recordId,
    itemId: String(item.itemId || item.item_id || '').trim(),
    title: String(item.title || '').trim() || '未命名工作项',
  };
}

function normalizePreviousVersionSnapshot(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const recordId = String(item.recordId || item.record_id || '').trim();
  if (!recordId) {
    return null;
  }
  return {
    recordId,
    versionNumber: String(item.versionNumber || item.version_number || '').trim(),
    platform: String(item.platform || '').trim(),
  };
}

function normalizeVersionStatusChange(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const id = String(item.id || '').trim();
  const newStatus = String(item.newStatus || item.new_status || '').trim();
  const changedAt = normalizeIsoDate(item.changedAt || item.changed_at);
  if (!id || !newStatus || !changedAt) {
    return null;
  }
  return {
    id,
    oldStatus: String(item.oldStatus || item.old_status || '').trim(),
    newStatus,
    changedAt,
    operatorOpenId: String(item.operatorOpenId || item.operator_open_id || '').trim(),
    operatorName: String(item.operatorName || item.operator_name || '').trim() || '未知用户',
    reason: String(item.reason || item.message || '').trim(),
    automatic: Boolean(item.automatic),
  };
}

function normalizeVersionComment(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const id = String(item.id || '').trim();
  const authorOpenId = String(item.authorOpenId || item.author_open_id || '').trim();
  const content = String(item.content || '').trim();
  const createdAt = normalizeIsoDate(item.createdAt || item.created_at);
  if (!id || !authorOpenId || !content || !createdAt) {
    return null;
  }
  const mentionedUsers = normalizeMentionedUsers(item.mentionedUsers || item.mentioned_users || []);
  return {
    id,
    authorOpenId,
    authorName: String(item.authorName || item.author_name || '').trim(),
    authorAvatarUrl: String(item.authorAvatarUrl || item.author_avatar_url || '').trim(),
    createdAt,
    content,
    mentionedOpenIds: [...new Set(
      [
        ...(Array.isArray(item.mentionedOpenIds) ? item.mentionedOpenIds : []),
        ...(Array.isArray(item.mentioned_open_ids) ? item.mentioned_open_ids : []),
        ...mentionedUsers.map((user) => user.openId),
      ].map((openId) => String(openId || '').trim()).filter(Boolean),
    )],
    mentionedUsers,
  };
}

function normalizeMentionedUsers(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      openId: String(item?.openId || item?.open_id || item?.id || '').trim(),
      name: String(item?.name || item?.openId || item?.open_id || '').trim(),
      avatarUrl: String(item?.avatarUrl || item?.avatar_url || '').trim(),
    }))
    .filter((item) => item.openId && !seen.has(item.openId) && seen.add(item.openId))
    .slice(0, 20);
}

function normalizeIsoDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function buildDocumentWarning(recordId, fieldName, document) {
  if (!document?.error) {
    return '';
  }
  return `${recordId || '未知记录'} 的“${fieldName}”${document.error.replace(`${fieldName}字段`, '字段')}`;
}
