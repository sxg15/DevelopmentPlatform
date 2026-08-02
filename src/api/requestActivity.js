const listeners = new Set();
const activeOperations = new Map();
let nextOperationId = 1;
let snapshot = createSnapshot();

export function beginGlobalOperation(message = '') {
  const operationId = nextOperationId;
  nextOperationId += 1;
  activeOperations.set(operationId, normalizeMessage(message));
  publishSnapshot();

  let completed = false;
  return () => {
    if (completed) {
      return;
    }
    completed = true;
    activeOperations.delete(operationId);
    publishSnapshot();
  };
}

export function subscribeGlobalOperation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGlobalOperationSnapshot() {
  return snapshot;
}

function publishSnapshot() {
  snapshot = createSnapshot();
  for (const listener of listeners) {
    listener();
  }
}

function createSnapshot() {
  const messages = [...activeOperations.values()];
  return Object.freeze({
    active: messages.length > 0,
    count: messages.length,
    message: messages.at(-1) || '',
  });
}

function normalizeMessage(message) {
  return String(message || '').trim() || '正在等待操作完成';
}
