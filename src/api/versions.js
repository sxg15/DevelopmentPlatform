import { requestJson } from './client.js';

export function ensureProjectVersions(projectId) {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/versions/ensure`, {
    method: 'POST',
  });
}

export function fetchVersionRecord(projectId, recordId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(recordId)}`,
  );
}

export function createVersionRecord(projectId, payload) {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateVersionRecord(projectId, recordId, payload) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(recordId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export function updateVersionStatus(projectId, recordId, payload) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(recordId)}/status`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export function deleteVersionRecord(projectId, recordId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(recordId)}`,
    { method: 'DELETE' },
  );
}

export function appendVersionComment(projectId, recordId, payload) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(recordId)}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export function deleteVersionComment(projectId, recordId, commentId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(recordId)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' },
  );
}
