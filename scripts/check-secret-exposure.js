import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const configPaths = [
  path.join(rootDir, 'config/config.json'),
  path.join(rootDir, 'Publish/config.json'),
];
const secrets = readConfiguredSecrets(configPaths);
const scanRoots = ['src', 'public', 'Publish/client']
  .map((item) => path.join(rootDir, item))
  .filter((item) => fs.existsSync(item));

if (secrets.length === 0) {
  console.log('未配置运行时密钥，跳过真实密钥泄露检查');
  process.exit(0);
}

const hits = [];

for (const scanRoot of scanRoots) {
  scanFiles(scanRoot, (filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const secret of secrets) {
      if (content.includes(secret)) {
        hits.push(path.relative(rootDir, filePath));
        break;
      }
    }
  });
}

if (hits.length > 0) {
  console.error('发现运行时密钥出现在浏览器可见文件中：');
  for (const hit of hits) {
    console.error(`- ${hit}`);
  }
  process.exit(1);
}

console.log('未发现运行时密钥暴露到浏览器可见文件');

function scanFiles(dirPath, onFile) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      scanFiles(fullPath, onFile);
      continue;
    }

    if (entry.isFile()) {
      onFile(fullPath);
    }
  }
}

function readConfiguredSecrets(filePaths) {
  const secrets = new Set();

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const configuredSecrets = [
      config?.feishu?.appSecret,
      config?.aiPlanning?.codex?.apiKey,
    ];
    for (const value of configuredSecrets) {
      const secret = String(value || '');
      if (secret) {
        secrets.add(secret);
      }
    }
  }

  return [...secrets];
}
