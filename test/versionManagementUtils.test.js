import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAssociationSnapshots,
  buildVersionOverview,
  canManageVersions,
  findActiveVersionConflict,
  normalizeVersionRecord,
  validatePreviousVersionReference,
  validateVersionIdentity,
} from '../shared/versionManagementUtils.js';

test('version records normalize JSON documents and report malformed history', () => {
  const version = normalizeVersionRecord({
    record_id: 'ver-1',
    fields: {
      版本号: '1.2.0',
      状态: '测试开发',
      平台: 'IGP',
      已处理需求: JSON.stringify({
        version: 1,
        items: [{ recordId: 'req-1', itemId: 'R-0001', title: '需求一' }],
      }),
      状态变动记录: '{bad json',
    },
  });

  assert.equal(version.versionNumber, '1.2.0');
  assert.equal(version.requirements[0].recordId, 'req-1');
  assert.equal(version.statusHistory.length, 0);
  assert.match(version.parseErrors.statusHistory, /不是合法 JSON/);
  assert.equal(version.warnings.length, 1);
});

test('global and development super admins can manage versions', () => {
  assert.equal(canManageVersions({ isSuperAdmin: true }), true);
  assert.equal(canManageVersions({ isDevelopmentSuperAdmin: true }), true);
  assert.equal(canManageVersions({}), false);
});

test('active version slots are unique per platform and status', () => {
  const versions = [
    createVersion('ver-1', '1.0.0', 'IGP', '测试开发'),
    createVersion('ver-2', '1.1.0', 'Steam', '测试开发'),
  ];

  assert.equal(findActiveVersionConflict(versions, {
    platform: 'IGP',
    status: '测试开发',
  })?.recordId, 'ver-1');
  assert.equal(findActiveVersionConflict(versions, {
    platform: 'Steam',
    status: '正式发布',
  }), null);
  assert.throws(() => validateVersionIdentity({
    versions,
    versionNumber: '1.0.0',
    platform: 'IGP',
  }), /不能重复/);
});

test('previous version references may cross platforms but cannot form cycles', () => {
  const versions = [
    createVersion('ver-1', '1.0.0', 'IGP', '过时', { recordId: 'ver-2' }),
    createVersion('ver-2', '2.0.0', 'Steam', '过时'),
  ];

  assert.deepEqual(validatePreviousVersionReference(versions, {
    recordId: 'ver-2',
    previousRecordId: '',
  }), null);
  assert.throws(() => validatePreviousVersionReference(versions, {
    recordId: 'ver-2',
    previousRecordId: 'ver-1',
  }), /循环/);
  assert.throws(() => validatePreviousVersionReference(versions, {
    recordId: 'ver-1',
    previousRecordId: 'ver-1',
  }), /当前版本/);
});

test('new work item associations require current completed candidates', () => {
  const candidates = [
    { recordId: 'req-1', itemId: 'R-0001', title: '完成需求', completed: true },
    { recordId: 'req-2', itemId: 'R-0002', title: '未完成需求', completed: false },
  ];

  assert.deepEqual(buildAssociationSnapshots(['req-1'], candidates), [{
    recordId: 'req-1',
    itemId: 'R-0001',
    title: '完成需求',
  }]);
  assert.throws(() => buildAssociationSnapshots(['req-2'], candidates), /已完成或已关闭/);
});

test('overview derives active slots and prior formal releases from history', () => {
  const versions = [
    {
      ...createVersion('ver-1', '1.0.0', 'IGP', '过时'),
      statusHistory: [
        {
          id: 'history-1',
          newStatus: '正式发布',
          changedAt: '2026-07-01T00:00:00.000Z',
          operatorName: '管理员',
        },
      ],
    },
    createVersion('ver-2', '1.1.0', 'IGP', '正式发布'),
  ];

  const overview = buildVersionOverview(versions);
  assert.equal(
    overview.platforms.find((item) => item.platform === 'IGP').active['正式发布'].recordId,
    'ver-2',
  );
  assert.equal(overview.recentFormalReleases[0].recordId, 'ver-1');
});

function createVersion(recordId, versionNumber, platform, status, previousVersion = null) {
  return {
    recordId,
    versionNumber,
    platform,
    status,
    previousVersion,
    statusHistory: [],
    comments: [],
    requirements: [],
    bugs: [],
    feedback: [],
  };
}
