import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createEmptyAssistantDraft, normalizeAssistantDraft } from '../../shared/feishuAssistantDefinitions.js';

export class FeishuAssistantRepository {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS assistant_conversations (
        owner_open_id TEXT PRIMARY KEY,
        owner_name TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL DEFAULT '',
        codex_thread_id TEXT NOT NULL DEFAULT '',
        context_summary TEXT NOT NULL DEFAULT '',
        draft_json TEXT NOT NULL DEFAULT '',
        draft_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assistant_inbox (
        event_id TEXT PRIMARY KEY,
        owner_open_id TEXT NOT NULL,
        owner_name TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_inbox_pending
      ON assistant_inbox(status, created_at);

      CREATE TABLE IF NOT EXISTS assistant_card_actions (
        id TEXT PRIMARY KEY,
        owner_open_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        draft_version INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assistant_executions (
        mutation_id TEXT PRIMARY KEY,
        owner_open_id TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assistant_outbox (
        id TEXT PRIMARY KEY,
        owner_open_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_outbox_pending
      ON assistant_outbox(status, next_attempt_at, created_at);
    `);
  }

  close() {
    this.database.close();
  }

  enqueueInbound(event) {
    const now = new Date().toISOString();
    const eventId = String(event?.eventId || '').trim();
    const ownerOpenId = String(event?.ownerOpenId || '').trim();
    const messageId = String(event?.messageId || '').trim();
    if (!eventId) {
      throw new Error('缺少飞书消息事件标识');
    }
    if (messageId) {
      const duplicate = this.database.prepare(`
        SELECT 1 FROM assistant_inbox
        WHERE owner_open_id = ? AND message_id = ?
        LIMIT 1
      `).get(ownerOpenId, messageId);
      if (duplicate) {
        return false;
      }
    }
    const result = this.database.prepare(`
      INSERT INTO assistant_inbox (
        event_id, owner_open_id, owner_name, chat_id, message_id,
        text, mentions_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).run(
      eventId,
      ownerOpenId,
      String(event.ownerName || '').slice(0, 200),
      String(event.chatId || ''),
      messageId,
      String(event.text || '').slice(0, 20_000),
      JSON.stringify(Array.isArray(event.mentions) ? event.mentions : []),
      now,
      now,
    );
    return result.changes > 0;
  }

  getNextQueuedInboundOwner() {
    const row = this.database.prepare(`
      SELECT owner_open_id FROM assistant_inbox
      WHERE status = 'queued'
      ORDER BY created_at
      LIMIT 1
    `).get();
    return String(row?.owner_open_id || '').trim();
  }

  claimNextInbound(ownerOpenId = '') {
    return this.withTransaction(() => {
      const row = ownerOpenId
        ? this.database.prepare(`
          SELECT * FROM assistant_inbox
          WHERE owner_open_id = ? AND status = 'queued'
          ORDER BY created_at LIMIT 1
        `).get(ownerOpenId)
        : this.database.prepare(`
          SELECT * FROM assistant_inbox
          WHERE status = 'queued'
          ORDER BY created_at LIMIT 1
        `).get();
      if (!row) {
        return null;
      }
      this.database.prepare(`
        UPDATE assistant_inbox
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE event_id = ? AND status = 'queued'
      `).run(new Date().toISOString(), row.event_id);
      return normalizeInboxRow(row);
    });
  }

  completeInbound(eventId) {
    this.database.prepare(`
      UPDATE assistant_inbox SET status = 'completed', updated_at = ?
      WHERE event_id = ?
    `).run(new Date().toISOString(), eventId);
  }

  retryInbound(eventId) {
    this.database.prepare(`
      UPDATE assistant_inbox SET status = 'queued', updated_at = ?
      WHERE event_id = ?
    `).run(new Date().toISOString(), eventId);
  }

  recoverQueuedInbound() {
    this.database.prepare(`
      UPDATE assistant_inbox SET status = 'queued', updated_at = ?
      WHERE status = 'processing'
    `).run(new Date().toISOString());
  }

  discardUnsafePendingOutbound() {
    const rows = this.database.prepare(`
      SELECT id, payload_json FROM assistant_outbox
      WHERE status = 'pending'
    `).all();
    const unsafeIds = rows.flatMap((row) => (
      isUnsafeOutboundPayload(parseObject(row.payload_json)) ? [row.id] : []
    ));
    if (unsafeIds.length === 0) {
      return 0;
    }
    const statement = this.database.prepare(`
      UPDATE assistant_outbox
      SET status = 'discarded', updated_at = ?
      WHERE id = ?
    `);
    const now = new Date().toISOString();
    this.withTransaction(() => {
      for (const id of unsafeIds) {
        statement.run(now, id);
      }
    });
    return unsafeIds.length;
  }

  getConversation(ownerOpenId) {
    const row = this.database.prepare(`
      SELECT * FROM assistant_conversations WHERE owner_open_id = ?
    `).get(ownerOpenId);
    return normalizeConversationRow(row);
  }

  saveConversation({
    ownerOpenId,
    ownerName = '',
    chatId = '',
    codexThreadId = '',
    contextSummary = '',
    draft,
    draftVersion,
  }) {
    const existing = this.getConversation(ownerOpenId);
    const nextDraft = draft === undefined
      ? existing?.draft || createEmptyAssistantDraft()
      : normalizeAssistantDraft(draft);
    const nextVersion = Number.isInteger(draftVersion)
      ? draftVersion
      : Math.max(0, Number(existing?.draftVersion || 0));
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO assistant_conversations (
        owner_open_id, owner_name, chat_id, codex_thread_id,
        context_summary, draft_json, draft_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_open_id) DO UPDATE SET
        owner_name = excluded.owner_name,
        chat_id = excluded.chat_id,
        codex_thread_id = excluded.codex_thread_id,
        context_summary = excluded.context_summary,
        draft_json = excluded.draft_json,
        draft_version = excluded.draft_version,
        updated_at = excluded.updated_at
    `).run(
      ownerOpenId,
      String(ownerName || existing?.ownerName || '').slice(0, 200),
      String(chatId || existing?.chatId || '').slice(0, 200),
      String(codexThreadId || existing?.codexThreadId || '').slice(0, 200),
      String(contextSummary || existing?.contextSummary || '').slice(0, 20_000),
      JSON.stringify(nextDraft),
      nextVersion,
      now,
    );
    return this.getConversation(ownerOpenId);
  }

  clearDraft(ownerOpenId) {
    const conversation = this.getConversation(ownerOpenId);
    if (!conversation) {
      return null;
    }
    return this.saveConversation({
      ...conversation,
      draft: createEmptyAssistantDraft(),
      draftVersion: conversation.draftVersion + 1,
    });
  }

  createCardAction({ ownerOpenId, actionType, payload, draftVersion, expiresAt }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO assistant_card_actions (
        id, owner_open_id, action_type, payload_json, draft_version, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ownerOpenId,
      String(actionType || '').slice(0, 100),
      JSON.stringify(payload || {}),
      Number(draftVersion || 0),
      expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt || ''),
      now,
    );
    return id;
  }

  consumeCardAction({ actionId, ownerOpenId }) {
    return this.withTransaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM assistant_card_actions WHERE id = ? AND owner_open_id = ?
      `).get(actionId, ownerOpenId);
      if (!row) {
        return { status: 'missing' };
      }
      if (row.consumed_at) {
        return { status: 'consumed' };
      }
      if (Date.parse(row.expires_at) <= Date.now()) {
        return { status: 'expired' };
      }
      this.database.prepare(`
        UPDATE assistant_card_actions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL
      `).run(new Date().toISOString(), actionId);
      return {
        status: 'ok',
        id: row.id,
        ownerOpenId: row.owner_open_id,
        actionType: row.action_type,
        payload: parseObject(row.payload_json),
        draftVersion: Number(row.draft_version || 0),
      };
    });
  }

  beginExecution({ mutationId, ownerOpenId }) {
    const existing = this.database.prepare(`
      SELECT * FROM assistant_executions WHERE mutation_id = ?
    `).get(mutationId);
    if (existing) {
      return normalizeExecutionRow(existing);
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO assistant_executions (
        mutation_id, owner_open_id, state, updated_at, created_at
      ) VALUES (?, ?, 'creating', ?, ?)
    `).run(mutationId, ownerOpenId, now, now);
    return {
      mutationId,
      ownerOpenId,
      state: 'creating',
      result: null,
    };
  }

  completeExecution(mutationId, result) {
    this.database.prepare(`
      UPDATE assistant_executions
      SET state = 'completed', result_json = ?, updated_at = ?
      WHERE mutation_id = ?
    `).run(JSON.stringify(result || {}), new Date().toISOString(), mutationId);
    return this.getExecution(mutationId);
  }

  getExecution(mutationId) {
    const row = this.database.prepare(`
      SELECT * FROM assistant_executions WHERE mutation_id = ?
    `).get(mutationId);
    return normalizeExecutionRow(row);
  }

  enqueueOutbound(ownerOpenId, payload) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const status = isUnsafeOutboundPayload(payload) ? 'discarded' : 'pending';
    this.database.prepare(`
      INSERT INTO assistant_outbox (
        id, owner_open_id, payload_json, status, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, ownerOpenId, JSON.stringify(payload || {}), status, now, now, now);
    return id;
  }

  listPendingOutbound(limit = 20) {
    return this.database.prepare(`
      SELECT * FROM assistant_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at LIMIT ?
    `).all(new Date().toISOString(), Math.max(1, Number(limit) || 20)).map((row) => ({
      id: row.id,
      ownerOpenId: row.owner_open_id,
      payload: parseObject(row.payload_json),
      attempts: Number(row.attempts || 0),
    }));
  }

  markOutboundSent(id) {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE assistant_outbox
      SET status = 'sent', sent_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
  }

  markOutboundFailed(id, delayMs = 30_000) {
    this.database.prepare(`
      UPDATE assistant_outbox
      SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
      WHERE id = ?
    `).run(new Date(Date.now() + delayMs).toISOString(), new Date().toISOString(), id);
  }

  prune({ retentionDays = 30 } = {}) {
    const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000).toISOString();
    this.database.prepare(`
      DELETE FROM assistant_inbox WHERE created_at < ?
    `).run(cutoff);
    this.database.prepare(`
      DELETE FROM assistant_outbox WHERE created_at < ?
    `).run(cutoff);
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
  if (!row) {
    return null;
  }
  return {
    ownerOpenId: row.owner_open_id,
    ownerName: row.owner_name || '',
    chatId: row.chat_id || '',
    codexThreadId: row.codex_thread_id || '',
    contextSummary: row.context_summary || '',
    draft: normalizeAssistantDraft(parseObject(row.draft_json)),
    draftVersion: Number(row.draft_version || 0),
    updatedAt: row.updated_at,
  };
}

function normalizeInboxRow(row) {
  return {
    eventId: row.event_id,
    ownerOpenId: row.owner_open_id,
    ownerName: row.owner_name || '',
    chatId: row.chat_id || '',
    messageId: row.message_id || '',
    text: row.text || '',
    mentions: parseArray(row.mentions_json),
  };
}

function normalizeExecutionRow(row) {
  if (!row) {
    return null;
  }
  return {
    mutationId: row.mutation_id,
    ownerOpenId: row.owner_open_id,
    state: row.state,
    result: parseObject(row.result_json),
  };
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isUnsafeOutboundPayload(payload) {
  const content = String(payload?.content || '');
  return /unexpected status\s+5\d\d|bad gateway|upstream request failed|https?:\/\/127\.0\.0\.1:\d+\/responses|request id:/i.test(
    content,
  );
}
