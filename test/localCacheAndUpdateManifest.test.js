import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_CACHE_RETENTION_MS,
  createDraftKey,
  createLocalCacheUserKey,
  createProjectOverviewSnapshotKey,
  createProjectsSnapshotKey,
  createVersionManagementSnapshotKey,
  createWorkItemsSnapshotKey,
  isLocalCacheEntryExpired,
  serializeDraftValue,
} from '../src/ui/localCache.js';
import {
  buildUpdateResponse,
  compareSemanticVersions,
  getReleasesNewerThan,
  normalizeUpdateManifest,
} from '../shared/updateManifest.js';
import {
  countWaitingAssignedWorkItems,
  replaceWorkItemByRecordId,
} from '../shared/workItemRealtimeUtils.js';

test('local cache keys isolate users, projects, and tools', () => {
  const alice = createLocalCacheUserKey({ openId: 'ou_alice' });
  const bob = createLocalCacheUserKey({ unionId: 'on_bob' });

  assert.notEqual(alice, bob);
  assert.notEqual(createProjectsSnapshotKey(alice), createProjectsSnapshotKey(bob));
  assert.notEqual(
    createWorkItemsSnapshotKey(alice, 'project-a', 'requirements'),
    createWorkItemsSnapshotKey(alice, 'project-a', 'bugs'),
  );
  assert.notEqual(
    createDraftKey(alice, 'edit', 'project-a', 'requirements', 'record-a'),
    createDraftKey(alice, 'edit', 'project-a', 'requirements', 'record-b'),
  );
  assert.notEqual(
    createProjectOverviewSnapshotKey(alice, 'project-a', 'project', 30),
    createProjectOverviewSnapshotKey(alice, 'project-a', 'mine', 30),
  );
  assert.notEqual(
    createVersionManagementSnapshotKey(alice, 'project-a'),
    createVersionManagementSnapshotKey(alice, 'project-b'),
  );
  assert.notEqual(
    createVersionManagementSnapshotKey(alice, 'project-a'),
    createVersionManagementSnapshotKey(bob, 'project-a'),
  );
});

test('local cache expires entries after seven days', () => {
  const now = Date.now();

  assert.equal(isLocalCacheEntryExpired(now - LOCAL_CACHE_RETENTION_MS + 1, now), false);
  assert.equal(isLocalCacheEntryExpired(now - LOCAL_CACHE_RETENTION_MS - 1, now), true);
  assert.equal(isLocalCacheEntryExpired('invalid', now), true);
});

test('draft serialization retains form values and excludes attachments', () => {
  const fileLike = {
    name: 'screenshot.png',
    size: 123,
    type: 'image/png',
    arrayBuffer() {},
  };
  const draft = serializeDraftValue({
    title: '缓存草稿',
    attachments: [fileLike],
    fieldValues: {
      描述: '保留描述',
      附件: [{ file_token: 'file-token', name: 'screenshot.png' }],
      其他文件字段: {
        existing: [{ fileToken: 'remote-file' }],
        newFiles: [fileLike],
      },
    },
  });

  assert.deepEqual(draft, {
    title: '缓存草稿',
    fieldValues: {
      描述: '保留描述',
    },
  });
});

test('overview cache retains attachment risk counts without retaining attachment data', () => {
  const overview = serializeDraftValue({
    summary: { active: 3, missingAttachments: 2 },
    submittedAttachments: [{ file_token: 'file-token', name: 'evidence.zip' }],
  });

  assert.deepEqual(overview, {
    summary: { active: 3, missingAttachments: 2 },
  });
});

test('update manifest validates, sorts, and filters newer releases', () => {
  const manifest = normalizeUpdateManifest({
    schemaVersion: 1,
    latestVersion: '0.1.63',
    releases: [
      {
        version: '0.1.62',
        publishedAt: '2026-07-15T08:00:00Z',
        changes: ['旧版本'],
      },
      {
        version: '0.1.63',
        publishedAt: '2026-07-16T08:00:00Z',
        changes: ['新增本地缓存'],
      },
    ],
  });

  assert.ok(manifest);
  assert.deepEqual(getReleasesNewerThan(manifest, '0.1.62').map((release) => release.version), ['0.1.63']);
  assert.deepEqual(buildUpdateResponse(manifest, '0.1.62', '0.1.62'), {
    enabled: true,
    currentVersion: '0.1.62',
    latestVersion: '0.1.63',
    updateAvailable: true,
    releases: [{
      version: '0.1.63',
      publishedAt: '2026-07-16T08:00:00Z',
      changes: ['新增本地缓存'],
    }],
  });
});

test('semantic version comparison follows prerelease ordering and rejects invalid manifests', () => {
  assert.ok(compareSemanticVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.ok(compareSemanticVersions('1.0.0-rc.2', '1.0.0-rc.1') > 0);
  assert.equal(normalizeUpdateManifest({
    schemaVersion: 1,
    latestVersion: 'bad-version',
    releases: [],
  }), null);
});

test('realtime item replacement uses recordId and retains unrelated items', () => {
  const original = [
    { recordId: 'rec-a', itemId: 'R-0001', title: '旧标题', requirementStatus: '待处理' },
    { recordId: 'rec-b', itemId: 'R-0002', title: '保持不变', requirementStatus: '处理中' },
  ];
  const updated = {
    recordId: 'rec-a',
    itemId: 'R-0001',
    title: '新标题',
    requirementStatus: '已完成',
  };

  assert.deepEqual(replaceWorkItemByRecordId(original, updated), [updated, original[1]]);
  assert.deepEqual(replaceWorkItemByRecordId(original, { ...updated, recordId: 'missing' }), original);
});

test('related project counts only include the current assignee waiting for each tool', () => {
  const user = { openId: 'ou-current', name: '当前用户' };
  const items = [
    { itemStatus: '待处理', assignees: [{ openId: 'ou-current' }] },
    { itemStatus: '处理中', assignees: [{ openId: 'ou-current' }] },
    { itemStatus: '待处理', assignees: [{ openId: 'ou-other' }], proposers: [{ openId: 'ou-current' }] },
    { itemStatus: '未处理', assignees: [{ openId: 'ou-current' }] },
    { itemStatus: '修复中', assignees: [{ openId: 'ou-current' }] },
  ];

  assert.equal(countWaitingAssignedWorkItems('requirements', items, user), 1);
  assert.equal(countWaitingAssignedWorkItems('bugs', items, user), 1);
});
