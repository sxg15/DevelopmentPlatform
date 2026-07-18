import { getWorkItemToolDefinition } from '../../../shared/workItemDefinitions.js';

export function isEmptyBitableValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (typeof value === 'object') {
    return Object.keys(value).length === 0;
  }

  return false;
}

export function buildDisplayFields(fields, rawFields, hiddenFieldNames = []) {
  const hiddenNames = new Set(hiddenFieldNames.map((item) => String(item || '').trim()).filter(Boolean));
  const normalizedFields = (Array.isArray(fields) ? fields : [])
    .filter((field) => field?.fieldName)
    .filter((field) => !hiddenNames.has(field.fieldName))
    .sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
  const knownNames = new Set(normalizedFields.map((field) => field.fieldName));
  const extraFields = Object.keys(rawFields || {})
    .filter((fieldName) => !knownNames.has(fieldName))
    .filter((fieldName) => !hiddenNames.has(fieldName))
    .map((fieldName, index) => ({
      fieldId: `raw-${fieldName}`,
      fieldName,
      type: '',
      uiType: '',
      property: {},
      index: normalizedFields.length + index,
    }));

  return [...normalizedFields, ...extraFields];
}

export function buildEditableFieldInitialValues(fields, rawFields, projectId, toolConfig) {
  return Object.fromEntries((Array.isArray(fields) ? fields : []).map((field) => {
    const value = rawFields?.[field.fieldName];
    return [field.fieldName, normalizeEditableFieldInitialValue(field, value, projectId, toolConfig)];
  }));
}

export function normalizeEditableFieldInitialValue(field, value, projectId, toolConfig) {
  if (isFeedbackContactInfoField(field, toolConfig)) {
    return normalizeEditableFeedbackContactInfo(parseFeedbackContactInfoForClient(value));
  }

  if (isAttachmentField(field, value)) {
    return {
      existing: normalizeAttachmentItems(value, projectId, toolConfig),
      newFiles: [],
    };
  }

  if (isUserField(field, value)) {
    return normalizeFieldUsers(value);
  }

  if (isMultiSelectField(field)) {
    return normalizeSelectItems(value).map((item) => item.name).filter(Boolean);
  }

  if (isSelectField(field, value)) {
    return normalizeSelectItems(value)[0]?.name || '';
  }

  if (isCheckboxField(field)) {
    return normalizeCheckboxValue(value);
  }

  if (isDateField(field)) {
    return formatDateTimeLocalInput(value);
  }

  if (isNumberLikeEditableField(field)) {
    const number = normalizeNumberDisplayValue(value);
    return number === null ? '' : String(number);
  }

  if (isUrlField(field, value)) {
    const url = normalizeUrlItems(value)[0];
    return url?.url || normalizeDisplayText(value);
  }

  return normalizeDisplayText(value);
}

export function isFeedbackContactInfoField(field, toolConfig) {
  return toolConfig?.toolId === 'feedback'
    && String(field?.fieldName || '').trim() === '联系信息数据';
}

export function parseFeedbackContactInfoForClient(value) {
  const text = normalizeDisplayText(value).trim();
  if (!text) {
    return {
      valid: false,
      isFeishuUser: false,
      feishuUserId: '',
      phone: '',
      email: '',
      allowDeveloperFollowUp: false,
    };
  }

  try {
    const source = JSON.parse(text);
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('invalid contact info');
    }

    return {
      valid: true,
      isFeishuUser: Boolean(source.isFeishuUser),
      feishuUserId: String(source.feishuUserId || '').trim(),
      phone: String(source.phone || '').trim(),
      email: String(source.email || '').trim(),
      allowDeveloperFollowUp: Boolean(source.allowDeveloperFollowUp),
    };
  } catch {
    return {
      valid: false,
      isFeishuUser: false,
      feishuUserId: '',
      phone: '',
      email: '',
      allowDeveloperFollowUp: false,
    };
  }
}

export function normalizeEditableFeedbackContactInfo(value) {
  return {
    isFeishuUser: Boolean(value?.isFeishuUser),
    feishuUserId: String(value?.feishuUserId || '').trim(),
    phone: String(value?.phone || '').trim(),
    email: String(value?.email || '').trim(),
    allowDeveloperFollowUp: Boolean(value?.allowDeveloperFollowUp),
  };
}

export function toEditableAttachmentPayload(attachment) {
  return {
    fileToken: attachment.fileToken || '',
    name: attachment.name || '',
    size: attachment.size || 0,
    mimeType: attachment.mimeType || '',
  };
}

export function formatDateTimeLocalInput(value) {
  const timestamp = normalizeDateDisplayTimestamp(value);
  if (!timestamp) {
    return '';
  }

  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function getFieldUiType(field) {
  return String(field?.uiType || field?.ui_type || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export function getFieldTypeNumber(field) {
  const number = Number(field?.type);
  return Number.isFinite(number) ? number : null;
}

export function isAttachmentField(field, value) {
  const uiType = getFieldUiType(field);
  return uiType.includes('attachment') || getFieldTypeNumber(field) === 17 || normalizeAttachmentItems(value).length > 0;
}

export function isUserField(field, value) {
  const uiType = getFieldUiType(field);
  return uiType.includes('user') || uiType.includes('person') || getFieldTypeNumber(field) === 11 || looksLikeUserValue(value);
}

export function isDateField(field) {
  const uiType = getFieldUiType(field);
  const type = getFieldTypeNumber(field);
  return uiType.includes('date') || uiType.includes('time') || type === 5 || type === 1001 || type === 1002;
}

export function isSelectField(field) {
  const uiType = getFieldUiType(field);
  const type = getFieldTypeNumber(field);
  return uiType.includes('select') || type === 3 || type === 4;
}

export function isMultiSelectField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('multiselect') || getFieldTypeNumber(field) === 4;
}

export function getFieldSelectOptionNames(field) {
  const options = Array.isArray(field?.property?.options) ? field.property.options : [];
  return options.map((option) => normalizeDisplayText(option.name || option.text || option.value)).filter(Boolean);
}

export function isCheckboxField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('checkbox') || getFieldTypeNumber(field) === 7;
}

export function isUrlField(field, value) {
  const uiType = getFieldUiType(field);
  return uiType === 'url' || uiType.includes('url') || uiType.includes('link') || normalizeUrlItems(value).length > 0;
}

export function isProgressField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('progress') || getFieldTypeNumber(field) === 18;
}

export function isRatingField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('rating') || getFieldTypeNumber(field) === 19;
}

export function isCurrencyField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('currency');
}

export function isNumberLikeEditableField(field) {
  return isProgressField(field) || isRatingField(field) || isCurrencyField(field) || getFieldTypeNumber(field) === 2 || getFieldUiType(field).includes('number');
}

export function getEditableFieldTypeLabel(field) {
  if (isAttachmentField(field, null)) {
    return '附件';
  }
  if (isUserField(field, null)) {
    return '人员';
  }
  if (isMultiSelectField(field)) {
    return '多选';
  }
  if (isSelectField(field, null)) {
    return '单选';
  }
  if (isCheckboxField(field)) {
    return '复选';
  }
  if (isDateField(field)) {
    return '日期';
  }
  if (isNumberLikeEditableField(field)) {
    return '数字';
  }
  if (isUrlField(field, null)) {
    return '链接';
  }
  return '文本';
}

export function normalizeSelectItems(value) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) => {
      if (item && typeof item === 'object' && Array.isArray(item.value)) {
        return normalizeSelectItems(item.value);
      }

      return [item];
    })
    .map((item) => {
      if (item && typeof item === 'object') {
        const colorId = Number(item.color);
        return {
          name: normalizeDisplayText(item.name || item.text || item.value || item.id),
          color: Number.isFinite(colorId) ? mapBitableOptionColor(colorId) : '',
        };
      }

      return {
        name: normalizeDisplayText(item),
        color: '',
      };
    })
    .filter((item) => item.name);
}

export function findFieldOption(field, name) {
  const options = Array.isArray(field?.property?.options) ? field.property.options : [];
  return options.find((option) => normalizeDisplayText(option.name) === name || normalizeDisplayText(option.text) === name) || null;
}

export function normalizeFieldUsers(value) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) => {
      if (item && typeof item === 'object' && Array.isArray(item.value)) {
        return normalizeFieldUsers(item.value);
      }

      return [item];
    })
    .map((item) => {
      if (!item || typeof item !== 'object') {
        const name = normalizeDisplayText(item);
        return name ? { name } : null;
      }

      const name = normalizeDisplayText(item.name || item.en_name || item.nickname || item.email || item.id);
      return {
        id: String(item.id || item.user_id || item.userId || item.open_id || item.openId || item.email || name || '').trim(),
        openId: String(item.open_id || item.openId || item.id || '').trim(),
        unionId: String(item.union_id || item.unionId || '').trim(),
        userId: String(item.user_id || item.userId || '').trim(),
        email: String(item.email || '').trim(),
        name,
        avatarUrl: String(item.avatar_url || item.avatarUrl || item.avatar_thumb || item.avatarThumb || '').trim(),
      };
    })
    .filter((item) => item?.name);
}

export function looksLikeUserValue(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => item && typeof item === 'object' && ('open_id' in item || 'openId' in item || 'user_id' in item || 'userId' in item));
}

export function normalizeUrlItems(value) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) => {
      if (item && typeof item === 'object' && Array.isArray(item.value)) {
        return normalizeUrlItems(item.value);
      }

      return [item];
    })
    .map((item) => {
      if (typeof item === 'string') {
        return isHttpUrl(item) ? { url: item, text: item } : null;
      }

      if (item && typeof item === 'object') {
        const url = normalizeDisplayText(item.link || item.url || item.href || item.value);
        return isHttpUrl(url)
          ? {
              url,
              text: normalizeDisplayText(item.text || item.name || item.title) || url,
            }
          : null;
      }

      return null;
    })
    .filter(Boolean);
}

export function normalizeAttachmentItems(value, projectId = '', toolConfig = getWorkItemToolDefinition('requirements')) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const fileToken = String(item.file_token || item.fileToken || item.token || item.attachmentToken || '').trim();
      const name = String(item.name || item.file_name || item.fileName || item.title || fileToken || '').trim();
      const size = Number(item.size || item.file_size || item.fileSize || 0);
      const mimeType = String(item.mime_type || item.mimeType || item.content_type || item.contentType || item.type || '').trim();
      const directUrl = String(item.url || item.download_url || item.downloadUrl || '').trim();
      const routeSegment = toolConfig?.routeSegment || 'requirements';
      const proxyUrl = fileToken && projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(routeSegment)}/attachments/${encodeURIComponent(fileToken)}?name=${encodeURIComponent(name)}`
        : '';

      return {
        fileToken,
        name,
        size: Number.isFinite(size) ? size : 0,
        mimeType,
        url: proxyUrl || directUrl,
      };
    })
    .filter((item) => item?.fileToken || item?.url);
}

export function isImageAttachment(attachment) {
  const extension = getFileExtension(attachment.name);
  return attachment.mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension);
}

export function isVideoAttachment(attachment) {
  const extension = getFileExtension(attachment.name);
  return attachment.mimeType.startsWith('video/') || ['mp4', 'webm', 'ogg', 'mov', 'm4v'].includes(extension);
}

export function getFileExtension(name) {
  const matched = String(name || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return matched ? matched[1] : '';
}

export function normalizeCheckboxValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const text = normalizeDisplayText(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'y', '是', '勾选', '已勾选'].includes(text);
}

export function formatBitableDate(value) {
  const timestamp = normalizeDateDisplayTimestamp(value);
  if (!timestamp) {
    return normalizeDisplayText(value) || '未填写';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function normalizeDateDisplayTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    const timestamp = value < 10000000000 ? value * 1000 : value;
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return normalizeDateDisplayTimestamp(numeric);
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (Array.isArray(value)) {
    return normalizeDateDisplayTimestamp(value[0]);
  }

  if (typeof value === 'object') {
    return normalizeDateDisplayTimestamp(value.timestamp || value.date || value.value || value.text);
  }

  return null;
}

export function normalizeNumberDisplayValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const number = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  if (Array.isArray(value)) {
    return normalizeNumberDisplayValue(value[0]);
  }

  if (value && typeof value === 'object') {
    return normalizeNumberDisplayValue(value.value || value.text || value.number);
  }

  return null;
}

export function formatCurrencyValue(value) {
  const text = normalizeDisplayText(value);
  return text || '未填写';
}

export function formatFileSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '大小未知';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function normalizeDisplayText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }

  if (Array.isArray(value)) {
    const delimiter = shouldJoinArrayWithoutSeparator(value) ? '' : '、';
    return value.map((item) => normalizeDisplayText(item)).filter(Boolean).join(delimiter);
  }

  if (typeof value === 'object') {
    if (Array.isArray(value.value)) {
      return normalizeDisplayText(value.value);
    }

    const directValue = value.text ?? value.name ?? value.title ?? value.link ?? value.url ?? value.value ?? value.en_name;
    if (directValue !== undefined && directValue !== value) {
      return normalizeDisplayText(directValue);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

export function shouldJoinArrayWithoutSeparator(value) {
  return value.every((item) => item && typeof item === 'object' && !('name' in item) && !('file_token' in item) && !('fileToken' in item));
}

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

export function mapBitableOptionColor(colorId) {
  const colorMap = {
    0: '#dee0e3',
    1: '#f54a45',
    2: '#ff8f1f',
    3: '#f5c400',
    4: '#34c724',
    5: '#20d2a8',
    6: '#1fb6ff',
    7: '#3370ff',
    8: '#8f4bff',
    9: '#f759ab',
    10: '#c9cdd4',
    11: '#fbbfbc',
    12: '#fed4a4',
    13: '#ffec8a',
    14: '#b7edb1',
    15: '#a9efe6',
    16: '#a6d8ff',
    17: '#bacefd',
    18: '#d7b9ff',
    19: '#ffc2e6',
    20: '#8f959e',
    21: '#d83931',
    22: '#de7802',
    23: '#dc9b04',
    24: '#2ea121',
    25: '#10a893',
    26: '#0788d8',
    27: '#245bdb',
    28: '#6425d0',
    29: '#c2287f',
    30: '#646a73',
    31: '#991b1b',
    32: '#a04a00',
    33: '#8f6b00',
    34: '#1f7a1f',
    35: '#0f766e',
    36: '#0c63b7',
    37: '#1d4ed8',
    38: '#581c87',
    39: '#9d174d',
    40: '#373c43',
  };

  return colorMap[Number(colorId)] || '';
}

export function buildSoftColor(color) {
  const rgb = hexToRgb(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.1)` : '';
}

export function buildBorderColor(color) {
  const rgb = hexToRgb(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)` : '';
}

export function hexToRgb(color) {
  const normalized = String(color || '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }

  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

export function isSameDisplayUser(left, right) {
  const leftKeys = buildDisplayUserKeys(left);
  const rightKeys = buildDisplayUserKeys(right);

  for (const key of leftKeys) {
    if (rightKeys.has(key)) {
      return true;
    }
  }

  return false;
}

export function buildDisplayUserSetKey(users) {
  return [...new Set((users || []).map(getDisplayUserStableKey).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .join('|');
}

export function getDisplayUserStableKey(user) {
  return String(user?.openId || user?.unionId || user?.userId || user?.email || user?.id || user?.name || '').trim();
}

export function formatPeopleNames(users) {
  const names = (users || []).map((user) => normalizeDisplayText(user?.name || user?.openId || user?.id)).filter(Boolean);
  return names.length > 0 ? names.join('、') : '无';
}

export function buildDisplayUserKeys(user) {
  return new Set(
    [user?.openId, user?.unionId, user?.userId, user?.email, user?.name, user?.id]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
}
