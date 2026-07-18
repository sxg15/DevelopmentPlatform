export function normalizeProjectOverviewDisplayData(value, now = Date.now()) {
  const source = isRecord(value) ? value : {};

  return {
    generatedAt: normalizeTimestamp(source.generatedAt, now),
    historyNotice: normalizeText(source.historyNotice),
    summary: normalizeSummary(source.summary),
    statusByTool: normalizeObjectArray(source.statusByTool).map((item) => ({
      toolId: normalizeText(item.toolId),
      label: normalizeText(item.label, '未命名类型'),
      categories: normalizeObjectArray(item.categories).map((category) => ({
        key: normalizeText(category.key),
        count: normalizeCount(category.count),
        statuses: normalizeObjectArray(category.statuses).map((status) => ({
          name: normalizeText(status.name),
          count: normalizeCount(status.count),
        })),
      })),
    })),
    priorityDistribution: normalizeObjectArray(source.priorityDistribution).map((item) => ({
      priority: normalizeText(item.priority, '未设置'),
      count: normalizeCount(item.count),
    })),
    trend: normalizeObjectArray(source.trend).map((item) => ({
      date: normalizeText(item.date),
      created: normalizeCount(item.created),
      completed: normalizeCount(item.completed),
    })),
    assigneeLoad: normalizeObjectArray(source.assigneeLoad).map((item) => ({
      name: normalizeText(item.name, '未命名人员'),
      waiting: normalizeCount(item.waiting),
      processing: normalizeCount(item.processing),
      overdue: normalizeCount(item.overdue),
    })),
    risks: normalizeObjectArray(source.risks).map((item) => ({
      toolId: normalizeText(item.toolId),
      toolLabel: normalizeText(item.toolLabel, '工作项'),
      recordId: normalizeText(item.recordId),
      itemId: normalizeText(item.itemId),
      title: normalizeText(item.title, '未命名工作项'),
      status: normalizeText(item.status, '未设置状态'),
      remainingDays: normalizeNumber(item.remainingDays),
      assignees: normalizeObjectArray(item.assignees).map((assignee) => ({
        name: normalizeText(assignee.name),
      })),
      riskKinds: normalizeTextArray(item.riskKinds),
      riskLabels: normalizeTextArray(item.riskLabels),
    })),
    recentActivity: normalizeObjectArray(source.recentActivity).map((item, index) => ({
      id: normalizeText(item.id, `activity-${index}`),
      type: normalizeText(item.type, 'updated'),
      toolId: normalizeText(item.toolId),
      toolLabel: normalizeText(item.toolLabel, '工作项'),
      recordId: normalizeText(item.recordId),
      itemId: normalizeText(item.itemId),
      title: normalizeText(item.title, '未命名工作项'),
      operatorName: normalizeText(item.operatorName, '未知用户'),
      text: normalizeText(item.text, '更新了工作项'),
      occurredAt: normalizeTimestamp(item.occurredAt, 0),
    })),
    unavailableTools: normalizeObjectArray(source.unavailableTools).map((item) => ({
      toolId: normalizeText(item.toolId),
      label: normalizeText(item.label, '工作项'),
    })),
  };
}

function normalizeSummary(value) {
  const source = isRecord(value) ? value : {};
  return {
    active: normalizeCount(source.active),
    waiting: normalizeCount(source.waiting),
    processing: normalizeCount(source.processing),
    overdue: normalizeCount(source.overdue),
    unassigned: normalizeCount(source.unassigned),
    completedThisWeek: normalizeCount(source.completedThisWeek),
  };
}

function normalizeObjectArray(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeTextArray(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(item)).filter(Boolean)
    : [];
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

function normalizeCount(value) {
  return Math.max(0, normalizeNumber(value) || 0);
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
