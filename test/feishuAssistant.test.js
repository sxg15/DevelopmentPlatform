import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEmptyAssistantDraft,
  getAssistantDraftMissingFields,
  rankAssistantTasks,
} from '../shared/feishuAssistantDefinitions.js';
import { FeishuAssistantRepository } from '../server/repositories/feishuAssistantRepository.js';
import { createFeishuAssistantService } from '../server/services/feishuAssistantService.js';

test('assistant draft requires an explicit project, description and assignee decision', () => {
  const draft = createEmptyAssistantDraft('bugs');
  assert.deepEqual(getAssistantDraftMissingFields(draft), [
    'project',
    'title',
    'description',
    'assignee',
  ]);

  draft.projectId = 'P1';
  draft.title = 'Bug title';
  draft.description = 'Steps to reproduce';
  draft.needsAssigneeAssignment = true;
  assert.deepEqual(getAssistantDraftMissingFields(draft), []);
});

test('assistant task ranking favors overdue, imminent and higher priority work', () => {
  const ranked = rankAssistantTasks([
    { title: 'later P1', priority: 'P1', remainingDays: 3, proposedAt: 1 },
    { title: 'overdue P4', priority: 'P4', remainingDays: -1, proposedAt: 3 },
    { title: 'today P2', priority: 'P2', remainingDays: 0, proposedAt: 2 },
  ]);
  assert.deepEqual(ranked.map((item) => item.title), [
    'overdue P4',
    'today P2',
    'later P1',
  ]);
});

test('assistant routes greetings through Codex', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-feishu-assistant-greeting-'));
  const repository = new FeishuAssistantRepository(path.join(root, 'assistant.sqlite'));
  const delivered = [];
  const runs = [];
  const service = createFeishuAssistantService({
    config: {
      enabled: true,
      pollIntervalMs: 10,
      draftTtlHours: 1,
      retentionDays: 30,
    },
    repository,
    codexClient: {
      async runTurn(options) {
        runs.push(options);
        options.onThread?.('greeting-thread');
        return {
          content: JSON.stringify({
            intent: 'unknown',
            message: '我在。',
            draftPatch: null,
          }),
        };
      },
    },
    async deliver(ownerOpenId, payload) {
      delivered.push({ ownerOpenId, payload });
    },
  });
  try {
    service.start();
    service.handleMessage({
      eventId: 'greeting-event-1',
      ownerOpenId: 'user-1',
      ownerName: 'User',
      chatId: 'chat-1',
      chatType: 'p2p',
      messageId: 'message-1',
      text: '你在吗？',
      mentions: [],
    });
    await waitFor(() => delivered.length === 1);
    assert.equal(runs.length, 1);
    assert.equal(delivered[0].payload.content, '我在。');
  } finally {
    service.stop();
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assistant sends regular messages to the configured low-latency Codex turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-feishu-assistant-model-'));
  const repository = new FeishuAssistantRepository(path.join(root, 'assistant.sqlite'));
  const delivered = [];
  const runs = [];
  const service = createFeishuAssistantService({
    config: {
      enabled: true,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'none',
      fallbackModel: 'gpt-5.6-terra',
      fallbackReasoningEffort: 'low',
      requestTimeoutMs: 15_000,
      pollIntervalMs: 10,
      draftTtlHours: 1,
      retentionDays: 30,
    },
    repository,
    cwd: root,
    skillPath: path.join(root, 'skill.md'),
    codexClient: {
      async runTurn(options) {
        runs.push(options);
        options.onThread?.('luna-thread');
        return {
          content: JSON.stringify({
            intent: 'unknown',
            message: '已收到。',
            draftPatch: null,
          }),
        };
      },
    },
    async deliver(ownerOpenId, payload) {
      delivered.push({ ownerOpenId, payload });
    },
  });
  try {
    service.start();
    service.handleMessage(createInboundMessage({
      eventId: 'model-event-1',
      text: '帮我整理一个需求',
    }));
    await waitFor(() => delivered.length === 1);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].model, 'gpt-5.6-luna');
    assert.equal(runs[0].reasoningEffort, 'none');
    assert.equal(runs[0].requestTimeoutMs, 15_000);
    assert.equal(repository.getConversation('user-1').codexThreadId, 'luna-thread');
  } finally {
    service.stop();
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assistant retries only an unavailable model with Terra in a fresh thread', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-feishu-assistant-fallback-'));
  const repository = new FeishuAssistantRepository(path.join(root, 'assistant.sqlite'));
  const delivered = [];
  const runs = [];
  repository.saveConversation({
    ownerOpenId: 'user-1',
    ownerName: 'User',
    chatId: 'chat-1',
    codexThreadId: 'existing-thread',
    draft: createEmptyAssistantDraft(),
    draftVersion: 0,
  });
  const service = createFeishuAssistantService({
    config: {
      enabled: true,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'none',
      fallbackModel: 'gpt-5.6-terra',
      fallbackReasoningEffort: 'low',
      requestTimeoutMs: 15_000,
      pollIntervalMs: 10,
      draftTtlHours: 1,
      retentionDays: 30,
    },
    repository,
    cwd: root,
    skillPath: path.join(root, 'skill.md'),
    codexClient: {
      async runTurn(options) {
        runs.push(options);
        if (runs.length === 1) {
          throw Object.assign(new Error('model is not available'), {
            code: 'codex_model_unavailable',
          });
        }
        options.onThread?.('terra-thread');
        return {
          content: JSON.stringify({
            intent: 'unknown',
            message: '已切换到备用模型。',
            draftPatch: null,
          }),
        };
      },
    },
    async deliver(ownerOpenId, payload) {
      delivered.push({ ownerOpenId, payload });
    },
  });
  try {
    service.start();
    service.handleMessage(createInboundMessage({
      eventId: 'fallback-event-1',
      text: '帮我整理一个需求',
    }));
    await waitFor(() => delivered.length === 1);

    assert.equal(runs.length, 2);
    assert.equal(runs[0].threadId, 'existing-thread');
    assert.equal(runs[0].model, 'gpt-5.6-luna');
    assert.equal(runs[0].reasoningEffort, 'none');
    assert.equal(runs[1].threadId, '');
    assert.equal(runs[1].model, 'gpt-5.6-terra');
    assert.equal(runs[1].reasoningEffort, 'low');
    assert.equal(runs[1].requestTimeoutMs, 15_000);
    assert.equal(repository.getConversation('user-1').codexThreadId, 'terra-thread');
  } finally {
    service.stop();
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assistant does not retry Codex timeouts with the fallback model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-feishu-assistant-timeout-'));
  const repository = new FeishuAssistantRepository(path.join(root, 'assistant.sqlite'));
  const delivered = [];
  const runs = [];
  const service = createFeishuAssistantService({
    config: {
      enabled: true,
      pollIntervalMs: 10,
      draftTtlHours: 1,
      retentionDays: 30,
    },
    repository,
    codexClient: {
      async runTurn(options) {
        runs.push(options);
        throw Object.assign(new Error('Codex 生成计划超时'), { code: 'codex_timeout' });
      },
    },
    async deliver(ownerOpenId, payload) {
      delivered.push({ ownerOpenId, payload });
    },
  });
  try {
    service.start();
    service.handleMessage(createInboundMessage({
      eventId: 'timeout-event-1',
      text: '帮我整理一个需求',
    }));
    await waitFor(() => delivered.length >= 1);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].model, 'gpt-5.6-luna');
    assert.equal(runs[0].reasoningEffort, 'none');
    assert.equal(delivered[0].payload.content, 'Codex 回复超时，请稍后重试。');
  } finally {
    service.stop();
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assistant masks upstream Codex failures and deduplicates the Feishu message id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-feishu-assistant-upstream-failure-'));
  const repository = new FeishuAssistantRepository(path.join(root, 'assistant.sqlite'));
  const delivered = [];
  const runs = [];
  const service = createFeishuAssistantService({
    config: {
      enabled: true,
      pollIntervalMs: 10,
      draftTtlHours: 1,
      retentionDays: 30,
    },
    repository,
    codexClient: {
      async runTurn(options) {
        runs.push(options);
        throw Object.assign(new Error(
          'unexpected status 502 Bad Gateway: Upstream request failed, url: http://127.0.0.1:49999/responses',
        ), {
          code: 'codex_failed',
        });
      },
    },
    async deliver(ownerOpenId, payload) {
      delivered.push({ ownerOpenId, payload });
    },
  });
  try {
    service.start();
    const first = createInboundMessage({
      eventId: 'upstream-event-1',
      text: '帮我整理一个需求',
    });
    first.messageId = 'duplicate-message-id';
    assert.equal(service.handleMessage(first).accepted, true);
    await waitFor(() => delivered.length === 1);

    const duplicate = {
      ...first,
      eventId: 'upstream-event-2',
    };
    assert.deepEqual(service.handleMessage(duplicate), {
      accepted: false,
      reason: 'duplicate',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(runs.length, 1);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].payload.content, 'Codex 服务暂时不可用，请稍后重试。');
  } finally {
    service.stop();
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assistant discards persisted upstream failures before delivery resumes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-feishu-assistant-outbox-cleanup-'));
  const repository = new FeishuAssistantRepository(path.join(root, 'assistant.sqlite'));
  try {
    const now = new Date().toISOString();
    repository.database.prepare(`
      INSERT INTO assistant_outbox (
        id, owner_open_id, payload_json, status, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      'legacy-upstream-error',
      'user-1',
      JSON.stringify({
        type: 'text',
        content: 'unexpected status 502 Bad Gateway: Upstream request failed, url: http://127.0.0.1:49999/responses',
      }),
      now,
      now,
      now,
    );
    repository.enqueueOutbound('user-1', {
      type: 'text',
      content: '正常待发送消息',
    });

    assert.equal(repository.discardUnsafePendingOutbound(), 1);
    const pending = repository.listPendingOutbound(20);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].payload.content, '正常待发送消息');

    repository.enqueueOutbound('user-1', {
      type: 'text',
      content: 'request id: accidental-bridge-diagnostic',
    });
    assert.equal(repository.listPendingOutbound(20).length, 1);
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assistant repository deduplicates inbound events and protects one-time card actions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-feishu-assistant-'));
  const repository = new FeishuAssistantRepository(path.join(root, 'assistant.sqlite'));
  try {
    const event = {
      eventId: 'event-1',
      ownerOpenId: 'user-1',
      ownerName: 'User',
      chatId: 'chat-1',
      messageId: 'message-1',
      text: '创建需求',
      mentions: [],
    };
    assert.equal(repository.enqueueInbound(event), true);
    assert.equal(repository.enqueueInbound(event), false);
    const claimed = repository.claimNextInbound('user-1');
    assert.equal(claimed.text, '创建需求');
    repository.completeInbound('event-1');

    const conversation = repository.saveConversation({
      ownerOpenId: 'user-1',
      ownerName: 'User',
      chatId: 'chat-1',
      draft: createEmptyAssistantDraft(),
      draftVersion: 2,
    });
    const actionId = repository.createCardAction({
      ownerOpenId: conversation.ownerOpenId,
      actionType: 'cancel_draft',
      payload: {},
      draftVersion: conversation.draftVersion,
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(repository.consumeCardAction({ actionId, ownerOpenId: 'user-2' }).status, 'missing');
    assert.equal(repository.consumeCardAction({ actionId, ownerOpenId: 'user-1' }).status, 'ok');
    assert.equal(repository.consumeCardAction({ actionId, ownerOpenId: 'user-1' }).status, 'consumed');
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assistant completes a confirmed requirement draft without direct model writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-feishu-assistant-service-'));
  const repository = new FeishuAssistantRepository(path.join(root, 'assistant.sqlite'));
  const delivered = [];
  const created = [];
  const service = createFeishuAssistantService({
    config: {
      enabled: true,
      pollIntervalMs: 10,
      draftTtlHours: 1,
      retentionDays: 30,
    },
    repository,
    cwd: root,
    skillPath: path.join(root, 'skill.md'),
    codexClient: {
      async runTurn(options) {
        options.onThread?.('thread-1');
        const isAssigneeReply = options.prompt.includes('User message: @处理人');
        return {
          content: JSON.stringify({
            intent: isAssigneeReply ? 'continue_draft' : 'create_requirement',
            message: isAssigneeReply ? '已记录处理人。' : '我已整理出需求草稿。',
            draftPatch: isAssigneeReply ? null : {
              title: '导出版本清单',
              description: '支持将项目版本清单导出为 CSV。',
              priority: 'P2',
              expectedDays: 3,
            },
            ...(isAssigneeReply ? { assigneeDecision: 'use_mentions' } : {}),
          }),
        };
      },
    },
    async listAccessibleProjects() {
      return [{
        projectId: 'P1',
        projectName: '项目一',
        allowedTools: [{ id: 'requirements', label: '需求列表' }],
      }];
    },
    async createWorkItem(input) {
      created.push(input);
      return {
        project: { projectId: 'P1' },
        item: { itemId: 'R-0001', title: input.draft.title },
      };
    },
    async deliver(ownerOpenId, payload) {
      delivered.push({ ownerOpenId, payload });
    },
  });
  try {
    service.start();
    service.handleMessage({
      eventId: 'message-event-1',
      ownerOpenId: 'user-1',
      ownerName: 'User',
      chatId: 'chat-1',
      chatType: 'p2p',
      messageId: 'message-1',
      text: '三天内做一个导出版本清单功能',
      mentions: [],
    });
    await waitFor(() => delivered.some(({ payload }) => payload.type === 'card'));
    const projectCard = delivered.find(({ payload }) => payload.type === 'card').payload.card;
    const projectActionId = projectCard.elements.at(-1).actions[0].value.actionId;
    await service.handleCardAction({ ownerOpenId: 'user-1', actionId: projectActionId });
    await waitFor(() => delivered.filter(({ payload }) => payload.type === 'card').length >= 2);

    service.handleMessage({
      eventId: 'message-event-2',
      ownerOpenId: 'user-1',
      ownerName: 'User',
      chatId: 'chat-1',
      chatType: 'p2p',
      messageId: 'message-2',
      text: '@处理人',
      mentions: [{ openId: 'handler-1', name: '处理人' }],
    });
    await waitFor(() => delivered.filter(({ payload }) => payload.type === 'card').length >= 3);
    const cards = delivered.filter(({ payload }) => payload.type === 'card');
    const confirmCard = cards.at(-1).payload.card;
    const confirmActionId = confirmCard.elements.at(-1).actions[0].value.actionId;
    assert.equal(created.length, 0);
    await service.handleCardAction({ ownerOpenId: 'user-1', actionId: confirmActionId });
    assert.equal(created.length, 1);
    assert.equal(created[0].toolId, 'requirements');
    assert.equal(created[0].draft.assignees[0].openId, 'handler-1');
    assert.equal(repository.getConversation('user-1').draft.title, '');
  } finally {
    service.stop();
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createInboundMessage({
  eventId,
  text,
}) {
  return {
    eventId,
    ownerOpenId: 'user-1',
    ownerName: 'User',
    chatId: 'chat-1',
    chatType: 'p2p',
    messageId: `${eventId}-message`,
    text,
    mentions: [],
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for assistant result');
}
