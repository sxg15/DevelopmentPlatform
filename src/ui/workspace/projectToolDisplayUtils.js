const PENDING_COUNT_TOOL_IDS = Object.freeze(['requirements', 'bugs', 'feedback']);

export function normalizeRelatedWorkItemCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(counts).map(([projectId, value]) => [
      String(projectId || '').trim(),
      {
        requirements: normalizeCount(value?.requirements),
        bugs: normalizeCount(value?.bugs),
        feedback: normalizeCount(value?.feedback),
      },
    ]).filter(([projectId]) => Boolean(projectId)),
  );
}

export function getProjectToolPendingCount(counts, toolId) {
  return isProjectToolPendingCountTool(toolId)
    ? normalizeCount(counts?.[String(toolId || '').trim()])
    : 0;
}

export function isProjectToolPendingCountTool(toolId) {
  return PENDING_COUNT_TOOL_IDS.includes(String(toolId || '').trim());
}

function normalizeCount(value) {
  return Math.max(0, Number(value) || 0);
}
