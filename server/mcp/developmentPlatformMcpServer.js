import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import {
  NodeStreamableHTTPServerTransport,
  hostHeaderValidation,
  originValidation,
} from '@modelcontextprotocol/node';
import { z } from 'zod';

export const DEVELOPMENT_PLATFORM_MCP_TOOL_ID = 'get_my_approved_ai_plans';

const AUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_AUTH_FAILURES = 20;
const TOOL_INPUT_SCHEMA = z.object({
  operation: z.enum(['list', 'detail']).default('list')
    .describe('list 返回分页摘要，detail 返回单个方案的完整 Markdown'),
  submissionId: z.string().trim().min(1).max(200).optional()
    .describe('detail 操作必填，来自 list 返回的 submissionId'),
  projectId: z.string().trim().min(1).max(200).optional()
    .describe('list 操作可选，仅返回指定项目'),
  toolId: z.enum(['requirements', 'bugs']).optional()
    .describe('list 操作可选，仅返回需求或 Bug'),
  limit: z.number().int().min(1).max(50).default(20)
    .describe('list 每页数量，范围 1 到 50'),
  offset: z.number().int().min(0).max(5000).default(0)
    .describe('list 分页偏移量，范围 0 到 5000'),
});

export function registerDevelopmentPlatformMcp(app, options) {
  const handler = createDevelopmentPlatformMcpHandler(options);
  app.all('/mcp', handler);
  return handler;
}

export function createDevelopmentPlatformMcpHandler({
  authenticate,
  executeAiPlanTool,
  allowedHostnames = getAllowedMcpHostnames(),
  serverVersion = '0.0.0',
  authRateLimiter = createFailedAuthRateLimiter(),
  onError = () => {},
}) {
  if (typeof authenticate !== 'function' || typeof executeAiPlanTool !== 'function') {
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
      executeAiPlanTool,
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
  executeAiPlanTool,
  serverVersion,
  onError,
}) {
  const server = new McpServer({
    name: 'igp-development-platform',
    version: String(serverVersion || '0.0.0'),
  });
  server.registerTool(
    DEVELOPMENT_PLATFORM_MCP_TOOL_ID,
    {
      title: '获取与自己有关的AI计划',
      description: '获取当前用户作为处理人的、已经通过审核的需求或 Bug AI 计划。支持分页摘要和按 submissionId 获取完整 Markdown。',
      inputSchema: TOOL_INPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (args.operation === 'detail' && !args.submissionId) {
        return createToolErrorResult('detail 操作必须提供 submissionId');
      }
      try {
        const output = await executeAiPlanTool({
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
        if (error?.code !== 'MCP_AI_PLAN_NOT_FOUND') {
          onError(error, { phase: 'tool' });
        }
        return createToolErrorResult(
          error?.code === 'MCP_AI_PLAN_NOT_FOUND'
            ? error.message
            : '获取 AI 计划失败',
        );
      }
    },
  );
  return server;
}

function createToolErrorResult(message) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: String(message || '工具执行失败'),
    }],
  };
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
