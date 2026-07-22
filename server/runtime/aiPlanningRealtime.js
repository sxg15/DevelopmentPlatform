import crypto from 'node:crypto';

const HEARTBEAT_INTERVAL_MS = 20_000;

export function createAiPlanningRealtimeHub() {
  const subscribers = new Map();

  function subscribe(response, { conversationId, ownerOpenId, snapshot }) {
    const subscriberId = crypto.randomUUID();
    writeEvent(response, 'snapshot', snapshot);
    const heartbeat = setInterval(() => {
      response.write(': keepalive\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    subscribers.set(subscriberId, {
      response,
      conversationId,
      ownerOpenId,
      heartbeat,
    });
    return () => removeSubscriber(subscriberId);
  }

  function publish(conversationId, ownerOpenId, eventName, payload) {
    for (const [subscriberId, subscriber] of subscribers.entries()) {
      if (
        subscriber.conversationId !== conversationId
        || subscriber.ownerOpenId !== ownerOpenId
      ) {
        continue;
      }
      try {
        writeEvent(subscriber.response, eventName, payload);
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
    publish,
    subscribe,
  };
}

function writeEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}
