import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  AI_PLAN_STATUSES,
  AI_PLAN_TOOL_ID,
  canAccessAiPlanTool,
  normalizeAiPlanSourceReferences,
} from '../shared/aiPlanningDefinitions.js';
import { AiPlanningRepository } from '../server/repositories/aiPlanningRepository.js';
import { ensureAiDataDirectories } from '../server/runtime/aiDataPaths.js';
import { createAiPlanningRealtimeHub } from '../server/runtime/aiPlanningRealtime.js';
import { createBoundedTaskScheduler } from '../server/runtime/boundedTaskScheduler.js';
import { createAiRunContextService } from '../server/services/aiRunContextService.js';
import { createAiPlanningNotificationService } from '../server/services/aiPlanningNotificationService.js';
import {
  buildPlanningPrompt,
  buildRequiredQuestionRetryPrompt,
  createAiPlanningService,
  getAllowedAiPlanToolIds,
  hasCompletedQuestionRound,
  parsePlanningOutput,
  serializeAiConversation,
} from '../server/services/aiPlanningService.js';

test('AI plan definitions keep source paths relative and permission-derived', () => {
  assert.equal(AI_PLAN_TOOL_ID, 'aiPlans');
  assert.equal(canAccessAiPlanTool(new Set(['requirements'])), true);
  assert.equal(canAccessAiPlanTool(['feedback']), false);
  assert.deepEqual(getAllowedAiPlanToolIds(new Set(['bugs', 'feedback'])), ['bugs']);
  assert.deepEqual(normalizeAiPlanSourceReferences([
    {
      rootId: 'main',
      relativePath: 'src\\app.js',
      startLine: 4,
      endLine: 8,
      note: 'entry',
    },
    {
      rootId: 'main',
      relativePath: '../secret.txt',
      startLine: 1,
      endLine: 1,
    },
  ]), [
    {
      rootId: 'main',
      relativePath: 'src/app.js',
      startLine: 4,
      endLine: 8,
      note: 'entry',
    },
  ]);
});

test('AI planning requires one completed question round before plan generation', () => {
  assert.equal(hasCompletedQuestionRound({ messages: [] }), false);
  assert.equal(hasCompletedQuestionRound({
    messages: [{ kind: 'question_set' }],
  }), false);
  assert.equal(hasCompletedQuestionRound({
    messages: [{ kind: 'question_answers' }],
  }), true);

  const prompt = buildPlanningPrompt({
    conversation: {
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'rec-1',
    },
    userMessage: { content: 'Generate a plan' },
    workItem: { title: 'Requirement' },
    project: { projectName: 'Project one' },
    workspace: { roots: [] },
    requiresQuestionRound: true,
  });
  assert.match(prompt, /MUST call request_user_input once/);
  assert.match(prompt, /without returning a plan/);
  assert.match(buildRequiredQuestionRetryPrompt(), /previous turn returned without/);
});

test('AI data directories are created with a writable probe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-data-'));
  try {
    const paths = ensureAiDataDirectories(root);
    assert.equal(fs.existsSync(paths.codexHome), true);
    assert.equal(fs.existsSync(paths.temp), true);
    assert.equal(fs.existsSync(paths.logs), true);
    assert.equal(
      fs.readdirSync(root).some((name) => name.startsWith('.write-probe-')),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI planning repository isolates conversations and preserves revisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-repository-'));
  const repository = new AiPlanningRepository(path.join(root, 'planning.sqlite'));
  try {
    const conversation = repository.createConversation({
      ownerOpenId: 'owner-a',
      ownerName: 'Owner A',
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'rec-1',
      title: 'Plan R1',
    });
    assert.equal(repository.getConversation(conversation.id, 'owner-b'), null);
    assert.equal(repository.listConversations({
      ownerOpenId: 'owner-b',
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'rec-1',
    }).length, 0);

    const appended = repository.appendUserMessage({
      conversationId: conversation.id,
      ownerOpenId: 'owner-a',
      content: 'Create a plan',
      expectedVersion: 1,
      clientMutationId: 'mutation-1',
    });
    const duplicate = repository.appendUserMessage({
      conversationId: conversation.id,
      ownerOpenId: 'owner-a',
      content: 'Create a plan',
      expectedVersion: 2,
      clientMutationId: 'mutation-1',
    });
    assert.equal(duplicate.duplicate, true);

    const started = repository.startRun({
      conversationId: conversation.id,
      userMessageId: appended.message.id,
      model: 'codex-test',
    });
    assert.equal(started.run.progressStage, 'queued');
    assert.equal(started.run.progressMessage, '任务已进入队列');
    assert.equal(started.run.activityCount, 1);
    const starting = repository.updateRunProgress({
      runId: started.run.id,
      stage: 'starting',
      message: '正在启动 Codex 只读运行环境',
    });
    assert.equal(starting.progressStage, 'starting');
    const nonRegressed = repository.updateRunProgress({
      runId: started.run.id,
      stage: 'queued',
      message: '不应回退',
    });
    assert.equal(nonRegressed.progressStage, 'starting');
    assert.equal(nonRegressed.progressMessage, '正在启动 Codex 只读运行环境');
    repository.updateRunProgress({
      runId: started.run.id,
      stage: 'analyzing',
      message: '正在读取项目结构和相关代码',
    });
    repository.completeRun({
      runId: started.run.id,
      conversationId: conversation.id,
      assistantContent: 'Plan ready',
      plan: {
        title: 'Implementation Plan',
        summary: 'Summary',
        markdown: '# Plan',
        sourceReferences: [],
      },
    });
    const completed = repository.getConversation(conversation.id, 'owner-a');
    assert.equal(completed.status, 'ready');
    assert.equal(completed.messages.length, 2);
    assert.equal(completed.draft.markdown, '# Plan');
    assert.equal(completed.latestRun.status, 'completed');
    assert.equal(completed.latestRun.progressStage, 'completed');
    assert.equal(completed.latestRun.progressMessage, '实施计划已生成');
    assert.ok(completed.latestRun.activityCount >= 5);

    const revisionOne = repository.createSubmission({
      conversationId: conversation.id,
      ownerOpenId: 'owner-a',
      title: 'Plan v1',
      summary: 'First',
      markdown: '# v1',
      sourceReferences: [],
      workItemId: 'REQ-001',
      workItemTitle: 'Requirement one',
      projectName: 'Project one',
    });
    const revisionTwo = repository.createSubmission({
      conversationId: conversation.id,
      ownerOpenId: 'owner-a',
      title: 'Plan v2',
      summary: 'Second',
      markdown: '# v2',
      sourceReferences: [],
      workItemId: 'REQ-001',
      workItemTitle: 'Requirement one',
      projectName: 'Project one',
    });
    assert.equal(revisionOne.revision, 1);
    assert.equal(revisionTwo.revision, 2);
    assert.equal(revisionTwo.parentSubmissionId, revisionOne.id);
    assert.equal(revisionTwo.workItemId, 'REQ-001');

    assert.equal(repository.getSubmission(revisionOne.id).status, AI_PLAN_STATUSES.SUPERSEDED);
    assert.equal(repository.getSubmission(revisionTwo.id).status, AI_PLAN_STATUSES.PENDING_REVIEW);
    assert.equal(repository.approveSubmission(revisionTwo.id, {
      openId: 'reviewer-a',
      name: 'Reviewer A',
    }).status, AI_PLAN_STATUSES.APPROVED);
    assert.deepEqual(
      repository.listApprovedSubmissionsForProjects({
        projectIds: ['P1'],
        toolIds: ['requirements'],
      }).map((submission) => submission.id),
      [revisionTwo.id],
    );

    const reviewRevision = repository.createReviewRevision({
      submissionId: revisionTwo.id,
      reviewer: { openId: 'reviewer-a', name: 'Reviewer A' },
      title: 'Plan v3',
      summary: 'Reviewer edit',
      markdown: '# v3',
    });
    assert.equal(reviewRevision.revision, 3);
    assert.equal(reviewRevision.status, AI_PLAN_STATUSES.PENDING_REVIEW);
    assert.equal(repository.getSubmission(revisionTwo.id).status, AI_PLAN_STATUSES.APPROVED);
    assert.equal(repository.rejectSubmission(
      reviewRevision.id,
      { openId: 'reviewer-b', name: 'Reviewer B' },
      '需要补充回滚步骤',
    ).status, AI_PLAN_STATUSES.REJECTED);
    assert.equal(repository.getSubmission(reviewRevision.id).reviewReason, '需要补充回滚步骤');
    assert.ok(repository.listSubmissionEvents(reviewRevision.rootSubmissionId).length >= 6);

    const revisionFour = repository.createSubmission({
      conversationId: conversation.id,
      ownerOpenId: 'owner-a',
      title: 'Plan v4',
      summary: 'Fourth',
      markdown: '# v4',
      sourceReferences: [],
      workItemId: 'REQ-001',
      workItemTitle: 'Requirement one',
      projectName: 'Project one',
    });
    assert.equal(repository.countPendingSubmissionsForWorkItem({
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'rec-1',
    }), 1);
    assert.equal(repository.withdrawSubmission(revisionFour.id, 'owner-b'), null);
    assert.equal(
      repository.withdrawSubmission(revisionFour.id, 'owner-a', 'Owner A').status,
      AI_PLAN_STATUSES.WITHDRAWN,
    );
    assert.equal(repository.listSubmissions({
      projectId: 'P1',
      allowedToolIds: ['bugs'],
    }).length, 0);
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI repository migrates legacy run tables with persistent progress columns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-migration-'));
  const databasePath = path.join(root, 'planning.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
  `);
  database.close();

  const repository = new AiPlanningRepository(databasePath);
  try {
    const columns = repository.database.prepare('PRAGMA table_info(runs)').all()
      .map((column) => column.name);
    assert.ok(columns.includes('progress_stage'));
    assert.ok(columns.includes('progress_message'));
    assert.ok(columns.includes('progress_updated_at'));
    assert.ok(columns.includes('activity_count'));
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI repository migrates legacy plan statuses and keeps one pending revision per chain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-plan-migration-'));
  const databasePath = path.join(root, 'planning.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      owner_open_id TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      codex_thread_id TEXT NOT NULL DEFAULT '',
      skill_version TEXT NOT NULL DEFAULT '1',
      context_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE plan_submissions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      author_open_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      markdown TEXT NOT NULL,
      source_references_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      parent_submission_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      withdrawn_at TEXT
    );
    INSERT INTO plan_submissions VALUES
      ('p1', 'P1', 'requirements', 'r1', 'u1', 'User', 'v1', '', '# v1', '[]', 1, '', 'candidate', '2026-01-01T00:00:00.000Z', NULL),
      ('p2', 'P1', 'requirements', 'r1', 'u1', 'User', 'v2', '', '# v2', '[]', 2, 'p1', 'candidate', '2026-01-02T00:00:00.000Z', NULL),
      ('p3', 'P1', 'bugs', 'b1', 'u2', 'User 2', 'bug', '', '# bug', '[]', 1, '', 'adopted', '2026-01-03T00:00:00.000Z', NULL);
    INSERT INTO conversations (
      id, owner_open_id, owner_name, project_id, tool_id, record_id,
      title, status, version, codex_thread_id, skill_version,
      context_summary, created_at, updated_at
    ) VALUES (
      'c1', 'u1', 'User', 'P1', 'requirements', 'r1',
      'Legacy conversation', 'idle', 1, '', '1', '',
      '2025-12-31T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
    );
  `);
  database.close();

  const repository = new AiPlanningRepository(databasePath);
  try {
    assert.equal(repository.getSubmission('p1').status, AI_PLAN_STATUSES.SUPERSEDED);
    assert.equal(repository.getSubmission('p2').status, AI_PLAN_STATUSES.PENDING_REVIEW);
    assert.equal(repository.getSubmission('p3').status, AI_PLAN_STATUSES.APPROVED);
    assert.equal(repository.getSubmission('p2').rootSubmissionId, 'p1');
    assert.equal(repository.getSubmission('p2').revisionAuthorName, 'User');
    const revisionThree = repository.createSubmission({
      conversationId: 'c1',
      ownerOpenId: 'u1',
      title: 'v3',
      summary: '',
      markdown: '# v3',
      sourceReferences: [],
    });
    assert.equal(revisionThree.revision, 3);
    assert.equal(revisionThree.rootSubmissionId, 'p1');
    assert.equal(repository.getSubmission('p2').conversationId, 'c1');
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI conversation creation is idempotent per owner mutation key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-conversation-mutation-'));
  const repository = new AiPlanningRepository(path.join(root, 'planning.sqlite'));
  try {
    const first = repository.createConversation({
      ownerOpenId: 'owner-a',
      ownerName: 'Owner A',
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'r1',
      title: 'Plan',
      clientMutationId: 'offer-1',
    });
    const duplicate = repository.createConversation({
      ownerOpenId: 'owner-a',
      ownerName: 'Owner A',
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'r1',
      title: 'Duplicate',
      clientMutationId: 'offer-1',
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(repository.listConversations({
      ownerOpenId: 'owner-a',
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'r1',
    }).length, 1);
    assert.throws(() => repository.createConversation({
      ownerOpenId: 'owner-a',
      ownerName: 'Owner A',
      projectId: 'P1',
      toolId: 'bugs',
      recordId: 'b1',
      title: 'Wrong item',
      clientMutationId: 'offer-1',
    }), /其他工作项/);
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI repository recovers running work after restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-recovery-'));
  const databasePath = path.join(root, 'planning.sqlite');
  let repository = new AiPlanningRepository(databasePath);
  try {
    const conversation = repository.createConversation({
      ownerOpenId: 'owner-a',
      ownerName: 'Owner A',
      projectId: 'P1',
      toolId: 'bugs',
      recordId: 'bug-1',
      title: 'Bug plan',
    });
    const appended = repository.appendUserMessage({
      conversationId: conversation.id,
      ownerOpenId: 'owner-a',
      content: 'Investigate',
      expectedVersion: 1,
      clientMutationId: 'mutation-2',
    });
    repository.startRun({
      conversationId: conversation.id,
      userMessageId: appended.message.id,
      model: 'codex-test',
    });
    repository.close();

    repository = new AiPlanningRepository(databasePath);
    const recovered = repository.getConversation(conversation.id, 'owner-a');
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.activeRun, null);
    assert.equal(recovered.latestRun.errorCode, 'server_restarted');
    assert.ok(recovered.latestRun.progressUpdatedAt);
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI service persists and publishes safe Codex progress snapshots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-progress-service-'));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  const repository = new AiPlanningRepository(path.join(root, 'planning.sqlite'));
  const realtimeHub = createAiPlanningRealtimeHub();
  const writes = [];
  const turnOptions = [];
  let turnCount = 0;
  const service = createAiPlanningService({
    config: {
      enabled: true,
      codex: { model: 'codex-test' },
      projects: [{
        projectId: 'P1',
        enabled: true,
        roots: [{ id: 'main', path: projectRoot, profile: 'auto' }],
      }],
    },
    repository,
    scheduler: createBoundedTaskScheduler(),
    realtimeHub,
    codexClient: {
      async runTurn(options) {
        turnCount += 1;
        turnOptions.push({
          threadId: options.threadId,
          prompt: options.prompt,
        });
        const {
          onThread,
          onTurn,
          onProgress,
          onRequestUserInput,
        } = options;
        onThread('private-thread');
        onTurn(`private-turn-${turnCount}`);
        onProgress({
          stage: 'analyzing',
          message: '正在读取项目结构和相关代码',
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        onProgress({
          stage: 'composing',
          message: '正在整理最终实施计划',
        });
        if (turnCount === 2) {
          await onRequestUserInput([{
            id: 'acceptance',
            header: '验收重点',
            question: '本次方案最需要优先保证什么？',
            isOther: true,
            options: [
              { label: '兼容性', description: '优先保持现有行为兼容' },
              { label: '交付速度', description: '优先缩小本次改动范围' },
            ],
          }]);
          return { awaitingUser: true };
        }
        return {
          threadId: 'private-thread',
          turnId: `private-turn-${turnCount}`,
          content: JSON.stringify({
            message: turnCount === 1 ? '过早生成的方案' : '计划已生成',
            plan: null,
          }),
        };
      },
    },
    skillPath: '',
  });
  try {
    const user = { openId: 'owner-a', name: 'Owner A' };
    const conversation = service.createConversation({
      user,
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'rec-1',
      title: 'Plan',
    });
    const unsubscribe = service.subscribe({
      response: { write: (value) => writes.push(value) },
      user,
      conversationId: conversation.id,
    });
    service.sendMessage({
      user,
      conversationId: conversation.id,
      content: 'Create a plan',
      expectedVersion: conversation.version,
      clientMutationId: 'progress-test',
      workItem: { itemId: 'REQ-001', title: 'Requirement' },
      project: { projectName: 'Project one' },
    });
    const awaiting = await waitForConversationStatus(
      repository,
      conversation.id,
      user.openId,
      'awaiting_user',
    );
    assert.equal(awaiting.pendingQuestionSet.questions.length, 1);
    service.answerQuestions({
      user,
      conversationId: conversation.id,
      questionSetId: awaiting.pendingQuestionSet.id,
      expectedVersion: awaiting.version,
      clientMutationId: 'progress-answer',
      answers: [{
        questionId: 'acceptance',
        optionLabel: '兼容性',
        customText: '',
      }],
      additionalContext: '',
      workItem: { itemId: 'REQ-001', title: 'Requirement' },
      project: { projectId: 'P1', projectName: 'Project one' },
    });
    const completed = await waitForConversationStatus(
      repository,
      conversation.id,
      user.openId,
      'idle',
    );
    unsubscribe();
    assert.equal(completed.latestRun.status, 'completed');
    assert.equal(completed.latestRun.progressStage, 'completed');
    assert.equal(turnCount, 3);
    assert.deepEqual(turnOptions.map((item) => item.threadId), [
      '',
      'private-thread',
      'private-thread',
    ]);
    assert.match(turnOptions[0].prompt, /MUST call request_user_input once/);
    assert.match(turnOptions[1].prompt, /previous turn returned without/);
    assert.doesNotMatch(turnOptions[2].prompt, /MUST call request_user_input once/);
    const events = writes.join('');
    assert.match(events, /"stage":"starting"/);
    assert.match(events, /"stage":"analyzing"/);
    assert.match(events, /"stage":"composing"/);
    assert.doesNotMatch(events, /private-thread|private-turn/);
    assert.doesNotMatch(events, /"runId"/);
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI service rejects premature plans when Codex skips the required question round twice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-required-question-'));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  const repository = new AiPlanningRepository(path.join(root, 'planning.sqlite'));
  const prompts = [];
  let turnCount = 0;
  const service = createAiPlanningService({
    config: {
      enabled: true,
      codex: { model: 'codex-test' },
      projects: [{
        projectId: 'P1',
        enabled: true,
        roots: [{ id: 'main', path: projectRoot, profile: 'auto' }],
      }],
    },
    repository,
    scheduler: createBoundedTaskScheduler(),
    realtimeHub: createAiPlanningRealtimeHub(),
    codexClient: {
      async runTurn(options) {
        turnCount += 1;
        prompts.push(options.prompt);
        options.onThread('private-thread');
        options.onTurn(`turn-${turnCount}`);
        return {
          content: JSON.stringify({
            message: `Premature plan ${turnCount}`,
            plan: {
              title: 'Must not persist',
              summary: 'Codex skipped the required user confirmation',
              markdown: '# Must not persist',
              sourceReferences: [],
            },
          }),
        };
      },
    },
    skillPath: '',
  });
  try {
    const user = { openId: 'owner-a', name: 'Owner A' };
    const conversation = service.createConversation({
      user,
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'rec-1',
      title: 'Plan',
    });
    service.sendMessage({
      user,
      conversationId: conversation.id,
      content: 'Generate a plan',
      expectedVersion: conversation.version,
      clientMutationId: 'required-question-failure',
      workItem: { itemId: 'REQ-001', title: 'Requirement' },
      project: { projectId: 'P1', projectName: 'Project one' },
    });

    const failed = await waitForConversationStatus(
      repository,
      conversation.id,
      user.openId,
      'failed',
    );
    assert.equal(turnCount, 2);
    assert.match(prompts[0], /MUST call request_user_input once/);
    assert.match(prompts[1], /previous turn returned without/);
    assert.equal(failed.latestRun.status, 'failed');
    assert.equal(failed.latestRun.errorCode, 'codex_protocol');
    assert.equal(failed.draft, null);
    assert.equal(
      failed.messages.some((message) => message.role === 'assistant'),
      false,
    );
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI questions persist, remain owner-only, and resume the same private conversation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-questions-'));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  const repository = new AiPlanningRepository(path.join(root, 'planning.sqlite'));
  const notifications = [];
  const runOptions = [];
  let turnCount = 0;
  const service = createAiPlanningService({
    config: {
      enabled: true,
      codex: { model: 'codex-test' },
      projects: [{
        projectId: 'P1',
        enabled: true,
        preludePrompt: 'Use the project service layer and existing naming rules.',
        roots: [{ id: 'main', path: projectRoot, profile: 'auto' }],
      }],
    },
    repository,
    scheduler: createBoundedTaskScheduler(),
    realtimeHub: createAiPlanningRealtimeHub(),
    codexClient: {
      async runTurn(options) {
        turnCount += 1;
        runOptions.push({
          threadId: options.threadId,
          preludePrompt: options.preludePrompt,
        });
        options.onThread('private-thread');
        options.onTurn(`turn-${turnCount}`);
        if (turnCount === 1) {
          await options.onRequestUserInput([{
            id: 'storage',
            header: '存储方式',
            question: '方案数据应保存在哪里？',
            isOther: true,
            options: [
              { label: 'SQLite', description: '沿用现有本地存储' },
              { label: '飞书', description: '存入远端表格' },
            ],
          }]);
          return { awaitingUser: true };
        }
        return {
          content: JSON.stringify({
            message: '已按你的选择生成方案',
            plan: {
              title: '实施方案',
              summary: '使用 SQLite',
              markdown: '# 实施方案',
              sourceReferences: [],
            },
          }),
        };
      },
    },
    notificationService: {
      enqueue(type, event) {
        notifications.push({ type, event });
      },
    },
    skillPath: '',
  });
  try {
    const user = { openId: 'owner-a', name: 'Owner A' };
    const conversation = service.createConversation({
      user,
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'rec-1',
      title: 'Plan',
    });
    service.sendMessage({
      user,
      conversationId: conversation.id,
      content: '生成方案',
      expectedVersion: conversation.version,
      clientMutationId: 'question-run-1',
      workItem: { itemId: 'REQ-1', title: 'Requirement' },
      project: { projectId: 'P1', projectName: 'Project' },
    });
    const awaiting = await waitForConversationStatus(
      repository,
      conversation.id,
      user.openId,
      'awaiting_user',
    );
    assert.equal(awaiting.pendingQuestionSet.questions.length, 1);
    assert.equal(awaiting.messages.at(-1).kind, 'question_set');
    assert.equal(repository.getConversation(conversation.id, 'owner-b'), null);
    assert.equal(notifications[0].type, 'question_required');

    const answerPayload = {
      user,
      conversationId: conversation.id,
      questionSetId: awaiting.pendingQuestionSet.id,
      expectedVersion: awaiting.version,
      clientMutationId: 'answer-1',
      answers: [{
        questionId: 'storage',
        optionLabel: 'SQLite',
        customText: '',
      }],
      additionalContext: '保持便携部署',
      workItem: { itemId: 'REQ-1', title: 'Requirement' },
      project: { projectId: 'P1', projectName: 'Project' },
    };
    service.answerQuestions(answerPayload);
    const completed = await waitForConversationStatus(
      repository,
      conversation.id,
      user.openId,
      'ready',
    );
    assert.equal(completed.codexThreadId, 'private-thread');
    assert.equal(completed.messages.at(-2).kind, 'question_answers');
    assert.equal(completed.draft.markdown, '# 实施方案');
    assert.equal(turnCount, 2);
    assert.deepEqual(runOptions, [
      {
        threadId: '',
        preludePrompt: 'Use the project service layer and existing naming rules.',
      },
      {
        threadId: 'private-thread',
        preludePrompt: '',
      },
    ]);
    assert.equal(notifications.at(-1).type, 'plan_ready');

    const duplicate = service.answerQuestions(answerPayload);
    assert.equal(duplicate.duplicate, true);
    assert.equal(turnCount, 2);
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI pending questions survive repository restart without becoming interrupted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-question-restart-'));
  const databasePath = path.join(root, 'planning.sqlite');
  let repository = new AiPlanningRepository(databasePath);
  try {
    const conversation = repository.createConversation({
      ownerOpenId: 'owner-a',
      ownerName: 'Owner A',
      projectId: 'P1',
      toolId: 'bugs',
      recordId: 'bug-1',
      title: 'Bug plan',
    });
    const appended = repository.appendUserMessage({
      conversationId: conversation.id,
      ownerOpenId: 'owner-a',
      content: 'Investigate',
      expectedVersion: 1,
      clientMutationId: 'question-restart',
    });
    const started = repository.startRun({
      conversationId: conversation.id,
      userMessageId: appended.message.id,
      model: 'codex-test',
    });
    repository.awaitUserInput({
      conversationId: conversation.id,
      ownerOpenId: 'owner-a',
      runId: started.run.id,
      questions: [{
        id: 'q1',
        header: '范围',
        question: '是否包含旧版本？',
        isOther: true,
        options: [
          { label: '包含', description: '兼容旧版本' },
          { label: '不包含', description: '仅新版本' },
        ],
      }],
    });
    repository.close();

    repository = new AiPlanningRepository(databasePath);
    const recovered = repository.getConversation(conversation.id, 'owner-a');
    assert.equal(recovered.status, 'awaiting_user');
    assert.equal(recovered.latestRun.status, 'awaiting_user');
    assert.equal(recovered.pendingQuestionSet.questions[0].id, 'q1');
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI run context exposes project roots read-only and cleans attachment files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-run-context-'));
  const projectRoot = path.join(root, 'project');
  const tempRoot = path.join(root, 'temp');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'keep.txt'), 'unchanged', 'utf8');
  const service = createAiRunContextService({
    tempRoot,
    config: {
      enabled: true,
      maxFiles: 2,
      maxFileBytes: 100,
      maxTotalBytes: 150,
      maxExtractedCharsPerFile: 100,
      maxExtractedCharsTotal: 100,
      retentionHours: 24,
    },
    async downloadAttachment(source) {
      return {
        buffer: source.fileToken === 'large'
          ? Buffer.alloc(120)
          : Buffer.from('attachment text', 'utf8'),
      };
    },
  });
  try {
    const context = await service.prepare({
      runId: 'run-12345678',
      workspace: {
        cwd: projectRoot,
        roots: [{ id: 'main', path: projectRoot, profile: 'auto' }],
      },
      workItem: {
        _aiAttachmentSources: [
          { fileToken: 'text', name: 'notes.txt', size: 15, mimeType: 'text/plain' },
          { fileToken: 'large', name: 'large.bin', size: 120 },
        ],
      },
    });
    assert.equal(fs.existsSync(context.cwd), true);
    assert.equal(context.attachmentSummary.processedCount, 1);
    assert.equal(context.attachmentSummary.skippedCount, 1);
    assert.match(context.attachmentContext, /notes\.txt/);
    assert.equal(fs.readFileSync(path.join(projectRoot, 'keep.txt'), 'utf8'), 'unchanged');
    await context.cleanup();
    assert.equal(fs.existsSync(context.cwd), false);
    assert.equal(fs.readFileSync(path.join(projectRoot, 'keep.txt'), 'utf8'), 'unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI notification outbox is durable and idempotent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-notifications-'));
  const repository = new AiPlanningRepository(path.join(root, 'planning.sqlite'));
  const delivered = [];
  const service = createAiPlanningNotificationService({
    repository,
    pollIntervalMs: 60_000,
    async deliver(notification) {
      delivered.push(notification);
    },
  });
  try {
    const event = {
      eventKey: 'ai:run-1:plan_ready',
      ownerOpenId: 'owner-a',
      conversation: {
        id: 'conversation-1',
        projectId: 'P1',
        toolId: 'requirements',
        recordId: 'rec-1',
        title: 'Private plan',
        codexThreadId: 'must-not-persist',
      },
      workItem: {
        itemId: 'REQ-1',
        title: 'Requirement',
        _aiAttachmentSources: [{ fileToken: 'secret-token' }],
      },
      project: { projectName: 'Project' },
      focus: 'plan',
    };
    assert.ok(service.enqueue('plan_ready', event));
    assert.equal(service.enqueue('plan_ready', event), null);
    await waitFor(() => delivered.length === 1);
    service.enqueue('plan_review_requested', {
      eventKey: 'ai-plan:review:submission-1:owner-b',
      recipientOpenId: 'owner-b',
      submission: {
        id: 'submission-1',
        projectId: 'P1',
        toolId: 'requirements',
        recordId: 'rec-1',
        workItemId: 'REQ-1',
        workItemTitle: 'Requirement',
        title: 'Shared plan',
        summary: 'Review me',
        revision: 1,
        authorName: 'Owner A',
      },
      project: { projectName: 'Project' },
    });
    await waitFor(() => delivered.length === 2);
    const rows = repository.database.prepare('SELECT * FROM notification_outbox').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === 'sent'));
    assert.doesNotMatch(rows[0].payload_json, /must-not-persist|secret-token/);
    assert.match(rows[1].payload_json, /submission-1|Shared plan/);
  } finally {
    service.stop();
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded AI scheduler limits user and project concurrency', async () => {
  const scheduler = createBoundedTaskScheduler({
    maxConcurrent: 2,
    maxPerUser: 1,
    maxPerProject: 1,
  });
  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = (name) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end:${name}`);
    active -= 1;
  };

  await Promise.all([
    scheduler.schedule({ userKey: 'u1', projectKey: 'p1', task: task('a') }),
    scheduler.schedule({ userKey: 'u1', projectKey: 'p2', task: task('b') }),
    scheduler.schedule({ userKey: 'u2', projectKey: 'p1', task: task('c') }),
    scheduler.schedule({ userKey: 'u2', projectKey: 'p2', task: task('d') }),
  ]);
  assert.equal(maxActive, 2);
  assert.ok(order.indexOf('end:a') < order.indexOf('start:b'));
  assert.ok(order.indexOf('end:a') < order.indexOf('start:c'));
});

test('AI realtime hub publishes only to the matching owner', () => {
  const hub = createAiPlanningRealtimeHub();
  const writesA = [];
  const writesB = [];
  const unsubscribeA = hub.subscribe({ write: (value) => writesA.push(value) }, {
    conversationId: 'c1',
    ownerOpenId: 'u1',
    snapshot: { id: 'c1' },
  });
  const unsubscribeB = hub.subscribe({ write: (value) => writesB.push(value) }, {
    conversationId: 'c1',
    ownerOpenId: 'u2',
    snapshot: { id: 'c1' },
  });
  hub.publish('c1', 'u1', 'assistant-delta', { delta: 'hello' });
  unsubscribeA();
  unsubscribeB();
  assert.match(writesA.join(''), /hello/);
  assert.doesNotMatch(writesB.join(''), /hello/);
});

test('structured Codex output filters unknown roots', () => {
  assert.throws(
    () => parsePlanningOutput('not json', { roots: [{ id: 'main' }] }),
    /格式不正确/,
  );
  const result = parsePlanningOutput(JSON.stringify({
    message: 'Ready from D:\\Projects\\P1',
    plan: {
      title: 'Plan for D:/Projects/P1',
      summary: 'Summary from D:\\Projects\\P1',
      markdown: '# Plan\nInspect D:/Projects/P1/src/app.js',
      sourceReferences: [
        {
          rootId: 'main',
          relativePath: 'src/app.js',
          startLine: 1,
          endLine: 2,
          note: 'used D:\\Projects\\P1\\src\\app.js',
        },
        {
          rootId: 'other',
          relativePath: 'secret.txt',
          startLine: 1,
          endLine: 1,
          note: 'ignored',
        },
      ],
    },
  }), {
    roots: [{ id: 'main', path: 'D:\\Projects\\P1' }],
  });
  assert.equal(result.plan.sourceReferences.length, 1);
  assert.equal(result.plan.sourceReferences[0].rootId, 'main');
  assert.doesNotMatch(JSON.stringify(result), /D:[\\/]+Projects/i);
  assert.match(result.plan.markdown, /\[root:main\]\/src\/app\.js/);
  assert.match(result.plan.sourceReferences[0].note, /\[root:main\]/);
});

test('AI conversation payloads omit owner and Codex runtime identifiers', () => {
  const serialized = serializeAiConversation({
    id: 'conversation-1',
    ownerOpenId: 'private-owner',
    ownerName: 'Private Owner',
    projectId: 'P1',
    toolId: 'requirements',
    recordId: 'rec-1',
    title: 'Plan',
    status: 'running',
    version: 2,
    codexThreadId: 'thread-private',
    skillVersion: '1',
    contextSummary: 'private context',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:01:00.000Z',
    messages: [{
      id: 'message-1',
      sequence: 1,
      role: 'user',
      content: 'Plan this',
      runId: 'run-private',
      createdAt: '2026-07-22T00:00:30.000Z',
    }],
    activeRun: {
      id: 'run-private',
      codexTurnId: 'turn-private',
    },
    latestRun: {
      id: 'run-private',
      codexTurnId: 'turn-private',
      model: 'private-model',
      status: 'failed',
      errorCode: 'codex_failed',
      errorMessage: 'Codex failed safely',
      progressStage: 'analyzing',
      progressMessage: '正在分析代码关系和实现约束',
      progressUpdatedAt: '2026-07-22T00:00:50.000Z',
      activityCount: 8,
      startedAt: '2026-07-22T00:00:30.000Z',
      finishedAt: '2026-07-22T00:01:00.000Z',
    },
    draft: null,
  });
  assert.equal(serialized.ownerOpenId, undefined);
  assert.equal(serialized.ownerName, undefined);
  assert.equal(serialized.codexThreadId, undefined);
  assert.equal(serialized.contextSummary, undefined);
  assert.equal(serialized.activeRun, undefined);
  assert.equal(serialized.messages[0].runId, undefined);
  assert.deepEqual(serialized.latestRun, {
    status: 'failed',
    errorCode: 'codex_failed',
    errorMessage: 'Codex failed safely',
    startedAt: '2026-07-22T00:00:30.000Z',
    finishedAt: '2026-07-22T00:01:00.000Z',
    progress: {
      stage: 'analyzing',
      message: '正在分析代码关系和实现约束',
      updatedAt: '2026-07-22T00:00:50.000Z',
      activityCount: 8,
    },
  });
  assert.equal(serialized.latestRun.id, undefined);
  assert.equal(serialized.latestRun.codexTurnId, undefined);
  assert.equal(serialized.latestRun.model, undefined);
  assert.equal(serialized.projectId, 'P1');
});

async function waitForConversationStatus(
  repository,
  conversationId,
  ownerOpenId,
  expectedStatus,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const conversation = repository.getConversation(conversationId, ownerOpenId);
    if (conversation?.status === expectedStatus) {
      return conversation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for AI conversation status ${expectedStatus}`);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test('submitted Markdown redacts configured project roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-ai-submission-'));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  const repository = new AiPlanningRepository(path.join(root, 'planning.sqlite'));
  const service = createAiPlanningService({
    config: {
      enabled: true,
      codex: { model: 'codex-test' },
      projects: [{
        projectId: 'P1',
        enabled: true,
        roots: [{ id: 'main', path: projectRoot, profile: 'auto' }],
      }],
    },
    repository,
    scheduler: createBoundedTaskScheduler(),
    realtimeHub: createAiPlanningRealtimeHub(),
    codexClient: {},
    skillPath: '',
  });
  try {
    const conversation = service.createConversation({
      user: { openId: 'owner-a', name: 'Owner A' },
      projectId: 'P1',
      toolId: 'requirements',
      recordId: 'rec-1',
      title: 'Plan',
    });
    const submission = service.createSubmission({
      user: { openId: 'owner-a', name: 'Owner A' },
      conversationId: conversation.id,
      title: `Plan for ${projectRoot}`,
      summary: `Read ${projectRoot}`,
      markdown: `# Plan\nRead ${path.join(projectRoot, 'src', 'app.js')}`,
      sourceReferences: [{
        rootId: 'main',
        relativePath: 'src/app.js',
        startLine: 1,
        endLine: 2,
        note: `From ${projectRoot}`,
      }],
      workItem: { itemId: 'REQ-001', title: 'Requirement' },
      project: { projectName: 'Project one' },
    });
    assert.doesNotMatch(JSON.stringify(submission), new RegExp(
      projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    ));
    assert.match(submission.markdown, /\[root:main\]/);
    assert.match(submission.sourceReferences[0].note, /\[root:main\]/);
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
