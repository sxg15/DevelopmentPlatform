import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  AI_CONVERSATION_STATUSES,
  AI_PLAN_STATUSES,
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
        content TEXT NOT NULL,
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
        started_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_runs_conversation
      ON runs(conversation_id, started_at DESC);

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
        project_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL DEFAULT '',
        work_item_title TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
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

      CREATE INDEX IF NOT EXISTS idx_plan_submissions_project
      ON plan_submissions(project_id, submitted_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_submissions_adopted
      ON plan_submissions(project_id, tool_id, record_id)
      WHERE status = 'adopted';
    `);
    ensureColumn(this.database, 'plan_submissions', 'work_item_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'work_item_title', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, 'plan_submissions', 'project_name', "TEXT NOT NULL DEFAULT ''");

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
  }) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO conversations (
        id, owner_open_id, owner_name, project_id, tool_id, record_id,
        title, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      ownerOpenId,
      ownerName,
      projectId,
      toolId,
      recordId,
      String(title || '新的 AI 计划').slice(0, 120),
      AI_CONVERSATION_STATUSES.IDLE,
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
        SELECT id, sequence, role, content, run_id, created_at
        FROM messages WHERE conversation_id = ? ORDER BY sequence
      `).all(conversationId).map(normalizeMessageRow);
    }
    conversation.draft = this.getDraft(conversationId);
    conversation.activeRun = this.getActiveRun(conversationId);
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
          SELECT id, sequence, role, content, run_id, created_at
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
      if (conversation.status === AI_CONVERSATION_STATUSES.RUNNING) {
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
          id, conversation_id, user_message_id, model, status, started_at
        ) VALUES (?, ?, ?, ?, 'running', ?)
      `).run(id, conversationId, userMessageId, model, now);
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
        UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?
      `).run(now, runId);
      this.database.prepare(`
        UPDATE conversations
        SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(AI_CONVERSATION_STATUSES.READY, now, conversationId);
      return message;
    });
  }

  failRun({ runId, conversationId, status = 'failed', errorCode = '', errorMessage = '' }) {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE runs
      SET status = ?, error_code = ?, error_message = ?, finished_at = ?
      WHERE id = ?
    `).run(status, errorCode, String(errorMessage || '').slice(0, 1000), now, runId);
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

      const previous = this.database.prepare(`
        SELECT id, revision FROM plan_submissions
        WHERE project_id = ? AND tool_id = ? AND record_id = ? AND author_open_id = ?
        ORDER BY revision DESC LIMIT 1
      `).get(
        conversation.projectId,
        conversation.toolId,
        conversation.recordId,
        ownerOpenId,
      );
      const id = crypto.randomUUID();
      const revision = Number(previous?.revision || 0) + 1;
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO plan_submissions (
          id, project_id, tool_id, record_id, work_item_id, work_item_title,
          project_name, author_open_id, author_name,
          title, summary, markdown, source_references_json, revision,
          parent_submission_id, status, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        conversation.projectId,
        conversation.toolId,
        conversation.recordId,
        String(workItemId || '').slice(0, 200),
        String(workItemTitle || '').slice(0, 500),
        String(projectName || '').slice(0, 500),
        ownerOpenId,
        conversation.ownerName,
        String(title || '未命名方案').slice(0, 200),
        String(summary || '').slice(0, 2000),
        String(markdown || '').slice(0, 200000),
        JSON.stringify(normalizeAiPlanSourceReferences(sourceReferences)),
        revision,
        previous?.id || '',
        AI_PLAN_STATUSES.CANDIDATE,
        now,
      );
      return this.getSubmission(id);
    });
  }

  listSubmissions({ projectId, allowedToolIds, toolId = '', search = '', status = '' }) {
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
    if (status) {
      where.push('status = ?');
      params.push(status);
    } else {
      where.push('status <> ?');
      params.push(AI_PLAN_STATUSES.WITHDRAWN);
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

  getSubmission(submissionId) {
    const row = this.database.prepare(`
      SELECT * FROM plan_submissions WHERE id = ?
    `).get(submissionId);
    return row ? normalizeSubmissionRow(row) : null;
  }

  adoptSubmission(submissionId) {
    return this.withTransaction(() => {
      const submission = this.getSubmission(submissionId);
      if (!submission || submission.status === AI_PLAN_STATUSES.WITHDRAWN) {
        return null;
      }
      this.database.prepare(`
        UPDATE plan_submissions SET status = ?
        WHERE project_id = ? AND tool_id = ? AND record_id = ? AND status = ?
      `).run(
        AI_PLAN_STATUSES.CANDIDATE,
        submission.projectId,
        submission.toolId,
        submission.recordId,
        AI_PLAN_STATUSES.ADOPTED,
      );
      this.database.prepare(`
        UPDATE plan_submissions SET status = ? WHERE id = ?
      `).run(AI_PLAN_STATUSES.ADOPTED, submissionId);
      return this.getSubmission(submissionId);
    });
  }

  withdrawSubmission(submissionId, ownerOpenId) {
    const result = this.database.prepare(`
      UPDATE plan_submissions SET status = ?, withdrawn_at = ?
      WHERE id = ? AND author_open_id = ? AND status = ?
    `).run(
      AI_PLAN_STATUSES.WITHDRAWN,
      new Date().toISOString(),
      submissionId,
      ownerOpenId,
      AI_PLAN_STATUSES.CANDIDATE,
    );
    return result.changes > 0 ? this.getSubmission(submissionId) : null;
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

  recoverInterruptedRuns() {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE runs
        SET status = 'interrupted', error_code = 'server_restarted',
            error_message = '服务重启导致任务中断', finished_at = ?
        WHERE status = 'running'
      `).run(now);
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
    content,
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
        id, conversation_id, sequence, role, content,
        client_mutation_id, run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      conversationId,
      sequence,
      role,
      String(content || '').slice(0, 200000),
      clientMutationId,
      runId,
      createdAt,
    );
    return {
      id,
      sequence,
      role,
      content: String(content || '').slice(0, 200000),
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
    content: row.content,
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
    startedAt: row.started_at,
    finishedAt: row.finished_at || '',
  };
}

function normalizeSubmissionRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    toolId: row.tool_id,
    recordId: row.record_id,
    workItemId: row.work_item_id || '',
    workItemTitle: row.work_item_title || '',
    projectName: row.project_name || '',
    authorOpenId: row.author_open_id,
    authorName: row.author_name,
    title: row.title,
    summary: row.summary,
    markdown: row.markdown,
    sourceReferences: parseJsonArray(row.source_references_json),
    revision: Number(row.revision || 0),
    parentSubmissionId: row.parent_submission_id,
    status: row.status,
    submittedAt: row.submitted_at,
    withdrawnAt: row.withdrawn_at || '',
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

function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}
