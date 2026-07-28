import fs from 'node:fs';
import path from 'node:path';

export function resolveNpmInvocation(args, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return {
      command: 'npm',
      args: [...args],
    };
  }

  const env = options.env || process.env;
  const explicitCli = env.npm_execpath;
  const explicitNode = env.npm_node_execpath;
  if (isFile(explicitCli) && isFile(explicitNode)) {
    return {
      command: explicitNode,
      args: [explicitCli, ...args],
    };
  }

  const pathValue = env.Path || env.PATH || '';
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) {
      continue;
    }
    const nodeExecutable = path.join(directory, 'node.exe');
    const npmCli = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (isFile(nodeExecutable) && isFile(npmCli)) {
      return {
        command: nodeExecutable,
        args: [npmCli, ...args],
      };
    }
  }

  throw new Error('未找到可用的 Node.js/npm，请先安装 Node.js 并将其加入 PATH');
}

function isFile(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
