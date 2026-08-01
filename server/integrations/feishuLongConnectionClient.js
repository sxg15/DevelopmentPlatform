export function createFeishuLongConnectionClient({
  appId,
  appSecret,
  onEvent = () => {},
  eventHandlers = {},
  onStatus = () => {},
  onError = () => {},
} = {}) {
  let eventHandler = onEvent;
  let handlers = normalizeEventHandlers(eventHandlers, eventHandler);
  let client = null;
  let status = canConnect(appId, appSecret) ? 'idle' : 'disabled';
  let starting = null;
  let lastErrorCode = '';
  let statusHandler = () => {};

  async function start() {
    if (!canConnect(appId, appSecret)) {
      status = 'disabled';
      notifyStatus();
      return getHealth();
    }
    if (client) {
      return getHealth();
    }
    if (starting) {
      return starting;
    }

    status = 'connecting';
    notifyStatus();
    starting = Promise.resolve()
      .then(async () => {
        const sdkModule = await import('@larksuiteoapi/node-sdk');
        const lark = sdkModule.default || sdkModule;
        const dispatcher = new lark.EventDispatcher({});
        dispatcher.register(buildDispatcherHandlers(handlers, onError));
        const nextClient = new lark.WSClient({
          appId,
          appSecret,
          loggerLevel: lark.LoggerLevel.warn,
          onReady() {
            status = 'connected';
            lastErrorCode = '';
            notifyStatus();
          },
          onReconnecting() {
            status = 'connecting';
            notifyStatus();
          },
          onReconnected() {
            status = 'connected';
            lastErrorCode = '';
            notifyStatus();
          },
          onError(error) {
            status = 'degraded';
            lastErrorCode = getSafeErrorCode(error);
            notifyStatus();
            onError(error);
          },
        });
        await nextClient.start({ eventDispatcher: dispatcher });
        client = nextClient;
        status = 'connected';
        lastErrorCode = '';
        notifyStatus();
        return getHealth();
      })
      .catch((error) => {
        status = 'degraded';
        lastErrorCode = getSafeErrorCode(error);
        notifyStatus();
        onError(error);
        return getHealth();
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  }

  async function stop() {
    const activeClient = client;
    client = null;
    status = canConnect(appId, appSecret) ? 'stopped' : 'disabled';
    notifyStatus();
    if (activeClient?.close) {
      await activeClient.close();
    } else if (activeClient?.stop) {
      await activeClient.stop();
    }
  }

  function setEventHandler(nextHandler) {
    eventHandler = typeof nextHandler === 'function' ? nextHandler : () => {};
    handlers = {
      ...handlers,
      'drive.file.bitable_record_changed_v1': eventHandler,
    };
  }

  function setEventHandlers(nextHandlers) {
    handlers = normalizeEventHandlers(nextHandlers, eventHandler);
  }

  function setStatusHandler(nextHandler) {
    statusHandler = typeof nextHandler === 'function' ? nextHandler : () => {};
  }

  function notifyStatus() {
    onStatus(status);
    statusHandler(status);
  }

  function getHealth() {
    return {
      status,
      lastErrorCode,
    };
  }

  return {
    getHealth,
    setEventHandler,
    setEventHandlers,
    setStatusHandler,
    start,
    stop,
  };
}

function normalizeEventHandlers(value, fallbackBitableHandler) {
  const source = value && typeof value === 'object' ? value : {};
  const handlers = {};
  for (const [eventType, handler] of Object.entries(source)) {
    if (typeof handler === 'function') {
      handlers[eventType] = handler;
    }
  }
  if (!handlers['drive.file.bitable_record_changed_v1']) {
    handlers['drive.file.bitable_record_changed_v1'] = fallbackBitableHandler;
  }
  return handlers;
}

function buildDispatcherHandlers(handlers, onError) {
  return Object.fromEntries(
    Object.entries(handlers).map(([eventType, handler]) => [eventType, async (payload) => {
      try {
        return await handler(payload);
      } catch (error) {
        onError(error);
        return undefined;
      }
    }]),
  );
}

function canConnect(appId, appSecret) {
  return Boolean(String(appId || '').trim() && String(appSecret || '').trim());
}

function getSafeErrorCode(error) {
  const message = String(error?.code || error?.name || 'connection_failed')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 80);
  return message || 'connection_failed';
}
