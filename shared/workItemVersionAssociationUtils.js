export const WORK_ITEM_VERSION_ASSOCIATION_CONFIRMATION_TYPE = 'version_association';

export const WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS = Object.freeze({
  ASSOCIATE: 'associate',
  UNLINK: 'unlink',
});

export const WORK_ITEM_COMPLETION_TRANSITIONS = Object.freeze({
  ENTER: 'enter_completed',
  LEAVE: 'leave_completed',
  NONE: 'none',
});

const SUPPORTED_TOOL_IDS = new Set(['requirements', 'bugs']);
const MAX_VERSION_SELECTION_COUNT = 200;

export function getWorkItemCompletionTransition({
  toolId,
  currentStatus,
  newStatus,
  completedStatuses,
} = {}) {
  if (!SUPPORTED_TOOL_IDS.has(String(toolId || '').trim())) {
    return WORK_ITEM_COMPLETION_TRANSITIONS.NONE;
  }

  const completed = new Set(
    (Array.isArray(completedStatuses) ? completedStatuses : [])
      .map((status) => String(status || '').trim())
      .filter(Boolean),
  );
  const currentCompleted = completed.has(String(currentStatus || '').trim());
  const nextCompleted = completed.has(String(newStatus || '').trim());

  if (!currentCompleted && nextCompleted) {
    return WORK_ITEM_COMPLETION_TRANSITIONS.ENTER;
  }
  if (currentCompleted && !nextCompleted) {
    return WORK_ITEM_COMPLETION_TRANSITIONS.LEAVE;
  }
  return WORK_ITEM_COMPLETION_TRANSITIONS.NONE;
}

export function getVersionAssociationOperationForTransition(transition) {
  if (transition === WORK_ITEM_COMPLETION_TRANSITIONS.ENTER) {
    return WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.ASSOCIATE;
  }
  if (transition === WORK_ITEM_COMPLETION_TRANSITIONS.LEAVE) {
    return WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.UNLINK;
  }
  return '';
}

export function normalizeWorkItemVersionAssociationDecision(value, {
  expectedOperation = '',
} = {}) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('版本关联决定格式不正确');
  }

  const operation = String(value.operation || '').trim();
  if (!Object.values(WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS).includes(operation)) {
    throw new Error('版本关联操作不在可选范围内');
  }
  if (expectedOperation && operation !== expectedOperation) {
    throw new Error('版本关联操作与当前状态变更不匹配');
  }
  if (typeof value.apply !== 'boolean') {
    throw new Error('版本关联决定必须明确是否执行');
  }

  const versionRecordIds = normalizeVersionRecordIds(value.versionRecordIds);
  if (value.apply && versionRecordIds.length === 0) {
    throw new Error('请选择至少一个版本');
  }
  if (!value.apply && versionRecordIds.length > 0) {
    throw new Error('不执行版本关联时不能提交版本记录');
  }

  return {
    operation,
    apply: value.apply,
    versionRecordIds,
  };
}

export function buildWorkItemVersionAssociationConfirmation({
  operation,
  currentStatus,
  requestedStatus,
  versions,
} = {}) {
  const normalizedOperation = String(operation || '').trim();
  if (!Object.values(WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS).includes(normalizedOperation)) {
    throw new Error('版本关联操作不在可选范围内');
  }

  return {
    confirmationType: WORK_ITEM_VERSION_ASSOCIATION_CONFIRMATION_TYPE,
    confirmField: 'versionAssociationDecision',
    operation: normalizedOperation,
    currentStatus: String(currentStatus || '').trim(),
    requestedStatus: String(requestedStatus || '').trim(),
    versions: (Array.isArray(versions) ? versions : [])
      .map(normalizeVersionConfirmationItem)
      .filter(Boolean),
  };
}

function normalizeVersionRecordIds(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const recordId = String(item || '').trim();
    if (!recordId || seen.has(recordId)) {
      continue;
    }
    seen.add(recordId);
    result.push(recordId);
    if (result.length >= MAX_VERSION_SELECTION_COUNT) {
      break;
    }
  }
  return result;
}

function normalizeVersionConfirmationItem(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const recordId = String(value.recordId || value.record_id || '').trim();
  if (!recordId) {
    return null;
  }
  return {
    recordId,
    versionNumber: String(value.versionNumber || value.version_number || '').trim(),
    platform: String(value.platform || '').trim(),
    status: String(value.status || '').trim(),
  };
}
