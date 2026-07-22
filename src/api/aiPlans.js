import { requestJson } from './client.js';

export function listAiPlans(projectId, filters = {}) {
  const query = new URLSearchParams();
  if (filters.toolId) {
    query.set('toolId', filters.toolId);
  }
  if (filters.status) {
    query.set('status', filters.status);
  }
  if (filters.search) {
    query.set('search', filters.search);
  }
  const suffix = query.size > 0 ? `?${query}` : '';
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/ai-plans${suffix}`);
}

export function fetchAiPlan(projectId, submissionId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}`,
  );
}

export function adoptAiPlan(projectId, submissionId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/adopt`,
    { method: 'POST' },
  );
}

export function withdrawAiPlan(projectId, submissionId) {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/withdraw`,
    { method: 'POST' },
  );
}

export function getAiPlanRawUrl(projectId, submissionId) {
  return `/api/projects/${encodeURIComponent(projectId)}/ai-plans/${encodeURIComponent(submissionId)}/raw`;
}
