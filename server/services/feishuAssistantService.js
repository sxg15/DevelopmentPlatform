import crypto from 'node:crypto';
import {
  FEISHU_ASSISTANT_CARD_ACTIONS,
  FEISHU_ASSISTANT_INTENTS,
  createEmptyAssistantDraft,
  getAssistantDraftMissingFields,
  mergeAssistantDraft,
  normalizeAssistantIntent,
  normalizeAssistantToolId,
  rankAssistantTasks,
} from '../../shared/feishuAssistantDefinitions.js';

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'message', 'draftPatch'],
  properties: {
    intent: {
      type: 'string',
      enum: Object.values(FEISHU_ASSISTANT_INTENTS),
    },
    message: {
      type: 'string',
      minLength: 1,
      maxLength: 2_000,
    },
    draftPatch: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        toolId: { type: 'string', enum: ['requirements', 'bugs'] },
        title: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: 5_000 },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
        expectedDays: { type: ['number', 'null'], minimum: 0, maximum: 3650 },
      },
    },
    assigneeDecision: {
      type: 'string',
      enum: ['keep', 'use_mentions', 'unknown'],
    },
  },
});

export function createFeishuAssistantService({
  config = {},
  repository,
  codexClient = null,
  skillPath = '',
  cwd = '',
  listAccessibleProjects = async () => [],
  listAssignedTasks = async () => ({ items: [], warnings: [] }),
  createWorkItem = async () => {
    throw new Error('机器人建单服务未配置');
  },
  deliver = async () => {},
  onError = () => {},
} = {}) {
  const activeOwners = new Set();
  const model = normalizeText(config.model, 'gpt-5.6-luna');
  const reasoningEffort = normalizeText(config.reasoningEffort, 'none');
  const fallbackModel = normalizeText(config.fallbackModel, 'gpt-5.6-terra');
  const fallbackReasoningEffort = normalizeText(config.fallbackReasoningEffort, 'low');
  const requestTimeoutMs = normalizePositiveInteger(config.requestTimeoutMs, 15_000);
  const pollIntervalMs = normalizePositiveInteger(config.pollIntervalMs, 2_000);
  const actionTtlMs = normalizePositiveInteger(config.draftTtlHours, 24) * 60 * 60_000;
  const retentionDays = normalizePositiveInteger(config.retentionDays, 30);
  const outboundLimit = 20;
  let timer = null;
  let started = false;

  function isEnabled() {
    return config.enabled === true;
  }

  function start() {
    if (started || !isEnabled()) {
      return;
    }
    started = true;
    repository.recoverQueuedInbound();
    repository.discardUnsafePendingOutbound();
    repository.prune({ retentionDays });
    void drainAll();
    timer = setInterval(() => {
      void drainAll();
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    started = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getHealth() {
    return {
      enabled: isEnabled(),
      started,
      activeOwnerCount: activeOwners.size,
    };
  }

  function handleMessage(event) {
    if (!isEnabled()) {
      return { accepted: false, reason: 'disabled' };
    }
    if (event?.chatType !== 'p2p') {
      return { accepted: false, reason: 'unsupported_chat' };
    }
    if (!String(event?.ownerOpenId || '').trim() || !String(event?.text || '').trim()) {
      return { accepted: false, reason: 'invalid_message' };
    }
    const inserted = repository.enqueueInbound(event);
    if (inserted) {
      void drainOwner(event.ownerOpenId);
    }
    return { accepted: inserted, reason: inserted ? '' : 'duplicate' };
  }

  async function handleCardAction({ ownerOpenId, actionId }) {
    if (!isEnabled()) {
      return { ok: false, message: '机器人未启用' };
    }
    const action = repository.consumeCardAction({ actionId, ownerOpenId });
    if (action.status === 'missing') {
      return { ok: false, message: '此操作无效或不属于当前用户' };
    }
    if (action.status === 'consumed') {
      return { ok: false, message: '此操作已处理' };
    }
    if (action.status === 'expired') {
      return { ok: false, message: '此确认已过期，请重新发起或继续对话' };
    }

    try {
      const conversation = repository.getConversation(ownerOpenId);
      if (!conversation || conversation.draftVersion !== action.draftVersion) {
        await queueText(ownerOpenId, '当前草稿已更新，请根据最新消息继续操作。');
        return { ok: false, message: '草稿已更新' };
      }

      switch (action.actionType) {
        case FEISHU_ASSISTANT_CARD_ACTIONS.SELECT_PROJECT:
          return updateDraftProject(conversation, action.payload.projectId);
        case FEISHU_ASSISTANT_CARD_ACTIONS.SET_ASSIGNEE_UNKNOWN:
          return setUnknownAssignee(conversation);
        case FEISHU_ASSISTANT_CARD_ACTIONS.CANCEL_DRAFT:
          repository.clearDraft(ownerOpenId);
          await queueText(ownerOpenId, '已取消当前建单草稿。');
          return { ok: true, message: '已取消' };
        case FEISHU_ASSISTANT_CARD_ACTIONS.CONFIRM_CREATE:
          return confirmCreate(conversation, action.payload.mutationId);
        default:
          return { ok: false, message: '不支持的操作' };
      }
    } catch (error) {
      onError(error);
      await queueText(ownerOpenId, formatSafeError(error, '处理卡片操作失败，请稍后重试。'));
      return { ok: false, message: '处理失败' };
    } finally {
      await flushOutbound();
    }
  }

  async function drainAll() {
    if (!started) {
      return;
    }
    await flushOutbound();
    const ownerOpenId = repository.getNextQueuedInboundOwner();
    if (!ownerOpenId || activeOwners.has(ownerOpenId)) {
      return;
    }
    await drainOwner(ownerOpenId);
  }

  async function drainOwner(ownerOpenId) {
    if (activeOwners.has(ownerOpenId)) {
      return;
    }
    activeOwners.add(ownerOpenId);
    try {
      let inbound = repository.claimNextInbound(ownerOpenId);
      while (inbound) {
        try {
          await processInbound(inbound);
          repository.completeInbound(inbound.eventId);
        } catch (error) {
          onError(error);
          repository.completeInbound(inbound.eventId);
          await queueText(
            inbound.ownerOpenId,
            formatSafeError(error, '机器人暂时无法处理这条消息，请稍后重试。'),
            inbound.messageId,
          );
          break;
        } finally {
          await flushOutbound();
        }
        inbound = repository.claimNextInbound(ownerOpenId);
      }
    } finally {
      activeOwners.delete(ownerOpenId);
    }
  }

  async function processInbound(inbound) {
    let conversation = repository.getConversation(inbound.ownerOpenId);
    if (!conversation) {
      conversation = repository.saveConversation({
        ownerOpenId: inbound.ownerOpenId,
        ownerName: inbound.ownerName,
        chatId: inbound.chatId,
        draft: createEmptyAssistantDraft(),
        draftVersion: 0,
      });
    }

    if (!codexClient) {
      await queueText(
        inbound.ownerOpenId,
        '当前 Codex 服务不可用。你仍可发送“我的待办”查看已分配任务。',
        inbound.messageId,
      );
      return;
    }

    const projects = await listAccessibleProjects({ user: toUser(inbound) });
    const output = await runCodexTurn({
      conversation,
      inbound,
      projects,
    });
    const intent = normalizeAssistantIntent(output.intent);
    const message = String(output.message || '').trim().slice(0, 2_000);
    if (
      intent === FEISHU_ASSISTANT_INTENTS.LIST_MY_TASKS
      || intent === FEISHU_ASSISTANT_INTENTS.RECOMMEND_NEXT
    ) {
      const result = await listAssignedTasks({
        user: toUser(inbound),
        recommend: intent === FEISHU_ASSISTANT_INTENTS.RECOMMEND_NEXT,
      });
      const items = rankAssistantTasks(result?.items || []);
      await queueText(
        inbound.ownerOpenId,
        formatTaskReply(
          items,
          result?.warnings || [],
          intent === FEISHU_ASSISTANT_INTENTS.RECOMMEND_NEXT,
        ),
        inbound.messageId,
      );
      return;
    }
    if (intent === FEISHU_ASSISTANT_INTENTS.CANCEL_DRAFT) {
      repository.clearDraft(inbound.ownerOpenId);
      await queueText(inbound.ownerOpenId, '已取消当前建单草稿。', inbound.messageId);
      return;
    }
    if (
      intent === FEISHU_ASSISTANT_INTENTS.CREATE_REQUIREMENT
      || intent === FEISHU_ASSISTANT_INTENTS.CREATE_BUG
      || intent === FEISHU_ASSISTANT_INTENTS.CONTINUE_DRAFT
    ) {
      const requestedToolId = intent === FEISHU_ASSISTANT_INTENTS.CREATE_BUG
        ? 'bugs'
        : intent === FEISHU_ASSISTANT_INTENTS.CREATE_REQUIREMENT
          ? 'requirements'
          : conversation.draft.toolId;
      if (hasActiveDraft(conversation.draft) && requestedToolId !== conversation.draft.toolId) {
        await queueText(
          inbound.ownerOpenId,
          '当前已有另一条未确认草稿。请先发送“取消当前操作”，再创建不同类型的工作项。',
          inbound.messageId,
        );
        return;
      }
      conversation = saveDraft(conversation, mergeAssistantDraft(
        hasActiveDraft(conversation.draft)
          ? conversation.draft
          : createEmptyAssistantDraft(requestedToolId),
        {
          ...(output.draftPatch || {}),
          toolId: requestedToolId,
          ...buildAssigneeDraftPatch(output.assigneeDecision, inbound.mentions),
        },
      ));
      await presentDraft(conversation, inbound.messageId, message);
      return;
    }

    await queueText(
      inbound.ownerOpenId,
      message || '我可以帮你创建需求或 Bug，也可以查询“我的待办”和“优先做什么”。',
      inbound.messageId,
    );
  }

  async function runCodexTurn({ conversation, inbound, projects }) {
    const prompt = buildAssistantPrompt({
      text: inbound.text,
      conversation,
      mentions: normalizeMentions(inbound.mentions),
      projects,
    });
    const run = async ({
      threadId,
      selectedModel,
      selectedReasoningEffort,
    }) => {
      let capturedThreadId = '';
      const result = await codexClient.runTurn({
        threadId,
        cwd,
        skillPath,
        skillName: 'feishu-assistant',
        prompt,
        outputSchema: OUTPUT_SCHEMA,
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        requestTimeoutMs,
        onThread(nextThreadId) {
          capturedThreadId = nextThreadId;
        },
      });
      return {
        result,
        threadId: capturedThreadId || String(result?.threadId || '').trim(),
      };
    };

    let completed;
    try {
      completed = await run({
        threadId: conversation.codexThreadId,
        selectedModel: model,
        selectedReasoningEffort: reasoningEffort,
      });
    } catch (error) {
      if (error?.code !== 'codex_model_unavailable') {
        throw error;
      }
      completed = await run({
        threadId: '',
        selectedModel: fallbackModel,
        selectedReasoningEffort: fallbackReasoningEffort,
      });
    }

    const output = parseAssistantOutput(completed.result?.content);
    repository.saveConversation({
      ...conversation,
      ownerName: inbound.ownerName,
      chatId: inbound.chatId,
      codexThreadId: completed.threadId || conversation.codexThreadId,
      contextSummary: appendContextSummary(conversation.contextSummary, inbound.text, output.message),
    });
    return output;
  }

  async function presentDraft(conversation, replyToMessageId, leadingMessage = '') {
    const missing = getAssistantDraftMissingFields(conversation.draft);
    if (leadingMessage) {
      await queueText(conversation.ownerOpenId, leadingMessage, replyToMessageId);
    }
    if (missing.includes('project')) {
      const projects = await listAccessibleProjects({
        user: { openId: conversation.ownerOpenId, name: conversation.ownerName },
      });
      await queueCard(
        conversation.ownerOpenId,
        await buildProjectCard(conversation, projects),
      );
      return;
    }
    if (missing.includes('title') || missing.includes('description')) {
      const labels = [
        missing.includes('title') ? '标题' : '',
        missing.includes('description') ? '具体描述' : '',
      ].filter(Boolean).join('和');
      await queueText(conversation.ownerOpenId, `还需要补充${labels}。`, replyToMessageId);
      return;
    }
    if (missing.includes('assignee')) {
      await queueCard(conversation.ownerOpenId, await buildAssigneeCard(conversation));
      return;
    }
    await queueCard(conversation.ownerOpenId, await buildConfirmCard(conversation));
  }

  function saveDraft(conversation, draft) {
    return repository.saveConversation({
      ...conversation,
      draft,
      draftVersion: conversation.draftVersion + 1,
    });
  }

  async function updateDraftProject(conversation, projectId) {
    const projects = await listAccessibleProjects({
      user: { openId: conversation.ownerOpenId, name: conversation.ownerName },
    });
    const project = (Array.isArray(projects) ? projects : []).find((item) => (
      String(item?.projectId || '') === String(projectId || '')
      && canUseTool(item, conversation.draft.toolId)
    ));
    if (!project) {
      await queueText(conversation.ownerOpenId, '你已无法访问所选项目，请重新选择。');
      return { ok: false, message: '项目不可用' };
    }
    const next = saveDraft(conversation, mergeAssistantDraft(conversation.draft, {
      projectId: project.projectId,
    }));
    await presentDraft(next, '', `已选择项目：${project.projectName || project.projectId}`);
    return { ok: true, message: '已选择项目' };
  }

  async function setUnknownAssignee(conversation) {
    const next = saveDraft(conversation, mergeAssistantDraft(conversation.draft, {
      assignees: [],
      needsAssigneeAssignment: true,
    }));
    await presentDraft(next, '', '将通知项目研发超级管理员分配处理人。');
    return { ok: true, message: '已选择待分配' };
  }

  async function confirmCreate(conversation, mutationId) {
    const missing = getAssistantDraftMissingFields(conversation.draft);
    if (missing.length > 0) {
      await presentDraft(conversation, '', '草稿信息不完整，请继续补充。');
      return { ok: false, message: '草稿不完整' };
    }
    const execution = repository.beginExecution({
      mutationId,
      ownerOpenId: conversation.ownerOpenId,
    });
    if (execution.state === 'completed') {
      await queueText(conversation.ownerOpenId, '该工作项已经创建完成。');
      return { ok: true, message: '已创建' };
    }
    const result = await createWorkItem({
      user: { openId: conversation.ownerOpenId, name: conversation.ownerName },
      projectId: conversation.draft.projectId,
      toolId: conversation.draft.toolId,
      draft: conversation.draft,
      sourceMutationId: mutationId,
    });
    repository.completeExecution(mutationId, result);
    repository.clearDraft(conversation.ownerOpenId);
    const label = conversation.draft.toolId === 'bugs' ? 'Bug' : '需求';
    const itemLabel = result?.item?.itemId
      ? `${result.item.itemId} ${result.item.title || ''}`.trim()
      : result?.item?.title || label;
    await queueText(conversation.ownerOpenId, `已创建${label}：${itemLabel}`);
    return { ok: true, message: '创建成功' };
  }

  async function queueText(ownerOpenId, content, replyToMessageId = '') {
    repository.enqueueOutbound(ownerOpenId, {
      type: 'text',
      content: String(content || '').trim().slice(0, 10_000),
      replyToMessageId: String(replyToMessageId || ''),
    });
  }

  async function queueCard(ownerOpenId, card) {
    repository.enqueueOutbound(ownerOpenId, {
      type: 'card',
      card,
    });
  }

  async function flushOutbound() {
    repository.discardUnsafePendingOutbound();
    for (const outbound of repository.listPendingOutbound(outboundLimit)) {
      try {
        await deliver(outbound.ownerOpenId, outbound.payload);
        repository.markOutboundSent(outbound.id);
      } catch (error) {
        onError(error);
        repository.markOutboundFailed(outbound.id);
      }
    }
  }

  async function buildProjectCard(conversation, projects) {
    const candidates = (Array.isArray(projects) ? projects : [])
      .filter((project) => canUseTool(project, conversation.draft.toolId))
      .slice(0, 12);
    if (candidates.length === 0) {
      return buildCard('无法创建工作项', [
        cardText('提示', '当前账号没有可提交该工作项的项目权限。'),
      ]);
    }
    const actions = candidates.map((project) => ({
      tag: 'button',
      type: 'primary',
      text: { tag: 'plain_text', content: String(project.projectName || project.projectId).slice(0, 40) },
      value: {
        actionId: createAction(conversation, FEISHU_ASSISTANT_CARD_ACTIONS.SELECT_PROJECT, {
          projectId: project.projectId,
        }),
      },
    }));
    return buildCard('选择归属项目', [
      cardText('工作项类型', conversation.draft.toolId === 'bugs' ? 'Bug' : '需求'),
      {
        tag: 'action',
        actions,
      },
    ], 'blue');
  }

  async function buildAssigneeCard(conversation) {
    const unknownAction = createAction(
      conversation,
      FEISHU_ASSISTANT_CARD_ACTIONS.SET_ASSIGNEE_UNKNOWN,
    );
    return buildCard('确定处理人', [
      cardText('指定人员', '请直接回复并 @ 提及具体处理人。'),
      cardText('无法确定', '也可以交由项目研发超级管理员分配。'),
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          type: 'default',
          text: { tag: 'plain_text', content: '暂不清楚，由研发超级管理员分配' },
          value: { actionId: unknownAction },
        }],
      },
    ], 'orange');
  }

  async function buildConfirmCard(conversation) {
    const draft = conversation.draft;
    const confirmAction = createAction(
      conversation,
      FEISHU_ASSISTANT_CARD_ACTIONS.CONFIRM_CREATE,
      { mutationId: crypto.randomUUID() },
    );
    const cancelAction = createAction(conversation, FEISHU_ASSISTANT_CARD_ACTIONS.CANCEL_DRAFT);
    return buildCard(`确认创建${draft.toolId === 'bugs' ? ' Bug' : '需求'}`, [
      cardText('标题', draft.title),
      cardText('描述', draft.description),
      cardText('优先级', draft.priority),
      ...(draft.expectedDays === null ? [] : [cardText('期望时限', `${draft.expectedDays} 天`)]),
      cardText(
        '处理人',
        draft.needsAssigneeAssignment
          ? '待研发超级管理员分配'
          : draft.assignees.map((user) => user.name || user.openId).join('、'),
      ),
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '确认创建' },
            value: { actionId: confirmAction },
          },
          {
            tag: 'button',
            type: 'default',
            text: { tag: 'plain_text', content: '取消' },
            value: { actionId: cancelAction },
          },
        ],
      },
    ], 'green');
  }

  function createAction(conversation, actionType, payload = {}) {
    return repository.createCardAction({
      ownerOpenId: conversation.ownerOpenId,
      actionType,
      payload,
      draftVersion: conversation.draftVersion,
      expiresAt: new Date(Date.now() + actionTtlMs),
    });
  }

  return {
    getHealth,
    handleCardAction,
    handleMessage,
    start,
    stop,
  };
}

export function parseAssistantOutput(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ''));
  } catch {
    throw new Error('Codex 返回的机器人指令格式不正确');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex 返回的机器人指令格式不正确');
  }
  return {
    intent: normalizeAssistantIntent(parsed.intent),
    message: String(parsed.message || '').trim().slice(0, 2_000),
    draftPatch: parsed.draftPatch && typeof parsed.draftPatch === 'object'
      ? parsed.draftPatch
      : null,
    assigneeDecision: ['keep', 'use_mentions', 'unknown'].includes(parsed.assigneeDecision)
      ? parsed.assigneeDecision
      : 'keep',
  };
}

function buildAssistantPrompt({ text, conversation, mentions, projects }) {
  const accessibleProjects = (Array.isArray(projects) ? projects : []).map((project) => ({
    projectId: String(project?.projectId || ''),
    projectName: String(project?.projectName || ''),
    allowedToolIds: (Array.isArray(project?.allowedTools) ? project.allowedTools : [])
      .map((tool) => String(tool?.id || '')).filter(Boolean),
  }));
  return [
    'You are a Chinese Feishu private-chat assistant for an internal development platform.',
    'Do not claim that work was created. You only classify intent and extract a draft patch.',
    'Return JSON matching the required schema. Do not include Markdown fences.',
    'Supported intents are create_requirement, create_bug, continue_draft, cancel_draft, help, list_my_tasks, recommend_next, unknown.',
    'For a new feature request, prefer create_requirement. For a defect, prefer create_bug.',
    'For pending-task questions, use list_my_tasks. For priority recommendations, use recommend_next.',
    'Never invent project IDs, people, deadlines, status, or permissions.',
    'The server handles project selection, assignee validation, confirmation cards, and all writes.',
    'When continuing a draft, use assigneeDecision=use_mentions only when the user explicitly mentioned the intended assignees; use unknown only when the user explicitly asks the project development administrator to assign someone.',
    `Current draft: ${JSON.stringify(conversation.draft)}`,
    `Known accessible projects: ${JSON.stringify(accessibleProjects)}`,
    `Mentioned people: ${JSON.stringify(mentions.map((item) => ({ openId: item.openId, name: item.name })))}`,
    `Conversation summary: ${String(conversation.contextSummary || '').slice(-8_000)}`,
    `User message: ${String(text || '').slice(0, 20_000)}`,
  ].join('\n');
}

function appendContextSummary(current, userText, assistantText) {
  const next = [
    String(current || '').slice(-8_000),
    `用户：${String(userText || '').slice(0, 1_000)}`,
    `助手：${String(assistantText || '').slice(0, 1_000)}`,
  ].filter(Boolean).join('\n');
  return next.slice(-12_000);
}

function buildCard(title, elements, template = 'blue') {
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements,
  };
}

function cardText(label, value) {
  return {
    tag: 'div',
    fields: [{
      is_short: false,
      text: {
        tag: 'lark_md',
        content: `**${escapeCardText(label)}**\n${escapeCardText(value)}`,
      },
    }],
  };
}

function escapeCardText(value) {
  return String(value || '').replace(/[<>]/g, '').slice(0, 6_000);
}

function normalizeMentions(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const openId = String(item?.openId || item?.open_id || '').trim();
    if (!openId || seen.has(openId)) {
      return [];
    }
    seen.add(openId);
    return [{
      openId,
      name: String(item?.name || item?.user_name || '').trim().slice(0, 200),
      userId: String(item?.userId || item?.user_id || '').trim().slice(0, 200),
      unionId: String(item?.unionId || item?.union_id || '').trim().slice(0, 200),
      email: String(item?.email || '').trim().slice(0, 320),
    }];
  });
}

function buildAssigneeDraftPatch(assigneeDecision, mentions) {
  if (assigneeDecision === 'unknown') {
    return {
      assignees: [],
      needsAssigneeAssignment: true,
    };
  }
  if (assigneeDecision === 'use_mentions') {
    return {
      assignees: normalizeMentions(mentions),
      needsAssigneeAssignment: false,
    };
  }
  return {};
}

function canUseTool(project, toolId) {
  return (Array.isArray(project?.allowedTools) ? project.allowedTools : [])
    .some((tool) => String(tool?.id || '') === normalizeAssistantToolId(toolId));
}

function hasActiveDraft(draft) {
  return Boolean(
    draft?.projectId
    || draft?.title
    || draft?.description
    || (Array.isArray(draft?.assignees) && draft.assignees.length > 0)
    || draft?.needsAssigneeAssignment,
  );
}

function formatTaskReply(items, warnings, recommend) {
  if (items.length === 0) {
    return '目前没有已分配给你的未完成工作项。';
  }
  const displayed = items.slice(0, 10);
  const header = recommend
    ? `建议优先处理：${formatTask(displayed[0])}`
    : `你有 ${items.length} 项未完成工作：`;
  const lines = displayed.map((item, index) => `${index + 1}. ${formatTask(item)}`);
  const warningText = (Array.isArray(warnings) && warnings.length > 0)
    ? `\n\n提示：${warnings.slice(0, 2).join('；')}`
    : '';
  return `${header}\n${lines.join('\n')}${warningText}`;
}

function formatTask(item) {
  const deadline = Number.isFinite(Number(item?.remainingDays))
    ? `，剩余 ${Number(item.remainingDays).toFixed(1)} 天`
    : '';
  return `[${item?.projectName || item?.projectId || '项目'}] ${item?.itemId || ''} ${item?.title || '未命名工作项'}（${item?.status || '未设置状态'}${deadline}）`;
}

function toUser(inbound) {
  return {
    openId: inbound.ownerOpenId,
    name: inbound.ownerName,
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeText(value, fallback) {
  return String(value || '').trim() || fallback;
}

function formatSafeError(error, fallback) {
  if (error?.code === 'codex_timeout') {
    return 'Codex 回复超时，请稍后重试。';
  }
  if (
    String(error?.code || '').startsWith('codex_')
    || /(?:\b5\d\d\b|bad gateway|upstream request failed|https?:\/\/|request id:)/i.test(
      String(error?.message || ''),
    )
  ) {
    return 'Codex 服务暂时不可用，请稍后重试。';
  }
  const message = String(error?.message || '').trim();
  return message && message.length <= 200 ? message : fallback;
}
