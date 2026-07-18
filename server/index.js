import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { buildUpdateResponse } from '../shared/updateManifest.js';
import { countWaitingAssignedWorkItems } from '../shared/workItemRealtimeUtils.js';
import {
  DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD,
  canManageWorkItemAssignees,
  getRoleGrantedWorkItemToolIds,
  supportsUnassignedWorkItemRouting,
  validateWorkItemAssignmentChoice,
} from '../shared/workItemAssignmentUtils.js';
import {
  buildRequirementSubmissionAttachmentChangeText,
  getSubmissionAttachmentToken,
  isRequirementSubmissionAttachmentRequired,
} from '../shared/requirementSubmissionAttachmentUtils.js';
import {
  PROJECT_OVERVIEW_TOOL_ORDER,
  buildProjectOverviewData,
  normalizeProjectOverviewConfig,
} from '../shared/projectOverviewUtils.js';
import {
  PROJECT_TOOL_DEFINITIONS,
  REQUIREMENT_PRIORITIES,
  getWorkItemToolDefinition,
} from '../shared/workItemDefinitions.js';
import {
  blockDirectConfigAccess,
  clientDir,
  currentAppVersion,
  isProduction,
  rootDir,
  runtimeConfig,
  validateKnowledgeBaseConfig,
  validateProjectBaseConfig,
  validateProjectPermissionConfig,
  validateToolPermissionConfig,
} from './config/runtimeConfig.js';
import { getLocalUrls } from './runtime/network.js';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  getSession,
  getSessionId,
} from './runtime/sessionStore.js';
import { createWorkItemRealtimeHub } from './runtime/workItemRealtime.js';
import { fetchUpdateManifest } from './services/updateService.js';
import {
  exchangeCodeForAccessToken,
  fetchFeishuJson,
  fetchFeishuUser,
  getTenantAccessToken,
  readJson,
} from './integrations/feishuClient.js';
import {
  createBitableRecord,
  deleteBitableRecord,
  ensureBitableTextField,
  ensureCachedBitableTextField,
  fetchBitableRecords,
  fetchCachedBitableFields,
  fetchCachedBitableRecords,
  fetchCachedBitableTables,
  formatFeishuApiError,
  updateBitableRecordFields,
} from './integrations/bitableClient.js';
import { getCachedValue } from './runtime/asyncCache.js';

const host = runtimeConfig.server.host;
const port = runtimeConfig.server.port;
const appId = runtimeConfig.feishu.appId;
const appSecret = runtimeConfig.feishu.appSecret;
let peopleDirectoryCache = null;

const MAX_SUBMIT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_SUBMIT_ATTACHMENT_COUNT = 5;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_FALLBACK_BYTES = 256 * 1024 * 1024;
const BITABLE_COPY_RETRY_DELAYS_MS = [1000, 2000, 3000, 5000, 8000];
const PROJECT_DATA_CACHE_TTL_MS = 60 * 1000;
const STRUCTURE_CACHE_TTL_MS = 5 * 60 * 1000;
const LONG_STRUCTURE_CACHE_TTL_MS = 10 * 60 * 1000;
const SUPER_ADMIN_DEPARTMENT = '超级管理员';
const WORK_ITEM_TOOL_IDS = new Set(['requirements', 'bugs', 'feedback']);
const PERMISSION_TOOL_DEFINITIONS = PROJECT_TOOL_DEFINITIONS.filter((tool) => tool.id !== 'overview');
const resolvedBitableTableConfigCache = new Map();
const wikiTitleCache = new Map();
const wikiChildrenCache = new Map();
const workItemNodeCache = new Map();
const workItemTableContextCache = new Map();
const projectOverviewCache = new Map();
const {
  publishWorkItemUpdated,
  subscribe: subscribeToWorkItemUpdates,
} = createWorkItemRealtimeHub({
  onPublish: ({ projectId }) => invalidateProjectOverviewCache(projectId),
});

const app = express();

app.use(express.json({ limit: '128kb' }));
app.use(blockDirectConfigAccess);

app.get('/api/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/api/config', (_request, response) => {
  response.json({
    appId,
    configured: Boolean(appId && appSecret),
    debugUser: {
      name: runtimeConfig.debug.userName,
      openId: runtimeConfig.debug.openId,
    },
  });
});

app.get('/api/updates', async (request, response) => {
  try {
    if (!getSession(request)) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const manifestUrl = runtimeConfig.updates.manifestUrl;
    if (!manifestUrl) {
      response.json({
        enabled: false,
        currentVersion: currentAppVersion,
        latestVersion: currentAppVersion,
        updateAvailable: false,
        releases: [],
      });
      return;
    }

    const manifest = await fetchUpdateManifest(manifestUrl);
    response.json(buildUpdateResponse(manifest, currentAppVersion, String(request.query.since || '').trim()));
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取更新日志失败';
    const status = message.includes('HTTPS') || message.includes('格式') ? 500 : 502;
    response.status(status).json({ message });
  }
});

app.get('/api/me', async (request, response) => {
  try {
    const session = getSession(request);

    if (!session) {
      response.status(401).json({ message: '未登录' });
      return;
    }

    const token = await getTenantAccessToken();
    await ensureUserHasPlatformAccess(token, session.user);
    response.json({ user: session.user });
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取登录状态失败';
    const status = message.includes('没有权限') ? 403 : message.includes('缺少') ? 500 : 502;
    response.status(status).json({ message });
  }
});

app.post('/api/auth/debug', async (_request, response) => {
  try {
    const user = {
      name: runtimeConfig.debug.userName,
      avatarUrl: '',
      openId: runtimeConfig.debug.openId,
      unionId: '',
      userId: '',
      email: '',
    };
    const token = await getTenantAccessToken();
    await ensureUserHasPlatformAccess(token, user);
    const sessionId = createSession(user);

    response.setHeader('Set-Cookie', buildSessionCookie(sessionId));
    response.json({ user });
  } catch (error) {
    const message = error instanceof Error ? error.message : '调试登录失败';
    const status = message.includes('没有权限') ? 403 : message.includes('缺少') ? 500 : 502;
    response.status(status).json({ message });
  }
});

app.post('/api/auth/logout', (request, response) => {
  const sessionId = getSessionId(request);
  deleteSession(sessionId);

  response.setHeader('Set-Cookie', buildClearSessionCookie());
  response.json({ ok: true });
});

app.get('/api/projects', async (request, response) => {
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const token = await getTenantAccessToken();
    const { projectRecords, permissionRecords, toolPermissionRecords } = await fetchProjectAccessRecords(token);
    const permissionContext = buildPermissionContext(permissionRecords, toolPermissionRecords, session.user);
    if (!permissionContext.hasAnyProject) {
      response.status(403).json({ message: '没有权限请联系管理员' });
      return;
    }

    const projects = normalizeProjects(projectRecords)
      .filter((project) => permissionContext.projectsById.has(project.projectId))
      .map((project) => attachProjectAccess(project, permissionContext.projectsById.get(project.projectId)))
      .sort(compareProjects);

    response.json({ projects });
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取项目列表失败';
    const status = message.includes('没有权限') ? 403 : message.includes('缺少') ? 500 : 502;
    response.status(status).json({ message });
  }
});

app.get('/api/projects/related-counts', async (request, response) => {
  await handleRelatedWorkItemCounts(request, response);
});

app.get('/api/projects/:projectId/overview', async (request, response) => {
  await handleProjectOverview(request, response);
});

app.get('/api/realtime/stream', async (request, response) => {
  await handleRealtimeStream(request, response);
});

app.get('/api/projects/:recordId/icon', async (request, response) => {
  try {
    validateProjectBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const recordId = String(request.params.recordId || '').trim();
    const fileToken = String(request.query.fileToken || '').trim();
    const tmpUrl = String(request.query.tmpUrl || '').trim();
    const downloadUrlFromRecord = String(request.query.downloadUrl || '').trim();

    if (!recordId || !fileToken) {
      response.status(400).json({ message: '缺少项目图标参数' });
      return;
    }

    const token = await getTenantAccessToken();
    const downloadUrl = downloadUrlFromRecord || (tmpUrl ? await getDownloadUrlFromRecordTmpUrl(token, tmpUrl, fileToken) : '') || (await getMediaDownloadUrl(token, fileToken));

    if (!downloadUrl) {
      response.status(404).json({ message: '项目图标不存在' });
      return;
    }

    const iconResponse = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!iconResponse.ok) {
      response.status(502).json({ message: '下载项目图标失败' });
      return;
    }

    response.setHeader('Cache-Control', 'private, max-age=600');
    response.setHeader('Content-Type', iconResponse.headers.get('content-type') || 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    const buffer = Buffer.from(await iconResponse.arrayBuffer());
    response.send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取项目图标失败';
    const status = message.includes('缺少') ? 500 : 502;
    response.status(status).json({ message });
  }
});

app.post('/api/projects/:projectId/requirements/ensure', async (request, response) => {
  await handleWorkItemEnsure(request, response, 'requirements');
});

app.post('/api/projects/:projectId/bugs/ensure', async (request, response) => {
  await handleWorkItemEnsure(request, response, 'bugs');
});

app.post('/api/projects/:projectId/feedback/ensure', async (request, response) => {
  await handleWorkItemEnsure(request, response, 'feedback');
});

app.post('/api/projects/:projectId/requirements', async (request, response) => {
  await handleWorkItemCreate(request, response, 'requirements');
});

app.post('/api/projects/:projectId/bugs', async (request, response) => {
  await handleWorkItemCreate(request, response, 'bugs');
});

app.post('/api/projects/:projectId/feedback', async (request, response) => {
  await handleWorkItemCreate(request, response, 'feedback');
});

app.put('/api/projects/:projectId/requirements/:recordId', async (request, response) => {
  await handleWorkItemUpdate(request, response, 'requirements');
});

app.put('/api/projects/:projectId/bugs/:recordId', async (request, response) => {
  await handleWorkItemUpdate(request, response, 'bugs');
});

app.put('/api/projects/:projectId/feedback/:recordId', async (request, response) => {
  await handleWorkItemUpdate(request, response, 'feedback');
});

app.get('/api/projects/:projectId/requirements/:recordId', async (request, response) => {
  await handleWorkItemRead(request, response, 'requirements');
});

app.get('/api/projects/:projectId/bugs/:recordId', async (request, response) => {
  await handleWorkItemRead(request, response, 'bugs');
});

app.get('/api/projects/:projectId/feedback/:recordId', async (request, response) => {
  await handleWorkItemRead(request, response, 'feedback');
});

app.get('/api/projects/:projectId/requirements/attachments/:fileToken', async (request, response) => {
  await handleWorkItemAttachment(request, response, 'requirements');
});

app.get('/api/projects/:projectId/bugs/attachments/:fileToken', async (request, response) => {
  await handleWorkItemAttachment(request, response, 'bugs');
});

app.get('/api/projects/:projectId/feedback/attachments/:fileToken', async (request, response) => {
  await handleWorkItemAttachment(request, response, 'feedback');
});

app.post('/api/projects/:projectId/requirements/:recordId/submission-attachments', async (request, response) => {
  await handleRequirementSubmissionAttachmentsUpdate(request, response);
});

app.post('/api/projects/:projectId/requirements/:recordId/comments', async (request, response) => {
  await handleWorkItemCommentCreate(request, response, 'requirements');
});

app.post('/api/projects/:projectId/bugs/:recordId/comments', async (request, response) => {
  await handleWorkItemCommentCreate(request, response, 'bugs');
});

app.post('/api/projects/:projectId/feedback/:recordId/comments', async (request, response) => {
  await handleWorkItemCommentCreate(request, response, 'feedback');
});

app.delete('/api/projects/:projectId/requirements/:recordId/comments/:commentId', async (request, response) => {
  await handleWorkItemCommentDelete(request, response, 'requirements');
});

app.delete('/api/projects/:projectId/bugs/:recordId/comments/:commentId', async (request, response) => {
  await handleWorkItemCommentDelete(request, response, 'bugs');
});

app.delete('/api/projects/:projectId/feedback/:recordId/comments/:commentId', async (request, response) => {
  await handleWorkItemCommentDelete(request, response, 'feedback');
});

app.post('/api/projects/:projectId/requirements/:recordId/status', async (request, response) => {
  await handleWorkItemStatusUpdate(request, response, 'requirements');
});

app.post('/api/projects/:projectId/bugs/:recordId/status', async (request, response) => {
  await handleWorkItemStatusUpdate(request, response, 'bugs');
});

app.post('/api/projects/:projectId/feedback/:recordId/status', async (request, response) => {
  await handleWorkItemStatusUpdate(request, response, 'feedback');
});

app.post('/api/projects/:projectId/requirements/:recordId/assignees', async (request, response) => {
  await handleWorkItemAssigneeChange(request, response, 'requirements');
});

app.post('/api/projects/:projectId/bugs/:recordId/assignees', async (request, response) => {
  await handleWorkItemAssigneeChange(request, response, 'bugs');
});

app.post('/api/projects/:projectId/feedback/:recordId/assignees', async (request, response) => {
  await handleWorkItemAssigneeChange(request, response, 'feedback');
});

app.delete('/api/projects/:projectId/requirements/:recordId', async (request, response) => {
  await handleWorkItemDelete(request, response, 'requirements');
});

app.delete('/api/projects/:projectId/bugs/:recordId', async (request, response) => {
  await handleWorkItemDelete(request, response, 'bugs');
});

app.delete('/api/projects/:projectId/feedback/:recordId', async (request, response) => {
  await handleWorkItemDelete(request, response, 'feedback');
});

async function handleWorkItemEnsure(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    if (!projectId) {
      response.status(400).json({ message: '缺少项目ID' });
      return;
    }

    const token = await getTenantAccessToken();
    const { project, projectAccess } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);

    const result = await ensureProjectWorkItemBitable(token, project, session.user, toolConfig);
    result.mentionableUsers = projectAccess.mentionableUsersByTool[toolId] || [];
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : `准备${toolConfig.listLabel}失败`;
    const status = message.includes('缺少') ? 500 : message.includes('权限') ? 403 : message.includes('不存在') ? 404 : 502;
    response.status(status).json({ message, result: error?.publicDetails || null });
  }
}

async function handleWorkItemRead(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const recordId = String(request.params.recordId || '').trim();
    if (!projectId || !recordId) {
      response.status(400).json({ message: `缺少${toolConfig.itemLabel}信息` });
      return;
    }

    const token = await getTenantAccessToken();
    const { project } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const record = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    const item = normalizeWorkItemRecords([record], session.user, toolConfig)[0] || null;

    if (!item) {
      response.status(404).json({ message: toolConfig.missingRecordText });
      return;
    }

    response.json({
      item,
      requirement: toolId === 'requirements' ? item : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `获取${toolConfig.itemLabel}失败`;
    const status = message.includes('缺少') ? 500 : message.includes('权限') ? 403 : message.includes('不存在') ? 404 : 502;
    response.status(status).json({ message });
  }
}

async function handleRelatedWorkItemCounts(request, response) {
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateToolPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const requestedProjectId = String(request.query.projectId || '').trim();
    const token = await getTenantAccessToken();
    const accessibleProjects = await getAccessibleProjectsForUser(token, session.user);
    const projects = requestedProjectId
      ? accessibleProjects.filter((project) => project.projectId === requestedProjectId)
      : accessibleProjects;

    if (requestedProjectId && projects.length === 0) {
      response.status(403).json({ message: '没有该项目权限' });
      return;
    }

    const entries = await mapWithConcurrency(projects, 4, async (project) => {
      const allowedToolIds = new Set((project.allowedTools || []).map((tool) => tool.id));
      const requirements = allowedToolIds.has('requirements')
        ? await getProjectWaitingWorkItemCount(token, project, session.user, getWorkItemToolConfig('requirements'))
        : 0;
      const bugs = allowedToolIds.has('bugs')
        ? await getProjectWaitingWorkItemCount(token, project, session.user, getWorkItemToolConfig('bugs'))
        : 0;

      return [project.projectId, { requirements, bugs }];
    });

    response.json({
      counts: Object.fromEntries(entries),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取项目待处理数量失败';
    const status = message.includes('缺少') ? 500 : message.includes('权限') ? 403 : 502;
    response.status(status).json({ message });
  }
}

async function handleProjectOverview(request, response) {
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateToolPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const scope = String(request.query.scope || 'project').trim();
    const trendDays = Number(request.query.trendDays || 30);
    if (!projectId) {
      response.status(400).json({ message: '缺少项目ID' });
      return;
    }
    if (!['project', 'mine'].includes(scope)) {
      response.status(400).json({ message: '总览范围不正确' });
      return;
    }
    if (![14, 30, 90].includes(trendDays)) {
      response.status(400).json({ message: '趋势周期只支持14天、30天或90天' });
      return;
    }

    const token = await getTenantAccessToken();
    const { project, projectAccess } = await getAuthorizedProjectAccess(
      token,
      projectId,
      session.user,
      'overview',
    );
    const allowedToolIds = PROJECT_OVERVIEW_TOOL_ORDER.filter(
      (toolId) => projectAccess.allowedToolIds.has(toolId),
    );
    const cacheKey = buildProjectOverviewCacheKey({
      projectId: project.projectId,
      allowedToolIds,
      scope,
      trendDays,
      user: session.user,
    });
    const result = await getCachedValue(
      projectOverviewCache,
      cacheKey,
      runtimeConfig.dashboard.cacheTtlMs,
      async () => {
        const toolResults = await mapWithConcurrency(allowedToolIds, 3, async (toolId) => {
          const toolConfig = getWorkItemToolConfig(toolId);
          try {
            const items = await fetchExistingProjectOverviewItems(
              token,
              project,
              session.user,
              toolConfig,
            );
            return { toolId, items, unavailable: null };
          } catch (error) {
            const message = error instanceof Error ? error.message : `读取${toolConfig.listLabel}失败`;
            return {
              toolId,
              items: null,
              unavailable: {
                toolId,
                label: toolConfig.listLabel,
                reason: isMissingWorkItemListError(error, toolConfig) ? 'notConfigured' : 'unavailable',
                message,
              },
            };
          }
        });
        const toolItems = Object.fromEntries(
          toolResults
            .filter((item) => Array.isArray(item.items))
            .map((item) => [item.toolId, item.items]),
        );

        return buildProjectOverviewData({
          toolItems,
          currentUser: session.user,
          scope,
          trendDays,
          config: runtimeConfig.dashboard,
          unavailableTools: toolResults.map((item) => item.unavailable).filter(Boolean),
        });
      },
    );

    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取项目总览失败';
    const status = message.includes('缺少')
      ? 500
      : message.includes('权限')
        ? 403
        : message.includes('不存在')
          ? 404
          : 502;
    response.status(status).json({ message });
  }
}

async function fetchExistingProjectOverviewItems(token, project, currentUser, toolConfig) {
  const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
  const { appToken, tableId } = await getCachedWorkItemTableContext(token, node, toolConfig);
  const records = await fetchBitableRecords(token, {
    appToken,
    tableId,
    viewId: '',
    fieldNames: {},
  });
  return normalizeWorkItemRecords(records, currentUser, toolConfig);
}

function buildProjectOverviewCacheKey({
  projectId,
  allowedToolIds,
  scope,
  trendDays,
  user,
}) {
  const userKey = [...buildUserKeySet(user)].sort().join(',');
  return [
    String(projectId || '').trim(),
    [...allowedToolIds].sort().join(','),
    scope,
    trendDays,
    userKey,
  ].join('|');
}

function invalidateProjectOverviewCache(projectId) {
  const prefix = `${String(projectId || '').trim()}|`;
  for (const key of projectOverviewCache.keys()) {
    if (key.startsWith(prefix)) {
      projectOverviewCache.delete(key);
    }
  }
}

async function handleRealtimeStream(request, response) {
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateToolPermissionConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const token = await getTenantAccessToken();
    const projects = await getAccessibleProjectsForUser(token, session.user);
    const allowedToolsByProject = new Map(
      projects.map((project) => [project.projectId, new Set((project.allowedTools || []).map((tool) => tool.id))]),
    );
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    const unsubscribe = subscribeToWorkItemUpdates(response, allowedToolsByProject);
    request.on('close', unsubscribe);
  } catch (error) {
    const message = error instanceof Error ? error.message : '建立实时连接失败';
    response.status(message.includes('权限') ? 403 : 502).json({ message });
  }
}

async function handleWorkItemCreate(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    if (!projectId) {
      response.status(400).json({ message: '缺少项目ID' });
      return;
    }

    const submitPayload = await readWorkItemCreatePayload(request);
    const title = String(submitPayload.fields?.title || '').trim();
    const description = String(submitPayload.fields?.description || '').trim();
    const priority = String(submitPayload.fields?.priority || '').trim();
    const assignees = normalizeMentionedUsers(submitPayload.fields?.assignees || []);
    const needsAssigneeAssignment = supportsUnassignedWorkItemRouting(toolId)
      && parseBooleanValue(submitPayload.fields?.needsAssigneeAssignment);
    const requiresSubmissionAttachment = toolId === 'requirements'
      && parseBooleanValue(submitPayload.fields?.requiresSubmissionAttachment);
    const expectedDays = normalizeNumberValue(submitPayload.fields?.expectedDays);
    const contactInfo = toolConfig.toolId === 'feedback'
      ? normalizeFeedbackContactInfo(submitPayload.fields?.contactInfo, session.user)
      : null;
    const attachments = submitPayload.files;

    if (!title) {
      response.status(400).json({ message: `${toolConfig.itemLabel}标题不能为空` });
      return;
    }

    if (title.length > 200) {
      response.status(400).json({ message: `${toolConfig.itemLabel}标题不能超过200字` });
      return;
    }

    if (description.length > 5000) {
      response.status(400).json({ message: `${toolConfig.itemLabel}描述不能超过5000字` });
      return;
    }

    if (expectedDays !== null && expectedDays < 0) {
      response.status(400).json({ message: '期望时限不能小于0' });
      return;
    }

    const assignmentError = validateWorkItemAssignmentChoice({
      toolId,
      assignees,
      needsAssigneeAssignment,
    });
    if (assignmentError) {
      response.status(400).json({ message: assignmentError });
      return;
    }

    const token = await getTenantAccessToken();
    const { project, projectAccess } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);
    if (needsAssigneeAssignment && projectAccess.developmentSuperAdmins.length === 0) {
      response.status(400).json({ message: '项目权限表未配置研发超级管理员，暂时无法提交未指定处理人的工作项' });
      return;
    }
    await ensureProjectWorkItemBitable(token, project, session.user, toolConfig);
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await getCachedWorkItemTableContext(token, node, toolConfig);
    let [fields, records] = await Promise.all([
      ensureCachedBitableTextField(token, appToken, tableId, toolConfig.fieldNames.comments),
      fetchBitableRecords(token, {
        appToken,
        tableId,
        viewId: '',
        fieldNames: {},
      }),
    ]);
    validateWorkItemTableSchema(fields, toolConfig);

    const uploadedAttachments = attachments.length > 0
      ? await uploadWorkItemSubmitAttachments(token, appToken, tableId, fields, toolConfig, attachments)
      : [];
    if (uploadedAttachments.length > 0) {
      fields = await fetchCachedBitableFields(token, appToken, tableId);
    }

    const allowedAssignees = filterMentionedUsersByCandidates(assignees, projectAccess.mentionableUsersByTool[toolId] || []);
    if (allowedAssignees.length !== assignees.length) {
      response.status(400).json({ message: '处理人员不在可选范围内' });
      return;
    }
    const createdRecord = await createWorkItemRecord(token, {
      appToken,
      tableId,
      records,
      fields,
      toolConfig,
      user: session.user,
      payload: {
        title,
        description,
        priority,
        assignees: allowedAssignees,
        requiresSubmissionAttachment,
        expectedDays,
        contactInfo,
        attachments: uploadedAttachments,
      },
    });

    const nextRecords = await fetchBitableRecords(token, {
      appToken,
      tableId,
      viewId: '',
      fieldNames: {},
    });
    const items = normalizeWorkItemRecords(nextRecords, session.user, toolConfig);
    const createdRecordId = String(createdRecord?.record_id || createdRecord?.recordId || createdRecord?.id || '');
    const item = items.find((candidate) => candidate.recordId === createdRecordId) || normalizeWorkItemRecords([createdRecord], session.user, toolConfig)[0] || null;
    const notificationResults = item
      ? await notifyWorkItemCreationRecipients(
          token,
          needsAssigneeAssignment ? projectAccess.developmentSuperAdmins : allowedAssignees,
          {
            project,
            item,
            submitter: session.user,
            request,
            toolConfig,
            needsAssigneeAssignment,
          },
        )
      : [];
    if (createdRecordId) {
      publishWorkItemUpdated({
        projectId: project.projectId,
        toolId,
        recordId: createdRecordId,
      });
    }

    response.json({
      item,
      requirement: toolId === 'requirements' ? item : null,
      items,
      [toolConfig.itemsKey]: items,
      requirements: toolId === 'requirements' ? items : [],
      fields: normalizeBitableFields(fields),
      priorityColors: normalizePriorityColors(fields, toolConfig),
      statusOptions: normalizeWorkItemStatusOptions(fields, toolConfig),
      mentionableUsers: projectAccess.mentionableUsersByTool[toolId] || [],
      editableFields: normalizeEditableWorkItemFields(fields, toolConfig),
      notificationResults,
      assignmentEscalated: needsAssigneeAssignment,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `提交${toolConfig.itemLabel}失败`;
    const status = message.includes('缺少') ? 500 : message.includes('权限') ? 403 : message.includes('不存在') ? 404 : 502;
    response.status(status).json({ message });
  }
}

async function handleWorkItemUpdate(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateToolPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const recordId = String(request.params.recordId || '').trim();
    if (!projectId || !recordId) {
      response.status(400).json({ message: `缺少${toolConfig.itemLabel}信息` });
      return;
    }

    const editPayload = await readWorkItemUpdatePayload(request);
    const selectedFields = parseStringArrayValue(editPayload.fields?.selectedFields);
    const updates = parseJsonObjectValue(editPayload.fields?.updates);
    const existingAttachments = parseJsonObjectValue(editPayload.fields?.existingAttachments);
    const notifyUsers = normalizeMentionedUsers(parseJsonArrayValue(editPayload.fields?.notifyUsers));
    const shouldNotify = parseBooleanValue(editPayload.fields?.notifyRelated);

    if (selectedFields.length === 0) {
      response.status(400).json({ message: '请选择要修改的字段' });
      return;
    }

    const token = await getTenantAccessToken();
    const { project, projectAccess } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const [fields, record] = await Promise.all([
      fetchCachedBitableFields(token, appToken, tableId),
      fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig),
    ]);

    const source = record.fields || {};
    const proposers = toolConfig.fieldNames.proposer ? normalizeUserListValue(source[toolConfig.fieldNames.proposer]) : [];
    const isSubmitter = proposers.some((proposer) => isSameUser(proposer, session.user));
    if (!projectAccess.isSuperAdmin && !isSubmitter) {
      response.status(403).json({ message: `只有提交者或超级管理员可以编辑${toolConfig.itemLabel}` });
      return;
    }

    const editableFields = normalizeEditableWorkItemFields(fields, toolConfig);
    const editableFieldByName = new Map(editableFields.map((field) => [field.fieldName, field]));
    const selectedEditableFields = selectedFields.map((fieldName) => {
      const field = editableFieldByName.get(fieldName);
      if (!field) {
        throw new Error(`字段不可编辑：${fieldName}`);
      }

      return field;
    });

    const uploadedAttachmentsByField = await uploadWorkItemEditAttachments(token, appToken, tableId, selectedEditableFields, editPayload.files);
    const updateFields = buildWorkItemUpdateFields({
      selectedFields: selectedEditableFields,
      updates,
      existingAttachments,
      uploadedAttachmentsByField,
      toolConfig,
    });
    normalizeFeedbackContactInfoUpdate(updateFields, toolConfig, source, session.user);
    validateWorkItemUpdateFields(updateFields, toolConfig);

    if (Object.keys(updateFields).length === 0) {
      response.status(400).json({ message: '没有可保存的修改' });
      return;
    }

    await updateBitableRecordFields(token, appToken, tableId, recordId, updateFields);
    const updatedRecord = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    const normalizedItem = normalizeWorkItemRecords([updatedRecord], session.user, toolConfig)[0] || null;
    publishWorkItemUpdated({
      projectId: project.projectId,
      toolId,
      recordId,
    });
    const allowedNotifyUsers = filterMentionedUsersByCandidates(notifyUsers, projectAccess.mentionableUsersByTool[toolId] || []);
    const notificationResults = shouldNotify && allowedNotifyUsers.length > 0
      ? await notifyWorkItemEditRecipients(token, allowedNotifyUsers, {
          project,
          item: normalizedItem,
          editor: session.user,
          changedFields: selectedEditableFields.map((field) => field.fieldName),
          request,
          toolConfig,
        })
      : [];

    response.json({
      item: normalizedItem,
      requirement: toolId === 'requirements' ? normalizedItem : null,
      fields: normalizeBitableFields(fields),
      editableFields,
      priorityColors: normalizePriorityColors(fields, toolConfig),
      statusOptions: normalizeWorkItemStatusOptions(fields, toolConfig),
      mentionableUsers: projectAccess.mentionableUsersByTool[toolId] || [],
      notificationResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `编辑${toolConfig.itemLabel}失败`;
    const status = message.includes('缺少')
      ? 500
      : message.includes('权限') || message.includes('只有') || message.includes('不可编辑')
        ? 403
        : message.includes('不存在')
          ? 404
          : message.includes('不能为空') || message.includes('不能超过') || message.includes('请选择') || message.includes('没有可保存')
            ? 400
            : 502;
    response.status(status).json({ message });
  }
}

async function handleWorkItemDelete(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const recordId = String(request.params.recordId || '').trim();
    if (!projectId || !recordId) {
      response.status(400).json({ message: `缺少${toolConfig.itemLabel}信息` });
      return;
    }

    const token = await getTenantAccessToken();
    const { project, projectAccess } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);
    if (!projectAccess.isSuperAdmin) {
      response.status(403).json({ message: `只有超级管理员可以删除${toolConfig.itemLabel}` });
      return;
    }

    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    await deleteBitableRecord(token, appToken, tableId, recordId);

    const nextRecords = await fetchBitableRecords(token, {
      appToken,
      tableId,
      viewId: '',
      fieldNames: {},
    });
    const fields = await fetchCachedBitableFields(token, appToken, tableId);
    const items = normalizeWorkItemRecords(nextRecords, session.user, toolConfig);
    publishWorkItemUpdated({
      projectId: project.projectId,
      toolId,
      recordId,
    });

    response.json({
      deletedRecordId: recordId,
      items,
      [toolConfig.itemsKey]: items,
      requirements: toolId === 'requirements' ? items : [],
      fields: normalizeBitableFields(fields),
      priorityColors: normalizePriorityColors(fields, toolConfig),
      statusOptions: normalizeWorkItemStatusOptions(fields, toolConfig),
      mentionableUsers: projectAccess.mentionableUsersByTool[toolId] || [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `删除${toolConfig.itemLabel}失败`;
    const status = message.includes('缺少') ? 500 : message.includes('权限') || message.includes('超级管理员') ? 403 : message.includes('不存在') ? 404 : 502;
    response.status(status).json({ message });
  }
}

async function handleWorkItemAttachment(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const fileToken = String(request.params.fileToken || '').trim();
    if (!projectId || !fileToken) {
      response.status(400).json({ message: '缺少附件信息' });
      return;
    }

    const token = await getTenantAccessToken();
    const { project } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);

    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const downloadUrl = await getMediaDownloadUrl(token, fileToken, tableId);
    if (!downloadUrl) {
      response.status(404).json({ message: '附件不可下载' });
      return;
    }

    const rangeHeader = getValidRangeHeader(request.headers.range);
    const fileResponse = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
    });
    if (fileResponse.status === 416) {
      setMediaResponseHeaders(response, fileResponse, String(request.query.name || '').trim());
      response.status(416).end();
      return;
    }

    if (!fileResponse.ok) {
      response.status(502).json({ message: '下载附件失败' });
      return;
    }

    const fileName = String(request.query.name || '').trim();
    setMediaResponseHeaders(response, fileResponse, fileName);

    if (rangeHeader && fileResponse.status === 200) {
      const fallbackSent = await sendBufferedRangeFallback(response, fileResponse, rangeHeader);
      if (fallbackSent) {
        return;
      }
    }

    response.status(fileResponse.status);
    pipeFetchBody(fileResponse, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取附件失败';
    const status = message.includes('缺少') ? 500 : message.includes('权限') ? 403 : 502;
    response.status(status).json({ message });
  }
}

async function handleRequirementSubmissionAttachmentsUpdate(request, response) {
  const toolConfig = getWorkItemToolConfig('requirements');
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateToolPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const recordId = String(request.params.recordId || '').trim();
    if (!projectId || !recordId) {
      response.status(400).json({ message: '缺少需求信息' });
      return;
    }

    const updatePayload = await readWorkItemUpdatePayload(request);
    const requestedExistingAttachments = parseJsonArrayValue(updatePayload.fields?.existingAttachments);
    const notifyProposer = parseBooleanValue(updatePayload.fields?.notifyProposer);
    const token = await getTenantAccessToken();
    const { project } = await getAuthorizedProjectAccess(token, projectId, session.user, 'requirements');
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    await ensureBitableTextField(token, appToken, tableId, toolConfig.fieldNames.comments);
    const [fields, record] = await Promise.all([
      fetchCachedBitableFields(token, appToken, tableId),
      fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig),
    ]);
    validateWorkItemTableSchema(fields, toolConfig);

    const fieldNames = toolConfig.fieldNames;
    const source = record.fields || {};
    const assignees = normalizeUserListValue(source[fieldNames.assignees]);
    if (!assignees.some((assignee) => isSameUser(assignee, session.user))) {
      response.status(403).json({ message: '只有处理人员可以变动提交附件' });
      return;
    }

    if (!isRequirementSubmissionAttachmentRequired(source[fieldNames.requiresSubmissionAttachment])) {
      response.status(400).json({ message: '当前需求不需要提交附件' });
      return;
    }

    const commentsDocument = parseCommentsDocument(source[fieldNames.comments], true);
    const currentAttachments = normalizeBitableAttachmentListValue(source[fieldNames.submittedAttachments]);
    const requestedTokens = [...new Set(
      requestedExistingAttachments.map(getSubmissionAttachmentToken).filter(Boolean),
    )];
    if (requestedTokens.length !== requestedExistingAttachments.length) {
      response.status(400).json({ message: '已有附件数据格式不正确' });
      return;
    }

    const currentByToken = new Map(
      currentAttachments.map((attachment) => [getSubmissionAttachmentToken(attachment), attachment]),
    );
    const retainedAttachments = requestedTokens.map((fileToken) => currentByToken.get(fileToken)).filter(Boolean);
    if (retainedAttachments.length !== requestedTokens.length) {
      response.status(400).json({ message: '已有附件不属于当前需求' });
      return;
    }

    const uploadedAttachments = [];
    for (const file of updatePayload.files) {
      uploadedAttachments.push(await uploadBitableAttachment(token, appToken, tableId, file));
    }

    const retainedTokens = new Set(retainedAttachments.map(getSubmissionAttachmentToken));
    const removedAttachments = currentAttachments.filter(
      (attachment) => !retainedTokens.has(getSubmissionAttachmentToken(attachment)),
    );
    if (uploadedAttachments.length === 0 && removedAttachments.length === 0) {
      response.status(400).json({ message: '提交附件没有变化' });
      return;
    }

    const nextAttachments = [...retainedAttachments, ...uploadedAttachments];
    const rawChangeText = buildRequirementSubmissionAttachmentChangeText({
      added: uploadedAttachments,
      removed: removedAttachments,
    });
    const changeText = rawChangeText.length > 1800
      ? `${rawChangeText.slice(0, 1797)}...`
      : rawChangeText;
    const comment = buildRecordComment(session.user, `${changeText}。`, []);
    const nextCommentsDocument = {
      version: 1,
      items: [...commentsDocument.items, comment],
    };

    await updateBitableRecordFields(token, appToken, tableId, recordId, {
      [fieldNames.submittedAttachments]: nextAttachments.map(toBitableAttachmentValue).filter(Boolean),
      [fieldNames.comments]: JSON.stringify(nextCommentsDocument),
    });

    const updatedRecord = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    const normalizedItem = normalizeWorkItemRecords([updatedRecord], session.user, toolConfig)[0] || null;
    publishWorkItemUpdated({
      projectId: project.projectId,
      toolId: 'requirements',
      recordId,
    });

    const proposers = normalizeUserListValue(source[fieldNames.proposer]);
    const notificationResults = notifyProposer
      ? await notifyRequirementSubmissionAttachmentChangeRecipients(token, proposers, {
          project,
          record: updatedRecord,
          item: normalizedItem,
          operator: session.user,
          addedAttachments: uploadedAttachments,
          removedAttachments,
          changeText,
          request,
          toolConfig,
        })
      : [];

    response.json({
      item: normalizedItem,
      requirement: normalizedItem,
      comment,
      comments: normalizeCommentsForClient(nextCommentsDocument),
      attachmentChange: {
        added: uploadedAttachments,
        removed: removedAttachments,
        text: changeText,
      },
      notificationResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '变动提交附件失败';
    const status = message.includes('缺少')
      ? 500
      : message.includes('权限') || message.includes('只有处理人员')
        ? 403
        : message.includes('不存在')
          ? 404
          : message.includes('JSON')
            ? 409
            : message.includes('不需要') || message.includes('格式') || message.includes('不属于') || message.includes('没有变化')
              ? 400
              : 502;
    response.status(status).json({ message });
  }
}

async function handleWorkItemCommentCreate(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const recordId = String(request.params.recordId || '').trim();
    const content = String(request.body?.content || '').trim();
    const mentionedUsers = normalizeMentionedUsers(request.body?.mentionedUsers || request.body?.mentions || []);
    const notifyMentioned = Boolean(request.body?.notifyMentioned);

    if (!projectId || !recordId) {
      response.status(400).json({ message: `缺少${toolConfig.itemLabel}信息` });
      return;
    }

    if (!content) {
      response.status(400).json({ message: '留言内容不能为空' });
      return;
    }

    if (content.length > 2000) {
      response.status(400).json({ message: '留言内容不能超过2000字' });
      return;
    }

    const token = await getTenantAccessToken();
    const { project, projectAccess } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const commentsFieldName = toolConfig.fieldNames.comments;
    await ensureBitableTextField(token, appToken, tableId, commentsFieldName);

    const record = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    const fields = record.fields || {};
    const commentsDocument = parseCommentsDocument(fields[commentsFieldName], true);
    const allowedMentionedUsers = filterMentionedUsersByCandidates(mentionedUsers, projectAccess.mentionableUsersByTool[toolId] || []);
    const comment = buildRecordComment(session.user, content, allowedMentionedUsers);
    const nextDocument = {
      version: 1,
      items: [...commentsDocument.items, comment],
    };

    await updateBitableRecordFields(token, appToken, tableId, recordId, {
      [commentsFieldName]: JSON.stringify(nextDocument),
    });
    publishWorkItemUpdated({
      projectId: project.projectId,
      toolId,
      recordId,
    });

    const notificationResults = notifyMentioned
      ? await notifyMentionedUsers(token, allowedMentionedUsers, {
          project,
          record,
          comment,
          request,
          toolConfig,
        })
      : [];

    response.json({
      comment,
      comments: normalizeCommentsForClient(nextDocument),
      notificationResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '发送留言失败';
    const status = message.includes('缺少') ? 500 : message.includes('权限') ? 403 : message.includes('不存在') ? 404 : message.includes('JSON') ? 409 : 502;
    response.status(status).json({ message });
  }
}

async function handleWorkItemCommentDelete(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateToolPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const recordId = String(request.params.recordId || '').trim();
    const commentId = String(request.params.commentId || '').trim();
    if (!projectId || !recordId || !commentId) {
      response.status(400).json({ message: '缺少留言信息' });
      return;
    }

    const token = await getTenantAccessToken();
    const { project } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const commentsFieldName = toolConfig.fieldNames.comments;
    await ensureBitableTextField(token, appToken, tableId, commentsFieldName);

    const record = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    const commentsDocument = parseCommentsDocument((record.fields || {})[commentsFieldName], true);
    const comment = commentsDocument.items.find((item) => item.id === commentId);
    if (!comment) {
      response.status(404).json({ message: '留言不存在' });
      return;
    }

    if (!isCommentAuthor(comment, session.user)) {
      response.status(403).json({ message: '只能删除自己发布的留言' });
      return;
    }

    const nextDocument = {
      version: 1,
      items: commentsDocument.items.filter((item) => item.id !== commentId),
    };

    await updateBitableRecordFields(token, appToken, tableId, recordId, {
      [commentsFieldName]: JSON.stringify(nextDocument),
    });
    publishWorkItemUpdated({
      projectId: project.projectId,
      toolId,
      recordId,
    });

    response.json({
      comments: normalizeCommentsForClient(nextDocument),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除留言失败';
    const status = message.includes('缺少') ? 500 : message.includes('权限') || message.includes('只能') ? 403 : message.includes('不存在') ? 404 : message.includes('JSON') ? 409 : 502;
    response.status(status).json({ message });
  }
}

async function handleWorkItemStatusUpdate(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateToolPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const recordId = String(request.params.recordId || '').trim();
    const newStatus = String(request.body?.newStatus || '').trim();
    const message = String(request.body?.message || '').trim();
    const notifyProposer = request.body?.notifyProposer !== false;

    if (!projectId || !recordId) {
      response.status(400).json({ message: `缺少${toolConfig.itemLabel}信息` });
      return;
    }

    if (!newStatus) {
      response.status(400).json({ message: '请选择处理状态' });
      return;
    }

    if (message.length > 2000) {
      response.status(400).json({ message: '留言不能超过2000字' });
      return;
    }

    const token = await getTenantAccessToken();
    const { project } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const fieldNames = toolConfig.fieldNames;
    await ensureBitableTextField(token, appToken, tableId, fieldNames.statusChangeLog);

    const [fields, record] = await Promise.all([
      fetchCachedBitableFields(token, appToken, tableId),
      fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig),
    ]);
    const source = record.fields || {};
    const currentStatus = normalizeTextValue(source[fieldNames.status]) || '未设置状态';
    if (currentStatus === newStatus) {
      response.status(400).json({ message: '处理状态没有变化' });
      return;
    }

    const assignees = normalizeUserListValue(source[fieldNames.assignees]);
    if (!assignees.some((assignee) => isSameUser(assignee, session.user))) {
      response.status(403).json({ message: '只有处理人员可以更新处理状态' });
      return;
    }

    const allowedStatuses = normalizeWorkItemStatusOptions(fields, toolConfig).map((item) => item.name);
    if (allowedStatuses.length > 0 && !allowedStatuses.includes(newStatus)) {
      response.status(400).json({ message: '处理状态不在可选范围内' });
      return;
    }

    const statusChangeLogDocument = parseStatusChangeLogDocument(source[fieldNames.statusChangeLog], true);
    const statusChange = buildStatusChangeLogItem(session.user, currentStatus, newStatus, message);
    const nextStatusChangeLog = {
      version: 1,
      items: [...statusChangeLogDocument.items, statusChange],
    };

    await updateBitableRecordFields(token, appToken, tableId, recordId, {
      [fieldNames.status]: newStatus,
      [fieldNames.statusChangeLog]: JSON.stringify(nextStatusChangeLog),
    });

    const updatedRecord = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    const normalizedItem = normalizeWorkItemRecords([updatedRecord], session.user, toolConfig)[0] || null;
    publishWorkItemUpdated({
      projectId: project.projectId,
      toolId,
      recordId,
    });
    const proposers = fieldNames.proposer ? normalizeUserListValue(source[fieldNames.proposer]) : [];
    const notificationResults = notifyProposer
      ? await notifyWorkItemProposers(token, proposers, {
          project,
          record: updatedRecord,
          oldStatus: currentStatus,
          newStatus,
          message,
          operator: session.user,
          request,
          toolConfig,
        })
      : [];

    response.json({
      requirement: normalizedItem,
      item: normalizedItem,
      statusChange,
      statusChangeLog: normalizeStatusChangeLogForClient(nextStatusChangeLog),
      notificationResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '更新处理状态失败';
    const status = message.includes('缺少') ? 500 : message.includes('权限') || message.includes('只有处理人员') ? 403 : message.includes('不存在') ? 404 : message.includes('JSON') ? 409 : 502;
    response.status(status).json({ message });
  }
}

async function handleWorkItemAssigneeChange(request, response, toolId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  try {
    validateProjectBaseConfig();
    validateProjectPermissionConfig();
    validateToolPermissionConfig();
    validateKnowledgeBaseConfig();

    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const projectId = String(request.params.projectId || '').trim();
    const recordId = String(request.params.recordId || '').trim();
    const requestedAssignees = normalizeMentionedUsers(request.body?.assignees || []);
    const reason = String(request.body?.reason || '').trim();

    if (!projectId || !recordId) {
      response.status(400).json({ message: `缺少${toolConfig.itemLabel}信息` });
      return;
    }

    if (requestedAssignees.length === 0) {
      response.status(400).json({ message: '请选择新的处理人员' });
      return;
    }

    if (!reason) {
      response.status(400).json({ message: '变更原因不能为空' });
      return;
    }

    if (reason.length > 2000) {
      response.status(400).json({ message: '变更原因不能超过2000字' });
      return;
    }

    const token = await getTenantAccessToken();
    const { project, projectAccess } = await getAuthorizedProjectAccess(token, projectId, session.user, toolId);
    const candidates = projectAccess.mentionableUsersByTool[toolId] || [];
    const allowedAssignees = filterMentionedUsersByCandidates(requestedAssignees, candidates);
    if (allowedAssignees.length !== requestedAssignees.length) {
      response.status(400).json({ message: '处理人员不在可选范围内' });
      return;
    }

    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const fieldNames = toolConfig.fieldNames;
    const commentsFieldName = fieldNames.comments;
    await ensureBitableTextField(token, appToken, tableId, commentsFieldName);

    const record = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    const source = record.fields || {};
    const currentAssignees = normalizeUserListValue(source[fieldNames.assignees]);
    const isCurrentAssignee = currentAssignees.some((assignee) => isSameUser(assignee, session.user));
    const canManageAssignees = canManageWorkItemAssignees({
      toolId,
      isSuperAdmin: projectAccess.isSuperAdmin,
      isDevelopmentSuperAdmin: projectAccess.isDevelopmentSuperAdmin,
      isCurrentAssignee,
    });
    if (!canManageAssignees) {
      response.status(403).json({ message: '只有当前处理人员、研发超级管理员或超级管理员可以变更处理人员' });
      return;
    }

    if (hasSameUserSet(currentAssignees, allowedAssignees)) {
      response.status(400).json({ message: '处理人员没有变化' });
      return;
    }

    const commentsDocument = parseCommentsDocument(source[commentsFieldName], true);
    const commentContent = buildAssigneeChangeCommentContent(currentAssignees, allowedAssignees, reason);
    const comment = buildRecordComment(session.user, commentContent, allowedAssignees);
    const nextCommentsDocument = {
      version: 1,
      items: [...commentsDocument.items, comment],
    };

    await updateBitableRecordFields(token, appToken, tableId, recordId, {
      [fieldNames.assignees]: allowedAssignees.map(toBitableUserValue).filter(Boolean),
      [commentsFieldName]: JSON.stringify(nextCommentsDocument),
    });

    const updatedRecord = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
    const normalizedItem = normalizeWorkItemRecords([updatedRecord], session.user, toolConfig)[0] || null;
    publishWorkItemUpdated({
      projectId: project.projectId,
      toolId,
      recordId,
    });
    const proposers = fieldNames.proposer ? normalizeUserListValue(source[fieldNames.proposer]) : [];
    const notificationResults = await notifyWorkItemAssigneeChangeRecipients(token, [...allowedAssignees, ...proposers], {
      project,
      record: updatedRecord,
      item: normalizedItem,
      oldAssignees: currentAssignees,
      newAssignees: allowedAssignees,
      reason,
      operator: session.user,
      request,
      toolConfig,
    });

    response.json({
      item: normalizedItem,
      requirement: toolId === 'requirements' ? normalizedItem : null,
      comment,
      comments: normalizeCommentsForClient(nextCommentsDocument),
      notificationResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `变更${toolConfig.itemLabel}处理人员失败`;
    const status = message.includes('缺少')
      ? 500
      : message.includes('权限') || message.includes('只有')
        ? 403
        : message.includes('不存在')
          ? 404
          : message.includes('JSON')
            ? 409
            : message.includes('请选择') || message.includes('不能为空') || message.includes('不能超过') || message.includes('可选范围') || message.includes('没有变化')
              ? 400
              : 502;
    response.status(status).json({ message });
  }
}

app.get('/api/people/search', async (request, response) => {
  response.status(410).json({ message: '人员搜索已改为项目权限候选人列表' });
});

app.post('/api/auth/feishu', async (request, response) => {
  try {
    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const code = String(request.body?.code || '').trim();
    if (!code) {
      response.status(400).json({ message: '缺少飞书授权码' });
      return;
    }

    const accessToken = await exchangeCodeForAccessToken(code);
    const user = await fetchFeishuUser(accessToken);
    const token = await getTenantAccessToken();
    await ensureUserHasPlatformAccess(token, user);
    const sessionId = createSession(user, accessToken);

    response.setHeader('Set-Cookie', buildSessionCookie(sessionId));
    response.json({ user });
  } catch (error) {
    const message = error instanceof Error ? error.message : '飞书登录失败';
    const status = message.includes('没有权限') ? 403 : message.includes('缺少') ? 500 : 502;
    response.status(status).json({ message });
  }
});

if (isProduction) {
  app.use(express.static(clientDir));
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(clientDir, 'index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: rootDir,
    server: {
      middlewareMode: true,
      hmr: {
        host: 'localhost',
        port: 24679,
      },
    },
    appType: 'spa',
  });

  app.use(vite.middlewares);
}

app.listen(port, host, () => {
  console.log(`Server started on ${host}:${port}`);
  for (const url of getLocalUrls(port)) {
    console.log(url);
  }
});

function normalizeProjects(records) {
  const fields = runtimeConfig.bitable.projectBase.fieldNames;

  return records.map((record) => {
    const source = record.fields || {};
    const projectId = normalizeTextValue(source[fields.projectId]);
    const projectName = normalizeTextValue(source[fields.projectName]);
    const iconFile = normalizeAttachmentValue(source[fields.projectIcon]);
    const iconParams = new URLSearchParams();
    if (iconFile?.fileToken) {
      iconParams.set('fileToken', iconFile.fileToken);
    }
    if (iconFile?.tmpUrl) {
      iconParams.set('tmpUrl', iconFile.tmpUrl);
    }
    if (iconFile?.downloadUrl) {
      iconParams.set('downloadUrl', iconFile.downloadUrl);
    }

    return {
      recordId: String(record.record_id || record.recordId || ''),
      projectId,
      projectName,
      iconUrl: iconFile?.fileToken
        ? `/api/projects/${encodeURIComponent(String(record.record_id || record.recordId || ''))}/icon?${iconParams}`
        : '',
    };
  });
}

async function getAuthorizedProjectAccess(token, projectId, user, requiredToolId = 'overview') {
  const { projectRecords, permissionRecords, toolPermissionRecords } = await fetchProjectAccessRecords(token);
  const permissionContext = buildPermissionContext(permissionRecords, toolPermissionRecords, user);
  const projectAccess = permissionContext.projectsById.get(projectId);
  if (!projectAccess) {
    throw new Error('没有该项目权限');
  }

  if (requiredToolId && !projectAccess.allowedToolIds.has(requiredToolId)) {
    throw new Error('没有该工具权限');
  }

  const project = normalizeProjects(projectRecords).find((item) => item.projectId === projectId);
  if (!project) {
    throw new Error('项目不存在');
  }

  return {
    project: attachProjectAccess(project, projectAccess),
    projectAccess,
  };
}

async function getAccessibleProjectsForUser(token, user) {
  const { projectRecords, permissionRecords, toolPermissionRecords } = await fetchProjectAccessRecords(token);
  const permissionContext = buildPermissionContext(permissionRecords, toolPermissionRecords, user);

  return normalizeProjects(projectRecords)
    .filter((project) => permissionContext.projectsById.has(project.projectId))
    .map((project) => attachProjectAccess(project, permissionContext.projectsById.get(project.projectId)))
    .sort(compareProjects);
}

async function getProjectWaitingWorkItemCount(token, project, user, toolConfig) {
  try {
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await getCachedWorkItemTableContext(token, node, toolConfig);
    const records = await fetchBitableRecords(token, {
      appToken,
      tableId,
      viewId: '',
      fieldNames: {},
    });
    const items = normalizeWorkItemRecords(records, user, toolConfig);
    return countWaitingAssignedWorkItems(toolConfig.toolId, items, user);
  } catch (error) {
    if (isMissingWorkItemListError(error, toolConfig)) {
      return 0;
    }
    throw error;
  }
}

function isMissingWorkItemListError(error, toolConfig) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes(toolConfig.missingNodeText)
    || message.includes('找不到知识库节点')
    || message.includes('不是多维表格节点');
}

async function mapWithConcurrency(items, maxConcurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(Number(maxConcurrency) || 1, 1), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

async function ensureUserHasPlatformAccess(token, user) {
  validateProjectPermissionConfig();
  const permissionRecords = await fetchProjectPermissionRecords(token);
  const allowedProjectIds = getAllowedProjectIds(permissionRecords, user);
  if (allowedProjectIds.size === 0) {
    throw new Error('没有权限请联系管理员');
  }
}

async function fetchProjectAccessRecords(token) {
  const [projectRecords, permissionRecords, toolPermissionRecords] = await Promise.all([
    fetchCachedBitableRecords(token, runtimeConfig.bitable.projectBase, 'project-base', PROJECT_DATA_CACHE_TTL_MS),
    fetchProjectPermissionRecords(token),
    fetchToolPermissionRecords(token),
  ]);

  return {
    projectRecords,
    permissionRecords,
    toolPermissionRecords,
  };
}

function fetchProjectPermissionRecords(token) {
  return fetchCachedBitableRecords(token, runtimeConfig.bitable.projectPermission, 'project-permission', PROJECT_DATA_CACHE_TTL_MS);
}

async function fetchToolPermissionRecords(token) {
  validateToolPermissionConfig();
  const tableConfig = await resolveBitableTableConfig(token, runtimeConfig.bitable.toolPermission, '工具权限表没有可读取的数据表');
  return fetchCachedBitableRecords(token, tableConfig, 'tool-permission', PROJECT_DATA_CACHE_TTL_MS);
}

async function resolveBitableTableConfig(token, tableConfig, errorMessage) {
  if (tableConfig.tableId) {
    return tableConfig;
  }

  const cacheKey = `${tableConfig.appToken || ''}|${errorMessage || ''}`;
  return getCachedValue(resolvedBitableTableConfigCache, cacheKey, LONG_STRUCTURE_CACHE_TTL_MS, async () => {
    const tables = await fetchCachedBitableTables(token, tableConfig.appToken);
    const firstTable = tables[0] || null;
    const tableId = String(firstTable?.table_id || firstTable?.tableId || '');
    if (!tableId) {
      throw new Error(errorMessage || '多维表格没有可读取的数据表');
    }

    return {
      ...tableConfig,
      tableId,
    };
  });
}

function getCachedWikiChildNodes(token, parentNodeToken) {
  const cacheKey = getWikiChildNodesCacheKey(parentNodeToken);
  return getCachedValue(wikiChildrenCache, cacheKey, STRUCTURE_CACHE_TTL_MS, () => fetchWikiChildNodes(token, parentNodeToken));
}

function invalidateWikiChildNodesCache(parentNodeToken) {
  wikiChildrenCache.delete(getWikiChildNodesCacheKey(parentNodeToken));
}

function getWikiChildNodesCacheKey(parentNodeToken) {
  return `${runtimeConfig.knowledgeBase.spaceId}|${parentNodeToken || ''}`;
}

function setCachedWikiNodeByTitle(title, node) {
  if (!title || !node) {
    return;
  }

  wikiTitleCache.set(getWikiTitleCacheKey(title), {
    value: node,
    expiresAt: Date.now() + STRUCTURE_CACHE_TTL_MS,
  });
}

function getWikiTitleCacheKey(title) {
  return `${runtimeConfig.knowledgeBase.spaceId}|${title || ''}`;
}

function setCachedWorkItemNode(toolConfig, projectId, node) {
  if (!toolConfig?.toolId || !projectId || !node) {
    return;
  }

  workItemNodeCache.set(getWorkItemNodeCacheKey(toolConfig, projectId), {
    value: node,
    expiresAt: Date.now() + STRUCTURE_CACHE_TTL_MS,
  });
}

function getWorkItemNodeCacheKey(toolConfig, projectId) {
  return `${toolConfig.toolId}|${projectId || ''}`;
}

function setCachedWorkItemTableContext(toolConfig, node, context) {
  if (!toolConfig?.toolId || !node?.nodeToken || !context?.tableId) {
    return;
  }

  workItemTableContextCache.set(getWorkItemTableContextCacheKey(toolConfig, node), {
    value: context,
    expiresAt: Date.now() + LONG_STRUCTURE_CACHE_TTL_MS,
  });
}

function getWorkItemTableContextCacheKey(toolConfig, node) {
  return `${toolConfig.toolId}|${node?.nodeToken || ''}|${node?.objToken || ''}`;
}

async function getCachedWorkItemTableContext(token, node, toolConfig) {
  return getCachedValue(
    workItemTableContextCache,
    getWorkItemTableContextCacheKey(toolConfig, node),
    LONG_STRUCTURE_CACHE_TTL_MS,
    () => fetchWorkItemTableContextUncached(token, node, toolConfig),
  );
}

async function fetchWorkItemTableContextUncached(token, node, toolConfig) {
  if (!node?.objToken) {
    throw new Error(toolConfig.notLinkedText);
  }

  const tables = await fetchCachedBitableTables(token, node.objToken);
  const firstTable = tables[0] || null;
  const tableId = String(firstTable?.table_id || firstTable?.tableId || '');
  if (!tableId) {
    throw new Error(toolConfig.noTableText);
  }

  return {
    appToken: node.objToken,
    tableId,
  };
}

function buildPermissionContext(permissionRecords, toolPermissionRecords, user) {
  const toolMatrix = buildToolPermissionMatrix(toolPermissionRecords);
  const userKeys = buildUserKeySet(user);
  const projectsById = new Map();

  for (const projectPermission of normalizeProjectPermissionRecords(permissionRecords)) {
    const departments = getUserDepartments(projectPermission, userKeys);
    if (departments.length === 0) {
      continue;
    }

    const isSuperAdmin = departments.includes(SUPER_ADMIN_DEPARTMENT);
    const developmentSuperAdminField = getDevelopmentSuperAdminFieldName();
    const isDevelopmentSuperAdmin = departments.includes(developmentSuperAdminField);
    const allowedToolIds = buildAllowedToolIds(
      departments,
      toolMatrix,
      isSuperAdmin,
      isDevelopmentSuperAdmin,
    );
    const allowedTools = PROJECT_TOOL_DEFINITIONS.filter((tool) => allowedToolIds.has(tool.id));

    projectsById.set(projectPermission.projectId, {
      projectId: projectPermission.projectId,
      departments,
      isSuperAdmin,
      isDevelopmentSuperAdmin,
      developmentSuperAdmins: uniqueUsers(
        projectPermission.usersByDepartment[developmentSuperAdminField] || [],
      ).map(toMentionableUser),
      allowedToolIds,
      allowedTools,
      mentionableUsersByTool: buildMentionableUsersByTool(projectPermission, toolMatrix),
    });
  }

  return {
    hasAnyProject: projectsById.size > 0,
    projectsById,
  };
}

function normalizeProjectPermissionRecords(records) {
  const fields = runtimeConfig.bitable.projectPermission.fieldNames;
  const departments = getProjectPermissionDepartments();

  return records
    .map((record) => {
      const source = record.fields || {};
      const projectId = normalizeTextValue(source[fields.projectId]);
      if (!projectId) {
        return null;
      }

      const usersByDepartment = {};
      for (const department of departments) {
        usersByDepartment[department] = normalizeUserListValue(source[department]);
      }

      return {
        projectId,
        usersByDepartment,
      };
    })
    .filter(Boolean);
}

function getProjectPermissionDepartments() {
  const fields = runtimeConfig.bitable.projectPermission.fieldNames;
  return [...new Set(
    [
      ...fields.permissionUsers,
      fields.developmentSuperAdmins,
    ].map((fieldName) => String(fieldName || '').trim()).filter(Boolean),
  )];
}

function getDevelopmentSuperAdminFieldName() {
  return String(
    runtimeConfig.bitable.projectPermission.fieldNames.developmentSuperAdmins
    || DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD,
  ).trim();
}

function getUserDepartments(projectPermission, userKeys) {
  return Object.entries(projectPermission.usersByDepartment)
    .filter(([, users]) => users.some((user) => isUserInKeySet(user, userKeys)))
    .map(([department]) => department);
}

function isUserInKeySet(user, userKeys) {
  return Array.from(buildUserKeySet(user)).some((key) => userKeys.has(key));
}

function buildAllowedToolIds(departments, toolMatrix, isSuperAdmin, isDevelopmentSuperAdmin) {
  const allowedToolIds = new Set(['overview']);
  const roleGrantedToolIds = getRoleGrantedWorkItemToolIds({
    isSuperAdmin,
    isDevelopmentSuperAdmin,
    allToolIds: PERMISSION_TOOL_DEFINITIONS.map((tool) => tool.id),
  });
  for (const toolId of roleGrantedToolIds) {
    allowedToolIds.add(toolId);
  }

  for (const department of departments) {
    const allowedTools = toolMatrix.get(department);
    if (!allowedTools) {
      continue;
    }

    for (const toolId of allowedTools) {
      allowedToolIds.add(toolId);
    }
  }

  return allowedToolIds;
}

function buildToolPermissionMatrix(records) {
  const fieldNames = runtimeConfig.bitable.toolPermission.fieldNames;
  const toolFields = fieldNames.tools || {};
  const toolMatrix = new Map();

  for (const record of records) {
    const source = record.fields || {};
    const department = normalizeTextValue(source[fieldNames.department]);
    if (!department) {
      continue;
    }

    const allowedToolIds = new Set();
    for (const tool of PERMISSION_TOOL_DEFINITIONS) {
      const fieldName = toolFields[tool.id] || tool.label;
      if (isAllowedToolValue(source[fieldName])) {
        allowedToolIds.add(tool.id);
      }
    }

    toolMatrix.set(department, allowedToolIds);
  }

  return toolMatrix;
}

function isAllowedToolValue(value) {
  return normalizeTextValue(value).trim() === '允许';
}

function buildMentionableUsersByTool(projectPermission, toolMatrix) {
  const result = Object.fromEntries(PERMISSION_TOOL_DEFINITIONS.map((tool) => [tool.id, []]));
  const admins = projectPermission.usersByDepartment[SUPER_ADMIN_DEPARTMENT] || [];
  const developmentSuperAdminField = getDevelopmentSuperAdminFieldName();
  const developmentSuperAdmins = projectPermission.usersByDepartment[developmentSuperAdminField] || [];

  for (const tool of PERMISSION_TOOL_DEFINITIONS) {
    const users = [];
    for (const admin of admins) {
      users.push(admin);
    }
    if (supportsUnassignedWorkItemRouting(tool.id)) {
      users.push(...developmentSuperAdmins);
    }

    for (const [department, departmentUsers] of Object.entries(projectPermission.usersByDepartment)) {
      if (department === SUPER_ADMIN_DEPARTMENT || department === developmentSuperAdminField) {
        continue;
      }

      if (toolMatrix.get(department)?.has(tool.id)) {
        users.push(...departmentUsers);
      }
    }

    result[tool.id] = uniqueUsers(users).map(toMentionableUser);
  }

  return result;
}

function uniqueUsers(users) {
  const seen = new Set();
  const result = [];

  for (const user of users) {
    const key = getUserStableKey(user);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(user);
  }

  return result;
}

function getUserStableKey(user) {
  return String(user.openId || user.unionId || user.userId || user.email || user.id || user.name || '').trim();
}

function toMentionableUser(user) {
  return {
    openId: String(user.openId || user.id || user.userId || '').trim(),
    name: normalizeTextValue(user.name || user.email || user.openId || user.id) || '未知用户',
    avatarUrl: String(user.avatarUrl || '').trim(),
  };
}

function attachProjectAccess(project, projectAccess) {
  return {
    ...project,
    departments: projectAccess.departments,
    isSuperAdmin: projectAccess.isSuperAdmin,
    isDevelopmentSuperAdmin: projectAccess.isDevelopmentSuperAdmin,
    allowedTools: projectAccess.allowedTools,
    mentionableUsersByTool: projectAccess.mentionableUsersByTool,
  };
}

function filterMentionedUsersByCandidates(mentionedUsers, candidates) {
  const candidatesByKey = new Map();
  for (const candidate of candidates) {
    for (const key of buildUserKeySet(candidate)) {
      candidatesByKey.set(key, candidate);
    }
  }

  const result = [];
  const seen = new Set();
  for (const mentionedUser of mentionedUsers) {
    const matched = Array.from(buildUserKeySet(mentionedUser))
      .map((key) => candidatesByKey.get(key))
      .find(Boolean);
    const key = matched ? getUserStableKey(matched) : '';
    if (!matched || !key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(matched);
  }

  return result;
}

function hasSameUserSet(leftUsers, rightUsers) {
  const leftKeys = buildComparableUserSet(leftUsers);
  const rightKeys = buildComparableUserSet(rightUsers);
  if (leftKeys.size !== rightKeys.size) {
    return false;
  }

  for (const key of leftKeys) {
    if (!rightKeys.has(key)) {
      return false;
    }
  }

  return true;
}

function buildComparableUserSet(users) {
  const keys = new Set();
  for (const user of users || []) {
    const key = getUserStableKey(user);
    if (key) {
      keys.add(key);
    }
  }

  return keys;
}

function buildAssigneeChangeCommentContent(oldAssignees, newAssignees, reason) {
  return `变更处理人：${formatUserNameList(oldAssignees)} -> ${formatUserNameList(newAssignees)}。原因：${reason}`;
}

function formatUserNameList(users) {
  const names = (users || []).map((user) => normalizeTextValue(user?.name || user?.openId || user?.id)).filter(Boolean);
  return names.length > 0 ? names.join('、') : '无';
}

async function readWorkItemCreatePayload(request) {
  if (isMultipartRequest(request)) {
    return parseMultipartWorkItemPayload(request);
  }

  return {
    fields: request.body || {},
    files: [],
  };
}

async function readWorkItemUpdatePayload(request) {
  if (isMultipartRequest(request)) {
    return parseMultipartWorkItemPayload(request);
  }

  return {
    fields: request.body || {},
    files: [],
  };
}

function isMultipartRequest(request) {
  return String(request.headers['content-type'] || '').toLowerCase().includes('multipart/form-data');
}

async function parseMultipartWorkItemPayload(request) {
  const contentType = String(request.headers['content-type'] || '');
  const boundary = getMultipartBoundary(contentType);
  if (!boundary) {
    throw new Error('附件上传格式错误');
  }

  const chunks = [];
  let totalSize = 0;
  for await (const chunk of request) {
    totalSize += chunk.length;
    if (totalSize > MAX_SUBMIT_ATTACHMENT_BYTES * MAX_SUBMIT_ATTACHMENT_COUNT + 1024 * 1024) {
      throw new Error('附件总大小超过限制');
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks);
  const parts = parseMultipartBody(body, boundary);
  const fields = {};
  const files = [];

  for (const part of parts) {
    if (!part.name) {
      continue;
    }

    if (part.filename) {
      if (part.data.length === 0) {
        continue;
      }
      if (files.length >= MAX_SUBMIT_ATTACHMENT_COUNT) {
        throw new Error(`一次最多上传 ${MAX_SUBMIT_ATTACHMENT_COUNT} 个附件`);
      }
      if (part.data.length > MAX_SUBMIT_ATTACHMENT_BYTES) {
        throw new Error(`单个附件不能超过 ${Math.round(MAX_SUBMIT_ATTACHMENT_BYTES / 1024 / 1024)}MB`);
      }
      files.push({
        fieldName: part.name,
        name: sanitizeFileName(part.filename),
        mimeType: part.contentType || 'application/octet-stream',
        size: part.data.length,
        buffer: part.data,
      });
      continue;
    }

    const value = part.data.toString('utf8');
    if (part.name === 'assignees') {
      fields.assignees = parseJsonArrayField(value);
    } else {
      fields[part.name] = value;
    }
  }

  return { fields, files };
}

function getMultipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return String(match?.[1] || match?.[2] || '').trim();
}

function parseMultipartBody(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(delimiter);

  while (start !== -1) {
    start += delimiter.length;
    if (body[start] === 45 && body[start + 1] === 45) {
      break;
    }
    if (body[start] === 13 && body[start + 1] === 10) {
      start += 2;
    }

    const next = body.indexOf(delimiter, start);
    if (next === -1) {
      break;
    }

    let partBuffer = body.subarray(start, next);
    if (partBuffer.length >= 2 && partBuffer[partBuffer.length - 2] === 13 && partBuffer[partBuffer.length - 1] === 10) {
      partBuffer = partBuffer.subarray(0, partBuffer.length - 2);
    }

    const headerEnd = partBuffer.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headerText = partBuffer.subarray(0, headerEnd).toString('utf8');
      const data = partBuffer.subarray(headerEnd + 4);
      parts.push(normalizeMultipartPart(headerText, data));
    }

    start = next;
  }

  return parts;
}

function normalizeMultipartPart(headerText, data) {
  const headers = {};
  for (const line of headerText.split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) {
      continue;
    }
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  const disposition = headers['content-disposition'] || '';
  return {
    name: getMultipartDispositionValue(disposition, 'name'),
    filename: getMultipartDispositionValue(disposition, 'filename'),
    contentType: headers['content-type'] || '',
    data,
  };
}

function getMultipartDispositionValue(disposition, key) {
  const match = new RegExp(`${key}="([^"]*)"`).exec(disposition);
  return match ? match[1] : '';
}

function parseJsonArrayField(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonArrayValue(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return parseJsonArrayField(value);
  }

  return [];
}

function parseStringArrayValue(value) {
  return parseJsonArrayValue(value)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 80);
}

function parseJsonObjectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseBooleanValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const text = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on', '是'].includes(text);
}

function sanitizeFileName(value) {
  return path.basename(String(value || '附件').replace(/\0/g, '')).slice(0, 180) || '附件';
}

async function uploadWorkItemSubmitAttachments(token, appToken, tableId, fields, toolConfig, files) {
  const attachmentFieldName = toolConfig.fieldNames.attachments;
  if (!attachmentFieldName) {
    throw new Error(`${toolConfig.itemLabel}未配置附件字段`);
  }

  const normalizedFields = normalizeBitableFields(fields);
  const attachmentField = findNormalizedField(normalizedFields, attachmentFieldName);
  if (!attachmentField) {
    throw new Error(`${toolConfig.itemLabel}表缺少“${attachmentFieldName}”附件字段`);
  }
  if (!isBitableAttachmentField(attachmentField)) {
    throw new Error(`字段“${attachmentFieldName}”不是附件类型`);
  }

  const uploaded = [];
  for (const file of files) {
    uploaded.push(await uploadBitableAttachment(token, appToken, tableId, file));
  }

  return uploaded;
}

async function uploadWorkItemEditAttachments(token, appToken, tableId, selectedFields, files) {
  const attachmentFields = new Map(selectedFields.filter(isBitableAttachmentField).map((field) => [field.fieldName, field]));
  const uploadedByField = new Map();

  for (const file of files || []) {
    const fieldName = parseAttachmentEditPartName(file.fieldName);
    if (!fieldName) {
      continue;
    }
    if (!attachmentFields.has(fieldName)) {
      throw new Error(`字段不可编辑：${fieldName}`);
    }

    const uploaded = await uploadBitableAttachment(token, appToken, tableId, file);
    const current = uploadedByField.get(fieldName) || [];
    current.push(uploaded);
    uploadedByField.set(fieldName, current);
  }

  return uploadedByField;
}

function parseAttachmentEditPartName(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('attachment:')) {
    return '';
  }

  return decodeURIComponent(text.slice('attachment:'.length));
}

function buildWorkItemUpdateFields(context) {
  const { selectedFields, updates, existingAttachments, uploadedAttachmentsByField, toolConfig } = context;
  const result = {};

  for (const field of selectedFields) {
    if (isBitableAttachmentField(field)) {
      const existing = Array.isArray(existingAttachments[field.fieldName]) ? existingAttachments[field.fieldName] : [];
      const uploaded = uploadedAttachmentsByField.get(field.fieldName) || [];
      result[field.fieldName] = [...existing, ...uploaded].map(toBitableAttachmentValue).filter(Boolean);
      continue;
    }

    if (toolConfig?.toolId === 'feedback' && field.fieldName === toolConfig.fieldNames.contactInfo) {
      result[field.fieldName] = updates[field.fieldName];
      continue;
    }

    result[field.fieldName] = normalizeEditableFieldValue(field, updates[field.fieldName]);
  }

  return result;
}

function validateWorkItemUpdateFields(fields, toolConfig) {
  const fieldNames = toolConfig.fieldNames || {};
  if (Object.hasOwn(fields, fieldNames.title)) {
    const title = normalizeTextValue(fields[fieldNames.title]).trim();
    if (!title) {
      throw new Error(`${toolConfig.itemLabel}标题不能为空`);
    }
    if (title.length > 200) {
      throw new Error(`${toolConfig.itemLabel}标题不能超过200字`);
    }
  }

  if (Object.hasOwn(fields, fieldNames.description)) {
    const description = normalizeTextValue(fields[fieldNames.description]);
    if (description.length > 5000) {
      throw new Error(`${toolConfig.itemLabel}描述不能超过5000字`);
    }
  }
}

function normalizeFeedbackContactInfoUpdate(updateFields, toolConfig, source, user) {
  if (toolConfig.toolId !== 'feedback') {
    return;
  }

  const fieldName = toolConfig.fieldNames.contactInfo;
  if (!fieldName || !Object.hasOwn(updateFields, fieldName)) {
    return;
  }

  const existing = parseFeedbackContactInfo(source?.[fieldName]);
  updateFields[fieldName] = JSON.stringify(normalizeFeedbackContactInfo(
    updateFields[fieldName],
    user,
    existing.valid
      ? {
          isFeishuUser: existing.isFeishuUser,
          feishuUserId: existing.feishuUserId,
        }
      : null,
  ));
}

function normalizeFeedbackContactInfo(value, user, identity = null) {
  const source = parseJsonObjectValue(value);
  const contactIdentity = identity || {
    isFeishuUser: true,
    feishuUserId: getFeedbackContactFeishuUserId(user),
  };
  const phone = normalizeTextValue(source.phone).trim();
  const email = normalizeTextValue(source.email).trim();

  if (phone.length > 50 || (phone && !/^[0-9+()\-\s]+$/.test(phone))) {
    throw new Error('联系电话格式不正确');
  }

  if (email.length > 200 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('联系邮箱格式不正确');
  }

  return {
    isFeishuUser: Boolean(contactIdentity.isFeishuUser),
    feishuUserId: String(contactIdentity.feishuUserId || '').trim(),
    phone,
    email,
    allowDeveloperFollowUp: parseBooleanValue(source.allowDeveloperFollowUp),
  };
}

function getFeedbackContactFeishuUserId(user) {
  const userId = String(user?.openId || user?.unionId || user?.userId || '').trim();
  if (!userId) {
    throw new Error('无法识别当前飞书用户');
  }

  return userId;
}

function parseFeedbackContactInfo(value) {
  const text = normalizeTextValue(value).trim();
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

function normalizeEditableFieldValue(field, value) {
  if (isBitableUserField(field)) {
    return normalizeMentionedUsers(Array.isArray(value) ? value : []).map(toBitableUserValue).filter(Boolean);
  }

  if (isBitableMultiSelectField(field)) {
    return parseStringArrayValue(value);
  }

  if (isBitableSingleSelectField(field)) {
    return normalizeTextValue(value);
  }

  if (isBitableCheckboxField(field)) {
    return parseBooleanValue(value);
  }

  if (isBitableDateField(field)) {
    return normalizeDateTimestamp(value);
  }

  if (isBitableNumberField(field)) {
    return normalizeNumberValue(value);
  }

  return normalizeTextValue(value);
}

function isBitableAttachmentField(field) {
  const uiType = String(field?.uiType || field?.ui_type || '').toLowerCase();
  return uiType.includes('attachment') || Number(field?.type) === 17;
}

async function uploadBitableAttachment(token, appToken, tableId, file) {
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimeType || 'application/octet-stream' });
  form.set('file_name', file.name);
  form.set('parent_type', isImageMimeType(file.mimeType) ? 'bitable_image' : 'bitable_file');
  form.set('parent_node', appToken);
  form.set('size', String(file.size));
  form.set('extra', JSON.stringify({ bitablePerm: { tableId } }));
  form.set('file', blob, file.name);

  const response = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(formatFeishuApiError(payload.msg || '上传附件失败'));
  }

  const fileToken = String(payload.data?.file_token || payload.data?.fileToken || '').trim();
  if (!fileToken) {
    throw new Error('上传附件失败：未返回文件标识');
  }

  return {
    fileToken,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
  };
}

function isImageMimeType(mimeType) {
  return String(mimeType || '').toLowerCase().startsWith('image/');
}

function normalizeTextValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeTextValue(item)).join('').trim();
  }

  if (typeof value === 'object') {
    if (Array.isArray(value.value)) {
      return normalizeTextValue(value.value);
    }

    return String(value.text || value.name || value.value || value.en_name || '').trim();
  }

  return String(value).trim();
}

function normalizeNumberValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const text = normalizeTextValue(value).replace(/[^\d.-]/g, '');
  if (!text) {
    return null;
  }

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeDateTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    const timestamp = value < 10000000000 ? value * 1000 : value;
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return normalizeDateTimestamp(numeric);
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (Array.isArray(value)) {
    return normalizeDateTimestamp(value[0]);
  }

  if (typeof value === 'object') {
    return normalizeDateTimestamp(value.timestamp || value.date || value.value || value.text);
  }

  return null;
}

function normalizeUserListValue(value) {
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') {
      return [normalizeUserValue(value)].filter(Boolean);
    }

    return [];
  }

  return value.map(normalizeUserValue).filter(Boolean);
}

function normalizeUserValue(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const name = normalizeTextValue(item.name || item.en_name || item.nickname || item.email || item.id);
  const openId = String(item.open_id || item.openId || item.id || '').trim();

  return {
    id: String(item.id || item.user_id || item.userId || openId || item.email || name || '').trim(),
    openId,
    unionId: String(item.union_id || item.unionId || '').trim(),
    userId: String(item.user_id || item.userId || '').trim(),
    email: String(item.email || '').trim(),
    name,
    avatarUrl: String(item.avatar_url || item.avatarUrl || item.avatar_thumb || item.avatarThumb || '').trim(),
  };
}

function normalizePriorityValue(value) {
  const raw = normalizeTextValue(value).toUpperCase();
  const matched = REQUIREMENT_PRIORITIES.find((priority) => raw.includes(priority));
  return matched || 'P4';
}

function getWorkItemToolConfig(toolId) {
  const definition = getWorkItemToolDefinition(toolId);
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const source = definition.toolId === 'feedback'
    ? {
        parentName: knowledgeBase.feedbackParentName,
        templateName: knowledgeBase.feedbackTemplateName,
        templateAppToken: knowledgeBase.feedbackTemplateAppToken,
        idPrefix: knowledgeBase.feedbackIdPrefix,
        idDigits: knowledgeBase.feedbackIdDigits,
        fieldNames: knowledgeBase.feedbackFieldNames,
      }
    : definition.toolId === 'bugs'
      ? {
          parentName: knowledgeBase.bugsParentName,
          templateName: knowledgeBase.bugsTemplateName,
          templateAppToken: knowledgeBase.bugsTemplateAppToken,
          idPrefix: knowledgeBase.bugsIdPrefix,
          idDigits: knowledgeBase.bugsIdDigits,
          fieldNames: knowledgeBase.bugsFieldNames,
        }
      : {
          parentName: knowledgeBase.requirementsParentName,
          templateName: knowledgeBase.requirementsTemplateName,
          templateAppToken: knowledgeBase.requirementsTemplateAppToken,
          idPrefix: knowledgeBase.requirementsIdPrefix,
          idDigits: knowledgeBase.requirementsIdDigits,
          fieldNames: knowledgeBase.requirementsFieldNames,
        };
  return {
    ...definition,
    ...source,
  };
}

function normalizeRequirementRecords(records, currentUser) {
  return normalizeWorkItemRecords(records, currentUser, getWorkItemToolConfig('requirements'));
}

function normalizeWorkItemRecords(records, currentUser, toolConfig) {
  const fields = toolConfig.fieldNames;
  const now = Date.now();

  return records
    .map((record) => {
      const source = record.fields || {};
      const proposedAt = normalizeDateTimestamp(source[fields.proposedAt]);
      const expectedDays = normalizeNumberValue(source[fields.expectedDays]);
      const elapsedDays = proposedAt ? (now - proposedAt) / MILLISECONDS_PER_DAY : null;
      const remainingDays = expectedDays !== null && expectedDays > 0 && elapsedDays !== null ? expectedDays - elapsedDays : null;
      const assignees = sortCurrentUserFirst(normalizeUserListValue(source[fields.assignees]), currentUser);
      const proposers = normalizeUserListValue(source[fields.proposer]);
      const itemId = normalizeTextValue(source[fields.itemId || fields.requirementId || fields.bugId || fields.feedbackId]);
      const title = normalizeTextValue(source[fields.title]) || toolConfig.unnamedTitle;
      const status = normalizeTextValue(source[fields.status]) || '未设置状态';
      const contactInfo = toolConfig.toolId === 'feedback'
        ? parseFeedbackContactInfo(source[fields.contactInfo])
        : null;
      const requiresSubmissionAttachment = toolConfig.toolId === 'requirements'
        && isRequirementSubmissionAttachmentRequired(source[fields.requiresSubmissionAttachment]);
      const submittedAttachments = toolConfig.toolId === 'requirements'
        ? normalizeBitableAttachmentListValue(source[fields.submittedAttachments])
        : [];

      return {
        recordId: String(record.record_id || record.recordId || ''),
        itemId,
        [toolConfig.itemIdKey]: itemId,
        requirementId: itemId,
        feedbackId: toolConfig.toolId === 'feedback' ? itemId : '',
        title,
        description: normalizeTextValue(source[fields.description]),
        priority: toolConfig.supportsPriority === false ? '' : normalizePriorityValue(source[fields.priority]),
        itemStatus: status,
        requirementStatus: status,
        assignees,
        proposers,
        proposedAt,
        expectedDays,
        remainingDays: remainingDays === null ? null : Number(remainingDays.toFixed(1)),
        channel: toolConfig.toolId === 'feedback' ? normalizeTextValue(source[fields.channel]) : '',
        contactInfo,
        requiresSubmissionAttachment,
        submittedAttachments,
        requiresSubmissionAttachmentFieldName: toolConfig.toolId === 'requirements'
          ? fields.requiresSubmissionAttachment
          : '',
        submittedAttachmentsFieldName: toolConfig.toolId === 'requirements'
          ? fields.submittedAttachments
          : '',
        comments: normalizeCommentsForClient(parseCommentsDocument(source[fields.comments], false)),
        commentsParseError: getCommentsParseError(source[fields.comments]),
        statusChangeLog: normalizeStatusChangeLogForClient(parseStatusChangeLogDocument(source[fields.statusChangeLog], false)),
        statusChangeLogParseError: getStatusChangeLogParseError(source[fields.statusChangeLog]),
        rawFields: source,
      };
    })
    .sort((left, right) => compareWorkItems(left, right, toolConfig));
}

async function createWorkItemRecord(token, context) {
  const { appToken, tableId, records, fields, toolConfig, user, payload } = context;
  const fieldNames = toolConfig.fieldNames;
  const normalizedFields = normalizeBitableFields(fields);
  const values = {};
  const itemIdFieldName = fieldNames.itemId || fieldNames.requirementId || fieldNames.bugId || fieldNames.feedbackId;
  const itemIdField = findNormalizedField(normalizedFields, itemIdFieldName);

  if (itemIdFieldName && !isAutoNumberField(itemIdField)) {
    values[itemIdFieldName] = buildNextWorkItemId(records, fieldNames, toolConfig);
  }

  values[fieldNames.title] = payload.title;
  if (fieldNames.description) {
    values[fieldNames.description] = payload.description || '';
  }
  if (toolConfig.supportsPriority !== false && fieldNames.priority && payload.priority) {
    values[fieldNames.priority] = payload.priority;
  }
  if (toolConfig.toolId === 'feedback' && fieldNames.channel) {
    values[fieldNames.channel] = toolConfig.channelValue;
  }
  if (fieldNames.status) {
    const defaultStatus = getDefaultWorkItemStatus(fields, toolConfig);
    if (defaultStatus) {
      values[fieldNames.status] = defaultStatus;
    }
  }
  if (fieldNames.proposer) {
    values[fieldNames.proposer] = [toBitableUserValue(user)];
  }
  if (fieldNames.assignees) {
    values[fieldNames.assignees] = (payload.assignees || []).map(toBitableUserValue).filter(Boolean);
  }
  if (fieldNames.proposedAt) {
    values[fieldNames.proposedAt] = Date.now();
  }
  if (fieldNames.expectedDays && payload.expectedDays !== null && payload.expectedDays !== undefined) {
    values[fieldNames.expectedDays] = payload.expectedDays;
  }
  if (toolConfig.toolId === 'requirements' && fieldNames.requiresSubmissionAttachment) {
    values[fieldNames.requiresSubmissionAttachment] = payload.requiresSubmissionAttachment ? '是' : '否';
  }
  if (toolConfig.toolId === 'feedback' && fieldNames.contactInfo && payload.contactInfo) {
    values[fieldNames.contactInfo] = JSON.stringify(payload.contactInfo);
  }
  if (fieldNames.attachments && Array.isArray(payload.attachments) && payload.attachments.length > 0) {
    values[fieldNames.attachments] = payload.attachments.map(toBitableAttachmentValue).filter(Boolean);
  }

  const writableValues = removeNonWritableCreateFields(values, normalizedFields);
  return createBitableRecord(token, appToken, tableId, writableValues);
}

function findNormalizedField(fields, fieldName) {
  return fields.find((field) => field.fieldName === fieldName) || null;
}

function isAutoNumberField(field) {
  const uiType = String(field?.uiType || '').toLowerCase();
  return uiType.includes('autonumber') || uiType.includes('auto_number') || Number(field?.type) === 1005;
}

function removeNonWritableCreateFields(values, fields) {
  const fieldByName = new Map(fields.map((field) => [field.fieldName, field]));
  const result = {};

  for (const [fieldName, value] of Object.entries(values)) {
    const field = fieldByName.get(fieldName);
    if (isAutoNumberField(field) || value === undefined) {
      continue;
    }

    result[fieldName] = value;
  }

  return result;
}

function validateWorkItemTableSchema(fields, toolConfig) {
  const fieldByName = new Map(normalizeBitableFields(fields).map((field) => [field.fieldName, field]));
  const names = toolConfig.fieldNames;

  if (toolConfig.toolId === 'requirements') {
    const requiredField = fieldByName.get(names.requiresSubmissionAttachment);
    if (!requiredField) {
      throw new Error(`需求模板缺少“${names.requiresSubmissionAttachment}”字段`);
    }
    if (!isBitableSingleSelectField(requiredField)) {
      throw new Error(`需求模板字段“${names.requiresSubmissionAttachment}”必须是单选类型`);
    }

    const requiredOptions = getFieldOptionNames(requiredField);
    for (const option of ['是', '否']) {
      if (!requiredOptions.includes(option)) {
        throw new Error(`需求模板“${names.requiresSubmissionAttachment}”缺少“${option}”选项`);
      }
    }

    const submittedAttachmentsField = fieldByName.get(names.submittedAttachments);
    if (!submittedAttachmentsField) {
      throw new Error(`需求模板缺少“${names.submittedAttachments}”字段`);
    }
    if (!isBitableAttachmentField(submittedAttachmentsField)) {
      throw new Error(`需求模板字段“${names.submittedAttachments}”必须是附件类型`);
    }
    return;
  }

  if (toolConfig.toolId !== 'feedback') {
    return;
  }

  const requirements = [
    [names.itemId, '文本', (field) => getServerFieldTypeNumber(field) === 1],
    [names.title, '文本', (field) => getServerFieldTypeNumber(field) === 1],
    [names.description, '文本', (field) => getServerFieldTypeNumber(field) === 1],
    [names.channel, '单选', isBitableSingleSelectField],
    [names.proposer, '人员', isBitableUserField],
    [names.assignees, '人员', isBitableUserField],
    [names.status, '单选', isBitableSingleSelectField],
    [names.proposedAt, '日期', isBitableDateField],
    [names.expectedDays, '数字', isBitableNumberField],
    [names.contactInfo, '文本', (field) => getServerFieldTypeNumber(field) === 1],
    [names.attachments, '附件', isBitableAttachmentField],
    [names.comments, '文本', (field) => getServerFieldTypeNumber(field) === 1],
    [names.statusChangeLog, '文本', (field) => getServerFieldTypeNumber(field) === 1],
  ];

  for (const [fieldName, expectedType, matchesType] of requirements) {
    const field = fieldByName.get(fieldName);
    if (!field) {
      throw new Error(`反馈模板缺少“${fieldName}”字段`);
    }
    if (!matchesType(field)) {
      throw new Error(`反馈模板字段“${fieldName}”必须是${expectedType}类型`);
    }
  }

  const statusOptions = getFieldOptionNames(fieldByName.get(names.status));
  for (const status of ['待处理', '处理中', '已完成', '已搁置', '已拒绝']) {
    if (!statusOptions.includes(status)) {
      throw new Error(`反馈模板“${names.status}”缺少“${status}”选项`);
    }
  }

  const channelOptions = getFieldOptionNames(fieldByName.get(names.channel));
  if (!channelOptions.includes(toolConfig.channelValue)) {
    throw new Error(`反馈模板“${names.channel}”缺少“${toolConfig.channelValue}”选项`);
  }
}

function getFieldOptionNames(field) {
  return (field?.property?.options || field?.property?.option || [])
    .map((option) => normalizeTextValue(option.name || option.text || option.value))
    .filter(Boolean);
}

function buildNextWorkItemId(records, fieldNames, toolConfig) {
  const fieldName = fieldNames.itemId || fieldNames.requirementId || fieldNames.bugId || fieldNames.feedbackId;
  const prefix = toolConfig.idPrefix || '';
  const digits = toolConfig.idDigits || 4;
  let maxNumber = 0;

  for (const record of records || []) {
    const text = normalizeTextValue(record?.fields?.[fieldName]);
    const number = extractWorkItemIdNumber(text, prefix);
    if (number > maxNumber) {
      maxNumber = number;
    }
  }

  return `${prefix}${String(maxNumber + 1).padStart(digits, '0')}`;
}

function extractWorkItemIdNumber(value, prefix) {
  const text = String(value || '').trim();
  if (!text) {
    return 0;
  }

  const escapedPrefix = escapeRegExp(prefix);
  const prefixedMatch = escapedPrefix ? new RegExp(`^${escapedPrefix}(\\d+)$`, 'i').exec(text) : null;
  const fallbackMatch = /(\d+)$/.exec(text);
  const number = Number(prefixedMatch?.[1] || fallbackMatch?.[1] || 0);
  return Number.isFinite(number) ? number : 0;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getDefaultWorkItemStatus(fields, toolConfig) {
  const options = normalizeWorkItemStatusOptions(fields, toolConfig);
  return options[0]?.name || '';
}

function toBitableUserValue(user) {
  const openId = String(user?.openId || user?.open_id || user?.id || '').trim();
  const name = normalizeTextValue(user?.name || user?.email || openId);
  if (!openId && !name) {
    return null;
  }

  return {
    id: openId || name,
    open_id: openId,
    name,
  };
}

function toBitableAttachmentValue(file) {
  const fileToken = String(file?.fileToken || file?.file_token || file?.token || '').trim();
  if (!fileToken) {
    return null;
  }

  return {
    file_token: fileToken,
    name: String(file?.name || file?.fileName || fileToken).trim(),
    size: Number(file?.size || 0) || undefined,
    type: String(file?.mimeType || file?.mime_type || '').trim(),
  };
}

function normalizeBitableAttachmentListValue(value) {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value.value)
      ? value.value
      : [];

  return values
    .map((file) => {
      const fileToken = getSubmissionAttachmentToken(file);
      if (!fileToken) {
        return null;
      }

      return {
        fileToken,
        name: String(file?.name || file?.fileName || file?.file_name || fileToken).trim(),
        size: Number(file?.size || file?.file_size || file?.fileSize || 0) || 0,
        mimeType: String(file?.type || file?.mimeType || file?.mime_type || '').trim(),
      };
    })
    .filter(Boolean);
}

function parseCommentsDocument(value, throwOnInvalid) {
  const text = normalizeTextValue(value).trim();
  if (!text) {
    return { version: 1, items: [] };
  }

  try {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];

    return {
      version: 1,
      items: items.map(normalizeStoredComment).filter(Boolean),
    };
  } catch {
    if (throwOnInvalid) {
      throw new Error('留言字段不是合法 JSON，请先修复多维表格中的留言字段');
    }

    return { version: 1, items: [] };
  }
}

function getCommentsParseError(value) {
  const text = normalizeTextValue(value).trim();
  if (!text) {
    return '';
  }

  try {
    JSON.parse(text);
    return '';
  } catch {
    return '留言字段不是合法 JSON';
  }
}

function normalizeStoredComment(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const id = String(item.id || '').trim();
  const authorOpenId = String(item.authorOpenId || item.author_open_id || '').trim();
  const content = String(item.content || '').trim();
  const createdAt = String(item.createdAt || item.created_at || '').trim();

  if (!id || !authorOpenId || !content || !createdAt) {
    return null;
  }

  return {
    id,
    authorOpenId,
    authorName: String(item.authorName || item.author_name || '').trim(),
    authorAvatarUrl: String(item.authorAvatarUrl || item.author_avatar_url || '').trim(),
    createdAt,
    content,
    mentionedOpenIds: normalizeOpenIdList(item.mentionedOpenIds || item.mentioned_open_ids || []),
    mentionedUsers: normalizeMentionedUsers(item.mentionedUsers || item.mentioned_users || []),
  };
}

function normalizeCommentsForClient(document) {
  return (document?.items || []).map(normalizeStoredComment).filter(Boolean);
}

function parseStatusChangeLogDocument(value, throwOnInvalid) {
  const text = normalizeTextValue(value).trim();
  if (!text) {
    return { version: 1, items: [] };
  }

  try {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];

    return {
      version: 1,
      items: items.map(normalizeStoredStatusChange).filter(Boolean),
    };
  } catch {
    if (throwOnInvalid) {
      throw new Error('处理状态变动记录字段不是合法 JSON，请先修复多维表格中的处理状态变动记录字段');
    }

    return { version: 1, items: [] };
  }
}

function getStatusChangeLogParseError(value) {
  const text = normalizeTextValue(value).trim();
  if (!text) {
    return '';
  }

  try {
    JSON.parse(text);
    return '';
  } catch {
    return '处理状态变动记录字段不是合法 JSON';
  }
}

function normalizeStoredStatusChange(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const id = String(item.id || '').trim();
  const changedAt = String(item.changedAt || item.changed_at || '').trim();
  const oldStatus = String(item.oldStatus || item.old_status || '').trim();
  const newStatus = String(item.newStatus || item.new_status || '').trim();
  const operatorName = String(item.operatorName || item.operator_name || '').trim();

  if (!id || !changedAt || !newStatus || !operatorName) {
    return null;
  }

  return {
    id,
    oldStatus,
    newStatus,
    changedAt,
    operatorOpenId: String(item.operatorOpenId || item.operator_open_id || '').trim(),
    operatorName,
    message: String(item.message || '').trim(),
  };
}

function normalizeStatusChangeLogForClient(document) {
  return (document?.items || []).map(normalizeStoredStatusChange).filter(Boolean);
}

function buildStatusChangeLogItem(user, oldStatus, newStatus, message) {
  return {
    id: crypto.randomUUID(),
    oldStatus: String(oldStatus || '').trim(),
    newStatus: String(newStatus || '').trim(),
    changedAt: new Date().toISOString(),
    operatorOpenId: String(user.openId || '').trim(),
    operatorName: String(user.name || '').trim(),
    message: String(message || '').trim(),
  };
}

function buildRecordComment(user, content, mentionedUsers) {
  return {
    id: crypto.randomUUID(),
    authorOpenId: String(user.openId || '').trim(),
    authorName: String(user.name || '').trim(),
    authorAvatarUrl: String(user.avatarUrl || '').trim(),
    createdAt: new Date().toISOString(),
    content,
    mentionedOpenIds: mentionedUsers.map((item) => item.openId).filter(Boolean),
    mentionedUsers,
  };
}

function normalizeMentionedUsers(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const users = [];
  for (const item of value) {
    const normalized = normalizeMentionedUser(item);
    if (!normalized || seen.has(normalized.openId)) {
      continue;
    }

    seen.add(normalized.openId);
    users.push(normalized);
  }

  return users.slice(0, 20);
}

function normalizeMentionedUser(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const openId = String(item.openId || item.open_id || item.id || '').trim();
  if (!openId) {
    return null;
  }

  return {
    openId,
    name: normalizeTextValue(item.name || item.en_name || item.nickname || item.email || openId) || openId,
    avatarUrl: String(item.avatarUrl || item.avatar_url || item.avatar_thumb || item.avatarThumb || '').trim(),
  };
}

function normalizeOpenIdList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function sortCurrentUserFirst(assignees, currentUser) {
  return [...assignees].sort((left, right) => {
    const leftIsCurrent = isSameUser(left, currentUser);
    const rightIsCurrent = isSameUser(right, currentUser);

    if (leftIsCurrent === rightIsCurrent) {
      return 0;
    }

    return leftIsCurrent ? -1 : 1;
  });
}

function compareRequirements(a, b) {
  return compareWorkItems(a, b);
}

function compareWorkItems(a, b, toolConfig = getWorkItemToolConfig('requirements')) {
  if (toolConfig.supportsPriority !== false) {
    const priorityDiff = REQUIREMENT_PRIORITIES.indexOf(a.priority) - REQUIREMENT_PRIORITIES.indexOf(b.priority);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
  }

  const statusDiff = getWorkItemStatusOrder(toolConfig.toolId, a.itemStatus || a.requirementStatus)
    - getWorkItemStatusOrder(toolConfig.toolId, b.itemStatus || b.requirementStatus);
  if (statusDiff !== 0) {
    return statusDiff;
  }

  const remainingDiff = compareRemainingDays(a.remainingDays, b.remainingDays);
  if (remainingDiff !== 0) {
    return remainingDiff;
  }

  const leftTime = a.proposedAt || 0;
  const rightTime = b.proposedAt || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return String(a.itemId || a.requirementId || a.title).localeCompare(String(b.itemId || b.requirementId || b.title), 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function getWorkItemStatusOrder(toolId, status) {
  const order = toolId === 'bugs'
    ? ['未处理', '修复中', '已修复', '无法复现', '已搁置', '关闭', '未设置状态']
    : ['待处理', '处理中', '已完成', '已搁置', '已拒绝', '已处理', '关闭', '未设置状态'];
  const index = order.indexOf(String(status || '').trim());
  return index === -1 ? order.length : index;
}

function compareRemainingDays(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftValid = Number.isFinite(leftNumber);
  const rightValid = Number.isFinite(rightNumber);

  if (leftValid && rightValid && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }

  return 0;
}

function isSameUser(left, right) {
  const leftKeys = buildUserKeySet(left);
  const rightKeys = buildUserKeySet(right);

  for (const key of leftKeys) {
    if (rightKeys.has(key)) {
      return true;
    }
  }

  return false;
}

function isCommentAuthor(comment, user) {
  const authorOpenId = String(comment?.authorOpenId || '').trim();
  const currentOpenId = String(user?.openId || '').trim();
  if (authorOpenId && currentOpenId) {
    return authorOpenId === currentOpenId;
  }

  return isSameUser({ openId: authorOpenId, name: comment?.authorName }, user);
}

function buildUserKeySet(user) {
  return new Set(
    [user?.openId, user?.unionId, user?.userId, user?.email, user?.name, user?.id]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
}

function normalizeAttachmentValue(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const item = value[0];
  const fileToken = item?.file_token || item?.fileToken || item?.token || item?.attachmentToken || '';

  if (!fileToken) {
    return null;
  }

  return {
    fileToken: String(fileToken),
    tmpUrl: String(item?.tmp_url || item?.tmpUrl || ''),
    downloadUrl: String(item?.url || item?.download_url || item?.downloadUrl || ''),
  };
}

function getAllowedProjectIds(records, user) {
  const fields = runtimeConfig.bitable.projectPermission.fieldNames;
  const userKeys = new Set(
    [user.openId, user.unionId, user.userId, user.email, user.name]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  const allowedProjectIds = new Set();

  for (const record of records) {
    const source = record.fields || {};
    const projectId = normalizeTextValue(source[fields.projectId]);

    if (!projectId) {
      continue;
    }

    if (getProjectPermissionDepartments().some((fieldName) => userListContainsCurrentUser(source[fieldName], userKeys))) {
      allowedProjectIds.add(projectId);
    }
  }

  return allowedProjectIds;
}

function userListContainsCurrentUser(value, userKeys) {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.some((item) => {
    const candidates = [
      item?.id,
      item?.open_id,
      item?.openId,
      item?.union_id,
      item?.unionId,
      item?.user_id,
      item?.userId,
      item?.email,
      item?.name,
      item?.en_name,
    ];

    return candidates.some((candidate) => userKeys.has(String(candidate || '').trim()));
  });
}

function compareProjects(a, b) {
  const leftNumber = Number(a.projectId);
  const rightNumber = Number(b.projectId);

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return String(a.projectId).localeCompare(String(b.projectId), 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

async function getMediaDownloadUrl(token, fileToken, tableId = runtimeConfig.bitable.projectBase.tableId) {
  const query = new URLSearchParams({
    file_tokens: fileToken,
    extra: JSON.stringify({
      bitablePerm: {
        tableId,
      },
    }),
  });
  const response = await fetch(`https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?${query}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '获取附件下载链接失败');
  }

  const items = payload.data?.tmp_download_urls || payload.data?.items || [];
  const matched = findDownloadUrlItem(items, fileToken);

  return matched?.tmp_download_url || matched?.download_url || '';
}

async function getDownloadUrlFromRecordTmpUrl(token, tmpUrl, fileToken) {
  const response = await fetch(tmpUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    return '';
  }

  const items = payload.data?.tmp_download_urls || payload.data?.items || [];
  const matched = findDownloadUrlItem(items, fileToken);

  return matched?.tmp_download_url || matched?.download_url || '';
}

function findDownloadUrlItem(items, fileToken) {
  if (Array.isArray(items)) {
    return items.find((item) => (item.file_token || item.fileToken) === fileToken) || items[0] || null;
  }

  if (items && typeof items === 'object') {
    const mappedValue = items[fileToken];
    if (typeof mappedValue === 'string') {
      return { tmp_download_url: mappedValue };
    }

    if (mappedValue && typeof mappedValue === 'object') {
      return mappedValue;
    }
  }

  return null;
}

function encodeRFC5987ValueChars(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function getValidRangeHeader(value) {
  const range = String(value || '').trim();
  if (!range) {
    return '';
  }

  return /^bytes=\d*-\d*(?:,\d*-\d*)*$/i.test(range) ? range : '';
}

function setMediaResponseHeaders(response, fileResponse, fileName) {
  response.setHeader('Cache-Control', 'private, max-age=600');
  response.setHeader('Content-Type', fileResponse.headers.get('content-type') || 'application/octet-stream');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Accept-Ranges', fileResponse.headers.get('accept-ranges') || 'bytes');
  copyFetchHeader(response, fileResponse, 'content-length', 'Content-Length');
  copyFetchHeader(response, fileResponse, 'content-range', 'Content-Range');
  copyFetchHeader(response, fileResponse, 'last-modified', 'Last-Modified');
  copyFetchHeader(response, fileResponse, 'etag', 'ETag');

  if (fileName) {
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeRFC5987ValueChars(fileName)}`);
  }
}

function copyFetchHeader(response, fileResponse, sourceHeader, targetHeader) {
  const value = fileResponse.headers.get(sourceHeader);
  if (value) {
    response.setHeader(targetHeader, value);
  }
}

function pipeFetchBody(fileResponse, response) {
  if (!fileResponse.body) {
    response.end();
    return;
  }

  Readable.fromWeb(fileResponse.body).on('error', () => {
    response.destroy();
  }).pipe(response);
}

async function sendBufferedRangeFallback(response, fileResponse, rangeHeader) {
  const remoteLength = Number(fileResponse.headers.get('content-length'));
  if (!Number.isFinite(remoteLength) || remoteLength <= 0 || remoteLength > MAX_RANGE_FALLBACK_BYTES) {
    return false;
  }

  const range = parseSingleByteRange(rangeHeader, remoteLength);
  if (!range) {
    response.status(416);
    response.setHeader('Content-Range', `bytes */${remoteLength}`);
    response.setHeader('Content-Length', '0');
    response.end();
    return true;
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  const chunk = buffer.subarray(range.start, range.end + 1);
  response.status(206);
  response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${buffer.length}`);
  response.setHeader('Content-Length', String(chunk.length));
  response.send(chunk);
  return true;
}

function parseSingleByteRange(rangeHeader, totalLength) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || '').trim());
  if (!match || !Number.isFinite(totalLength) || totalLength <= 0) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return null;
  }

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(totalLength - suffixLength, 0);
    return { start, end: totalLength - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : totalLength - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= totalLength) {
    return null;
  }

  return {
    start,
    end: Math.min(end, totalLength - 1),
  };
}

async function ensureProjectRequirementBitable(token, project, currentUser) {
  return ensureProjectWorkItemBitable(token, project, currentUser, getWorkItemToolConfig('requirements'));
}

async function ensureProjectWorkItemBitable(token, project, currentUser, toolConfig) {
  const parentNode = (await findWikiNodeByTitle(token, toolConfig.parentName)) || (await createWikiNode(token, '', toolConfig.parentName));
  if (!parentNode) {
    throw new Error(`无法创建知识库节点：${toolConfig.parentName}`);
  }

  const children = await getCachedWikiChildNodes(token, parentNode.nodeToken);
  const projectNode = findWikiNodeByExactTitle(children, project.projectId);
  if (projectNode) {
    setCachedWorkItemNode(toolConfig, project.projectId, projectNode);
    return buildWorkItemEnsureResult('exists', projectNode, await fetchWorkItemItems(token, projectNode, currentUser, toolConfig), toolConfig);
  }

  const templateNode = findWikiNodeByExactTitle(children, toolConfig.templateName);
  if (!templateNode) {
    const error = new Error(`${toolConfig.missingTemplatePrefix}：${toolConfig.templateName}`);
    error.publicDetails = buildWorkItemEnsureResult('parent_ready', parentNode, {}, toolConfig);
    throw error;
  }

  if (!isWikiBitableNode(templateNode)) {
    throw new Error(`${toolConfig.templateName}不是多维表格节点`);
  }

  const copiedNode = await copyWikiNode(token, templateNode.nodeToken, parentNode.nodeToken, project.projectId);
  setCachedWorkItemNode(toolConfig, project.projectId, copiedNode);
  return buildWorkItemEnsureResult('created', copiedNode, await fetchWorkItemItemsWithCopyRetry(token, copiedNode, currentUser, toolConfig), toolConfig);
}

async function findProjectRequirementNode(token, projectId) {
  return findProjectWorkItemNode(token, projectId, getWorkItemToolConfig('requirements'));
}

async function findProjectWorkItemNode(token, projectId, toolConfig) {
  const cachedNode = await getCachedValue(
    workItemNodeCache,
    getWorkItemNodeCacheKey(toolConfig, projectId),
    STRUCTURE_CACHE_TTL_MS,
    async () => {
      const parentNode = await findWikiNodeByTitle(token, toolConfig.parentName);
      if (!parentNode) {
        throw new Error(`找不到知识库节点：${toolConfig.parentName}`);
      }

      const children = await getCachedWikiChildNodes(token, parentNode.nodeToken);
      const projectNode = findWikiNodeByExactTitle(children, projectId);
      if (!projectNode) {
        throw new Error(`${toolConfig.missingNodeText}：${projectId}`);
      }

      if (!isWikiBitableNode(projectNode)) {
        throw new Error(`${projectId}不是多维表格节点`);
      }

      return projectNode;
    },
  );

  if (!isWikiBitableNode(cachedNode)) {
    throw new Error(`${projectId}不是多维表格节点`);
  }

  return cachedNode;
}

function buildRequirementEnsureResult(status, node, requirementData = {}) {
  return buildWorkItemEnsureResult(status, node, requirementData, getWorkItemToolConfig('requirements'));
}

function buildWorkItemEnsureResult(status, node, itemData = {}, toolConfig) {
  const items = Array.isArray(itemData.items) ? itemData.items : Array.isArray(itemData[toolConfig.itemsKey]) ? itemData[toolConfig.itemsKey] : [];
  const fields = Array.isArray(itemData.fields) ? itemData.fields : [];
  return {
    status,
    existed: status === 'exists',
    created: status === 'created',
    nodeName: node.title,
    nodeToken: node.nodeToken,
    appToken: node.objToken,
    toolId: toolConfig.toolId,
    itemLabel: toolConfig.itemLabel,
    listLabel: toolConfig.listLabel,
    itemIdKey: toolConfig.itemIdKey,
    tableId: itemData.tableId || '',
    commentsFieldName: itemData.commentsFieldName || toolConfig.fieldNames.comments,
    statusChangeLogFieldName: itemData.statusChangeLogFieldName || toolConfig.fieldNames.statusChangeLog,
    fields,
    editableFields: Array.isArray(itemData.editableFields) ? itemData.editableFields : normalizeEditableWorkItemFields(fields, toolConfig),
    items,
    [toolConfig.itemsKey]: items,
    requirements: toolConfig.toolId === 'requirements' ? items : [],
    priorityColors: itemData.priorityColors || {},
    statusOptions: Array.isArray(itemData.statusOptions) ? itemData.statusOptions : getFallbackRequirementStatusOptions(),
  };
}

async function fetchRequirementItems(token, node, currentUser) {
  return fetchWorkItemItems(token, node, currentUser, getWorkItemToolConfig('requirements'));
}

async function fetchWorkItemItemsWithCopyRetry(token, node, currentUser, toolConfig) {
  let lastError = null;
  for (const delay of [0, ...BITABLE_COPY_RETRY_DELAYS_MS]) {
    if (delay > 0) {
      await wait(delay);
    }

    try {
      return await fetchWorkItemItems(token, node, currentUser, toolConfig);
    } catch (error) {
      lastError = error;
      if (!isBitableCopyingError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error(`${toolConfig.listLabel}复制中，请稍后重试`);
}

function isBitableCopyingError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.toLowerCase().includes('bitable is copying') || message.includes('复制中');
}

async function fetchWorkItemItems(token, node, currentUser, toolConfig) {
  if (!node?.objToken) {
    throw new Error(toolConfig.notLinkedText);
  }

  const { appToken, tableId } = await getCachedWorkItemTableContext(token, node, toolConfig);

  const fields = await ensureCachedBitableTextField(token, appToken, tableId, toolConfig.fieldNames.comments);
  validateWorkItemTableSchema(fields, toolConfig);
  setCachedWorkItemTableContext(toolConfig, node, { appToken, tableId });
  const records = await fetchBitableRecords(token, {
    appToken,
    tableId,
    viewId: '',
    fieldNames: {},
  });

  return {
    tableId,
    commentsFieldName: toolConfig.fieldNames.comments,
    statusChangeLogFieldName: toolConfig.fieldNames.statusChangeLog,
    fields: normalizeBitableFields(fields),
    editableFields: normalizeEditableWorkItemFields(fields, toolConfig),
    items: normalizeWorkItemRecords(records, currentUser, toolConfig),
    priorityColors: normalizePriorityColors(fields, toolConfig),
    statusOptions: normalizeWorkItemStatusOptions(fields, toolConfig),
  };
}

async function fetchRequirementTableContext(token, node) {
  return fetchWorkItemTableContext(token, node, getWorkItemToolConfig('requirements'));
}

async function fetchWorkItemTableContext(token, node, toolConfig) {
  return getCachedWorkItemTableContext(token, node, toolConfig);
}

async function fetchRequirementRecordById(token, appToken, tableId, recordId) {
  return fetchWorkItemRecordById(token, appToken, tableId, recordId, getWorkItemToolConfig('requirements'));
}

async function fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig) {
  const records = await fetchBitableRecords(token, {
    appToken,
    tableId,
    viewId: '',
    fieldNames: {},
  });
  const record = records.find((item) => String(item.record_id || item.recordId || '') === recordId);
  if (!record) {
    throw new Error(toolConfig.missingRecordText);
  }

  return record;
}

async function searchPeopleForMention(session, keyword) {
  try {
    const tenantToken = await getTenantAccessToken();
    return await searchFeishuDirectoryUsers(tenantToken, keyword);
  } catch (directoryError) {
    if (session.userAccessToken) {
      try {
        return await searchFeishuUsers(session.userAccessToken, keyword);
      } catch {
        throw directoryError;
      }
    }

    const debugUser = normalizePeopleSearchUser({
      open_id: session.user.openId,
      name: session.user.name,
      avatar_url: session.user.avatarUrl,
    });
    const matchedDebugUsers = debugUser && normalizeTextValue(debugUser.name).includes(keyword) ? [debugUser] : [];
    if (matchedDebugUsers.length > 0) {
      return matchedDebugUsers;
    }

    throw directoryError;
  }
}

async function searchFeishuDirectoryUsers(token, keyword) {
  const users = await fetchFeishuDirectoryUsers(token);
  const normalizedKeyword = normalizeTextValue(keyword).toLowerCase();
  return users
    .filter((user) => {
      const searchable = [
        user.name,
        user.openId,
        user.userId,
        user.email,
      ].map((value) => normalizeTextValue(value).toLowerCase()).join(' ');
      return searchable.includes(normalizedKeyword);
    })
    .slice(0, 20);
}

async function fetchFeishuDirectoryUsers(token) {
  const now = Date.now();
  if (peopleDirectoryCache && peopleDirectoryCache.expiresAt > now) {
    return peopleDirectoryCache.users;
  }

  const departmentIds = await fetchFeishuDirectoryDepartmentIds(token);
  const userMap = new Map();
  for (const departmentId of departmentIds) {
    const users = await fetchFeishuDepartmentUsers(token, departmentId);
    for (const user of users) {
      const normalized = normalizePeopleSearchUser(user);
      if (normalized) {
        userMap.set(normalized.openId, normalized);
      }
    }
  }

  const users = Array.from(userMap.values()).sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  peopleDirectoryCache = {
    users,
    expiresAt: now + 5 * 60 * 1000,
  };

  return users;
}

async function fetchFeishuDirectoryDepartmentIds(token) {
  try {
    const departments = await fetchFeishuDepartments(token);
    const departmentIds = departments
      .map((department) => normalizeDepartmentId(department))
      .filter(Boolean);
    return Array.from(new Set(['0', ...departmentIds]));
  } catch {
    return ['0'];
  }
}

async function fetchFeishuDepartments(token) {
  const departments = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({
      department_id: '0',
      department_id_type: 'open_department_id',
      fetch_child: 'true',
      page_size: '50',
    });
    if (pageToken) {
      query.set('page_token', pageToken);
    }

    const payload = await fetchFeishuJson(`https://open.feishu.cn/open-apis/contact/v3/departments?${query}`, {
      method: 'GET',
      token,
      errorMessage: '读取飞书部门失败',
      normalizeError: normalizeFeishuDirectoryError,
    });

    departments.push(...(payload.data?.items || []));
    pageToken = payload.data?.page_token || payload.data?.pageToken || '';
  } while (pageToken);

  return departments;
}

async function fetchFeishuDepartmentUsers(token, departmentId) {
  const users = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({
      department_id: departmentId,
      department_id_type: 'open_department_id',
      fetch_child: 'true',
      user_id_type: 'open_id',
      page_size: '50',
    });
    if (pageToken) {
      query.set('page_token', pageToken);
    }

    const payload = await fetchFeishuJson(`https://open.feishu.cn/open-apis/contact/v3/users/find_by_department?${query}`, {
      method: 'GET',
      token,
      errorMessage: '读取飞书成员失败',
      normalizeError: normalizeFeishuDirectoryError,
    });

    users.push(...(payload.data?.items || []));
    pageToken = payload.data?.page_token || payload.data?.pageToken || '';
  } while (pageToken);

  return users;
}

function normalizeDepartmentId(department) {
  return String(
    department.open_department_id
    || department.openDepartmentId
    || department.department_id
    || department.departmentId
    || '',
  ).trim();
}

function normalizeFeishuDirectoryError(payload) {
  const message = String(payload?.msg || '');
  const normalizedMessage = message.toLowerCase();
  if (
    normalizedMessage.includes('permission')
    || normalizedMessage.includes('unauthorized')
    || normalizedMessage.includes('forbidden')
    || normalizedMessage.includes('access denied')
    || message.includes('应用尚未开通所需的应用身份权限')
  ) {
    return '飞书应用缺少应用身份的通讯录读取权限，请在开放平台开通 contact:contact.base:readonly 或 contact:contact:readonly_as_app 后重新发布/更新应用';
  }

  return message || '读取飞书通讯录失败';
}

async function searchFeishuUsers(token, keyword) {
  const query = new URLSearchParams({
    user_id_type: 'open_id',
  });
  const response = await fetch(`https://open.feishu.cn/open-apis/contact/v3/users/search?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      query: keyword,
      page_size: 20,
    }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(normalizeFeishuPeopleSearchError(payload));
  }

  const items = payload.data?.users || payload.data?.items || [];
  return items.map(normalizePeopleSearchUser).filter(Boolean);
}

function normalizeFeishuPeopleSearchError(payload) {
  const code = String(payload?.code || '');
  const message = String(payload?.msg || '');
  if (code === '99991679' || message.includes('contact:user:search')) {
    return '当前登录授权不支持成员搜索，请改用应用通讯录读取权限';
  }

  if (message.includes('Invalid access token') || message.includes('Unauthorized')) {
    return '飞书登录授权已失效，请重新打开网页应用后再搜索成员';
  }

  return message || '搜索飞书人员失败';
}

function normalizePeopleSearchUser(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const openId = String(item.open_id || item.openId || item.user_id || item.userId || item.id || '').trim();
  const name = normalizeTextValue(item.name || item.en_name || item.nickname || item.email || openId);
  if (!openId || !name) {
    return null;
  }

  return {
    openId,
    name,
    avatarUrl: String(item.avatar_url || item.avatarUrl || item.avatar_thumb || item.avatarThumb || '').trim(),
  };
}

async function notifyMentionedUsers(token, mentionedUsers, context) {
  const uniqueUsers = normalizeMentionedUsers(mentionedUsers);
  const results = [];

  for (const user of uniqueUsers) {
    try {
      await sendFeishuInteractiveMessage(token, user.openId, buildCommentNotificationCard(user, context));
      results.push({ openId: user.openId, name: user.name, ok: true, message: '' });
    } catch (error) {
      results.push({
        openId: user.openId,
        name: user.name,
        ok: false,
        message: error instanceof Error ? error.message : '通知失败',
      });
    }
  }

  return results;
}

async function notifyWorkItemCreationRecipients(token, recipients, context) {
  const uniqueUsers = normalizeMentionedUsers(recipients);
  const results = [];

  for (const user of uniqueUsers) {
    try {
      const card = context.needsAssigneeAssignment
        ? buildWorkItemNeedsAssignmentNotificationCard(user, context)
        : buildWorkItemCreatedNotificationCard(user, context);
      await sendFeishuInteractiveMessage(token, user.openId, card);
      results.push({ openId: user.openId, name: user.name, ok: true, message: '' });
    } catch (error) {
      results.push({
        openId: user.openId,
        name: user.name,
        ok: false,
        message: error instanceof Error ? error.message : '通知失败',
      });
    }
  }

  return results;
}

async function notifyWorkItemEditRecipients(token, recipients, context) {
  const uniqueUsers = normalizeMentionedUsers(recipients);
  const results = [];

  for (const user of uniqueUsers) {
    try {
      await sendFeishuInteractiveMessage(token, user.openId, buildWorkItemEditNotificationCard(user, context));
      results.push({ openId: user.openId, name: user.name, ok: true, message: '' });
    } catch (error) {
      results.push({
        openId: user.openId,
        name: user.name,
        ok: false,
        message: error instanceof Error ? error.message : '通知失败',
      });
    }
  }

  return results;
}

async function notifyWorkItemAssigneeChangeRecipients(token, recipients, context) {
  const uniqueUsers = normalizeMentionedUsers(recipients);
  const results = [];

  for (const user of uniqueUsers) {
    try {
      await sendFeishuInteractiveMessage(token, user.openId, buildAssigneeChangeNotificationCard(user, context));
      results.push({ openId: user.openId, name: user.name, ok: true, message: '' });
    } catch (error) {
      results.push({
        openId: user.openId,
        name: user.name,
        ok: false,
        message: error instanceof Error ? error.message : '通知失败',
      });
    }
  }

  return results;
}

async function notifyRequirementSubmissionAttachmentChangeRecipients(token, recipients, context) {
  const uniqueUsers = normalizeMentionedUsers(recipients);
  const results = [];

  for (const user of uniqueUsers) {
    try {
      await sendFeishuInteractiveMessage(
        token,
        user.openId,
        buildRequirementSubmissionAttachmentChangeCard(user, context),
      );
      results.push({ openId: user.openId, name: user.name, ok: true, message: '' });
    } catch (error) {
      results.push({
        openId: user.openId,
        name: user.name,
        ok: false,
        message: error instanceof Error ? error.message : '通知失败',
      });
    }
  }

  return results;
}

async function notifyRequirementProposers(token, proposers, context) {
  return notifyWorkItemProposers(token, proposers, {
    ...context,
    toolConfig: context.toolConfig || getWorkItemToolConfig('requirements'),
  });
}

async function notifyWorkItemProposers(token, proposers, context) {
  const uniqueUsers = normalizeMentionedUsers(proposers);
  const results = [];

  for (const user of uniqueUsers) {
    try {
      await sendFeishuInteractiveMessage(token, user.openId, buildStatusChangeNotificationCard(user, context));
      results.push({ openId: user.openId, name: user.name, ok: true, message: '' });
    } catch (error) {
      results.push({
        openId: user.openId,
        name: user.name,
        ok: false,
        message: error instanceof Error ? error.message : '通知失败',
      });
    }
  }

  return results;
}

async function sendFeishuInteractiveMessage(token, openId, card) {
  const query = new URLSearchParams({
    receive_id_type: 'open_id',
  });
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '发送飞书通知失败');
  }

  return payload.data || {};
}

function buildCommentNotificationCard(_user, context) {
  const toolConfig = context.toolConfig || getWorkItemToolConfig('requirements');
  const projectName = context.project?.projectName || '未命名项目';
  const itemTitle = normalizeTextValue(context.record?.fields?.[toolConfig.fieldNames.title]) || toolConfig.unnamedTitle;
  const authorName = context.comment.authorName || context.comment.authorOpenId;
  const link = buildPlatformExternalLink(toolConfig.directCommentType, {
    projectId: context.project?.projectId || '',
    tool: toolConfig.toolId,
    recordId: context.record?.record_id || context.record?.recordId || '',
    commentId: context.comment.id || '',
  }, context.request);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: `${authorName}在${toolConfig.itemLabel}“${itemTitle}”中给您留言`,
      },
    },
    elements: [
      buildCardLargeTextElement('留言内容', context.comment.content),
      buildCardTextElement('项目名称', `${projectName} (${context.project?.projectId || '无ID'})`),
      buildCardTextElement(toolConfig.itemNameLabel, itemTitle),
      buildCardPersonElement('留言人', {
        openId: context.comment.authorOpenId,
        name: authorName,
      }),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton('跳转至留言', link),
        ],
      },
    ],
  };
}

function buildWorkItemCreatedNotificationCard(_user, context) {
  const toolConfig = context.toolConfig || getWorkItemToolConfig('requirements');
  const projectName = context.project?.projectName || '未命名项目';
  const item = context.item || {};
  const itemTitle = item.title || toolConfig.unnamedTitle;
  const itemId = item.itemId || item[toolConfig.itemIdKey] || '';
  const submitter = context.submitter || {};
  const submitterName = submitter.name || submitter.openId || '未知用户';
  const expectedDays = Number(item.expectedDays);
  const link = buildPlatformExternalLink(toolConfig.directDetailType, {
    projectId: context.project?.projectId || '',
    tool: toolConfig.toolId,
    recordId: item.recordId || '',
  }, context.request);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: `${submitterName}提交了新的${toolConfig.itemLabel}“${itemTitle}”`,
      },
    },
    elements: [
      buildCardLargeTextElement(`${toolConfig.itemLabel}描述`, item.description || '无'),
      buildCardTextElement('项目名称', `${projectName} (${context.project?.projectId || '无ID'})`),
      buildCardTextElement(toolConfig.itemNameLabel, itemId ? `${itemTitle} (${itemId})` : itemTitle),
      buildCardPersonElement('提交人', submitter),
      buildCardTextElement('优先级', item.priority || '未设置'),
      buildCardTextElement('期望时限', Number.isFinite(expectedDays) && expectedDays > 0 ? `${expectedDays.toFixed(1)} 天` : '未设置'),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton(`跳转至${toolConfig.itemLabel}`, link),
        ],
      },
    ],
  };
}

function buildWorkItemNeedsAssignmentNotificationCard(_user, context) {
  const toolConfig = context.toolConfig || getWorkItemToolConfig('requirements');
  const projectName = context.project?.projectName || '未命名项目';
  const item = context.item || {};
  const itemTitle = item.title || toolConfig.unnamedTitle;
  const itemId = item.itemId || item[toolConfig.itemIdKey] || '';
  const submitter = context.submitter || {};
  const submitterName = submitter.name || submitter.openId || '未知用户';
  const expectedDays = Number(item.expectedDays);
  const link = buildPlatformExternalLink(toolConfig.directDetailType, {
    projectId: context.project?.projectId || '',
    tool: toolConfig.toolId,
    recordId: item.recordId || '',
  }, context.request);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: `${submitterName}提交的${toolConfig.itemLabel}未指定处理人，需要手动分配`,
      },
    },
    elements: [
      buildCardLargeTextElement(`${toolConfig.itemLabel}描述`, item.description || '无'),
      buildCardTextElement('项目名称', `${projectName} (${context.project?.projectId || '无ID'})`),
      buildCardTextElement(toolConfig.itemNameLabel, itemId ? `${itemTitle} (${itemId})` : itemTitle),
      buildCardPersonElement('提交人', submitter),
      buildCardTextElement('优先级', item.priority || '未设置'),
      buildCardTextElement('期望时限', Number.isFinite(expectedDays) && expectedDays > 0 ? `${expectedDays.toFixed(1)} 天` : '未设置'),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton(`跳转至${toolConfig.itemLabel}`, link),
        ],
      },
    ],
  };
}

function buildWorkItemEditNotificationCard(_user, context) {
  const toolConfig = context.toolConfig || getWorkItemToolConfig('requirements');
  const projectName = context.project?.projectName || '未命名项目';
  const item = context.item || {};
  const itemTitle = item.title || toolConfig.unnamedTitle;
  const editor = context.editor || {};
  const editorName = editor.name || editor.openId || '未知用户';
  const changedFields = Array.isArray(context.changedFields) && context.changedFields.length > 0 ? context.changedFields.join('、') : '未列出';
  const link = buildPlatformExternalLink(toolConfig.directDetailType, {
    projectId: context.project?.projectId || '',
    tool: toolConfig.toolId,
    recordId: item.recordId || '',
  }, context.request);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: `${editorName}更新了${toolConfig.itemLabel}“${itemTitle}”`,
      },
    },
    elements: [
      buildCardTextElement('项目名称', `${projectName} (${context.project?.projectId || '无ID'})`),
      buildCardTextElement(toolConfig.itemNameLabel, itemTitle),
      buildCardPersonElement('修改人', editor),
      buildCardTextElement('修改字段', changedFields),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton(`跳转至${toolConfig.itemLabel}`, link),
        ],
      },
    ],
  };
}

function buildAssigneeChangeNotificationCard(_user, context) {
  const toolConfig = context.toolConfig || getWorkItemToolConfig('requirements');
  const projectName = context.project?.projectName || '未命名项目';
  const item = context.item || {};
  const itemTitle = item.title || normalizeTextValue(context.record?.fields?.[toolConfig.fieldNames.title]) || toolConfig.unnamedTitle;
  const operator = context.operator || {};
  const operatorName = operator.name || operator.openId || '未知用户';
  const newAssigneeText = formatUserNameList(context.newAssignees);
  const link = buildPlatformExternalLink(toolConfig.directDetailType, {
    projectId: context.project?.projectId || '',
    tool: toolConfig.toolId,
    recordId: item.recordId || context.record?.record_id || context.record?.recordId || '',
  }, context.request);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: `${operatorName}将${toolConfig.itemLabel}“${itemTitle}”的处理人变更为${newAssigneeText}`,
      },
    },
    elements: [
      buildCardLargeTextElement('变更原因', context.reason || '无'),
      buildCardTextElement('项目名称', `${projectName} (${context.project?.projectId || '无ID'})`),
      buildCardTextElement(toolConfig.itemNameLabel, itemTitle),
      buildCardTextElement('原处理人', formatUserNameList(context.oldAssignees)),
      buildCardTextElement('新处理人', newAssigneeText),
      buildCardPersonElement('变更人', operator),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton(`跳转至${toolConfig.itemLabel}`, link),
        ],
      },
    ],
  };
}

function buildRequirementSubmissionAttachmentChangeCard(_user, context) {
  const toolConfig = context.toolConfig || getWorkItemToolConfig('requirements');
  const projectName = context.project?.projectName || '未命名项目';
  const item = context.item || {};
  const itemTitle = item.title
    || normalizeTextValue(context.record?.fields?.[toolConfig.fieldNames.title])
    || toolConfig.unnamedTitle;
  const operator = context.operator || {};
  const operatorName = operator.name || operator.openId || '未知用户';
  const link = buildPlatformExternalLink(toolConfig.directDetailType, {
    projectId: context.project?.projectId || '',
    tool: toolConfig.toolId,
    recordId: item.recordId || context.record?.record_id || context.record?.recordId || '',
  }, context.request);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: `${operatorName}变动了需求“${itemTitle}”的提交附件`,
      },
    },
    elements: [
      buildCardLargeTextElement('附件变动', context.changeText || '无'),
      buildCardTextElement('项目名称', `${projectName} (${context.project?.projectId || '无ID'})`),
      buildCardTextElement(toolConfig.itemNameLabel, itemTitle),
      buildCardPersonElement('操作人', operator),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton('跳转至需求', link),
        ],
      },
    ],
  };
}

function buildStatusChangeNotificationCard(_user, context) {
  const toolConfig = context.toolConfig || getWorkItemToolConfig('requirements');
  const projectName = context.project?.projectName || '未命名项目';
  const itemTitle = normalizeTextValue(context.record?.fields?.[toolConfig.fieldNames.title]) || toolConfig.unnamedTitle;
  const operatorName = context.operator?.name || context.operator?.openId || '未知用户';
  const link = buildPlatformExternalLink(toolConfig.directDetailType, {
    projectId: context.project?.projectId || '',
    tool: toolConfig.toolId,
    recordId: context.record?.record_id || context.record?.recordId || '',
  }, context.request);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: `${toolConfig.itemLabel}“${itemTitle}”的处理状态更新为${context.newStatus}`,
      },
    },
    elements: [
      buildCardLargeTextElement('留言内容', context.message || '无'),
      buildCardTextElement('项目名称', `${projectName} (${context.project?.projectId || '无ID'})`),
      buildCardTextElement(toolConfig.itemNameLabel, itemTitle),
      buildCardPersonElement('操作者', context.operator || { name: operatorName }),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton(`跳转至${toolConfig.itemLabel}`, link),
        ],
      },
    ],
  };
}

function buildCardLargeTextElement(label, value) {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${escapeLarkMarkdown(label)}**\n## ${escapeLarkMarkdown(value || '无')}`,
    },
  };
}

function buildCardPersonElement(label, user) {
  const openId = String(user?.openId || user?.open_id || user?.id || '').trim();
  const name = normalizeTextValue(user?.name || openId || '未知用户');
  const content = openId ? `<at id='${escapeLarkAtId(openId)}'></at>` : escapeLarkMarkdown(name);

  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${escapeLarkMarkdown(label)}**\n${content}`,
    },
  };
}

function buildCardTextElement(label, value) {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${escapeLarkMarkdown(label)}**\n${escapeLarkMarkdown(value)}`,
    },
  };
}

function buildCardLinkButton(text, link) {
  const targetUrl = link.appLink || link.webUrl || link.displayUrl;
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: text,
    },
    type: 'primary',
    url: targetUrl,
    pc_url: targetUrl,
    android_url: targetUrl,
    ios_url: targetUrl,
  };
}

function escapeLarkMarkdown(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/_/g, '\\_').replace(/`/g, '\\`');
}

function escapeLarkAtId(value) {
  return String(value || '').replace(/['"<>]/g, '');
}

function buildPlatformExternalLink(targetType, params = {}, request = null) {
  const path = buildPlatformDirectPath(targetType, params);
  const webUrl = buildPlatformWebUrl(path, request);
  const appLink = buildFeishuWebAppLink(path);

  return {
    appLink,
    webUrl,
    displayUrl: appLink || webUrl,
    path,
    targetType,
  };
}

function buildPlatformDirectPath(targetType, params = {}) {
  const query = new URLSearchParams();
  const direct = String(targetType || 'home').trim() || 'home';
  query.set('direct', direct);

  const allowedParams = ['projectId', 'tool', 'recordId', 'commentId'];
  for (const key of allowedParams) {
    const value = String(params[key] || '').trim();
    if (value) {
      query.set(key, value);
    }
  }

  return `/?${query}`;
}

function buildPlatformWebUrl(pathname, request = null) {
  const configuredBaseUrl = String(runtimeConfig.webApp.publicBaseUrl || '').trim();
  const baseUrl = configuredBaseUrl || buildRequestBaseUrl(request);

  try {
    return new URL(pathname, ensureTrailingSlash(baseUrl)).toString();
  } catch {
    return new URL(pathname, buildRequestBaseUrl(request)).toString();
  }
}

function buildFeishuWebAppLink(pathname) {
  if (!appId) {
    return '';
  }

  const query = new URLSearchParams({
    appId,
    mode: normalizeFeishuWebAppMode(runtimeConfig.webApp.openMode),
    path: pathname,
  });

  return `https://applink.feishu.cn/client/web_app/open?${query}`;
}

function normalizeFeishuWebAppMode(openMode) {
  const mode = String(openMode || '').trim();
  if (mode === 'sidebar' || mode === 'sidebar-semi' || mode === 'appCenter') {
    return mode;
  }

  return 'appCenter';
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function buildRequestBaseUrl(request) {
  const headers = request?.headers || {};
  const forwardedProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || request?.protocol || 'http';
  const host = String(headers.host || `127.0.0.1:${port}`);
  return `${protocol}://${host}/`;
}

function normalizeBitableFields(fields) {
  return fields.map((field, index) => {
    const typeValue = field.type ?? field.field_type ?? field.fieldType ?? '';
    const numericType = Number(typeValue);

    return {
      fieldId: String(field.field_id || field.fieldId || field.id || ''),
      fieldName: String(field.field_name || field.fieldName || field.name || ''),
      type: Number.isFinite(numericType) ? numericType : String(typeValue),
      uiType: String(field.ui_type || field.uiType || field.ui || ''),
      property: normalizeBitableFieldProperty(field.property || {}),
      index,
    };
  });
}

function normalizeEditableWorkItemFields(fields, toolConfig) {
  return normalizeBitableFields(fields).filter((field) => isEditableWorkItemField(field, toolConfig));
}

function isEditableWorkItemField(field, toolConfig) {
  const fieldName = String(field?.fieldName || '').trim();
  if (!fieldName) {
    return false;
  }

  const names = toolConfig.fieldNames || {};
  const blockedNames = new Set([
    names.itemId,
    names.requirementId,
    names.bugId,
    names.feedbackId,
    names.proposer,
    names.proposedAt,
    names.channel,
    names.status,
    names.requiresSubmissionAttachment,
    names.submittedAttachments,
    names.comments,
    names.statusChangeLog,
  ].map((item) => String(item || '').trim()).filter(Boolean));
  if (blockedNames.has(fieldName)) {
    return false;
  }

  if (isAutoNumberField(field) || isReadonlyBitableField(field)) {
    return false;
  }

  return isSupportedEditableBitableField(field);
}

function isReadonlyBitableField(field) {
  const uiType = getServerFieldUiType(field);
  const type = getServerFieldTypeNumber(field);
  return (
    type >= 1000
    || [20, 21, 22, 23, 24, 25, 31, 32].includes(type)
    || uiType.includes('formula')
    || uiType.includes('lookup')
    || uiType.includes('created')
    || uiType.includes('modified')
    || uiType.includes('autonumber')
    || uiType.includes('duplex')
  );
}

function isSupportedEditableBitableField(field) {
  const type = getServerFieldTypeNumber(field);
  const uiType = getServerFieldUiType(field);
  return (
    [1, 2, 3, 4, 5, 7, 11, 13, 15, 17, 18, 19].includes(type)
    || isBitableAttachmentField(field)
    || isBitableUserField(field)
    || isBitableDateField(field)
    || isBitableSingleSelectField(field)
    || isBitableMultiSelectField(field)
    || isBitableCheckboxField(field)
    || isBitableNumberField(field)
    || uiType.includes('text')
    || uiType.includes('url')
    || uiType.includes('phone')
  );
}

function getServerFieldUiType(field) {
  return String(field?.uiType || field?.ui_type || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function getServerFieldTypeNumber(field) {
  const number = Number(field?.type);
  return Number.isFinite(number) ? number : -1;
}

function isBitableUserField(field) {
  const uiType = getServerFieldUiType(field);
  return uiType.includes('user') || uiType.includes('person') || getServerFieldTypeNumber(field) === 11;
}

function isBitableDateField(field) {
  const uiType = getServerFieldUiType(field);
  const type = getServerFieldTypeNumber(field);
  return uiType.includes('date') || uiType.includes('time') || type === 5;
}

function isBitableSingleSelectField(field) {
  const uiType = getServerFieldUiType(field);
  return uiType.includes('singleselect') || getServerFieldTypeNumber(field) === 3;
}

function isBitableMultiSelectField(field) {
  const uiType = getServerFieldUiType(field);
  return uiType.includes('multiselect') || getServerFieldTypeNumber(field) === 4;
}

function isBitableCheckboxField(field) {
  const uiType = getServerFieldUiType(field);
  return uiType.includes('checkbox') || getServerFieldTypeNumber(field) === 7;
}

function isBitableNumberField(field) {
  const uiType = getServerFieldUiType(field);
  const type = getServerFieldTypeNumber(field);
  return [2, 18, 19].includes(type) || uiType.includes('number') || uiType.includes('progress') || uiType.includes('rating') || uiType.includes('currency');
}

function normalizeBitableFieldProperty(property) {
  const normalized = cloneJsonSafe(property) || {};
  const options = Array.isArray(property?.options)
    ? property.options
    : Array.isArray(property?.option)
      ? property.option
      : Array.isArray(property?.options_list)
        ? property.options_list
        : [];

  if (options.length > 0) {
    normalized.options = options.map(normalizeBitableOption).filter(Boolean);
  }

  return normalized;
}

function normalizeBitableOption(option) {
  if (!option || typeof option !== 'object') {
    return null;
  }

  const colorId = Number(option.color);
  return {
    ...cloneJsonSafe(option),
    id: String(option.id || option.option_id || option.optionId || option.name || option.text || option.value || ''),
    name: normalizeTextValue(option.name || option.text || option.value || ''),
    colorId: Number.isFinite(colorId) ? colorId : null,
    color: Number.isFinite(colorId) ? mapFeishuBitableOptionColor(colorId) : '',
  };
}

function cloneJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value && typeof value === 'object' ? { ...value } : value;
  }
}

function normalizePriorityColors(fields, toolConfig = getWorkItemToolConfig('requirements')) {
  const priorityFieldName = toolConfig.fieldNames.priority;
  const priorityField = fields.find((field) => String(field.field_name || field.fieldName || '') === priorityFieldName);
  const options = priorityField?.property?.options || priorityField?.property?.option || [];
  const colors = {};

  for (const option of options) {
    const priority = normalizePriorityValue(option.name || option.text || option.value);
    const colorId = Number(option.color);
    const color = mapFeishuBitableOptionColor(colorId);

    if (REQUIREMENT_PRIORITIES.includes(priority) && color) {
      colors[priority] = color;
    }
  }

  return colors;
}

function normalizeRequirementStatusOptions(fields) {
  return normalizeWorkItemStatusOptions(fields, getWorkItemToolConfig('requirements'));
}

function normalizeWorkItemStatusOptions(fields, toolConfig) {
  const statusFieldName = toolConfig.fieldNames.status;
  const statusField = fields.find((field) => String(field.field_name || field.fieldName || '') === statusFieldName);
  const options = statusField?.property?.options || statusField?.property?.option || [];
  const normalizedOptions = options
    .map((option) => {
      const colorId = Number(option.color);
      const name = normalizeTextValue(option.name || option.text || option.value);
      if (!name) {
        return null;
      }

      return {
        name,
        color: mapFeishuBitableOptionColor(colorId),
      };
    })
    .filter(Boolean);

  return normalizedOptions.length > 0 ? normalizedOptions : getFallbackRequirementStatusOptions();
}

function getFallbackRequirementStatusOptions() {
  return ['待处理', '处理中', '已处理', '已完成', '关闭'].map((name) => ({ name, color: '' }));
}

function mapFeishuBitableOptionColor(colorId) {
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

  return colorMap[colorId] || '';
}

async function findWikiNodeByTitle(token, title) {
  return getCachedValue(wikiTitleCache, getWikiTitleCacheKey(title), STRUCTURE_CACHE_TTL_MS, async () => {
    const rootNodes = await getCachedWikiChildNodes(token, '');
    const queue = [...rootNodes];
    const visited = new Set();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current?.nodeToken || visited.has(current.nodeToken)) {
        continue;
      }

      visited.add(current.nodeToken);

      if (current.title === title) {
        return current;
      }

      const children = await getCachedWikiChildNodes(token, current.nodeToken);
      queue.push(...children);
    }

    return null;
  });
}

async function fetchWikiChildNodes(token, parentNodeToken) {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const nodes = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({ page_size: '50' });
    if (parentNodeToken) {
      query.set('parent_node_token', parentNodeToken);
    }
    if (pageToken) {
      query.set('page_token', pageToken);
    }

    const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(knowledgeBase.spaceId)}/nodes?${query}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = await readJson(response);

    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.msg || '读取知识库节点失败');
    }

    const items = payload.data?.items || payload.data?.nodes || [];
    nodes.push(...items.map(normalizeWikiNode).filter(Boolean));
    pageToken = payload.data?.has_more ? String(payload.data?.page_token || '') : '';
  } while (pageToken);

  return nodes;
}

async function createWikiNode(token, parentNodeToken, title) {
  const attempts = ['docx', 'doc'];
  let lastError = null;

  for (const objType of attempts) {
    try {
      const node = await createWikiNodeWithType(token, parentNodeToken, title, objType);
      const titledNode = node.title === title ? node : await updateWikiNodeTitle(token, node.nodeToken, title);
      invalidateWikiChildNodesCache(parentNodeToken);
      setCachedWikiNodeByTitle(title, titledNode);
      return titledNode;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('创建知识库节点失败');
}

async function createWikiNodeWithType(token, parentNodeToken, title, objType) {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const body = {
    obj_type: objType,
    node_type: 'origin',
    title,
  };

  if (parentNodeToken) {
    body.parent_node_token = parentNodeToken;
  }

  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(knowledgeBase.spaceId)}/nodes`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '创建知识库节点失败');
  }

  const node = normalizeWikiNode(payload.data?.node || payload.data?.wiki_node || payload.data);
  if (!node?.nodeToken) {
    throw new Error('创建知识库节点没有返回节点信息');
  }

  return node;
}

async function updateWikiNodeTitle(token, nodeToken, title) {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(knowledgeBase.spaceId)}/nodes/${encodeURIComponent(nodeToken)}/update_title`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ title }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '更新知识库节点标题失败');
  }

  return normalizeWikiNode(payload.data?.node || payload.data?.wiki_node || payload.data) || {
    nodeToken,
    objToken: '',
    objType: '',
    title,
  };
}

async function copyWikiNode(token, sourceNodeToken, parentNodeToken, title) {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const body = {
    target_parent_token: parentNodeToken,
    target_space_id: knowledgeBase.spaceId,
    title,
  };
  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(knowledgeBase.spaceId)}/nodes/${encodeURIComponent(sourceNodeToken)}/copy`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '复制需求模板失败');
  }

  const copiedNode = normalizeWikiNode(payload.data?.node || payload.data?.wiki_node || payload.data);
  if (copiedNode?.nodeToken) {
    invalidateWikiChildNodesCache(parentNodeToken);
    return copiedNode;
  }

  const taskId = payload.data?.task_id || payload.data?.taskId || payload.data?.id;
  if (taskId) {
    const taskNode = await pollWikiTaskForNode(token, taskId);
    invalidateWikiChildNodesCache(parentNodeToken);
    return taskNode;
  }

  invalidateWikiChildNodesCache(parentNodeToken);
  const childNodes = await getCachedWikiChildNodes(token, parentNodeToken);
  const createdNode = findWikiNodeByExactTitle(childNodes, title);
  if (createdNode) {
    return createdNode;
  }

  throw new Error('复制已提交，但没有返回新节点信息');
}

async function pollWikiTaskForNode(token, taskId) {
  const query = new URLSearchParams({ task_type: 'copy' });
  const url = `https://open.feishu.cn/open-apis/wiki/v2/tasks/${encodeURIComponent(String(taskId))}?${query}`;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = await readJson(response);

    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.msg || '查询知识库复制结果失败');
    }

    const task = payload.data?.task || payload.data || {};
    const status = String(task.status || task.task_status || '').toLowerCase();
    const node = normalizeWikiNode(task.node || task.wiki_node || task.result?.node || task.result);

    if (node?.nodeToken) {
      return node;
    }

    if (status.includes('fail') || status.includes('error')) {
      throw new Error(task.message || task.msg || '复制需求模板失败');
    }

    await wait(800);
  }

  throw new Error('复制需求模板超时');
}

function normalizeWikiNode(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const nodeToken = String(node.node_token || node.nodeToken || node.token || '');
  const objToken = String(node.obj_token || node.objToken || node.app_token || node.appToken || '');
  const title = String(node.title || node.name || '');

  if (!nodeToken && !objToken && !title) {
    return null;
  }

  return {
    nodeToken,
    objToken,
    objType: String(node.obj_type || node.objType || node.type || ''),
    title,
  };
}

function findWikiNodeByExactTitle(nodes, title) {
  return nodes.find((node) => node.title === title) || null;
}

function isWikiBitableNode(node) {
  const type = String(node.objType || '').toLowerCase();
  return type === 'bitable' || type === 'base' || type.includes('bitable');
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isPeopleSearchReauthorizationRequired(message) {
  return message.includes('登录授权已失效');
}
