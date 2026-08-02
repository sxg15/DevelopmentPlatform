export const TEST_TASK_TOOL_ID = 'testTasks';
export const TEST_TASK_STATUSES = Object.freeze({
  waiting: '待测试',
  testing: '测试中',
  completed: '已完成',
});
export const TEST_TASK_ITEM_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const TEST_TASK_ITEM_ID_LENGTH = 6;
export const TEST_TASK_LIMITS = Object.freeze({
  title: 200,
  itemCount: 100,
  itemContent: 2000,
  conclusion: 5000,
  feedbackTitle: 200,
  feedbackContent: 5000,
  feedbackAttachments: 5,
  attachmentBytes: 20 * 1024 * 1024,
  requestAttachmentBytes: 50 * 1024 * 1024,
});

export function createTestTaskItemId(random = Math.random) {
  let result = '';
  for (let index = 0; index < TEST_TASK_ITEM_ID_LENGTH; index += 1) {
    const position = Math.min(
      TEST_TASK_ITEM_ID_ALPHABET.length - 1,
      Math.floor(Math.max(0, Number(random()) || 0) * TEST_TASK_ITEM_ID_ALPHABET.length),
    );
    result += TEST_TASK_ITEM_ID_ALPHABET[position];
  }
  return result;
}

export function createUniqueTestTaskItemId(existingIds = [], random = Math.random) {
  const existing = new Set(
    (Array.isArray(existingIds) ? existingIds : [])
      .map((item) => String(item || '').trim().toUpperCase())
      .filter(Boolean),
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = createTestTaskItemId(random);
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('无法生成唯一的测试子任务 ID');
}

export function normalizeTestTaskContentDocument(value, options = {}) {
  const parsed = parseVersionedDocument(value);
  const sourceItems = Array.isArray(parsed.value?.items) ? parsed.value.items : [];
  const seen = new Set();
  const items = sourceItems.map((item) => {
    const id = String(item?.id || '').trim().toUpperCase();
    const content = String(item?.content || '').trim();
    if (!id || !content || seen.has(id)) {
      return null;
    }
    seen.add(id);
    return { id, content };
  }).filter(Boolean);

  const document = {
    version: 1,
    revision: normalizeRevision(parsed.value?.revision),
    items,
  };
  return {
    ...document,
    error: parsed.error || validateTestTaskContentDocument(document, options),
  };
}

export function validateTestTaskContentDocument(document, options = {}) {
  const limits = { ...TEST_TASK_LIMITS, ...(options.limits || {}) };
  const items = Array.isArray(document?.items) ? document.items : [];
  if (items.length < 1 || items.length > limits.itemCount) {
    return `测试任务必须包含 1 到 ${limits.itemCount} 个子任务`;
  }

  const seen = new Set();
  for (const item of items) {
    const id = String(item?.id || '').trim().toUpperCase();
    const content = String(item?.content || '').trim();
    if (!new RegExp(`^[${TEST_TASK_ITEM_ID_ALPHABET}]{${TEST_TASK_ITEM_ID_LENGTH}}$`).test(id)) {
      return '测试子任务 ID 格式无效';
    }
    if (seen.has(id)) {
      return `测试子任务 ID 重复：${id}`;
    }
    seen.add(id);
    if (!content) {
      return `测试子任务 ${id} 的内容不能为空`;
    }
    if (content.length > limits.itemContent) {
      return `测试子任务 ${id} 的内容不能超过 ${limits.itemContent} 个字符`;
    }
  }
  return '';
}

export function createTestTaskContentDocument(items, revision = 1) {
  return normalizeTestTaskContentDocument({ version: 1, revision, items });
}

export function normalizeTestTaskResultsDocument(value, contentDocument, options = {}) {
  const parsed = parseVersionedDocument(value);
  const sourceItems = Array.isArray(parsed.value?.items) ? parsed.value.items : [];
  const sourceById = new Map(
    sourceItems.map((item) => [String(item?.itemId || '').trim().toUpperCase(), item]),
  );
  const contentItems = Array.isArray(contentDocument?.items) ? contentDocument.items : [];
  const items = contentItems.map((contentItem) => {
    const source = sourceById.get(contentItem.id) || {};
    return {
      itemId: contentItem.id,
      conclusion: String(source.conclusion || '').trim(),
      feedbackDraft: normalizeFeedbackDraft(source.feedbackDraft),
    };
  });
  const document = {
    version: 1,
    revision: normalizeRevision(parsed.value?.revision),
    items,
  };
  return {
    ...document,
    error: parsed.error || validateTestTaskResultsDocument(document, contentDocument, options),
  };
}

export function validateTestTaskResultsDocument(document, contentDocument, options = {}) {
  const limits = { ...TEST_TASK_LIMITS, ...(options.limits || {}) };
  const expectedIds = new Set(
    (Array.isArray(contentDocument?.items) ? contentDocument.items : [])
      .map((item) => String(item?.id || '').trim().toUpperCase())
      .filter(Boolean),
  );
  const items = Array.isArray(document?.items) ? document.items : [];
  if (items.length !== expectedIds.size) {
    return '测试结果必须与测试子任务逐项对应';
  }

  const seen = new Set();
  for (const item of items) {
    const itemId = String(item?.itemId || '').trim().toUpperCase();
    if (!expectedIds.has(itemId) || seen.has(itemId)) {
      return `测试结果子任务 ID 无效：${itemId || '空'}`;
    }
    seen.add(itemId);
    const conclusion = String(item?.conclusion || '').trim();
    if (conclusion.length > limits.conclusion) {
      return `测试子任务 ${itemId} 的结论不能超过 ${limits.conclusion} 个字符`;
    }
    const draftError = validateFeedbackDraft(item?.feedbackDraft, limits);
    if (draftError) {
      return `${itemId}：${draftError}`;
    }
  }
  return '';
}

export function getIncompleteTestTaskResultIds(document) {
  return (Array.isArray(document?.items) ? document.items : [])
    .filter((item) => !String(item?.conclusion || '').trim())
    .map((item) => String(item?.itemId || '').trim())
    .filter(Boolean);
}

export function buildDefaultTestFeedbackTitle(taskTitle, itemContent) {
  const value = `【测试结论】${String(taskTitle || '').trim()}-${String(itemContent || '').trim()}`;
  return value.length <= TEST_TASK_LIMITS.feedbackTitle
    ? value
    : value.slice(0, TEST_TASK_LIMITS.feedbackTitle);
}

export function buildTestTaskPermissions({
  status,
  isCreator,
  isSuperAdmin,
  isTestAdmin,
} = {}) {
  const normalizedStatus = String(status || '').trim();
  return {
    canEditContent: normalizedStatus === TEST_TASK_STATUSES.waiting
      && Boolean(isCreator || isSuperAdmin),
    canStart: normalizedStatus === TEST_TASK_STATUSES.waiting && Boolean(isTestAdmin),
    canEditResults: normalizedStatus === TEST_TASK_STATUSES.testing && Boolean(isTestAdmin),
    canAdjustTesters: normalizedStatus === TEST_TASK_STATUSES.testing && Boolean(isTestAdmin),
    canComplete: normalizedStatus === TEST_TASK_STATUSES.testing && Boolean(isTestAdmin),
    canDelete: Boolean(isSuperAdmin),
  };
}

export function isTestTaskActionableForUser(task, user, options = {}) {
  const status = String(task?.itemStatus || task?.status || '').trim();
  if (status === TEST_TASK_STATUSES.completed) {
    return false;
  }
  if (options.isTestAdmin === true) {
    return true;
  }
  return status === TEST_TASK_STATUSES.testing
    && hasMatchingUser(task?.assignees || task?.testers, user);
}

export function isValidTestTaskTransition(currentStatus, nextStatus) {
  return (
    currentStatus === TEST_TASK_STATUSES.waiting
    && nextStatus === TEST_TASK_STATUSES.testing
  ) || (
    currentStatus === TEST_TASK_STATUSES.testing
    && nextStatus === TEST_TASK_STATUSES.completed
  );
}

function normalizeFeedbackDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    title: String(value.title || '').trim(),
    content: String(value.content || '').trim(),
    author: normalizePerson(value.author),
    attachments: (Array.isArray(value.attachments) ? value.attachments : [])
      .map((item) => ({
        fileToken: String(item?.fileToken || item?.file_token || '').trim(),
        name: String(item?.name || '').trim(),
        size: Number(item?.size) || 0,
        type: String(item?.type || '').trim(),
      }))
      .filter((item) => item.fileToken),
    feedbackRecordId: String(value.feedbackRecordId || '').trim(),
    feedbackId: String(value.feedbackId || '').trim(),
  };
}

function validateFeedbackDraft(value, limits) {
  if (!value) {
    return '';
  }
  if (!String(value.title || '').trim()) {
    return '反馈标题不能为空';
  }
  if (String(value.title || '').trim().length > limits.feedbackTitle) {
    return `反馈标题不能超过 ${limits.feedbackTitle} 个字符`;
  }
  if (String(value.content || '').trim().length > limits.feedbackContent) {
    return `反馈内容不能超过 ${limits.feedbackContent} 个字符`;
  }
  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  if (attachments.length > limits.feedbackAttachments) {
    return `每条反馈最多上传 ${limits.feedbackAttachments} 个附件`;
  }
  if (attachments.some((item) => Number(item?.size) > limits.attachmentBytes)) {
    return `单个反馈附件不能超过 ${Math.round(limits.attachmentBytes / 1024 / 1024)} MB`;
  }
  return '';
}

function parseVersionedDocument(value) {
  if (value === null || value === undefined || value === '') {
    return { value: {}, error: '' };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (!isBitableTextFragment(value)) {
      return { value, error: '' };
    }
  }
  try {
    const parsed = JSON.parse(normalizeBitableTextValue(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: {}, error: 'JSON 文档必须是对象' };
    }
    if (Number(parsed.version || 1) !== 1) {
      return { value: parsed, error: `不支持的 JSON 文档版本：${parsed.version}` };
    }
    return { value: parsed, error: '' };
  } catch {
    return { value: {}, error: 'JSON 文档格式错误' };
  }
}

function normalizeBitableTextValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeBitableTextValue).join('');
  }
  if (value && typeof value === 'object') {
    return normalizeBitableTextValue(value.text ?? value.value ?? '');
  }
  return String(value ?? '').trim();
}

function isBitableTextFragment(value) {
  return Object.hasOwn(value, 'text') || Object.hasOwn(value, 'value');
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision > 0 ? revision : 1;
}

function normalizePerson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    openId: String(value.openId || value.open_id || '').trim(),
    userId: String(value.userId || value.user_id || '').trim(),
    unionId: String(value.unionId || value.union_id || '').trim(),
    email: String(value.email || '').trim(),
    name: String(value.name || '').trim(),
  };
}

function hasMatchingUser(people, user) {
  const wanted = new Set(getUserKeys(user));
  return wanted.size > 0 && (Array.isArray(people) ? people : [])
    .some((person) => getUserKeys(person).some((key) => wanted.has(key)));
}

function getUserKeys(user) {
  return [
    user?.openId,
    user?.open_id,
    user?.userId,
    user?.user_id,
    user?.unionId,
    user?.union_id,
    user?.email,
    user?.id,
  ].map((item) => String(item || '').trim()).filter(Boolean);
}
