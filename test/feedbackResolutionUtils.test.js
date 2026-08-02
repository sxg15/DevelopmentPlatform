import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEEDBACK_RESOLUTION_TYPES,
  createFeedbackRelatedItemDocument,
  createRelatedFeedbackDocument,
  getFeedbackResolutionStatus,
  normalizeFeedbackRelatedItemDocument,
  normalizeRelatedFeedbackDocument,
  serializeFeedbackResolutionDocument,
} from '../shared/feedbackResolutionUtils.js';
import { FEEDBACK_STATUSES } from '../shared/workItemDefinitions.js';

test('feedback association documents round-trip through Bitable text fragments', () => {
  const relatedItem = createFeedbackRelatedItemDocument({
    type: FEEDBACK_RESOLUTION_TYPES.requirements,
    recordId: 'rec-requirement',
    itemId: 'R-0001',
    title: '登录优化',
    linkedAt: 1000,
    linkedBy: { openId: 'ou-operator', name: '操作人' },
  });
  const serialized = serializeFeedbackResolutionDocument(relatedItem);
  const parsed = normalizeFeedbackRelatedItemDocument([
    { text: serialized.slice(0, 20) },
    { text: serialized.slice(20) },
  ]);

  assert.equal(parsed.error, '');
  assert.equal(parsed.type, 'requirements');
  assert.equal(parsed.recordId, 'rec-requirement');
  assert.equal(parsed.itemId, 'R-0001');
});

test('reverse feedback document preserves proposer snapshots', () => {
  const document = createRelatedFeedbackDocument({
    recordId: 'rec-feedback',
    feedbackId: 'F-0001',
    title: '页面异常',
    proposers: [{ openId: 'ou-proposer', name: '提出人' }],
    linkedAt: 2000,
    linkedBy: { openId: 'ou-operator', name: '操作人' },
  });
  const parsed = normalizeRelatedFeedbackDocument(JSON.stringify(document));

  assert.equal(parsed.error, '');
  assert.equal(parsed.feedbackId, 'F-0001');
  assert.equal(parsed.proposers[0].openId, 'ou-proposer');
});

test('association parsing surfaces malformed and unsupported documents', () => {
  assert.match(normalizeFeedbackRelatedItemDocument('{bad').error, /JSON/);
  assert.match(
    normalizeRelatedFeedbackDocument({ version: 2, recordId: 'rec' }).error,
    /不支持/,
  );
  assert.match(
    normalizeFeedbackRelatedItemDocument({
      version: 1,
      type: 'requirements',
      recordId: '',
      itemId: 'R-1',
      linkedAt: 1,
    }).error,
    /记录 ID/,
  );
});

test('resolution types map to the explicit feedback terminal statuses', () => {
  assert.equal(
    getFeedbackResolutionStatus(FEEDBACK_RESOLUTION_TYPES.requirements),
    FEEDBACK_STATUSES.convertedToRequirement,
  );
  assert.equal(
    getFeedbackResolutionStatus(FEEDBACK_RESOLUTION_TYPES.bugs),
    FEEDBACK_STATUSES.convertedToBug,
  );
  assert.equal(
    getFeedbackResolutionStatus(FEEDBACK_RESOLUTION_TYPES.reply),
    FEEDBACK_STATUSES.replied,
  );
});
