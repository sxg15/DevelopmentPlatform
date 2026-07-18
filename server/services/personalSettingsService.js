import {
  DEFAULT_TODO_NOTIFICATION_TIME,
  DEFAULT_TODO_NOTIFICATION_TIME_ZONE,
  getZonedDateTimeParts,
  normalizePersonalNotificationSettings,
  normalizeTodoNotificationTime,
} from '../../shared/personalSettingsUtils.js';
import { runtimeConfig, validatePersonalSettingsConfig } from '../config/runtimeConfig.js';
import {
  createBitableRecord,
  fetchBitableRecords,
  fetchCachedBitableFields,
  fetchCachedBitableTables,
  updateBitableRecordFields,
} from '../integrations/bitableClient.js';
import { fetchWikiNodeByToken, isWikiBitableNode } from '../integrations/wikiClient.js';
import { getCachedValue } from '../runtime/asyncCache.js';

const PERSONAL_SETTINGS_CONTEXT_TTL_MS = 10 * 60 * 1000;
const personalSettingsContextCache = new Map();

export async function readPersonalSettingsForUser(token, user) {
  const context = await getPersonalSettingsTableContext(token);
  const records = await fetchPersonalSettingsRecords(token, context);
  const matchedRecords = findPersonalSettingsRecordsForUser(records, user, context.config.fieldNames);

  if (matchedRecords.length > 1) {
    throw createDuplicatePersonalSettingsError();
  }

  return normalizePersonalSettingsRecord(matchedRecords[0], context.config);
}

export async function savePersonalSettingsForUser(token, user, value) {
  const context = await getPersonalSettingsTableContext(token);
  const settings = normalizePersonalNotificationSettings(value, {
    defaultTime: context.config.defaultTime,
    timeZone: context.config.timeZone,
  });
  const records = await fetchPersonalSettingsRecords(token, context);
  const matchedRecords = findPersonalSettingsRecordsForUser(records, user, context.config.fieldNames);

  if (matchedRecords.length > 1) {
    throw createDuplicatePersonalSettingsError();
  }

  const fields = buildPersonalSettingsFields(context, user, settings, {
    includeUser: matchedRecords.length === 0,
  });

  if (matchedRecords.length === 0) {
    await createBitableRecord(token, context.appToken, context.tableId, fields);
  } else {
    const recordId = String(matchedRecords[0].record_id || matchedRecords[0].recordId || '').trim();
    await updateBitableRecordFields(token, context.appToken, context.tableId, recordId, fields);
  }

  return settings;
}

export async function listTodoNotificationRecipients(token) {
  const context = await getPersonalSettingsTableContext(token);
  const records = await fetchPersonalSettingsRecords(token, context);
  const recipientsByKey = new Map();
  const duplicateKeys = new Set();
  const warnings = [];

  for (const record of records) {
    const settings = normalizePersonalSettingsRecord(record, context.config);
    if (!settings.receiveTodoNotifications) {
      continue;
    }

    const users = normalizeBitableUsers(record?.fields?.[context.config.fieldNames.user]);
    const user = users[0] || null;
    const userKey = getPrimaryUserKey(user);
    if (!userKey) {
      warnings.push('个人设置表存在无法识别用户的通知记录');
      continue;
    }

    if (recipientsByKey.has(userKey)) {
      recipientsByKey.delete(userKey);
      duplicateKeys.add(userKey);
      continue;
    }

    if (!duplicateKeys.has(userKey)) {
      recipientsByKey.set(userKey, { user, settings });
    }
  }

  if (duplicateKeys.size > 0) {
    warnings.push(`个人设置表存在 ${duplicateKeys.size} 个重复用户，已跳过通知`);
  }

  return {
    recipients: [...recipientsByKey.values()],
    warnings,
  };
}

export async function getPersonalSettingsTableContext(token) {
  validatePersonalSettingsConfig();
  const config = runtimeConfig.bitable.personalSettings;
  const cacheKey = `${config.wikiNodeToken}|${config.tableId || ''}`;

  return getCachedValue(
    personalSettingsContextCache,
    cacheKey,
    PERSONAL_SETTINGS_CONTEXT_TTL_MS,
    async () => {
      const node = await fetchWikiNodeByToken(token, config.wikiNodeToken);
      if (!isWikiBitableNode(node)) {
        throw new Error('个人设置 Wiki 节点不是多维表格');
      }

      const tables = await fetchCachedBitableTables(token, node.objToken);
      const tableId = config.tableId
        || String(tables[0]?.table_id || tables[0]?.tableId || '').trim();
      if (!tableId) {
        throw new Error('个人设置多维表格没有可读取的数据表');
      }

      const fields = await fetchCachedBitableFields(token, node.objToken, tableId);
      const normalizedContext = {
        appToken: node.objToken,
        tableId,
        config,
        fields,
      };
      validatePersonalSettingsSchema(normalizedContext);
      return normalizedContext;
    },
  );
}

function fetchPersonalSettingsRecords(token, context) {
  return fetchBitableRecords(token, {
    appToken: context.appToken,
    tableId: context.tableId,
    viewId: context.config.viewId,
    fieldNames: context.config.fieldNames,
  });
}

function normalizePersonalSettingsRecord(record, config) {
  const fields = record?.fields || {};
  const enabledText = normalizeTextValue(fields[config.fieldNames.receiveTodoNotifications]);
  return {
    receiveTodoNotifications: enabledText === config.enabledValue,
    todoNotificationTime: normalizeTodoNotificationTime(
      fields[config.fieldNames.todoNotificationTime],
      config.defaultTime || DEFAULT_TODO_NOTIFICATION_TIME,
      config.timeZone || DEFAULT_TODO_NOTIFICATION_TIME_ZONE,
    ),
  };
}

function findPersonalSettingsRecordsForUser(records, user, fieldNames) {
  const expectedKeys = getUserKeySet(user);
  if (expectedKeys.size === 0) {
    return [];
  }

  return (Array.isArray(records) ? records : []).filter((record) => (
    normalizeBitableUsers(record?.fields?.[fieldNames.user])
      .some((person) => [...getUserKeySet(person)].some((key) => expectedKeys.has(key)))
  ));
}

function buildPersonalSettingsFields(context, user, settings, options = {}) {
  const names = context.config.fieldNames;
  const values = {};

  if (options.includeUser) {
    values[names.user] = [toBitableUserValue(user)];
  }

  if (settings.receiveTodoNotifications) {
    values[names.receiveTodoNotifications] = context.config.enabledValue;
  } else if (!options.includeUser) {
    values[names.receiveTodoNotifications] = null;
  }
  values[names.todoNotificationTime] = serializeTodoNotificationTime(
    settings.todoNotificationTime,
    findFieldByName(context.fields, names.todoNotificationTime),
    context.config.timeZone,
  );

  return values;
}

function validatePersonalSettingsSchema(context) {
  const names = context.config.fieldNames;
  const userField = findRequiredField(context.fields, names.user);
  const enabledField = findRequiredField(context.fields, names.receiveTodoNotifications);
  const timeField = findRequiredField(context.fields, names.todoNotificationTime);

  if (!isBitableUserField(userField)) {
    throw new Error(`个人设置字段“${names.user}”必须是人员字段`);
  }
  if (!isBitableSingleSelectField(enabledField)) {
    throw new Error(`个人设置字段“${names.receiveTodoNotifications}”必须是单选字段`);
  }
  if (!isBitableTextField(timeField) && !isBitableDateField(timeField)) {
    throw new Error(`个人设置字段“${names.todoNotificationTime}”必须是文本或日期时间字段`);
  }

  const options = enabledField?.property?.options || enabledField?.property?.option || [];
  if (
    Array.isArray(options)
    && options.length > 0
    && !options.some((option) => normalizeTextValue(option?.name || option?.text || option?.value) === context.config.enabledValue)
  ) {
    throw new Error(`个人设置字段“${names.receiveTodoNotifications}”缺少“${context.config.enabledValue}”选项`);
  }
}

function serializeTodoNotificationTime(time, field, timeZone) {
  const normalizedTime = normalizeTodoNotificationTime(time);
  if (!isBitableDateField(field)) {
    return normalizedTime;
  }

  const { dateKey } = getZonedDateTimeParts(new Date(), timeZone);
  const offset = timeZone === 'Asia/Shanghai' ? '+08:00' : '';
  const timestamp = new Date(`${dateKey}T${normalizedTime}:00${offset}`).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error('待办事项通知时间格式无效');
  }
  return timestamp;
}

function normalizeBitableUsers(value) {
  const source = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return source.map((item) => ({
    id: String(item?.id || item?.user_id || item?.userId || '').trim(),
    openId: String(item?.open_id || item?.openId || item?.id || '').trim(),
    userId: String(item?.user_id || item?.userId || '').trim(),
    unionId: String(item?.union_id || item?.unionId || '').trim(),
    email: String(item?.email || '').trim(),
    name: normalizeTextValue(item?.name || item?.en_name || item?.nickname || item?.email),
  })).filter((item) => getPrimaryUserKey(item));
}

function toBitableUserValue(user) {
  const openId = String(user?.openId || user?.open_id || user?.id || '').trim();
  const name = normalizeTextValue(user?.name || user?.email || openId);
  if (!openId) {
    throw new Error('当前用户缺少飞书 Open ID');
  }
  return {
    id: openId,
    open_id: openId,
    name,
  };
}

function getPrimaryUserKey(user) {
  return [...getUserKeySet(user)][0] || '';
}

function getUserKeySet(user) {
  return new Set([
    user?.openId,
    user?.open_id,
    user?.userId,
    user?.user_id,
    user?.unionId,
    user?.union_id,
    user?.email,
    user?.id,
    user?.name,
  ].map((item) => String(item || '').trim()).filter(Boolean));
}

function normalizeTextValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeTextValue).filter(Boolean).join('');
  }
  if (typeof value === 'object') {
    return normalizeTextValue(value.text ?? value.name ?? value.value ?? '');
  }
  return '';
}

function findRequiredField(fields, fieldName) {
  const field = findFieldByName(fields, fieldName);
  if (!field) {
    throw new Error(`个人设置表缺少“${fieldName}”字段`);
  }
  return field;
}

function findFieldByName(fields, fieldName) {
  return (Array.isArray(fields) ? fields : []).find((field) => (
    String(field?.field_name || field?.fieldName || '').trim() === fieldName
  )) || null;
}

function getFieldType(field) {
  const number = Number(field?.type);
  return Number.isFinite(number) ? number : -1;
}

function getFieldUiType(field) {
  return String(field?.ui_type || field?.uiType || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isBitableUserField(field) {
  return getFieldType(field) === 11 || getFieldUiType(field).includes('user') || getFieldUiType(field).includes('person');
}

function isBitableSingleSelectField(field) {
  return getFieldType(field) === 3 || getFieldUiType(field).includes('singleselect');
}

function isBitableDateField(field) {
  return getFieldType(field) === 5 || getFieldUiType(field).includes('date') || getFieldUiType(field).includes('time');
}

function isBitableTextField(field) {
  return getFieldType(field) === 1 || getFieldUiType(field).includes('text');
}

function createDuplicatePersonalSettingsError() {
  const error = new Error('个人设置表中存在重复用户记录，请联系管理员清理');
  error.code = 'DUPLICATE_PERSONAL_SETTINGS';
  return error;
}
