export const MCP_CLIENT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    fileName: 'config.toml',
  }),
  Object.freeze({
    id: 'claude-code',
    label: 'Claude Code',
    fileName: '.mcp.json',
  }),
  Object.freeze({
    id: 'cursor',
    label: 'Cursor',
    fileName: '.cursor/mcp.json',
  }),
  Object.freeze({
    id: 'gemini-cli',
    label: 'Gemini CLI',
    fileName: '.gemini/settings.json',
  }),
  Object.freeze({
    id: 'vscode',
    label: 'VS Code',
    fileName: '.vscode/mcp.json',
  }),
]);

const SERVER_NAME = 'igp-development-platform';

export function buildMcpClientConfigs({ serverUrl, token }) {
  const normalizedUrl = String(serverUrl || '').trim();
  const authorization = `Bearer ${String(token || '').trim()}`;
  const standardServer = {
    type: 'http',
    url: normalizedUrl,
    headers: {
      Authorization: authorization,
    },
  };

  const valuesById = {
    codex: [
      `[mcp_servers.${SERVER_NAME}]`,
      `url = ${JSON.stringify(normalizedUrl)}`,
      `http_headers = { Authorization = ${JSON.stringify(authorization)} }`,
    ].join('\n'),
    'claude-code': stringifyJson({
      mcpServers: {
        [SERVER_NAME]: standardServer,
      },
    }),
    cursor: stringifyJson({
      mcpServers: {
        [SERVER_NAME]: {
          url: normalizedUrl,
          headers: {
            Authorization: authorization,
          },
        },
      },
    }),
    'gemini-cli': stringifyJson({
      mcpServers: {
        [SERVER_NAME]: {
          httpUrl: normalizedUrl,
          headers: {
            Authorization: authorization,
          },
        },
      },
    }),
    vscode: stringifyJson({
      servers: {
        [SERVER_NAME]: standardServer,
      },
    }),
  };

  return MCP_CLIENT_DEFINITIONS.map((definition) => ({
    ...definition,
    value: valuesById[definition.id],
  }));
}

function stringifyJson(value) {
  return JSON.stringify(value, null, 2);
}
