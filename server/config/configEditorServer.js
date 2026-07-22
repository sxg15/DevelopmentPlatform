import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConfigEditorStore } from './configEditorStore.js';

const LOOPBACK_HOST = '127.0.0.1';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = resolveRootDir(process.argv.slice(2));
const assetsDir = resolveAssetsDir(rootDir);
const folderPickerPath = path.join(__dirname, 'selectFolder.ps1');
const runtimeDir = path.join(rootDir, 'runtime');
const lockPath = path.join(runtimeDir, 'config-editor.lock');
const token = String(process.env.IGP_CONFIG_EDITOR_TOKEN || crypto.randomBytes(24).toString('hex'));
const requestedPort = normalizePort(process.env.IGP_CONFIG_EDITOR_PORT);
const noBrowser = process.env.IGP_CONFIG_EDITOR_NO_BROWSER === '1';
const store = createConfigEditorStore(rootDir);

fs.mkdirSync(runtimeDir, { recursive: true });
const lockHandle = acquireEditorLock(lockPath);
if (!lockHandle) {
  process.exit(0);
}

let lastActivityAt = Date.now();
let editorUrl = '';
let shuttingDown = false;

const server = http.createServer(async (request, response) => {
  lastActivityAt = Date.now();
  applySecurityHeaders(response);

  try {
    if (!isLoopbackRequest(request)) {
      sendJson(response, 403, { message: '配置工具只允许本机访问' });
      return;
    }

    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || LOOPBACK_HOST}`);
    if (requestUrl.pathname.startsWith('/api/')) {
      if (!isAuthorizedApiRequest(request)) {
        sendJson(response, 403, { message: '配置工具会话无效' });
        return;
      }
      await handleApiRequest(request, response, requestUrl);
      return;
    }

    if (
      ['/', '/index.html'].includes(requestUrl.pathname)
      && requestUrl.searchParams.get('token') !== token
    ) {
      sendText(response, 403, '配置工具会话无效');
      return;
    }
    serveStatic(response, requestUrl.pathname);
  } catch (error) {
    sendJson(response, 500, {
      message: error instanceof Error ? error.message : '配置工具发生异常',
    });
  }
});

server.listen(requestedPort, LOOPBACK_HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  editorUrl = `http://${LOOPBACK_HOST}:${port}/?token=${encodeURIComponent(token)}`;
  writeLockMetadata(lockHandle, { pid: process.pid, url: editorUrl });
  console.log('IGP 运行配置工具已启动。');
  console.log(`访问地址：${editorUrl}`);
  console.log('保存配置后，请关闭本工具并重新运行 StartWebBackend.bat。');
  if (!noBrowser) {
    openBrowser(editorUrl);
  }
});

server.on('error', (error) => {
  console.error(`配置工具启动失败：${error instanceof Error ? error.message : error}`);
  cleanupLock();
  process.exitCode = 1;
});

const idleTimer = setInterval(() => {
  if (Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS) {
    console.log('配置工具长时间未使用，正在自动退出。');
    shutdown();
  }
}, 30_000);
idleTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, shutdown);
}
process.on('exit', cleanupLock);

async function handleApiRequest(request, response, requestUrl) {
  if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
    const result = store.read();
    sendResult(response, result);
    return;
  }

  if (request.method === 'PUT' && requestUrl.pathname === '/api/config') {
    const payload = await readJsonBody(request);
    const result = store.save(payload);
    sendResult(response, result);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/recovery') {
    const payload = await readJsonBody(request);
    const result = store.recover(String(payload?.source || ''));
    sendResult(response, result);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/select-directory') {
    const payload = await readJsonBody(request);
    const result = selectDirectory(String(payload?.initialPath || ''));
    sendResult(response, result);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/shutdown') {
    sendJson(response, 200, { ok: true });
    setTimeout(shutdown, 50).unref();
    return;
  }

  sendJson(response, 404, { message: 'Not found' });
}

function selectDirectory(initialPath) {
  if (!fs.existsSync(folderPickerPath)) {
    return {
      ok: false,
      statusCode: 500,
      code: 'FOLDER_PICKER_MISSING',
      message: '目录选择组件缺失',
    };
  }

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      folderPickerPath,
      '-InitialPath',
      initialPath,
    ],
    {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: false,
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    },
  );

  if (result.error) {
    return {
      ok: false,
      statusCode: 500,
      code: 'FOLDER_PICKER_FAILED',
      message: '无法打开目录选择器',
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      statusCode: 500,
      code: 'FOLDER_PICKER_FAILED',
      message: String(result.stderr || '').trim() || '目录选择器执行失败',
    };
  }

  return {
    ok: true,
    path: String(result.stdout || '').trim(),
    cancelled: !String(result.stdout || '').trim(),
  };
}

function isAuthorizedApiRequest(request) {
  if (String(request.headers['x-config-editor-token'] || '') !== token) {
    return false;
  }
  if (!['PUT', 'POST', 'DELETE', 'PATCH'].includes(request.method || '')) {
    return true;
  }
  return String(request.headers.origin || '') === new URL(editorUrl).origin;
}

function isLoopbackRequest(request) {
  const remoteAddress = String(request.socket.remoteAddress || '');
  const host = String(request.headers.host || '').split(':')[0].toLowerCase();
  return (
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)
    && ['127.0.0.1', 'localhost'].includes(host)
  );
}

function serveStatic(response, requestPath) {
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(assetsDir, relativePath);
  const assetsPrefix = `${path.resolve(assetsDir)}${path.sep}`;
  if (resolvedPath !== path.resolve(assetsDir, 'index.html') && !resolvedPath.startsWith(assetsPrefix)) {
    sendText(response, 404, 'Not found');
    return;
  }
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    sendText(response, 404, 'Not found');
    return;
  }

  response.statusCode = 200;
  response.setHeader('Content-Type', getContentType(resolvedPath));
  response.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(resolvedPath).pipe(response);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求内容不是有效的 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendResult(response, result) {
  sendJson(response, result.ok ? 200 : result.statusCode || 500, result);
}

function sendJson(response, statusCode, payload) {
  if (response.headersSent) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, content) {
  if (response.headersSent) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(content);
}

function applySecurityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function acquireEditorLock(filePath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return fs.openSync(filePath, 'wx+');
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const existing = readExistingLock(filePath);
      if (existing?.pid && isProcessRunning(existing.pid)) {
        console.log('IGP 运行配置工具已经在运行。');
        if (existing.url && !noBrowser) {
          openBrowser(existing.url);
        }
        return null;
      }
      fs.rmSync(filePath, { force: true });
    }
  }
  throw new Error('无法获取配置工具运行锁');
}

function readExistingLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLockMetadata(handle, metadata) {
  fs.ftruncateSync(handle, 0);
  fs.writeSync(handle, JSON.stringify(metadata), 0, 'utf8');
  fs.fsyncSync(handle);
}

function cleanupLock() {
  try {
    fs.closeSync(lockHandle);
  } catch {
    // The process may already have closed the lock handle.
  }
  try {
    const existing = readExistingLock(lockPath);
    if (!existing || existing.pid === process.pid) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Exit cleanup must not mask the original process result.
  }
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(idleTimer);
  server.close(() => {
    cleanupLock();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2_000).unref();
}

function openBrowser(url) {
  try {
    const child = spawn('explorer.exe', [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    console.log('无法自动打开浏览器，请手动访问上方地址。');
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function resolveRootDir(args) {
  const rootIndex = args.indexOf('--root');
  const value = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
  return path.resolve(value || process.cwd());
}

function resolveAssetsDir(resolvedRoot) {
  const candidates = [
    path.join(resolvedRoot, 'config-editor'),
    path.join(resolvedRoot, 'Publish', 'config-editor'),
  ];
  const candidate = candidates.find((item) => fs.existsSync(path.join(item, 'index.html')));
  if (!candidate) {
    throw new Error('找不到配置编辑器页面资源');
  }
  return candidate;
}

function normalizePort(value) {
  const port = Number(value || 0);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
}

function getContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}
