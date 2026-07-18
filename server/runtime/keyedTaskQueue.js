export function createKeyedTaskQueue() {
  const tails = new Map();

  return {
    run(key, task) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) {
        return Promise.reject(new Error('缺少任务队列键'));
      }
      if (typeof task !== 'function') {
        return Promise.reject(new Error('缺少任务函数'));
      }

      const previous = tails.get(normalizedKey) || Promise.resolve();
      const current = previous
        .catch(() => {})
        .then(task);
      tails.set(normalizedKey, current);

      return current.finally(() => {
        if (tails.get(normalizedKey) === current) {
          tails.delete(normalizedKey);
        }
      });
    },
    size() {
      return tails.size;
    },
  };
}
