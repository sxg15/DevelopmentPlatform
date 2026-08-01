import { createKeyedTaskQueue } from '../runtime/keyedTaskQueue.js';

export function createFeishuBitableEventService({
  enabled = true,
  eventDebounceMs = 500,
  eventDedupeTtlMs = 24 * 60 * 60 * 1000,
  maxEventIds = 10_000,
  getTenantToken,
  tableDataService,
  longConnection,
  documentSubscriptions,
  publishWorkItemUpdated = () => {},
  onError = () => {},
} = {}) {
  const queue = createKeyedTaskQueue();
  const seenEventIds = new Map();
  const pendingRecords = new Map();
  let lastEventAt = 0;
  let connectionStatus = enabled ? 'idle' : 'disabled';
  let lastErrorCode = '';

  if (longConnection?.setEventHandler) {
    longConnection.setEventHandler(handleEvent);
  }
  if (longConnection?.setStatusHandler) {
    longConnection.setStatusHandler((status) => {
      connectionStatus = status;
      if (status === 'connected') {
        void refreshAfterRecovery();
      }
    });
  }

  async function start() {
    if (!enabled) {
      connectionStatus = 'disabled';
      return getHealth();
    }
    const health = await longConnection?.start?.();
    connectionStatus = health?.status || 'degraded';
    return getHealth();
  }

  async function stop() {
    for (const pending of pendingRecords.values()) {
      clearTimeout(pending.timer);
    }
    pendingRecords.clear();
    await longConnection?.stop?.();
    connectionStatus = enabled ? 'stopped' : 'disabled';
  }

  function registerTableContext(context) {
    const normalized = tableDataService?.registerTableContext(context);
    if (normalized && enabled) {
      void documentSubscriptions?.ensureBitableRecordEvents(normalized.appToken);
    }
    return normalized;
  }

  async function handleEvent(payload) {
    if (!enabled) {
      return;
    }
    const events = normalizeBitableRecordEvents(payload);
    if (events.length === 0) {
      return;
    }
    lastEventAt = Date.now();
    for (const event of events) {
      if (event.eventId && hasSeen(event.eventId)) {
        continue;
      }
      if (event.eventId) {
        rememberEvent(event.eventId);
      }
      schedule(event);
    }
  }

  function schedule(event) {
    const key = `${event.appToken}|${event.tableId}|${event.recordId}`;
    const existing = pendingRecords.get(key);
    if (existing) {
      existing.event = mergeEvents(existing.event, event);
      return;
    }
    const pending = {
      event,
      timer: setTimeout(() => {
        pendingRecords.delete(key);
        void queue.run(key, () => processEvent(pending.event));
      }, normalizePositiveInteger(eventDebounceMs, 500)),
    };
    pendingRecords.set(key, pending);
  }

  async function processEvent(event) {
    const contexts = tableDataService?.getTableContexts(event.appToken, event.tableId) || [];
    if (contexts.length === 0) {
      return;
    }

    try {
      if (event.changeType === 'deleted') {
        tableDataService.removeCachedRecord(event.appToken, event.tableId, event.recordId);
      } else if (event.changeType === 'updated') {
        const token = await getTenantToken();
        await tableDataService.refreshRecord(token, event.appToken, event.tableId, event.recordId);
      } else {
        tableDataService.invalidateTable(event.appToken, event.tableId);
      }
      for (const context of contexts) {
        publishWorkItemUpdated({
          projectId: context.projectId,
          toolId: context.toolId,
          recordId: event.recordId,
          changeType: event.changeType === 'deleted' ? 'deleted' : 'updated',
        });
      }
    } catch (error) {
      tableDataService.invalidateTable(event.appToken, event.tableId);
      lastErrorCode = getSafeErrorCode(error);
      onError(error);
      for (const context of contexts) {
        publishWorkItemUpdated({
          projectId: context.projectId,
          toolId: context.toolId,
          recordId: event.recordId,
          changeType: 'updated',
        });
      }
    }
  }

  async function refreshAfterRecovery() {
    try {
      const token = await getTenantToken();
      const reconciled = await tableDataService?.refreshHotTables(token);
      for (const result of reconciled || []) {
        for (const change of result.changes || []) {
          publishWorkItemUpdated({
            projectId: result.context.projectId,
            toolId: result.context.toolId,
            recordId: change.recordId,
            changeType: change.changeType === 'deleted' ? 'deleted' : 'updated',
          });
        }
      }
    } catch (error) {
      lastErrorCode = getSafeErrorCode(error);
      onError(error);
    }
  }

  function hasSeen(eventId) {
    const expiresAt = seenEventIds.get(eventId);
    return Number(expiresAt) > Date.now();
  }

  function rememberEvent(eventId) {
    const now = Date.now();
    for (const [key, expiresAt] of seenEventIds.entries()) {
      if (expiresAt <= now) {
        seenEventIds.delete(key);
      }
    }
    while (seenEventIds.size >= normalizePositiveInteger(maxEventIds, 10_000)) {
      const oldest = seenEventIds.keys().next().value;
      if (!oldest) {
        break;
      }
      seenEventIds.delete(oldest);
    }
    seenEventIds.set(eventId, now + normalizePositiveInteger(eventDedupeTtlMs, 86_400_000));
  }

  function getHealth() {
    const longConnectionHealth = longConnection?.getHealth?.() || {};
    return {
      enabled,
      connectionStatus: longConnectionHealth.status || connectionStatus,
      lastEventAt,
      lastErrorCode,
      queuedRecords: pendingRecords.size,
      dedupeEntries: seenEventIds.size,
      ...longConnectionHealth,
      ...(documentSubscriptions?.getHealth?.() || {}),
    };
  }

  return {
    getHealth,
    handleEvent,
    registerTableContext,
    start,
    stop,
  };
}

export function normalizeBitableRecordEvent(payload) {
  return normalizeBitableRecordEvents(payload)[0] || null;
}

export function normalizeBitableRecordEvents(payload) {
  const event = payload?.event || payload?.data?.event || payload?.data || payload;
  const appToken = findText(event, ['app_token', 'appToken', 'file_token', 'fileToken']);
  const tableId = findText(event, ['table_id', 'tableId']);
  if (!appToken || !tableId) {
    return [];
  }
  const baseEventId = findText(event, ['event_id', 'eventId', 'uuid'])
    || findText(payload?.header || payload, ['event_id', 'eventId', 'uuid']);
  const actions = Array.isArray(event?.action_list) && event.action_list.length > 0
    ? event.action_list
    : [event];
  return actions
    .map((action, index) => {
      const recordId = findText(action, ['record_id', 'recordId']);
      if (!recordId) {
        return null;
      }
      return {
        eventId: baseEventId ? `${baseEventId}:${recordId}:${index}` : '',
        appToken,
        tableId,
        recordId,
        changeType: normalizeChangeType(findText(action, ['action', 'change_type', 'changeType', 'type'])),
      };
    })
    .filter(Boolean);
}

function findText(source, keys) {
  for (const key of keys) {
    const value = String(source?.[key] || '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function normalizeChangeType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['delete', 'deleted', 'remove', 'removed'].includes(normalized)) {
    return 'deleted';
  }
  if (['create', 'created', 'add', 'added', 'update', 'updated', 'edit', 'edited', 'modify', 'modified'].includes(normalized)) {
    return 'updated';
  }
  return 'unknown';
}

function mergeEvents(previous, next) {
  if (next.changeType === 'deleted') {
    return next;
  }
  if (previous.changeType === 'deleted') {
    return next;
  }
  return next.changeType === 'unknown' ? previous : next;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function getSafeErrorCode(error) {
  return String(error?.code || error?.name || 'event_processing_failed')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 80) || 'event_processing_failed';
}
