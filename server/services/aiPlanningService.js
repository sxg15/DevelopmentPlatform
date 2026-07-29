import {
  AI_CONVERSATION_STATUSES,
  AI_MESSAGE_KINDS,
  AI_PLAN_SUPPORTED_WORK_ITEM_TOOL_IDS,
  AI_RUN_PROGRESS_STAGES,
  isAiPlanningWorkItemTool,
  normalizeAiPlanSourceReferences,
} from '../../shared/aiPlanningDefinitions.js';
import { isRecoverableCodexTransportError } from '../integrations/codexErrorUtils.js';
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
  runContextService = null,
  notificationService = null,
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

  function createConversation({
    user,
    projectId,
    toolId,
    recordId,
    title,
    clientMutationId = '',
  }) {
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
      clientMutationId,
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
      throw createServiceError(
        appended.conversation?.status === AI_CONVERSATION_STATUSES.AWAITING_USER
          ? '请先回答 Codex 正在等待的决策问题'
          : '当前对话正在生成计划',
        409,
        {
          conversation: serializeAiConversation(appended.conversation),
        },
      );
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

    scheduleRun({
      conversation: appended.conversation,
      userMessage: appended.message,
      run: started.run,
      ownerOpenId,
      workItem,
      project,
    });

    return {
      duplicate: false,
      conversation: serializeAiConversation(
        repository.getConversation(conversationId, ownerOpenId),
      ),
    };
  }

  function answerQuestions({
    user,
    conversationId,
    questionSetId,
    expectedVersion,
    clientMutationId,
    answers,
    additionalContext,
    workItem,
    project,
  }) {
    assertAvailable();
    const ownerOpenId = getUserOpenId(user);
    const conversation = repository.getConversation(conversationId, ownerOpenId);
    if (!conversation) {
      throw createServiceError('对话不存在', 404);
    }
    const mutationId = String(clientMutationId || '').trim().slice(0, 100);
    if (!mutationId) {
      throw createServiceError('缺少回答请求标识', 400);
    }
    const questionSet = conversation.pendingQuestionSet?.id === questionSetId
      ? conversation.pendingQuestionSet
      : repository.getQuestionSet(questionSetId);
    if (!questionSet || questionSet.conversationId !== conversationId) {
      throw createServiceError('待回答的问题不存在或已失效', 404);
    }
    if (
      questionSet.status === 'answered'
      && questionSet.answerClientMutationId === mutationId
    ) {
      return {
        duplicate: true,
        conversation: serializeAiConversation(conversation),
      };
    }
    const normalized = normalizeQuestionAnswers(
      questionSet.questions,
      answers,
      additionalContext,
    );
    const appended = repository.answerQuestionSet({
      conversationId,
      ownerOpenId,
      questionSetId,
      answers: normalized.answers,
      additionalContext: normalized.additionalContext,
      expectedVersion,
      clientMutationId: mutationId,
    });
    if (appended.missing) {
      throw createServiceError('待回答的问题不存在', 404);
    }
    if (appended.stale) {
      throw createServiceError('对话已在其他页面更新，请刷新后重试', 409, {
        conversation: serializeAiConversation(appended.conversation),
      });
    }
    if (appended.alreadyAnswered || appended.inactive) {
      throw createServiceError('该组问题已经回答或取消', 409, {
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
    scheduleRun({
      conversation: appended.conversation,
      userMessage: appended.message,
      run: started.run,
      ownerOpenId,
      workItem,
      project,
    });
    return {
      duplicate: false,
      conversation: serializeAiConversation(
        repository.getConversation(conversationId, ownerOpenId),
      ),
    };
  }

  function scheduleRun({
    conversation,
    userMessage,
    run,
    ownerOpenId,
    workItem,
    project,
  }) {
    const taskState = {
      conversationId: conversation.id,
      ownerOpenId,
      runId: run.id,
      threadId: conversation.codexThreadId,
      turnId: '',
      cancelRequested: false,
    };
    activeTasks.set(conversation.id, taskState);
    publishSnapshot(conversation.id, ownerOpenId);

    void scheduler.schedule({
      userKey: ownerOpenId,
      projectKey: conversation.projectId,
      task: () => executeRun({
        taskState,
        conversation,
        userMessage,
        workItem,
        project,
      }),
    }).catch(() => {
      // executeRun persists and publishes every terminal failure.
    });
  }

  async function executeRun({
    taskState,
    conversation,
    userMessage,
    workItem,
    project,
  }) {
    let runContext = null;
    try {
      reportRunProgress(taskState, {
        stage: AI_RUN_PROGRESS_STAGES.STARTING,
        message: '正在启动 Codex 只读运行环境',
      });
      if (taskState.cancelRequested) {
        throw createInterruptedError();
      }
      const workspace = resolveAiProjectWorkspace(config, conversation.projectId);
      runContext = runContextService
        ? await runContextService.prepare({
            runId: taskState.runId,
            workspace,
            workItem,
          })
        : {
            cwd: workspace.cwd,
            workspace,
            inputItems: [],
            attachmentSummary: null,
            attachmentContext: '',
          };
      if (runContext.attachmentSummary) {
        repository.setRunAttachmentSummary(taskState.runId, runContext.attachmentSummary);
        publishSnapshot(conversation.id, taskState.ownerOpenId);
      }
      const requiresQuestionRound = !hasCompletedQuestionRound(conversation);
      const prompt = buildPlanningPrompt({
        conversation,
        userMessage,
        workItem,
        project,
        workspace: runContext.workspace || workspace,
        attachmentContext: runContext.attachmentContext,
        requiresQuestionRound,
      });

      const runCodexTurn = ({
        threadId,
        turnPrompt,
        preludePrompt = '',
        inputItems = [],
      }) => codexClient.runTurn({
        threadId,
        cwd: runContext.cwd,
        skillPath,
        preludePrompt,
        prompt: turnPrompt,
        inputItems,
        outputSchema: OUTPUT_SCHEMA,
        onThread(threadIdValue) {
          taskState.threadId = threadIdValue;
          repository.setConversationThread(
            conversation.id,
            taskState.ownerOpenId,
            threadIdValue,
          );
        },
        onTurn(turnId) {
          taskState.turnId = turnId;
          repository.setRunTurnId(taskState.runId, turnId);
        },
        onProgress(progress) {
          reportRunProgress(taskState, progress);
        },
        onRequestUserInput(questions) {
          const awaited = repository.awaitUserInput({
            conversationId: conversation.id,
            ownerOpenId: taskState.ownerOpenId,
            runId: taskState.runId,
            questions,
          });
          if (awaited.missing || awaited.inactive) {
            throw createServiceError('AI 问题无法保存，对话状态已变化', 409);
          }
          publishSnapshot(conversation.id, taskState.ownerOpenId);
          realtimeHub.publish(
            conversation.id,
            taskState.ownerOpenId,
            'questions-required',
            { questionSetId: awaited.questionSet.id },
          );
          enqueueNotification('question_required', {
            eventKey: `ai:${taskState.runId}:question_required`,
            ownerOpenId: taskState.ownerOpenId,
            conversation,
            workItem,
            project,
            focus: 'questions',
            questionCount: questions.length,
          });
        },
      });

      const runCodexTurnWithRetry = async (options) => {
        try {
          return await runCodexTurn(options);
        } catch (error) {
          if (
            taskState.cancelRequested
            || !isRecoverableCodexTransportError(error)
          ) {
            throw error;
          }
          reportRunProgress(taskState, {
            stage: AI_RUN_PROGRESS_STAGES.ANALYZING,
            message: 'Codex 连接中断，正在自动重试',
          });
          const retryThreadId = taskState.threadId || options.threadId;
          return runCodexTurn({
            ...options,
            threadId: retryThreadId,
            preludePrompt: retryThreadId ? '' : options.preludePrompt,
          });
        }
      };

      let result = await runCodexTurnWithRetry({
        threadId: conversation.codexThreadId,
        turnPrompt: prompt,
        preludePrompt: conversation.codexThreadId
          ? ''
          : workspace.preludePrompt,
        inputItems: runContext.inputItems,
      });
      if (taskState.cancelRequested) {
        throw createInterruptedError();
      }
      if (requiresQuestionRound && !result.awaitingUser) {
        result = await runCodexTurnWithRetry({
          threadId: taskState.threadId,
          turnPrompt: buildRequiredQuestionRetryPrompt(),
        });
      }
      if (taskState.cancelRequested) {
        throw createInterruptedError();
      }
      if (result.awaitingUser) {
        return;
      }
      if (requiresQuestionRound) {
        throw createCodexProtocolError('Codex 未按要求发起首轮确认问题');
      }
      const outputWorkspace = {
        ...workspace,
        roots: [
          ...(workspace.roots || []),
          ...((runContext.workspace?.roots || []).filter((root) => (
            !(workspace.roots || []).some((item) => item.path === root.path)
          ))),
        ],
      };
      const output = parsePlanningOutput(result.content, outputWorkspace);
      repository.completeRun({
        runId: taskState.runId,
        conversationId: conversation.id,
        assistantContent: output.message,
        plan: output.plan,
      });
      publishSnapshot(conversation.id, taskState.ownerOpenId);
      realtimeHub.publish(conversation.id, taskState.ownerOpenId, 'run-completed', {
        status: 'completed',
      });
      if (output.plan?.markdown) {
        enqueueNotification('plan_ready', {
          eventKey: `ai:${taskState.runId}:plan_ready`,
          ownerOpenId: taskState.ownerOpenId,
          conversation,
          workItem,
          project,
          focus: 'plan',
        });
      }
    } catch (error) {
      const interrupted = taskState.cancelRequested || error?.code === 'interrupted';
      const errorCode = interrupted ? 'interrupted' : classifyRunError(error);
      finishFailedRun(taskState, {
        status: interrupted ? 'interrupted' : 'failed',
        errorCode,
        errorMessage: interrupted ? '任务已取消' : sanitizeRunError(error, config),
      });
      if (!interrupted) {
        enqueueNotification('run_failed', {
          eventKey: `ai:${taskState.runId}:run_failed`,
          ownerOpenId: taskState.ownerOpenId,
          conversation,
          workItem,
          project,
          focus: 'failure',
          errorMessage: sanitizeRunError(error, config),
        });
      }
    } finally {
      await runContext?.cleanup?.().catch(() => {});
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
    if (
      conversation.status === AI_CONVERSATION_STATUSES.AWAITING_USER
      && conversation.pendingQuestionSet
    ) {
      return serializeAiConversation(
        repository.cancelPendingQuestionSets(conversationId, ownerOpenId),
      );
    }
    if (!run) {
      return serializeAiConversation(conversation);
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

  function enqueueNotification(eventType, event) {
    try {
      notificationService?.enqueue(eventType, event);
    } catch {
      // Notification delivery never changes the AI run result.
    }
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
      status: failure.status,
      message: failure.errorMessage,
    });
  }

  function reportRunProgress(taskState, progress) {
    try {
      const updatedRun = repository.updateRunProgress({
        runId: taskState.runId,
        stage: progress?.stage,
        message: progress?.message,
      });
      if (updatedRun) {
        publishSnapshot(taskState.conversationId, taskState.ownerOpenId);
      }
    } catch {
      // Progress telemetry must not fail or cancel the underlying Codex run.
    }
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
    recordId,
    search,
    status,
  }) {
    return repository.listSubmissions({
      projectId,
      allowedToolIds,
      toolId,
      recordId,
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

  function getSubmissionRevisions({ user, submissionId, projectId, allowedToolIds }) {
    const current = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !current
      || current.projectId !== projectId
      || !allowed.has(current.toolId)
    ) {
      return [];
    }
    return repository.listSubmissionRevisions(current.rootSubmissionId)
      .map((submission) => serializeSubmission(submission, user, { includeMarkdown: false }));
  }

  function getSubmissionEvents({ submissionId, projectId, allowedToolIds }) {
    const current = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !current
      || current.projectId !== projectId
      || !allowed.has(current.toolId)
    ) {
      return [];
    }
    return repository.listSubmissionEvents(current.rootSubmissionId)
      .map(({ actorOpenId: _actorOpenId, ...event }) => event);
  }

  function approveSubmission({ user, submissionId, projectId, allowedToolIds }) {
    const current = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !current
      || current.projectId !== projectId
      || !allowed.has(current.toolId)
    ) {
      return null;
    }
    const submission = repository.approveSubmission(submissionId, {
      openId: getUserOpenId(user),
      name: getUserName(user),
    });
    return submission
      ? serializeSubmission(submission, user, { includeMarkdown: true })
      : null;
  }

  function adoptSubmission(options) {
    return approveSubmission(options);
  }

  function rejectSubmission({
    user,
    submissionId,
    projectId,
    allowedToolIds,
    reason,
  }) {
    const normalizedReason = String(reason || '').trim();
    if (!normalizedReason) {
      throw createServiceError('拒绝原因不能为空', 400);
    }
    if (normalizedReason.length > 2000) {
      throw createServiceError('拒绝原因不能超过 2000 字', 400);
    }
    const current = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !current
      || current.projectId !== projectId
      || !allowed.has(current.toolId)
    ) {
      return null;
    }
    const submission = repository.rejectSubmission(submissionId, {
      openId: getUserOpenId(user),
      name: getUserName(user),
    }, normalizedReason);
    return submission
      ? serializeSubmission(submission, user, { includeMarkdown: true })
      : null;
  }

  function createReviewRevision({
    user,
    submissionId,
    projectId,
    allowedToolIds,
    title,
    summary,
    markdown,
  }) {
    const current = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !current
      || current.projectId !== projectId
      || !allowed.has(current.toolId)
    ) {
      return null;
    }
    const normalizedTitle = String(title || '').trim();
    const normalizedSummary = String(summary || '').trim();
    const normalizedMarkdown = String(markdown || '').trim();
    if (!normalizedTitle || !normalizedMarkdown) {
      throw createServiceError('方案标题和 Markdown 不能为空', 400);
    }
    if (normalizedTitle.length > 200) {
      throw createServiceError('方案标题不能超过 200 字', 400);
    }
    if (normalizedSummary.length > 2000) {
      throw createServiceError('方案摘要不能超过 2000 字', 400);
    }
    if (normalizedMarkdown.length > 200_000) {
      throw createServiceError('方案 Markdown 不能超过 200000 字', 400);
    }
    const workspace = resolveAiProjectWorkspace(config, current.projectId);
    const submission = repository.createReviewRevision({
      submissionId,
      reviewer: {
        openId: getUserOpenId(user),
        name: getUserName(user),
      },
      title: redactWorkspacePaths(normalizedTitle, workspace),
      summary: redactWorkspacePaths(normalizedSummary, workspace),
      markdown: redactWorkspacePaths(normalizedMarkdown, workspace),
    });
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
    const submission = repository.withdrawSubmission(
      submissionId,
      getUserOpenId(user),
      getUserName(user),
    );
    return submission
      ? serializeSubmission(submission, user, { includeMarkdown: true })
      : null;
  }

  function deleteSubmission({ submissionId, projectId, allowedToolIds }) {
    const current = repository.getSubmission(submissionId);
    const allowed = new Set(allowedToolIds || []);
    if (
      !current
      || current.projectId !== projectId
      || !allowed.has(current.toolId)
    ) {
      return null;
    }
    const deleted = repository.deleteSubmissionChain(submissionId);
    return deleted
      ? { deletedCount: deleted.deletedCount }
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
    approveSubmission,
    answerQuestions,
    archiveConversation,
    cancelRun,
    createConversation,
    createReviewRevision,
    createSubmission,
    deleteSubmission,
    getConversation,
    getSubmission,
    getSubmissionEvents,
    getSubmissionRevisions,
    isAvailable: () => Boolean(config.enabled && codexClient),
    listConversations,
    listSubmissions,
    listPendingSubmissionsForWorkItem: (options) => repository
      .listPendingSubmissionsForWorkItem(options)
      .map((submission) => serializeSubmission(submission, null, { includeMarkdown: false })),
    countPendingSubmissionsForWorkItem: (options) => repository
      .countPendingSubmissionsForWorkItem(options),
    rejectSubmission,
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
  attachmentContext = '',
  requiresQuestionRound = false,
}) {
  const roots = workspace.roots.map((root) => ({
    rootId: root.id,
    path: root.path,
    profile: root.profile,
  }));
  const workItemContext = limitSerializedValue(
    stripPrivateWorkItemContext(workItem),
    40_000,
  );
  return [
    'Generate or refine a read-only implementation plan for the current work item.',
    `Project: ${String(project?.projectName || conversation.projectId)} (${conversation.projectId})`,
    `Work item type: ${conversation.toolId}`,
    `Work item record ID: ${conversation.recordId}`,
    `Configured roots: ${JSON.stringify(roots)}`,
    `Current work item data: ${workItemContext}`,
    `User message: ${userMessage.content}`,
    attachmentContext ? `Attachment context: ${attachmentContext}` : '',
    '',
    'Inspect source only as needed. Do not modify anything or run builds/tests/installers.',
    'Use root-relative references and the configured rootId values. Never include absolute paths in the plan.',
    ...(requiresQuestionRound ? [
      'This conversation has not completed its required user-confirmation round.',
      'Before creating any plan, you MUST call request_user_input once with 1 to 3 high-value clarification or confirmation questions, then stop this turn without returning a plan.',
      'Even if the implementation appears clear, ask the user to confirm the most consequential interpretation, desired outcome, acceptance criterion, scope boundary, priority, or tradeoff.',
    ] : [
      'If material implementation decisions remain unresolved, use request_user_input with 1 to 3 batched questions and stop this turn.',
    ]),
    'Put the recommended option first, allow a custom answer, never ask for secrets, and do not ask questions whose answer is available in source.',
    'Once uncertainty is resolved, automatically return a complete implementation plan.',
  ].join('\n');
}

export function hasCompletedQuestionRound(conversation) {
  return (Array.isArray(conversation?.messages) ? conversation.messages : [])
    .some((message) => message?.kind === AI_MESSAGE_KINDS.QUESTION_ANSWERS);
}

export function buildRequiredQuestionRetryPrompt() {
  return [
    'The previous turn returned without completing the required initial user-confirmation round.',
    'Do not produce, repeat, or refine a plan in this turn.',
    'Use request_user_input now with 1 to 3 high-value questions that help confirm the user intent before planning.',
    'Base the questions on the work item and repository evidence already inspected.',
    'Even if the implementation seems clear, confirm the most consequential desired outcome, acceptance criterion, scope boundary, priority, or tradeoff.',
    'Do not ask for information already available in source and do not ask for secrets.',
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
      kind: message.kind,
      content: message.content,
      payload: serializeMessagePayload(message),
      createdAt: message.createdAt,
    }));
  }
  if (Object.prototype.hasOwnProperty.call(conversation, 'latestRun')) {
    result.latestRun = conversation.latestRun
      ? {
          status: conversation.latestRun.status,
          errorCode: conversation.latestRun.errorCode,
          errorMessage: conversation.latestRun.errorMessage,
          startedAt: conversation.latestRun.startedAt,
          finishedAt: conversation.latestRun.finishedAt,
          progress: {
            stage: conversation.latestRun.progressStage,
            message: conversation.latestRun.progressMessage,
            updatedAt: conversation.latestRun.progressUpdatedAt,
            activityCount: conversation.latestRun.activityCount,
          },
          ...(conversation.latestRun.attachmentSummary
            ? { attachmentSummary: conversation.latestRun.attachmentSummary }
            : {}),
        }
      : null;
  }
  result.pendingQuestionSet = conversation.pendingQuestionSet
    ? serializePendingQuestionSet(conversation.pendingQuestionSet)
    : null;
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

function stripPrivateWorkItemContext(value) {
  if (Array.isArray(value)) {
    return value.map(stripPrivateWorkItemContext);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('_ai'))
      .map(([key, item]) => [key, stripPrivateWorkItemContext(item)]),
  );
}

function sanitizeRunError(error, config) {
  let message = error instanceof Error ? error.message : '生成计划失败';
  const sensitiveValues = [
    config?.codex?.apiKey,
    config?.codex?.apiBaseUrl,
    ...(config?.projects || []).map((project) => project.preludePrompt),
    ...(config?.projects || []).flatMap((project) => (
      (project.roots || []).map((root) => root.path)
    )),
  ].map((value) => String(value || '').replaceAll('\r', ' ').replaceAll('\n', ' '))
    .filter(Boolean);
  message = String(message || '生成计划失败').replaceAll('\r', ' ').replaceAll('\n', ' ');
  for (const value of sensitiveValues) {
    message = message.replaceAll(value, '[REDACTED]');
  }
  return message.slice(0, 1000);
}

function classifyRunError(error) {
  const code = String(error?.code || '').trim();
  if (isRecoverableCodexTransportError(error)) {
    return 'codex_transport';
  }
  if ([
    'codex_timeout',
    'codex_process_exit',
    'codex_runtime_missing',
    'codex_protocol',
    'codex_empty_output',
    'codex_failed',
  ].includes(code)) {
    return code;
  }
  const message = String(error?.message || '');
  if (/超时|timed?\s*out|timeout/i.test(message)) {
    return 'codex_timeout';
  }
  if (/格式不正确|invalid.*json|json.*invalid/i.test(message)) {
    return 'codex_invalid_output';
  }
  if (/进程.*退出|process.*exit/i.test(message)) {
    return 'codex_process_exit';
  }
  return 'codex_failed';
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

function createCodexProtocolError(message) {
  const error = createServiceError(message, 502);
  error.code = 'codex_protocol';
  return error;
}

function normalizeQuestionAnswers(questions, value, additionalContext) {
  const submitted = Array.isArray(value) ? value : [];
  const answerById = new Map();
  let totalLength = 0;
  for (const answer of submitted) {
    const questionId = String(answer?.questionId || '').trim();
    if (!questionId || answerById.has(questionId)) {
      throw createServiceError('问题回答格式不正确', 400);
    }
    answerById.set(questionId, answer);
  }

  const answers = questions.map((question) => {
    const answer = answerById.get(question.id);
    if (!answer) {
      throw createServiceError('请回答全部问题后再继续', 400);
    }
    const optionLabel = String(answer.optionLabel || '').trim();
    const customText = String(answer.customText || '').trim();
    if (customText.length > 4_000) {
      throw createServiceError('单个自定义回答不能超过 4000 字', 400);
    }
    const optionLabels = new Set((question.options || []).map((option) => option.label));
    if (optionLabel && !optionLabels.has(optionLabel)) {
      throw createServiceError('选择的回答选项已失效，请刷新后重试', 409);
    }
    if ((question.options || []).length > 0 && !optionLabel && !customText) {
      throw createServiceError('请选择一个选项或填写自定义回答', 400);
    }
    if ((question.options || []).length === 0 && !customText) {
      throw createServiceError('请填写问题答案', 400);
    }
    totalLength += optionLabel.length + customText.length;
    return {
      questionId: question.id,
      optionLabel,
      customText,
    };
  });
  const normalizedAdditionalContext = String(additionalContext || '').trim();
  if (normalizedAdditionalContext.length > 4_000) {
    throw createServiceError('补充期望不能超过 4000 字', 400);
  }
  totalLength += normalizedAdditionalContext.length;
  if (totalLength > 12_000) {
    throw createServiceError('本轮回答总长度不能超过 12000 字', 400);
  }
  return {
    answers,
    additionalContext: normalizedAdditionalContext,
  };
}

function serializePendingQuestionSet(questionSet) {
  return {
    id: questionSet.id,
    status: questionSet.status,
    questions: questionSet.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther,
      options: question.options,
    })),
    createdAt: questionSet.createdAt,
  };
}

function serializeMessagePayload(message) {
  if (message.kind === 'question_set') {
    const payload = message.payload || {};
    return {
      questionSetId: String(payload.questionSetId || ''),
      status: String(payload.status || ''),
      questions: (Array.isArray(payload.questions) ? payload.questions : []).map((question) => ({
        id: String(question?.id || ''),
        header: String(question?.header || ''),
        question: String(question?.question || ''),
        isOther: question?.isOther !== false,
        options: Array.isArray(question?.options) ? question.options : [],
      })),
    };
  }
  if (message.kind === 'question_answers') {
    const payload = message.payload || {};
    return {
      questionSetId: String(payload.questionSetId || ''),
      answers: (Array.isArray(payload.answers) ? payload.answers : []).map((answer) => ({
        questionId: String(answer?.questionId || ''),
        optionLabel: String(answer?.optionLabel || ''),
        customText: String(answer?.customText || ''),
      })),
      additionalContext: String(payload.additionalContext || ''),
    };
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeSubmission(submission, user, { includeMarkdown }) {
  const openId = String(user?.openId || '').trim();
  const result = {
    ...submission,
    authorOpenId: undefined,
    revisionAuthorOpenId: undefined,
    reviewedByOpenId: undefined,
    conversationId: undefined,
    isOwnPlan: Boolean(openId && submission.authorOpenId === openId),
  };
  if (!includeMarkdown) {
    result.markdown = undefined;
  }
  return result;
}
