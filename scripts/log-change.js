import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const packagePath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');
const uploadLogPath = path.join(rootDir, 'UploadLog.md');
const changeText = process.argv.slice(2).join(' ').trim();

if (!changeText) {
  console.error('请提供变动说明，例如：npm run log-change -- "初始化飞书网页应用"');
  process.exit(1);
}

const packageJson = readJsonFile(packagePath);
const nextVersion = bumpPatchVersion(packageJson.version);
const today = formatLocalDate(new Date());

packageJson.version = nextVersion;
writeJsonFile(packagePath, packageJson);
syncPackageLockVersion(packageLockPath, nextVersion);
writeUploadLog(uploadLogPath, nextVersion, today, changeText);

console.log(`版本已升级到 ${nextVersion}`);
console.log(`UploadLog.md 已记录：${changeText}`);

function bumpPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!match) {
    throw new Error(`package.json version 不是 x.y.z 格式：${version}`);
  }

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function writeUploadLog(filePath, version, date, text) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '# UploadLog\n';
  const body = current.trimEnd();
  const entry = `\n\n## ${version} - ${date}\n- ${text}\n`;

  if (body.startsWith('# UploadLog')) {
    fs.writeFileSync(filePath, body.replace('# UploadLog', `# UploadLog${entry}`) + '\n');
    return;
  }

  fs.writeFileSync(filePath, `# UploadLog${entry}\n${body}\n`);
}

function syncPackageLockVersion(filePath, version) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const packageLock = readJsonFile(filePath);
  packageLock.version = version;

  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = version;
  }

  writeJsonFile(filePath, packageLock);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
