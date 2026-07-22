import {
  AI_CONVERSATION_STATUSES,
  AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS,
  isAiPlanningWorkItemTool,
  normalizeAiPlanSourceReferences,
} from '../../shared/aiPlanningDefinitions.js';
import { resolveAiProjectWorkspace } from '../security/projectWorkspaceResolver.js';

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['message', 'plan'],
  properties: {
    message: {
      type: 'string',
      minLength: 1,
      maxLength: 20_000,
    },
    plan: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'summary', 'markdown', 'sourceReferences'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            summary: { type: 'string', maxLength: 2_000 },
            markdown: { type: 'string', minLength: 1, maxLength: 200_000 },
            sourceReferences: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['rootId', 'relativePath', 'startLine', 'endLine', 'note'],
                properties: {
                  rootId: { type: 'string', minLength: 1, maxLength: 100 },
                  relativePath: { type: 'string', minLength: 1, maxLength: 500 },
                  startLine: { type: 'integer', minimum: 1 },
                  endLine: { type: 'integer', minimum: 1 },
                  note: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
      ],
    },
  },
});

export function createAiPlanningService({
  config,
  repository,
  scheduler,
  realtimeHub,
  codexClient,
  skillPath,
}) {
  const activeTasks = new Map();

  function assertAvailable() {
    if (!config.enabled || !codexClient) {
      const error = new Error('当前环境未启用 AI 计划');
      error.statusCode = 503;
      throw error;
    }
  }

  function listConversations({ user, projectId, toolId, recordId }) {
    assertSupportedTool(toolId);
    return repository.listConversations({
      ownerOpenId: getUserOpenId(user),
      projectId,
      toolId,
      recordId,
    }).map(serializeAiConversation);
  }

  function createConversation({ user, projectId, toolId, recordId, title }) {
    assertAvailable();
    assertSupportedTool(toolId);
    resolveAiProjectWorkspace(config, projectId);
    return serializeAiConversation(repository.createConversation({
      ownerOpenId: getUserOpenId(user),
      ownerName: getUserName(user),
      projectId,
      toolId,
      recordId,
      title,
    }));
  }

  function getConversation({ user, conversationId }) {
    return serializeAiConversation(
      repository.getConversation(conversationId, getUserOpenId(user)),
    );
  }

  function archiveConversation({ user, conversationId }) {
    return repository.archiveConversation(conversationId, getUserOpenId(user));
  }

  function sendMessage({
    user,
    conversationId,
    content,
    expectedVersion,
    clientMutationId,
    workItem,
    project,
  }) {
    assertAvailable();
    const ownerOpenId = getUserOpenId(user);
    const trimmedContent = String(content || '').trim();
    if (!trimmedContent) {
      throw createServiceError('请输入对话内容', 400);
    }
    if (trimmedContent.length > 20_000) {
      throw createServiceError('单条对话内容不能超过 20000 字', 400);
    }

    const appended = repository.appendUserMessage({
      conversationId,
      ownerOpenId,
      content: trimmedContent,
      expectedVersion,
      clientMutationId: String(clientMutationId || '').trim().slice(0, 100),
    });
    if (appended.missing) {
      throw createServiceError('对话不存在', 404);
    }
    if (appended.busy) {
      throw createServiceError('当前对话正在生成计划', 409, {
        conversation: serializeAiConversation(appended.conversation),
      });
    }
    if (appended.stale) {
      throw createServiceError('对话已在其他页面更新，请刷新后重试', 409, {
        conversation: serializeAiConversation(appended.conversation),
      });
    }
    if (appended.duplicate) {
      return {
        duplicate: true,
        conversation: serializeAiConversation(appended.conversation),
      };
    }

    const started = repository.startRun({
      conversationId,
      userMessageId: appended.message.id,
      model: config.codex.model,
    });
    if (started.busy) {
      throw createServiceError('当前对话正在生成计划', 409);
    }

    const taskState = {
      conversationId,
      ownerOpenId,
      runId: started.run.id,
      threadId: appended.conversation.codexThreadId,
      turnId: '',
      cancelRequested: false,
    };
    activeTasks.set(conversationId, taskState);
    publishSnapshot(conversationId, ownerOpenId);

    void scheduler.schedule({
      userKey: ownerOpenId,
      projectKey: appended.conversation.projectId,
      task: () => executeRun({
        taskState,
        conversation: appended.conversation,
        userMessage: appended.message,
        workItem,
        project,
      }),
    }).catch(() => {
      // executeRun persists and publishes every terminal failure.
    });

    return {
      duplicate: false,
      conversation: serializeAiConversation(
        repository.getConversation(conversationId, ownerOpenId),
      ),
    };
  }

  async function executeRun({
    taskState,
    conversation,
    userMessage,
    workItem,
    project,
  }) {
    try {
      if (taskState.cancelRequested) {
        throw createInterruptedError();
      }
      const workspace = resolveAiProjectWorkspace(config, conversation.projectId);
      const prompt = buildPlanningPrompt({
        conversation,
        userMessage,
        workItem,
        project,
        workspace,
      });
      const result = await codexClient.runTurn({
        threadId: conversation.codexThreadId,
        cwd: workspace.cwd,
        skillPath,
        prompt,
        outputSchema: OUTPUT_SCHEMA,
        onThread(threadId) {
          taskState.threadId = threadId;
          repository.setConversationThread(conversation.id, taskState.ownerOpenId, threadId);
        },
        onTurn(turnId) {
          taskState.turnId = turnId;
          repository.setRunTurnId(taskState.runId, turnId);
        },
      });
      if (taskState.cancelRequested) {
        throw createInterruptedError();
      }
      const output = parsePlanningOutput(result.content, workspace);
      repository.completeRun({
        runId: taskState.runId,
        conversationId: conversation.id,
        assistantContent: output.message,
        plan: output.plan,
      });
      publishSnapshot(conversation.id, taskState.ownerOpenId);
      realtimeHub.publish(conversation.id, taskState.ownerOpenId, 'run-completed', {
        runId: taskState.runId,
      });
    } catch (error) {
      const interrupted = taskState.cancelRequested || error?.code === 'interrupted';
      finishFailedRun(taskState, {
        status: interrupted ? 'interrupted' : 'failed',
        errorCode: interrupted ? 'interrupted' : 'codex_failed',
        errorMessage: interrupted ? '任务已取消' : sanitizeRunError(error, config),
      });
    } finally {
      if (activeTasks.get(conversation.id) === taskState) {
        activeTasks.delete(conversation.id);
      }
    }
  }

  async function cancelRun({ user, conversationId }) {
    const ownerOpenId = getUserOpenId(user);
    const conversation = repository.getConversation(conversationId, ownerOpenId);
    if (!conversation) {
      throw createServiceError('对话不存在', 404);
    }
    const run = conversation.activeRun;
    if (!run) {
      return conversation;
    }
    const taskState = activeTasks.get(conversationId);
    if (taskState) {
      taskState.cancelRequested = true;
    }
    if (taskState?.threadId && taskState?.turnId) {
      try {
        await codexClient.interrupt(taskState.threadId, taskState.turnId);
      } catch {
        // The local interrupted state remains authoritative if Codex already exited.
      }
    }
    finishFailedRun(taskState || {
      conversationId,
      ownerOpenId,
      runId: run.id,
    }, {
      status: 'interrupted',
      errorCode: 'interrupted',
      errorMessage: '任务已取消',
    });
    return serializeAiConversation(
      repository.getConversation(conversationId, ownerOpenId),
    );
  }

  function finishFailedRun(taskState, failure) {
    const run = repository.getRun(taskState.runId);
    if (run?.status !== 'running') {
      return;
    }
    repository.failRun({
      runId: taskState.runId,
      conversationId: taskState.conversationId,
      ...failure,
    });
    publishSnapshot(taskState.conversationId, taskState.ownerOpenId);
    realtimeHub.publish(taskState.conversationId, taskState.ownerOpenId, 'run-failed', {
      runId: taskState.runId,
      status: failure.status,
      message: failure.errorMessage,
    });
  }

  function subscribe({ response, user, conversationId }) {
    const ownerOpenId = getUserOpenId(user);
    const conversation = repository.getConversation(conversationId, ownerOpenId);
    if (!conversation) {
      throw createServiceError('对话不存在', 404);
    }
    return realtimeHub.subscribe(response, {
      conversationId,
      ownerOpenId,
      snapshot: serializeAiConversation(conversation),
    });
  }

  function createSubmission({
    user,
    conversationId,
    title,
    summary,
    markdown,
    sourceReferences,
    workItem,
    project,
  }) {
    const ownerOpenId = getUserOpenId(user);
    const conversation = repository.getConversation(conversationId, ownerOpenId);
    if (!conversation) {
      throw createServiceError('对话不存在', 404);
    }
    const draft = conversation.draft;
    const normalizedMarkdown = String(markdown ?? draft?.markdown ?? '').trim();
    if (!normalizedMarkdown) {
      throw createServiceError('方案 Markdown 不能为空', 400);
    }
    if (normalizedMarkdown.length > 200_000) {
      throw createServiceError('方案 Markdown 不能超过 200000 字', 400);
    }
    const workspace = resolveAiProjectWorkspace(config, conversation.projectId);
    const allowedRootIds = new Set(workspace.roots.map((root) => root.id));
    const normalizedReferences = normalizeAiPlanSourceReferences(
      sourceReferences ?? draft?.sourceReferences ?? [],
    )
      .filter((reference) => allowedRootIds.has(reference.rootId))
      .map((reference) => ({
        ...reference,
        note: redactWorkspacePaths(reference.note, workspace),
      }));
    const submission = repository.createSubmission({
      conversationId,
      ownerOpenId,
      title: redactWorkspacePaths(String(title ?? draft?.title ?? '').trim(), workspace),
      summary: redactWorkspacePaths(String(summary ?? draft?.summary ?? '').trim(), workspace),
      markdown: redactWorkspacePaths(normalizedMarkdown, workspace),
      sourceReferences: normalizedReferences,
      workItemId: String(workItem?.itemId || ''),
      workItemTitle: String(workItem?.title || ''),
      projectName: String(project?.projectName || ''),
    });
    return serializeSubmission(submission, user, { includeMarkdown: true });
  }

  function listSubmissions({
    user,
    projectId,
    allowedToolIds,
    toolId,
    search,
    status,
  }) {
    return repository.listSubmissions({
      projectId,
      allowedToolIds,
      toolId,
      search,
      status,
    }).map((submission) => serializeSubmission(submission, user, { includeMarkdown: false }));
  }

  function getSubmission({ user, submissionId, projectId, allowedToolIds }) {
    const submission = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !submission
      || submission.projectId !== projectId
      || !allowed.has(submission.toolId)
    ) {
      return null;
    }
    return serializeSubmission(submission, user, { includeMarkdown: true });
  }

  function adoptSubmission({ user, submissionId, projectId, allowedToolIds }) {
    const current = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !current
      || current.projectId !== projectId
      || !allowed.has(current.toolId)
    ) {
      return null;
    }
    const submission = repository.adoptSubmission(submissionId);
    return submission
      ? serializeSubmission(submission, user, { includeMarkdown: true })
      : null;
  }

  function withdrawSubmission({ user, submissionId, projectId, allowedToolIds }) {
    const current = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !current
      || current.projectId !== projectId
      || !allowed.has(current.toolId)
    ) {
      return null;
    }
    const submission = repository.withdrawSubmission(submissionId, getUserOpenId(user));
    return submission
      ? serializeSubmission(submission, user, { includeMarkdown: true })
      : null;
  }

  function publishSnapshot(conversationId, ownerOpenId) {
    const snapshot = repository.getConversation(conversationId, ownerOpenId);
    if (snapshot) {
      realtimeHub.publish(
        conversationId,
        ownerOpenId,
        'snapshot',
        serializeAiConversation(snapshot),
      );
    }
  }

  return {
    adoptSubmission,
    archiveConversation,
    cancelRun,
    createConversation,
    createSubmission,
    getConversation,
    getSubmission,
    isAvailable: () => Boolean(config.enabled && codexClient),
    listConversations,
    listSubmissions,
    sendMessage,
    subscribe,
    withdrawSubmission,
  };
}

export function parsePlanningOutput(content, workspace) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || '').trim());
  } catch {
    throw createServiceError('Codex 返回的计划格式不正确', 502);
  }
  const message = redactWorkspacePaths(String(parsed?.message || '').trim(), workspace);
  if (!message) {
    throw createServiceError('Codex 未返回对话内容', 502);
  }
  if (!parsed.plan) {
    return {
      message: message.slice(0, 20_000),
      plan: null,
    };
  }
  const markdown = redactWorkspacePaths(String(parsed.plan.markdown || '').trim(), workspace);
  const title = redactWorkspacePaths(String(parsed.plan.title || '').trim(), workspace);
  if (!title || !markdown) {
    throw createServiceError('Codex 返回的方案内容不完整', 502);
  }

  const allowedRootIds = new Set(workspace.roots.map((root) => root.id));
  const sourceReferences = normalizeAiPlanSourceReferences(parsed.plan.sourceReferences)
    .filter((reference) => allowedRootIds.has(reference.rootId))
    .map((reference) => ({
      ...reference,
      note: redactWorkspacePaths(reference.note, workspace),
    }));
  return {
    message: message.slice(0, 20_000),
    plan: {
      title: title.slice(0, 200),
      summary: redactWorkspacePaths(
        String(parsed.plan.summary || '').trim(),
        workspace,
      ).slice(0, 2_000),
      markdown: markdown.slice(0, 200_000),
      sourceReferences,
    },
  };
}

export function buildPlanningPrompt({
  conversation,
  userMessage,
  workItem,
  project,
  workspace,
}) {
  const roots = workspace.roots.map((root) => ({
    rootId: root.id,
    path: root.path,
    profile: root.profile,
  }));
  const workItemContext = limitSerializedValue(workItem, 40_000);
  return [
    'Generate or refine a read-only implementation plan for the current work item.',
    `Project: ${String(project?.projectName || conversation.projectId)} (${conversation.projectId})`,
    `Work item type: ${conversation.toolId}`,
    `Work item record ID: ${conversation.recordId}`,
    `Configured roots: ${JSON.stringify(roots)}`,
    `Current work item data: ${workItemContext}`,
    `User message: ${userMessage.content}`,
    '',
    'Inspect source only as needed. Do not modify anything or run builds/tests/installers.',
    'Use root-relative references and the configured rootId values. Never include absolute paths in the plan.',
    'If the user asks a question that does not yet warrant a full plan, answer it and return plan as null.',
  ].join('\n');
}

export function getAllowedAiPlanToolIds(allowedToolIds) {
  const allowed = allowedToolIds instanceof Set
    ? allowedToolIds
    : new Set(Array.isArray(allowedToolIds) ? allowedToolIds : []);
  return AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS.filter((toolId) => allowed.has(toolId));
}

export function redactWorkspacePaths(value, workspace) {
  let text = String(value || '');
  const replacements = (workspace?.roots || [])
    .flatMap((root) => {
      const rootPath = String(root?.path || '').trim().replace(/[\\/]+$/, '');
      if (!rootPath) {
        return [];
      }
      const replacement = `[root:${String(root.id || 'project')}]`;
      return [
        { source: rootPath, replacement },
        { source: rootPath.replaceAll('\\', '/'), replacement },
        { source: rootPath.replaceAll('/', '\\'), replacement },
      ];
    })
    .filter((item, index, items) => (
      item.source
      && items.findIndex((candidate) => candidate.source.toLowerCase() === item.source.toLowerCase()) === index
    ))
    .sort((left, right) => right.source.length - left.source.length);

  for (const { source, replacement } of replacements) {
    text = text.replace(new RegExp(escapeRegExp(source), 'gi'), replacement);
  }
  return text;
}

export function serializeAiConversation(conversation) {
  if (!conversation) {
    return null;
  }
  const result = {
    id: conversation.id,
    projectId: conversation.projectId,
    toolId: conversation.toolId,
    recordId: conversation.recordId,
    title: conversation.title,
    status: conversation.status,
    version: conversation.version,
    skillVersion: conversation.skillVersion,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
  if (Array.isArray(conversation.messages)) {
    result.messages = conversation.messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
  }
  result.draft = conversation.draft
    ? {
        title: conversation.draft.title,
        summary: conversation.draft.summary,
        markdown: conversation.draft.markdown,
        sourceReferences: normalizeAiPlanSourceReferences(
          conversation.draft.sourceReferences,
        ),
        updatedAt: conversation.draft.updatedAt,
      }
    : null;
  return result;
}

function assertSupportedTool(toolId) {
  if (!isAiPlanningWorkItemTool(toolId)) {
    throw createServiceError('AI 计划只支持需求和 Bug', 400);
  }
}

function getUserOpenId(user) {
  const openId = String(user?.openId || '').trim();
  if (!openId) {
    throw createServiceError('当前用户缺少 Open ID', 400);
  }
  return openId;
}

function getUserName(user) {
  return String(user?.name || user?.openId || '未知用户').trim().slice(0, 200);
}

function limitSerializedValue(value, maxLength) {
  const serialized = JSON.stringify(value ?? {});
  return serialized.length <= maxLength
    ? serialized
    : `${serialized.slice(0, maxLength)}...`;
}

function sanitizeRunError(error, config) {
  let message = error instanceof Error ? error.message : '生成计划失败';
  const sensitiveValues = [
    config?.codex?.apiKey,
    config?.codex?.apiBaseUrl,
    ...(config?.projects || []).flatMap((project) => (
      (project.roots || []).map((root) => root.path)
    )),
  ].map((value) => String(value || '')).filter(Boolean);
  message = String(message || '生成计划失败').replaceAll('\r', ' ').replaceAll('\n', ' ');
  for (const value of sensitiveValues) {
    message = message.replaceAll(value, '[REDACTED]');
  }
  return message.slice(0, 1000);
}

function createInterruptedError() {
  const error = new Error('任务已取消');
  error.code = 'interrupted';
  return error;
}

function createServiceError(message, statusCode, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicDetails = details;
  return error;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeSubmission(submission, user, { includeMarkdown }) {
  const openId = String(user?.openId || '').trim();
  const result = {
    ...submission,
    authorOpenId: undefined,
    isOwnPlan: Boolean(openId && submission.authorOpenId === openId),
  };
  if (!includeMarkdown) {
    result.markdown = undefined;
  }
  return result;
}
