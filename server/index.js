import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import {
  buildTodoNotificationDedupeKey,
  collectPendingTodoNotificationItems,
  getZonedDateTimeParts,
  isTodoNotificationDue,
  isValidTodoNotificationTime,
  summarizeTodoNotificationItems,
} from '../shared/personalSettingsUtils.js';
import {
  AI_CONVERSATION_STATUSES,
  AI_PLAN_STATUSES,
  AI_PLAN_TOOL_ID,
  canAccessAiPlanTool,
  isAiPlanningWorkItemTool,
} from '../shared/aiPlanningDefinitions.js';
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
} from '../shared/projectOverviewUtils.js';
import {
  PROJECT_TOOL_DEFINITIONS,
  REQUIREMENT_PRIORITIES,
  getWorkItemToolDefinition,
} from '../shared/workItemDefinitions.js';
import {
  VERSION_ASSOCIATION_TOOL_IDS,
  VERSION_MANAGEMENT_TOOL_ID,
  canManageVersions,
} from '../shared/versionManagementUtils.js';
import {
  WORK_ITEM_COMPLETION_TRANSITIONS,
  WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS,
  buildWorkItemVersionAssociationConfirmation,
  getVersionAssociationOperationForTransition,
  getWorkItemCompletionTransition,
  normalizeWorkItemVersionAssociationDecision,
} from '../shared/workItemVersionAssociationUtils.js';
import {
  blockDirectConfigAccess,
  clientDir,
  currentAppVersion,
  isProduction,
  rootDir,
  runtimeConfig,
  validateAiPlanningConfig,
  validateKnowledgeBaseConfig,
  validateProjectBaseConfig,
  validateProjectPermissionConfig,
  validateToolPermissionConfig,
  validateVersionManagementConfig,
} from './config/runtimeConfig.js';
import { createCodexAppServerClient } from './integrations/codexAppServerClient.js';
import { AiPlanningRepository } from './repositories/aiPlanningRepository.js';
import { FeishuAssistantRepository } from './repositories/feishuAssistantRepository.js';
import { ensureAiDataDirectories } from './runtime/aiDataPaths.js';
import { createAiPlanningRealtimeHub } from './runtime/aiPlanningRealtime.js';
import { createBoundedTaskScheduler } from './runtime/boundedTaskScheduler.js';
import { createKeyedTaskQueue } from './runtime/keyedTaskQueue.js';
import { getLocalUrls, getMcpServerUrls } from './runtime/network.js';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  getSession,
  getSessionId,
} from './runtime/sessionStore.js';
import { createWorkItemRealtimeHub } from './runtime/workItemRealtime.js';
import { createBitableTableDataService } from './services/bitableTableDataService.js';
import { createFeishuBitableEventService } from './services/feishuBitableEventService.js';
import {
  clientErrorLogFilePath,
  createClientErrorRateLimiter,
  writeClientErrorLog,
} from './runtime/clientErrorLog.js';
import { fetchUpdateManifest } from './services/updateService.js';
import {
  ensurePersonalSettingsForUser,
  listTodoNotificationRecipients,
  readPersonalSettingsForUser,
  regenerateDevelopmentPlatformTokenForUser,
  resolveUserByDevelopmentPlatformToken,
  savePersonalSettingsForUser,
} from './services/personalSettingsService.js';
import { createTodoNotificationScheduler } from './services/todoNotificationScheduler.js';
import { createVersionManagementService } from './services/versionManagementService.js';
import { createAiRunContextService } from './services/aiRunContextService.js';
import { createAiPlanningNotificationService } from './services/aiPlanningNotificationService.js';
import { createFeishuAssistantService } from './services/feishuAssistantService.js';
import {
  createAiPlanningService,
  getAllowedAiPlanToolIds,
} from './services/aiPlanningService.js';
import {
  McpToolExecutionError,
  createDevelopmentPlatformMcpService,
} from './services/developmentPlatformMcpService.js';
import { createMcpAiPlanService } from './services/mcpAiPlanService.js';
import {
  DEVELOPMENT_PLATFORM_MCP_TOOL_IDS,
  registerDevelopmentPlatformMcp,
} from './mcp/developmentPlatformMcpServer.js';
import {
  ensureWorkItemStatusOptions,
  migrateWorkItemStatusOptions,
  resolveWorkItemTableContext,
} from './services/workItemStatusSchemaService.js';
import {
  exchangeCodeForAccessToken,
  fetchFeishuJson,
  fetchFeishuUser,
  getTenantAccessToken,
  readJson,
} from './integrations/feishuClient.js';
import {
  replyFeishuMessage,
  sendFeishuInteractiveMessage,
  sendFeishuTextMessage,
} from './integrations/feishuMessageClient.js';
import {
  createBitableRecord as createBitableRecordFromApi,
  deleteBitableRecord as deleteBitableRecordFromApi,
  ensureBitableTextField,
  ensureCachedBitableTextField,
  fetchBitableRecord as fetchBitableRecordFromApi,
  fetchBitableRecords as fetchBitableRecordsFromApi,
  fetchCachedBitableFields,
  fetchCachedBitableRecords,
  fetchCachedBitableTables,
  formatFeishuApiError,
  updateBitableRecordFields as updateBitableRecordFieldsFromApi,
} from './integrations/bitableClient.js';
import { createFeishuLongConnectionClient } from './integrations/feishuLongConnectionClient.js';
import { createFeishuDocumentEventSubscriptionClient } from './integrations/feishuDocumentEventSubscriptionClient.js';
import {
  copyWikiNode,
  createWikiNode,
  findWikiNodeByExactTitle,
  findWikiNodeByTitle,
  getCachedWikiChildNodes,
  isWikiBitableNode,
  wait,
} from './integrations/wikiClient.js';
import { getCachedValue } from './runtime/asyncCache.js';
import { findIdempotentMutation } from './runtime/idempotentMutation.js';
import { createMutationFingerprint } from './runtime/mutationFingerprint.js';

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
const PERMISSION_TOOL_DEFINITIONS = PROJECT_TOOL_DEFINITIONS.filter(
  (tool) => !['overview', VERSION_MANAGEMENT_TOOL_ID, AI_PLAN_TOOL_ID].includes(tool.id),
);
const resolvedBitableTableConfigCache = new Map();
const workItemNodeCache = new Map();
const workItemTableContextCache = new Map();
const projectOverviewCache = new Map();
const sentTodoNotificationKeys = new Set();
let sentTodoNotificationDateKey = '';
const {
  publishWorkItemUpdated,
  subscribe: subscribeToWorkItemUpdates,
} = createWorkItemRealtimeHub({
  onPublish: ({ projectId }) => invalidateProjectOverviewCache(projectId),
});
const bitableTableDataService = createBitableTableDataService({
  config: runtimeConfig.bitable.cache,
  bitable: {
    createRecord: createBitableRecordFromApi,
    deleteRecord: deleteBitableRecordFromApi,
    fetchRecord: fetchBitableRecordFromApi,
    fetchRecords: fetchBitableRecordsFromApi,
    updateRecord: updateBitableRecordFieldsFromApi,
  },
});
const feishuDocumentEventSubscriptionClient = createFeishuDocumentEventSubscriptionClient({
  enabled: runtimeConfig.feishu.events.enabled,
  getTenantToken: getTenantAccessToken,
  onError(error) {
    console.error('[feishu-bitable-events] document subscription failed', formatLogError(error));
  },
});
const feishuLongConnectionClient = createFeishuLongConnectionClient({
  appId,
  appSecret,
  onError(error) {
    console.error('[feishu-bitable-events] long connection failed', formatLogError(error));
  },
});
const feishuBitableEventService = createFeishuBitableEventService({
  enabled: runtimeConfig.feishu.events.enabled,
  ...runtimeConfig.bitable.cache,
  getTenantToken: getTenantAccessToken,
  tableDataService: bitableTableDataService,
  longConnection: feishuLongConnectionClient,
  documentSubscriptions: feishuDocumentEventSubscriptionClient,
  publishWorkItemUpdated,
  onError(error) {
    console.error('[feishu-bitable-events] event processing failed', formatLogError(error));
  },
});
const versionManagementService = createVersionManagementService({
  loadCompletedWorkItemCandidates: loadCompletedVersionWorkItemCandidates,
  bitable: {
    createRecord: createBitableRecord,
    deleteRecord: deleteBitableRecord,
    fetchFields: fetchCachedBitableFields,
    fetchRecords: fetchBitableRecords,
    fetchTables: fetchCachedBitableTables,
    updateRecord: updateBitableRecordFields,
  },
  onTableContextResolved: registerBitableTableContext,
});
const todoNotificationScheduler = createTodoNotificationScheduler({
  run: runTodoNotificationTick,
  onError(error) {
    console.error('[todo-notification] 调度失败', formatLogError(error));
  },
});
const aiDataPaths = ensureAiDataDirectories();
const aiPlanningRepository = new AiPlanningRepository(aiDataPaths.database);
const aiPlanMutationQueue = createKeyedTaskQueue();
const workItemMutationQueue = createKeyedTaskQueue();
const workItemTableMutationQueue = createKeyedTaskQueue();
const aiPlanningRealtimeHub = createAiPlanningRealtimeHub();
const aiPlanningScheduler = createBoundedTaskScheduler({
  maxConcurrent: runtimeConfig.aiPlanning.codex.maxConcurrentRuns,
  maxPerUser: runtimeConfig.aiPlanning.codex.maxConcurrentRunsPerUser,
  maxPerProject: runtimeConfig.aiPlanning.codex.maxConcurrentRunsPerProject,
});
const codexRuntimeReady = Boolean(
  runtimeConfig.aiPlanning.enabled
  && runtimeConfig.aiPlanning.codex.model
  && runtimeConfig.aiPlanning.codex.apiBaseUrl
  && runtimeConfig.aiPlanning.codex.apiKey,
);
const codexAppServerClient = codexRuntimeReady
  ? createCodexAppServerClient({
      rootDir,
      codexHome: aiDataPaths.codexHome,
      tempDir: aiDataPaths.temp,
      apiKey: runtimeConfig.aiPlanning.codex.apiKey,
      apiBaseUrl: runtimeConfig.aiPlanning.codex.apiBaseUrl,
      model: runtimeConfig.aiPlanning.codex.model,
      reasoningEffort: runtimeConfig.aiPlanning.codex.reasoningEffort,
      requestTimeoutMs: runtimeConfig.aiPlanning.codex.requestTimeoutMs,
      onApiDiagnostic(diagnostic) {
        console.error('[codex-api-bridge]', formatCodexBridgeDiagnostic(diagnostic));
      },
    })
  : null;
const aiRunContextService = createAiRunContextService({
  tempRoot: aiDataPaths.temp,
  config: runtimeConfig.aiPlanning.attachments,
  downloadAttachment: downloadAiPlanningAttachment,
});
const aiPlanningNotificationService = createAiPlanningNotificationService({
  enabled: runtimeConfig.aiPlanning.notifications.enabled,
  repository: aiPlanningRepository,
  deliver: deliverAiPlanningNotification,
});
const aiPlanningService = createAiPlanningService({
  config: runtimeConfig.aiPlanning,
  repository: aiPlanningRepository,
  scheduler: aiPlanningScheduler,
  realtimeHub: aiPlanningRealtimeHub,
  codexClient: codexAppServerClient,
  skillPath: path.join(rootDir, 'server', 'ai', 'skills', 'work-item-plan', 'SKILL.md'),
  runContextService: aiRunContextService,
  notificationService: aiPlanningNotificationService,
});
const mcpAiPlanService = createMcpAiPlanService({
  repository: aiPlanningRepository,
  listAccessibleProjects: getAccessibleProjectsForUser,
  loadProjectWorkItems(token, project, user, toolId) {
    return getProjectWorkItems(token, project, user, getWorkItemToolConfig(toolId));
  },
});
const developmentPlatformMcpService = createDevelopmentPlatformMcpService({
  statusGroups: runtimeConfig.dashboard.statusGroups,
  listAccessibleProjects({ token, user }) {
    return getAccessibleProjectsForUser(token, user);
  },
  loadProjectWorkItems({ token, user, project, toolId }) {
    return getProjectWorkItems(token, project, user, getWorkItemToolConfig(toolId));
  },
  loadWorkItemDetail: loadDevelopmentPlatformMcpWorkItemDetail,
  loadProjectOverview: loadDevelopmentPlatformMcpProjectOverview,
  loadProjectVersionOverview: loadDevelopmentPlatformMcpVersionOverview,
  aiPlanService: mcpAiPlanService,
  addWorkItemComment: addDevelopmentPlatformMcpWorkItemComment,
  submitAiPlanForReview: submitDevelopmentPlatformMcpAiPlan,
  setAiPlanApplied: setDevelopmentPlatformMcpAiPlanApplied,
  addVersionComment: addDevelopmentPlatformMcpVersionComment,
  updateWorkItemStatus: updateDevelopmentPlatformMcpWorkItemStatus,
});
const feishuAssistantRepository = new FeishuAssistantRepository(aiDataPaths.assistantDatabase);
const feishuAssistantService = createFeishuAssistantService({
  config: runtimeConfig.aiPlanning.assistant,
  repository: feishuAssistantRepository,
  codexClient: codexAppServerClient,
  skillPath: path.join(rootDir, 'server', 'ai', 'skills', 'feishu-assistant', 'SKILL.md'),
  cwd: aiDataPaths.assistantWorkspace,
  async listAccessibleProjects({ user }) {
    const token = await getTenantAccessToken();
    return getAccessibleProjectsForUser(token, user);
  },
  async listAssignedTasks({ user }) {
    const token = await getTenantAccessToken();
    return developmentPlatformMcpService.execute({
      toolName: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_MY_WORK_ITEMS,
      authContext: { token, user },
      arguments: {
        includeCompleted: false,
        limit: 50,
        offset: 0,
      },
    });
  },
  createWorkItem: createWorkItemForAssistant,
  async deliver(ownerOpenId, payload) {
    const token = await getTenantAccessToken();
    if (payload?.type === 'card') {
      await sendFeishuInteractiveMessage(token, ownerOpenId, payload.card);
      return;
    }
    if (payload?.replyToMessageId) {
      await replyFeishuMessage(token, payload.replyToMessageId, {
        msgType: 'text',
        content: { text: payload.content || '' },
      });
      return;
    }
    await sendFeishuTextMessage(token, ownerOpenId, payload?.content || '');
  },
  onError(error) {
    console.error('[feishu-assistant]', formatFeishuAssistantLogError(error));
  },
});
feishuLongConnectionClient.setEventHandlers({
  'drive.file.bitable_record_changed_v1': (payload) => feishuBitableEventService.handleEvent(payload),
  'im.message.receive_v1': (payload) => {
    const event = normalizeFeishuAssistantMessageEvent(payload);
    if (event) {
      feishuAssistantService.handleMessage(event);
    }
  },
  'card.action.trigger': async (payload) => {
    const action = normalizeFeishuAssistantCardAction(payload);
    if (!action) {
      return;
    }
    await feishuAssistantService.handleCardAction(action);
  },
});

const app = express();
const allowClientErrorReport = createClientErrorRateLimiter();

app.use(express.json({ limit: '256kb' }));
app.use(blockDirectConfigAccess);
registerDevelopmentPlatformMcp(app, {
  serverVersion: currentAppVersion,
  authenticate: authenticateDevelopmentPlatformMcpRequest,
  executeTool: executeDevelopmentPlatformMcpTool,
  onError(error, context) {
    console.error(`[mcp] ${context?.phase || 'request'} 失败`, formatLogError(error));
  },
});

app.post('/api/client-errors', (request, response) => {
  if (!allowClientErrorReport(request.ip)) {
    response.status(429).json({ message: '客户端异常上报过于频繁' });
    return;
  }

  const entry = writeClientErrorLog(request.body, {
    authenticated: Boolean(getSession(request)),
    userAgent: request.headers['user-agent'] || '',
  });
  response.status(202).json({
    ok: true,
    diagnosticId: entry.diagnosticId,
  });
});

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    version: currentAppVersion,
    realtimeCache: {
      cache: bitableTableDataService.getHealth(),
      events: feishuBitableEventService.getHealth(),
    },
    feishuAssistant: feishuAssistantService.getHealth(),
  });
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

app.get('/api/me/settings', async (request, response) => {
  await handlePersonalSettingsRead(request, response);
});

app.put('/api/me/settings', async (request, response) => {
  await handlePersonalSettingsUpdate(request, response);
});

app.post('/api/me/settings/ensure', async (request, response) => {
  await handlePersonalSettingsEnsure(request, response);
});

app.post('/api/me/settings/token/regenerate', async (request, response) => {
  await handleDevelopmentPlatformTokenRegenerate(request, response);
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

app.post('/api/projects/:projectId/versions/ensure', async (request, response) => {
  await handleVersionManagementEnsure(request, response);
});

app.get('/api/projects/:projectId/versions/:recordId', async (request, response) => {
  await handleVersionRead(request, response);
});

app.post('/api/projects/:projectId/versions', async (request, response) => {
  await handleVersionCreate(request, response);
});

app.put('/api/projects/:projectId/versions/:recordId', async (request, response) => {
  await handleVersionUpdate(request, response);
});

app.post('/api/projects/:projectId/versions/:recordId/status', async (request, response) => {
  await handleVersionStatusUpdate(request, response);
});

app.delete('/api/projects/:projectId/versions/:recordId', async (request, response) => {
  await handleVersionDelete(request, response);
});

app.post('/api/projects/:projectId/versions/:recordId/comments', async (request, response) => {
  await handleVersionCommentCreate(request, response);
});

app.delete('/api/projects/:projectId/versions/:recordId/comments/:commentId', async (request, response) => {
  await handleVersionCommentDelete(request, response);
});

app.get('/api/projects/:projectId/:toolId/:recordId/ai/conversations', async (request, response) => {
  await handleAiConversationList(request, response);
});

app.post('/api/projects/:projectId/:toolId/:recordId/ai/conversations', async (request, response) => {
  await handleAiConversationCreate(request, response);
});

app.get('/api/ai/conversations/:conversationId', async (request, response) => {
  await handleAiConversationRead(request, response);
});

app.delete('/api/ai/conversations/:conversationId', async (request, response) => {
  await handleAiConversationArchive(request, response);
});

app.post('/api/ai/conversations/:conversationId/messages', async (request, response) => {
  await handleAiConversationMessage(request, response);
});

app.post('/api/ai/conversations/:conversationId/questions/:questionSetId/answers', async (request, response) => {
  await handleAiConversationQuestionAnswers(request, response);
});

app.post('/api/ai/conversations/:conversationId/cancel', async (request, response) => {
  await handleAiConversationCancel(request, response);
});

app.get('/api/ai/conversations/:conversationId/stream', async (request, response) => {
  await handleAiConversationStream(request, response);
});

app.post('/api/ai/conversations/:conversationId/submissions', async (request, response) => {
  await handleAiPlanSubmissionCreate(request, response);
});

app.get('/api/projects/:projectId/ai-plans', async (request, response) => {
  await handleAiPlanList(request, response);
});

app.get('/api/projects/:projectId/ai-activity', async (request, response) => {
  await handleAiProjectActivity(request, response);
});

app.get('/api/projects/:projectId/ai-plans/:submissionId/raw', async (request, response) => {
  await handleAiPlanRawRead(request, response);
});

app.get('/api/projects/:projectId/ai-plans/:submissionId', async (request, response) => {
  await handleAiPlanRead(request, response);
});

app.delete('/api/projects/:projectId/ai-plans/:submissionId', async (request, response) => {
  await handleAiPlanDelete(request, response);
});

app.post('/api/projects/:projectId/ai-plans/:submissionId/adopt', async (request, response) => {
  await handleAiPlanApprove(request, response);
});

app.post('/api/projects/:projectId/ai-plans/:submissionId/approve', async (request, response) => {
  await handleAiPlanApprove(request, response);
});

app.post('/api/projects/:projectId/ai-plans/:submissionId/applied', async (request, response) => {
  await handleAiPlanAppliedUpdate(request, response);
});

app.post('/api/projects/:projectId/ai-plans/:submissionId/reject', async (request, response) => {
  await handleAiPlanReject(request, response);
});

app.post('/api/projects/:projectId/ai-plans/:submissionId/revisions', async (request, response) => {
  await handleAiPlanRevisionCreate(request, response);
});

app.post('/api/projects/:projectId/ai-plans/:submissionId/withdraw', async (request, response) => {
  await handleAiPlanWithdraw(request, response);
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

async function handleVersionManagementEnsure(request, response) {
  try {
    const context = await getVersionRequestContext(request);
    const result = await versionManagementService.ensure(
      context.token,
      context.project,
      context.session.user,
    );
    response.json({
      ...result,
      canManageVersions: canManageProjectVersions(context.projectAccess),
      mentionableUsers: context.projectAccess.mentionableUsersByTool.versions || [],
    });
  } catch (error) {
    sendVersionError(response, error, '准备版本管理失败');
  }
}

async function handleVersionRead(request, response) {
  try {
    const recordId = String(request.params.recordId || '').trim();
    if (!recordId) {
      response.status(400).json({ message: '缺少版本记录ID' });
      return;
    }
    const context = await getVersionRequestContext(request);
    const result = await versionManagementService.readOne(context.token, context.project, recordId);
    response.json({
      ...result,
      canManageVersions: canManageProjectVersions(context.projectAccess),
      mentionableUsers: context.projectAccess.mentionableUsersByTool.versions || [],
    });
  } catch (error) {
    sendVersionError(response, error, '读取版本失败');
  }
}

async function handleVersionCreate(request, response) {
  try {
    const context = await getVersionRequestContext(request, { requireManager: true });
    const result = await versionManagementService.createVersion(
      context.token,
      context.project,
      context.session.user,
      request.body,
    );
    publishVersionUpdate(context.project.projectId, result.version?.recordId);
    if (result.replacedVersion?.recordId) {
      publishVersionUpdate(context.project.projectId, result.replacedVersion.recordId);
    }
    response.status(201).json(result);
  } catch (error) {
    sendVersionError(response, error, '创建版本失败');
  }
}

async function handleVersionUpdate(request, response) {
  try {
    const recordId = String(request.params.recordId || '').trim();
    if (!recordId) {
      response.status(400).json({ message: '缺少版本记录ID' });
      return;
    }
    const context = await getVersionRequestContext(request, { requireManager: true });
    const result = await versionManagementService.updateVersion(
      context.token,
      context.project,
      context.session.user,
      recordId,
      request.body,
    );
    publishVersionUpdate(context.project.projectId, recordId);
    if (result.replacedVersion?.recordId) {
      publishVersionUpdate(context.project.projectId, result.replacedVersion.recordId);
    }
    response.json(result);
  } catch (error) {
    sendVersionError(response, error, '更新版本失败');
  }
}

async function handleVersionStatusUpdate(request, response) {
  try {
    const recordId = String(request.params.recordId || '').trim();
    if (!recordId) {
      response.status(400).json({ message: '缺少版本记录ID' });
      return;
    }
    const context = await getVersionRequestContext(request, { requireManager: true });
    const result = await versionManagementService.changeStatus(
      context.token,
      context.project,
      context.session.user,
      recordId,
      request.body,
    );
    publishVersionUpdate(context.project.projectId, recordId);
    if (result.replacedVersion?.recordId) {
      publishVersionUpdate(context.project.projectId, result.replacedVersion.recordId);
    }
    response.json(result);
  } catch (error) {
    sendVersionError(response, error, '变更版本状态失败');
  }
}

async function handleVersionDelete(request, response) {
  try {
    const recordId = String(request.params.recordId || '').trim();
    if (!recordId) {
      response.status(400).json({ message: '缺少版本记录ID' });
      return;
    }
    const context = await getVersionRequestContext(request, { requireManager: true });
    const result = await versionManagementService.deleteVersion(
      context.token,
      context.project,
      recordId,
    );
    publishVersionUpdate(context.project.projectId, recordId);
    response.json(result);
  } catch (error) {
    sendVersionError(response, error, '删除版本失败');
  }
}

async function handleVersionCommentCreate(request, response) {
  try {
    const recordId = String(request.params.recordId || '').trim();
    if (!recordId) {
      response.status(400).json({ message: '缺少版本记录ID' });
      return;
    }
    const context = await getVersionRequestContext(request);
    const mentionedUsers = normalizeMentionedUsers(
      request.body?.mentionedUsers || request.body?.mentions || [],
    );
    const result = await executeVersionCommentMutation({
      token: context.token,
      user: context.session.user,
      projectId: context.project.projectId,
      recordId,
      content: request.body?.content,
      mentionedUsers,
      notifyMentioned: Boolean(request.body?.notifyMentioned),
      request,
    });
    response.json(result);
  } catch (error) {
    sendVersionError(response, error, '发送版本留言失败');
  }
}

async function executeVersionCommentMutation({
  token,
  user,
  projectId,
  recordId,
  content,
  mentionedUsers = [],
  requestedMentionedUserOpenIds = [],
  notifyMentioned = false,
  clientMutationId = '',
  request = null,
}) {
  const { project, projectAccess } = await getAuthorizedProjectAccess(
    token,
    projectId,
    user,
    VERSION_MANAGEMENT_TOOL_ID,
  );
  const acceptedUsers = filterMentionedUsersByCandidates(
    mentionedUsers,
    projectAccess.mentionableUsersByTool.versions || [],
  );
  const normalizedMutationId = String(clientMutationId || '').trim().slice(0, 100);
  const mutationFingerprint = normalizedMutationId
    ? createMutationFingerprint({
        projectId,
        recordId,
        content: String(content || '').trim(),
        mentionedUserOpenIds: normalizeOpenIdList(requestedMentionedUserOpenIds).sort(),
        notifyMentioned: Boolean(notifyMentioned),
      })
    : '';
  const result = await versionManagementService.createComment(
    token,
    project,
    user,
    recordId,
    {
      content,
      mentionedUsers: acceptedUsers,
      notifyMentioned,
      clientMutationId: normalizedMutationId,
      mutationFingerprint,
    },
  );
  if (!result.duplicate) {
    publishVersionUpdate(project.projectId, recordId);
  }
  const notificationResults = notifyMentioned && !result.duplicate
    ? await notifyVersionMentionedUsers(token, acceptedUsers, {
        project,
        version: result.version,
        comment: result.comment,
        request,
      })
    : [];
  const acceptedOpenIds = acceptedUsers.map((item) => item.openId).filter(Boolean);
  return {
    ...result,
    notificationResults,
    acceptedMentionedUserOpenIds: acceptedOpenIds,
    ignoredMentionedUserOpenIds: normalizeOpenIdList(requestedMentionedUserOpenIds)
      .filter((openId) => !acceptedOpenIds.includes(openId)),
  };
}

async function handleVersionCommentDelete(request, response) {
  try {
    const recordId = String(request.params.recordId || '').trim();
    const commentId = String(request.params.commentId || '').trim();
    if (!recordId || !commentId) {
      response.status(400).json({ message: '缺少版本留言信息' });
      return;
    }
    const context = await getVersionRequestContext(request);
    const result = await versionManagementService.deleteComment(
      context.token,
      context.project,
      context.session.user,
      recordId,
      commentId,
    );
    publishVersionUpdate(context.project.projectId, recordId);
    response.json(result);
  } catch (error) {
    sendVersionError(response, error, '删除版本留言失败');
  }
}

async function getVersionRequestContext(request, { requireManager = false } = {}) {
  validateProjectBaseConfig();
  validateProjectPermissionConfig();
  validateToolPermissionConfig();
  validateKnowledgeBaseConfig();
  validateVersionManagementConfig();
  if (!appId || !appSecret) {
    throw new Error('缺少飞书应用配置');
  }
  const session = getSession(request);
  if (!session) {
    const error = new Error('请先登录飞书');
    error.statusCode = 401;
    throw error;
  }
  const projectId = String(request.params.projectId || '').trim();
  if (!projectId) {
    const error = new Error('缺少项目ID');
    error.statusCode = 400;
    throw error;
  }
  const token = await getTenantAccessToken();
  const { project, projectAccess } = await getAuthorizedProjectAccess(
    token,
    projectId,
    session.user,
    VERSION_MANAGEMENT_TOOL_ID,
  );
  if (requireManager && !canManageProjectVersions(projectAccess)) {
    const error = new Error('只有研发超级管理员或超级管理员可以变更版本');
    error.statusCode = 403;
    throw error;
  }
  return { token, session, project, projectAccess };
}

function canManageProjectVersions(projectAccess) {
  return canManageVersions(projectAccess);
}

function publishVersionUpdate(projectId, recordId) {
  if (!recordId) {
    return;
  }
  publishWorkItemUpdated({
    projectId,
    toolId: VERSION_MANAGEMENT_TOOL_ID,
    recordId,
  });
}

function sendVersionError(response, error, fallbackMessage) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const status = Number(error?.statusCode) || (
    message.includes('请先登录')
      ? 401
      : message.includes('权限') || message.includes('只有') || message.includes('只能')
        ? 403
        : message.includes('不存在') || message.includes('尚未初始化')
          ? 404
          : message.includes('JSON') || message.includes('回滚失败')
            ? 409
            : message.includes('缺少') || message.includes('模板')
              ? 500
              : message.includes('不能为空')
                || message.includes('不能超过')
                || message.includes('没有变化')
                || message.includes('可选范围')
                || message.includes('不能重复')
                || message.includes('不能引用')
                || message.includes('循环')
                || message.includes('已完成')
                || message.includes('仍引用')
                ? 400
                : 502
  );
  response.status(status).json({ message });
}

async function handleAiConversationList(request, response) {
  try {
    const context = await getAiWorkItemRequestContext(request, { loadWorkItem: true });
    const conversations = aiPlanningService.listConversations({
      user: context.session.user,
      projectId: context.project.projectId,
      toolId: context.toolId,
      recordId: context.recordId,
    });
    response.json({
      available: aiPlanningService.isAvailable(),
      conversations,
    });
  } catch (error) {
    sendAiPlanningError(response, error, '读取 AI 对话失败');
  }
}

async function handleAiConversationCreate(request, response) {
  try {
    const context = await getAiWorkItemRequestContext(request, { loadWorkItem: true });
    const conversation = aiPlanningService.createConversation({
      user: context.session.user,
      projectId: context.project.projectId,
      toolId: context.toolId,
      recordId: context.recordId,
      title: String(request.body?.title || `AI计划：${context.workItem.title || context.recordId}`),
      clientMutationId: String(request.body?.clientMutationId || '').trim(),
    });
    response.status(201).json({ conversation });
  } catch (error) {
    sendAiPlanningError(response, error, '创建 AI 对话失败');
  }
}

async function handleAiConversationRead(request, response) {
  try {
    const context = await getAiConversationRequestContext(request);
    response.json({ conversation: context.conversation });
  } catch (error) {
    sendAiPlanningError(response, error, '读取 AI 对话失败');
  }
}

async function handleAiConversationArchive(request, response) {
  try {
    const context = await getAiConversationRequestContext(request);
    const archived = aiPlanningService.archiveConversation({
      user: context.session.user,
      conversationId: context.conversation.id,
    });
    if (!archived) {
      throw createHttpError(
        context.conversation.status === AI_CONVERSATION_STATUSES.RUNNING
          ? '生成计划时不能删除对话'
          : '对话不存在',
        context.conversation.status === AI_CONVERSATION_STATUSES.RUNNING ? 409 : 404,
      );
    }
    response.json({ ok: true });
  } catch (error) {
    sendAiPlanningError(response, error, '删除 AI 对话失败');
  }
}

async function handleAiConversationMessage(request, response) {
  try {
    validateAiPlanningConfig();
    const context = await getAiConversationRequestContext(request, { loadWorkItem: true });
    const result = aiPlanningService.sendMessage({
      user: context.session.user,
      conversationId: context.conversation.id,
      content: request.body?.content,
      expectedVersion: request.body?.expectedVersion,
      clientMutationId: request.body?.clientMutationId,
      workItem: context.workItem,
      project: context.project,
    });
    response.status(result.duplicate ? 200 : 202).json(result);
  } catch (error) {
    sendAiPlanningError(response, error, '发送 AI 对话失败');
  }
}

async function handleAiConversationQuestionAnswers(request, response) {
  try {
    validateAiPlanningConfig();
    const context = await getAiConversationRequestContext(request, { loadWorkItem: true });
    const result = aiPlanningService.answerQuestions({
      user: context.session.user,
      conversationId: context.conversation.id,
      questionSetId: String(request.params.questionSetId || '').trim(),
      expectedVersion: request.body?.expectedVersion,
      clientMutationId: request.body?.clientMutationId,
      answers: request.body?.answers,
      additionalContext: request.body?.additionalContext,
      workItem: context.workItem,
      project: context.project,
    });
    response.status(result.duplicate ? 200 : 202).json(result);
  } catch (error) {
    sendAiPlanningError(response, error, '提交 AI 问题回答失败');
  }
}

async function handleAiConversationCancel(request, response) {
  try {
    const context = await getAiConversationRequestContext(request);
    const conversation = await aiPlanningService.cancelRun({
      user: context.session.user,
      conversationId: context.conversation.id,
    });
    response.json({ conversation });
  } catch (error) {
    sendAiPlanningError(response, error, '取消 AI 任务失败');
  }
}

async function handleAiConversationStream(request, response) {
  try {
    const context = await getAiConversationRequestContext(request);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();
    const unsubscribe = aiPlanningService.subscribe({
      response,
      user: context.session.user,
      conversationId: context.conversation.id,
    });
    request.on('close', unsubscribe);
  } catch (error) {
    if (!response.headersSent) {
      sendAiPlanningError(response, error, '订阅 AI 对话失败');
    } else {
      response.end();
    }
  }
}

async function handleAiPlanSubmissionCreate(request, response) {
  try {
    const context = await getAiConversationRequestContext(request, { loadWorkItem: true });
    const submission = aiPlanningService.createSubmission({
      user: context.session.user,
      conversationId: context.conversation.id,
      title: request.body?.title,
      summary: request.body?.summary,
      markdown: request.body?.markdown,
      sourceReferences: request.body?.sourceReferences,
      workItem: context.workItem,
      project: context.project,
    });
    const rawSubmission = aiPlanningRepository.getSubmission(submission.id);
    const reviewRecipients = getAiPlanReviewNotificationRecipients(
      context.workItem,
      context.projectAccess,
    );
    const notificationQueuedCount = enqueueAiPlanNotifications(
      'plan_review_requested',
      rawSubmission,
      reviewRecipients,
      {
        project: context.project,
        workItem: context.workItem,
      },
    );
    response.status(201).json({
      submission,
      notificationQueuedCount,
      notificationDeliveryEnabled: runtimeConfig.aiPlanning.notifications.enabled,
      reviewRecipientCount: reviewRecipients.length,
      notificationTargetLabel: context.workItem?._aiReviewAssignees?.length
        ? '处理人'
        : '研发超级管理员',
    });
  } catch (error) {
    sendAiPlanningError(response, error, '提交 AI 方案失败');
  }
}

async function handleAiPlanList(request, response) {
  try {
    const context = await getAiPlanProjectRequestContext(request);
    const toolId = String(request.query.toolId || '').trim();
    const status = String(request.query.status || '').trim();
    const recordId = String(request.query.recordId || '').trim();
    if (toolId && !context.allowedToolIds.includes(toolId)) {
      throw createHttpError('没有该工具权限', 403);
    }
    if (status && status !== 'all' && !Object.values(AI_PLAN_STATUSES).includes(status)) {
      throw createHttpError('方案状态不正确', 400);
    }
    const submissions = aiPlanningService.listSubmissions({
      user: context.session.user,
      projectId: context.project.projectId,
      allowedToolIds: context.allowedToolIds,
      toolId,
      recordId,
      search: String(request.query.search || '').trim(),
      status,
    });
    response.json({
      submissions,
      allowedToolIds: context.allowedToolIds,
    });
  } catch (error) {
    sendAiPlanningError(response, error, '读取 AI 方案失败');
  }
}

async function handleAiProjectActivity(request, response) {
  try {
    const context = await getAiPlanProjectRequestContext(request);
    response.json(aiPlanningService.getProjectActivity({
      user: context.session.user,
      projectId: context.project.projectId,
      allowedToolIds: context.allowedToolIds,
    }));
  } catch (error) {
    sendAiPlanningError(response, error, '读取 AI 任务状态失败');
  }
}

async function handleAiPlanRead(request, response) {
  try {
    const context = await getAiPlanProjectRequestContext(request);
    const detail = await buildAiPlanDetailResponse(context, request.params.submissionId);
    response.json({
      ...detail,
    });
  } catch (error) {
    sendAiPlanningError(response, error, '读取 AI 方案失败');
  }
}

async function handleAiPlanRawRead(request, response) {
  try {
    const context = await getAiPlanProjectRequestContext(request);
    const submission = aiPlanningService.getSubmission({
      user: context.session.user,
      submissionId: String(request.params.submissionId || '').trim(),
      projectId: context.project.projectId,
      allowedToolIds: context.allowedToolIds,
    });
    if (!submission) {
      throw createHttpError('方案不存在', 404);
    }
    const fileName = `${String(submission.title || 'ai-plan').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.md`;
    response.setHeader(
      'Content-Disposition',
      `inline; filename="ai-plan.md"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    response.type('text/markdown; charset=utf-8').send(submission.markdown);
  } catch (error) {
    sendAiPlanningError(response, error, '读取 AI 方案 Markdown 失败');
  }
}

async function handleAiPlanDelete(request, response) {
  try {
    const initial = await getAiPlanDeleteRequestContext(request);
    const result = await aiPlanMutationQueue.run(
      buildAiPlanMutationKey(initial.submission),
      async () => {
        const context = await getAiPlanDeleteRequestContext(request);
        assertCanDeleteAiPlan(context);
        const deleted = aiPlanningService.deleteSubmission({
          submissionId: context.submission.id,
          projectId: context.project.projectId,
          allowedToolIds: context.allowedToolIds,
        });
        if (!deleted) {
          throw createHttpError('方案不存在', 404);
        }
        return deleted;
      },
    );
    response.json(result);
  } catch (error) {
    sendAiPlanningError(response, error, '删除 AI 方案失败');
  }
}

async function handleAiPlanApprove(request, response) {
  try {
    const initial = await getAiPlanReviewRequestContext(request);
    const result = await aiPlanMutationQueue.run(
      buildAiPlanMutationKey(initial.submission),
      async () => {
        const context = await getAiPlanReviewRequestContext(request);
        assertCanReviewAiPlan(context);
        const previousApproved = aiPlanningRepository.getApprovedSubmissionForWorkItem({
          projectId: context.submission.projectId,
          toolId: context.submission.toolId,
          recordId: context.submission.recordId,
        });
        const submission = aiPlanningService.approveSubmission({
          user: context.session.user,
          submissionId: context.submission.id,
          projectId: context.project.projectId,
          allowedToolIds: context.allowedToolIds,
        });
        if (!submission) {
          throw createHttpError('方案状态已变化，请刷新后重试', 409);
        }
        const rawSubmission = aiPlanningRepository.getSubmission(submission.id);
        let notificationQueuedCount = enqueueAiPlanNotifications(
          'plan_approved',
          rawSubmission,
          [toMentionableUser(context.submissionAuthor)],
          {
            project: context.project,
            workItem: context.workItem,
            reviewer: context.session.user,
          },
        );
        if (previousApproved && previousApproved.id !== rawSubmission.id) {
          notificationQueuedCount += enqueueAiPlanNotifications(
            'plan_superseded',
            previousApproved,
            [{
              openId: previousApproved.authorOpenId,
              name: previousApproved.authorName,
            }],
            {
              project: context.project,
              workItem: context.workItem,
              reviewer: context.session.user,
            },
          );
        }
        return {
          submission,
          notificationQueuedCount,
          notificationDeliveryEnabled: runtimeConfig.aiPlanning.notifications.enabled,
        };
      },
    );
    response.json(result);
  } catch (error) {
    sendAiPlanningError(response, error, '通过 AI 方案失败');
  }
}

async function handleAiPlanAppliedUpdate(request, response) {
  try {
    const initial = await getAiPlanReviewRequestContext(request);
    const result = await aiPlanMutationQueue.run(
      buildAiPlanMutationKey(initial.submission),
      async () => {
        const context = await getAiPlanReviewRequestContext(request);
        assertCanSetAiPlanApplied(context);
        const mutation = aiPlanningService.setSubmissionApplied({
          user: context.session.user,
          submissionId: context.submission.id,
          projectId: context.project.projectId,
          allowedToolIds: context.allowedToolIds,
          applied: request.body?.applied,
          clientMutationId: request.body?.clientMutationId,
        });
        if (!mutation) {
          throw createHttpError('方案不存在', 404);
        }
        return mutation;
      },
    );
    response.json(result);
  } catch (error) {
    sendAiPlanningError(response, error, '更新 AI 方案应用状态失败');
  }
}

async function handleAiPlanReject(request, response) {
  try {
    const initial = await getAiPlanReviewRequestContext(request);
    const result = await aiPlanMutationQueue.run(
      buildAiPlanMutationKey(initial.submission),
      async () => {
        const context = await getAiPlanReviewRequestContext(request);
        assertCanReviewAiPlan(context);
        const submission = aiPlanningService.rejectSubmission({
          user: context.session.user,
          submissionId: context.submission.id,
          projectId: context.project.projectId,
          allowedToolIds: context.allowedToolIds,
          reason: request.body?.reason,
        });
        if (!submission) {
          throw createHttpError('方案状态已变化，请刷新后重试', 409);
        }
        const rawSubmission = aiPlanningRepository.getSubmission(submission.id);
        const notificationQueuedCount = enqueueAiPlanNotifications(
          'plan_rejected',
          rawSubmission,
          [toMentionableUser(context.submissionAuthor)],
          {
            project: context.project,
            workItem: context.workItem,
            reviewer: context.session.user,
            reviewReason: rawSubmission.reviewReason,
          },
        );
        return {
          submission,
          notificationQueuedCount,
          notificationDeliveryEnabled: runtimeConfig.aiPlanning.notifications.enabled,
        };
      },
    );
    response.json(result);
  } catch (error) {
    sendAiPlanningError(response, error, '拒绝 AI 方案失败');
  }
}

async function handleAiPlanRevisionCreate(request, response) {
  try {
    const initial = await getAiPlanReviewRequestContext(request);
    const result = await aiPlanMutationQueue.run(
      buildAiPlanMutationKey(initial.submission),
      async () => {
        const context = await getAiPlanReviewRequestContext(request);
        assertCanEditAiPlan(context);
        const submission = aiPlanningService.createReviewRevision({
          user: context.session.user,
          submissionId: context.submission.id,
          projectId: context.project.projectId,
          allowedToolIds: context.allowedToolIds,
          title: request.body?.title,
          summary: request.body?.summary,
          markdown: request.body?.markdown,
        });
        if (!submission) {
          throw createHttpError('方案已有更新，请刷新后重试', 409);
        }
        const rawSubmission = aiPlanningRepository.getSubmission(submission.id);
        const reviewRecipients = getAiPlanReviewNotificationRecipients(
          context.workItem,
          context.projectAccess,
        );
        const reviewQueuedCount = enqueueAiPlanNotifications(
          'plan_review_requested',
          rawSubmission,
          reviewRecipients,
          {
            project: context.project,
            workItem: context.workItem,
            reviewer: context.session.user,
          },
        );
        const authorQueuedCount = enqueueAiPlanNotifications(
          'plan_edited',
          rawSubmission,
          [toMentionableUser(context.submissionAuthor)],
          {
            project: context.project,
            workItem: context.workItem,
            reviewer: context.session.user,
          },
        );
        return {
          submission,
          notificationQueuedCount: reviewQueuedCount + authorQueuedCount,
          notificationDeliveryEnabled: runtimeConfig.aiPlanning.notifications.enabled,
          reviewRecipientCount: reviewRecipients.length,
        };
      },
    );
    response.status(201).json(result);
  } catch (error) {
    sendAiPlanningError(response, error, '编辑 AI 方案失败');
  }
}

async function handleAiPlanWithdraw(request, response) {
  try {
    const context = await getAiPlanProjectRequestContext(request);
    const submissionId = String(request.params.submissionId || '').trim();
    const current = aiPlanningService.getSubmission({
      user: context.session.user,
      submissionId,
      projectId: context.project.projectId,
      allowedToolIds: context.allowedToolIds,
    });
    if (!current) {
      throw createHttpError('方案不存在', 404);
    }
    if (!current.isOwnPlan) {
      throw createHttpError('只能撤回自己提交的方案', 403);
    }
    const revisions = aiPlanningService.getSubmissionRevisions({
      user: context.session.user,
      submissionId,
      projectId: context.project.projectId,
      allowedToolIds: context.allowedToolIds,
    });
    if (revisions[0]?.id !== current.id || current.status !== AI_PLAN_STATUSES.PENDING_REVIEW) {
      throw createHttpError('只能撤回最新的待审核方案', 409);
    }
    const submission = aiPlanningService.withdrawSubmission({
      user: context.session.user,
      submissionId,
      projectId: context.project.projectId,
      allowedToolIds: context.allowedToolIds,
    });
    if (!submission) {
      throw createHttpError('方案状态已变化，请刷新后重试', 409);
    }
    response.json({ submission });
  } catch (error) {
    sendAiPlanningError(response, error, '撤回 AI 方案失败');
  }
}

async function getAiWorkItemRequestContext(request, { loadWorkItem = false } = {}) {
  validateProjectBaseConfig();
  validateProjectPermissionConfig();
  validateToolPermissionConfig();
  validateKnowledgeBaseConfig();
  validateAiPlanningConfig();
  if (!appId || !appSecret) {
    throw createHttpError('缺少飞书应用配置', 500);
  }
  const session = getSession(request);
  if (!session) {
    throw createHttpError('请先登录飞书', 401);
  }
  const projectId = String(request.params.projectId || '').trim();
  const toolId = String(request.params.toolId || '').trim();
  const recordId = String(request.params.recordId || '').trim();
  if (!projectId || !toolId || !recordId) {
    throw createHttpError('缺少 AI 计划关联信息', 400);
  }
  if (!isAiPlanningWorkItemTool(toolId)) {
    throw createHttpError('AI 计划只支持需求和 Bug', 400);
  }
  const token = await getTenantAccessToken();
  const { project, projectAccess } = await getAuthorizedProjectAccess(
    token,
    projectId,
    session.user,
    toolId,
  );
  if (!projectAccess.allowedToolIds.has(AI_PLAN_TOOL_ID)) {
    throw createHttpError('当前项目未启用 AI 计划', 404);
  }
  const workItem = loadWorkItem
    ? await loadAiPlanningWorkItem(token, project, session.user, toolId, recordId)
    : null;
  return {
    token,
    session,
    project,
    projectAccess,
    toolId,
    recordId,
    workItem,
  };
}

async function getAiConversationRequestContext(request, { loadWorkItem = false } = {}) {
  validateProjectBaseConfig();
  validateProjectPermissionConfig();
  validateToolPermissionConfig();
  validateKnowledgeBaseConfig();
  const session = getSession(request);
  if (!session) {
    throw createHttpError('请先登录飞书', 401);
  }
  const conversationId = String(request.params.conversationId || '').trim();
  if (!conversationId) {
    throw createHttpError('缺少对话ID', 400);
  }
  const conversation = aiPlanningService.getConversation({
    user: session.user,
    conversationId,
  });
  if (!conversation) {
    throw createHttpError('对话不存在', 404);
  }
  const token = await getTenantAccessToken();
  const { project, projectAccess } = await getAuthorizedProjectAccess(
    token,
    conversation.projectId,
    session.user,
    conversation.toolId,
  );
  const workItem = loadWorkItem
    ? await loadAiPlanningWorkItem(
        token,
        project,
        session.user,
        conversation.toolId,
        conversation.recordId,
      )
    : null;
  return {
    token,
    session,
    project,
    projectAccess,
    conversation,
    workItem,
  };
}

async function getAiPlanProjectRequestContext(request) {
  validateProjectBaseConfig();
  validateProjectPermissionConfig();
  validateToolPermissionConfig();
  validateAiPlanningConfig();
  const session = getSession(request);
  if (!session) {
    throw createHttpError('请先登录飞书', 401);
  }
  const projectId = String(request.params.projectId || '').trim();
  if (!projectId) {
    throw createHttpError('缺少项目ID', 400);
  }
  const token = await getTenantAccessToken();
  const { project, projectAccess } = await getAuthorizedProjectAccess(
    token,
    projectId,
    session.user,
    AI_PLAN_TOOL_ID,
  );
  const allowedToolIds = getAllowedAiPlanToolIds(projectAccess.allowedToolIds);
  if (allowedToolIds.length === 0) {
    throw createHttpError('没有可查看的需求或 Bug 方案', 403);
  }
  return {
    token,
    session,
    project,
    projectAccess,
    allowedToolIds,
  };
}

async function getAiPlanReviewRequestContext(request) {
  const context = await getAiPlanProjectRequestContext(request);
  return buildAiPlanReviewContext(context, request.params.submissionId);
}

async function getAiPlanDeleteRequestContext(request) {
  const context = await getAiPlanProjectRequestContext(request);
  const submissionId = String(request.params.submissionId || '').trim();
  const submission = aiPlanningRepository.getSubmission(submissionId);
  if (
    !submission
    || submission.projectId !== context.project.projectId
    || !context.allowedToolIds.includes(submission.toolId)
  ) {
    throw createHttpError('方案不存在', 404);
  }
  return {
    ...context,
    submission,
  };
}

async function buildAiPlanReviewContext(context, submissionIdValue) {
  const submissionId = String(submissionIdValue || '').trim();
  const submission = aiPlanningRepository.getSubmission(submissionId);
  if (
    !submission
    || submission.projectId !== context.project.projectId
    || !context.allowedToolIds.includes(submission.toolId)
  ) {
    throw createHttpError('方案不存在', 404);
  }
  const workItem = await tryLoadAiPlanReviewWorkItem(
    context.token,
    context.project,
    context.session.user,
    submission,
  );
  const revisions = aiPlanningRepository.listSubmissionRevisions(
    submission.rootSubmissionId,
  );
  const isLatestRevision = revisions[0]?.id === submission.id;
  const canReview = canReviewAiPlan({
    projectAccess: context.projectAccess,
    workItem,
    user: context.session.user,
  });
  return {
    ...context,
    submission,
    submissionAuthor: {
      openId: submission.authorOpenId,
      name: submission.authorName,
    },
    workItem,
    revisions,
    isLatestRevision,
    canReview,
  };
}

async function buildAiPlanDetailResponse(context, submissionId) {
  const requestContext = await buildAiPlanReviewContext(context, submissionId);
  const submission = aiPlanningService.getSubmission({
    user: context.session.user,
    submissionId: requestContext.submission.id,
    projectId: context.project.projectId,
    allowedToolIds: context.allowedToolIds,
  });
  const revisions = aiPlanningService.getSubmissionRevisions({
    user: context.session.user,
    submissionId: requestContext.submission.id,
    projectId: context.project.projectId,
    allowedToolIds: context.allowedToolIds,
  });
  const events = aiPlanningService.getSubmissionEvents({
    submissionId: requestContext.submission.id,
    projectId: context.project.projectId,
    allowedToolIds: context.allowedToolIds,
  });
  return {
    submission,
    revisions,
    events,
    permissions: buildAiPlanPermissions(requestContext, submission),
    workItem: buildSharedAiPlanWorkItem(requestContext.workItem, requestContext.submission),
  };
}

async function tryLoadAiPlanReviewWorkItem(token, project, user, submission) {
  try {
    return await loadAiPlanningWorkItem(
      token,
      project,
      user,
      submission.toolId,
      submission.recordId,
    );
  } catch (error) {
    const message = String(error?.message || '');
    if (Number(error?.statusCode) === 404 || message.includes('不存在')) {
      return null;
    }
    throw error;
  }
}

function canReviewAiPlan({ projectAccess, workItem, user }) {
  if (canManageAiPlans(projectAccess)) {
    return true;
  }
  return Boolean(
    workItem?._aiReviewAssignees?.some((assignee) => isSameUser(assignee, user)),
  );
}

function buildAiPlanPermissions(context, submission) {
  const isPending = submission?.status === AI_PLAN_STATUSES.PENDING_REVIEW;
  const isApproved = submission?.status === AI_PLAN_STATUSES.APPROVED;
  return {
    canApprove: Boolean(context.canReview && context.isLatestRevision && isPending),
    canReject: Boolean(context.canReview && context.isLatestRevision && isPending),
    canEdit: Boolean(
      context.canReview
      && context.isLatestRevision
      && ![AI_PLAN_STATUSES.WITHDRAWN, AI_PLAN_STATUSES.SUPERSEDED]
        .includes(submission?.status),
    ),
    canWithdraw: Boolean(
      submission?.isOwnPlan
      && context.isLatestRevision
      && isPending,
    ),
    canDelete: canDeleteAiPlan(context, submission),
    canSetApplied: Boolean(context.canReview && context.workItem && isApproved),
  };
}

function buildSharedAiPlanWorkItem(workItem, submission) {
  return {
    exists: Boolean(workItem),
    recordId: submission.recordId,
    itemId: workItem?.itemId || submission.workItemId || '',
    title: workItem?.title || submission.workItemTitle || '',
    status: workItem?.status || '',
  };
}

function assertCanReviewAiPlan(context) {
  if (!context.canReview) {
    throw createHttpError('只有当前处理人、研发超级管理员或超级管理员可以审核方案', 403);
  }
  if (
    !context.isLatestRevision
    || context.submission.status !== AI_PLAN_STATUSES.PENDING_REVIEW
  ) {
    throw createHttpError('只能审核最新的待审核方案', 409);
  }
}

function assertCanEditAiPlan(context) {
  if (!context.canReview) {
    throw createHttpError('只有当前处理人、研发超级管理员或超级管理员可以编辑方案', 403);
  }
  if (
    !context.isLatestRevision
    || [AI_PLAN_STATUSES.WITHDRAWN, AI_PLAN_STATUSES.SUPERSEDED]
      .includes(context.submission.status)
  ) {
    throw createHttpError('只能编辑修订链中的最新有效方案', 409);
  }
}

function assertCanSetAiPlanApplied(context) {
  if (!context.workItem) {
    throw createHttpError('原工作项不存在，无法修改已应用状态', 409);
  }
  if (!context.canReview) {
    throw createHttpError('只有当前处理人、研发超级管理员或超级管理员可以修改已应用状态', 403);
  }
  if (context.submission.status !== AI_PLAN_STATUSES.APPROVED) {
    throw createHttpError('只有已通过的 AI 方案可以设置已应用状态', 409);
  }
}

function assertCanDeleteAiPlan(context) {
  if (!canDeleteAiPlan(context, context.submission)) {
    throw createHttpError('只有原提交者、研发超级管理员或超级管理员可以删除方案', 403);
  }
}

function canDeleteAiPlan(context, submission) {
  const userOpenId = String(context.session?.user?.openId || '').trim();
  return Boolean(
    canManageAiPlans(context.projectAccess)
    || submission?.isOwnPlan
    || (userOpenId && submission?.authorOpenId === userOpenId),
  );
}

function buildAiPlanMutationKey(submission) {
  return [
    submission.projectId,
    submission.toolId,
    submission.recordId,
  ].join(':');
}

async function loadAiPlanningWorkItem(token, project, user, toolId, recordId) {
  const toolConfig = getWorkItemToolConfig(toolId);
  const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
  const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
  const record = await fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig);
  const item = normalizeWorkItemRecords([record], user, toolConfig)[0] || null;
  if (!item) {
    throw createHttpError(toolConfig.missingRecordText, 404);
  }
  const attachmentSources = [
    ...normalizeBitableAttachmentListValue(
      item.rawFields?.[toolConfig.fieldNames.attachments],
    ).map((attachment) => ({
      ...attachment,
      category: 'work_item',
      tableId,
    })),
    ...(toolId === 'requirements'
      ? normalizeBitableAttachmentListValue(
          item.rawFields?.[toolConfig.fieldNames.submittedAttachments],
        ).map((attachment) => ({
          ...attachment,
          category: 'submission',
          tableId,
        }))
      : []),
  ];
  return sanitizeAiWorkItemContext({
    recordId: item.recordId,
    itemId: item.itemId || item[toolConfig.itemIdKey] || '',
    title: item.title || toolConfig.unnamedTitle,
    description: item.description || '',
    priority: item.priority || '',
    status: item.itemStatus || item.requirementStatus || '',
    expectedDays: item.expectedDays,
    remainingDays: item.remainingDays,
    assignees: item.assignees,
    proposers: item.proposers,
    comments: item.comments,
    rawFields: item.rawFields,
    attachments: attachmentSources.map(({ fileToken: _fileToken, tableId: _tableId, ...attachment }) => attachment),
    _aiAttachmentSources: attachmentSources,
    _aiReviewAssignees: item.assignees,
  });
}

function sanitizeAiWorkItemContext(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 200).map(sanitizeAiWorkItemContext);
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, 20_000) : value;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '_aiAttachmentSources' || key === '_aiReviewAssignees') {
      result[key] = item;
      continue;
    }
    if (/^(openId|open_id|unionId|userId|avatarUrl|fileToken|tmpUrl|downloadUrl)$/i.test(key)) {
      continue;
    }
    result[key] = sanitizeAiWorkItemContext(item);
  }
  return result;
}

function canManageAiPlans(projectAccess) {
  return Boolean(projectAccess?.isSuperAdmin || projectAccess?.isDevelopmentSuperAdmin);
}

function sendAiPlanningError(response, error, fallbackMessage) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const status = Number(error?.statusCode) || (
    message.includes('请先登录')
      ? 401
      : message.includes('权限') || message.includes('只能') || message.includes('只有')
        ? 403
        : message.includes('不存在') || message.includes('未启用') || message.includes('未配置')
          ? 404
          : message.includes('正在') || message.includes('已变化') || message.includes('采纳')
            ? 409
            : message.includes('缺少') || message.includes('格式') || message.includes('不能超过') || message.includes('不能为空') || message.includes('只支持')
              ? 400
              : 502
  );
  response.status(status).json({
    message,
    ...(error?.publicDetails || {}),
  });
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

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

async function handlePersonalSettingsRead(request, response) {
  try {
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
    await ensureUserHasPlatformAccess(token, session.user);
    const settings = await readPersonalSettingsForUser(token, session.user);
    response.json({
      settings,
      mcp: {
        serverUrls: getMcpServerUrls(port, getRequestOrigin(request)),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取个人设置失败';
    response.status(getPersonalSettingsErrorStatus(error, message)).json({ message });
  }
}

async function handlePersonalSettingsUpdate(request, response) {
  try {
    if (!appId || !appSecret) {
      response.status(500).json({ message: '缺少飞书应用配置' });
      return;
    }

    const session = getSession(request);
    if (!session) {
      response.status(401).json({ message: '请先登录飞书' });
      return;
    }

    const notifications = request.body?.notifications;
    if (!notifications || typeof notifications !== 'object') {
      response.status(400).json({ message: '缺少通知设置' });
      return;
    }
    if (typeof notifications.receiveTodoNotifications !== 'boolean') {
      response.status(400).json({ message: '接收待办事项通知必须是开关值' });
      return;
    }
    if (!isValidTodoNotificationTime(notifications.todoNotificationTime)) {
      response.status(400).json({ message: '待办事项通知时间必须是 HH:mm 格式' });
      return;
    }

    const token = await getTenantAccessToken();
    await ensureUserHasPlatformAccess(token, session.user);
    const settings = await savePersonalSettingsForUser(token, session.user, { notifications });
    response.json({ settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存个人设置失败';
    response.status(getPersonalSettingsErrorStatus(error, message)).json({ message });
  }
}

async function handlePersonalSettingsEnsure(request, response) {
  try {
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
    await ensureUserHasPlatformAccess(token, session.user);
    const result = await ensurePersonalSettingsForUser(token, session.user);
    response.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '初始化个人设置失败';
    response.status(getPersonalSettingsErrorStatus(error, message)).json({ message });
  }
}

async function handleDevelopmentPlatformTokenRegenerate(request, response) {
  try {
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
    await ensureUserHasPlatformAccess(token, session.user);
    const settings = await regenerateDevelopmentPlatformTokenForUser(token, session.user);
    response.json({ settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成开发平台令牌失败';
    response.status(getPersonalSettingsErrorStatus(error, message)).json({ message });
  }
}

async function authenticateDevelopmentPlatformMcpRequest(developmentPlatformToken) {
  if (!appId || !appSecret) {
    throw new Error('缺少飞书应用配置');
  }
  const token = await getTenantAccessToken();
  const user = await resolveUserByDevelopmentPlatformToken(
    token,
    developmentPlatformToken,
  );
  return user ? { token, user } : null;
}

async function executeDevelopmentPlatformMcpTool(context) {
  return developmentPlatformMcpService.execute(context);
}

async function loadDevelopmentPlatformMcpWorkItemDetail({
  token,
  user,
  projectId,
  toolId,
  recordId,
}) {
  return runMcpOperation(async () => {
    const toolConfig = getWorkItemToolConfig(toolId);
    const { project } = await getAuthorizedProjectAccess(token, projectId, user, toolId);
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const record = await fetchWorkItemRecordById(
      token,
      appToken,
      tableId,
      recordId,
      toolConfig,
    );
    const item = normalizeWorkItemRecords([record], user, toolConfig)[0] || null;
    if (!item) {
      throw createHttpError(toolConfig.missingRecordText, 404);
    }
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      toolId,
      toolName: toolConfig.itemLabel,
      item: serializeDevelopmentPlatformMcpWorkItem(item, toolConfig),
    };
  }, `获取${getWorkItemToolConfig(toolId).itemLabel}详情失败`);
}

async function loadDevelopmentPlatformMcpProjectOverview({
  token,
  user,
  projectId,
  scope,
  trendDays,
}) {
  return runMcpOperation(async () => ({
    projectId,
    scope,
    trendDays,
    overview: await loadProjectOverviewData({
      token,
      user,
      projectId,
      scope,
      trendDays,
    }),
  }), '获取项目总览失败');
}

async function loadDevelopmentPlatformMcpVersionOverview({
  token,
  user,
  projectId,
}) {
  return runMcpOperation(async () => {
    const { project } = await getAuthorizedProjectAccess(
      token,
      projectId,
      user,
      VERSION_MANAGEMENT_TOOL_ID,
    );
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      overview: await versionManagementService.readOverview(token, project.projectId),
    };
  }, '获取项目版本总览失败');
}

async function addDevelopmentPlatformMcpWorkItemComment({
  token,
  user,
  projectId,
  toolId,
  recordId,
  content,
  mentionedUserOpenIds,
  notifyMentioned,
  clientMutationId,
}) {
  return runMcpOperation(async () => {
    const { projectAccess } = await getAuthorizedProjectAccess(
      token,
      projectId,
      user,
      toolId,
    );
    const mentionedUsers = resolveMentionedUsersByOpenIds(
      mentionedUserOpenIds,
      projectAccess.mentionableUsersByTool[toolId] || [],
    );
    const result = await executeWorkItemCommentMutation({
      token,
      user,
      projectId,
      toolId,
      recordId,
      content,
      mentionedUsers,
      requestedMentionedUserOpenIds: mentionedUserOpenIds,
      notifyMentioned,
      clientMutationId,
    });
    return {
      comment: result.comment,
      acceptedMentionedUserOpenIds: result.acceptedMentionedUserOpenIds,
      ignoredMentionedUserOpenIds: result.ignoredMentionedUserOpenIds,
      notifications: summarizeNotificationResults(result.notificationResults),
      duplicate: result.duplicate,
    };
  }, '添加工作项留言失败');
}

async function submitDevelopmentPlatformMcpAiPlan({
  token,
  user,
  projectId,
  toolId,
  recordId,
  title,
  summary,
  markdown,
  sourceReferences,
  clientMutationId,
}) {
  return runMcpOperation(
    () => aiPlanMutationQueue.run(
      [projectId, toolId, recordId].join(':'),
      async () => {
        const { project, projectAccess } = await getAuthorizedProjectAccess(
          token,
          projectId,
          user,
          toolId,
        );
        if (!projectAccess.allowedToolIds.has(AI_PLAN_TOOL_ID)) {
          throw createHttpError('当前项目未启用 AI 计划', 404);
        }
        const workItem = await loadAiPlanningWorkItem(
          token,
          project,
          user,
          toolId,
          recordId,
        );
        const result = aiPlanningService.createExternalSubmission({
          user,
          projectId,
          toolId,
          recordId,
          title,
          summary,
          markdown,
          sourceReferences,
          clientMutationId,
          workItem,
          project,
        });
        let notificationQueuedCount = 0;
        let reviewRecipientCount = 0;
        if (!result.duplicate) {
          const rawSubmission = aiPlanningRepository.getSubmission(
            result.submission.id,
          );
          const reviewRecipients = getAiPlanReviewNotificationRecipients(
            workItem,
            projectAccess,
          );
          reviewRecipientCount = reviewRecipients.length;
          notificationQueuedCount = enqueueAiPlanNotifications(
            'plan_review_requested',
            rawSubmission,
            reviewRecipients,
            { project, workItem },
          );
        }
        return {
          submission: result.submission,
          duplicate: result.duplicate,
          notificationQueuedCount,
          notificationDeliveryEnabled: runtimeConfig.aiPlanning.notifications.enabled,
          reviewRecipientCount,
        };
      },
    ),
    '提交 AI 方案失败',
  );
}

async function setDevelopmentPlatformMcpAiPlanApplied({
  token,
  user,
  submissionId,
  applied,
  clientMutationId,
}) {
  return runMcpOperation(
    async () => {
      const initial = await mcpAiPlanService.getMyApprovedPlan({
        token,
        user,
        submissionId,
      });
      const initialSubmission = aiPlanningRepository.getSubmission(
        initial.plan.submissionId,
      );
      if (!initialSubmission) {
        throw createHttpError('AI 计划不存在或不再属于当前用户', 404);
      }
      return aiPlanMutationQueue.run(
        buildAiPlanMutationKey(initialSubmission),
        async () => {
          const current = await mcpAiPlanService.getMyApprovedPlan({
            token,
            user,
            submissionId,
          });
          const rawSubmission = aiPlanningRepository.getSubmission(
            current.plan.submissionId,
          );
          if (!rawSubmission) {
            throw createHttpError('AI 计划不存在或不再属于当前用户', 404);
          }
          const result = aiPlanningService.setSubmissionApplied({
            user,
            submissionId: rawSubmission.id,
            projectId: rawSubmission.projectId,
            allowedToolIds: [rawSubmission.toolId],
            applied,
            clientMutationId,
          });
          if (!result) {
            throw createHttpError('AI 计划不存在或不再属于当前用户', 404);
          }
          return result;
        },
      );
    },
    '更新 AI 计划应用状态失败',
  );
}

async function addDevelopmentPlatformMcpVersionComment({
  token,
  user,
  projectId,
  recordId,
  content,
  mentionedUserOpenIds,
  notifyMentioned,
  clientMutationId,
}) {
  return runMcpOperation(async () => {
    const { projectAccess } = await getAuthorizedProjectAccess(
      token,
      projectId,
      user,
      VERSION_MANAGEMENT_TOOL_ID,
    );
    const mentionedUsers = resolveMentionedUsersByOpenIds(
      mentionedUserOpenIds,
      projectAccess.mentionableUsersByTool.versions || [],
    );
    const result = await executeVersionCommentMutation({
      token,
      user,
      projectId,
      recordId,
      content,
      mentionedUsers,
      requestedMentionedUserOpenIds: mentionedUserOpenIds,
      notifyMentioned,
      clientMutationId,
    });
    return {
      comment: serializeDevelopmentPlatformMcpVersionComment(result.comment),
      version: {
        recordId: result.version.recordId,
        versionNumber: result.version.versionNumber,
        platform: result.version.platform,
        status: result.version.status,
      },
      acceptedMentionedUserOpenIds: result.acceptedMentionedUserOpenIds,
      ignoredMentionedUserOpenIds: result.ignoredMentionedUserOpenIds,
      notifications: summarizeNotificationResults(result.notificationResults),
      warnings: result.warnings,
      duplicate: result.duplicate,
    };
  }, '添加版本留言失败');
}

async function updateDevelopmentPlatformMcpWorkItemStatus({
  token,
  user,
  projectId,
  toolId,
  recordId,
  expectedCurrentStatus,
  newStatus,
  message,
  notifyProposer,
  confirmWithoutRequiredAttachment,
  versionAssociationDecision,
  clientMutationId,
}) {
  return runMcpOperation(async () => {
    const toolConfig = getWorkItemToolConfig(toolId);
    const result = await executeWorkItemStatusMutation({
      token,
      user,
      projectId,
      toolId,
      recordId,
      expectedCurrentStatus,
      newStatus,
      message,
      notifyProposer,
      confirmWithoutRequiredAttachment,
      versionAssociationDecision,
      clientMutationId,
      requireVersionAssociationDecision: true,
    });
    return {
      item: serializeDevelopmentPlatformMcpWorkItem(result.item, toolConfig),
      statusChange: result.statusChange,
      notifications: summarizeNotificationResults(result.notificationResults),
      versionAssociation: result.versionAssociation,
      duplicate: result.duplicate,
    };
  }, '更新工作项状态失败');
}

function serializeDevelopmentPlatformMcpWorkItem(item, toolConfig) {
  const rawFields = item?.rawFields && typeof item.rawFields === 'object'
    ? item.rawFields
    : {};
  const regularAttachments = normalizeBitableAttachmentListValue(
    rawFields[toolConfig.fieldNames.attachments],
  ).map((attachment) => serializeDevelopmentPlatformMcpAttachment(
    attachment,
    'work_item',
  ));
  const submissionAttachments = toolConfig.toolId === 'requirements'
    ? normalizeBitableAttachmentListValue(
        rawFields[toolConfig.fieldNames.submittedAttachments],
      ).map((attachment) => serializeDevelopmentPlatformMcpAttachment(
        attachment,
        'submission',
      ))
    : [];
  return {
    recordId: String(item?.recordId || ''),
    itemId: String(item?.itemId || ''),
    title: String(item?.title || toolConfig.unnamedTitle),
    description: String(item?.description || ''),
    priority: String(item?.priority || ''),
    status: String(item?.itemStatus || item?.requirementStatus || ''),
    assignees: serializeDevelopmentPlatformMcpUsers(item?.assignees),
    proposers: serializeDevelopmentPlatformMcpUsers(item?.proposers),
    proposedAt: item?.proposedAt || null,
    expectedDays: item?.expectedDays ?? null,
    remainingDays: item?.remainingDays ?? null,
    channel: String(item?.channel || ''),
    requiresSubmissionAttachment: Boolean(item?.requiresSubmissionAttachment),
    comments: Array.isArray(item?.comments) ? item.comments : [],
    commentsParseError: String(item?.commentsParseError || ''),
    statusChangeLog: Array.isArray(item?.statusChangeLog) ? item.statusChangeLog : [],
    statusChangeLogParseError: String(item?.statusChangeLogParseError || ''),
    attachments: [...regularAttachments, ...submissionAttachments],
  };
}

function serializeDevelopmentPlatformMcpAttachment(attachment, category) {
  return {
    category,
    name: String(attachment?.name || '附件'),
    size: Number(attachment?.size || 0),
    mimeType: String(attachment?.mimeType || ''),
  };
}

function serializeDevelopmentPlatformMcpUsers(users) {
  return (Array.isArray(users) ? users : []).map((user) => ({
    openId: String(user?.openId || user?.open_id || ''),
    userId: String(user?.userId || user?.user_id || ''),
    unionId: String(user?.unionId || user?.union_id || ''),
    email: String(user?.email || ''),
    name: String(user?.name || ''),
  })).filter((user) => user.openId || user.userId || user.unionId || user.email);
}

function serializeDevelopmentPlatformMcpVersionComment(comment) {
  return {
    id: String(comment?.id || ''),
    authorOpenId: String(comment?.authorOpenId || ''),
    authorName: String(comment?.authorName || ''),
    createdAt: String(comment?.createdAt || ''),
    content: String(comment?.content || ''),
    mentionedOpenIds: normalizeOpenIdList(comment?.mentionedOpenIds),
    mentionedUsers: normalizeMentionedUsers(comment?.mentionedUsers),
  };
}

function resolveMentionedUsersByOpenIds(openIds, candidates) {
  const requested = new Set(normalizeOpenIdList(openIds));
  return normalizeMentionedUsers(candidates)
    .filter((candidate) => requested.has(candidate.openId));
}

function summarizeNotificationResults(results) {
  const source = Array.isArray(results) ? results : [];
  return {
    requestedCount: source.length,
    succeededCount: source.filter((item) => item?.ok).length,
    failedCount: source.filter((item) => !item?.ok).length,
  };
}

async function runMcpOperation(task, fallbackMessage) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof McpToolExecutionError || error?.mcpCode) {
      throw error;
    }
    const statusCode = Number(error?.statusCode);
    const message = String(error?.message || fallbackMessage);
    if (statusCode === 400) {
      throw new McpToolExecutionError('invalid_argument', message, error?.publicDetails);
    }
    if (statusCode === 403 || message.includes('权限') || message.includes('只有')) {
      throw new McpToolExecutionError('forbidden', message);
    }
    if (statusCode === 404 || message.includes('不存在') || message.includes('尚未初始化')) {
      throw new McpToolExecutionError('not_found', message);
    }
    if (statusCode === 409 || message.includes('JSON') || message.includes('已变化')) {
      throw new McpToolExecutionError('conflict', message, error?.publicDetails);
    }
    throw new McpToolExecutionError('dependency_unavailable', fallbackMessage);
  }
}

function buildWorkItemMutationKey(projectId, toolId, recordId) {
  return ['work-item', projectId, toolId, recordId].join(':');
}

function buildWorkItemTableMutationKey(projectId, toolId) {
  return ['work-item', projectId, toolId, 'table'].join(':');
}

function getRequestOrigin(request) {
  const hostHeader = String(request.get?.('host') || request.headers?.host || '').trim();
  return hostHeader ? `${request.protocol || 'http'}://${hostHeader}` : '';
}

function getPersonalSettingsErrorStatus(error, message) {
  if (error?.code === 'DUPLICATE_PERSONAL_SETTINGS') {
    return 409;
  }
  if (message.includes('没有权限')) {
    return 403;
  }
  if (
    message.includes('缺少')
    || message.includes('必须是')
    || message.includes('不是多维表格')
    || message.includes('没有可读取')
  ) {
    return 500;
  }
  return 502;
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
      const counts = Object.fromEntries(await Promise.all(
        [...WORK_ITEM_TOOL_IDS].map(async (toolId) => [
          toolId,
          allowedToolIds.has(toolId)
            ? await getProjectWaitingWorkItemCount(
                token,
                project,
                session.user,
                getWorkItemToolConfig(toolId),
              )
            : 0,
        ]),
      ));

      return [project.projectId, counts];
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
    const result = await loadProjectOverviewData({
      token,
      user: session.user,
      projectId,
      scope,
      trendDays,
    });

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

async function loadProjectOverviewData({
  token,
  user,
  projectId,
  scope,
  trendDays,
}) {
  const { project, projectAccess } = await getAuthorizedProjectAccess(
    token,
    projectId,
    user,
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
    user,
  });
  return getCachedValue(
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
            user,
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
      let versions = null;
      try {
        versions = await versionManagementService.readOverview(token, project.projectId);
      } catch (error) {
        versions = {
          initialized: false,
          platforms: [],
          recentFormalReleases: [],
          warnings: [error instanceof Error ? error.message : '读取版本信息失败'],
        };
      }
      const overview = buildProjectOverviewData({
        toolItems,
        currentUser: user,
        scope,
        trendDays,
        config: runtimeConfig.dashboard,
        unavailableTools: toolResults.map((item) => item.unavailable).filter(Boolean),
      });
      return {
        ...overview,
        versions,
      };
    },
  );
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

async function createWorkItemForAssistant({
  user,
  projectId,
  toolId,
  draft,
  sourceMutationId = '',
}) {
  const toolConfig = getWorkItemToolConfig(toolId);
  validateProjectBaseConfig();
  validateProjectPermissionConfig();
  validateKnowledgeBaseConfig();

  if (!appId || !appSecret) {
    throw new Error('缺少飞书应用配置');
  }

  const title = String(draft?.title || '').trim();
  const description = String(draft?.description || '').trim();
  const priority = String(draft?.priority || 'P4').trim();
  const assignees = normalizeMentionedUsers(draft?.assignees || []);
  const needsAssigneeAssignment = supportsUnassignedWorkItemRouting(toolId)
    && draft?.needsAssigneeAssignment === true;
  const expectedDays = normalizeNumberValue(draft?.expectedDays);
  if (!title || !description) {
    throw new Error(`${toolConfig.itemLabel}标题和描述不能为空`);
  }
  if (title.length > 200 || description.length > 5000) {
    throw new Error(`${toolConfig.itemLabel}内容超过允许长度`);
  }
  if (expectedDays !== null && expectedDays < 0) {
    throw new Error('期望时限不能小于0');
  }
  const assignmentError = validateWorkItemAssignmentChoice({
    toolId,
    assignees,
    needsAssigneeAssignment,
  });
  if (assignmentError) {
    throw new Error(assignmentError);
  }

  const token = await getTenantAccessToken();
  const { project, projectAccess } = await getAuthorizedProjectAccess(
    token,
    String(projectId || '').trim(),
    user,
    toolId,
  );
  if (needsAssigneeAssignment && projectAccess.developmentSuperAdmins.length === 0) {
    throw new Error('项目权限表未配置研发超级管理员，暂时无法提交未指定处理人的工作项');
  }
  const allowedAssignees = filterMentionedUsersByCandidates(
    assignees,
    projectAccess.mentionableUsersByTool[toolId] || [],
  );
  if (allowedAssignees.length !== assignees.length) {
    throw new Error('处理人员不在可选范围内');
  }

  await ensureProjectWorkItemBitable(token, project, user, toolConfig);
  const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
  const { appToken, tableId } = await getCachedWorkItemTableContext(token, node, toolConfig);
  let fields = await ensureCachedBitableTextField(
    token,
    appToken,
    tableId,
    toolConfig.fieldNames.comments,
  );
  ({ fields } = await ensureWorkItemStatusOptions(token, { appToken, tableId }, toolConfig));
  validateWorkItemTableSchema(fields, toolConfig);

  const result = await workItemTableMutationQueue.run(
    buildWorkItemTableMutationKey(project.projectId, toolId),
    async () => {
      const currentRecords = await fetchBitableRecords(token, {
        appToken,
        tableId,
        viewId: '',
        fieldNames: {},
      }, { consistency: 'fresh' });
      const existing = findWorkItemBySourceMutationId(
        currentRecords,
        toolConfig.fieldNames.comments,
        sourceMutationId,
      );
      if (existing) {
        return { createdRecord: existing, nextRecords: currentRecords, duplicate: true };
      }
      const createdRecord = await createWorkItemRecord(token, {
        appToken,
        tableId,
        records: currentRecords,
        fields,
        toolConfig,
        user,
        payload: {
          title,
          description,
          priority,
          assignees: allowedAssignees,
          requiresSubmissionAttachment: false,
          expectedDays,
          contactInfo: null,
          attachments: [],
          sourceMutationId,
        },
      });
      const nextRecords = await fetchBitableRecords(token, {
        appToken,
        tableId,
        viewId: '',
        fieldNames: {},
      }, { consistency: 'fresh' });
      return { createdRecord, nextRecords, duplicate: false };
    },
  );
  const createdRecordId = String(
    result.createdRecord?.record_id || result.createdRecord?.recordId || result.createdRecord?.id || '',
  );
  const item = normalizeWorkItemRecords(result.nextRecords, user, toolConfig)
    .find((candidate) => candidate.recordId === createdRecordId)
    || normalizeWorkItemRecords([result.createdRecord], user, toolConfig)[0]
    || null;
  const notificationResults = !result.duplicate && item
    ? await notifyWorkItemCreationRecipients(
      token,
      needsAssigneeAssignment ? projectAccess.developmentSuperAdmins : allowedAssignees,
      {
        project,
        item,
        submitter: user,
        toolConfig,
        needsAssigneeAssignment,
      },
    )
    : [];
  if (!result.duplicate && createdRecordId) {
    publishWorkItemUpdated({
      projectId: project.projectId,
      toolId,
      recordId: createdRecordId,
    });
  }
  return {
    project,
    item,
    duplicate: result.duplicate,
    notificationResults,
  };
}

function findWorkItemBySourceMutationId(records, commentsFieldName, sourceMutationId) {
  const mutationId = String(sourceMutationId || '').trim();
  if (!mutationId) {
    return null;
  }
  return (Array.isArray(records) ? records : []).find((record) => {
    const document = parseCommentsDocument(record?.fields?.[commentsFieldName], false);
    return document.internal?.sourceMutationIds?.includes(mutationId);
  }) || null;
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
    let fields = await ensureCachedBitableTextField(
      token,
      appToken,
      tableId,
      toolConfig.fieldNames.comments,
    );
    ({ fields } = await ensureWorkItemStatusOptions(token, { appToken, tableId }, toolConfig));
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
    const { createdRecord, nextRecords } = await workItemTableMutationQueue.run(
      buildWorkItemTableMutationKey(project.projectId, toolId),
      async () => {
        const currentRecords = await fetchBitableRecords(token, {
          appToken,
          tableId,
          viewId: '',
          fieldNames: {},
        }, { consistency: 'fresh' });
        const createdRecord = await createWorkItemRecord(token, {
          appToken,
          tableId,
          records: currentRecords,
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
        }, { consistency: 'fresh' });
        return { createdRecord, nextRecords };
      },
    );
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
    return workItemMutationQueue.run(
      buildWorkItemMutationKey(project.projectId, toolId, recordId),
      async () => {
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const [fields, record] = await Promise.all([
      fetchCachedBitableFields(token, appToken, tableId),
      fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig, { consistency: 'fresh' }),
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
    const updatedRecord = await fetchWorkItemRecordById(
      token,
      appToken,
      tableId,
      recordId,
      toolConfig,
      { consistency: 'fresh' },
    );
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
      },
    );
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

    return workItemMutationQueue.run(
      buildWorkItemMutationKey(project.projectId, toolId, recordId),
      async () => {
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    await fetchWorkItemRecordById(
      token,
      appToken,
      tableId,
      recordId,
      toolConfig,
      { consistency: 'fresh' },
    );
    await deleteBitableRecord(token, appToken, tableId, recordId);

    const nextRecords = await fetchBitableRecords(token, {
      appToken,
      tableId,
      viewId: '',
      fieldNames: {},
    }, { consistency: 'fresh' });
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
      },
    );
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
    return workItemMutationQueue.run(
      buildWorkItemMutationKey(project.projectId, 'requirements', recordId),
      async () => {
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    await ensureBitableTextField(token, appToken, tableId, toolConfig.fieldNames.comments);
    const [statusSchema, record] = await Promise.all([
      ensureWorkItemStatusOptions(token, { appToken, tableId }, toolConfig),
      fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig, { consistency: 'fresh' }),
    ]);
    const fields = statusSchema.fields;
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

    const updatedRecord = await fetchWorkItemRecordById(
      token,
      appToken,
      tableId,
      recordId,
      toolConfig,
      { consistency: 'fresh' },
    );
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
      },
    );
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
    const result = await executeWorkItemCommentMutation({
      token,
      user: session.user,
      projectId,
      toolId,
      recordId,
      content,
      mentionedUsers,
      notifyMentioned,
      request,
    });
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '发送留言失败';
    const status = message.includes('缺少') ? 500 : message.includes('权限') ? 403 : message.includes('不存在') ? 404 : message.includes('JSON') ? 409 : 502;
    response.status(status).json({ message });
  }
}

async function executeWorkItemCommentMutation({
  token,
  user,
  projectId,
  toolId,
  recordId,
  content,
  mentionedUsers = [],
  requestedMentionedUserOpenIds = [],
  notifyMentioned = false,
  clientMutationId = '',
  request = null,
}) {
  const toolConfig = getWorkItemToolConfig(toolId);
  return workItemMutationQueue.run(
    buildWorkItemMutationKey(projectId, toolId, recordId),
    async () => {
      const { project, projectAccess } = await getAuthorizedProjectAccess(
        token,
        projectId,
        user,
        toolId,
      );
      const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
      const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
      const commentsFieldName = toolConfig.fieldNames.comments;
      await ensureBitableTextField(token, appToken, tableId, commentsFieldName);

      const record = await fetchWorkItemRecordById(
        token,
        appToken,
        tableId,
        recordId,
        toolConfig,
        { consistency: 'fresh' },
      );
      const commentsDocument = parseCommentsDocument(
        (record.fields || {})[commentsFieldName],
        true,
      );
      const allowedMentionedUsers = filterMentionedUsersByCandidates(
        mentionedUsers,
        projectAccess.mentionableUsersByTool[toolId] || [],
      );
      const normalizedMutationId = String(clientMutationId || '').trim().slice(0, 100);
      const mutationFingerprint = normalizedMutationId
        ? createMutationFingerprint({
            projectId,
            toolId,
            recordId,
            content,
            mentionedUserOpenIds: normalizeOpenIdList(requestedMentionedUserOpenIds).sort(),
            notifyMentioned: Boolean(notifyMentioned),
          })
        : '';
      const existingComment = findIdempotentMutation({
        items: commentsDocument.items,
        clientMutationId: normalizedMutationId,
        mutationFingerprint,
        belongsToActor: (comment) => isSameUser(comment, user),
        conflictMessage: 'clientMutationId 已用于不同的工作项留言',
      });
      if (existingComment) {
        return {
          comment: normalizeCommentsForClient({ items: [existingComment] })[0],
          comments: normalizeCommentsForClient(commentsDocument),
          notificationResults: [],
          acceptedMentionedUserOpenIds: existingComment.mentionedOpenIds,
          ignoredMentionedUserOpenIds: [],
          duplicate: true,
        };
      }

      const comment = buildRecordComment(user, content, allowedMentionedUsers, {
        clientMutationId: normalizedMutationId,
        mutationFingerprint,
        notifyMentioned,
      });
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
      const acceptedOpenIds = allowedMentionedUsers.map((item) => item.openId).filter(Boolean);
      return {
        comment: normalizeCommentsForClient({ items: [comment] })[0],
        comments: normalizeCommentsForClient(nextDocument),
        notificationResults,
        acceptedMentionedUserOpenIds: acceptedOpenIds,
        ignoredMentionedUserOpenIds: normalizeOpenIdList(requestedMentionedUserOpenIds)
          .filter((openId) => !acceptedOpenIds.includes(openId)),
        duplicate: false,
      };
    },
  );
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
    return workItemMutationQueue.run(
      buildWorkItemMutationKey(project.projectId, toolId, recordId),
      async () => {
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
    const commentsFieldName = toolConfig.fieldNames.comments;
    await ensureBitableTextField(token, appToken, tableId, commentsFieldName);

    const record = await fetchWorkItemRecordById(
      token,
      appToken,
      tableId,
      recordId,
      toolConfig,
      { consistency: 'fresh' },
    );
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
      },
    );
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
    const expectedCurrentStatus = String(request.body?.expectedCurrentStatus || '').trim();
    const clientMutationId = String(request.body?.clientMutationId || '').trim();
    const confirmWithoutRequiredAttachment = Boolean(
      request.body?.confirmWithoutRequiredAttachment,
    );
    const versionAssociationDecision = request.body?.versionAssociationDecision;

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
    const result = await executeWorkItemStatusMutation({
      token,
      user: session.user,
      projectId,
      toolId,
      recordId,
      expectedCurrentStatus,
      newStatus,
      message,
      notifyProposer,
      confirmWithoutRequiredAttachment,
      clientMutationId,
      versionAssociationDecision,
      requireVersionAssociationDecision: true,
      request,
    });
    response.json({
      ...result,
      requirement: result.item,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '更新处理状态失败';
    const status = Number(error?.statusCode) || (
      message.includes('缺少') ? 500 : message.includes('权限') || message.includes('只有处理人员') ? 403 : message.includes('不存在') ? 404 : message.includes('JSON') ? 409 : 502
    );
    response.status(status).json({
      message,
      ...(error?.publicDetails ? { result: error.publicDetails } : {}),
    });
  }
}

async function executeWorkItemStatusMutation({
  token,
  user,
  projectId,
  toolId,
  recordId,
  expectedCurrentStatus = '',
  newStatus,
  message = '',
  notifyProposer = false,
  confirmWithoutRequiredAttachment = false,
  clientMutationId = '',
  versionAssociationDecision = null,
  requireVersionAssociationDecision = false,
  request = null,
}) {
  const toolConfig = getWorkItemToolConfig(toolId);
  return workItemMutationQueue.run(
    buildWorkItemMutationKey(projectId, toolId, recordId),
    async () => {
      const { project } = await getAuthorizedProjectAccess(token, projectId, user, toolId);
      const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
      const { appToken, tableId } = await fetchWorkItemTableContext(token, node, toolConfig);
      const fieldNames = toolConfig.fieldNames;
      await ensureBitableTextField(token, appToken, tableId, fieldNames.statusChangeLog);

      const [statusSchema, record] = await Promise.all([
        ensureWorkItemStatusOptions(token, { appToken, tableId }, toolConfig),
        fetchWorkItemRecordById(token, appToken, tableId, recordId, toolConfig, { consistency: 'fresh' }),
      ]);
      const source = record.fields || {};
      const currentStatus = normalizeTextValue(source[fieldNames.status]) || '未设置状态';
      const statusChangeLogDocument = parseStatusChangeLogDocument(
        source[fieldNames.statusChangeLog],
        true,
      );
      const normalizedVersionDecision = normalizeStatusVersionAssociationDecision(
        versionAssociationDecision,
      );
      const normalizedMutationId = String(clientMutationId || '').trim().slice(0, 100);
      const mutationFingerprint = normalizedMutationId
        ? createMutationFingerprint({
            projectId,
            toolId,
            recordId,
            expectedCurrentStatus: String(expectedCurrentStatus || '').trim(),
            newStatus,
            message,
            notifyProposer: Boolean(notifyProposer),
            confirmWithoutRequiredAttachment: Boolean(confirmWithoutRequiredAttachment),
            versionAssociationDecision: normalizedVersionDecision,
          })
        : '';
      const existingChange = findIdempotentMutation({
        items: statusChangeLogDocument.items,
        clientMutationId: normalizedMutationId,
        mutationFingerprint,
        belongsToActor: (change) => isSameUser({
          openId: change.operatorOpenId,
          name: change.operatorName,
        }, user),
        conflictMessage: 'clientMutationId 已用于不同的状态更新',
      });
      if (existingChange) {
        const item = normalizeWorkItemRecords([record], user, toolConfig)[0] || null;
        const versionAssociation = await applyStatusVersionAssociationDecision({
          token,
          project,
          toolId,
          item,
          decision: normalizedVersionDecision,
        });
        return {
          item,
          statusChange: normalizeStatusChangeLogForClient({ items: [existingChange] })[0],
          statusChangeLog: normalizeStatusChangeLogForClient(statusChangeLogDocument),
          notificationResults: [],
          versionAssociation,
          duplicate: true,
        };
      }

      const expectedStatus = String(expectedCurrentStatus || '').trim();
      if (expectedStatus && expectedStatus !== currentStatus) {
        const error = createHttpError(
          `工作项状态已变化，当前状态为“${currentStatus}”`,
          409,
        );
        error.publicDetails = { currentStatus };
        throw error;
      }
      if (currentStatus === newStatus) {
        throw createHttpError('处理状态没有变化', 400);
      }

      const assignees = normalizeUserListValue(source[fieldNames.assignees]);
      if (!assignees.some((assignee) => isSameUser(assignee, user))) {
        throw createHttpError('只有处理人员可以更新处理状态', 403);
      }
      if (
        toolId === 'requirements'
        && isRequirementSubmissionAttachmentRequired(
          source[fieldNames.requiresSubmissionAttachment],
        )
        && normalizeBitableAttachmentListValue(
          source[fieldNames.submittedAttachments],
        ).length === 0
        && !confirmWithoutRequiredAttachment
      ) {
        const error = createHttpError('当前需求要求提交附件，但还没有提交任何附件', 409);
        error.mcpCode = 'confirmation_required';
        error.publicDetails = {
          confirmField: 'confirmWithoutRequiredAttachment',
          currentStatus,
          requestedStatus: newStatus,
        };
        throw error;
      }

      const allowedStatuses = normalizeWorkItemStatusOptions(
        statusSchema.fields,
        toolConfig,
      ).map((item) => item.name);
      if (allowedStatuses.length > 0 && !allowedStatuses.includes(newStatus)) {
        throw createHttpError('处理状态不在可选范围内', 400);
      }

      const completionTransition = getWorkItemCompletionTransition({
        toolId,
        currentStatus,
        newStatus,
        completedStatuses: runtimeConfig.dashboard.statusGroups?.[toolId]?.completed,
      });
      const expectedVersionOperation = getVersionAssociationOperationForTransition(
        completionTransition,
      );
      if (
        completionTransition === WORK_ITEM_COMPLETION_TRANSITIONS.NONE
        && normalizedVersionDecision
      ) {
        throw createHttpError('当前状态变更不需要版本关联决定', 400);
      }
      if (expectedVersionOperation) {
        const decision = normalizeStatusVersionAssociationDecision(
          normalizedVersionDecision,
          { expectedOperation: expectedVersionOperation },
        );
        const associationContext = await versionManagementService.inspectWorkItemAssociations(
          token,
          project,
          {
            toolId,
            workItemRecordId: recordId,
            operation: expectedVersionOperation,
          },
        );
        if (
          requireVersionAssociationDecision
          && associationContext.versions.length > 0
          && !decision
        ) {
          const error = createHttpError(
            expectedVersionOperation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.ASSOCIATE
              ? '请选择是否关联当前测试开发版本'
              : '请选择是否取消已有版本关联',
            409,
          );
          error.mcpCode = 'confirmation_required';
          error.publicDetails = buildWorkItemVersionAssociationConfirmation({
            operation: expectedVersionOperation,
            currentStatus,
            requestedStatus: newStatus,
            versions: associationContext.versions,
          });
          throw error;
        }
        if (decision?.apply) {
          await versionManagementService.validateWorkItemAssociationDecision(
            token,
            project,
            {
              toolId,
              operation: decision.operation,
              versionRecordIds: decision.versionRecordIds,
            },
          );
        }
      }

      const statusChange = buildStatusChangeLogItem(
        user,
        currentStatus,
        newStatus,
        message,
        {
          clientMutationId: normalizedMutationId,
          mutationFingerprint,
          notifyProposer,
        },
      );
      const nextStatusChangeLog = {
        version: 1,
        items: [...statusChangeLogDocument.items, statusChange],
      };
      await updateBitableRecordFields(token, appToken, tableId, recordId, {
        [fieldNames.status]: newStatus,
        [fieldNames.statusChangeLog]: JSON.stringify(nextStatusChangeLog),
      });

      const updatedRecord = await fetchWorkItemRecordById(
        token,
        appToken,
        tableId,
        recordId,
        toolConfig,
        { consistency: 'fresh' },
      );
      const item = normalizeWorkItemRecords([updatedRecord], user, toolConfig)[0] || null;
      const versionAssociation = await applyStatusVersionAssociationDecision({
        token,
        project,
        toolId,
        item,
        decision: normalizedVersionDecision,
      });
      publishWorkItemUpdated({
        projectId: project.projectId,
        toolId,
        recordId,
      });
      const proposers = fieldNames.proposer
        ? normalizeUserListValue(source[fieldNames.proposer])
        : [];
      const notificationResults = notifyProposer
        ? await notifyWorkItemProposers(token, proposers, {
            project,
            record: updatedRecord,
            oldStatus: currentStatus,
            newStatus,
            message,
            operator: user,
            request,
            toolConfig,
          })
        : [];
      return {
        item,
        statusChange: normalizeStatusChangeLogForClient({ items: [statusChange] })[0],
        statusChangeLog: normalizeStatusChangeLogForClient(nextStatusChangeLog),
        notificationResults,
        versionAssociation,
        duplicate: false,
      };
    },
  );
}

async function applyStatusVersionAssociationDecision({
  token,
  project,
  toolId,
  item,
  decision,
}) {
  if (!decision) {
    return {
      operation: '',
      applied: false,
      ok: true,
      changedVersions: [],
      message: '',
    };
  }
  if (!decision.apply) {
    return {
      operation: decision.operation,
      applied: false,
      ok: true,
      changedVersions: [],
      message: '',
    };
  }

  try {
    const result = await versionManagementService.applyWorkItemAssociationDecision(
      token,
      project,
      {
        toolId,
        workItem: item,
        operation: decision.operation,
        versionRecordIds: decision.versionRecordIds,
      },
    );
    for (const version of result.changedVersions) {
      publishVersionUpdate(project.projectId, version.recordId);
    }
    return {
      operation: decision.operation,
      applied: true,
      ok: true,
      changedVersions: result.changedVersions,
      message: '',
    };
  } catch (error) {
    return {
      operation: decision.operation,
      applied: true,
      ok: false,
      changedVersions: [],
      message: error instanceof Error ? error.message : '版本关联更新失败',
    };
  }
}

function normalizeStatusVersionAssociationDecision(value, options = {}) {
  try {
    return normalizeWorkItemVersionAssociationDecision(value, options);
  } catch (error) {
    throw createHttpError(
      error instanceof Error ? error.message : '版本关联决定格式不正确',
      400,
    );
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
    return workItemMutationQueue.run(
      buildWorkItemMutationKey(project.projectId, toolId, recordId),
      async () => {
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

    const record = await fetchWorkItemRecordById(
      token,
      appToken,
      tableId,
      recordId,
      toolConfig,
      { consistency: 'fresh' },
    );
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

    const updatedRecord = await fetchWorkItemRecordById(
      token,
      appToken,
      tableId,
      recordId,
      toolConfig,
      { consistency: 'fresh' },
    );
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
    const newlyAddedAssignees = allowedAssignees.filter(
      (assignee) => !currentAssignees.some((current) => isSameUser(current, assignee)),
    );
    const aiPlanNotificationQueuedCount = isAiPlanningWorkItemTool(toolId)
      && projectAccess.allowedToolIds.has(AI_PLAN_TOOL_ID)
      && newlyAddedAssignees.length > 0
      ? enqueuePendingAiPlanNotificationsForAssignees({
          project,
          toolId,
          recordId,
          workItem: {
            ...normalizedItem,
            _aiReviewAssignees: allowedAssignees,
          },
          assignees: newlyAddedAssignees,
          assignmentEventId: comment.id,
        })
      : 0;

    response.json({
      item: normalizedItem,
      requirement: toolId === 'requirements' ? normalizedItem : null,
      comment,
      comments: normalizeCommentsForClient(nextCommentsDocument),
      notificationResults,
      aiPlanNotificationQueuedCount,
    });
      },
    );
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

const httpServer = app.listen(port, host, () => {
  console.log(`Server started on ${host}:${port}`);
  console.log(`Client error log: ${clientErrorLogFilePath}`);
  for (const url of getLocalUrls(port)) {
    console.log(url);
  }
  todoNotificationScheduler.start();
  void feishuBitableEventService.start();
  if (runtimeConfig.aiPlanning.assistant.enabled && !runtimeConfig.feishu.events.enabled) {
    void feishuLongConnectionClient.start();
  }
  feishuAssistantService.start();
  void migrateConfiguredWorkItemStatusOptions();
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    todoNotificationScheduler.stop();
    aiPlanningNotificationService.stop();
    void Promise.allSettled([
      feishuBitableEventService.stop(),
      Promise.resolve(feishuAssistantService.stop()),
      codexAppServerClient?.stop(),
    ]).finally(() => {
      feishuAssistantRepository.close();
      httpServer.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}

async function migrateConfiguredWorkItemStatusOptions() {
  if (!appId || !appSecret || !runtimeConfig.knowledgeBase.spaceId) {
    return;
  }

  try {
    const token = await getTenantAccessToken();
    const summary = await migrateWorkItemStatusOptions(token, [
      getWorkItemToolConfig('requirements'),
      getWorkItemToolConfig('bugs'),
    ]);
    console.log(
      `Work item status migration completed: scanned=${summary.scanned}, updated=${summary.updated}, unchanged=${summary.unchanged}, failed=${summary.failed}`,
    );
    for (const failure of summary.failures) {
      console.error(
        `Work item status migration failed: tool=${failure.toolId}, node=${failure.nodeTitle || 'unknown'}, message=${failure.message}`,
      );
    }
  } catch (error) {
    console.error(
      `Work item status migration failed: ${error instanceof Error ? error.message : String(error || 'unknown error')}`,
    );
  }
}

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

async function runTodoNotificationTick(now = new Date()) {
  const timeZone = runtimeConfig.bitable.personalSettings.timeZone;
  const { dateKey } = getZonedDateTimeParts(now, timeZone);
  if (sentTodoNotificationDateKey !== dateKey) {
    sentTodoNotificationDateKey = dateKey;
    sentTodoNotificationKeys.clear();
  }

  const token = await getTenantAccessToken();
  const { recipients, warnings } = await listTodoNotificationRecipients(token);
  for (const warning of warnings) {
    console.warn('[todo-notification]', warning);
  }

  const dueRecipients = recipients.filter(({ settings }) => (
    isTodoNotificationDue(settings, now, timeZone)
  ));

  await mapWithConcurrency(dueRecipients, 3, async ({ user, settings }) => {
    const dedupeKey = buildTodoNotificationDedupeKey(user, now, timeZone);
    if (sentTodoNotificationKeys.has(dedupeKey)) {
      return;
    }

    try {
      const result = await collectTodoNotificationItemsForUser(token, user);
      if (result.items.length > 0) {
        const card = buildTodoNotificationCard(user, {
          items: result.items,
          failedSourceCount: result.failedSourceCount,
          notificationTime: settings.todoNotificationTime,
        });
        await sendFeishuInteractiveMessage(token, user.openId, card);
      }
      sentTodoNotificationKeys.add(dedupeKey);
      console.log(
        `[todo-notification] 完成：待办 ${result.items.length} 项，读取失败 ${result.failedSourceCount} 项`,
      );
    } catch (error) {
      console.error('[todo-notification] 用户通知失败', formatLogError(error));
    }
  });
}

async function collectTodoNotificationItemsForUser(token, user) {
  const projects = await getAccessibleProjectsForUser(token, user);
  const tasks = [];

  for (const project of projects) {
    const allowedToolIds = new Set((project.allowedTools || []).map((tool) => tool.id));
    for (const toolId of WORK_ITEM_TOOL_IDS) {
      if (allowedToolIds.has(toolId)) {
        tasks.push({
          project,
          toolConfig: getWorkItemToolConfig(toolId),
        });
      }
    }
  }

  const results = await mapWithConcurrency(tasks, 4, async ({ project, toolConfig }) => {
    try {
      return {
        source: {
          project,
          toolId: toolConfig.toolId,
          items: await getProjectWorkItems(token, project, user, toolConfig),
        },
        error: null,
      };
    } catch (error) {
      console.error(
        `[todo-notification] 读取 ${project.projectId || 'unknown'}/${toolConfig.toolId} 失败`,
        formatLogError(error),
      );
      return { source: null, error };
    }
  });

  return {
    items: collectPendingTodoNotificationItems(
      results.map((result) => result.source).filter(Boolean),
      user,
      runtimeConfig.dashboard.statusGroups,
    ),
    failedSourceCount: results.filter((result) => result.error).length,
  };
}

async function getProjectWaitingWorkItemCount(token, project, user, toolConfig) {
  const items = await getProjectWorkItems(token, project, user, toolConfig);
  return countWaitingAssignedWorkItems(toolConfig.toolId, items, user);
}

async function getProjectWorkItems(token, project, user, toolConfig) {
  try {
    const node = await findProjectWorkItemNode(token, project.projectId, toolConfig);
    const { appToken, tableId } = await getCachedWorkItemTableContext(token, node, toolConfig);
    const records = await fetchBitableRecords(token, {
      appToken,
      tableId,
      viewId: '',
      fieldNames: {},
    });
    return normalizeWorkItemRecords(records, user, toolConfig);
  } catch (error) {
    if (isMissingWorkItemListError(error, toolConfig)) {
      return [];
    }
    throw error;
  }
}

async function loadCompletedVersionWorkItemCandidates(token, project, user) {
  const entries = await mapWithConcurrency(VERSION_ASSOCIATION_TOOL_IDS, 3, async (toolId) => {
    const toolConfig = getWorkItemToolConfig(toolId);
    try {
      const items = await getProjectWorkItems(token, project, user, toolConfig);
      const completedStatuses = new Set(runtimeConfig.dashboard.statusGroups?.[toolId]?.completed || []);
      return {
        toolId,
        items: items
          .filter((item) => completedStatuses.has(String(item.itemStatus || item.requirementStatus || '').trim()))
          .map((item) => ({
            recordId: String(item.recordId || '').trim(),
            itemId: String(item.itemId || item[toolConfig.itemIdKey] || '').trim(),
            title: String(item.title || toolConfig.unnamedTitle).trim(),
            status: String(item.itemStatus || item.requirementStatus || '').trim(),
            completed: true,
          }))
          .filter((item) => item.recordId),
        warning: '',
      };
    } catch (error) {
      return {
        toolId,
        items: [],
        warning: `${toolConfig.listLabel}读取失败：${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  });

  return {
    candidates: Object.fromEntries(entries.map((entry) => [entry.toolId, entry.items])),
    warnings: entries.map((entry) => entry.warning).filter(Boolean),
  };
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
  registerBitableTableContext({
    appToken: context.appToken,
    tableId: context.tableId,
    viewId: '',
    fieldNames: {},
    projectId: String(node.title || '').trim(),
    toolId: toolConfig.toolId,
  });
}

function registerBitableTableContext(context) {
  return feishuBitableEventService.registerTableContext(context);
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
  return resolveWorkItemTableContext(token, node, toolConfig);
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
    if (
      isAiPlanningProjectEnabled(projectPermission.projectId)
      && canAccessAiPlanTool(allowedToolIds)
    ) {
      allowedToolIds.add(AI_PLAN_TOOL_ID);
    }
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
  const allowedToolIds = new Set(['overview', VERSION_MANAGEMENT_TOOL_ID]);
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
  const result = Object.fromEntries([
    ...PERMISSION_TOOL_DEFINITIONS.map((tool) => [tool.id, []]),
    [VERSION_MANAGEMENT_TOOL_ID, []],
  ]);
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
  result[VERSION_MANAGEMENT_TOOL_ID] = uniqueUsers(
    Object.values(projectPermission.usersByDepartment).flat(),
  ).map(toMentionableUser);

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
  const allowedAiToolIds = getAllowedAiPlanToolIds(projectAccess.allowedToolIds);
  const aiPlanningEnabled = projectAccess.allowedToolIds.has(AI_PLAN_TOOL_ID);
  return {
    ...project,
    departments: projectAccess.departments,
    isSuperAdmin: projectAccess.isSuperAdmin,
    isDevelopmentSuperAdmin: projectAccess.isDevelopmentSuperAdmin,
    allowedTools: projectAccess.allowedTools,
    mentionableUsersByTool: projectAccess.mentionableUsersByTool,
    aiPlanning: {
      enabled: aiPlanningEnabled,
      supportedToolIds: allowedAiToolIds,
      unavailableReason: getAiPlanningUnavailableReason(
        project.projectId,
        allowedAiToolIds,
        aiPlanningEnabled,
      ),
    },
  };
}

function isAiPlanningProjectEnabled(projectId) {
  return Boolean(
    codexRuntimeReady
    && runtimeConfig.aiPlanning.projects.some(
      (project) => project.enabled && project.projectId === projectId && project.roots.length > 0,
    )
  );
}

function getAiPlanningUnavailableReason(projectId, supportedToolIds, enabled) {
  if (
    enabled
    || !runtimeConfig.aiPlanning.enabled
    || supportedToolIds.length === 0
  ) {
    return '';
  }
  if (!codexRuntimeReady) {
    return 'AI 模型连接尚未完整配置';
  }
  if (!isAiPlanningProjectEnabled(projectId)) {
    return '当前项目未配置 AI 代码目录';
  }
  return 'AI 计划当前不可用';
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
  if (fieldNames.comments && payload.sourceMutationId) {
    values[fieldNames.comments] = JSON.stringify({
      version: 1,
      items: [],
      internal: {
        sourceMutationIds: [String(payload.sourceMutationId).slice(0, 100)],
      },
    });
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

  if (toolConfig.toolId === 'requirements' || toolConfig.toolId === 'bugs') {
    const statusField = fieldByName.get(names.status);
    if (!statusField) {
      throw new Error(`${toolConfig.itemLabel}模板缺少“${names.status}”字段`);
    }
    if (!isBitableSingleSelectField(statusField)) {
      throw new Error(`${toolConfig.itemLabel}模板字段“${names.status}”必须是单选类型`);
    }

    const acceptanceStatus = String(toolConfig.acceptanceStatus || '').trim();
    if (acceptanceStatus && !getFieldOptionNames(statusField).includes(acceptanceStatus)) {
      throw new Error(`${toolConfig.itemLabel}模板“${names.status}”缺少“${acceptanceStatus}”选项`);
    }
  }

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
      internal: normalizeCommentInternal(parsed?.internal),
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
    clientMutationId: String(item.clientMutationId || item.client_mutation_id || '').trim(),
    mutationFingerprint: String(item.mutationFingerprint || item.mutation_fingerprint || '').trim(),
    notifyMentioned: Boolean(item.notifyMentioned ?? item.notify_mentioned),
  };
}

function normalizeCommentInternal(value) {
  const sourceMutationIds = Array.isArray(value?.sourceMutationIds)
    ? value.sourceMutationIds
      .map((item) => String(item || '').trim().slice(0, 100))
      .filter(Boolean)
    : [];
  return {
    sourceMutationIds: [...new Set(sourceMutationIds)].slice(0, 20),
  };
}

function normalizeFeishuAssistantMessageEvent(payload) {
  const event = payload?.event || payload || {};
  const message = event.message || {};
  const sender = event.sender || {};
  const senderId = sender.sender_id || sender.senderId || {};
  const openId = String(
    senderId.open_id || senderId.openId || sender.open_id || sender.openId || '',
  ).trim();
  const chatType = String(message.chat_type || message.chatType || '').trim();
  const senderType = String(sender.sender_type || sender.senderType || '').trim();
  const text = extractFeishuMessageText(message.content);
  if (!openId || !text || senderType === 'app') {
    return null;
  }
  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).map((mention) => {
    const id = mention?.id || mention?.user_id || mention?.userId || {};
    return {
      openId: String(id?.open_id || id?.openId || mention?.open_id || mention?.openId || '').trim(),
      userId: String(id?.user_id || id?.userId || mention?.user_id || mention?.userId || '').trim(),
      unionId: String(id?.union_id || id?.unionId || mention?.union_id || mention?.unionId || '').trim(),
      name: String(mention?.name || mention?.user_name || '').trim(),
    };
  }).filter((mention) => mention.openId);
  return {
    eventId: String(
      payload?.header?.event_id || payload?.header?.eventId || message.message_id || message.messageId || '',
    ).trim(),
    messageId: String(message.message_id || message.messageId || '').trim(),
    chatId: String(message.chat_id || message.chatId || '').trim(),
    chatType,
    ownerOpenId: openId,
    ownerName: String(sender.sender_name || sender.senderName || '').trim(),
    text,
    mentions,
  };
}

function normalizeFeishuAssistantCardAction(payload) {
  const event = payload?.event || payload || {};
  const operator = event.operator || {};
  const operatorId = operator.operator_id || operator.operatorId || operator;
  const ownerOpenId = String(
    operatorId.open_id || operatorId.openId || operator.open_id || operator.openId || '',
  ).trim();
  const action = event.action || {};
  let value = action.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const actionId = String(value?.actionId || value?.action_id || '').trim();
  return ownerOpenId && actionId ? { ownerOpenId, actionId } : null;
}

function extractFeishuMessageText(content) {
  if (typeof content === 'object' && content) {
    return String(content.text || '').trim();
  }
  try {
    const parsed = JSON.parse(String(content || ''));
    return String(parsed?.text || '').trim();
  } catch {
    return '';
  }
}

function normalizeCommentsForClient(document) {
  return (document?.items || []).map(normalizeStoredComment).filter(Boolean).map((comment) => ({
    id: comment.id,
    authorOpenId: comment.authorOpenId,
    authorName: comment.authorName,
    authorAvatarUrl: comment.authorAvatarUrl,
    createdAt: comment.createdAt,
    content: comment.content,
    mentionedOpenIds: comment.mentionedOpenIds,
    mentionedUsers: comment.mentionedUsers,
  }));
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
    clientMutationId: String(item.clientMutationId || item.client_mutation_id || '').trim(),
    mutationFingerprint: String(item.mutationFingerprint || item.mutation_fingerprint || '').trim(),
    notifyProposer: Boolean(item.notifyProposer ?? item.notify_proposer),
  };
}

function normalizeStatusChangeLogForClient(document) {
  return (document?.items || []).map(normalizeStoredStatusChange).filter(Boolean).map((change) => ({
    id: change.id,
    oldStatus: change.oldStatus,
    newStatus: change.newStatus,
    changedAt: change.changedAt,
    operatorOpenId: change.operatorOpenId,
    operatorName: change.operatorName,
    message: change.message,
  }));
}

function buildStatusChangeLogItem(user, oldStatus, newStatus, message, mutation = {}) {
  return {
    id: crypto.randomUUID(),
    oldStatus: String(oldStatus || '').trim(),
    newStatus: String(newStatus || '').trim(),
    changedAt: new Date().toISOString(),
    operatorOpenId: String(user.openId || '').trim(),
    operatorName: String(user.name || '').trim(),
    message: String(message || '').trim(),
    clientMutationId: String(mutation.clientMutationId || '').trim(),
    mutationFingerprint: String(mutation.mutationFingerprint || '').trim(),
    notifyProposer: Boolean(mutation.notifyProposer),
  };
}

function buildRecordComment(user, content, mentionedUsers, mutation = {}) {
  return {
    id: crypto.randomUUID(),
    authorOpenId: String(user.openId || '').trim(),
    authorName: String(user.name || '').trim(),
    authorAvatarUrl: String(user.avatarUrl || '').trim(),
    createdAt: new Date().toISOString(),
    content,
    mentionedOpenIds: mentionedUsers.map((item) => item.openId).filter(Boolean),
    mentionedUsers,
    clientMutationId: String(mutation.clientMutationId || '').trim(),
    mutationFingerprint: String(mutation.mutationFingerprint || '').trim(),
    notifyMentioned: Boolean(mutation.notifyMentioned),
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

async function downloadAiPlanningAttachment(source, { maxBytes }) {
  const fileToken = String(source?.fileToken || '').trim();
  const tableId = String(source?.tableId || '').trim();
  if (!fileToken || !tableId) {
    throw new Error('附件下载信息不完整');
  }
  const token = await getTenantAccessToken();
  const downloadUrl = await getMediaDownloadUrl(token, fileToken, tableId);
  if (!downloadUrl) {
    throw new Error('附件不可下载');
  }
  const response = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error('附件下载失败');
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new Error('附件超过大小限制');
  }
  return {
    buffer: await readFetchBodyWithLimit(response, maxBytes),
    contentType: String(response.headers.get('content-type') || ''),
  };
}

async function readFetchBodyWithLimit(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error('附件超过大小限制');
    }
    return buffer;
  }

  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('附件超过大小限制');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
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

  const templateContext = await resolveWorkItemTableContext(token, templateNode, toolConfig);
  await ensureWorkItemStatusOptions(token, templateContext, toolConfig);
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
    statusOptions: Array.isArray(itemData.statusOptions) ? itemData.statusOptions : getFallbackWorkItemStatusOptions(toolConfig),
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

async function fetchBitableRecords(token, tableConfig, options) {
  return bitableTableDataService.readRecords(token, tableConfig, options);
}

async function fetchBitableRecord(token, appToken, tableId, recordId, options) {
  return bitableTableDataService.readRecord(token, appToken, tableId, recordId, options);
}

async function createBitableRecord(token, appToken, tableId, fields) {
  return bitableTableDataService.createRecord(token, appToken, tableId, fields);
}

async function updateBitableRecordFields(token, appToken, tableId, recordId, fields) {
  return bitableTableDataService.updateRecord(token, appToken, tableId, recordId, fields);
}

async function deleteBitableRecord(token, appToken, tableId, recordId) {
  return bitableTableDataService.deleteRecord(token, appToken, tableId, recordId);
}

async function fetchWorkItemItems(token, node, currentUser, toolConfig) {
  if (!node?.objToken) {
    throw new Error(toolConfig.notLinkedText);
  }

  const { appToken, tableId } = await getCachedWorkItemTableContext(token, node, toolConfig);

  await ensureCachedBitableTextField(token, appToken, tableId, toolConfig.fieldNames.comments);
  const { fields } = await ensureWorkItemStatusOptions(token, { appToken, tableId }, toolConfig);
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

async function fetchWorkItemRecordById(
  token,
  appToken,
  tableId,
  recordId,
  toolConfig,
  { consistency = 'cache' } = {},
) {
  const record = await fetchBitableRecord(token, appToken, tableId, recordId, { consistency });
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

async function notifyVersionMentionedUsers(token, mentionedUsers, context) {
  const uniqueUsers = normalizeMentionedUsers(mentionedUsers);
  const results = [];
  for (const user of uniqueUsers) {
    try {
      await sendFeishuInteractiveMessage(
        token,
        user.openId,
        buildVersionCommentNotificationCard(user, context),
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

function getAiPlanReviewNotificationRecipients(workItem, projectAccess) {
  const assignees = normalizeMentionedUsers(workItem?._aiReviewAssignees || []);
  return assignees.length > 0
    ? assignees
    : normalizeMentionedUsers(projectAccess?.developmentSuperAdmins || []);
}

function enqueueAiPlanNotifications(
  eventType,
  submission,
  recipients,
  {
    project = null,
    workItem = null,
    reviewer = null,
    reviewReason = '',
    pendingCount = 0,
    eventDiscriminator = '',
  } = {},
) {
  if (!submission) {
    return 0;
  }
  let queuedCount = 0;
  for (const recipient of normalizeMentionedUsers(recipients || [])) {
    const eventKeyParts = [
      'ai-plan',
      eventType,
      submission.id,
      submission.revision,
      recipient.openId,
    ];
    const normalizedDiscriminator = String(eventDiscriminator || '').trim();
    if (normalizedDiscriminator) {
      eventKeyParts.push(normalizedDiscriminator);
    }
    const queued = aiPlanningNotificationService.enqueue(eventType, {
      eventKey: eventKeyParts.join(':'),
      recipientOpenId: recipient.openId,
      submission,
      project,
      workItem,
      reviewer,
      reviewReason,
      pendingCount,
    });
    if (queued) {
      queuedCount += 1;
    }
  }
  return queuedCount;
}

function enqueuePendingAiPlanNotificationsForAssignees({
  project,
  toolId,
  recordId,
  workItem,
  assignees,
  assignmentEventId = '',
}) {
  const pendingCount = aiPlanningService.countPendingSubmissionsForWorkItem({
    projectId: project.projectId,
    toolId,
    recordId,
  });
  if (pendingCount < 1) {
    return 0;
  }
  const [latest] = aiPlanningService.listPendingSubmissionsForWorkItem({
    projectId: project.projectId,
    toolId,
    recordId,
    limit: 1,
  });
  const rawSubmission = latest
    ? aiPlanningRepository.getSubmission(latest.id)
    : null;
  return enqueueAiPlanNotifications(
    pendingCount === 1 ? 'plan_review_requested' : 'plan_review_summary',
    rawSubmission,
    assignees,
    {
      project,
      workItem,
      pendingCount,
      eventDiscriminator: assignmentEventId,
    },
  );
}

async function deliverAiPlanningNotification(notification) {
  const token = await getTenantAccessToken();
  await sendFeishuInteractiveMessage(
    token,
    notification.recipientOpenId || notification.ownerOpenId,
    buildAiPlanningNotificationCard(notification.eventType, notification.payload),
  );
}

function buildAiPlanningNotificationCard(eventType, payload) {
  const toolConfig = getWorkItemToolConfig(payload.toolId);
  const itemLabel = payload.workItemId
    ? `${payload.workItemId} ${payload.workItemTitle || toolConfig.unnamedTitle}`
    : payload.workItemTitle || toolConfig.unnamedTitle;
  const sharedPlanEvent = [
    'plan_review_requested',
    'plan_review_summary',
    'plan_approved',
    'plan_rejected',
    'plan_edited',
    'plan_superseded',
  ].includes(eventType);
  const link = sharedPlanEvent
    ? buildPlatformExternalLink('ai-plan', {
        projectId: payload.projectId,
        tool: AI_PLAN_TOOL_ID,
        recordId: payload.recordId,
        submissionId: payload.submissionId,
      })
    : buildPlatformExternalLink('ai-conversation', {
        projectId: payload.projectId,
        tool: payload.toolId,
        recordId: payload.recordId,
        conversationId: payload.conversationId,
        focus: payload.focus,
      });
  const definitions = {
    question_required: {
      template: 'orange',
      title: `Codex 需要你确认 ${payload.questionCount || 1} 个决策`,
      detailLabel: '下一步',
      detail: '回答后 Codex 会继续只读分析并自动生成方案',
      button: '打开并回答',
    },
    plan_ready: {
      template: 'green',
      title: 'Codex 已生成一版实施方案',
      detailLabel: '方案状态',
      detail: '方案当前仅你可见，确认后可手动提交到项目方案库',
      button: '打开方案',
    },
    run_failed: {
      template: 'red',
      title: 'Codex 生成方案失败',
      detailLabel: '失败信息',
      detail: payload.errorMessage || '请打开对话查看失败详情',
      button: '查看失败详情',
    },
    plan_review_requested: {
      template: 'orange',
      title: '有新的 AI 计划需要审核',
      detailLabel: '审核状态',
      detail: `${payload.submitterName || '项目成员'}提交了修订 ${payload.submissionRevision || 1}`,
      button: '打开审核方案',
    },
    plan_review_summary: {
      template: 'orange',
      title: `该工作项有 ${payload.pendingCount || 1} 份 AI 计划待审核`,
      detailLabel: '审核提示',
      detail: '请打开方案库查看并处理待审核方案',
      button: '打开方案库',
    },
    plan_approved: {
      template: 'green',
      title: 'AI 计划已通过审核',
      detailLabel: '审核人',
      detail: payload.reviewerName || '处理人',
      button: '查看已通过方案',
    },
    plan_rejected: {
      template: 'red',
      title: 'AI 计划未通过审核',
      detailLabel: '拒绝原因',
      detail: payload.reviewReason || '请打开方案查看审核记录',
      button: '查看审核结果',
    },
    plan_edited: {
      template: 'blue',
      title: '处理人编辑了 AI 计划',
      detailLabel: '新修订',
      detail: `修订 ${payload.submissionRevision || 1} 已重新进入待审核`,
      button: '查看新修订',
    },
    plan_superseded: {
      template: 'grey',
      title: '原 AI 计划已被新的通过方案替代',
      detailLabel: '方案状态',
      detail: '原方案及审核记录仍保留在修订历史中',
      button: '查看原方案',
    },
  };
  const definition = definitions[eventType] || definitions.run_failed;

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: definition.template,
      title: {
        tag: 'plain_text',
        content: definition.title,
      },
    },
    elements: [
      buildCardTextElement(
        '项目',
        `${payload.projectName || '未命名项目'} (${payload.projectId || '无ID'})`,
      ),
      buildCardTextElement(toolConfig.itemNameLabel, itemLabel),
      ...(sharedPlanEvent
        ? [buildCardTextElement(
            '方案',
            `${payload.submissionTitle || '未命名方案'}（修订 ${payload.submissionRevision || 1}）`,
          )]
        : []),
      buildCardTextElement(definition.detailLabel, definition.detail),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton(definition.button, link),
        ],
      },
    ],
  };
}

function buildTodoNotificationCard(_user, context) {
  const summary = summarizeTodoNotificationItems(context.items);
  const platformLink = buildPlatformExternalLink('home');
  const elements = [
    buildCardTextElement(
      '待办汇总',
      `需求 ${summary.counts.requirements} 项 · Bug ${summary.counts.bugs} 项 · 反馈 ${summary.counts.feedback} 项`,
    ),
    buildTodoNotificationListElement(summary.displayedItems),
  ];

  if (summary.hiddenCount > 0) {
    elements.push(buildCardTextElement('更多事项', `还有 ${summary.hiddenCount} 项未在卡片中展开`));
  }
  if (context.failedSourceCount > 0) {
    elements.push(buildCardTextElement(
      '数据提示',
      `有 ${context.failedSourceCount} 个项目工具读取失败，卡片可能未包含全部待办`,
    ));
  }

  elements.push({
    tag: 'action',
    actions: [
      buildCardLinkButton('打开开发平台', platformLink),
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: `你有 ${summary.total} 项待办事项`,
      },
    },
    elements,
  };
}

function buildTodoNotificationListElement(items) {
  const content = (Array.isArray(items) ? items : []).map((item, index) => {
    const toolConfig = getWorkItemToolConfig(item.toolId);
    const itemLabel = item.itemId ? `${item.itemId} ${item.title}` : item.title;
    const link = buildPlatformExternalLink(toolConfig.directDetailType, {
      projectId: item.projectId,
      tool: item.toolId,
      recordId: item.recordId,
    });
    const targetUrl = link.appLink || link.webUrl || link.displayUrl;
    return `${index + 1}. [${escapeLarkMarkdown(`${item.projectName} · ${itemLabel}`)}](${targetUrl})  \n${escapeLarkMarkdown(`${toolConfig.itemLabel} · ${item.status}`)}`;
  }).join('\n');

  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: content || '暂无可展示的待办事项',
    },
  };
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

function buildVersionCommentNotificationCard(_user, context) {
  const projectName = context.project?.projectName || '未命名项目';
  const versionNumber = context.version?.versionNumber || '未命名版本';
  const authorName = context.comment?.authorName || context.comment?.authorOpenId || '未知用户';
  const link = buildPlatformExternalLink('version-comment', {
    projectId: context.project?.projectId || '',
    tool: VERSION_MANAGEMENT_TOOL_ID,
    recordId: context.version?.recordId || '',
    commentId: context.comment?.id || '',
  }, context.request);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: `${authorName}在版本“${versionNumber}”中给您留言`,
      },
    },
    elements: [
      buildCardLargeTextElement('留言内容', context.comment?.content || '无'),
      buildCardTextElement('项目名称', `${projectName} (${context.project?.projectId || '无ID'})`),
      buildCardTextElement('版本', `${versionNumber} · ${context.version?.platform || '未设置平台'}`),
      buildCardPersonElement('留言人', {
        openId: context.comment?.authorOpenId,
        name: authorName,
      }),
      {
        tag: 'action',
        actions: [
          buildCardLinkButton('跳转至版本留言', link),
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

function formatLogError(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function formatCodexBridgeDiagnostic(diagnostic) {
  const type = String(diagnostic?.type || 'unknown').replace(/[^a-z_]/g, '').slice(0, 40);
  const statusCode = Number.isInteger(diagnostic?.statusCode) ? diagnostic.statusCode : 0;
  const category = String(diagnostic?.category || 'unknown').replace(/[^a-z_]/g, '').slice(0, 80);
  const upstreamCode = String(diagnostic?.upstreamCode || '').replace(/[^a-z0-9_.-]/g, '').slice(0, 120);
  const requestIdFingerprint = String(diagnostic?.requestIdFingerprint || '')
    .replace(/[^a-f0-9]/g, '').slice(0, 12);
  return [
    `type=${type || 'unknown'}`,
    `status=${statusCode}`,
    `category=${category || 'unknown'}`,
    ...(upstreamCode ? [`upstream_code=${upstreamCode}`] : []),
    ...(requestIdFingerprint ? [`request_id_fp=${requestIdFingerprint}`] : []),
  ].join(' ');
}

function formatFeishuAssistantLogError(error) {
  const code = String(error?.code || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 80);
  if (code.startsWith('codex_')) {
    return `code=${code}`;
  }
  const message = formatLogError(error);
  if (/upstream request failed|bad gateway|https?:\/\/127\.0\.0\.1:\d+\/responses|request id:/i.test(message)) {
    return 'code=codex_upstream_failure';
  }
  return message;
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

  const allowedParams = [
    'projectId',
    'tool',
    'recordId',
    'commentId',
    'conversationId',
    'submissionId',
    'focus',
  ];
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

  return normalizedOptions.length > 0 ? normalizedOptions : getFallbackWorkItemStatusOptions(toolConfig);
}

function getFallbackWorkItemStatusOptions(toolConfig) {
  const statuses = toolConfig?.toolId === 'bugs'
    ? ['未处理', '修复中', '待验收', '已修复', '无法复现', '已搁置', '关闭']
    : toolConfig?.toolId === 'feedback'
      ? ['待处理', '处理中', '已完成', '已搁置', '已拒绝']
      : ['待处理', '处理中', '待验收', '已处理', '已完成', '关闭'];
  return statuses.map((name) => ({ name, color: '' }));
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

function isPeopleSearchReauthorizationRequired(message) {
  return message.includes('登录授权已失效');
}
