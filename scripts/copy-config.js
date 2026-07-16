import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const sourcePath = path.join(rootDir, 'config/config.json');
const outputPath = path.join(rootDir, 'Publish/config.json');

if (!fs.existsSync(sourcePath)) {
  console.error('缺少 config/config.json');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

fs.copyFileSync(sourcePath, outputPath);

console.log('配置文件已覆盖到 Publish/config.json');
