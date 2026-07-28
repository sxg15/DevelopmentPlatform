const RETRY_DELAYS_MS = Object.freeze([
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
]);

export function createAiPlanningNotificationService({
  enabled = true,
  repository,
  deliver,
  pollIntervalMs = 30_000,
}) {
  let processing = false;
  let timer = null;

  function enqueue(eventType, event) {
    if (!enabled) {
      return null;
    }
    const payload = normalizeNotificationPayload(event);
    const queued = repository.enqueueNotification({
      eventKey: String(event?.eventKey || '').trim(),
      ownerOpenId: String(event?.ownerOpenId || '').trim(),
      eventType,
      payload,
    });
    void processPending();
    return queued;
  }

  async function processPending() {
    if (!enabled || processing) {
      return;
    }
    processing = true;
    try {
      const pending = repository.listPendingNotifications(20);
      for (const notification of pending) {
        try {
          await deliver(notification);
          repository.markNotificationSent(notification.id);
        } catch (error) {
          const message = sanitizeDeliveryError(error);
          if (notification.attempts >= RETRY_DELAYS_MS.length - 1) {
            repository.markNotificationAbandoned(notification.id, message);
            continue;
          }
          repository.markNotificationFailed(
            notification.id,
            message,
            new Date(Date.now() + RETRY_DELAYS_MS[notification.attempts]).toISOString(),
          );
        }
      }
    } finally {
      processing = false;
    }
  }

  if (enabled) {
    timer = setInterval(() => {
      void processPending();
    }, Math.max(5_000, Number(pollIntervalMs) || 30_000));
    timer.unref?.();
    queueMicrotask(() => {
      void processPending();
    });
  }

  return {
    enqueue,
    processPending,
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function normalizeNotificationPayload(event) {
  const conversation = event?.conversation || {};
  const workItem = event?.workItem || {};
  const project = event?.project || {};
  return {
    conversationId: String(conversation.id || '').slice(0, 100),
    projectId: String(conversation.projectId || project.projectId || '').slice(0, 200),
    projectName: String(project.projectName || '').slice(0, 300),
    toolId: String(conversation.toolId || '').slice(0, 50),
    recordId: String(conversation.recordId || workItem.recordId || '').slice(0, 200),
    conversationTitle: String(conversation.title || '').slice(0, 200),
    workItemId: String(workItem.itemId || '').slice(0, 200),
    workItemTitle: String(workItem.title || '').slice(0, 500),
    focus: String(event?.focus || '').slice(0, 50),
    questionCount: Math.max(0, Math.min(3, Number(event?.questionCount || 0))),
    errorMessage: String(event?.errorMessage || '').slice(0, 500),
  };
}

function sanitizeDeliveryError(error) {
  return String(error?.message || '发送飞书通知失败')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .trim()
    .slice(0, 500);
}
