import { requestJson } from './client.js';

export function listAiPlans(projectId, filters = {}) {
  const query = new URLSearchParams();
  if (filters.toolId) {
    query.set('toolId', filters.toolId);
  }
  if (filters.status) {
    query.set('status', filters.status);
  }
  if (filters.recordId) {
    query.set('recordId', filters.recordId);
  }
  if (filters.search) {
    query.set('search', filters.search);
  }
  const suffix = query.size > 0 ? `?${query}` : '';
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/ai-plans${suffix}`);
}

export function fetchAiProjectActivity(projectId) {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/ai-activity`);
}

export function fetchAiPlan(projectId, submissionId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}`,
  );
}

export function deleteAiPlan(projectId, submissionId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}`,
    { method: 'DELETE' },
  );
}

export function approveAiPlan(projectId, submissionId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/approve`,
    { method: 'POST' },
  );
}

export function setAiPlanApplied(projectId, submissionId, applied, clientMutationId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/applied`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applied, clientMutationId }),
    },
  );
}

export function rejectAiPlan(projectId, submissionId, reason) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/reject`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  );
}

export function createAiPlanRevision(projectId, submissionId, payload) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/revisions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export const adoptAiPlan = approveAiPlan;

export function withdrawAiPlan(projectId, submissionId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/withdraw`,
    { method: 'POST' },
  );
}

export function getAiPlanRawUrl(projectId, submissionId) {
  return `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/raw`;
}
