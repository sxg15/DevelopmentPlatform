import fs from 'node:fs';
import path from 'node:path';

export function resolveAiProjectWorkspace(aiPlanningConfig, projectId) {
  const projectConfig = (aiPlanningConfig?.projects || [])
    .find((item) => item.enabled && item.projectId === String(projectId || '').trim());
  if (!projectConfig) {
    throw createWorkspaceError('当前项目未配置 AI 代码目录', 404);
  }

  const roots = projectConfig.roots.map((root) => resolveRoot(root));
  if (roots.length === 0) {
    throw createWorkspaceError('当前项目没有可读取的代码目录', 503);
  }

  return {
    projectId: projectConfig.projectId,
    preludePrompt: String(projectConfig.preludePrompt || '').trim(),
    cwd: roots[0].path,
    roots,
  };
}

function resolveRoot(root) {
  if (!path.isAbsolute(root.path)) {
    throw createWorkspaceError(`AI 代码目录必须是绝对路径：${root.id}`, 500);
  }

  let resolvedPath;
  try {
    resolvedPath = fs.realpathSync.native(root.path);
  } catch {
    throw createWorkspaceError(`AI 代码目录不存在或无法读取：${root.id}`, 503);
  }

  let stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    throw createWorkspaceError(`AI 代码目录不存在或无法读取：${root.id}`, 503);
  }
  if (!stats.isDirectory()) {
    throw createWorkspaceError(`AI 代码目录不是文件夹：${root.id}`, 500);
  }

  return {
    id: root.id,
    path: resolvedPath,
    profile: root.profile,
  };
}

function createWorkspaceError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
