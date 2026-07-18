import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from './normalizeConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '../..');
export const isProduction = process.env.NODE_ENV === 'production';
export const clientDir = isProduction ? path.join(rootDir, 'client') : path.join(rootDir, 'Publish/client');
export const runtimeConfig = loadRuntimeConfig();
export const currentAppVersion = readCurrentAppVersion();
export function loadRuntimeConfig() {
  const configPath = findConfigPath();
  const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  return normalizeConfig(parsedConfig);
}

export function readCurrentAppVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return String(packageJson.version || '0.0.0').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function findConfigPath() {
  const configPaths = isProduction
    ? [path.join(rootDir, 'config.json'), path.join(rootDir, 'Publish/config.json'), path.join(rootDir, 'config/config.json')]
    : [path.join(rootDir, 'config/config.json'), path.join(rootDir, 'Publish/config.json')];

  const configPath = configPaths.find((item) => fs.existsSync(item));

  if (!configPath) {
    throw new Error('缺少配置文件，请创建 config/config.json');
  }

  return configPath;
}

export function validateProjectBaseConfig() {
  const projectBase = runtimeConfig.bitable.projectBase;
  if (!projectBase.appToken || !projectBase.tableId) {
    throw new Error('缺少项目基础信息配置');
  }
}

export function validateProjectPermissionConfig() {
  const projectPermission = runtimeConfig.bitable.projectPermission;
  if (!projectPermission.appToken || !projectPermission.tableId) {
    throw new Error('缺少项目权限配置');
  }
}

export function validateToolPermissionConfig() {
  const toolPermission = runtimeConfig.bitable.toolPermission;
  if (!toolPermission.appToken) {
    throw new Error('缺少工具权限配置');
  }
}

export function validateKnowledgeBaseConfig() {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  if (!knowledgeBase.spaceId) {
    throw new Error('缺少知识库空间配置');
  }
}

export function blockDirectConfigAccess(request, response, next) {
  const requestPath = request.path.replaceAll('\\', '/');
  const blockedPaths = new Set(['/config.json', '/Publish/config.json']);

  if (blockedPaths.has(requestPath) || requestPath.startsWith('/config/')) {
    response.status(404).send('Not found');
    return;
  }

  next();
}
