export function createTodoNotificationScheduler(options = {}) {
  const run = typeof options.run === 'function' ? options.run : async () => {};
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  let timer = null;
  let started = false;

  function scheduleNext() {
    if (!started) {
      return;
    }

    const current = now();
    timer = setTimer(async () => {
      if (!started) {
        return;
      }

      try {
        await run(now());
      } catch (error) {
        onError(error);
      } finally {
        scheduleNext();
      }
    }, getDelayToNextMinuteCheck(current));
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      scheduleNext();
    },
    stop() {
      started = false;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    isStarted() {
      return started;
    },
  };
}

export function getDelayToNextMinuteCheck(value = new Date(), checkSecond = 5) {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error('无效的调度时间');
  }

  const normalizedSecond = Math.min(59, Math.max(0, Number(checkSecond) || 0));
  const minuteStart = Math.floor(timestamp / 60_000) * 60_000;
  let target = minuteStart + normalizedSecond * 1000;
  if (target <= timestamp) {
    target += 60_000;
  }
  return target - timestamp;
}
