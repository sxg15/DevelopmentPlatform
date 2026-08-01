export function createTableSnapshotCache({
  maxSnapshots = 128,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  const stats = {
    freshHits: 0,
    staleHits: 0,
    misses: 0,
    loads: 0,
    loadFailures: 0,
  };

  async function getOrLoad(key, options, loader, { force = false } = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      return loader();
    }

    const timestamp = now();
    let entry = entries.get(normalizedKey);
    if (!entry) {
      entry = createEntry(options);
      entries.set(normalizedKey, entry);
      trim();
    }

    if (!force && entry.records) {
      touch(normalizedKey, entry);
      if (entry.freshUntil > timestamp) {
        stats.freshHits += 1;
        return entry.records;
      }
      if (entry.staleUntil > timestamp) {
        stats.staleHits += 1;
        void load(normalizedKey, entry, options, loader);
        return entry.records;
      }
    }

    stats.misses += 1;
    return load(normalizedKey, entry, options, loader, { force });
  }

  function invalidateTable(tableKey) {
    for (const [key, entry] of entries.entries()) {
      if (entry.tableKey === tableKey) {
        invalidateEntry(key, entry);
      }
    }
  }

  function getSnapshot(key) {
    const entry = entries.get(String(key || '').trim());
    if (!entry?.records) {
      return null;
    }
    return entry.records;
  }

  function getStats() {
    return {
      snapshots: entries.size,
      ...stats,
    };
  }

  function load(key, entry, options, loader, { force = false } = {}) {
    if (!force && entry.pending?.generation === entry.generation) {
      return entry.pending.promise;
    }

    if (force) {
      entry.generation += 1;
    }
    const generation = entry.generation;
    stats.loads += 1;
    const pending = {
      generation,
      promise: Promise.resolve()
        .then(loader)
        .then((records) => {
          const current = entries.get(key);
          if (current === entry && current.generation === generation) {
            applyRecords(current, records, options);
            touch(key, current);
          }
          return Array.isArray(records) ? records : [];
        })
        .catch((error) => {
          stats.loadFailures += 1;
          if (entries.get(key) === entry && entry.generation === generation && !entry.records) {
            entries.delete(key);
          }
          throw error;
        })
        .finally(() => {
          if (entries.get(key) === entry && entry.pending === pending) {
            entry.pending = null;
          }
        }),
    };

    entry.pending = pending;
    return pending.promise;
  }

  function createEntry(options) {
    return {
      tableKey: String(options?.tableKey || ''),
      viewId: String(options?.viewId || ''),
      records: null,
      freshUntil: 0,
      staleUntil: 0,
      pending: null,
      generation: 0,
      lastUsedAt: now(),
    };
  }

  function applyRecords(entry, records, options) {
    const timestamp = now();
    entry.records = Array.isArray(records) ? records : [];
    entry.freshUntil = timestamp + normalizePositiveInteger(options?.freshTtlMs, 30_000);
    entry.staleUntil = entry.freshUntil
      + normalizePositiveInteger(options?.staleWhileRevalidateMs, 300_000);
  }

  function invalidateEntry(key, entry) {
    entry.generation += 1;
    entry.freshUntil = 0;
    entry.staleUntil = 0;
    if (!entry.pending) {
      entries.delete(key);
    }
  }

  function touch(key, entry) {
    entry.lastUsedAt = now();
    entries.delete(key);
    entries.set(key, entry);
  }

  function trim() {
    const maximum = normalizePositiveInteger(maxSnapshots, 128);
    while (entries.size > maximum) {
      const candidate = [...entries.entries()].find(([, entry]) => !entry.pending);
      if (!candidate) {
        return;
      }
      entries.delete(candidate[0]);
    }
  }

  return {
    getOrLoad,
    getSnapshot,
    getStats,
    invalidateTable,
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
