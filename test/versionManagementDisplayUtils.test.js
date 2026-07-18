import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActiveVersionMatrix,
  filterVersionAssociationCandidates,
  filterVersions,
  mergeVersionPayload,
  normalizeVersionManagementPayload,
} from '../src/ui/versions/versionManagementDisplayUtils.js';

test('version display payload tolerates malformed cached values', () => {
  const payload = normalizeVersionManagementPayload({
    versions: [
      {
        recordId: 'ver-1',
        versionNumber: '1.0.0',
        platform: 'IGP',
        status: '正式发布',
        requirements: 'invalid',
        comments: [{ id: 'c1', content: { text: 'invalid' } }],
      },
      null,
    ],
    completedWorkItems: {
      requirements: [{ recordId: 'req-1', title: '需求一' }],
      bugs: 'invalid',
    },
    warnings: [{ text: 'invalid' }],
  });

  assert.equal(payload.versions.length, 1);
  assert.deepEqual(payload.versions[0].requirements, []);
  assert.deepEqual(payload.versions[0].comments, []);
  assert.equal(payload.completedWorkItems.requirements[0].recordId, 'req-1');
  assert.deepEqual(payload.warnings, []);
});

test('version filters and active matrix use platform and status slots', () => {
  const versions = [
    createVersion('ver-1', '1.0.0', 'IGP', '正式发布'),
    createVersion('ver-2', '2.0.0', 'Steam', '测试开发'),
  ];

  assert.deepEqual(
    filterVersions(versions, { search: 'steam', platform: 'all', status: 'all' })
      .map((item) => item.recordId),
    ['ver-2'],
  );
  const matrix = buildActiveVersionMatrix(versions, ['IGP', 'Steam'], ['测试开发', '正式发布']);
  assert.equal(matrix[0].slots['正式发布'].recordId, 'ver-1');
  assert.equal(matrix[1].slots['测试开发'].recordId, 'ver-2');
});

test('single-version mutation payload replaces the matching detail record', () => {
  const current = normalizeVersionManagementPayload({
    versions: [createVersion('ver-1', '1.0.0', 'IGP', '测试开发')],
  });
  const next = mergeVersionPayload(current, {
    version: createVersion('ver-1', '1.0.0', 'IGP', '正式发布'),
  });

  assert.equal(next.versions.length, 1);
  assert.equal(next.versions[0].status, '正式发布');
});

test('version association candidates can be searched by business id, title, or status', () => {
  const candidates = [
    { recordId: 'req-1', itemId: 'REQ-100', title: '登录流程改造', status: '已完成' },
    { recordId: 'req-2', itemId: 'REQ-200', title: '版本列表优化', status: '已关闭' },
  ];

  assert.deepEqual(
    filterVersionAssociationCandidates(candidates, '100').map((item) => item.recordId),
    ['req-1'],
  );
  assert.deepEqual(
    filterVersionAssociationCandidates(candidates, '列表').map((item) => item.recordId),
    ['req-2'],
  );
  assert.equal(filterVersionAssociationCandidates(candidates, '已完成').length, 1);
  assert.deepEqual(filterVersionAssociationCandidates(candidates, ''), candidates);
  assert.deepEqual(filterVersionAssociationCandidates('invalid', '需求'), []);
});

function createVersion(recordId, versionNumber, platform, status) {
  return {
    recordId,
    versionNumber,
    platform,
    status,
    requirements: [],
    bugs: [],
    feedback: [],
    statusHistory: [],
    comments: [],
  };
}
