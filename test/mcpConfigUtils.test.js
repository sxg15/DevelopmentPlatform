import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_CLIENT_DEFINITIONS,
  buildMcpClientConfigs,
} from '../src/ui/settings/mcpConfigUtils.js';

const SERVER_URL = 'http://192.168.1.20:3000/mcp';
const TOKEN = `igp_${'A'.repeat(43)}`;

test('MCP settings generate exact configs for five supported clients', () => {
  const configs = buildMcpClientConfigs({
    serverUrl: SERVER_URL,
    token: TOKEN,
  });
  assert.deepEqual(
    configs.map((config) => config.id),
    MCP_CLIENT_DEFINITIONS.map((definition) => definition.id),
  );
  assert.equal(configs.length, 5);
  assert.equal(configs[0].value, [
    '[mcp_servers.igp-development-platform]',
    `url = "${SERVER_URL}"`,
    `http_headers = { Authorization = "Bearer ${TOKEN}" }`,
  ].join('\n'));

  const claude = JSON.parse(configs.find((config) => config.id === 'claude-code').value);
  assert.deepEqual(claude, {
    mcpServers: {
      'igp-development-platform': {
        type: 'http',
        url: SERVER_URL,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
        },
      },
    },
  });
  assert.deepEqual(
    JSON.parse(configs.find((config) => config.id === 'cursor').value),
    {
      mcpServers: {
        'igp-development-platform': {
          url: SERVER_URL,
          headers: {
            Authorization: `Bearer ${TOKEN}`,
          },
        },
      },
    },
  );
  assert.deepEqual(
    JSON.parse(configs.find((config) => config.id === 'gemini-cli').value),
    {
      mcpServers: {
        'igp-development-platform': {
          httpUrl: SERVER_URL,
          headers: {
            Authorization: `Bearer ${TOKEN}`,
          },
        },
      },
    },
  );
  assert.deepEqual(
    JSON.parse(configs.find((config) => config.id === 'vscode').value),
    {
      servers: {
        'igp-development-platform': {
          type: 'http',
          url: SERVER_URL,
          headers: {
            Authorization: `Bearer ${TOKEN}`,
          },
        },
      },
    },
  );
});

test('MCP config generation replaces both endpoint and token', () => {
  const first = buildMcpClientConfigs({
    serverUrl: SERVER_URL,
    token: TOKEN,
  });
  const nextUrl = 'http://10.0.0.8:3000/mcp';
  const nextToken = `igp_${'B'.repeat(43)}`;
  const second = buildMcpClientConfigs({
    serverUrl: nextUrl,
    token: nextToken,
  });
  for (const config of second) {
    assert.match(config.value, new RegExp(nextUrl.replaceAll('.', '\\.')));
    assert.match(config.value, new RegExp(nextToken));
    assert.doesNotMatch(config.value, new RegExp(TOKEN));
  }
  assert.notDeepEqual(first, second);
});
