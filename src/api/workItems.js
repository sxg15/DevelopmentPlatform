import { requestJson } from './client.js';

export function ensureProjectWorkItems(projectId, toolConfig) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/ensure`,
    { method: 'POST' },
  );
}

export function fetchWorkItemRecord(projectId, toolConfig, recordId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}`,
  );
}

export function createWorkItem(toolConfig, projectId, payload) {
  const formData = new FormData();
  formData.set('title', payload.title || '');
  formData.set('description', payload.description || '');
  formData.set('priority', payload.priority || '');
  formData.set('expectedDays', payload.expectedDays === null || payload.expectedDays === undefined ? '' : String(payload.expectedDays));
  formData.set('assignees', JSON.stringify(payload.assignees || []));
  formData.set('needsAssigneeAssignment', payload.needsAssigneeAssignment ? 'true' : 'false');
  formData.set('requiresSubmissionAttachment', payload.requiresSubmissionAttachment ? 'true' : 'false');
  formData.set('contactInfo', JSON.stringify(payload.contactInfo || {}));
  for (const file of payload.attachments || []) {
    formData.append('attachments', file);
  }

  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}`,
    { method: 'POST', body: formData },
  );
}

export function updateWorkItem(toolConfig, projectId, recordId, payload) {
  const formData = new FormData();
  const selectedFields = (payload.selectedFields || []).map((field) => field.fieldName).filter(Boolean);
  const updates = {};
  const existingAttachments = {};

  for (const field of payload.selectedFields || []) {
    const fieldName = field.fieldName;
    const value = payload.fieldValues?.[fieldName];
    if (isAttachmentEditField(field, value)) {
      const attachmentValue = value || { existing: [], newFiles: [] };
      existingAttachments[fieldName] = (attachmentValue.existing || []).map(toEditableAttachmentPayload);
      for (const file of attachmentValue.newFiles || []) {
        formData.append(`attachment:${encodeURIComponent(fieldName)}`, file);
      }
    } else {
      updates[fieldName] = value;
    }
  }

  formData.set('selectedFields', JSON.stringify(selectedFields));
  formData.set('updates', JSON.stringify(updates));
  formData.set('existingAttachments', JSON.stringify(existingAttachments));
  formData.set('notifyRelated', payload.notifyRelated ? 'true' : 'false');
  formData.set('notifyUsers', JSON.stringify(payload.notifyUsers || []));

  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}`,
    { method: 'PUT', body: formData },
  );
}

export function updateRequirementSubmissionAttachments(projectId, recordId, payload) {
  const formData = new FormData();
  formData.set(
    'existingAttachments',
    JSON.stringify((payload.existingAttachments || []).map(toEditableAttachmentPayload)),
  );
  formData.set('notifyProposer', payload.notifyProposer ? 'true' : 'false');
  for (const file of payload.newFiles || []) {
    formData.append('attachments', file);
  }

  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(recordId)}/submission-attachments`,
    { method: 'POST', body: formData },
  );
}

export function deleteWorkItem(toolConfig, projectId, recordId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}`,
    { method: 'DELETE' },
  );
}

export function appendRecordComment(toolConfig, projectId, recordId, payload) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export function deleteRecordComment(toolConfig, projectId, recordId, commentId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' },
  );
}

export function updateWorkItemStatus(toolConfig, projectId, recordId, payload) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}/status`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export function createWorkItemClientMutationId() {
  return `work-item-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function resolveFeedback(projectId, recordId, payload) {
  const formData = new FormData();
  formData.set('resolutionType', payload.resolutionType || '');
  formData.set('clientMutationId', payload.clientMutationId || '');
  formData.set('title', payload.title || '');
  formData.set('description', payload.description || '');
  formData.set('priority', payload.priority || '');
  formData.set(
    'expectedDays',
    payload.expectedDays === null || payload.expectedDays === undefined
      ? ''
      : String(payload.expectedDays),
  );
  formData.set('assignees', JSON.stringify(payload.assignees || []));
  formData.set(
    'needsAssigneeAssignment',
    payload.needsAssigneeAssignment ? 'true' : 'false',
  );
  formData.set(
    'requiresSubmissionAttachment',
    payload.requiresSubmissionAttachment ? 'true' : 'false',
  );
  formData.set(
    'sourceAttachmentTokens',
    JSON.stringify(payload.sourceAttachmentTokens || []),
  );
  formData.set('replyContent', payload.replyContent || '');
  for (const file of payload.attachments || []) {
    formData.append('attachments', file);
  }

  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/feedback/${encodeURIComponent(recordId)}/resolve`,
    { method: 'POST', body: formData },
  );
}

export function changeWorkItemAssignees(toolConfig, projectId, recordId, payload) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}/assignees`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

function isAttachmentEditField(field, value) {
  const uiType = String(field?.uiType || field?.ui_type || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const type = Number(field?.type);
  return uiType.includes('attachment')
    || (Number.isFinite(type) && type === 17)
    || Boolean(value && typeof value === 'object' && (
      Array.isArray(value.existing)
      || Array.isArray(value.newFiles)
    ));
}

function toEditableAttachmentPayload(attachment) {
  return {
    fileToken: attachment?.fileToken || '',
    name: attachment?.name || '',
    size: attachment?.size || 0,
    mimeType: attachment?.mimeType || '',
  };
}
