import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  AI_CONVERSATION_STATUSES,
  AI_MESSAGE_KINDS,
  AI_PLAN_STATUSES,
  AI_QUESTION_SET_STATUSES,
  AI_RUN_PROGRESS_STAGE_ORDER,
  AI_RUN_PROGRESS_STAGES,
  normalizeAiPlanSourceReferences,
} from '../../shared/aiPlanningDefinitions.js';

export class AiPlanningRepository {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_open_id TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        project_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        client_mutation_id TEXT NOT NULL DEFAULT '',
        codex_thread_id TEXT NOT NULL DEFAULT '',
        skill_version TEXT NOT NULL DEFAULT '1',
        context_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_owner_item
      ON conversations(owner_open_id, project_id, tool_id, record_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '',
        client_mutation_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        UNIQUE(conversation_id, sequence)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_mutation
      ON messages(conversation_id, client_mutation_id)
      WHERE client_mutation_id <> '';

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        progress_stage TEXT NOT NULL DEFAULT '',
        progress_message TEXT NOT NULL DEFAULT '',
        progress_updated_at TEXT NOT NULL DEFAULT '',
        activity_count INTEGER NOT NULL DEFAULT 0,
        attachment_summary_json TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_runs_conversation
      ON runs(conversation_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS question_sets (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        status TEXT NOT NULL,
        answers_json TEXT NOT NULL DEFAULT '',
        answer_client_mutation_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        answered_at TEXT,
        cancelled_at TEXT,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_question_sets_run
      ON question_sets(run_id);

      CREATE INDEX IF NOT EXISTS idx_question_sets_pending
      ON question_sets(conversation_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS plan_drafts (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        markdown TEXT NOT NULL,
        source_references_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plan_submissions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL DEFAULT '',
        work_item_title TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
        author_open_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        revision_author_open_id TEXT NOT NULL DEFAULT '',
        revision_author_name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        markdown TEXT NOT NULL,
        source_references_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        parent_submission_id TEXT NOT NULL DEFAULT '',
        root_submission_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        withdrawn_at TEXT,
        reviewed_by_open_id TEXT NOT NULL DEFAULT '',
        reviewed_by_name TEXT NOT NULL DEFAULT '',
        reviewed_at TEXT,
        review_reason TEXT NOT NULL DEFAULT '',
        superseded_by_submission_id TEXT NOT NULL DEFAULT '',
        superseded_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_plan_submissions_project
      ON plan_submissions(project_id, submitted_at DESC);

      CREATE TABLE IF NOT EXISTS plan_submission_events (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_open_id TEXT NOT NULL DEFAULT '',
        actor_name TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        related_submission_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(submission_id) REFERENCES plan_submissions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_plan_submission_events_submission
      ON plan_submission_events(submission_id, created_at);

      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        event_key TEXT NOT NULL UNIQUE,
        owner_open_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
      ON notification_outbox(status, next_attempt_at, created_at);
    `);
    ensureColumn(this.database, 'conversations', 'client_mutation_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'conversation_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'work_item_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'work_item_title', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'project_name', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'revision_author_open_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'revision_author_name', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'root_submission_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'reviewed_by_open_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'reviewed_by_name', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'reviewed_at', 'TEXT');
    ensureColumn(this.database, 'plan_submissions', 'review_reason', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'superseded_by_submission_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'superseded_at', 'TEXT');
    ensureColumn(this.database, 'runs', 'progress_stage', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'runs', 'progress_message', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'runs', 'progress_updated_at', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'runs', 'activity_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.database, 'runs', 'attachment_summary_json', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
    ensureColumn(this.database, 'messages', 'payload_json', "TEXT NOT NULL DEFAULT ''");

    this.migrateAiPlanReviewSchema();
    this.recoverInterruptedRuns();
  }

  close() {
    this.database.close();
  }

  createConversation({
    ownerOpenId,
    ownerName,
    projectId,
    toolId,
    recordId,
    title,
    clientMutationId = '',
  }) {
    const normalizedMutationId = String(clientMutationId || '').trim().slice(0, 100);
    if (normalizedMutationId) {
      const existing = this.database.prepare(`
        SELECT * FROM conversations
        WHERE owner_open_id = ? AND client_mutation_id = ?
      `).get(ownerOpenId, normalizedMutationId);
      if (existing) {
        if (
          existing.project_id !== projectId
          || existing.tool_id !== toolId
          || existing.record_id !== recordId
        ) {
          throw new Error('对话幂等键已用于其他工作项');
        }
        return this.getConversation(existing.id, ownerOpenId);
      }
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO conversations (
        id, owner_open_id, owner_name, project_id, tool_id, record_id,
        title, status, version, client_mutation_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      ownerOpenId,
      ownerName,
      projectId,
      toolId,
      recordId,
      String(title || '新的 AI 计划').slice(0, 120),
      AI_CONVERSATION_STATUSES.IDLE,
      normalizedMutationId,
      now,
      now,
    );
    return this.getConversation(id, ownerOpenId);
  }

  listConversations({ ownerOpenId, projectId, toolId, recordId }) {
    return this.database.prepare(`
      SELECT * FROM conversations
      WHERE owner_open_id = ? AND project_id = ? AND tool_id = ? AND record_id = ?
        AND status <> ?
      ORDER BY updated_at DESC
    `).all(
      ownerOpenId,
      projectId,
      toolId,
      recordId,
      AI_CONVERSATION_STATUSES.ARCHIVED,
    ).map(normalizeConversationRow);
  }

  getConversation(conversationId, ownerOpenId, { includeMessages = true } = {}) {
    const row = this.database.prepare(`
      SELECT * FROM conversations WHERE id = ? AND owner_open_id = ?
    `).get(conversationId, ownerOpenId);
    if (!row) {
      return null;
    }

    const conversation = normalizeConversationRow(row);
    if (includeMessages) {
      conversation.messages = this.database.prepare(`
        SELECT id, sequence, role, kind, content, payload_json, run_id, created_at
        FROM messages WHERE conversation_id = ? ORDER BY sequence
      `).all(conversationId).map(normalizeMessageRow);
    }
    conversation.draft = this.getDraft(conversationId);
    conversation.latestRun = this.getLatestRun(conversationId);
    conversation.pendingQuestionSet = this.getPendingQuestionSet(conversationId);
    conversation.activeRun = conversation.latestRun?.status === 'running'
      ? conversation.latestRun
      : null;
    return conversation;
  }

  setConversationThread(conversationId, ownerOpenId, threadId) {
    const result = this.database.prepare(`
      UPDATE conversations SET codex_thread_id = ?, updated_at = ?
      WHERE id = ? AND owner_open_id = ?
    `).run(threadId, new Date().toISOString(), conversationId, ownerOpenId);
    return result.changes > 0;
  }

  appendUserMessage({
    conversationId,
    ownerOpenId,
    content,
    expectedVersion,
    clientMutationId,
  }) {
    return this.withTransaction(() => {
      const conversation = this.getConversation(conversationId, ownerOpenId, { includeMessages: false });
      if (!conversation) {
        return { missing: true };
      }

      if (clientMutationId) {
        const duplicate = this.database.prepare(`
          SELECT id, sequence, role, kind, content, payload_json, run_id, created_at
          FROM messages WHERE conversation_id = ? AND client_mutation_id = ?
        `).get(conversationId, clientMutationId);
        if (duplicate) {
          return {
            duplicate: true,
            message: normalizeMessageRow(duplicate),
            conversation: this.getConversation(conversationId, ownerOpenId),
          };
        }
      }
      if ([
        AI_CONVERSATION_STATUSES.RUNNING,
        AI_CONVERSATION_STATUSES.QUEUED,
        AI_CONVERSATION_STATUSES.AWAITING_USER,
      ].includes(conversation.status)) {
        return { busy: true, conversation };
      }

      if (Number(expectedVersion) !== conversation.version) {
        return { stale: true, conversation };
      }

      const message = this.insertMessage({
        conversationId,
        role: 'user',
        content,
        clientMutationId,
      });
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE conversations
        SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(AI_CONVERSATION_STATUSES.QUEUED, now, conversationId);
      return {
        message,
        conversation: this.getConversation(conversationId, ownerOpenId),
      };
    });
  }

  startRun({ conversationId, userMessageId, model }) {
    return this.withTransaction(() => {
      const active = this.getActiveRun(conversationId);
      if (active) {
        return { busy: true, run: active };
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO runs (
          id, conversation_id, user_message_id, model, status,
          progress_stage, progress_message, progress_updated_at, activity_count,
          started_at
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, 1, ?)
      `).run(
        id,
        conversationId,
        userMessageId,
        model,
        AI_RUN_PROGRESS_STAGES.QUEUED,
        '任务已进入队列',
        now,
        now,
      );
      this.database.prepare(`
        UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?
      `).run(AI_CONVERSATION_STATUSES.RUNNING, now, conversationId);
      return { run: this.getRun(id) };
    });
  }

  setRunTurnId(runId, turnId) {
    this.database.prepare(`
      UPDATE runs SET codex_turn_id = ? WHERE id = ?
    `).run(turnId, runId);
  }

  updateRunProgress({ runId, stage, message }) {
    const run = this.getRun(runId);
    if (!run || run.status !== 'running') {
      return null;
    }
    const currentStage = normalizeProgressStage(run.progressStage)
      || AI_RUN_PROGRESS_STAGES.QUEUED;
    const nextStage = normalizeProgressStage(stage) || currentStage;
    const currentIndex = AI_RUN_PROGRESS_STAGE_ORDER.indexOf(currentStage);
    const nextIndex = AI_RUN_PROGRESS_STAGE_ORDER.indexOf(nextStage);
    const resolvedStage = nextIndex >= currentIndex ? nextStage : currentStage;
    const resolvedMessage = nextIndex >= currentIndex
      ? String(message || run.progressMessage || '').trim().slice(0, 300)
      : run.progressMessage;
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE runs
      SET progress_stage = ?, progress_message = ?,
          progress_updated_at = ?, activity_count = activity_count + 1
      WHERE id = ? AND status = 'running'
    `).run(resolvedStage, resolvedMessage, now, runId);
    return this.getRun(runId);
  }

  setRunAttachmentSummary(runId, summary) {
    this.database.prepare(`
      UPDATE runs SET attachment_summary_json = ? WHERE id = ?
    `).run(JSON.stringify(normalizeAttachmentSummary(summary)), runId);
    return this.getRun(runId);
  }

  awaitUserInput({
    conversationId,
    ownerOpenId,
    runId,
    questions,
  }) {
    return this.withTransaction(() => {
      const conversation = this.getConversation(conversationId, ownerOpenId, {
        includeMessages: false,
      });
      const run = this.getRun(runId);
      if (!conversation || !run || run.conversationId !== conversationId) {
        return { missing: true };
      }
      const existing = this.database.prepare(`
        SELECT * FROM question_sets WHERE run_id = ?
      `).get(runId);
      if (existing) {
        return {
          duplicate: true,
          questionSet: normalizeQuestionSetRow(existing),
          conversation: this.getConversation(conversationId, ownerOpenId),
        };
      }
      if (run.status !== 'running') {
        return { inactive: true, conversation };
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const normalizedQuestions = normalizeStoredQuestions(questions);
      this.database.prepare(`
        INSERT INTO question_sets (
          id, conversation_id, run_id, questions_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        conversationId,
        runId,
        JSON.stringify(normalizedQuestions),
        AI_QUESTION_SET_STATUSES.PENDING,
        now,
      );
      this.insertMessage({
        conversationId,
        role: 'assistant',
        kind: AI_MESSAGE_KINDS.QUESTION_SET,
        content: buildQuestionSetMessage(normalizedQuestions),
        payload: {
          questionSetId: id,
          questions: normalizedQuestions,
          status: AI_QUESTION_SET_STATUSES.PENDING,
        },
        runId,
      });
      this.database.prepare(`
        UPDATE runs
        SET status = ?, progress_stage = ?, progress_message = ?,
            progress_updated_at = ?, activity_count = activity_count + 1,
            finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(
        AI_CONVERSATION_STATUSES.AWAITING_USER,
        AI_RUN_PROGRESS_STAGES.AWAITING_USER,
        '等待用户确认关键决策',
        now,
        now,
        runId,
      );
      this.database.prepare(`
        UPDATE conversations
        SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_open_id = ?
      `).run(
        AI_CONVERSATION_STATUSES.AWAITING_USER,
        now,
        conversationId,
        ownerOpenId,
      );
      return {
        questionSet: this.getQuestionSet(id),
        conversation: this.getConversation(conversationId, ownerOpenId),
      };
    });
  }

  answerQuestionSet({
    conversationId,
    ownerOpenId,
    questionSetId,
    answers,
    additionalContext,
    expectedVersion,
    clientMutationId,
  }) {
    return this.withTransaction(() => {
      const conversation = this.getConversation(conversationId, ownerOpenId, {
        includeMessages: false,
      });
      if (!conversation) {
        return { missing: true };
      }
      const questionSet = this.getQuestionSet(questionSetId);
      if (!questionSet || questionSet.conversationId !== conversationId) {
        return { missing: true };
      }
      if (questionSet.status === AI_QUESTION_SET_STATUSES.ANSWERED) {
        if (
          clientMutationId
          && questionSet.answerClientMutationId === clientMutationId
        ) {
          return {
            duplicate: true,
            conversation: this.getConversation(conversationId, ownerOpenId),
          };
        }
        return { alreadyAnswered: true, conversation };
      }
      if (
        questionSet.status !== AI_QUESTION_SET_STATUSES.PENDING
        || conversation.status !== AI_CONVERSATION_STATUSES.AWAITING_USER
      ) {
        return { inactive: true, conversation };
      }
      if (Number(expectedVersion) !== conversation.version) {
        return { stale: true, conversation };
      }

      const now = new Date().toISOString();
      const payload = {
        questionSetId,
        answers,
        additionalContext,
      };
      this.database.prepare(`
        UPDATE question_sets
        SET status = ?, answers_json = ?, answer_client_mutation_id = ?,
            answered_at = ?
        WHERE id = ? AND status = ?
      `).run(
        AI_QUESTION_SET_STATUSES.ANSWERED,
        JSON.stringify(payload),
        clientMutationId,
        now,
        questionSetId,
        AI_QUESTION_SET_STATUSES.PENDING,
      );
      const message = this.insertMessage({
        conversationId,
        role: 'user',
        kind: AI_MESSAGE_KINDS.QUESTION_ANSWERS,
        content: buildQuestionAnswersMessage(questionSet.questions, answers, additionalContext),
        payload,
        clientMutationId,
      });
      this.database.prepare(`
        UPDATE conversations
        SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_open_id = ?
      `).run(
        AI_CONVERSATION_STATUSES.QUEUED,
        now,
        conversationId,
        ownerOpenId,
      );
      return {
        message,
        conversation: this.getConversation(conversationId, ownerOpenId),
      };
    });
  }

  cancelPendingQuestionSets(conversationId, ownerOpenId) {
    return this.withTransaction(() => {
      const conversation = this.getConversation(conversationId, ownerOpenId, {
        includeMessages: false,
      });
      if (!conversation) {
        return null;
      }
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE question_sets
        SET status = ?, cancelled_at = ?
        WHERE conversation_id = ? AND status = ?
      `).run(
        AI_QUESTION_SET_STATUSES.CANCELLED,
        now,
        conversationId,
        AI_QUESTION_SET_STATUSES.PENDING,
      );
      this.database.prepare(`
        UPDATE conversations
        SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_open_id = ?
      `).run(
        AI_CONVERSATION_STATUSES.INTERRUPTED,
        now,
        conversationId,
        ownerOpenId,
      );
      return this.getConversation(conversationId, ownerOpenId);
    });
  }

  completeRun({ runId, conversationId, assistantContent, plan }) {
    return this.withTransaction(() => {
      const message = this.insertMessage({
        conversationId,
        role: 'assistant',
        content: assistantContent,
        runId,
      });
      const now = new Date().toISOString();
      if (plan?.markdown) {
        this.database.prepare(`
          INSERT INTO plan_drafts (
            conversation_id, title, summary, markdown, source_references_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            title = excluded.title,
            summary = excluded.summary,
            markdown = excluded.markdown,
            source_references_json = excluded.source_references_json,
            updated_at = excluded.updated_at
        `).run(
          conversationId,
          plan.title,
          plan.summary,
          plan.markdown,
          JSON.stringify(normalizeAiPlanSourceReferences(plan.sourceReferences)),
          now,
        );
      }
      this.database.prepare(`
        UPDATE runs
        SET status = 'completed', progress_stage = ?, progress_message = ?,
            progress_updated_at = ?, activity_count = activity_count + 1,
            finished_at = ?
        WHERE id = ?
      `).run(
        AI_RUN_PROGRESS_STAGES.COMPLETED,
        '实施计划已生成',
        now,
        now,
        runId,
      );
      this.database.prepare(`
        UPDATE conversations
        SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(
        plan?.markdown || this.getDraft(conversationId)
          ? AI_CONVERSATION_STATUSES.READY
          : AI_CONVERSATION_STATUSES.IDLE,
        now,
        conversationId,
      );
      return message;
    });
  }

  failRun({ runId, conversationId, status = 'failed', errorCode = '', errorMessage = '' }) {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE runs
      SET status = ?, error_code = ?, error_message = ?,
          progress_updated_at = ?, activity_count = activity_count + 1,
          finished_at = ?
      WHERE id = ?
    `).run(
      status,
      errorCode,
      String(errorMessage || '').slice(0, 1000),
      now,
      now,
      runId,
    );
    this.database.prepare(`
      UPDATE conversations SET status = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(
      status === 'interrupted'
        ? AI_CONVERSATION_STATUSES.INTERRUPTED
        : AI_CONVERSATION_STATUSES.FAILED,
      now,
      conversationId,
    );
  }

  archiveConversation(conversationId, ownerOpenId) {
    return this.database.prepare(`
      UPDATE conversations SET status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND owner_open_id = ? AND status <> ?
    `).run(
      AI_CONVERSATION_STATUSES.ARCHIVED,
      new Date().toISOString(),
      conversationId,
      ownerOpenId,
      AI_CONVERSATION_STATUSES.RUNNING,
    ).changes > 0;
  }

  getQuestionSet(questionSetId) {
    const row = this.database.prepare(`
      SELECT * FROM question_sets WHERE id = ?
    `).get(questionSetId);
    return row ? normalizeQuestionSetRow(row) : null;
  }

  getPendingQuestionSet(conversationId) {
    const row = this.database.prepare(`
      SELECT * FROM question_sets
      WHERE conversation_id = ? AND status = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(conversationId, AI_QUESTION_SET_STATUSES.PENDING);
    return row ? normalizeQuestionSetRow(row) : null;
  }

  getDraft(conversationId) {
    const row = this.database.prepare(`
      SELECT * FROM plan_drafts WHERE conversation_id = ?
    `).get(conversationId);
    return row ? {
      title: row.title,
      summary: row.summary,
      markdown: row.markdown,
      sourceReferences: parseJsonArray(row.source_references_json),
      updatedAt: row.updated_at,
    } : null;
  }

  createSubmission({
    conversationId,
    ownerOpenId,
    title,
    summary,
    markdown,
    sourceReferences,
    workItemId = '',
    workItemTitle = '',
    projectName = '',
  }) {
    return this.withTransaction(() => {
      const conversation = this.getConversation(conversationId, ownerOpenId, { includeMessages: false });
      if (!conversation) {
        return null;
      }

      let previous = this.database.prepare(`
        SELECT * FROM plan_submissions
        WHERE conversation_id = ?
        ORDER BY revision DESC LIMIT 1
      `).get(conversationId);
      if (!previous) {
        previous = this.database.prepare(`
          SELECT * FROM plan_submissions
          WHERE conversation_id = ''
            AND project_id = ?
            AND tool_id = ?
            AND record_id = ?
            AND author_open_id = ?
          ORDER BY revision DESC, submitted_at DESC
          LIMIT 1
        `).get(
          conversation.projectId,
          conversation.toolId,
          conversation.recordId,
          ownerOpenId,
        );
        if (previous) {
          this.database.prepare(`
            UPDATE plan_submissions
            SET conversation_id = ?
            WHERE root_submission_id = ? AND conversation_id = ''
          `).run(conversationId, previous.root_submission_id || previous.id);
        }
      }
      const id = crypto.randomUUID();
      const revision = Number(previous?.revision || 0) + 1;
      const rootSubmissionId = previous?.root_submission_id || previous?.id || id;
      const now = new Date().toISOString();
      if (previous?.status === AI_PLAN_STATUSES.PENDING_REVIEW) {
        this.markSubmissionSuperseded(previous.id, id, now);
      }
      this.database.prepare(`
        INSERT INTO plan_submissions (
          id, conversation_id, project_id, tool_id, record_id, work_item_id, work_item_title,
          project_name, author_open_id, author_name, revision_author_open_id,
          revision_author_name,
          title, summary, markdown, source_references_json, revision,
          parent_submission_id, root_submission_id, status, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        conversationId,
        conversation.projectId,
        conversation.toolId,
        conversation.recordId,
        String(workItemId || '').slice(0, 200),
        String(workItemTitle || '').slice(0, 500),
        String(projectName || '').slice(0, 500),
        ownerOpenId,
        conversation.ownerName,
        ownerOpenId,
        conversation.ownerName,
        String(title || '未命名方案').slice(0, 200),
        String(summary || '').slice(0, 2000),
        String(markdown || '').slice(0, 200000),
        JSON.stringify(normalizeAiPlanSourceReferences(sourceReferences)),
        revision,
        previous?.id || '',
        rootSubmissionId,
        AI_PLAN_STATUSES.PENDING_REVIEW,
        now,
      );
      this.insertSubmissionEvent({
        submissionId: id,
        eventType: previous ? 'revision_submitted' : 'submitted',
        actorOpenId: ownerOpenId,
        actorName: conversation.ownerName,
        relatedSubmissionId: previous?.id || '',
        createdAt: now,
      });
      return this.getSubmission(id);
    });
  }

  listSubmissions({
    projectId,
    allowedToolIds,
    toolId = '',
    recordId = '',
    search = '',
    status = '',
  }) {
    const tools = [...new Set(allowedToolIds || [])].filter(Boolean);
    if (tools.length === 0) {
      return [];
    }

    const where = [
      'project_id = ?',
      `tool_id IN (${tools.map(() => '?').join(', ')})`,
    ];
    const params = [projectId, ...tools];
    if (toolId && tools.includes(toolId)) {
      where.push('tool_id = ?');
      params.push(toolId);
    }
    if (recordId) {
      where.push('record_id = ?');
      params.push(recordId);
    }
    if (status && status !== 'all') {
      where.push('status = ?');
      params.push(status);
    } else if (!status) {
      where.push('status IN (?, ?)');
      params.push(AI_PLAN_STATUSES.PENDING_REVIEW, AI_PLAN_STATUSES.APPROVED);
    }
    if (search) {
      where.push('(title LIKE ? OR summary LIKE ? OR record_id LIKE ? OR work_item_id LIKE ? OR work_item_title LIKE ? OR author_name LIKE ?)');
      const like = `%${search.slice(0, 100)}%`;
      params.push(like, like, like, like, like, like);
    }

    return this.database.prepare(`
      SELECT * FROM plan_submissions
      WHERE ${where.join(' AND ')}
      ORDER BY submitted_at DESC
      LIMIT 500
    `).all(...params).map(normalizeSubmissionRow);
  }

  listApprovedSubmissionsForProjects({ projectIds, toolIds = [] }) {
    const projects = [...new Set(projectIds || [])]
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (projects.length === 0) {
      return [];
    }

    const tools = [...new Set(toolIds || [])]
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    const where = [
      `project_id IN (${projects.map(() => '?').join(', ')})`,
      'status = ?',
    ];
    const params = [...projects, AI_PLAN_STATUSES.APPROVED];
    if (tools.length > 0) {
      where.push(`tool_id IN (${tools.map(() => '?').join(', ')})`);
      params.push(...tools);
    }

    return this.database.prepare(`
      SELECT * FROM plan_submissions
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(reviewed_at, submitted_at) DESC, submitted_at DESC, id ASC
    `).all(...params).map(normalizeSubmissionRow);
  }

  getSubmission(submissionId) {
    const row = this.database.prepare(`
      SELECT * FROM plan_submissions WHERE id = ?
    `).get(submissionId);
    return row ? normalizeSubmissionRow(row) : null;
  }

  listSubmissionRevisions(rootSubmissionId) {
    if (!rootSubmissionId) {
      return [];
    }
    return this.database.prepare(`
      SELECT * FROM plan_submissions
      WHERE root_submission_id = ?
      ORDER BY revision DESC, submitted_at DESC
    `).all(rootSubmissionId).map(normalizeSubmissionRow);
  }

  listPendingSubmissionsForWorkItem({ projectId, toolId, recordId, limit = 100 }) {
    return this.database.prepare(`
      SELECT * FROM plan_submissions
      WHERE project_id = ? AND tool_id = ? AND record_id = ? AND status = ?
      ORDER BY submitted_at DESC
      LIMIT ?
    `).all(
      projectId,
      toolId,
      recordId,
      AI_PLAN_STATUSES.PENDING_REVIEW,
      Math.max(1, Math.min(500, Number(limit) || 100)),
    ).map(normalizeSubmissionRow);
  }

  countPendingSubmissionsForWorkItem({ projectId, toolId, recordId }) {
    return Number(this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM plan_submissions
      WHERE project_id = ? AND tool_id = ? AND record_id = ? AND status = ?
    `).get(
      projectId,
      toolId,
      recordId,
      AI_PLAN_STATUSES.PENDING_REVIEW,
    )?.count || 0);
  }

  getApprovedSubmissionForWorkItem({ projectId, toolId, recordId }) {
    const row = this.database.prepare(`
      SELECT * FROM plan_submissions
      WHERE project_id = ? AND tool_id = ? AND record_id = ? AND status = ?
      LIMIT 1
    `).get(projectId, toolId, recordId, AI_PLAN_STATUSES.APPROVED);
    return row ? normalizeSubmissionRow(row) : null;
  }

  approveSubmission(submissionId, reviewer) {
    return this.withTransaction(() => {
      const submission = this.getSubmission(submissionId);
      if (!submission || submission.status !== AI_PLAN_STATUSES.PENDING_REVIEW) {
        return null;
      }
      const now = new Date().toISOString();
      const previousApproved = this.database.prepare(`
        SELECT id FROM plan_submissions
        WHERE project_id = ? AND tool_id = ? AND record_id = ? AND status = ? AND id <> ?
      `).get(
        submission.projectId,
        submission.toolId,
        submission.recordId,
        AI_PLAN_STATUSES.APPROVED,
        submissionId,
      );
      if (previousApproved?.id) {
        this.markSubmissionSuperseded(previousApproved.id, submissionId, now);
      }
      const result = this.database.prepare(`
        UPDATE plan_submissions
        SET status = ?, reviewed_by_open_id = ?, reviewed_by_name = ?,
            reviewed_at = ?, review_reason = ''
        WHERE id = ? AND status = ?
      `).run(
        AI_PLAN_STATUSES.APPROVED,
        String(reviewer?.openId || ''),
        String(reviewer?.name || ''),
        now,
        submissionId,
        AI_PLAN_STATUSES.PENDING_REVIEW,
      );
      if (result.changes === 0) {
        return null;
      }
      this.insertSubmissionEvent({
        submissionId,
        eventType: 'approved',
        actorOpenId: reviewer.openId,
        actorName: reviewer.name,
        createdAt: now,
      });
      return this.getSubmission(submissionId);
    });
  }

  rejectSubmission(submissionId, reviewer, reason) {
    return this.withTransaction(() => {
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE plan_submissions
        SET status = ?, reviewed_by_open_id = ?, reviewed_by_name = ?,
            reviewed_at = ?, review_reason = ?
        WHERE id = ? AND status = ?
      `).run(
        AI_PLAN_STATUSES.REJECTED,
        String(reviewer?.openId || ''),
        String(reviewer?.name || ''),
        now,
        String(reason || '').slice(0, 2000),
        submissionId,
        AI_PLAN_STATUSES.PENDING_REVIEW,
      );
      if (result.changes === 0) {
        return null;
      }
      this.insertSubmissionEvent({
        submissionId,
        eventType: 'rejected',
        actorOpenId: reviewer?.openId,
        actorName: reviewer?.name,
        reason,
        createdAt: now,
      });
      return this.getSubmission(submissionId);
    });
  }

  createReviewRevision({
    submissionId,
    reviewer,
    title,
    summary,
    markdown,
  }) {
    return this.withTransaction(() => {
      const parent = this.getSubmission(submissionId);
      if (!parent || parent.status === AI_PLAN_STATUSES.WITHDRAWN || parent.status === AI_PLAN_STATUSES.SUPERSEDED) {
        return null;
      }
      const latest = this.database.prepare(`
        SELECT id FROM plan_submissions
        WHERE root_submission_id = ?
        ORDER BY revision DESC, submitted_at DESC
        LIMIT 1
      `).get(parent.rootSubmissionId);
      if (latest?.id !== parent.id) {
        return null;
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      if (parent.status === AI_PLAN_STATUSES.PENDING_REVIEW) {
        this.markSubmissionSuperseded(parent.id, id, now);
      }
      this.database.prepare(`
        INSERT INTO plan_submissions (
          id, conversation_id, project_id, tool_id, record_id, work_item_id,
          work_item_title, project_name, author_open_id, author_name,
          revision_author_open_id, revision_author_name, title, summary, markdown,
          source_references_json, revision, parent_submission_id,
          root_submission_id, status, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        parent.conversationId,
        parent.projectId,
        parent.toolId,
        parent.recordId,
        parent.workItemId,
        parent.workItemTitle,
        parent.projectName,
        parent.authorOpenId,
        parent.authorName,
        String(reviewer?.openId || ''),
        String(reviewer?.name || ''),
        String(title || '未命名方案').slice(0, 200),
        String(summary || '').slice(0, 2000),
        String(markdown || '').slice(0, 200000),
        JSON.stringify(normalizeAiPlanSourceReferences(parent.sourceReferences)),
        parent.revision + 1,
        parent.id,
        parent.rootSubmissionId,
        AI_PLAN_STATUSES.PENDING_REVIEW,
        now,
      );
      this.insertSubmissionEvent({
        submissionId: id,
        eventType: 'review_revision_created',
        actorOpenId: reviewer?.openId,
        actorName: reviewer?.name,
        relatedSubmissionId: parent.id,
        createdAt: now,
      });
      return this.getSubmission(id);
    });
  }

  adoptSubmission(submissionId, reviewer = {}) {
    return this.approveSubmission(submissionId, reviewer);
  }

  withdrawSubmission(submissionId, ownerOpenId, ownerName = '') {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE plan_submissions SET status = ?, withdrawn_at = ?
      WHERE id = ? AND author_open_id = ? AND status = ?
    `).run(
      AI_PLAN_STATUSES.WITHDRAWN,
      now,
      submissionId,
      ownerOpenId,
      AI_PLAN_STATUSES.PENDING_REVIEW,
    );
    if (result.changes === 0) {
      return null;
    }
    this.insertSubmissionEvent({
      submissionId,
      eventType: 'withdrawn',
      actorOpenId: ownerOpenId,
      actorName: ownerName,
      createdAt: now,
    });
    return this.getSubmission(submissionId);
  }

  deleteSubmissionChain(submissionId) {
    return this.withTransaction(() => {
      const submission = this.getSubmission(submissionId);
      if (!submission) {
        return null;
      }
      const rows = this.database.prepare(`
        SELECT id FROM plan_submissions
        WHERE root_submission_id = ?
      `).all(submission.rootSubmissionId);
      const submissionIds = rows.map((row) => row.id);
      if (submissionIds.length === 0) {
        return null;
      }
      const placeholders = submissionIds.map(() => '?').join(', ');
      const idSet = new Set(submissionIds);
      const notifications = this.database.prepare(`
        SELECT id, payload_json FROM notification_outbox
      `).all();
      const deleteNotification = this.database.prepare(`
        DELETE FROM notification_outbox WHERE id = ?
      `);
      for (const notification of notifications) {
        const payload = parseJsonObject(notification.payload_json);
        if (idSet.has(String(payload?.submissionId || ''))) {
          deleteNotification.run(notification.id);
        }
      }
      this.database.prepare(`
        UPDATE plan_submissions
        SET superseded_by_submission_id = ''
        WHERE superseded_by_submission_id IN (${placeholders})
      `).run(...submissionIds);
      this.database.prepare(`
        UPDATE plan_submission_events
        SET related_submission_id = ''
        WHERE related_submission_id IN (${placeholders})
          AND submission_id NOT IN (${placeholders})
      `).run(...submissionIds, ...submissionIds);
      this.database.prepare(`
        DELETE FROM plan_submission_events
        WHERE submission_id IN (${placeholders})
      `).run(...submissionIds);
      const result = this.database.prepare(`
        DELETE FROM plan_submissions
        WHERE id IN (${placeholders})
      `).run(...submissionIds);
      return {
        rootSubmissionId: submission.rootSubmissionId,
        submissionIds,
        deletedCount: result.changes,
      };
    });
  }

  markSubmissionSuperseded(submissionId, relatedSubmissionId, createdAt = new Date().toISOString()) {
    const result = this.database.prepare(`
      UPDATE plan_submissions
      SET status = ?, superseded_by_submission_id = ?, superseded_at = ?
      WHERE id = ? AND status <> ?
    `).run(
      AI_PLAN_STATUSES.SUPERSEDED,
      relatedSubmissionId,
      createdAt,
      submissionId,
      AI_PLAN_STATUSES.SUPERSEDED,
    );
    if (result.changes === 0) {
      return false;
    }
    this.insertSubmissionEvent({
      submissionId,
      eventType: 'superseded',
      relatedSubmissionId,
      createdAt,
    });
    return true;
  }

  insertSubmissionEvent({
    submissionId,
    eventType,
    actorOpenId = '',
    actorName = '',
    reason = '',
    relatedSubmissionId = '',
    createdAt = new Date().toISOString(),
  }) {
    this.database.prepare(`
      INSERT INTO plan_submission_events (
        id, submission_id, event_type, actor_open_id, actor_name,
        reason, related_submission_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      submissionId,
      eventType,
      String(actorOpenId || '').slice(0, 200),
      String(actorName || '').slice(0, 200),
      String(reason || '').slice(0, 2000),
      String(relatedSubmissionId || '').slice(0, 100),
      createdAt,
    );
  }

  listSubmissionEvents(rootSubmissionId) {
    if (!rootSubmissionId) {
      return [];
    }
    return this.database.prepare(`
      SELECT events.*
      FROM plan_submission_events events
      INNER JOIN plan_submissions submissions ON submissions.id = events.submission_id
      WHERE submissions.root_submission_id = ?
      ORDER BY events.created_at, events.rowid
    `).all(rootSubmissionId).map((row) => ({
      id: row.id,
      submissionId: row.submission_id,
      eventType: row.event_type,
      actorOpenId: row.actor_open_id || '',
      actorName: row.actor_name || '',
      reason: row.reason || '',
      relatedSubmissionId: row.related_submission_id || '',
      createdAt: row.created_at,
    }));
  }

  migrateAiPlanReviewSchema() {
    this.withTransaction(() => {
      this.database.exec(`
        DROP INDEX IF EXISTS idx_plan_submissions_adopted;
        UPDATE plan_submissions SET status = 'pending_review' WHERE status = 'candidate';
        UPDATE plan_submissions SET status = 'approved' WHERE status = 'adopted';
        UPDATE plan_submissions
        SET revision_author_open_id = author_open_id
        WHERE revision_author_open_id = '';
        UPDATE plan_submissions
        SET revision_author_name = author_name
        WHERE revision_author_name = '';
        UPDATE plan_submissions
        SET root_submission_id = id
        WHERE root_submission_id = '' AND parent_submission_id = '';
      `);
      const unresolved = this.database.prepare(`
        SELECT id, parent_submission_id FROM plan_submissions
        WHERE root_submission_id = '' AND parent_submission_id <> ''
      `).all();
      for (let pass = 0; pass < unresolved.length; pass += 1) {
        let changed = 0;
        for (const row of unresolved) {
          const parent = this.database.prepare(`
            SELECT root_submission_id FROM plan_submissions WHERE id = ?
          `).get(row.parent_submission_id);
          if (!parent?.root_submission_id) {
            continue;
          }
          changed += this.database.prepare(`
            UPDATE plan_submissions SET root_submission_id = ?
            WHERE id = ? AND root_submission_id = ''
          `).run(parent.root_submission_id, row.id).changes;
        }
        if (changed === 0) {
          break;
        }
      }
      const pendingRoots = this.database.prepare(`
        SELECT root_submission_id
        FROM plan_submissions
        WHERE status = 'pending_review'
        GROUP BY root_submission_id
        HAVING COUNT(*) > 1
      `).all();
      for (const group of pendingRoots) {
        const revisions = this.database.prepare(`
          SELECT id FROM plan_submissions
          WHERE root_submission_id = ? AND status = 'pending_review'
          ORDER BY revision DESC, submitted_at DESC, id DESC
        `).all(group.root_submission_id);
        const latestId = revisions[0]?.id || '';
        for (const revision of revisions.slice(1)) {
          this.markSubmissionSuperseded(revision.id, latestId);
        }
      }
      const approvedItems = this.database.prepare(`
        SELECT project_id, tool_id, record_id
        FROM plan_submissions
        WHERE status = 'approved'
        GROUP BY project_id, tool_id, record_id
        HAVING COUNT(*) > 1
      `).all();
      for (const item of approvedItems) {
        const submissions = this.database.prepare(`
          SELECT id FROM plan_submissions
          WHERE project_id = ? AND tool_id = ? AND record_id = ? AND status = 'approved'
          ORDER BY COALESCE(reviewed_at, submitted_at) DESC, revision DESC, id DESC
        `).all(item.project_id, item.tool_id, item.record_id);
        const latestId = submissions[0]?.id || '';
        for (const submission of submissions.slice(1)) {
          this.markSubmissionSuperseded(submission.id, latestId);
        }
      }
      this.database.exec(`
        UPDATE plan_submissions SET root_submission_id = id WHERE root_submission_id = '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_owner_mutation
        ON conversations(owner_open_id, client_mutation_id)
        WHERE client_mutation_id <> '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_submissions_approved
        ON plan_submissions(project_id, tool_id, record_id)
        WHERE status = 'approved';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_submissions_pending_root
        ON plan_submissions(root_submission_id)
        WHERE status = 'pending_review';
      `);
    });
  }

  getRun(runId) {
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    return row ? normalizeRunRow(row) : null;
  }

  getActiveRun(conversationId) {
    const row = this.database.prepare(`
      SELECT * FROM runs
      WHERE conversation_id = ? AND status = 'running'
      ORDER BY started_at DESC LIMIT 1
    `).get(conversationId);
    return row ? normalizeRunRow(row) : null;
  }

  getLatestRun(conversationId) {
    const row = this.database.prepare(`
      SELECT * FROM runs
      WHERE conversation_id = ?
      ORDER BY started_at DESC LIMIT 1
    `).get(conversationId);
    return row ? normalizeRunRow(row) : null;
  }

  enqueueNotification({
    eventKey,
    ownerOpenId,
    eventType,
    payload,
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO notification_outbox (
        id, event_key, owner_open_id, event_type, payload_json,
        status, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(event_key) DO NOTHING
    `).run(
      id,
      eventKey,
      ownerOpenId,
      eventType,
      JSON.stringify(payload || {}),
      now,
      now,
      now,
    );
    if (result.changes === 0) {
      return null;
    }
    return this.database.prepare(`
      SELECT * FROM notification_outbox WHERE event_key = ?
    `).get(eventKey);
  }

  listPendingNotifications(limit = 20) {
    return this.database.prepare(`
      SELECT * FROM notification_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at
      LIMIT ?
    `).all(new Date().toISOString(), Math.max(1, Number(limit) || 20))
      .map(normalizeNotificationRow);
  }

  markNotificationSent(notificationId) {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE notification_outbox
      SET status = 'sent', updated_at = ?, sent_at = ?, last_error = ''
      WHERE id = ?
    `).run(now, now, notificationId);
  }

  markNotificationFailed(notificationId, errorMessage, retryAt) {
    this.database.prepare(`
      UPDATE notification_outbox
      SET status = 'pending', attempts = attempts + 1,
          next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      retryAt,
      String(errorMessage || '').slice(0, 500),
      new Date().toISOString(),
      notificationId,
    );
  }

  markNotificationAbandoned(notificationId, errorMessage) {
    this.database.prepare(`
      UPDATE notification_outbox
      SET status = 'failed', attempts = attempts + 1,
          last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      String(errorMessage || '').slice(0, 500),
      new Date().toISOString(),
      notificationId,
    );
  }

  recoverInterruptedRuns() {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE runs
        SET status = 'interrupted', error_code = 'server_restarted',
            error_message = '服务重启导致任务中断',
            progress_updated_at = ?, activity_count = activity_count + 1,
            finished_at = ?
        WHERE status = 'running'
      `).run(now, now);
      this.database.prepare(`
        UPDATE conversations
        SET status = ?, version = version + 1, updated_at = ?
        WHERE status IN (?, ?)
      `).run(
        AI_CONVERSATION_STATUSES.INTERRUPTED,
        now,
        AI_CONVERSATION_STATUSES.RUNNING,
        AI_CONVERSATION_STATUSES.QUEUED,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  insertMessage({
    conversationId,
    role,
    kind = AI_MESSAGE_KINDS.TEXT,
    content,
    payload = null,
    clientMutationId = '',
    runId = '',
  }) {
    const sequence = Number(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM messages WHERE conversation_id = ?
    `).get(conversationId)?.next_sequence || 1);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO messages (
        id, conversation_id, sequence, role, kind, content, payload_json,
        client_mutation_id, run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      conversationId,
      sequence,
      role,
      kind,
      String(content || '').slice(0, 200000),
      payload ? JSON.stringify(payload) : '',
      clientMutationId,
      runId,
      createdAt,
    );
    return {
      id,
      sequence,
      role,
      kind,
      content: String(content || '').slice(0, 200000),
      payload,
      runId,
      createdAt,
    };
  }

  withTransaction(task) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = task();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function normalizeConversationRow(row) {
  return {
    id: row.id,
    ownerOpenId: row.owner_open_id,
    ownerName: row.owner_name,
    projectId: row.project_id,
    toolId: row.tool_id,
    recordId: row.record_id,
    title: row.title,
    status: row.status,
    version: Number(row.version || 0),
    codexThreadId: row.codex_thread_id,
    skillVersion: row.skill_version,
    contextSummary: row.context_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMessageRow(row) {
  return {
    id: row.id,
    sequence: Number(row.sequence || 0),
    role: row.role,
    kind: String(row.kind || AI_MESSAGE_KINDS.TEXT),
    content: row.content,
    payload: parseJsonObject(row.payload_json),
    runId: row.run_id || '',
    createdAt: row.created_at,
  };
}

function normalizeRunRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    codexTurnId: row.codex_turn_id,
    model: row.model,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    progressStage: normalizeProgressStage(row.progress_stage),
    progressMessage: String(row.progress_message || ''),
    progressUpdatedAt: String(row.progress_updated_at || ''),
    activityCount: Math.max(0, Number(row.activity_count || 0)),
    attachmentSummary: normalizeAttachmentSummary(parseJsonObject(row.attachment_summary_json)),
    startedAt: row.started_at,
    finishedAt: row.finished_at || '',
  };
}

function normalizeQuestionSetRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    questions: normalizeStoredQuestions(parseJsonArray(row.questions_json)),
    status: row.status,
    answers: parseJsonObject(row.answers_json),
    answerClientMutationId: row.answer_client_mutation_id || '',
    createdAt: row.created_at,
    answeredAt: row.answered_at || '',
    cancelledAt: row.cancelled_at || '',
  };
}

function normalizeNotificationRow(row) {
  return {
    id: row.id,
    eventKey: row.event_key,
    ownerOpenId: row.owner_open_id,
    recipientOpenId: row.owner_open_id,
    eventType: row.event_type,
    payload: parseJsonObject(row.payload_json),
    status: row.status,
    attempts: Number(row.attempts || 0),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at || '',
  };
}

function normalizeSubmissionRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id || '',
    projectId: row.project_id,
    toolId: row.tool_id,
    recordId: row.record_id,
    workItemId: row.work_item_id || '',
    workItemTitle: row.work_item_title || '',
    projectName: row.project_name || '',
    authorOpenId: row.author_open_id,
    authorName: row.author_name,
    revisionAuthorOpenId: row.revision_author_open_id || row.author_open_id,
    revisionAuthorName: row.revision_author_name || row.author_name,
    title: row.title,
    summary: row.summary,
    markdown: row.markdown,
    sourceReferences: parseJsonArray(row.source_references_json),
    revision: Number(row.revision || 0),
    parentSubmissionId: row.parent_submission_id,
    rootSubmissionId: row.root_submission_id || row.id,
    status: row.status,
    submittedAt: row.submitted_at,
    withdrawnAt: row.withdrawn_at || '',
    reviewedByOpenId: row.reviewed_by_open_id || '',
    reviewedByName: row.reviewed_by_name || '',
    reviewedAt: row.reviewed_at || '',
    reviewReason: row.review_reason || '',
    supersededBySubmissionId: row.superseded_by_submission_id || '',
    supersededAt: row.superseded_at || '',
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function normalizeProgressStage(value) {
  const stage = String(value || '').trim();
  return AI_RUN_PROGRESS_STAGE_ORDER.includes(stage) ? stage : '';
}

function normalizeStoredQuestions(value) {
  return (Array.isArray(value) ? value : []).slice(0, 3).map((question) => ({
    id: String(question?.id || '').trim().slice(0, 100),
    header: String(question?.header || '').trim().slice(0, 80),
    question: String(question?.question || '').trim().slice(0, 2000),
    isOther: question?.isOther !== false,
    options: Array.isArray(question?.options)
      ? question.options.slice(0, 3).map((option) => ({
          label: String(option?.label || '').trim().slice(0, 200),
          description: String(option?.description || '').trim().slice(0, 1000),
        }))
      : [],
  })).filter((question) => question.id && question.question);
}

function normalizeAttachmentSummary(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    discoveredCount: Math.max(0, Number(source.discoveredCount || 0)),
    processedCount: Math.max(0, Number(source.processedCount || 0)),
    skippedCount: Math.max(0, Number(source.skippedCount || 0)),
    files: (Array.isArray(source.files) ? source.files : []).slice(0, 20).map((file) => ({
      name: String(file?.name || '附件').slice(0, 300),
      status: String(file?.status || 'skipped').slice(0, 30),
      kind: String(file?.kind || '').slice(0, 50),
      reason: String(file?.reason || '').slice(0, 500),
    })),
  };
}

function buildQuestionSetMessage(questions) {
  return [
    '继续生成方案前，需要你确认以下关键决策：',
    ...questions.map((question, index) => `${index + 1}. ${question.question}`),
  ].join('\n');
}

function buildQuestionAnswersMessage(questions, answers, additionalContext) {
  const answerById = new Map(
    (Array.isArray(answers) ? answers : []).map((answer) => [answer.questionId, answer]),
  );
  const lines = questions.map((question, index) => {
    const answer = answerById.get(question.id) || {};
    const text = [answer.optionLabel, answer.customText].filter(Boolean).join('：');
    return `${index + 1}. ${question.question}\n回答：${text || '未填写'}`;
  });
  if (additionalContext) {
    lines.push(`补充期望：${additionalContext}`);
  }
  return lines.join('\n\n');
}
