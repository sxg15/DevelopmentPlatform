import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AI_PLAN_TOOL_ID,
  canAccessAiPlanTool,
  normalizeAiPlanSourceReferences,
} from '../shared/aiPlanningDefinitions.js';
import { AiPlanningRepository } from '../server/repositories/aiPlanningRepository.js';
import { ensureAiDataDirectories } from '../server/runtime/aiDataPaths.js';
import { createAiPlanningRealtimeHub } from '../server/runtime/aiPlanningRealtime.js';
import { createBoundedTaskScheduler } from '../server/runtime/boundedTaskScheduler.js';
import {
  createAiPlanningService,
  getAllowedAiPlanToolIds,
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

    repository.adoptSubmission(revisionOne.id);
    repository.adoptSubmission(revisionTwo.id);
    assert.equal(repository.getSubmission(revisionOne.id).status, 'candidate');
    assert.equal(repository.getSubmission(revisionTwo.id).status, 'adopted');
    assert.equal(repository.withdrawSubmission(revisionOne.id, 'owner-b'), null);
    assert.equal(repository.withdrawSubmission(revisionOne.id, 'owner-a').status, 'withdrawn');
    assert.equal(repository.listSubmissions({
      projectId: 'P1',
      allowedToolIds: ['bugs'],
    }).length, 0);
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
  } finally {
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
    draft: null,
  });
  assert.equal(serialized.ownerOpenId, undefined);
  assert.equal(serialized.ownerName, undefined);
  assert.equal(serialized.codexThreadId, undefined);
  assert.equal(serialized.contextSummary, undefined);
  assert.equal(serialized.activeRun, undefined);
  assert.equal(serialized.messages[0].runId, undefined);
  assert.equal(serialized.projectId, 'P1');
});

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
