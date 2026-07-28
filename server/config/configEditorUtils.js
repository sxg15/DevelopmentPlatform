import crypto from 'node:crypto';
import path from 'node:path';
import { normalizeConfig } from './normalizeConfig.js';

export const CONFIG_EDITOR_SECRET_PATHS = Object.freeze([
  'feishu.appSecret',
  'aiPlanning.codex.apiKey',
]);

const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function createConfigRevision(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

export function createEditableConfig(rawConfig) {
  const normalized = normalizeConfig(rawConfig);
  const editable = cloneValue(normalized);
  const secretState = {};

  for (const secretPath of CONFIG_EDITOR_SECRET_PATHS) {
    secretState[secretPath] = Boolean(String(getPathValue(rawConfig, secretPath) || '').trim());
    setPathValue(editable, secretPath, '');
  }

  return {
    config: editable,
    secretState,
    warnings: collectConfigWarnings(rawConfig),
  };
}

export function applyConfigUpdate(currentConfig, submittedConfig, secretChanges = {}) {
  if (!isPlainObject(currentConfig) || !isPlainObject(submittedConfig)) {
    throw new TypeError('配置必须是 JSON 对象');
  }

  const sanitizedSubmitted = cloneValue(submittedConfig);
  for (const secretPath of CONFIG_EDITOR_SECRET_PATHS) {
    deletePathValue(sanitizedSubmitted, secretPath);
  }

  const merged = mergeConfigObjects(cloneValue(currentConfig), sanitizedSubmitted);
  for (const secretPath of CONFIG_EDITOR_SECRET_PATHS) {
    applySecretChange(merged, currentConfig, secretPath, secretChanges[secretPath]);
  }
  return merged;
}

export function validateConfigDocument(config, options = {}) {
  const errors = [];
  if (!isPlainObject(config)) {
    return [{ path: '', message: '配置必须是 JSON 对象' }];
  }

  const port = Number(config?.server?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push({ path: 'server.port', message: '端口必须是 1 到 65535 之间的整数' });
  }

  validateOptionalHttpUrl(errors, config?.webApp?.publicBaseUrl, 'webApp.publicBaseUrl', 'Web 公开地址');
  validateOptionalHttpsUrl(errors, config?.updates?.manifestUrl, 'updates.manifestUrl', '更新清单地址');
  validatePositiveInteger(
    errors,
    config?.knowledgeBase?.requirementsIdDigits,
    'knowledgeBase.requirementsIdDigits',
    '需求 ID 位数',
  );
  validatePositiveInteger(
    errors,
    config?.knowledgeBase?.bugsIdDigits,
    'knowledgeBase.bugsIdDigits',
    'Bug ID 位数',
  );
  validatePositiveInteger(
    errors,
    config?.knowledgeBase?.feedbackIdDigits,
    'knowledgeBase.feedbackIdDigits',
    '反馈 ID 位数',
  );
  validatePositiveInteger(errors, config?.dashboard?.cacheTtlMs, 'dashboard.cacheTtlMs', '概览缓存时间');
  validatePositiveInteger(errors, config?.dashboard?.staleDays, 'dashboard.staleDays', '无进展天数');
  validatePositiveInteger(errors, config?.dashboard?.dueSoonDays, 'dashboard.dueSoonDays', '即将到期天数');

  const aiPlanning = config?.aiPlanning || {};
  const codex = aiPlanning.codex || {};
  validatePositiveInteger(
    errors,
    codex.requestTimeoutMs,
    'aiPlanning.codex.requestTimeoutMs',
    'Codex 请求超时',
  );
  validatePositiveInteger(
    errors,
    codex.maxConcurrentRuns,
    'aiPlanning.codex.maxConcurrentRuns',
    'Codex 最大并发数',
  );
  const attachments = aiPlanning.attachments;
  if (attachments && typeof attachments === 'object') {
    for (const [field, label] of [
      ['maxFiles', '附件数量上限'],
      ['maxFileBytes', '单附件字节上限'],
      ['maxTotalBytes', '附件总字节上限'],
      ['maxExtractedCharsPerFile', '单附件提取字符上限'],
      ['maxExtractedCharsTotal', '附件提取总字符上限'],
      ['retentionHours', '附件临时目录保留小时数'],
    ]) {
      validatePositiveInteger(
        errors,
        attachments[field],
        `aiPlanning.attachments.${field}`,
        label,
      );
    }
    if (
      Number(attachments.maxTotalBytes) < Number(attachments.maxFileBytes)
    ) {
      errors.push({
        path: 'aiPlanning.attachments.maxTotalBytes',
        message: '附件总字节上限不能小于单附件字节上限',
      });
    }
    if (
      Number(attachments.maxExtractedCharsTotal)
      < Number(attachments.maxExtractedCharsPerFile)
    ) {
      errors.push({
        path: 'aiPlanning.attachments.maxExtractedCharsTotal',
        message: '附件提取总字符上限不能小于单附件提取字符上限',
      });
    }
  }

  const projects = Array.isArray(aiPlanning.projects) ? aiPlanning.projects : [];
  if (!Array.isArray(aiPlanning.projects)) {
    errors.push({ path: 'aiPlanning.projects', message: 'AI 项目配置必须是数组' });
  }

  if (aiPlanning.enabled === true) {
    requireText(errors, codex.model, 'aiPlanning.codex.model', 'Codex 模型名称');
    requireText(errors, codex.apiBaseUrl, 'aiPlanning.codex.apiBaseUrl', 'Codex API URL');
    requireText(errors, codex.apiKey, 'aiPlanning.codex.apiKey', 'Codex API Key');
    validateOptionalHttpUrl(
      errors,
      codex.apiBaseUrl,
      'aiPlanning.codex.apiBaseUrl',
      'Codex API URL',
      true,
    );
    if (projects.filter((project) => project?.enabled !== false).length === 0) {
      errors.push({ path: 'aiPlanning.projects', message: '启用 AI 计划时至少需要一个启用的项目' });
    }
  }

  validateAiProjects(errors, projects, options, aiPlanning.enabled === true);
  validateStatusGroups(errors, config?.dashboard?.statusGroups);
  validatePersonalSettings(errors, config?.bitable?.personalSettings);
  if (!Array.isArray(config?.bitable?.projectPermission?.fieldNames?.permissionUsers)) {
    errors.push({
      path: 'bitable.projectPermission.fieldNames.permissionUsers',
      message: '项目权限人员字段必须是字符串数组',
    });
  }
  validateLinks(errors, config?.bitable?.links);
  return errors;
}

export function collectConfigWarnings(config) {
  const warnings = [];
  const checks = [
    ['feishu.appId', config?.feishu?.appId, '尚未配置飞书 App ID'],
    ['feishu.appSecret', config?.feishu?.appSecret, '尚未配置飞书 App Secret'],
    ['knowledgeBase.spaceId', config?.knowledgeBase?.spaceId, '尚未配置知识库空间 ID'],
    ['bitable.projectBase.appToken', config?.bitable?.projectBase?.appToken, '尚未配置项目基础信息 App Token'],
    ['bitable.projectBase.tableId', config?.bitable?.projectBase?.tableId, '尚未配置项目基础信息 Table ID'],
    ['bitable.projectPermission.appToken', config?.bitable?.projectPermission?.appToken, '尚未配置项目权限 App Token'],
    ['bitable.projectPermission.tableId', config?.bitable?.projectPermission?.tableId, '尚未配置项目权限 Table ID'],
    ['bitable.toolPermission.appToken', config?.bitable?.toolPermission?.appToken, '尚未配置工具权限 App Token'],
  ];

  for (const [warningPath, value, message] of checks) {
    if (!String(value || '').trim()) {
      warnings.push({ path: warningPath, message });
    }
  }
  return warnings;
}

export function mergeConfigObjects(target, source) {
  if (!isPlainObject(source)) {
    return cloneValue(source);
  }

  const result = isPlainObject(target) ? target : {};
  for (const [key, value] of Object.entries(source)) {
    if (BLOCKED_OBJECT_KEYS.has(key)) {
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = mergeConfigObjects(result[key], value);
    } else {
      result[key] = cloneValue(value);
    }
  }
  return result;
}

function validateAiProjects(errors, projects, options, requireRunnableProjects) {
  if (!requireRunnableProjects) {
    return;
  }
  const projectIds = new Set();
  projects.forEach((project, projectIndex) => {
    const projectPath = `aiPlanning.projects.${projectIndex}`;
    const projectId = String(project?.projectId || '').trim();
    if (!projectId && project?.enabled !== false) {
      errors.push({ path: `${projectPath}.projectId`, message: '项目 ID 不能为空' });
    } else if (projectId && projectIds.has(projectId)) {
      errors.push({ path: `${projectPath}.projectId`, message: `项目 ID 不能重复：${projectId}` });
    } else if (projectId) {
      projectIds.add(projectId);
    }

    const roots = Array.isArray(project?.roots) ? project.roots : [];
    if (!Array.isArray(project?.roots)) {
      errors.push({ path: `${projectPath}.roots`, message: '代码目录配置必须是数组' });
      return;
    }
    if (project?.enabled === false) {
      return;
    }
    if (roots.length === 0) {
      errors.push({ path: `${projectPath}.roots`, message: '启用的项目至少需要一个代码目录' });
    }

    const rootIds = new Set();
    roots.forEach((root, rootIndex) => {
      const rootPath = `${projectPath}.roots.${rootIndex}`;
      const rootId = String(root?.id || '').trim();
      const configuredPath = String(root?.path || '').trim();
      if (!rootId) {
        errors.push({ path: `${rootPath}.id`, message: '目录 ID 不能为空' });
      } else if (rootIds.has(rootId)) {
        errors.push({ path: `${rootPath}.id`, message: `目录 ID 不能重复：${rootId}` });
      } else {
        rootIds.add(rootId);
      }

      if (!configuredPath) {
        errors.push({ path: `${rootPath}.path`, message: '代码目录不能为空' });
      } else if (!path.isAbsolute(configuredPath)) {
        errors.push({ path: `${rootPath}.path`, message: '代码目录必须是绝对路径' });
      } else if (options.checkDirectory && !options.checkDirectory(configuredPath)) {
        errors.push({ path: `${rootPath}.path`, message: '代码目录不存在或不是文件夹' });
      }

      const profile = String(root?.profile || 'auto').trim().toLowerCase();
      if (!['auto', 'web', 'unity', 'generic'].includes(profile)) {
        errors.push({ path: `${rootPath}.profile`, message: '项目类型只支持 auto、web、unity 或 generic' });
      }
    });
  });
}

function validateStatusGroups(errors, statusGroups) {
  if (!isPlainObject(statusGroups)) {
    errors.push({ path: 'dashboard.statusGroups', message: '状态分组必须是对象' });
    return;
  }

  for (const toolId of ['requirements', 'bugs', 'feedback']) {
    for (const groupId of ['waiting', 'processing', 'completed', 'blocked']) {
      if (!Array.isArray(statusGroups?.[toolId]?.[groupId])) {
        errors.push({
          path: `dashboard.statusGroups.${toolId}.${groupId}`,
          message: '状态分组必须是字符串数组',
        });
      }
    }
  }
}

function validateLinks(errors, links) {
  if (!Array.isArray(links)) {
    errors.push({ path: 'bitable.links', message: 'Bitable links 必须是 JSON 数组' });
  }
}

function validatePersonalSettings(errors, personalSettings) {
  const defaultTime = String(personalSettings?.defaultTime || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultTime)) {
    errors.push({
      path: 'bitable.personalSettings.defaultTime',
      message: '默认提醒时间必须使用 HH:mm 格式',
    });
  }
}

function validatePositiveInteger(errors, value, fieldPath, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    errors.push({ path: fieldPath, message: `${label}必须是正整数` });
  }
}

function validateOptionalHttpUrl(errors, value, fieldPath, label, required = false) {
  const text = String(value || '').trim();
  if (!text) {
    if (required) {
      return;
    }
    return;
  }

  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    errors.push({ path: fieldPath, message: `${label}必须是有效的 HTTP 或 HTTPS 地址` });
  }
}

function validateOptionalHttpsUrl(errors, value, fieldPath, label) {
  const text = String(value || '').trim();
  if (!text) {
    return;
  }

  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:') {
      throw new Error('HTTPS required');
    }
  } catch {
    errors.push({ path: fieldPath, message: `${label}必须是有效的 HTTPS 地址` });
  }
}

function requireText(errors, value, fieldPath, label) {
  if (!String(value || '').trim()) {
    errors.push({ path: fieldPath, message: `${label}不能为空` });
  }
}

function applySecretChange(target, currentConfig, secretPath, change) {
  const action = String(change?.action || 'keep');
  if (action === 'keep') {
    setPathValue(target, secretPath, String(getPathValue(currentConfig, secretPath) || ''));
    return;
  }
  if (action === 'clear') {
    setPathValue(target, secretPath, '');
    return;
  }
  if (action === 'replace') {
    const value = String(change?.value || '').trim();
    if (!value) {
      throw new TypeError(`${secretPath} 的替换值不能为空`);
    }
    setPathValue(target, secretPath, value);
    return;
  }
  throw new TypeError(`${secretPath} 的敏感字段操作无效`);
}

function getPathValue(value, fieldPath) {
  return fieldPath.split('.').reduce((current, segment) => current?.[segment], value);
}

function setPathValue(value, fieldPath, nextValue) {
  const segments = fieldPath.split('.');
  let current = value;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = nextValue;
      return;
    }
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  });
}

function deletePathValue(value, fieldPath) {
  const segments = fieldPath.split('.');
  let current = value;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = current?.[segments[index]];
    if (!isPlainObject(current)) {
      return;
    }
  }
  if (isPlainObject(current)) {
    delete current[segments.at(-1)];
  }
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !BLOCKED_OBJECT_KEYS.has(key))
        .map(([key, item]) => [key, cloneValue(item)]),
    );
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
