import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequirementSubmissionAttachmentChangeText,
  isRequirementSubmissionAttachmentRequired,
  shouldConfirmStatusUpdateWithoutSubmissionAttachments,
} from '../shared/requirementSubmissionAttachmentUtils.js';

test('requirement submission attachment option recognizes the yes selection', () => {
  assert.equal(isRequirementSubmissionAttachmentRequired('是'), true);
  assert.equal(isRequirementSubmissionAttachmentRequired({ name: '是' }), true);
  assert.equal(isRequirementSubmissionAttachmentRequired(['否']), false);
  assert.equal(isRequirementSubmissionAttachmentRequired(false), false);
});

test('attachment change text lists added and removed files', () => {
  assert.equal(buildRequirementSubmissionAttachmentChangeText({
    added: [{ name: '验收截图.png' }, { fileName: '说明.pdf' }],
    removed: [{ name: '旧版本.zip' }],
  }), '提交附件变动：新增：验收截图.png、说明.pdf；删除：旧版本.zip');
});

test('status update confirmation only applies to requirements that require an attachment', () => {
  assert.equal(shouldConfirmStatusUpdateWithoutSubmissionAttachments({
    toolId: 'requirements',
    requiresSubmissionAttachment: true,
    submittedAttachments: [],
  }), true);
  assert.equal(shouldConfirmStatusUpdateWithoutSubmissionAttachments({
    toolId: 'requirements',
    requiresSubmissionAttachment: true,
    submittedAttachments: [{ fileToken: 'file-a' }],
  }), false);
  assert.equal(shouldConfirmStatusUpdateWithoutSubmissionAttachments({
    toolId: 'bugs',
    requiresSubmissionAttachment: true,
    submittedAttachments: [],
  }), false);
});
