import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const uploadLogPath = path.join(rootDir, 'UploadLog.md');

if (!fs.existsSync(uploadLogPath)) {
  console.error('缺少 UploadLog.md');
  process.exit(1);
}

const uploadLog = fs.readFileSync(uploadLogPath, 'utf8');
const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const versionHeading = new RegExp(`^##\\s+${escapedVersion}\\s+-\\s+\\d{4}-\\d{2}-\\d{2}`, 'm');

if (!versionHeading.test(uploadLog)) {
  console.error(`UploadLog.md 没有记录当前版本 ${packageJson.version}`);
  process.exit(1);
}

console.log(`UploadLog.md 已记录当前版本 ${packageJson.version}`);
