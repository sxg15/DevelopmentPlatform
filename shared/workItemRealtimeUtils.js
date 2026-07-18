export function getWaitingWorkItemStatus(toolId) {
  return String(toolId || '').trim() === 'bugs' ? '未处理' : '待处理';
}

export function getWorkItemRecordId(item) {
  return String(item?.recordId || '').trim();
}

export function replaceWorkItemByRecordId(items, updatedItem) {
  const recordId = getWorkItemRecordId(updatedItem);
  if (!recordId || !Array.isArray(items)) {
    return Array.isArray(items) ? items : [];
  }

  return items.map((item) => (getWorkItemRecordId(item) === recordId ? updatedItem : item));
}

export function countWaitingAssignedWorkItems(toolId, items, user) {
  const userKeys = getWorkItemUserKeys(user);
  const waitingStatus = getWaitingWorkItemStatus(toolId);

  if (userKeys.size === 0) {
    return 0;
  }

  return (Array.isArray(items) ? items : []).filter((item) => (
    getWorkItemStatus(item) === waitingStatus
    && isWorkItemAssignedToUser(item, user)
  )).length;
}

export function getWorkItemStatus(item) {
  return String(item?.itemStatus || item?.requirementStatus || '未设置状态').trim() || '未设置状态';
}

export function getWorkItemUserKeys(user) {
  const keys = [
    user?.openId,
    user?.open_id,
    user?.unionId,
    user?.union_id,
    user?.userId,
    user?.user_id,
    user?.email,
    user?.id,
    user?.name,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return new Set(keys);
}

export function isWorkItemAssignedToUser(item, user) {
  const userKeys = getWorkItemUserKeys(user);
  if (userKeys.size === 0) {
    return false;
  }

  return (Array.isArray(item?.assignees) ? item.assignees : [])
    .some((assignee) => hasMatchingWorkItemUser(assignee, userKeys));
}

function hasMatchingWorkItemUser(user, expectedKeys) {
  for (const key of getWorkItemUserKeys(user)) {
    if (expectedKeys.has(key)) {
      return true;
    }
  }

  return false;
}
