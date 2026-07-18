const DATABASE_NAME = 'igp-development-platform-cache';
const DATABASE_VERSION = 1;
const SNAPSHOTS_STORE = 'snapshots';
const DRAFTS_STORE = 'drafts';
const PREFERENCE_PREFIX = 'igp-development-platform:preferences:';
const ACTIVE_USER_PREFERENCE_KEY = 'igp-development-platform:active-user';

export const LOCAL_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createLocalCacheUserKey(user) {
  const value = [
    user?.openId,
    user?.open_id,
    user?.unionId,
    user?.union_id,
    user?.userId,
    user?.user_id,
    user?.email,
    user?.name,
  ]
    .map((item) => String(item || '').trim())
    .find(Boolean);

  return `user:${encodeURIComponent(value || 'unknown')}`;
}

export function createProjectsSnapshotKey(userKey) {
  return createSnapshotKey(userKey, 'projects');
}

export function createWorkItemsSnapshotKey(userKey, projectId, toolId) {
  return createSnapshotKey(userKey, 'work-items', projectId, toolId);
}

export function createProjectOverviewSnapshotKey(userKey, projectId, scope, trendDays) {
  return createSnapshotKey(userKey, 'project-overview', projectId, scope, trendDays);
}

export function createVersionManagementSnapshotKey(userKey, projectId) {
  return createSnapshotKey(userKey, 'version-management', projectId);
}

export function createDraftKey(userKey, action, projectId, toolId, recordId = '') {
  return [
    normalizeKeyPart(userKey),
    'draft',
    normalizeKeyPart(action),
    normalizeKeyPart(projectId),
    normalizeKeyPart(toolId),
    normalizeKeyPart(recordId),
  ].join(':');
}

export function isLocalCacheEntryExpired(savedAt, now = Date.now()) {
  const timestamp = Number(savedAt);
  return !Number.isFinite(timestamp) || now - timestamp > LOCAL_CACHE_RETENTION_MS;
}

export async function initializeLocalCache(user) {
  const userKey = createLocalCacheUserKey(user);
  clearForeignLocalPreferences(userKey);
  await clearExpiredAndForeignEntries(userKey);
  return userKey;
}

export async function getCachedSnapshot(key) {
  const entry = await getEntry(SNAPSHOTS_STORE, key);
  if (!entry) {
    return null;
  }

  if (isLocalCacheEntryExpired(entry.savedAt)) {
    await deleteEntry(SNAPSHOTS_STORE, key);
    return null;
  }

  return {
    savedAt: entry.savedAt,
    value: entry.value,
  };
}

export async function saveCachedSnapshot(userKey, key, value) {
  const sanitizedValue = sanitizeCacheValue(value);
  await putEntry(SNAPSHOTS_STORE, {
    key,
    userKey: normalizeKeyPart(userKey),
    savedAt: Date.now(),
    value: sanitizedValue,
  });
}

export async function getLocalDraft(key) {
  const entry = await getEntry(DRAFTS_STORE, key);
  if (!entry) {
    return null;
  }

  if (isLocalCacheEntryExpired(entry.savedAt)) {
    await deleteEntry(DRAFTS_STORE, key);
    return null;
  }

  return {
    savedAt: entry.savedAt,
    value: entry.value,
  };
}

export async function saveLocalDraft(userKey, key, value) {
  await putEntry(DRAFTS_STORE, {
    key,
    userKey: normalizeKeyPart(userKey),
    savedAt: Date.now(),
    value: serializeDraftValue(value),
  });
}

export async function clearLocalDraft(key) {
  await deleteEntry(DRAFTS_STORE, key);
}

export function readLocalPreference(userKey, name, fallback = null) {
  const storage = getLocalStorage();
  if (!storage) {
    return fallback;
  }

  try {
    const raw = storage.getItem(createPreferenceKey(userKey, name));
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeLocalPreference(userKey, name, value) {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(createPreferenceKey(userKey, name), JSON.stringify(value));
  } catch {
    // Local storage may be disabled in some embedded web views.
  }
}

export function serializeDraftValue(value) {
  return sanitizeCacheValue(value);
}

function createSnapshotKey(userKey, type, ...parts) {
  return [
    normalizeKeyPart(userKey),
    'snapshot',
    normalizeKeyPart(type),
    ...parts.map(normalizeKeyPart),
  ].join(':');
}

function createPreferenceKey(userKey, name) {
  return `${PREFERENCE_PREFIX}${normalizeKeyPart(userKey)}:${normalizeKeyPart(name)}`;
}

function normalizeKeyPart(value) {
  return encodeURIComponent(String(value || '').trim() || '_');
}

function clearForeignLocalPreferences(userKey) {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    const previousUserKey = storage.getItem(ACTIVE_USER_PREFERENCE_KEY);
    if (previousUserKey && previousUserKey !== userKey) {
      const currentPrefix = `${PREFERENCE_PREFIX}${normalizeKeyPart(userKey)}:`;
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(PREFERENCE_PREFIX) && !key.startsWith(currentPrefix)) {
          keys.push(key);
        }
      }
      keys.forEach((key) => storage.removeItem(key));
    }
    storage.setItem(ACTIVE_USER_PREFERENCE_KEY, userKey);
  } catch {
    // Keep the application usable when the host blocks local storage.
  }
}

async function clearExpiredAndForeignEntries(userKey) {
  const stores = [SNAPSHOTS_STORE, DRAFTS_STORE];
  await Promise.all(stores.map(async (storeName) => {
    const entries = await getAllEntries(storeName);
    const staleKeys = entries
      .filter((entry) => entry?.userKey !== userKey || isLocalCacheEntryExpired(entry?.savedAt))
      .map((entry) => entry.key)
      .filter(Boolean);

    await Promise.all(staleKeys.map((key) => deleteEntry(storeName, key)));
  }));
}

function sanitizeCacheValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isFileLike(value) || isAttachmentRecord(value) || isAttachmentState(value) || typeof value !== 'object') {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeCacheValue(item, seen))
      .filter((item) => item !== undefined);
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isAttachmentKey(key) && !isAttachmentSummaryKey(key)) {
      continue;
    }

    const sanitizedItem = sanitizeCacheValue(item, seen);
    if (sanitizedItem !== undefined) {
      result[key] = sanitizedItem;
    }
  }
  return result;
}

function isFileLike(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (typeof File !== 'undefined' && value instanceof File) {
    return true;
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return true;
  }

  return typeof value.arrayBuffer === 'function' && typeof value.type === 'string' && typeof value.size === 'number';
}

function isAttachmentRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Boolean(value.file_token || value.fileToken || value.tmp_url || value.tmpUrl);
}

function isAttachmentState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(value, 'newFiles') || (
    Object.prototype.hasOwnProperty.call(value, 'existing')
    && Array.isArray(value.existing)
  );
}

function isAttachmentKey(key) {
  const text = String(key || '').toLocaleLowerCase('en-US');
  return text.includes('attachment') || text.includes('附件');
}

function isAttachmentSummaryKey(key) {
  return String(key || '').toLocaleLowerCase('en-US') === 'missingattachments';
}

function getLocalStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function getIndexedDb() {
  return typeof indexedDB !== 'undefined' ? indexedDB : null;
}

function openDatabase() {
  const indexedDb = getIndexedDb();
  if (!indexedDb) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of [SNAPSHOTS_STORE, DRAFTS_STORE]) {
        if (!database.objectStoreNames.contains(storeName)) {
          const store = database.createObjectStore(storeName, { keyPath: 'key' });
          store.createIndex('userKey', 'userKey', { unique: false });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地缓存'));
    request.onblocked = () => reject(new Error('本地缓存被其他页面占用'));
  });
}

async function getEntry(storeName, key) {
  return runStoreRequest(storeName, 'readonly', (store) => store.get(key));
}

async function getAllEntries(storeName) {
  return (await runStoreRequest(storeName, 'readonly', (store) => store.getAll())) || [];
}

async function putEntry(storeName, value) {
  await runStoreRequest(storeName, 'readwrite', (store) => store.put(value));
}

async function deleteEntry(storeName, key) {
  await runStoreRequest(storeName, 'readwrite', (store) => store.delete(key));
}

async function runStoreRequest(storeName, mode, createRequest) {
  try {
    const database = await openDatabase();
    if (!database) {
      return null;
    }

    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = createRequest(transaction.objectStore(storeName));
      let requestResult = null;

      request.onsuccess = () => {
        requestResult = request.result;
      };
      request.onerror = () => reject(request.error || new Error('本地缓存操作失败'));
      transaction.oncomplete = () => resolve(requestResult);
      transaction.onerror = () => reject(transaction.error || new Error('本地缓存操作失败'));
      transaction.onabort = () => reject(transaction.error || new Error('本地缓存操作已取消'));
    });
  } catch {
    return null;
  }
}
