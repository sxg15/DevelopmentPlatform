import assert from 'node:assert/strict';
import test from 'node:test';

import { createBitableTableDataService } from '../server/services/bitableTableDataService.js';
import {
  createFeishuBitableEventService,
  normalizeBitableRecordEvents,
} from '../server/services/feishuBitableEventService.js';
import { matchesBackendProcess } from '../server/runtime/backendProcessController.js';
import { createTableSnapshotCache } from '../server/runtime/tableSnapshotCache.js';

test('table snapshot cache coalesces loads and rejects an invalidated in-flight result', async () => {
  let timestamp = 1_000;
  let loads = 0;
  const cache = createTableSnapshotCache({
    maxSnapshots: 2,
    now: () => timestamp,
  });
  const options = {
    tableKey: 'app|table',
    viewId: '',
    freshTtlMs: 10,
    staleWhileRevalidateMs: 50,
  };
  let resolveLoad;
  const firstLoad = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  const loader = async () => {
    loads += 1;
    return firstLoad;
  };

  const pending = cache.getOrLoad('snapshot', options, loader);
  const shared = cache.getOrLoad('snapshot', options, loader);
  resolveLoad([{ record_id: 'rec-1', fields: { title: 'old' } }]);
  assert.deepEqual(await pending, await shared);
  assert.equal(loads, 1);

  let resolveOldRefresh;
  const oldRefresh = cache.getOrLoad(
    'snapshot',
    options,
    () => new Promise((resolve) => {
      resolveOldRefresh = resolve;
    }),
    { force: true },
  );
  await Promise.resolve();
  cache.invalidateTable('app|table');
  const currentRefresh = cache.getOrLoad('snapshot', options, async () => {
    loads += 1;
    return [{ record_id: 'rec-1', fields: { title: 'current' } }];
  });
  resolveOldRefresh([{ record_id: 'rec-1', fields: { title: 'stale' } }]);
  await oldRefresh;
  assert.equal((await currentRefresh)[0].fields.title, 'current');
  assert.equal(cache.getSnapshot('snapshot')[0].fields.title, 'current');
  assert.equal(loads, 2);
});

test('cache-aware Bitable gateway never treats a partial write response as a complete record', async () => {
  const calls = [];
  const storedRecord = {
    record_id: 'rec-1',
    fields: {
      title: 'first',
      assignees: [{ open_id: 'ou-handler', name: '处理人' }],
      status: '待处理',
    },
  };
  const gateway = createBitableTableDataService({
    config: {
      enabled: true,
      freshTtlMs: 60_000,
      staleWhileRevalidateMs: 60_000,
      maxSnapshots: 8,
    },
    bitable: {
      async fetchRecords() {
        calls.push('records');
        return [structuredClone(storedRecord)];
      },
      async fetchRecord(_token, _appToken, _tableId, recordId) {
        calls.push(`record:${recordId}`);
        return structuredClone(storedRecord);
      },
      async createRecord() {
        return { record_id: 'rec-2', fields: { title: 'created' } };
      },
      async updateRecord(_token, _appToken, _tableId, recordId, fields) {
        Object.assign(storedRecord.fields, fields);
        return { record_id: recordId, fields };
      },
      async deleteRecord() {
        return {};
      },
    },
  });
  const table = { appToken: 'app', tableId: 'table', viewId: '', fieldNames: {} };

  const [first, second] = await Promise.all([
    gateway.readRecords('token', table),
    gateway.readRecords('token', table),
  ]);
  assert.equal(calls.filter((item) => item === 'records').length, 1);
  assert.strictEqual(first, second);
  assert.equal((await gateway.readRecord('token', 'app', 'table', 'rec-1')).fields.title, 'first');
  assert.equal(calls.some((item) => item.startsWith('record:')), true);

  await gateway.updateRecord('token', 'app', 'table', 'rec-1', { status: '处理中' });
  const updated = await gateway.readRecord('token', 'app', 'table', 'rec-1');
  assert.equal(updated.fields.title, 'first');
  assert.equal(updated.fields.assignees[0].open_id, 'ou-handler');
  assert.equal(updated.fields.status, '处理中');
  assert.ok(calls.filter((item) => item === 'records').length >= 1);
  await gateway.deleteRecord('token', 'app', 'table', 'rec-1');
  storedRecord.fields.status = '已删除后重建';
  assert.equal((await gateway.readRecord('token', 'app', 'table', 'rec-1')).fields.status, '已删除后重建');
  assert.ok(calls.includes('record:rec-1'));
});

test('Feishu Bitable event normalization expands every action and preserves deletes', () => {
  const events = normalizeBitableRecordEvents({
    event_id: 'evt-1',
    file_token: 'app-token',
    table_id: 'tbl-1',
    action_list: [
      { record_id: 'rec-1', action: 'add' },
      { record_id: 'rec-2', action: 'delete' },
    ],
  });

  assert.deepEqual(events, [
    {
      eventId: 'evt-1:rec-1:0',
      appToken: 'app-token',
      tableId: 'tbl-1',
      recordId: 'rec-1',
      changeType: 'updated',
    },
    {
      eventId: 'evt-1:rec-2:1',
      appToken: 'app-token',
      tableId: 'tbl-1',
      recordId: 'rec-2',
      changeType: 'deleted',
    },
  ]);
});

test('Feishu Bitable event service refreshes records and publishes compatible SSE deletes', async () => {
  const refreshed = [];
  const removed = [];
  const published = [];
  const context = {
    appToken: 'app-token',
    tableId: 'tbl-1',
    projectId: 'P1',
    toolId: 'requirements',
  };
  const tableDataService = {
    registerTableContext: (value) => value,
    getTableContexts: () => [context],
    async refreshRecord(_token, appToken, tableId, recordId) {
      refreshed.push(`${appToken}:${tableId}:${recordId}`);
    },
    removeCachedRecord(appToken, tableId, recordId) {
      removed.push(`${appToken}:${tableId}:${recordId}`);
    },
    invalidateTable() {},
  };
  const service = createFeishuBitableEventService({
    eventDebounceMs: 1,
    getTenantToken: async () => 'tenant-token',
    tableDataService,
    publishWorkItemUpdated: (event) => published.push(event),
  });
  service.registerTableContext(context);

  await service.handleEvent({
    event_id: 'evt-2',
    file_token: 'app-token',
    table_id: 'tbl-1',
    action_list: [
      { record_id: 'rec-1', action: 'update' },
      { record_id: 'rec-2', action: 'delete' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(refreshed, ['app-token:tbl-1:rec-1']);
  assert.deepEqual(removed, ['app-token:tbl-1:rec-2']);
  assert.deepEqual(
    published.map((event) => `${event.recordId}:${event.changeType}`).sort(),
    ['rec-1:updated', 'rec-2:deleted'],
  );
});

test('Feishu Bitable event service reconciles changed and deleted records after reconnect', async () => {
  let statusHandler = null;
  const published = [];
  const context = {
    appToken: 'app-token',
    tableId: 'tbl-1',
    projectId: 'P1',
    toolId: 'requirements',
  };
  const service = createFeishuBitableEventService({
    getTenantToken: async () => 'tenant-token',
    longConnection: {
      setEventHandler() {},
      setStatusHandler(handler) {
        statusHandler = handler;
      },
    },
    tableDataService: {
      async refreshHotTables(token) {
        assert.equal(token, 'tenant-token');
        return [{
          context,
          changes: [
            { recordId: 'rec-1', changeType: 'updated' },
            { recordId: 'rec-2', changeType: 'deleted' },
          ],
        }];
      },
    },
    publishWorkItemUpdated: (event) => published.push(event),
  });

  assert.equal(typeof statusHandler, 'function');
  statusHandler('connected');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(
    published.map((event) => `${event.recordId}:${event.changeType}`).sort(),
    ['rec-1:updated', 'rec-2:deleted'],
  );
  assert.equal(service.getHealth().connectionStatus, 'connected');
});

test('portable backend process matching requires the expected Node executable and entry file', () => {
  assert.equal(matchesBackendProcess({
    executablePath: 'D:\\Publish\\runtime\\node.exe',
    commandLine: '"D:\\Publish\\runtime\\node.exe" D:\\Publish\\server\\index.js',
  }, {
    nodeExecutable: 'D:\\Publish\\runtime\\node.exe',
    serverEntry: 'D:\\Publish\\server\\index.js',
  }), true);
  assert.equal(matchesBackendProcess({
    executablePath: 'D:\\Publish\\runtime\\node.exe',
    commandLine: '"D:\\Publish\\runtime\\node.exe" D:\\Other\\server\\index.js',
  }, {
    nodeExecutable: 'D:\\Publish\\runtime\\node.exe',
    serverEntry: 'D:\\Publish\\server\\index.js',
  }), false);
});
