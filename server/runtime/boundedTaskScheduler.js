export function createBoundedTaskScheduler({
  maxConcurrent = 3,
  maxPerUser = 1,
  maxPerProject = 2,
} = {}) {
  const pending = [];
  const userCounts = new Map();
  const projectCounts = new Map();
  let activeCount = 0;

  function schedule({ userKey, projectKey, task }) {
    if (!userKey || !projectKey || typeof task !== 'function') {
      return Promise.reject(new Error('任务调度参数不完整'));
    }

    return new Promise((resolve, reject) => {
      pending.push({ userKey, projectKey, task, resolve, reject });
      drain();
    });
  }

  function drain() {
    let started = true;
    while (started && activeCount < maxConcurrent) {
      started = false;
      const index = pending.findIndex(canStart);
      if (index < 0) {
        return;
      }

      const [entry] = pending.splice(index, 1);
      started = true;
      activeCount += 1;
      increment(userCounts, entry.userKey);
      increment(projectCounts, entry.projectKey);

      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          activeCount -= 1;
          decrement(userCounts, entry.userKey);
          decrement(projectCounts, entry.projectKey);
          drain();
        });
    }
  }

  function canStart(entry) {
    return (userCounts.get(entry.userKey) || 0) < maxPerUser
      && (projectCounts.get(entry.projectKey) || 0) < maxPerProject;
  }

  return {
    schedule,
    stats() {
      return {
        active: activeCount,
        pending: pending.length,
      };
    },
  };
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function decrement(map, key) {
  const next = (map.get(key) || 1) - 1;
  if (next <= 0) {
    map.delete(key);
  } else {
    map.set(key, next);
  }
}
