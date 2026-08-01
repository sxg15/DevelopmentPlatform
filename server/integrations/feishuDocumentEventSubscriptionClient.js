import { readJson } from './feishuClient.js';

const BITABLE_RECORD_CHANGED_EVENT = 'drive.file.bitable_record_changed_v1';

export function createFeishuDocumentEventSubscriptionClient({
  enabled = true,
  getTenantToken,
  retryDelayMs = 5 * 60 * 1000,
  maxSubscriptions = 256,
  onError = () => {},
} = {}) {
  const subscriptions = new Map();

  async function ensureBitableRecordEvents(appToken) {
    const fileToken = String(appToken || '').trim();
    if (!enabled || !fileToken || typeof getTenantToken !== 'function') {
      return false;
    }
    const existing = subscriptions.get(fileToken);
    if (existing?.status === 'subscribed') {
      existing.lastUsedAt = Date.now();
      return true;
    }
    if (existing?.status === 'pending') {
      return existing.promise;
    }
    if (existing?.retryAfter > Date.now()) {
      return false;
    }

    const pending = Promise.resolve()
      .then(async () => {
        const token = await getTenantToken();
        const query = new URLSearchParams({
          file_type: 'bitable',
          event_type: BITABLE_RECORD_CHANGED_EVENT,
        });
        const response = await fetch(
          `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/subscribe?${query}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        const payload = await readJson(response);
        const message = String(payload?.msg || '');
        if ((!response.ok || payload?.code !== 0) && !isAlreadySubscribed(message)) {
          throw new Error(message || `HTTP ${response.status}`);
        }
        subscriptions.set(fileToken, {
          status: 'subscribed',
          retryAfter: 0,
          lastUsedAt: Date.now(),
        });
        return true;
      })
      .catch((error) => {
        subscriptions.set(fileToken, {
          status: 'failed',
          retryAfter: Date.now() + retryDelayMs,
          lastUsedAt: Date.now(),
        });
        onError(error);
        return false;
      });

    subscriptions.set(fileToken, {
      status: 'pending',
      promise: pending,
      retryAfter: 0,
      lastUsedAt: Date.now(),
    });
    trimSubscriptions();
    return pending;
  }

  function getHealth() {
    const values = [...subscriptions.values()];
    return {
      subscribedDocuments: values.filter((item) => item.status === 'subscribed').length,
      failedDocuments: values.filter((item) => item.status === 'failed').length,
    };
  }

  return {
    ensureBitableRecordEvents,
    getHealth,
  };

  function trimSubscriptions() {
    const maximum = Number.isInteger(Number(maxSubscriptions)) && Number(maxSubscriptions) > 0
      ? Number(maxSubscriptions)
      : 256;
    while (subscriptions.size > maximum) {
      const candidate = [...subscriptions.entries()]
        .filter(([, item]) => item.status !== 'pending')
        .sort((left, right) => Number(left[1].lastUsedAt || 0) - Number(right[1].lastUsedAt || 0))[0];
      if (!candidate) {
        return;
      }
      subscriptions.delete(candidate[0]);
    }
  }
}

function isAlreadySubscribed(message) {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('already') || normalized.includes('重复') || normalized.includes('已订阅');
}
