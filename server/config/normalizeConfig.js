import { normalizeProjectOverviewConfig } from '../../shared/projectOverviewUtils.js';
import { normalizeVersionFieldNames } from '../../shared/versionManagementUtils.js';
import { DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD } from '../../shared/workItemAssignmentUtils.js';

export function normalizeConfig(config) {
  const parsedPort = Number(config?.server?.port ?? 3000);
  const dashboardConfig = config?.dashboard || {};
  const aiPlanningConfig = config?.aiPlanning || {};
  const codexConfig = aiPlanningConfig.codex || {};
  const aiAssistantConfig = aiPlanningConfig.assistant || {};
  const aiConcurrencyConfig = normalizeAiConcurrencyConfig(codexConfig);
  const aiAttachmentConfig = aiPlanningConfig.attachments || {};
  const aiNotificationConfig = aiPlanningConfig.notifications || {};
  const feishuEventsConfig = config?.feishu?.events || {};
  const bitableCacheConfig = config?.bitable?.cache || {};
  const requirementsFieldNames = config?.knowledgeBase?.requirementsFieldNames || {};
  const bugsFieldNames = config?.knowledgeBase?.bugsFieldNames || {};
  const feedbackFieldNames = config?.knowledgeBase?.feedbackFieldNames || {};
  const testTasksFieldNames = config?.knowledgeBase?.testTasksFieldNames || {};
  const projectBaseFieldNames = config?.bitable?.projectBase?.fieldNames || {};
  const projectPermissionFieldNames = config?.bitable?.projectPermission?.fieldNames || {};
  const toolPermissionFieldNames = config?.bitable?.toolPermission?.fieldNames || {};
  const toolPermissionToolFields = toolPermissionFieldNames.tools || {};
  const personalSettingsFieldNames = config?.bitable?.personalSettings?.fieldNames || {};
  const versionManagementConfig = config?.bitable?.versionManagement || {};

  return {
    server: {
      host: String(config?.server?.host || '0.0.0.0'),
      port: Number.isFinite(parsedPort) ? parsedPort : 3000,
    },
    feishu: {
      appId: String(config?.feishu?.appId || ''),
      appSecret: String(config?.feishu?.appSecret || ''),
      events: {
        enabled: feishuEventsConfig.enabled !== false,
      },
    },
    webApp: {
      publicBaseUrl: String(config?.webApp?.publicBaseUrl || `http://127.0.0.1:${Number.isFinite(parsedPort) ? parsedPort : 3000}/`),
      openMode: String(config?.webApp?.openMode || 'appCenter'),
    },
    updates: {
      manifestUrl: String(config?.updates?.manifestUrl || '').trim(),
    },
    aiPlanning: {
      enabled: aiPlanningConfig.enabled !== false,
      codex: {
        model: String(codexConfig.model || 'gpt-5.6-sol').trim(),
        apiBaseUrl: normalizeBaseUrl(codexConfig.apiBaseUrl || 'https://api.openai.com/v1'),
        apiKey: String(codexConfig.apiKey || '').trim(),
        reasoningEffort: String(codexConfig.reasoningEffort || 'high').trim() || 'high',
        requestTimeoutMs: normalizePositiveInteger(codexConfig.requestTimeoutMs, 600000),
        ...aiConcurrencyConfig,
      },
      attachments: {
        enabled: aiAttachmentConfig.enabled !== false,
        maxFiles: normalizePositiveInteger(aiAttachmentConfig.maxFiles, 10),
        maxFileBytes: normalizePositiveInteger(aiAttachmentConfig.maxFileBytes, 20 * 1024 * 1024),
        maxTotalBytes: normalizePositiveInteger(aiAttachmentConfig.maxTotalBytes, 50 * 1024 * 1024),
        maxExtractedCharsPerFile: normalizePositiveInteger(
          aiAttachmentConfig.maxExtractedCharsPerFile,
          100_000,
        ),
        maxExtractedCharsTotal: normalizePositiveInteger(
          aiAttachmentConfig.maxExtractedCharsTotal,
          300_000,
        ),
        retentionHours: normalizePositiveInteger(aiAttachmentConfig.retentionHours, 24),
      },
      notifications: {
        enabled: aiNotificationConfig.enabled !== false,
      },
      assistant: {
        enabled: aiAssistantConfig.enabled !== false,
        model: String(aiAssistantConfig.model || 'gpt-5.6-luna').trim() || 'gpt-5.6-luna',
        reasoningEffort: String(aiAssistantConfig.reasoningEffort || 'none').trim() || 'none',
        fallbackModel: String(aiAssistantConfig.fallbackModel || 'gpt-5.6-terra').trim()
          || 'gpt-5.6-terra',
        fallbackReasoningEffort: String(
          aiAssistantConfig.fallbackReasoningEffort || 'low',
        ).trim() || 'low',
        requestTimeoutMs: normalizePositiveInteger(aiAssistantConfig.requestTimeoutMs, 15_000),
        pollIntervalMs: normalizePositiveInteger(aiAssistantConfig.pollIntervalMs, 2_000),
        draftTtlHours: normalizePositiveInteger(aiAssistantConfig.draftTtlHours, 24),
        retentionDays: normalizePositiveInteger(aiAssistantConfig.retentionDays, 30),
      },
      projects: normalizeAiPlanningProjects(aiPlanningConfig.projects),
    },
    dashboard: normalizeProjectOverviewConfig(dashboardConfig),
    knowledgeBase: {
      spaceId: String(config?.knowledgeBase?.spaceId || ''),
      requirementsParentName: String(config?.knowledgeBase?.requirementsParentName || '需求列表'),
      requirementsTemplateName: String(config?.knowledgeBase?.requirementsTemplateName || '模板'),
      requirementsTemplateAppToken: String(config?.knowledgeBase?.requirementsTemplateAppToken || ''),
      requirementsIdPrefix: String(config?.knowledgeBase?.requirementsIdPrefix || 'R-'),
      requirementsIdDigits: normalizePositiveInteger(config?.knowledgeBase?.requirementsIdDigits, 4),
      requirementsFieldNames: {
        requirementId: String(requirementsFieldNames.requirementId || '需求ID'),
        itemId: String(requirementsFieldNames.itemId || requirementsFieldNames.requirementId || '需求ID'),
        title: String(requirementsFieldNames.title || '需求标题'),
        description: String(requirementsFieldNames.description || '需求描述'),
        proposer: String(requirementsFieldNames.proposer || '提出人员'),
        priority: String(requirementsFieldNames.priority || '优先级'),
        assignees: String(requirementsFieldNames.assignees || '处理人员'),
        status: String(requirementsFieldNames.status || '处理状态'),
        proposedAt: String(requirementsFieldNames.proposedAt || '提出时间'),
        expectedDays: String(requirementsFieldNames.expectedDays || '期望时限'),
        attachments: String(requirementsFieldNames.attachments || '附件'),
        requiresSubmissionAttachment: String(requirementsFieldNames.requiresSubmissionAttachment || '需要提交附件'),
        submittedAttachments: String(requirementsFieldNames.submittedAttachments || '提交附件'),
        relatedFeedback: String(requirementsFieldNames.relatedFeedback || '关联反馈'),
        comments: String(requirementsFieldNames.comments || '留言'),
        statusChangeLog: String(requirementsFieldNames.statusChangeLog || '处理状态变动记录'),
      },
      bugsParentName: String(config?.knowledgeBase?.bugsParentName || 'Bug列表'),
      bugsTemplateName: String(config?.knowledgeBase?.bugsTemplateName || '模板'),
      bugsTemplateAppToken: String(config?.knowledgeBase?.bugsTemplateAppToken || 'ZuHmbPMjzaDFCUsge7PcjkAsn4e'),
      bugsIdPrefix: String(config?.knowledgeBase?.bugsIdPrefix || 'B-'),
      bugsIdDigits: normalizePositiveInteger(config?.knowledgeBase?.bugsIdDigits, 4),
      bugsFieldNames: {
        bugId: String(bugsFieldNames.bugId || bugsFieldNames.itemId || bugsFieldNames.requirementId || 'BugID'),
        itemId: String(bugsFieldNames.itemId || bugsFieldNames.bugId || bugsFieldNames.requirementId || 'BugID'),
        title: String(bugsFieldNames.title || '标题'),
        description: String(bugsFieldNames.description || '详细描述'),
        proposer: String(bugsFieldNames.proposer || requirementsFieldNames.proposer || '提出人员'),
        priority: String(bugsFieldNames.priority || requirementsFieldNames.priority || '优先级'),
        assignees: String(bugsFieldNames.assignees || requirementsFieldNames.assignees || '处理人员'),
        status: String(bugsFieldNames.status || requirementsFieldNames.status || '处理状态'),
        proposedAt: String(bugsFieldNames.proposedAt || '发现时间'),
        expectedDays: String(bugsFieldNames.expectedDays || requirementsFieldNames.expectedDays || '期望时限'),
        attachments: String(bugsFieldNames.attachments || requirementsFieldNames.attachments || '附件'),
        relatedFeedback: String(bugsFieldNames.relatedFeedback || '关联反馈'),
        comments: String(bugsFieldNames.comments || requirementsFieldNames.comments || '留言'),
        statusChangeLog: String(bugsFieldNames.statusChangeLog || requirementsFieldNames.statusChangeLog || '处理状态变动记录'),
      },
      feedbackParentName: String(config?.knowledgeBase?.feedbackParentName || '反馈列表'),
      feedbackTemplateName: String(config?.knowledgeBase?.feedbackTemplateName || '模板'),
      feedbackTemplateAppToken: String(config?.knowledgeBase?.feedbackTemplateAppToken || ''),
      feedbackIdPrefix: String(config?.knowledgeBase?.feedbackIdPrefix || 'F-'),
      feedbackIdDigits: normalizePositiveInteger(config?.knowledgeBase?.feedbackIdDigits, 4),
      feedbackFieldNames: {
        feedbackId: String(feedbackFieldNames.feedbackId || feedbackFieldNames.itemId || '反馈ID'),
        itemId: String(feedbackFieldNames.itemId || feedbackFieldNames.feedbackId || '反馈ID'),
        title: String(feedbackFieldNames.title || '标题'),
        description: String(feedbackFieldNames.description || '详细描述'),
        channel: String(feedbackFieldNames.channel || '渠道'),
        proposer: String(feedbackFieldNames.proposer || requirementsFieldNames.proposer || '提出人员'),
        assignees: String(feedbackFieldNames.assignees || requirementsFieldNames.assignees || '处理人员'),
        status: String(feedbackFieldNames.status || requirementsFieldNames.status || '处理状态'),
        proposedAt: String(feedbackFieldNames.proposedAt || '反馈时间'),
        expectedDays: String(feedbackFieldNames.expectedDays || requirementsFieldNames.expectedDays || '期望时限'),
        contactInfo: String(feedbackFieldNames.contactInfo || '联系信息数据'),
        attachments: String(feedbackFieldNames.attachments || requirementsFieldNames.attachments || '附件'),
        relatedItem: String(feedbackFieldNames.relatedItem || '关联项'),
        comments: String(feedbackFieldNames.comments || requirementsFieldNames.comments || '留言'),
        statusChangeLog: String(feedbackFieldNames.statusChangeLog || requirementsFieldNames.statusChangeLog || '处理状态变动记录'),
      },
      testTasksParentName: String(config?.knowledgeBase?.testTasksParentName || '测试任务'),
      testTasksTemplateName: String(config?.knowledgeBase?.testTasksTemplateName || '模板'),
      testTasksTemplateAppToken: String(
        config?.knowledgeBase?.testTasksTemplateAppToken || 'SGvgwousMiRvjGkHQf7cwDwJnab',
      ),
      testTasksIdPrefix: String(config?.knowledgeBase?.testTasksIdPrefix || 'T-'),
      testTasksIdDigits: normalizePositiveInteger(config?.knowledgeBase?.testTasksIdDigits, 4),
      testTasksFieldNames: {
        taskId: String(testTasksFieldNames.taskId || '任务ID'),
        itemId: String(testTasksFieldNames.itemId || testTasksFieldNames.taskId || '任务ID'),
        title: String(testTasksFieldNames.title || '任务名称'),
        content: String(testTasksFieldNames.content || '任务内容'),
        createdAt: String(testTasksFieldNames.createdAt || '创建时间'),
        creator: String(testTasksFieldNames.creator || '创建人'),
        testers: String(testTasksFieldNames.testers || '测试人员'),
        status: String(testTasksFieldNames.status || '处理状态'),
        statusChangeLog: String(testTasksFieldNames.statusChangeLog || '处理状态变动记录'),
        comments: String(testTasksFieldNames.comments || '留言'),
        results: String(testTasksFieldNames.results || '测试结果记录'),
        attachments: String(testTasksFieldNames.attachments || '附件'),
        relatedFeedback: String(testTasksFieldNames.relatedFeedback || '关联反馈'),
      },
    },
    debug: {
      userName: String(config?.debug?.userName || '测试用户'),
      openId: String(config?.debug?.openId || ''),
    },
    bitable: {
      cache: {
        enabled: bitableCacheConfig.enabled !== false,
        freshTtlMs: normalizePositiveInteger(bitableCacheConfig.freshTtlMs, 30_000),
        staleWhileRevalidateMs: normalizePositiveInteger(
          bitableCacheConfig.staleWhileRevalidateMs,
          300_000,
        ),
        maxSnapshots: normalizePositiveInteger(bitableCacheConfig.maxSnapshots, 128),
        eventDebounceMs: normalizePositiveInteger(bitableCacheConfig.eventDebounceMs, 500),
        eventDedupeTtlMs: normalizePositiveInteger(
          bitableCacheConfig.eventDedupeTtlMs,
          24 * 60 * 60 * 1000,
        ),
        maxEventIds: normalizePositiveInteger(bitableCacheConfig.maxEventIds, 10_000),
      },
      projectBase: {
        appToken: String(config?.bitable?.projectBase?.appToken || ''),
        tableId: String(config?.bitable?.projectBase?.tableId || ''),
        viewId: String(config?.bitable?.projectBase?.viewId || ''),
        fieldNames: {
          projectId: String(projectBaseFieldNames.projectId || '项目ID'),
          projectName: String(projectBaseFieldNames.projectName || '项目名称'),
          projectIcon: String(projectBaseFieldNames.projectIcon || '项目图标'),
        },
      },
      projectPermission: {
        appToken: String(config?.bitable?.projectPermission?.appToken || ''),
        tableId: String(config?.bitable?.projectPermission?.tableId || ''),
        viewId: String(config?.bitable?.projectPermission?.viewId || ''),
        fieldNames: {
          projectId: String(projectPermissionFieldNames.projectId || '项目ID'),
          developmentSuperAdmins: String(
            projectPermissionFieldNames.developmentSuperAdmins || DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD,
          ),
          testAdministrators: String(
            projectPermissionFieldNames.testAdministrators || '测试管理员',
          ),
          permissionUsers: Array.isArray(projectPermissionFieldNames.permissionUsers)
            ? projectPermissionFieldNames.permissionUsers.map((item) => String(item)).filter(Boolean)
            : ['超级管理员', DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD, '研发', '测试', '发行', '商务'],
        },
      },
      toolPermission: {
        appToken: String(config?.bitable?.toolPermission?.appToken || ''),
        tableId: String(config?.bitable?.toolPermission?.tableId || ''),
        viewId: String(config?.bitable?.toolPermission?.viewId || ''),
        fieldNames: {
          department: String(toolPermissionFieldNames.department || '部门'),
          tools: {
            requirements: String(toolPermissionToolFields.requirements || '需求列表'),
            bugs: String(toolPermissionToolFields.bugs || 'Bug列表'),
            builds: String(toolPermissionToolFields.builds || '打包列表'),
            review: String(toolPermissionToolFields.review || '内容审查'),
            testTasks: String(toolPermissionToolFields.testTasks || '测试任务'),
            feedback: String(toolPermissionToolFields.feedback || '反馈列表'),
          },
        },
      },
      personalSettings: {
        wikiNodeToken: String(
          config?.bitable?.personalSettings?.wikiNodeToken
          || 'PDcJwzNTIiJHzNkcM0Gc3Cy1nRd',
        ),
        tableId: String(config?.bitable?.personalSettings?.tableId || ''),
        viewId: String(config?.bitable?.personalSettings?.viewId || ''),
        enabledValue: String(config?.bitable?.personalSettings?.enabledValue || '允许'),
        defaultTime: String(config?.bitable?.personalSettings?.defaultTime || '11:00'),
        timeZone: String(config?.bitable?.personalSettings?.timeZone || 'Asia/Shanghai'),
        fieldNames: {
          user: String(personalSettingsFieldNames.user || '用户'),
          receiveTodoNotifications: String(
            personalSettingsFieldNames.receiveTodoNotifications || '接收待办事项通知',
          ),
          todoNotificationTime: String(
            personalSettingsFieldNames.todoNotificationTime || '待办事项通知时间',
          ),
          developmentPlatformToken: String(
            personalSettingsFieldNames.developmentPlatformToken || '开发平台令牌',
          ),
        },
      },
      versionManagement: {
        wikiNodeToken: String(
          versionManagementConfig.wikiNodeToken
          || 'UVqFwm4EIiBcoPkoz9JcOLNfnVg',
        ),
        parentName: String(versionManagementConfig.parentName || '版本管理'),
        tableId: String(versionManagementConfig.tableId || ''),
        viewId: String(versionManagementConfig.viewId || ''),
        fieldNames: normalizeVersionFieldNames(versionManagementConfig.fieldNames),
      },
      links: Array.isArray(config?.bitable?.links) ? config.bitable.links : [],
    },
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizeAiConcurrencyConfig(codexConfig) {
  const hasPerUserLimit = Object.prototype.hasOwnProperty.call(
    codexConfig,
    'maxConcurrentRunsPerUser',
  );
  const hasPerProjectLimit = Object.prototype.hasOwnProperty.call(
    codexConfig,
    'maxConcurrentRunsPerProject',
  );
  const rawMaxConcurrentRuns = codexConfig.maxConcurrentRuns;
  const hasLegacyDefault = !hasPerUserLimit
    && !hasPerProjectLimit
    && (
      rawMaxConcurrentRuns === undefined
      || rawMaxConcurrentRuns === null
      || rawMaxConcurrentRuns === ''
      || Number(rawMaxConcurrentRuns) === 3
    );
  const maxConcurrentRuns = hasLegacyDefault
    ? 6
    : normalizePositiveInteger(rawMaxConcurrentRuns, 6);
  const defaultProjectLimit = Math.min(4, maxConcurrentRuns);

  return {
    maxConcurrentRuns,
    maxConcurrentRunsPerUser: normalizeNonNegativeInteger(
      codexConfig.maxConcurrentRunsPerUser,
      0,
    ),
    maxConcurrentRunsPerProject: normalizePositiveInteger(
      codexConfig.maxConcurrentRunsPerProject,
      defaultProjectLimit,
    ),
  };
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeAiPlanningProjects(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((project) => {
      const projectId = String(project?.projectId || '').trim();
      if (!projectId) {
        return null;
      }

      const roots = (Array.isArray(project?.roots) ? project.roots : [])
        .map((root) => {
          const id = String(root?.id || '').trim();
          const rootPath = String(root?.path || '').trim();
          if (!id || !rootPath) {
            return null;
          }
          return {
            id,
            path: rootPath,
            profile: normalizeAiProjectProfile(root?.profile),
          };
        })
        .filter(Boolean);

      return {
        projectId,
        enabled: project?.enabled !== false,
        preludePrompt: String(project?.preludePrompt || '').trim(),
        roots,
      };
    })
    .filter(Boolean);
}

function normalizeAiProjectProfile(value) {
  const profile = String(value || 'auto').trim().toLowerCase();
  return ['auto', 'web', 'unity', 'generic'].includes(profile) ? profile : 'auto';
}
