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
    executeAiPlanTool: async ({ arguments: args }) => (
      args.operation === 'detail'
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
          }
    ),
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

test('official MCP client initializes, lists one tool and calls list/detail operations', async () => {
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
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].name, DEVELOPMENT_PLATFORM_MCP_TOOL_ID);
    assert.equal(tools.tools[0].title, '获取与自己有关的AI计划');

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
