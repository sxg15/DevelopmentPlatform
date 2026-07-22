import fs from 'node:fs';
import path from 'node:path';

export const AI_DATA_ROOT = 'D:\\DevelopmentPlatformDB';
export const AI_DATABASE_PATH = path.join(AI_DATA_ROOT, 'ai-planning.sqlite');
export const AI_CODEX_HOME = path.join(AI_DATA_ROOT, 'codex-home');
export const AI_TEMP_DIR = path.join(AI_DATA_ROOT, 'tmp');
export const AI_LOG_DIR = path.join(AI_DATA_ROOT, 'logs');

export function ensureAiDataDirectories(rootPath = AI_DATA_ROOT) {
  const paths = {
    root: rootPath,
    database: path.join(rootPath, 'ai-planning.sqlite'),
    codexHome: path.join(rootPath, 'codex-home'),
    temp: path.join(rootPath, 'tmp'),
    logs: path.join(rootPath, 'logs'),
  };

  for (const directory of [paths.root, paths.codexHome, paths.temp, paths.logs]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const probePath = path.join(paths.root, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probePath, 'ok', { encoding: 'ascii', flag: 'wx' });
  } catch {
    throw new Error(`无法写入 AI 数据目录：${rootPath}`);
  } finally {
    try {
      fs.rmSync(probePath, { force: true });
    } catch {
      // The startup error above is authoritative; cleanup failure must not hide it.
    }
  }

  return paths;
}
