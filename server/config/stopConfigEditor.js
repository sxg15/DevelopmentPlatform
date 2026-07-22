import fs from 'node:fs';
import path from 'node:path';

const rootDir = resolveRootDir(process.argv.slice(2));
const lockPath = path.join(rootDir, 'runtime', 'config-editor.lock');

const metadata = readLockMetadata(lockPath);
if (!metadata) {
  console.log('IGP 运行配置工具当前未运行。');
  process.exit(0);
}

const pid = Number(metadata.pid);
const editorUrl = parseEditorUrl(metadata.url);
if (!Number.isInteger(pid) || pid <= 0 || !editorUrl) {
  removeLock(lockPath);
  console.log('已清理无效的配置工具运行记录。');
  process.exit(0);
}

if (!isProcessRunning(pid)) {
  removeLock(lockPath);
  console.log('配置工具进程已结束，已清理运行记录。');
  process.exit(0);
}

try {
  const token = editorUrl.searchParams.get('token') || '';
  const shutdownUrl = new URL('/api/shutdown', editorUrl);
  const response = await fetch(shutdownUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: editorUrl.origin,
      'X-Config-Editor-Token': token,
    },
    body: '{}',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`关闭接口响应异常（${response.status}）`);
  }

  await waitForProcessExit(pid, 4_000);
  if (isProcessRunning(pid) && lockStillBelongsTo(lockPath, pid)) {
    process.kill(pid, 'SIGTERM');
    await waitForProcessExit(pid, 2_000);
  }
  if (isProcessRunning(pid)) {
    throw new Error('配置工具进程未能退出');
  }

  removeLock(lockPath);
  console.log('IGP 运行配置工具已停止。');
} catch (error) {
  if (!isProcessRunning(pid)) {
    removeLock(lockPath);
    console.log('配置工具进程已结束，已清理运行记录。');
    process.exit(0);
  }
  console.error(`停止配置工具失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

function resolveRootDir(args) {
  const rootIndex = args.indexOf('--root');
  const value = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
  return path.resolve(value || process.cwd());
}

function readLockMetadata(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function parseEditorUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (
      parsed.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockStillBelongsTo(filePath, pid) {
  const current = readLockMetadata(filePath);
  return Number(current?.pid) === pid;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessRunning(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function removeLock(filePath) {
  fs.rmSync(filePath, { force: true });
}
