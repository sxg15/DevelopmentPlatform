import { requestJson } from './client.js';

export function fetchProjects() {
  return requestJson('/api/projects');
}

export function fetchRelatedWorkItemCounts(projectId = '') {
  const normalizedProjectId = String(projectId || '').trim();
  const query = normalizedProjectId ? `?projectId=${encodeURIComponent(normalizedProjectId)}` : '';
  return requestJson(`/api/projects/related-counts${query}`);
}

export function fetchUpdates(sinceVersion) {
  const normalizedVersion = String(sinceVersion || '').trim();
  const query = normalizedVersion ? `?since=${encodeURIComponent(normalizedVersion)}` : '';
  return requestJson(`/api/updates${query}`);
}
