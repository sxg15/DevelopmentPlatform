import {
  createBitableRecord,
  deleteBitableRecord,
  fetchBitableRecord,
  fetchBitableRecords,
  getBitableFieldNames,
  updateBitableRecordFields,
} from '../integrations/bitableClient.js';
import { createTableSnapshotCache } from '../runtime/tableSnapshotCache.js';

export function createBitableTableDataService({
  config = {},
  bitable = {
    createRecord: createBitableRecord,
    deleteRecord: deleteBitableRecord,
    fetchRecord: fetchBitableRecord,
    fetchRecords: fetchBitableRecords,
    updateRecord: updateBitableRecordFields,
  },
  cache = createTableSnapshotCache({ maxSnapshots: config.maxSnapshots }),
  now = () => Date.now(),
} = {}) {
  const enabled = config.enabled !== false;
  const recordEntries = new Map();
  const contextsByTable = new Map();
  const maximumContexts = Math.max(64, normalizePositiveInteger(config.maxSnapshots, 128) * 2);

  async function readRecords(token, tableConfig, { consistency = 'cache' } = {}) {
    if (!enabled) {
      return bitable.fetchRecords(token, tableConfig);
    }
    const descriptor = describeTable(tableConfig);
    return cache.getOrLoad(
      descriptor.snapshotKey,
      {
        ...config,
        tableKey: descriptor.tableKey,
        viewId: descriptor.viewId,
      },
      () => bitable.fetchRecords(token, tableConfig),
      { force: consistency === 'fresh' },
    );
  }

  async function readRecord(token, appToken, tableId, recordId, { consistency = 'cache' } = {}) {
    if (!enabled) {
      return bitable.fetchRecord(token, appToken, tableId, recordId);
    }
    const key = buildRecordKey(appToken, tableId, recordId);
    if (!key) {
      return bitable.fetchRecord(token, appToken, tableId, recordId);
    }

    const entry = recordEntries.get(key);
    if (consistency !== 'fresh' && entry?.record && entry.freshUntil > now()) {
      entry.lastUsedAt = now();
      touchRecord(key, entry);
      return entry.record;
    }
    if (consistency !== 'fresh' && entry?.pending) {
      return entry.pending;
    }

    return loadFullRecord(token, appToken, tableId, recordId, { force: consistency === 'fresh' });
  }

  async function createRecord(token, appToken, tableId, fields) {
    const record = await bitable.createRecord(token, appToken, tableId, fields);
    invalidateAfterWrite(appToken, tableId, getRecordId(record));
    return record;
  }

  async function updateRecord(token, appToken, tableId, recordId, fields) {
    const record = await bitable.updateRecord(token, appToken, tableId, recordId, fields);
    invalidateAfterWrite(appToken, tableId, recordId);
    return record;
  }

  async function deleteRecord(token, appToken, tableId, recordId) {
    const result = await bitable.deleteRecord(token, appToken, tableId, recordId);
    invalidateAfterWrite(appToken, tableId, recordId);
    return result;
  }

  async function refreshRecord(token, appToken, tableId, recordId) {
    invalidateTableSnapshots(appToken, tableId);
    return loadFullRecord(token, appToken, tableId, recordId, { force: true });
  }

  function invalidateTable(appToken, tableId) {
    invalidateTableSnapshots(appToken, tableId);
    removeTableRecords(appToken, tableId);
  }

  function invalidateAfterWrite(appToken, tableId, recordId) {
    invalidateTableSnapshots(appToken, tableId);
    removeRecord(appToken, tableId, recordId);
  }

  function invalidateTableSnapshots(appToken, tableId) {
    if (enabled) {
      cache.invalidateTable(buildTableKey(appToken, tableId));
    }
  }

  function removeCachedRecord(appToken, tableId, recordId) {
    invalidateAfterWrite(appToken, tableId, recordId);
  }

  function registerTableContext(context) {
    const normalized = normalizeContext(context);
    if (!normalized) {
      return null;
    }
    const existing = contextsByTable.get(normalized.tableKey) || [];
    const index = existing.findIndex((item) => item.contextKey === normalized.contextKey);
    if (index >= 0) {
      existing[index] = normalized;
    } else {
      existing.push(normalized);
    }
    contextsByTable.set(normalized.tableKey, existing);
    trimContexts();
    return normalized;
  }

  function getTableContexts(appToken, tableId) {
    const tableKey = buildTableKey(appToken, tableId);
    const contexts = contextsByTable.get(tableKey) || [];
    const timestamp = now();
    for (const context of contexts) {
      context.lastUsedAt = timestamp;
    }
    return contexts.map(copyContext);
  }

  async function refreshHotTables(token, { limit = 16, delayMs = 250 } = {}) {
    const contexts = getRegisteredContexts().slice(0, normalizePositiveInteger(limit, 16));
    const reconciled = [];
    for (let index = 0; index < contexts.length; index += 1) {
      if (index > 0 && delayMs > 0) {
        await wait(delayMs);
      }
      try {
        const descriptor = describeTable(contexts[index]);
        const previous = cache.getSnapshot(descriptor.snapshotKey);
        const records = await readRecords(token, contexts[index], { consistency: 'fresh' });
        if (previous) {
          reconciled.push({
            context: contexts[index],
            changes: diffRecords(previous, records),
          });
        }
      } catch {
        // Recovery is best effort. The regular read path surfaces normal errors.
      }
    }
    return reconciled;
  }

  function getHealth() {
    return {
      enabled,
      ...cache.getStats(),
      records: recordEntries.size,
      registeredTables: contextsByTable.size,
      registeredContexts: getRegisteredContexts().length,
    };
  }

  return {
    createRecord,
    deleteRecord,
    getHealth,
    getTableContexts,
    invalidateAfterWrite,
    invalidateTable,
    readRecord,
    readRecords,
    refreshHotTables,
    refreshRecord,
    registerTableContext,
    removeCachedRecord,
    updateRecord,
  };

  async function loadFullRecord(token, appToken, tableId, recordId, { force = false } = {}) {
    const key = buildRecordKey(appToken, tableId, recordId);
    if (!key) {
      return bitable.fetchRecord(token, appToken, tableId, recordId);
    }
    const previous = recordEntries.get(key);
    if (!force && previous?.pending) {
      return previous.pending;
    }

    const entry = previous || {
      record: null,
      freshUntil: 0,
      generation: 0,
      pending: null,
      lastUsedAt: now(),
    };
    if (force) {
      entry.generation += 1;
    }
    const generation = entry.generation;
    const pending = Promise.resolve()
      .then(() => bitable.fetchRecord(token, appToken, tableId, recordId))
      .then((record) => {
        if (recordEntries.get(key) === entry && entry.generation === generation) {
          if (record) {
            entry.record = record;
            entry.freshUntil = now() + normalizePositiveInteger(config.freshTtlMs, 30_000);
            entry.lastUsedAt = now();
            touchRecord(key, entry);
          } else {
            recordEntries.delete(key);
          }
        }
        return record;
      })
      .finally(() => {
        if (recordEntries.get(key) === entry && entry.pending === pending) {
          entry.pending = null;
        }
      });

    entry.pending = pending;
    recordEntries.set(key, entry);
    trimRecords();
    return pending;
  }

  function removeRecord(appToken, tableId, recordId) {
    const key = buildRecordKey(appToken, tableId, recordId);
    const entry = recordEntries.get(key);
    if (!entry) {
      return;
    }
    entry.generation += 1;
    recordEntries.delete(key);
  }

  function removeTableRecords(appToken, tableId) {
    const prefix = `${buildTableKey(appToken, tableId)}|`;
    for (const [key, entry] of recordEntries.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      entry.generation += 1;
      recordEntries.delete(key);
    }
  }

  function touchRecord(key, entry) {
    recordEntries.delete(key);
    recordEntries.set(key, entry);
  }

  function trimRecords() {
    const maximum = normalizePositiveInteger(config.maxSnapshots, 128) * 4;
    while (recordEntries.size > maximum) {
      const candidate = [...recordEntries.entries()].find(([, entry]) => !entry.pending);
      if (!candidate) {
        return;
      }
      recordEntries.delete(candidate[0]);
    }
  }

  function trimContexts() {
    const contexts = getRegisteredContexts();
    if (contexts.length <= maximumContexts) {
      return;
    }
    const removable = contexts
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
      .slice(0, contexts.length - maximumContexts);
    for (const context of removable) {
      const entries = contextsByTable.get(context.tableKey) || [];
      const remaining = entries.filter((item) => item.contextKey !== context.contextKey);
      if (remaining.length > 0) {
        contextsByTable.set(context.tableKey, remaining);
      } else {
        contextsByTable.delete(context.tableKey);
      }
    }
  }

  function getRegisteredContexts() {
    return [...contextsByTable.values()].flat().map(copyContext);
  }
}

export function buildBitableTableKey(appToken, tableId) {
  return buildTableKey(appToken, tableId);
}

function describeTable(tableConfig) {
  const tableKey = buildTableKey(tableConfig?.appToken, tableConfig?.tableId);
  const viewId = String(tableConfig?.viewId || '').trim();
  const fieldNames = getBitableFieldNames(tableConfig).sort().join('\u001f');
  return {
    tableKey,
    viewId,
    snapshotKey: [tableKey, viewId, fieldNames].join('|'),
  };
}

function normalizeContext(context) {
  const appToken = String(context?.appToken || '').trim();
  const tableId = String(context?.tableId || '').trim();
  const projectId = String(context?.projectId || '').trim();
  const toolId = String(context?.toolId || '').trim();
  if (!appToken || !tableId || !projectId || !toolId) {
    return null;
  }
  const fieldNames = context?.fieldNames || {};
  const projection = getBitableFieldNames({ fieldNames }).sort().join('\u001f');
  const tableKey = buildTableKey(appToken, tableId);
  const viewId = String(context?.viewId || '').trim();
  return {
    appToken,
    tableId,
    tableKey,
    viewId,
    fieldNames,
    projectId,
    toolId,
    contextKey: [tableKey, projectId, toolId, viewId, projection].join('|'),
    lastUsedAt: Date.now(),
  };
}

function copyContext(context) {
  return {
    appToken: context.appToken,
    tableId: context.tableId,
    tableKey: context.tableKey,
    viewId: context.viewId,
    fieldNames: context.fieldNames,
    projectId: context.projectId,
    toolId: context.toolId,
    contextKey: context.contextKey,
    lastUsedAt: context.lastUsedAt,
  };
}

function diffRecords(previous, next) {
  const previousById = new Map((previous || []).map((record) => [getRecordId(record), record]).filter(([recordId]) => recordId));
  const nextById = new Map((next || []).map((record) => [getRecordId(record), record]).filter(([recordId]) => recordId));
  const changes = [];
  for (const [recordId, record] of previousById.entries()) {
    if (!nextById.has(recordId)) {
      changes.push({ recordId, changeType: 'deleted' });
    } else if (stableStringify(record) !== stableStringify(nextById.get(recordId))) {
      changes.push({ recordId, changeType: 'updated' });
    }
  }
  for (const recordId of nextById.keys()) {
    if (!previousById.has(recordId)) {
      changes.push({ recordId, changeType: 'updated' });
    }
  }
  return changes;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function getRecordId(record) {
  return String(record?.record_id || record?.recordId || record?.id || '').trim();
}

function buildRecordKey(appToken, tableId, recordId) {
  const tableKey = buildTableKey(appToken, tableId);
  const normalizedRecordId = String(recordId || '').trim();
  return tableKey && normalizedRecordId ? `${tableKey}|${normalizedRecordId}` : '';
}

function buildTableKey(appToken, tableId) {
  return `${String(appToken || '').trim()}|${String(tableId || '').trim()}`;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
