import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const AUTOMATION_REQUEST_TIMEOUT_MS = 15_000;
const AUTOMATION_READ_DEADLINE_MS = 90 * 1000;
const DEPLOY_JOB_DEADLINE_MS = 30 * 60 * 1000;

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const metadataPath = resolveAutomationMetadataPath();

  if (!fs.existsSync(metadataPath)) {
    throw new Error('未发现正在运行的开发端调试工具。请先启动 IGP LAN Deploy Tool 并切换到开发端模式。');
  }

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    throw new Error('调试工具自动化状态文件无效，请重启开发端调试工具。');
  }

  const sourcePath = path.resolve(options.sourcePath || process.cwd());
  const sourceType = options.sourceType;

  if (options.mode === 'status') {
    const query = new URLSearchParams({ targetId: options.targetId });
    const status = await requestAutomationWithRetry(
      metadata,
      'GET',
      `/v1/target/status?${query}`,
    );
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (options.mode === 'logs') {
    const query = new URLSearchParams({
      targetId: options.targetId,
      name: options.logName,
    });
    const log = await requestAutomationWithRetry(
      metadata,
      'GET',
      `/v1/target/log?${query}`,
    );
    process.stdout.write(log.text || '');
    return;
  }

  if (options.mode === 'action') {
    const result = await requestAutomation(metadata, 'POST', '/v1/target/action', {
      targetId: options.targetId,
      action: options.action,
    }, {
      timeoutMs: 75_000,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const created = await requestAutomation(metadata, 'POST', '/v1/deploy', {
    targetId: options.targetId,
    sourcePath,
    sourceType,
  });

  console.log(`[deploy-debug] 已创建任务 ${created.jobId}`);
  const deadline = Date.now() + DEPLOY_JOB_DEADLINE_MS;
  let previousMessage = '';
  let waitingMessageShown = false;
  while (Date.now() < deadline) {
    await wait(1000);
    let job;
    try {
      job = await requestAutomation(
        metadata,
        'GET',
        `/v1/jobs/${encodeURIComponent(created.jobId)}`,
      );
      waitingMessageShown = false;
    } catch (error) {
      if (!isTransientAutomationError(error)) {
        throw error;
      }
      if (!waitingMessageShown) {
        console.log('[deploy-debug] 开发端正在处理较大的发布产物，继续等待任务状态');
        waitingMessageShown = true;
      }
      continue;
    }
    const summary = `${job.phase}: ${job.message}`;
    if (summary !== previousMessage) {
      console.log(`[deploy-debug] ${summary}`);
      previousMessage = summary;
    }
    if (job.status === 'completed') {
      const checks = job.result?.checks || {};
      console.log(
        `[deploy-debug] 远端验证通过：版本 ${job.result?.manifest?.appVersion || 'unknown'}，`
        + `应用端口 ${checks.appPort || '--'}，Inspector ${checks.inspectorPort || '--'}`,
      );
      return;
    }
    if (job.status === 'failed') {
      throw new Error(`远端部署调试失败：${job.error || job.message}`);
    }
  }
  throw new Error('等待远端部署任务完成超时');
}

function parseArguments(args) {
  const parsed = {
    targetId: '',
    sourcePath: '',
    sourceType: 'repository',
    mode: 'deploy',
    logName: '',
    action: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--target') {
      parsed.targetId = String(args[index + 1] || '');
      index += 1;
    } else if (item === '--source') {
      parsed.sourcePath = String(args[index + 1] || '');
      index += 1;
    } else if (item === '--publish') {
      parsed.sourcePath = String(args[index + 1] || '');
      parsed.sourceType = 'publish';
      index += 1;
    } else if (item === '--status') {
      parsed.mode = 'status';
    } else if (item === '--logs') {
      parsed.mode = 'logs';
      parsed.logName = String(args[index + 1] || '');
      index += 1;
    } else if (item === '--action') {
      parsed.mode = 'action';
      parsed.action = String(args[index + 1] || '');
      index += 1;
    }
  }
  if (parsed.mode === 'logs' && !['stdout', 'stderr', 'client', 'audit'].includes(parsed.logName)) {
    fail('--logs 只支持 stdout、stderr、client 或 audit');
  }
  if (parsed.mode === 'action' && !['start', 'stop', 'restart', 'rollback'].includes(parsed.action)) {
    fail('--action 只支持 start、stop、restart 或 rollback');
  }
  return parsed;
}

function resolveAutomationMetadataPath() {
  if (process.env.IGP_DEPLOY_AUTOMATION_FILE) {
    return path.resolve(process.env.IGP_DEPLOY_AUTOMATION_FILE);
  }
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'IGP LAN Deploy Tool', 'automation.json');
}

async function requestAutomationWithRetry(metadata, method, requestPath, body) {
  const deadline = Date.now() + AUTOMATION_READ_DEADLINE_MS;
  let waitingMessageShown = false;
  while (Date.now() < deadline) {
    try {
      return await requestAutomation(metadata, method, requestPath, body);
    } catch (error) {
      if (!isTransientAutomationError(error)) {
        throw error;
      }
      if (!waitingMessageShown) {
        console.log('[deploy-debug] 开发端或目标端正忙，继续等待响应');
        waitingMessageShown = true;
      }
      await wait(1000);
    }
  }
  throw new Error('等待开发端调试工具响应超时');
}

function requestAutomation(metadata, method, requestPath, body, options = {}) {
  const content = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: metadata.host || '127.0.0.1',
      port: metadata.port,
      method,
      path: requestPath,
      headers: {
        Authorization: `Bearer ${metadata.token}`,
        Accept: 'application/json',
        ...(content ? {
          'Content-Type': 'application/json',
          'Content-Length': String(content.length),
        } : {}),
      },
      timeout: options.timeoutMs || AUTOMATION_REQUEST_TIMEOUT_MS,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          reject(new Error('调试工具返回了无效响应'));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(payload.message || `自动化请求失败：HTTP ${response.statusCode}`));
          return;
        }
        resolve(payload);
      });
    });
    request.on('timeout', () => request.destroy(new Error('连接开发端调试工具超时')));
    request.on('error', reject);
    if (content) {
      request.write(content);
    }
    request.end();
  });
}

function isTransientAutomationError(error) {
  const code = String(error?.code || '');
  const message = error instanceof Error ? error.message : String(error);
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code)
    || /超时|socket hang up|连接被重置/i.test(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`[deploy-debug] ${message}`);
  process.exit(1);
}
