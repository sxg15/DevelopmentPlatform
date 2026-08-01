import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import {
  NodeStreamableHTTPServerTransport,
  hostHeaderValidation,
  originValidation,
} from '@modelcontextprotocol/node';
import { z } from 'zod';

export const DEVELOPMENT_PLATFORM_MCP_TOOL_IDS = Object.freeze({
  LIST_ACCESSIBLE_PROJECTS: 'list_accessible_projects',
  LIST_MY_WORK_ITEMS: 'list_my_work_items',
  GET_WORK_ITEM_DETAIL: 'get_work_item_detail',
  GET_PROJECT_OVERVIEW: 'get_project_overview',
  GET_PROJECT_VERSION_OVERVIEW: 'get_project_version_overview',
  LIST_MY_PENDING_AI_PLAN_REVIEWS: 'list_my_pending_ai_plan_reviews',
  GET_MY_APPROVED_AI_PLANS: 'get_my_approved_ai_plans',
  SET_AI_PLAN_APPLIED: 'set_ai_plan_applied',
  ADD_WORK_ITEM_COMMENT: 'add_work_item_comment',
  SUBMIT_AI_PLAN_FOR_REVIEW: 'submit_ai_plan_for_review',
  ADD_VERSION_COMMENT: 'add_version_comment',
  UPDATE_WORK_ITEM_STATUS: 'update_work_item_status',
});
export const DEVELOPMENT_PLATFORM_MCP_TOOL_ID =
  DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_MY_APPROVED_AI_PLANS;

const AUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_AUTH_FAILURES = 20;
const PROJECT_ID_SCHEMA = z.string().trim().min(1).max(200);
const RECORD_ID_SCHEMA = z.string().trim().min(1).max(200);
const TOOL_ID_SCHEMA = z.enum(['requirements', 'bugs', 'feedback']);
const AI_TOOL_ID_SCHEMA = z.enum(['requirements', 'bugs']);
const LIMIT_SCHEMA = z.number().int().min(1).max(50).default(20);
const OFFSET_SCHEMA = z.number().int().min(0).max(5000).default(0);
const CLIENT_MUTATION_ID_SCHEMA = z.string().trim().min(1).max(100)
  .describe('调用方生成的写操作唯一ID；重试同一操作必须复用，相同ID不得用于不同请求');
const MENTIONED_OPEN_IDS_SCHEMA = z.array(
  z.string().trim().min(1).max(200),
).max(20).default([])
  .describe('需要在留言中提及的飞书 Open ID；无提及时传空数组');
const AI_SOURCE_REFERENCE_SCHEMA = z.object({
  rootId: z.string().trim().min(1).max(100),
  relativePath: z.string().trim().min(1).max(500),
  startLine: z.number().int().min(1).default(1),
  endLine: z.number().int().min(1).default(1),
  note: z.string().trim().max(500).default(''),
});

const APPROVED_AI_PLAN_SCHEMA = z.object({
  operation: z.enum(['list', 'detail']).default('list')
    .describe('list 返回分页摘要，detail 返回单个方案的完整 Markdown'),
  submissionId: z.string().trim().min(1).max(200).optional()
    .describe('detail 操作必填，来自 list 返回的 submissionId'),
  projectId: PROJECT_ID_SCHEMA.optional()
    .describe('list 操作可选，仅返回指定项目'),
  toolId: AI_TOOL_ID_SCHEMA.optional()
    .describe('list 操作可选，仅返回需求或 Bug'),
  limit: LIMIT_SCHEMA,
  offset: OFFSET_SCHEMA,
});

const TOOL_DEFINITIONS = Object.freeze([
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_ACCESSIBLE_PROJECTS,
    title: '获取可访问项目',
    description: '获取当前用户可访问的项目、工具权限和 AI 计划可用状态。',
    inputSchema: z.object({
      limit: LIMIT_SCHEMA,
      offset: OFFSET_SCHEMA,
    }),
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_MY_WORK_ITEMS,
    title: '获取我的工作项',
    description: '获取当前用户作为处理人的需求、Bug 或反馈，支持过滤和分页。',
    inputSchema: z.object({
      projectId: PROJECT_ID_SCHEMA.optional(),
      toolId: TOOL_ID_SCHEMA.optional(),
      statuses: z.array(z.string().trim().min(1).max(100)).max(20).default([])
        .describe('可选状态白名单；空数组表示不过滤状态'),
      search: z.string().trim().max(200).default('')
        .describe('按项目、类型、编号、标题、描述、状态和优先级搜索'),
      includeCompleted: z.boolean().default(false)
        .describe('是否包含已完成或已关闭状态，默认不包含'),
      limit: LIMIT_SCHEMA,
      offset: OFFSET_SCHEMA,
    }),
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_WORK_ITEM_DETAIL,
    title: '获取工作项详情',
    description: '读取有权限查看的单个需求、Bug 或反馈的安全详情。',
    inputSchema: z.object({
      projectId: PROJECT_ID_SCHEMA,
      toolId: TOOL_ID_SCHEMA,
      recordId: RECORD_ID_SCHEMA,
    }),
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_PROJECT_OVERVIEW,
    title: '获取项目总览',
    description: '读取项目或与当前用户有关的项目总览，不创建任何项目数据。',
    inputSchema: z.object({
      projectId: PROJECT_ID_SCHEMA,
      scope: z.enum(['project', 'mine']).default('project')
        .describe('project 查看项目范围，mine 仅统计与当前用户有关的工作项'),
      trendDays: z.union([z.literal(14), z.literal(30), z.literal(90)]).default(30)
        .describe('趋势统计天数'),
    }),
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_PROJECT_VERSION_OVERVIEW,
    title: '获取项目版本总览',
    description: '读取项目各平台活动版本和近期正式版本，不初始化版本管理。',
    inputSchema: z.object({
      projectId: PROJECT_ID_SCHEMA,
    }),
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_MY_PENDING_AI_PLAN_REVIEWS,
    title: '获取待我审核的AI方案',
    description: '获取当前用户有权审核的待审核 AI 方案，支持列表和详情。',
    inputSchema: z.object({
      operation: z.enum(['list', 'detail']).default('list')
        .describe('list 返回分页摘要，detail 返回完整 Markdown 和修订摘要'),
      submissionId: z.string().trim().min(1).max(200).optional()
        .describe('detail 操作必填，来自 list 返回的 submissionId'),
      projectId: PROJECT_ID_SCHEMA.optional(),
      toolId: AI_TOOL_ID_SCHEMA.optional(),
      limit: LIMIT_SCHEMA,
      offset: OFFSET_SCHEMA,
    }),
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.GET_MY_APPROVED_AI_PLANS,
    title: '获取与自己有关的AI计划',
    description: '获取当前用户作为处理人的、已经通过审核的需求或 Bug AI 计划。支持分页摘要和按 submissionId 获取完整 Markdown。',
    inputSchema: APPROVED_AI_PLAN_SCHEMA,
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.SET_AI_PLAN_APPLIED,
    title: '设置AI计划已应用状态',
    description: '为当前用户负责的已通过 AI 计划设置或取消独立的已应用标记。',
    inputSchema: z.object({
      submissionId: z.string().trim().min(1).max(200),
      applied: z.boolean(),
      clientMutationId: CLIENT_MUTATION_ID_SCHEMA,
    }),
    readOnly: false,
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.ADD_WORK_ITEM_COMMENT,
    title: '添加工作项留言',
    description: '为有权限访问的需求、Bug 或反馈添加留言。',
    inputSchema: z.object({
      projectId: PROJECT_ID_SCHEMA,
      toolId: TOOL_ID_SCHEMA,
      recordId: RECORD_ID_SCHEMA,
      content: z.string().trim().min(1).max(2000),
      mentionedUserOpenIds: MENTIONED_OPEN_IDS_SCHEMA,
      notifyMentioned: z.boolean()
        .describe('是否向已接受的被提及用户发送飞书通知，必须显式选择'),
      clientMutationId: CLIENT_MUTATION_ID_SCHEMA,
    }),
    readOnly: false,
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.SUBMIT_AI_PLAN_FOR_REVIEW,
    title: '提交AI方案审核',
    description: '为需求或 Bug 提交一份 MCP 来源的 Markdown AI 方案进入现有审核流程。',
    inputSchema: z.object({
      projectId: PROJECT_ID_SCHEMA,
      toolId: AI_TOOL_ID_SCHEMA,
      recordId: RECORD_ID_SCHEMA,
      title: z.string().trim().min(1).max(200),
      summary: z.string().trim().max(2000).default(''),
      markdown: z.string().trim().min(1).max(200000),
      sourceReferences: z.array(AI_SOURCE_REFERENCE_SCHEMA).max(100).default([])
        .describe('可选代码来源引用；rootId 必须属于该项目已配置的代码根目录'),
      clientMutationId: CLIENT_MUTATION_ID_SCHEMA,
    }),
    readOnly: false,
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.ADD_VERSION_COMMENT,
    title: '添加版本留言',
    description: '为已初始化的项目版本记录添加留言。',
    inputSchema: z.object({
      projectId: PROJECT_ID_SCHEMA,
      recordId: RECORD_ID_SCHEMA,
      content: z.string().trim().min(1).max(2000),
      mentionedUserOpenIds: MENTIONED_OPEN_IDS_SCHEMA,
      notifyMentioned: z.boolean()
        .describe('是否向已接受的被提及用户发送飞书通知，必须显式选择'),
      clientMutationId: CLIENT_MUTATION_ID_SCHEMA,
    }),
    readOnly: false,
  }),
  createToolDefinition({
    name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.UPDATE_WORK_ITEM_STATUS,
    title: '更新工作项状态',
    description: '由当前处理人更新需求、Bug 或反馈状态，并校验原状态。',
    inputSchema: z.object({
      projectId: PROJECT_ID_SCHEMA,
      toolId: TOOL_ID_SCHEMA,
      recordId: RECORD_ID_SCHEMA,
      expectedCurrentStatus: z.string().trim().min(1).max(100)
        .describe('调用方读取到的当前状态；状态已变化时工具返回 conflict'),
      newStatus: z.string().trim().min(1).max(100),
      message: z.string().trim().max(2000).default(''),
      notifyProposer: z.boolean()
        .describe('是否向提议人发送飞书状态变更通知，必须显式选择'),
      confirmWithoutRequiredAttachment: z.boolean().default(false)
        .describe('仅在工具返回 confirmation_required 后，由调用方确认无附件继续时设为 true'),
      clientMutationId: CLIENT_MUTATION_ID_SCHEMA,
    }),
    readOnly: false,
  }),
]);

export function registerDevelopmentPlatformMcp(app, options) {
  const handler = createDevelopmentPlatformMcpHandler(options);
  app.all('/mcp', handler);
  return handler;
}

export function createDevelopmentPlatformMcpHandler({
  authenticate,
  executeTool,
  allowedHostnames = getAllowedMcpHostnames(),
  serverVersion = '0.0.0',
  authRateLimiter = createFailedAuthRateLimiter(),
  onError = () => {},
}) {
  if (typeof authenticate !== 'function' || typeof executeTool !== 'function') {
    throw new Error('MCP 服务器缺少认证或工具执行器');
  }

  const validateHost = hostHeaderValidation(allowedHostnames);
  const validateOrigin = originValidation(allowedHostnames);

  return async function developmentPlatformMcpHandler(request, response) {
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJsonRpcHttpError(response, 405, -32600, '仅支持 POST /mcp');
      return;
    }

    const clientKey = getClientKey(request);
    if (authRateLimiter.isBlocked(clientKey)) {
      response.setHeader('Retry-After', String(Math.ceil(AUTH_WINDOW_MS / 1000)));
      sendJsonRpcHttpError(response, 429, -32029, '身份验证尝试过于频繁');
      return;
    }

    const bearerToken = readBearerToken(request);
    let authContext = null;
    if (bearerToken) {
      try {
        authContext = await authenticate(bearerToken);
      } catch (error) {
        onError(error, { phase: 'authenticate' });
        sendJsonRpcHttpError(response, 503, -32603, 'MCP 身份验证服务暂时不可用');
        return;
      }
    }
    if (!authContext) {
      authRateLimiter.recordFailure(clientKey);
      response.setHeader(
        'WWW-Authenticate',
        'Bearer realm="igp-development-platform-mcp"',
      );
      sendJsonRpcHttpError(response, 401, -32001, '身份验证失败');
      return;
    }
    authRateLimiter.recordSuccess(clientKey);

    const server = createRequestMcpServer({
      authContext,
      executeTool,
      serverVersion,
      onError,
    });
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      onError(error, { phase: 'protocol' });
      if (!response.headersSent) {
        sendJsonRpcHttpError(response, 500, -32603, 'MCP 请求处理失败');
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      await server.close().catch(() => {});
    }
  };
}

export function createFailedAuthRateLimiter({
  maxFailures = MAX_AUTH_FAILURES,
  windowMs = AUTH_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  function getActiveEntry(key) {
    const entry = entries.get(key);
    if (!entry) {
      return null;
    }
    if (now() - entry.startedAt >= windowMs) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  return {
    isBlocked(key) {
      return Number(getActiveEntry(key)?.failures || 0) >= maxFailures;
    },
    recordFailure(key) {
      const entry = getActiveEntry(key);
      if (entry) {
        entry.failures += 1;
      } else {
        entries.set(key, { failures: 1, startedAt: now() });
      }
    },
    recordSuccess(key) {
      entries.delete(key);
    },
    size() {
      return entries.size;
    },
  };
}

export function getAllowedMcpHostnames() {
  const hostnames = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    os.hostname(),
  ]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4') {
        hostnames.add(item.address);
      }
    }
  }
  return [...hostnames].map((item) => String(item || '').trim()).filter(Boolean);
}

function createRequestMcpServer({
  authContext,
  executeTool,
  serverVersion,
  onError,
}) {
  const server = new McpServer({
    name: 'igp-development-platform',
    version: String(serverVersion || '0.0.0'),
  });
  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args) => {
        if (
          ['get_my_approved_ai_plans', 'list_my_pending_ai_plan_reviews'].includes(tool.name)
          && args.operation === 'detail'
          && !args.submissionId
        ) {
          return createToolErrorResult('invalid_argument', 'detail 操作必须提供 submissionId');
        }
        try {
          const output = await executeTool({
            toolName: tool.name,
            authContext,
            arguments: args,
          });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(output, null, 2),
            }],
            structuredContent: output,
          };
        } catch (error) {
          const errorCode = normalizeMcpToolErrorCode(error);
          if (!isExpectedToolErrorCode(errorCode)) {
            onError(error, { phase: 'tool', toolName: tool.name });
          }
          return createToolErrorResult(
            errorCode,
            isExpectedToolErrorCode(errorCode)
              ? error.message
              : '工具执行失败',
            error?.publicDetails,
          );
        }
      },
    );
  }
  return server;
}

function createToolDefinition({
  name,
  title,
  description,
  inputSchema,
  readOnly = true,
}) {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });
}

function createToolErrorResult(code, message, details = null) {
  const error = {
    code: String(code || 'dependency_unavailable'),
    message: String(message || '工具执行失败'),
    ...(details && typeof details === 'object' ? { details } : {}),
  };
  return {
    isError: true,
    content: [{
      type: 'text',
      text: error.message,
    }],
    structuredContent: { error },
  };
}

function normalizeMcpToolErrorCode(error) {
  if (error?.code === 'MCP_AI_PLAN_NOT_FOUND') {
    return 'not_found';
  }
  const code = String(error?.mcpCode || '').trim();
  return isExpectedToolErrorCode(code) ? code : 'dependency_unavailable';
}

function isExpectedToolErrorCode(code) {
  return [
    'invalid_argument',
    'forbidden',
    'not_found',
    'conflict',
    'confirmation_required',
  ].includes(code);
}

function readBearerToken(request) {
  const header = String(request.headers?.authorization || '').trim();
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : '';
}

function getClientKey(request) {
  return String(
    request.ip
    || request.socket?.remoteAddress
    || request.connection?.remoteAddress
    || 'unknown',
  );
}

function sendJsonRpcHttpError(response, status, code, message) {
  response.status(status).type('application/json').send({
    jsonrpc: '2.0',
    error: {
      code,
      message,
    },
    id: null,
  });
}
