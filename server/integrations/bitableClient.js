import { readJson } from './feishuClient.js';
import { getCachedValue } from '../runtime/asyncCache.js';

const PROJECT_DATA_CACHE_TTL_MS = 60 * 1000;
const STRUCTURE_CACHE_TTL_MS = 5 * 60 * 1000;
const LONG_STRUCTURE_CACHE_TTL_MS = 10 * 60 * 1000;
const projectDataCache = new Map();
const bitableTablesCache = new Map();
const bitableFieldsCache = new Map();
export async function fetchBitableRecords(token, tableConfig) {
  const records = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) {
      query.set('page_token', pageToken);
    }

    const fieldNames = getBitableFieldNames(tableConfig);
    const requestBody = {};

    if (fieldNames.length > 0) {
      requestBody.field_names = fieldNames;
    }

    if (tableConfig.viewId) {
      requestBody.view_id = tableConfig.viewId;
    }

    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(tableConfig.appToken)}/tables/${encodeURIComponent(tableConfig.tableId)}/records/search?${query}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(requestBody),
    });

    const payload = await readJson(response);

    if (!response.ok || payload.code !== 0) {
      throw new Error(formatFeishuApiError(payload.msg || '读取项目基础信息失败'));
    }

    const pageItems = payload.data?.items || payload.data?.records || [];
    records.push(...pageItems);
    pageToken = payload.data?.has_more ? String(payload.data?.page_token || '') : '';
  } while (pageToken);

  return records;
}

export async function fetchCachedBitableRecords(token, tableConfig, cacheKeyPrefix, ttlMs) {
  const cacheKey = [
    'records',
    cacheKeyPrefix,
    tableConfig.appToken,
    tableConfig.tableId,
    tableConfig.viewId || '',
    getBitableFieldNames(tableConfig).join('\u001f'),
  ].join('|');

  return getCachedValue(projectDataCache, cacheKey, ttlMs, () => fetchBitableRecords(token, tableConfig));
}

export function getBitableFieldNames(tableConfig) {
  const fields = tableConfig.fieldNames || {};
  const names = [];

  collectBitableFieldNames(fields, names);

  return [...new Set(names.filter(Boolean))];
}

export function collectBitableFieldNames(value, names) {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    names.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectBitableFieldNames(item, names);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectBitableFieldNames(item, names);
    }
  }
}

export function formatFeishuApiError(message) {
  const text = String(message || '');

  if (text.includes('FieldNameNotFound')) {
    return '需求表字段名不匹配，请检查配置文件中的需求字段名';
  }

  return text;
}

export async function fetchBitableTables(token, appToken) {
  const tables = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (pageToken) {
      query.set('page_token', pageToken);
    }

    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?${query}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = await readJson(response);

    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.msg || '读取需求数据表失败');
    }

    const items = payload.data?.items || payload.data?.tables || [];
    tables.push(...items);
    pageToken = payload.data?.has_more ? String(payload.data?.page_token || '') : '';
  } while (pageToken);

  return tables;
}

export function fetchCachedBitableTables(token, appToken) {
  return getCachedValue(
    bitableTablesCache,
    String(appToken || ''),
    LONG_STRUCTURE_CACHE_TTL_MS,
    () => fetchBitableTables(token, appToken),
  );
}

export async function fetchBitableFields(token, appToken, tableId) {
  const fields = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (pageToken) {
      query.set('page_token', pageToken);
    }

    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${query}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = await readJson(response);

    if (!response.ok || payload.code !== 0) {
      throw new Error(formatFeishuApiError(payload.msg || '读取需求字段失败'));
    }

    const items = payload.data?.items || payload.data?.fields || [];
    fields.push(...items);
    pageToken = payload.data?.has_more ? String(payload.data?.page_token || '') : '';
  } while (pageToken);

  return fields;
}

export function fetchCachedBitableFields(token, appToken, tableId) {
  return getCachedValue(
    bitableFieldsCache,
    getBitableFieldCacheKey(appToken, tableId),
    STRUCTURE_CACHE_TTL_MS,
    () => fetchBitableFields(token, appToken, tableId),
  );
}

export function invalidateBitableFieldsCache(appToken, tableId) {
  bitableFieldsCache.delete(getBitableFieldCacheKey(appToken, tableId));
}

export function getBitableFieldCacheKey(appToken, tableId) {
  return `${appToken || ''}|${tableId || ''}`;
}

export async function createBitableTextField(token, appToken, tableId, fieldName) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      field_name: fieldName,
      type: 1,
    }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    const message = String(payload.msg || '');
    if (message.includes('FieldName') || message.includes('duplicate') || message.includes('duplicated')) {
      return null;
    }

    throw new Error(formatFeishuApiError(message || '创建留言字段失败'));
  }

  return payload.data?.field || payload.data || null;
}

export async function ensureBitableTextField(token, appToken, tableId, fieldName) {
  const fields = await fetchCachedBitableFields(token, appToken, tableId);
  const existingField = fields.find((field) => String(field.field_name || field.fieldName || '') === fieldName);
  if (existingField) {
    return existingField;
  }

  await createBitableTextField(token, appToken, tableId, fieldName);
  invalidateBitableFieldsCache(appToken, tableId);
  const nextFields = await fetchCachedBitableFields(token, appToken, tableId);
  const createdField = nextFields.find((field) => String(field.field_name || field.fieldName || '') === fieldName);
  if (!createdField) {
    throw new Error(`无法创建留言字段：${fieldName}`);
  }

  return createdField;
}

export async function ensureCachedBitableTextField(token, appToken, tableId, fieldName) {
  const fields = await fetchCachedBitableFields(token, appToken, tableId);
  const existingField = fields.find((field) => String(field.field_name || field.fieldName || '') === fieldName);
  if (existingField) {
    return fields;
  }

  await createBitableTextField(token, appToken, tableId, fieldName);
  invalidateBitableFieldsCache(appToken, tableId);
  const nextFields = await fetchCachedBitableFields(token, appToken, tableId);
  const createdField = nextFields.find((field) => String(field.field_name || field.fieldName || '') === fieldName);
  if (!createdField) {
    throw new Error(`无法创建留言字段：${fieldName}`);
  }

  return nextFields;
}

export async function updateBitableField(token, appToken, tableId, fieldId, field) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(fieldId)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(field),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(formatFeishuApiError(payload.msg || '更新多维表格字段失败'));
  }

  invalidateBitableFieldsCache(appToken, tableId);
  return payload.data?.field || payload.data || null;
}

export async function updateBitableRecordFields(token, appToken, tableId, recordId, fields) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ fields }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(formatFeishuApiError(payload.msg || '更新需求记录失败'));
  }

  return payload.data?.record || payload.data || null;
}

export async function createBitableRecord(token, appToken, tableId, fields) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ fields }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(formatFeishuApiError(payload.msg || '新增记录失败'));
  }

  return payload.data?.record || payload.data || null;
}

export async function deleteBitableRecord(token, appToken, tableId, recordId) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(formatFeishuApiError(payload.msg || '删除记录失败'));
  }

  return payload.data || {};
}
