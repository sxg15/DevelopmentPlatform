import { requestJson } from './client.js';

export function listAiConversations(projectId, toolId, recordId) {
  return requestJson(buildWorkItemAiUrl(projectId, toolId, recordId));
}

export function createAiConversation(projectId, toolId, recordId, title, clientMutationId = '') {
  return requestJson(buildWorkItemAiUrl(projectId, toolId, recordId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, clientMutationId }),
  });
}

export function fetchAiConversation(conversationId) {
  return requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}`);
}

export function archiveAiConversation(conversationId) {
  return requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });
}

export function sendAiConversationMessage(conversationId, payload) {
  return requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function answerAiConversationQuestions(conversationId, questionSetId, payload) {
  return requestJson(
    `/api/ai/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(questionSetId)}/answers`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export function cancelAiConversationRun(conversationId) {
  return requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}/cancel`, {
    method: 'POST',
  });
}

export function submitAiPlan(conversationId, payload) {
  return requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function subscribeAiConversation(conversationId, handlers = {}) {
  const source = new EventSource(
    `/api/ai/conversations/${encodeURIComponent(conversationId)}/stream`,
  );
  const listeners = [];
  for (const eventName of [
    'snapshot',
    'assistant-delta',
    'questions-required',
    'run-completed',
    'run-failed',
  ]) {
    const listener = (event) => {
      try {
        handlers[eventName]?.(JSON.parse(event.data || '{}'));
      } catch {
        // Ignore malformed realtime events and let EventSource reconnect.
      }
    };
    source.addEventListener(eventName, listener);
    listeners.push([eventName, listener]);
  }
  source.onerror = () => handlers.error?.();
  return () => {
    for (const [eventName, listener] of listeners) {
      source.removeEventListener(eventName, listener);
    }
    source.close();
  };
}

export function createAiClientMutationId() {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function buildWorkItemAiUrl(projectId, toolId, recordId) {
  return [
    '/api/projects',
    encodeURIComponent(projectId),
    encodeURIComponent(toolId),
    encodeURIComponent(recordId),
    'ai',
    'conversations',
  ].join('/');
}
