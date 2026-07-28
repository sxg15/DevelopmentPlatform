import { spawn } from 'node:child_process';

const activeChildren = new Set();

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: options.windowsHide !== false,
      shell: false,
    });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    const maxCaptureBytes = options.maxCaptureBytes || 2 * 1024 * 1024;
    let settled = false;
    let timeout = null;

    const settle = (callback) => {
      if (settled) {
        return false;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      activeChildren.delete(child);
      callback();
      return true;
    };

    child.stdout?.on('data', (chunk) => {
      capture(stdout, chunk, maxCaptureBytes);
      options.onOutput?.({ stream: 'stdout', text: chunk.toString('utf8') });
    });
    child.stderr?.on('data', (chunk) => {
      capture(stderr, chunk, maxCaptureBytes);
      options.onOutput?.({ stream: 'stderr', text: chunk.toString('utf8') });
    });
    child.on('error', (error) => {
      settle(() => reject(error));
    });
    child.on('exit', (code, signal) => {
      settle(() => {
        const result = {
          code: Number.isInteger(code) ? code : -1,
          signal: signal || '',
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        };
        if (result.code !== 0 && options.rejectOnError !== false) {
          reject(new Error(
            String(result.stderr || result.stdout || `${command} 执行失败`).trim(),
            { cause: result },
          ));
          return;
        }
        resolve(result);
      });
    });
    if (Number(options.timeoutMs) > 0) {
      timeout = setTimeout(() => {
        settle(() => {
          void terminateProcessTree(child).finally(() => {
            const error = new Error(
              `${pathName(command)} 执行超时（${Number(options.timeoutMs)}ms）`,
            );
            error.code = 'PROCESS_TIMEOUT';
            reject(error);
          });
        });
      }, Number(options.timeoutMs));
      timeout.unref?.();
    }
  });
}

export async function terminateActiveProcesses() {
  const children = [...activeChildren].filter(
    (child) => child.pid && child.exitCode === null && child.signalCode === null,
  );
  await Promise.all(children.map((child) => terminateProcessTree(child)));
}

function terminateProcessTree(child) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill.exe', [
        '/PID',
        String(child.pid),
        '/T',
        '/F',
      ], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        child.kill('SIGKILL');
        resolve();
      });
      killer.once('exit', resolve);
    });
  }
  child.kill('SIGTERM');
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 2000).unref();
  });
}

function capture(chunks, chunk, maxBytes) {
  chunks.push(Buffer.from(chunk));
  while (chunks.reduce((total, item) => total + item.length, 0) > maxBytes && chunks.length > 1) {
    chunks.shift();
  }
}

function pathName(command) {
  return String(command || '').split(/[\\/]/).at(-1) || '进程';
}
