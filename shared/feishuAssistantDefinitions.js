export const FEISHU_ASSISTANT_WORK_ITEM_TOOL_IDS = Object.freeze([
  'requirements',
  'bugs',
]);

export const FEISHU_ASSISTANT_INTENTS = Object.freeze({
  CANCEL_DRAFT: 'cancel_draft',
  CONTINUE_DRAFT: 'continue_draft',
  CREATE_BUG: 'create_bug',
  CREATE_REQUIREMENT: 'create_requirement',
  HELP: 'help',
  LIST_MY_TASKS: 'list_my_tasks',
  RECOMMEND_NEXT: 'recommend_next',
  UNKNOWN: 'unknown',
});

export const FEISHU_ASSISTANT_CARD_ACTIONS = Object.freeze({
  CANCEL_DRAFT: 'cancel_draft',
  CONFIRM_CREATE: 'confirm_create',
  SELECT_PROJECT: 'select_project',
  SET_ASSIGNEE_UNKNOWN: 'set_assignee_unknown',
});

export function createEmptyAssistantDraft(toolId = 'requirements') {
  return {
    toolId: normalizeAssistantToolId(toolId),
    projectId: '',
    title: '',
    description: '',
    priority: 'P4',
    expectedDays: null,
    assignees: [],
    needsAssigneeAssignment: false,
  };
}

export function normalizeAssistantIntent(value) {
  const intent = String(value || '').trim();
  return Object.values(FEISHU_ASSISTANT_INTENTS).includes(intent)
    ? intent
    : FEISHU_ASSISTANT_INTENTS.UNKNOWN;
}

export function normalizeAssistantToolId(value) {
  const toolId = String(value || '').trim();
  return FEISHU_ASSISTANT_WORK_ITEM_TOOL_IDS.includes(toolId)
    ? toolId
    : 'requirements';
}

export function normalizeAssistantDraft(value, fallbackToolId = 'requirements') {
  const source = value && typeof value === 'object' ? value : {};
  const expectedDays = Number(source.expectedDays);
  return {
    toolId: normalizeAssistantToolId(source.toolId || fallbackToolId),
    projectId: String(source.projectId || '').trim().slice(0, 100),
    title: String(source.title || '').trim().slice(0, 200),
    description: String(source.description || '').trim().slice(0, 5000),
    priority: normalizePriority(source.priority),
    expectedDays: Number.isFinite(expectedDays) && expectedDays >= 0
      ? expectedDays
      : null,
    assignees: normalizeUsers(source.assignees),
    needsAssigneeAssignment: source.needsAssigneeAssignment === true,
  };
}

export function mergeAssistantDraft(current, patch) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const draft = normalizeAssistantDraft(current);
  return normalizeAssistantDraft({
    ...draft,
    ...source,
    assignees: Array.isArray(source.assignees) ? source.assignees : draft.assignees,
  }, draft.toolId);
}

export function getAssistantDraftMissingFields(draft) {
  const normalized = normalizeAssistantDraft(draft);
  const missing = [];
  if (!normalized.projectId) {
    missing.push('project');
  }
  if (!normalized.title) {
    missing.push('title');
  }
  if (!normalized.description) {
    missing.push('description');
  }
  if (
    normalized.assignees.length === 0
    && normalized.needsAssigneeAssignment !== true
  ) {
    missing.push('assignee');
  }
  return missing;
}

export function rankAssistantTasks(items) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const overdueDifference = Number(isOverdue(right)) - Number(isOverdue(left));
    if (overdueDifference !== 0) {
      return overdueDifference;
    }
    const remainingDifference = sortableRemainingDays(left?.remainingDays)
      - sortableRemainingDays(right?.remainingDays);
    if (remainingDifference !== 0) {
      return remainingDifference;
    }
    const priorityDifference = priorityWeight(left?.priority) - priorityWeight(right?.priority);
    if (priorityDifference !== 0) {
      return priorityDifference;
    }
    return sortableTimestamp(left?.proposedAt) - sortableTimestamp(right?.proposedAt);
  });
}

function normalizePriority(value) {
  const priority = String(value || '').trim().toUpperCase();
  return ['P1', 'P2', 'P3', 'P4'].includes(priority) ? priority : 'P4';
}

function normalizeUsers(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((user) => {
    const openId = String(user?.openId || user?.open_id || '').trim();
    if (!openId || seen.has(openId)) {
      return [];
    }
    seen.add(openId);
    return [{
      openId,
      name: String(user?.name || '').trim().slice(0, 200),
      userId: String(user?.userId || user?.user_id || '').trim().slice(0, 200),
      unionId: String(user?.unionId || user?.union_id || '').trim().slice(0, 200),
      email: String(user?.email || '').trim().slice(0, 320),
    }];
  }).slice(0, 20);
}

function isOverdue(item) {
  return Number(item?.remainingDays) < 0;
}

function sortableRemainingDays(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function priorityWeight(value) {
  const priority = normalizePriority(value);
  return ['P1', 'P2', 'P3', 'P4'].indexOf(priority);
}

function sortableTimestamp(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}
