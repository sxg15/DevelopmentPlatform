import crypto from 'node:crypto';

const HEARTBEAT_INTERVAL_MS = 20_000;

export function createWorkItemRealtimeHub({ onPublish = () => {} } = {}) {
  const subscribers = new Map();

  function subscribe(response, allowedToolsByProject) {
    const subscriberId = crypto.randomUUID();
    writeRealtimeEvent(response, 'ready', { connectedAt: Date.now() });

    const heartbeat = setInterval(() => {
      response.write(': keepalive\n\n');
    }, HEARTBEAT_INTERVAL_MS);
    subscribers.set(subscriberId, { response, allowedToolsByProject, heartbeat });

    return () => {
      removeSubscriber(subscriberId);
    };
  }

  function publishWorkItemUpdated(event) {
    const payload = {
      projectId: String(event?.projectId || '').trim(),
      toolId: String(event?.toolId || '').trim(),
      recordId: String(event?.recordId || '').trim(),
      occurredAt: Date.now(),
    };

    if (!payload.projectId || !payload.toolId || !payload.recordId) {
      return;
    }

    onPublish(payload);

    for (const [subscriberId, subscriber] of subscribers.entries()) {
      const allowedToolIds = subscriber.allowedToolsByProject.get(payload.projectId);
      if (!allowedToolIds?.has(payload.toolId)) {
        continue;
      }

      try {
        writeRealtimeEvent(subscriber.response, 'work-item-updated', payload);
      } catch {
        removeSubscriber(subscriberId);
      }
    }
  }

  function removeSubscriber(subscriberId) {
    const subscriber = subscribers.get(subscriberId);
    if (subscriber?.heartbeat) {
      clearInterval(subscriber.heartbeat);
    }
    subscribers.delete(subscriberId);
  }

  return {
    publishWorkItemUpdated,
    subscribe,
  };
}

export function writeRealtimeEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}
