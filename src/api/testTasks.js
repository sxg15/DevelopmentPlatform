import { requestJson } from './client.js';

function basePath(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/test-tasks`;
}

export function ensureProjectTestTasks(projectId) {
  return requestJson(`${basePath(projectId)}/ensure`, { method: 'POST' });
}

export function fetchTestTask(projectId, recordId) {
  return requestJson(`${basePath(projectId)}/${encodeURIComponent(recordId)}`);
}

export function createTestTask(projectId, payload) {
  return requestJson(basePath(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateTestTask(projectId, recordId, payload) {
  return requestJson(`${basePath(projectId)}/${encodeURIComponent(recordId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function startTestTask(projectId, recordId, payload) {
  return requestJson(`${basePath(projectId)}/${encodeURIComponent(recordId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateTestTaskTesters(projectId, recordId, payload) {
  return requestJson(`${basePath(projectId)}/${encodeURIComponent(recordId)}/testers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function saveTestTaskResults(projectId, recordId, payload) {
  const formData = new FormData();
  formData.set('results', JSON.stringify(payload.results || []));
  formData.set('expectedRevision', String(payload.expectedRevision || 1));
  formData.set('clientMutationId', payload.clientMutationId || '');
  for (const item of payload.results || []) {
    for (const file of item.feedbackDraft?.newFiles || []) {
      formData.append(`feedbackAttachment:${item.itemId}`, file);
    }
  }
  return requestJson(`${basePath(projectId)}/${encodeURIComponent(recordId)}/results`, {
    method: 'PUT',
    body: formData,
  });
}

export function completeTestTask(projectId, recordId, payload) {
  return requestJson(`${basePath(projectId)}/${encodeURIComponent(recordId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function deleteTestTask(projectId, recordId) {
  return requestJson(`${basePath(projectId)}/${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
  });
}

export function createTestTaskMutationId() {
  return `test-task-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
