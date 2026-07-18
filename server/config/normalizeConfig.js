import { normalizeProjectOverviewConfig } from '../../shared/projectOverviewUtils.js';
import { DEFAULT_DEVELOPMENT_SUPER_ADMIN_FIELD } from '../../shared/workItemAssignmentUtils.js';

export function normalizeConfig(config) {
  const parsedPort = Number(config?.server?.port ?? 3000);
  const dashboardConfig = config?.dashboard || {};
  const requirementsFieldNames = config?.knowledgeBase?.requirementsFieldNames || {};
  const bugsFieldNames = config?.knowledgeBase?.bugsFieldNames || {};
  const feedbackFieldNames = config?.knowledgeBase?.feedbackFieldNames || {};
  const projectBaseFieldNames = config?.bitable?.projectBase?.fieldNames || {};
  const projectPermissionFieldNames = config?.bitable?.projectPermission?.fieldNames || {};
  const toolPermissionFieldNames = config?.bitable?.toolPermission?.fieldNames || {};
  const toolPermissionToolFields = toolPermissionFieldNames.tools || {};

  return {
    server: {
      host: String(config?.server?.host || '0.0.0.0'),
      port: Number.isFinite(parsedPort) ? parsedPort : 3000,
    },
    feishu: {
      appId: String(config?.feishu?.appId || ''),
      appSecret: String(config?.feishu?.appSecret || ''),
    },
    webApp: {
      publicBaseUrl: String(config?.webApp?.publicBaseUrl || `http://127.0.0.1:${Number.isFinite(parsedPort) ? parsedPort : 3000}/`),
      openMode: String(config?.webApp?.openMode || 'appCenter'),
    },
    updates: {
      manifestUrl: String(config?.updates?.manifestUrl || '').trim(),
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
        comments: String(feedbackFieldNames.comments || requirementsFieldNames.comments || '留言'),
        statusChangeLog: String(feedbackFieldNames.statusChangeLog || requirementsFieldNames.statusChangeLog || '处理状态变动记录'),
      },
    },
    debug: {
      userName: String(config?.debug?.userName || '测试用户'),
      openId: String(config?.debug?.openId || ''),
    },
    bitable: {
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
            feedback: String(toolPermissionToolFields.feedback || '反馈列表'),
          },
        },
      },
      links: Array.isArray(config?.bitable?.links) ? config.bitable.links : [],
    },
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
