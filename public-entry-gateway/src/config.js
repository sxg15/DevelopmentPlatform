import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = Object.freeze({
  server: {
    host: '127.0.0.1',
    port: 3100,
  },
  publicEntry: {
    baseUrl: 'http://47.100.74.169/',
    clientIpProbeUrl: 'http://47.100.74.169/__igp/client-ip',
    relayToken: '',
  },
  localPlatform: {
    baseUrl: 'http://172.16.20.205:3000/',
    healthUrl: 'http://127.0.0.1:3000/api/health',
  },
  feishu: {
    appId: '',
    oauthScope: 'contact:user.base:readonly',
  },
  accessControl: {
    additionalAllowedCidrs: [],
  },
  monitoring: {
    healthIntervalMs: 2000,
    healthTimeoutMs: 1500,
    requiredHealthyChecks: 2,
    publicIpIntervalMs: 30000,
    publicIpTimeoutMs: 3000,
    publicIpMaxAgeMs: 90000,
    maintenanceMaxAgeMs: 30 * 60 * 1000,
  },
  ssh: {
    executable: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    host: '47.100.74.169',
    port: 22,
    user: 'igp-entry',
    identityFile: 'ssh\\id_ed25519',
    knownHostsFile: 'ssh\\known_hosts',
    remoteBindHost: '127.0.0.1',
    remoteBindPort: 18080,
    serverAliveIntervalSeconds: 15,
    serverAliveCountMax: 3,
  },
  deployment: {
    maintenanceFile: '',
  },
});

export function loadGatewayConfig(configPath = process.env.IGP_PUBLIC_ENTRY_CONFIG_PATH) {
  const resolvedConfigPath = path.resolve(
    configPath || path.join(process.cwd(), 'config.json'),
  );
  let rawConfig;
  try {
    rawConfig = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `无法读取公网入口配置 ${resolvedConfigPath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalizeGatewayConfig(rawConfig, {
    configPath: resolvedConfigPath,
  });
}

export function normalizeGatewayConfig(rawConfig, { configPath = 'config.json' } = {}) {
  const configDirectory = path.dirname(path.resolve(configPath));
  const config = {
    server: {
      host: normalizeText(rawConfig?.server?.host, DEFAULTS.server.host),
      port: normalizePort(rawConfig?.server?.port, DEFAULTS.server.port, 'server.port'),
    },
    publicEntry: {
      baseUrl: normalizeHttpUrl(
        rawConfig?.publicEntry?.baseUrl,
        DEFAULTS.publicEntry.baseUrl,
        'publicEntry.baseUrl',
      ),
      clientIpProbeUrl: normalizeHttpUrl(
        rawConfig?.publicEntry?.clientIpProbeUrl,
        DEFAULTS.publicEntry.clientIpProbeUrl,
        'publicEntry.clientIpProbeUrl',
      ),
      relayToken: normalizeText(rawConfig?.publicEntry?.relayToken, ''),
    },
    localPlatform: {
      baseUrl: normalizeHttpUrl(
        rawConfig?.localPlatform?.baseUrl,
        DEFAULTS.localPlatform.baseUrl,
        'localPlatform.baseUrl',
      ),
      healthUrl: normalizeHttpUrl(
        rawConfig?.localPlatform?.healthUrl,
        DEFAULTS.localPlatform.healthUrl,
        'localPlatform.healthUrl',
      ),
    },
    feishu: {
      appId: normalizeText(rawConfig?.feishu?.appId, DEFAULTS.feishu.appId),
      oauthScope: normalizeText(
        rawConfig?.feishu?.oauthScope,
        DEFAULTS.feishu.oauthScope,
      ),
    },
    accessControl: {
      additionalAllowedCidrs: normalizeTextList(
        rawConfig?.accessControl?.additionalAllowedCidrs,
      ),
    },
    monitoring: {
      healthIntervalMs: normalizePositiveInteger(
        rawConfig?.monitoring?.healthIntervalMs,
        DEFAULTS.monitoring.healthIntervalMs,
      ),
      healthTimeoutMs: normalizePositiveInteger(
        rawConfig?.monitoring?.healthTimeoutMs,
        DEFAULTS.monitoring.healthTimeoutMs,
      ),
      requiredHealthyChecks: normalizePositiveInteger(
        rawConfig?.monitoring?.requiredHealthyChecks,
        DEFAULTS.monitoring.requiredHealthyChecks,
      ),
      publicIpIntervalMs: normalizePositiveInteger(
        rawConfig?.monitoring?.publicIpIntervalMs,
        DEFAULTS.monitoring.publicIpIntervalMs,
      ),
      publicIpTimeoutMs: normalizePositiveInteger(
        rawConfig?.monitoring?.publicIpTimeoutMs,
        DEFAULTS.monitoring.publicIpTimeoutMs,
      ),
      publicIpMaxAgeMs: normalizePositiveInteger(
        rawConfig?.monitoring?.publicIpMaxAgeMs,
        DEFAULTS.monitoring.publicIpMaxAgeMs,
      ),
      maintenanceMaxAgeMs: normalizePositiveInteger(
        rawConfig?.monitoring?.maintenanceMaxAgeMs,
        DEFAULTS.monitoring.maintenanceMaxAgeMs,
      ),
    },
    ssh: {
      executable: resolveConfigPath(
        configDirectory,
        normalizeText(rawConfig?.ssh?.executable, DEFAULTS.ssh.executable),
      ),
      host: normalizeText(rawConfig?.ssh?.host, DEFAULTS.ssh.host),
      port: normalizePort(rawConfig?.ssh?.port, DEFAULTS.ssh.port, 'ssh.port'),
      user: normalizeText(rawConfig?.ssh?.user, DEFAULTS.ssh.user),
      identityFile: resolveConfigPath(
        configDirectory,
        normalizeText(rawConfig?.ssh?.identityFile, DEFAULTS.ssh.identityFile),
      ),
      knownHostsFile: resolveConfigPath(
        configDirectory,
        normalizeText(rawConfig?.ssh?.knownHostsFile, DEFAULTS.ssh.knownHostsFile),
      ),
      remoteBindHost: normalizeText(
        rawConfig?.ssh?.remoteBindHost,
        DEFAULTS.ssh.remoteBindHost,
      ),
      remoteBindPort: normalizePort(
        rawConfig?.ssh?.remoteBindPort,
        DEFAULTS.ssh.remoteBindPort,
        'ssh.remoteBindPort',
      ),
      serverAliveIntervalSeconds: normalizePositiveInteger(
        rawConfig?.ssh?.serverAliveIntervalSeconds,
        DEFAULTS.ssh.serverAliveIntervalSeconds,
      ),
      serverAliveCountMax: normalizePositiveInteger(
        rawConfig?.ssh?.serverAliveCountMax,
        DEFAULTS.ssh.serverAliveCountMax,
      ),
    },
    deployment: {
      maintenanceFile: rawConfig?.deployment?.maintenanceFile
        ? resolveConfigPath(configDirectory, String(rawConfig.deployment.maintenanceFile))
        : '',
    },
    configPath: path.resolve(configPath),
  };

  if (config.server.host !== '127.0.0.1' && config.server.host !== '::1') {
    throw new Error('server.host 必须绑定到回环地址');
  }
  if (config.publicEntry.relayToken && config.publicEntry.relayToken.length < 32) {
    throw new Error('publicEntry.relayToken 启用时至少需要 32 个字符');
  }
  if (!config.ssh.host || !config.ssh.user) {
    throw new Error('ssh.host 和 ssh.user 不能为空');
  }
  return config;
}

function normalizeText(value, fallback) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeTextList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
    : [];
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizePort(value, fallback, fieldName) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${fieldName} 必须是 1 到 65535 之间的整数`);
  }
  return port;
}

function normalizeHttpUrl(value, fallback, fieldName) {
  let url;
  try {
    url = new URL(normalizeText(value, fallback));
  } catch {
    throw new Error(`${fieldName} 必须是有效的 HTTP 地址`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${fieldName} 必须使用 HTTP 或 HTTPS`);
  }
  return url.toString();
}

function resolveConfigPath(configDirectory, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configDirectory, value);
}
