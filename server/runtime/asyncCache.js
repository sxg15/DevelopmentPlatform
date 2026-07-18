export async function getCachedValue(cache, key, ttlMs, loader) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.value;
  }

  const pendingValue = Promise.resolve().then(loader);
  cache.set(key, {
    value: pendingValue,
    expiresAt: now + ttlMs,
  });

  try {
    const value = await pendingValue;
    cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    return value;
  } catch (error) {
    if (cache.get(key)?.value === pendingValue) {
      cache.delete(key);
    }
    throw error;
  }
}
