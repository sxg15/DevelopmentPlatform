import {
  VERSION_PLATFORMS,
  VERSION_STATUSES,
} from '../../../shared/versionManagementUtils.js';

export function normalizeVersionManagementPayload(value) {
  const source = isRecord(value) ? value : {};
  const versions = normalizeObjectArray(source.versions)
    .map(normalizeVersion)
    .filter((version) => version.recordId && version.versionNumber);
  return {
    status: normalizeText(source.status),
    created: Boolean(source.created),
    versions,
    statusOptions: normalizeTextArray(source.statusOptions, VERSION_STATUSES),
    platformOptions: normalizeTextArray(source.platformOptions, VERSION_PLATFORMS),
    completedWorkItems: Object.fromEntries(
      ['requirements', 'bugs', 'feedback'].map((toolId) => [
        toolId,
        normalizeObjectArray(source.completedWorkItems?.[toolId]).map((item) => ({
          recordId: normalizeText(item.recordId),
          itemId: normalizeText(item.itemId),
          title: normalizeText(item.title, '未命名工作项'),
          status: normalizeText(item.status),
        })).filter((item) => item.recordId),
      ]),
    ),
    mentionableUsers: normalizePeople(source.mentionableUsers),
    canManageVersions: Boolean(source.canManageVersions),
    warnings: normalizeTextArray(source.warnings),
  };
}

export function normalizeVersion(value) {
  const source = isRecord(value) ? value : {};
  return {
    recordId: normalizeText(source.recordId),
    versionNumber: normalizeText(source.versionNumber, '未命名版本'),
    status: normalizeText(source.status, '未设置状态'),
    platform: normalizeText(source.platform, '未设置平台'),
    requirements: normalizeSnapshots(source.requirements),
    bugs: normalizeSnapshots(source.bugs),
    feedback: normalizeSnapshots(source.feedback),
    previousVersion: isRecord(source.previousVersion)
      ? {
          recordId: normalizeText(source.previousVersion.recordId),
          versionNumber: normalizeText(source.previousVersion.versionNumber, '未命名版本'),
          platform: normalizeText(source.previousVersion.platform),
        }
      : null,
    statusHistory: normalizeObjectArray(source.statusHistory).map((item, index) => ({
      id: normalizeText(item.id, `history-${index}`),
      oldStatus: normalizeText(item.oldStatus),
      newStatus: normalizeText(item.newStatus, '未设置状态'),
      changedAt: normalizeText(item.changedAt),
      operatorOpenId: normalizeText(item.operatorOpenId),
      operatorName: normalizeText(item.operatorName, '未知用户'),
      reason: normalizeText(item.reason),
      automatic: Boolean(item.automatic),
    })),
    comments: normalizeObjectArray(source.comments).map((item, index) => ({
      id: normalizeText(item.id, `comment-${index}`),
      authorOpenId: normalizeText(item.authorOpenId),
      authorName: normalizeText(item.authorName, '未知用户'),
      authorAvatarUrl: normalizeText(item.authorAvatarUrl),
      createdAt: normalizeText(item.createdAt),
      content: normalizeText(item.content),
      mentionedUsers: normalizePeople(item.mentionedUsers),
    })).filter((item) => item.content),
    warnings: normalizeTextArray(source.warnings),
    parseErrors: isRecord(source.parseErrors) ? source.parseErrors : {},
  };
}

export function mergeVersionPayload(current, payload) {
  const next = normalizeVersionManagementPayload({
    ...current,
    ...payload,
    completedWorkItems: payload?.completedWorkItems || current?.completedWorkItems,
    mentionableUsers: payload?.mentionableUsers || current?.mentionableUsers,
    canManageVersions: payload?.canManageVersions ?? current?.canManageVersions,
  });
  if (!Array.isArray(payload?.versions) && payload?.version) {
    const version = normalizeVersion(payload.version);
    next.versions = [
      ...next.versions
        .filter((item) => item.recordId !== version.recordId),
      version,
    ].sort((left, right) => left.versionNumber.localeCompare(right.versionNumber, 'zh-Hans-CN', {
      numeric: true,
    }));
  }
  return next;
}

export function filterVersions(versions, { search = '', platform = 'all', status = 'all' } = {}) {
  const keyword = String(search || '').trim().toLocaleLowerCase('zh-CN');
  return (Array.isArray(versions) ? versions : [])
    .filter((version) => platform === 'all' || version.platform === platform)
    .filter((version) => status === 'all' || version.status === status)
    .filter((version) => !keyword || [
      version.versionNumber,
      version.platform,
      version.status,
      ...version.requirements.map((item) => `${item.itemId} ${item.title}`),
      ...version.bugs.map((item) => `${item.itemId} ${item.title}`),
      ...version.feedback.map((item) => `${item.itemId} ${item.title}`),
    ].join(' ').toLocaleLowerCase('zh-CN').includes(keyword))
    .sort(compareVersions);
}

export function buildActiveVersionMatrix(versions, platforms, statuses) {
  return (Array.isArray(platforms) ? platforms : VERSION_PLATFORMS).map((platform) => ({
    platform,
    slots: Object.fromEntries((Array.isArray(statuses) ? statuses : VERSION_STATUSES)
      .filter((status) => status !== '过时')
      .map((status) => [
        status,
        (Array.isArray(versions) ? versions : []).find(
          (version) => version.platform === platform && version.status === status,
        ) || null,
      ])),
  }));
}

function compareVersions(left, right) {
  const leftTime = Math.max(
    0,
    ...left.statusHistory.map((item) => Date.parse(item.changedAt) || 0),
  );
  const rightTime = Math.max(
    0,
    ...right.statusHistory.map((item) => Date.parse(item.changedAt) || 0),
  );
  return rightTime - leftTime
    || left.platform.localeCompare(right.platform, 'zh-Hans-CN')
    || right.versionNumber.localeCompare(left.versionNumber, 'zh-Hans-CN', { numeric: true });
}

function normalizeSnapshots(value) {
  return normalizeObjectArray(value).map((item) => ({
    recordId: normalizeText(item.recordId),
    itemId: normalizeText(item.itemId),
    title: normalizeText(item.title, '未命名工作项'),
  })).filter((item) => item.recordId);
}

function normalizePeople(value) {
  return normalizeObjectArray(value).map((item) => ({
    openId: normalizeText(item.openId || item.open_id || item.id),
    name: normalizeText(item.name || item.openId || item.open_id, '未知用户'),
    avatarUrl: normalizeText(item.avatarUrl || item.avatar_url),
  })).filter((item) => item.openId);
}

function normalizeTextArray(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.map((item) => normalizeText(item)).filter(Boolean))];
}

function normalizeObjectArray(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeText(value, fallback = '') {
  if (typeof value === 'string') {
    return value.trim() || fallback;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
