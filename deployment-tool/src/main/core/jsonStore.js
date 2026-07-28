import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = path.resolve(filePath);
    this.defaults = structuredClone(defaults);
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return mergeObjects(this.defaults, parsed);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return structuredClone(this.defaults);
      }
      throw new Error(`状态文件读取失败：${path.basename(this.filePath)}`, { cause: error });
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const rollbackPath = `${this.filePath}.${process.pid}.${Date.now()}.rollback`;
    let movedCurrent = false;
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, rollbackPath);
        movedCurrent = true;
      }
      fs.renameSync(tempPath, this.filePath);
      fs.rmSync(rollbackPath, { force: true });
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if (movedCurrent && !fs.existsSync(this.filePath) && fs.existsSync(rollbackPath)) {
        fs.renameSync(rollbackPath, this.filePath);
      }
      throw error;
    } finally {
      fs.rmSync(tempPath, { force: true });
      if (fs.existsSync(rollbackPath) && fs.existsSync(this.filePath)) {
        fs.rmSync(rollbackPath, { force: true });
      }
    }
  }

  update(mutator) {
    const current = this.read();
    const next = mutator(structuredClone(current)) ?? current;
    this.write(next);
    return next;
  }
}

export function mergeObjects(defaults, value) {
  if (!isPlainObject(defaults) || !isPlainObject(value)) {
    return value === undefined ? structuredClone(defaults) : structuredClone(value);
  }
  const result = structuredClone(defaults);
  for (const [key, item] of Object.entries(value)) {
    result[key] = isPlainObject(result[key]) && isPlainObject(item)
      ? mergeObjects(result[key], item)
      : structuredClone(item);
  }
  return result;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
