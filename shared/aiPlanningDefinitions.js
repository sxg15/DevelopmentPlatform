export const AI_PLAN_TOOL_ID = 'aiPlans';
export const AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS = Object.freeze(['requirements', 'bugs']);

export const AI_CONVERSATION_STATUSES = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  RUNNING: 'running',
  READY: 'ready',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  ARCHIVED: 'archived',
});

export const AI_PLAN_STATUSES = Object.freeze({
  CANDIDATE: 'candidate',
  ADOPTED: 'adopted',
  WITHDRAWN: 'withdrawn',
});

export function isAiPlanningWorkItemTool(toolId) {
  return AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS.includes(String(toolId || '').trim());
}

export function canAccessAiPlanTool(allowedToolIds) {
  const normalized = allowedToolIds instanceof Set
    ? allowedToolIds
    : new Set(Array.isArray(allowedToolIds) ? allowedToolIds : []);
  return AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS.some((toolId) => normalized.has(toolId));
}

export function normalizeAiPlanSourceReferences(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const rootId = String(item?.rootId || '').trim();
      const relativePath = normalizeRelativeSourcePath(item?.relativePath);
      if (!rootId || !relativePath) {
        return null;
      }

      const startLine = normalizePositiveLineNumber(item?.startLine);
      const endLine = Math.max(startLine, normalizePositiveLineNumber(item?.endLine, startLine));
      return {
        rootId,
        relativePath,
        startLine,
        endLine,
        note: String(item?.note || '').trim().slice(0, 500),
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeRelativeSourcePath(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  if (
    !text
    || text.startsWith('/')
    || /^[a-zA-Z]:/.test(text)
    || text.split('/').includes('..')
  ) {
    return '';
  }
  return text.slice(0, 500);
}

function normalizePositiveLineNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
