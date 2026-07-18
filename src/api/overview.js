import { requestJson } from './client.js';

export function fetchProjectOverview(projectId, scope, trendDays) {
  const query = new URLSearchParams({ scope, trendDays: String(trendDays) });
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/overview?${query}`);
}
