export const TOOL_NAME = 'IGP LAN Deploy Tool';
export const PROTOCOL_VERSION = 1;
export const DISCOVERY_PORT = 47321;
export const TARGET_CONTROL_PORT = 47322;
export const AUTOMATION_HOST = '127.0.0.1';
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const RELEASE_RETENTION_COUNT = 5;
export const LOG_READ_MAX_BYTES = 1024 * 1024;
export const SERVICE_START_TIMEOUT_MS = 45 * 1000;

export const DISCOVERY_QUERY = Object.freeze({
  type: 'igp-lan-deploy-discover',
  protocolVersion: PROTOCOL_VERSION,
});

export const TARGET_LOGS = Object.freeze({
  stdout: 'server.log',
  stderr: 'server.err.log',
  client: 'client-errors.log',
  agent: 'deploy-agent.log',
  audit: 'deploy-audit.jsonl',
});
