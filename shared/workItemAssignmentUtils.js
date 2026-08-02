export const DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD = '研发超级管理员';

const UNASSIGNED_ROUTING_TOOL_IDS = new Set(['requirements', 'bugs']);
const DEVELOPMENT_SUPER_ADMIN_TOOL_IDS = new Set(['requirements', 'bugs']);

export function supportsUnassignedWorkItemRouting(toolId) {
  return UNASSIGNED_ROUTING_TOOL_IDS.has(String(toolId || '').trim());
}

export function validateWorkItemAssignmentChoice({
  toolId,
  assignees,
  needsAssigneeAssignment,
}) {
  if (!supportsUnassignedWorkItemRouting(toolId)) {
    return '';
  }

  const assigneeCount = Array.isArray(assignees) ? assignees.length : 0;
  if (needsAssigneeAssignment && assigneeCount > 0) {
    return '选择“不知道该由谁处理”后不能再选择处理人员';
  }

  if (!needsAssigneeAssignment && assigneeCount === 0) {
    return '请选择处理人员，或点击“不知道该由谁处理”';
  }

  return '';
}

export function getAssignmentNotificationTargetLabel(needsAssigneeAssignment) {
  return needsAssigneeAssignment ? '研发超级管理员' : '处理人';
}

export function canManageWorkItemAssignees({
  toolId,
  isSuperAdmin,
  isDevelopmentSuperAdmin,
  isCurrentAssignee,
}) {
  return Boolean(
    isSuperAdmin
    || isCurrentAssignee
    || (isDevelopmentSuperAdmin && supportsUnassignedWorkItemRouting(toolId)),
  );
}

export function getRoleGrantedWorkItemToolIds({
  isSuperAdmin,
  isDevelopmentSuperAdmin,
  isTestAdmin,
  allToolIds,
}) {
  if (isSuperAdmin) {
    return new Set(Array.isArray(allToolIds) ? allToolIds : []);
  }

  const granted = isDevelopmentSuperAdmin
    ? new Set(DEVELOPMENT_SUPER_ADMIN_TOOL_IDS)
    : new Set();
  if (isTestAdmin) {
    granted.add('testTasks');
  }
  return granted;
}
