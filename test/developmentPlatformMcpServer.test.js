import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  DEVELOPMENT_PLATFORM_MCP_TOOL_ID,
  DEVELOPMENT_PLATFORM_MCP_TOOL_IDS,
  createFailedAuthRateLimiter,
  registerDevelopmentPlatformMcp,
} from '../server/mcp/developmentPlatformMcpServer.js';

async function startTestServer(options = {}) {
  const app = express();
  app.use(express.json());
  registerDevelopmentPlatformMcp(app, {
    allowedHostnames: ['127.0.0.1', 'localhost'],
    authenticate: async (token) => (
      token === 'valid-token'
        ? { token: 'tenant-token', user: { openId: 'ou_current' } }
        : null
    ),
    executeTool: async ({ toolName, arguments: args }) => {
      if (toolName === DEVELOPMENT_PLATFORM_MCP_TOOL_ID) {
        return args.operation === 'detail'
          ? {
              operation: 'detail',
              plan: {
                submissionId: args.submissionId,
                markdown: '# Detail',
              },
            }
          : {
              operation: 'list',
              total: 1,
              offset: args.offset,
              limit: args.limit,
              hasMore: false,
              nextOffset: null,
              plans: [{ submissionId: 'plan-1' }],
              warnings: [],
            };
      }
      if (toolName === DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_ACCESSIBLE_PROJECTS) {
        return {
          total: 1,
          projects: [{ projectId: '50' }],
        };
      }
      return { ok: true, toolName, arguments: args };
    },
    ...options,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('official MCP client initializes, lists twelve tools and calls read/write operations', async () => {
  const server = await startTestServer();
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: {
        Authorization: 'Bearer valid-token',
      },
    },
  });
  const client = new Client({ name: 'igp-test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 12);
    assert.deepEqual(
      new Set(tools.tools.map((tool) => tool.name)),
      new Set(Object.values(DEVELOPMENT_PLATFORM_MCP_TOOL_IDS)),
    );
    const approvedTool = tools.tools.find(
      (tool) => tool.name === DEVELOPMENT_PLATFORM_MCP_TOOL_ID,
    );
    assert.equal(approvedTool.title, '获取与自己有关的AI计划');
    assert.equal(approvedTool.annotations.readOnlyHint, true);
    const statusTool = tools.tools.find(
      (tool) => tool.name === DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.UPDATE_WORK_ITEM_STATUS,
    );
    assert.equal(statusTool.annotations.readOnlyHint, false);
    const appliedTool = tools.tools.find(
      (tool) => tool.name === DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.SET_AI_PLAN_APPLIED,
    );
    assert.equal(appliedTool.title, '设置AI计划已应用状态');
    assert.equal(appliedTool.annotations.readOnlyHint, false);

    const listResult = await client.callTool({
      name: DEVELOPMENT_PLATFORM_MCP_TOOL_ID,
      arguments: {
        operation: 'list',
        limit: 10,
        offset: 0,
      },
    });
    assert.equal(listResult.isError, undefined);
    assert.equal(listResult.structuredContent.operation, 'list');
    assert.equal(listResult.structuredContent.plans[0].submissionId, 'plan-1');

    const detailResult = await client.callTool({
      name: DEVELOPMENT_PLATFORM_MCP_TOOL_ID,
      arguments: {
        operation: 'detail',
        submissionId: 'plan-1',
      },
    });
    assert.equal(detailResult.structuredContent.plan.markdown, '# Detail');

    const projectResult = await client.callTool({
      name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_ACCESSIBLE_PROJECTS,
      arguments: { limit: 10, offset: 0 },
    });
    assert.equal(projectResult.structuredContent.projects[0].projectId, '50');

    const statusResult = await client.callTool({
      name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.UPDATE_WORK_ITEM_STATUS,
      arguments: {
        projectId: '50',
        toolId: 'bugs',
        recordId: 'record-1',
        expectedCurrentStatus: '未处理',
        newStatus: '修复中',
        notifyProposer: false,
        clientMutationId: 'mutation-1',
      },
    });
    assert.equal(
      statusResult.structuredContent.toolName,
      DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.UPDATE_WORK_ITEM_STATUS,
    );

    const appliedResult = await client.callTool({
      name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.SET_AI_PLAN_APPLIED,
      arguments: {
        submissionId: 'plan-1',
        applied: true,
        clientMutationId: 'mutation-2',
      },
    });
    assert.equal(
      appliedResult.structuredContent.toolName,
      DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.SET_AI_PLAN_APPLIED,
    );
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
});

test('MCP HTTP endpoint rejects missing auth, invalid hosts and unsupported methods', async () => {
  const server = await startTestServer();
  try {
    const unauthorized = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate') || '', /^Bearer/);
    assert.equal((await unauthorized.json()).error.message, '身份验证失败');

    const forbiddenHost = await requestWithHost(server.url, {
      host: 'untrusted.example',
      authorization: 'Bearer valid-token',
    });
    assert.equal(forbiddenHost.statusCode, 403);

    const forbiddenOrigin = await fetch(server.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-token',
        'Content-Type': 'application/json',
        Origin: 'http://untrusted.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(forbiddenOrigin.status, 403);

    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(server.url, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'POST');
    }
  } finally {
    await server.close();
  }
});

function requestWithHost(urlValue, headers) {
  const url = new URL(urlValue);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve({
        statusCode: response.statusCode,
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('MCP failed authentication is rate limited per client address', async () => {
  const server = await startTestServer({
    authRateLimiter: createFailedAuthRateLimiter({
      maxFailures: 2,
      windowMs: 60_000,
    }),
  });
  try {
    const request = () => fetch(server.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer invalid-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal((await request()).status, 401);
    assert.equal((await request()).status, 401);
    assert.equal((await request()).status, 429);
  } finally {
    await server.close();
  }
});

test('MCP tool errors preserve expected codes and public confirmation details', async () => {
  const server = await startTestServer({
    executeTool: async ({ toolName }) => {
      if (toolName === DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.UPDATE_WORK_ITEM_STATUS) {
        const error = new Error('当前需求要求提交附件，但还没有提交任何附件');
        error.mcpCode = 'confirmation_required';
        error.publicDetails = {
          confirmField: 'confirmWithoutRequiredAttachment',
          currentStatus: '处理中',
          requestedStatus: '已完成',
        };
        throw error;
      }
      return { ok: true };
    },
  });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: {
        Authorization: 'Bearer valid-token',
      },
    },
  });
  const client = new Client({ name: 'igp-error-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.UPDATE_WORK_ITEM_STATUS,
      arguments: {
        projectId: '50',
        toolId: 'requirements',
        recordId: 'record-1',
        expectedCurrentStatus: '处理中',
        newStatus: '已完成',
        notifyProposer: false,
        clientMutationId: 'status-1',
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'confirmation_required');
    assert.deepEqual(result.structuredContent.error.details, {
      confirmField: 'confirmWithoutRequiredAttachment',
      currentStatus: '处理中',
      requestedStatus: '已完成',
    });

    const missingDetailId = await client.callTool({
      name: DEVELOPMENT_PLATFORM_MCP_TOOL_IDS.LIST_MY_PENDING_AI_PLAN_REVIEWS,
      arguments: { operation: 'detail' },
    });
    assert.equal(missingDetailId.isError, true);
    assert.equal(missingDetailId.structuredContent.error.code, 'invalid_argument');
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
});
