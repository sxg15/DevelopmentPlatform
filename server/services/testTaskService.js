import {
  TEST_TASK_LIMITS,
  TEST_TASK_STATUSES,
  buildTestTaskPermissions,
  getIncompleteTestTaskResultIds,
  isValidTestTaskTransition,
  normalizeTestTaskContentDocument,
  normalizeTestTaskResultsDocument,
  validateTestTaskContentDocument,
  validateTestTaskResultsDocument,
} from '../../shared/testTaskUtils.js';

export function createTestTaskService({
  config,
  resolveContext,
  bitable,
  queue,
  notify = async () => [],
  publish = () => {},
  createFeedback = async () => {
    throw new Error('未配置测试反馈创建服务');
  },
  now = () => Date.now(),
  randomId = () => Math.random().toString(36).slice(2, 10),
}) {
  if (!config?.fieldNames || typeof resolveContext !== 'function' || !bitable || !queue) {
    throw new TypeError('测试任务服务缺少必要依赖');
  }

  const fields = config.fieldNames;

  async function list({ token, project, user, access, ensure = false }) {
    const context = await resolveContext({ token, project, user, ensure });
    const records = await bitable.fetchRecords(token, context, { consistency: 'fresh' });
    return buildListPayload(records, user, access, context);
  }

  async function read({ token, project, user, access, recordId }) {
    const context = await resolveContext({ token, project, user, ensure: false });
    const record = await bitable.fetchRecord(
      token,
      context.appToken,
      context.tableId,
      recordId,
      { consistency: 'fresh' },
    );
    if (!record) {
      throw httpError('测试任务记录不存在', 404);
    }
    return normalizeRecord(record, user, access);
  }

  async function create({
    token,
    project,
    user,
    access,
    title,
    items,
    clientMutationId,
  }) {
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) {
      throw httpError('任务名称不能为空', 400);
    }
    if (normalizedTitle.length > TEST_TASK_LIMITS.title) {
      throw httpError(`任务名称不能超过 ${TEST_TASK_LIMITS.title} 个字符`, 400);
    }
    const content = normalizeTestTaskContentDocument({
      version: 1,
      revision: 1,
      items,
    });
    if (content.error) {
      throw httpError(content.error, 400);
    }
    requireMutationId(clientMutationId);
    if (!Array.isArray(access?.testAdministrators) || access.testAdministrators.length === 0) {
      throw httpError('项目权限表未配置测试管理员，暂时无法创建测试任务', 400);
    }

    const context = await resolveContext({ token, project, user, ensure: true });
    const result = await queue.run(tableMutationKey(project.projectId), async () => {
      const records = await bitable.fetchRecords(token, context, { consistency: 'fresh' });
      const duplicate = findBySourceMutationId(records, clientMutationId);
      if (duplicate) {
        return { record: duplicate, duplicate: true };
      }
      const taskId = buildNextTaskId(records);
      const results = normalizeTestTaskResultsDocument('', content);
      const record = await bitable.createRecord(token, context.appToken, context.tableId, {
        [fields.taskId]: taskId,
        [fields.title]: normalizedTitle,
        [fields.content]: JSON.stringify(stripError(content)),
        [fields.createdAt]: now(),
        [fields.creator]: [toBitableUser(user)],
        [fields.testers]: [],
        [fields.status]: TEST_TASK_STATUSES.waiting,
        [fields.statusChangeLog]: JSON.stringify({ version: 1, items: [] }),
        [fields.comments]: JSON.stringify({
          version: 1,
          items: [],
          internal: { sourceMutationIds: [String(clientMutationId).slice(0, 100)] },
        }),
        [fields.results]: JSON.stringify(stripError(results)),
        [fields.relatedFeedback]: JSON.stringify({ version: 1, revision: 1, items: [] }),
      });
      return { record, duplicate: false };
    });

    const task = await read({
      token,
      project,
      user,
      access,
      recordId: getRecordId(result.record),
    });
    const notificationResults = result.duplicate
      ? []
      : await notify('created', access.testAdministrators, { project, task, actor: user });
    if (!result.duplicate) {
      publishUpdate(project.projectId, task.recordId);
    }
    return {
      task,
      duplicate: result.duplicate,
      notificationResults,
    };
  }

  async function updateContent({
    token,
    project,
    user,
    access,
    recordId,
    title,
    items,
    expectedRevision,
    clientMutationId,
  }) {
    requireMutationId(clientMutationId);
    return mutateRecord({
      token,
      project,
      user,
      access,
      recordId,
      mutation: async ({ context, record, task }) => {
        if (!task.permissions.canEditContent) {
          throw httpError('只有创建人或超级管理员能在待测试状态编辑任务内容', 403);
        }
        if (Number(expectedRevision) !== task.content.revision) {
          throw revisionConflict('任务内容已被其他人修改', task);
        }
        const normalizedTitle = String(title || '').trim();
        if (!normalizedTitle || normalizedTitle.length > TEST_TASK_LIMITS.title) {
          throw httpError(`任务名称不能为空且不能超过 ${TEST_TASK_LIMITS.title} 个字符`, 400);
        }
        const nextContent = normalizeTestTaskContentDocument({
          version: 1,
          revision: task.content.revision + 1,
          items,
        });
        if (nextContent.error) {
          throw httpError(nextContent.error, 400);
        }
        const nextResults = normalizeTestTaskResultsDocument(task.results, nextContent);
        await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
          [fields.title]: normalizedTitle,
          [fields.content]: JSON.stringify(stripError(nextContent)),
          [fields.results]: JSON.stringify(stripError({
            ...nextResults,
            revision: task.results.revision + 1,
          })),
        });
      },
    });
  }

  async function start({
    token,
    project,
    user,
    access,
    recordId,
    testers,
    clientMutationId,
  }) {
    requireMutationId(clientMutationId);
    const selectedTesters = validateTesters(testers, access);
    const result = await mutateRecord({
      token,
      project,
      user,
      access,
      recordId,
      mutation: async ({ context, task }) => {
        if (!task.permissions.canStart || !isValidTestTaskTransition(task.status, TEST_TASK_STATUSES.testing)) {
          throw httpError('只有测试管理员能将待测试任务变更为测试中', 403);
        }
        await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
          [fields.testers]: selectedTesters.map(toBitableUser),
          [fields.status]: TEST_TASK_STATUSES.testing,
          [fields.statusChangeLog]: JSON.stringify(appendStatusChange(
            task.statusChangeLog,
            task.status,
            TEST_TASK_STATUSES.testing,
            user,
            now(),
            randomId,
          )),
        });
      },
    });
    const notificationResults = await notify('started', result.task.creators, {
      project,
      task: result.task,
      actor: user,
      testers: selectedTesters,
    });
    return { ...result, notificationResults };
  }

  async function updateTesters({
    token,
    project,
    user,
    access,
    recordId,
    testers,
    reason,
    clientMutationId,
  }) {
    requireMutationId(clientMutationId);
    const selectedTesters = validateTesters(testers, access);
    const normalizedReason = String(reason || '').trim();
    if (!normalizedReason) {
      throw httpError('调整测试人员时必须填写原因', 400);
    }
    return mutateRecord({
      token,
      project,
      user,
      access,
      recordId,
      mutation: async ({ context, task }) => {
        if (!task.permissions.canAdjustTesters) {
          throw httpError('只有测试管理员能在测试中调整测试人员', 403);
        }
        const comments = appendSystemComment(
          task.commentsDocument,
          user,
          `【测试人员调整】${normalizedReason}`,
          now(),
          randomId,
        );
        await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
          [fields.testers]: selectedTesters.map(toBitableUser),
          [fields.comments]: JSON.stringify(comments),
        });
      },
    });
  }

  async function saveResults({
    token,
    project,
    user,
    access,
    recordId,
    results,
    expectedRevision,
    clientMutationId,
  }) {
    requireMutationId(clientMutationId);
    return mutateRecord({
      token,
      project,
      user,
      access,
      recordId,
      mutation: async ({ context, task }) => {
        if (!task.permissions.canEditResults) {
          throw httpError('只有测试管理员能在测试中填写测试结果', 403);
        }
        if (Number(expectedRevision) !== task.results.revision) {
          throw revisionConflict('测试结果已被其他人修改', task);
        }
        const withAuthors = {
          version: 1,
          revision: task.results.revision + 1,
          items: (Array.isArray(results) ? results : []).map((item) => ({
            ...item,
            feedbackDraft: item?.feedbackDraft
              ? {
                  ...item.feedbackDraft,
                  author: findExistingDraftAuthor(task.results, item.itemId) || toStoredUser(user),
                }
              : null,
          })),
        };
        const nextResults = normalizeTestTaskResultsDocument(withAuthors, task.content);
        const validationError = validateTestTaskResultsDocument(nextResults, task.content);
        if (validationError) {
          throw httpError(validationError, 400);
        }
        await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
          [fields.results]: JSON.stringify(stripError(nextResults)),
        });
      },
    });
  }

  async function complete({
    token,
    project,
    user,
    access,
    recordId,
    expectedRevision,
    clientMutationId,
  }) {
    requireMutationId(clientMutationId);
    return queue.run(recordMutationKey(project.projectId, recordId), async () => {
      const context = await resolveContext({ token, project, user, ensure: false });
      let record = await bitable.fetchRecord(
        token,
        context.appToken,
        context.tableId,
        recordId,
        { consistency: 'fresh' },
      );
      let task = normalizeRecord(record, user, access);
      if (!task.permissions.canComplete) {
        throw httpError('只有测试管理员能完成测试中的任务', 403);
      }
      if (Number(expectedRevision) !== task.results.revision) {
        throw revisionConflict('测试结果已被其他人修改', task);
      }
      const incompleteIds = getIncompleteTestTaskResultIds(task.results);
      if (incompleteIds.length > 0) {
        throw httpError(`以下子任务尚未填写测试结论：${incompleteIds.join('、')}`, 400);
      }

      const failures = [];
      for (const resultItem of task.results.items) {
        const draft = resultItem.feedbackDraft;
        if (!draft || draft.feedbackRecordId) {
          continue;
        }
        try {
          const feedback = await createFeedback({
            token,
            project,
            task,
            resultItem,
            draft,
            sourceMutationId: `test-task:${recordId}:${resultItem.itemId}`,
          });
          const nextResults = {
            ...task.results,
            revision: task.results.revision + 1,
            items: task.results.items.map((item) => (
              item.itemId === resultItem.itemId
                ? {
                    ...item,
                    feedbackDraft: {
                      ...item.feedbackDraft,
                      feedbackRecordId: feedback.recordId,
                      feedbackId: feedback.itemId || feedback.feedbackId || '',
                    },
                  }
                : item
            )),
          };
          const relatedFeedback = appendRelatedFeedback(task.relatedFeedback, {
            itemId: resultItem.itemId,
            feedbackRecordId: feedback.recordId,
            feedbackId: feedback.itemId || feedback.feedbackId || '',
            title: feedback.title || draft.title,
            proposer: draft.author,
            submittedAt: now(),
          });
          await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
            [fields.results]: JSON.stringify(stripError(nextResults)),
            [fields.relatedFeedback]: JSON.stringify(relatedFeedback),
          });
          record = await bitable.fetchRecord(
            token,
            context.appToken,
            context.tableId,
            recordId,
            { consistency: 'fresh' },
          );
          task = normalizeRecord(record, user, access);
        } catch (error) {
          failures.push({
            itemId: resultItem.itemId,
            message: error instanceof Error ? error.message : '创建反馈失败',
          });
        }
      }
      if (failures.length > 0) {
        const error = httpError('部分反馈创建失败，测试任务仍保持测试中', 502);
        error.publicDetails = { feedbackFailures: failures, task };
        throw error;
      }

      await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
        [fields.status]: TEST_TASK_STATUSES.completed,
        [fields.statusChangeLog]: JSON.stringify(appendStatusChange(
          task.statusChangeLog,
          task.status,
          TEST_TASK_STATUSES.completed,
          user,
          now(),
          randomId,
        )),
      });
      const completedTask = await read({ token, project, user, access, recordId });
      publishUpdate(project.projectId, recordId);
      return { task: completedTask };
    });
  }

  async function remove({ token, project, user, access, recordId }) {
    if (!access?.isSuperAdmin) {
      throw httpError('只有超级管理员可以删除测试任务', 403);
    }
    const context = await resolveContext({ token, project, user, ensure: false });
    await bitable.deleteRecord(token, context.appToken, context.tableId, recordId);
    publish({
      projectId: project.projectId,
      toolId: 'testTasks',
      recordId,
      changeType: 'deleted',
    });
    return { deleted: true, recordId };
  }

  async function mutateRecord({ token, project, user, access, recordId, mutation }) {
    return queue.run(recordMutationKey(project.projectId, recordId), async () => {
      const context = await resolveContext({ token, project, user, ensure: false });
      const record = await bitable.fetchRecord(
        token,
        context.appToken,
        context.tableId,
        recordId,
        { consistency: 'fresh' },
      );
      if (!record) {
        throw httpError('测试任务记录不存在', 404);
      }
      const task = normalizeRecord(record, user, access);
      await mutation({ context, record, task });
      const nextTask = await read({ token, project, user, access, recordId });
      publishUpdate(project.projectId, recordId);
      return { task: nextTask };
    });
  }

  function buildListPayload(records, user, access, context) {
    return {
      status: context.status || 'exists',
      existed: context.status !== 'created',
      created: context.status === 'created',
      toolId: 'testTasks',
      tableId: context.tableId,
      fields: context.fields || [],
      testTasks: (Array.isArray(records) ? records : [])
        .map((record) => normalizeRecord(record, user, access))
        .filter((task) => !task.isEmpty)
        .sort((left, right) => right.createdAt - left.createdAt),
      testerCandidates: access?.mentionableUsersByTool?.testTasks || [],
      testAdministrators: access?.testAdministrators || [],
      isTestAdmin: Boolean(access?.isTestAdmin),
    };
  }

  function normalizeRecord(record, user, access) {
    const source = record?.fields || {};
    const status = normalizeText(source[fields.status]) || TEST_TASK_STATUSES.waiting;
    const creators = normalizeUsers(source[fields.creator]);
    const testers = normalizeUsers(source[fields.testers]);
    const content = normalizeTestTaskContentDocument(source[fields.content]);
    const results = normalizeTestTaskResultsDocument(source[fields.results], content);
    const commentsDocument = parseStoredDocument(source[fields.comments], { version: 1, items: [] });
    const statusChangeLog = parseStoredDocument(
      source[fields.statusChangeLog],
      { version: 1, items: [] },
    );
    const relatedFeedback = parseStoredDocument(
      source[fields.relatedFeedback],
      { version: 1, revision: 1, items: [] },
    );
    const task = {
      recordId: getRecordId(record),
      itemId: normalizeText(source[fields.taskId]),
      taskId: normalizeText(source[fields.taskId]),
      title: normalizeText(source[fields.title]) || '未命名测试任务',
      status,
      itemStatus: status,
      requirementStatus: status,
      createdAt: normalizeTimestamp(source[fields.createdAt]),
      proposedAt: normalizeTimestamp(source[fields.createdAt]),
      creators,
      proposers: creators,
      testers,
      assignees: testers,
      content,
      results,
      comments: normalizeComments(commentsDocument.items),
      commentsDocument,
      statusChangeLog: normalizeStatusChanges(statusChangeLog.items),
      statusChangeLogDocument: statusChangeLog,
      relatedFeedback,
      attachments: normalizeAttachments(source[fields.attachments]),
      permissions: {},
      isEmpty: !normalizeText(source[fields.taskId])
        && !normalizeText(source[fields.title])
        && content.items.length === 0,
    };
    task.permissions = buildTestTaskPermissions({
      status,
      isCreator: creators.some((creator) => sameUser(creator, user)),
      isSuperAdmin: Boolean(access?.isSuperAdmin),
      isTestAdmin: Boolean(access?.isTestAdmin),
    });
    return task;
  }

  function buildNextTaskId(records) {
    let maximum = 0;
    for (const record of Array.isArray(records) ? records : []) {
      const value = normalizeText(record?.fields?.[fields.taskId]);
      const match = /(\d+)$/.exec(value);
      maximum = Math.max(maximum, Number(match?.[1] || 0));
    }
    return `${config.idPrefix || 'T-'}${String(maximum + 1).padStart(config.idDigits || 4, '0')}`;
  }

  function findBySourceMutationId(records, clientMutationId) {
    return (Array.isArray(records) ? records : []).find((record) => {
      const document = parseStoredDocument(record?.fields?.[fields.comments], {});
      return document.internal?.sourceMutationIds?.includes(String(clientMutationId).slice(0, 100));
    }) || null;
  }

  function publishUpdate(projectId, recordId) {
    publish({ projectId, toolId: 'testTasks', recordId });
  }

  return {
    complete,
    create,
    list,
    read,
    remove,
    saveResults,
    start,
    updateContent,
    updateTesters,
  };
}

function validateTesters(testers, access) {
  const selected = uniqueUsers(testers);
  if (selected.length === 0) {
    throw httpError('请选择至少一名测试人员', 400);
  }
  const candidates = uniqueUsers(access?.mentionableUsersByTool?.testTasks || []);
  if (selected.some((tester) => !candidates.some((candidate) => sameUser(tester, candidate)))) {
    throw httpError('测试人员不在项目测试人员可选范围内', 400);
  }
  return selected;
}

function appendStatusChange(document, oldStatus, newStatus, user, timestamp, randomId) {
  return {
    version: 1,
    items: [
      ...(Array.isArray(document?.items) ? document.items : []),
      {
        id: `status-${timestamp}-${randomId()}`,
        oldStatus,
        newStatus,
        changedAt: new Date(timestamp).toISOString(),
        operatorOpenId: String(user?.openId || '').trim(),
        operatorName: String(user?.name || '').trim(),
      },
    ],
  };
}

function appendSystemComment(document, user, content, timestamp, randomId) {
  return {
    version: 1,
    items: [
      ...(Array.isArray(document?.items) ? document.items : []),
      {
        id: `comment-${timestamp}-${randomId()}`,
        authorOpenId: String(user?.openId || '').trim(),
        authorName: String(user?.name || '').trim(),
        authorAvatarUrl: String(user?.avatarUrl || '').trim(),
        createdAt: new Date(timestamp).toISOString(),
        content,
        mentionedOpenIds: [],
        mentionedUsers: [],
      },
    ],
    ...(document?.internal ? { internal: document.internal } : {}),
  };
}

function appendRelatedFeedback(document, item) {
  const items = Array.isArray(document?.items) ? document.items : [];
  return {
    version: 1,
    revision: Math.max(1, Number(document?.revision) || 1) + 1,
    items: [
      ...items.filter((entry) => entry.itemId !== item.itemId),
      item,
    ],
  };
}

function findExistingDraftAuthor(results, itemId) {
  return results?.items?.find((item) => item.itemId === itemId)?.feedbackDraft?.author || null;
}

function parseStoredDocument(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  const text = normalizeText(value);
  if (!text) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeComments(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || '').trim(),
    authorOpenId: String(item?.authorOpenId || '').trim(),
    authorName: String(item?.authorName || '').trim(),
    authorAvatarUrl: String(item?.authorAvatarUrl || '').trim(),
    createdAt: normalizeTimestamp(item?.createdAt),
    content: String(item?.content || '').trim(),
    mentionedOpenIds: Array.isArray(item?.mentionedOpenIds) ? item.mentionedOpenIds : [],
    mentionedUsers: Array.isArray(item?.mentionedUsers) ? item.mentionedUsers : [],
  })).filter((item) => item.id && item.content);
}

function normalizeStatusChanges(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || '').trim(),
    oldStatus: String(item?.oldStatus || '').trim(),
    newStatus: String(item?.newStatus || '').trim(),
    changedAt: normalizeTimestamp(item?.changedAt),
    operatorOpenId: String(item?.operatorOpenId || '').trim(),
    operatorName: String(item?.operatorName || '').trim(),
  })).filter((item) => item.id && item.newStatus);
}

function normalizeAttachments(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    fileToken: String(item?.file_token || item?.fileToken || '').trim(),
    name: String(item?.name || '').trim(),
    size: Number(item?.size) || 0,
    mimeType: String(item?.type || item?.mimeType || '').trim(),
  })).filter((item) => item.fileToken);
}

function normalizeUsers(value) {
  return uniqueUsers(Array.isArray(value) ? value : value ? [value] : []);
}

function uniqueUsers(value) {
  const result = [];
  const seen = new Set();
  for (const user of Array.isArray(value) ? value : []) {
    const normalized = toStoredUser(user);
    const key = userKey(normalized);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function toStoredUser(user) {
  return {
    openId: String(user?.openId || user?.open_id || user?.id || '').trim(),
    userId: String(user?.userId || user?.user_id || '').trim(),
    unionId: String(user?.unionId || user?.union_id || '').trim(),
    email: String(user?.email || '').trim(),
    name: String(user?.name || user?.en_name || user?.email || '').trim(),
    avatarUrl: String(user?.avatarUrl || user?.avatar_url || '').trim(),
  };
}

function toBitableUser(user) {
  const normalized = toStoredUser(user);
  return {
    id: normalized.openId || normalized.userId || normalized.email || normalized.name,
    open_id: normalized.openId,
    name: normalized.name,
  };
}

function sameUser(left, right) {
  const leftKeys = new Set(userKeys(left));
  return userKeys(right).some((key) => leftKeys.has(key));
}

function userKey(user) {
  return userKeys(user)[0] || '';
}

function userKeys(user) {
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

function normalizeText(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean).join('');
  }
  if (value && typeof value === 'object') {
    return normalizeText(value.text ?? value.value ?? value.name ?? '');
  }
  return String(value ?? '').trim();
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripError(document) {
  const { error: _error, ...value } = document || {};
  return value;
}

function getRecordId(record) {
  return String(record?.record_id || record?.recordId || record?.id || '').trim();
}

function requireMutationId(value) {
  if (!String(value || '').trim()) {
    throw httpError('缺少 clientMutationId', 400);
  }
}

function tableMutationKey(projectId) {
  return `test-task-table:${projectId}`;
}

function recordMutationKey(projectId, recordId) {
  return `test-task:${projectId}:${recordId}`;
}

function revisionConflict(message, task) {
  const error = httpError(message, 409);
  error.publicDetails = { task };
  return error;
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
