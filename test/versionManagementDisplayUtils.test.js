import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActiveVersionMatrix,
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
