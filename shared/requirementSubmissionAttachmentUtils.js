export function isRequirementSubmissionAttachmentRequired(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.some(isRequirementSubmissionAttachmentRequired);
  }

  if (value && typeof value === 'object') {
    return isRequirementSubmissionAttachmentRequired(
      value.name ?? value.text ?? value.value ?? value.label,
    );
  }

  return String(value || '').trim() === '是';
}

export function getSubmissionAttachmentToken(attachment) {
  return String(
    attachment?.fileToken
    || attachment?.file_token
    || attachment?.token
    || '',
  ).trim();
}

export function buildRequirementSubmissionAttachmentChangeText({ added, removed }) {
  const addedNames = getAttachmentNames(added);
  const removedNames = getAttachmentNames(removed);
  const changes = [];

  if (addedNames.length > 0) {
    changes.push(`新增：${addedNames.join('、')}`);
  }
  if (removedNames.length > 0) {
    changes.push(`删除：${removedNames.join('、')}`);
  }

  return changes.length > 0 ? `提交附件变动：${changes.join('；')}` : '';
}

export function shouldConfirmStatusUpdateWithoutSubmissionAttachments({
  toolId,
  requiresSubmissionAttachment,
  submittedAttachments,
}) {
  return String(toolId || '').trim() === 'requirements'
    && Boolean(requiresSubmissionAttachment)
    && (!Array.isArray(submittedAttachments) || submittedAttachments.length === 0);
}

function getAttachmentNames(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((attachment) => String(
      attachment?.name
      || attachment?.fileName
      || attachment?.file_name
      || getSubmissionAttachmentToken(attachment)
      || '未命名附件',
    ).trim())
    .filter(Boolean);
}
