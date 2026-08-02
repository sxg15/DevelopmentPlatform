const PENDING_COUNT_TOOL_IDS = Object.freeze(['requirements', 'bugs', 'testTasks', 'feedback']);

export function getProjectToolsForDisplay(project, definitions) {
  const canonicalTools = Array.isArray(definitions) ? definitions.filter(Boolean) : [];
  const tools = Array.isArray(project?.allowedTools) && project.allowedTools.length > 0
    ? project.allowedTools
    : canonicalTools;
  const normalizedTools = [];
  const addedToolIds = new Set();

  for (const tool of tools) {
    const canonicalTool = canonicalTools.find((item) => item.id === tool?.id) || tool;
    const toolId = String(canonicalTool?.id || '').trim();
    if (
      !toolId
      || !canonicalTool?.label
      || addedToolIds.has(toolId)
      || (toolId === 'aiPlans' && !project?.aiPlanning?.enabled)
    ) {
      continue;
    }
    normalizedTools.push(canonicalTool);
    addedToolIds.add(toolId);
  }

  const overviewTool = canonicalTools.find((tool) => tool.id === 'overview');
  if (overviewTool && !addedToolIds.has('overview')) {
    normalizedTools.unshift(overviewTool);
    addedToolIds.add('overview');
  }

  const versionTool = canonicalTools.find((tool) => tool.id === 'versions');
  if (versionTool && !addedToolIds.has('versions')) {
    normalizedTools.splice(1, 0, versionTool);
    addedToolIds.add('versions');
  }

  for (const tool of canonicalTools) {
    if (!isDevelopmentProjectTool(tool) || addedToolIds.has(tool.id)) {
      continue;
    }
    normalizedTools.push(tool);
    addedToolIds.add(tool.id);
  }

  return normalizedTools;
}

export function getProjectToolNavigationSections(tools, groupDefinitions) {
  const visibleTools = Array.isArray(tools) ? tools.filter(Boolean) : [];
  const groups = (Array.isArray(groupDefinitions) ? groupDefinitions : [])
    .filter((group) => group?.id && group?.label)
    .map((group) => ({
      ...group,
      tools: visibleTools.filter((tool) => tool?.groupId === group.id),
    }))
    .filter((group) => group.tools.length > 0);
  const knownGroupIds = new Set(groups.map((group) => group.id));

  return {
    ungroupedTools: visibleTools.filter((tool) => !tool?.groupId || !knownGroupIds.has(tool.groupId)),
    groups,
  };
}

export function normalizeCollapsedProjectToolGroupIds(value, groupDefinitions) {
  const validGroupIds = new Set(
    (Array.isArray(groupDefinitions) ? groupDefinitions : [])
      .map((group) => String(group?.id || '').trim())
      .filter(Boolean),
  );

  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((groupId) => String(groupId || '').trim())
      .filter((groupId) => validGroupIds.has(groupId)),
  )];
}

export function getProjectToolGroupPendingCount(tools, getPendingCount) {
  if (!Array.isArray(tools) || typeof getPendingCount !== 'function') {
    return 0;
  }

  return tools.reduce(
    (total, tool) => total + normalizeCount(getPendingCount(tool)),
    0,
  );
}

export function isDevelopmentProjectTool(tool) {
  return tool?.disabled === true && Boolean(String(tool?.statusText || '').trim());
}

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
        testTasks: normalizeCount(value?.testTasks),
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
