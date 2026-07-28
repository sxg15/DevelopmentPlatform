import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectDir = path.resolve(import.meta.dirname, '..');
const outputDir = path.join(projectDir, 'Publish');
const unpackedDir = path.join(outputDir, 'win-unpacked');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
const archivePath = path.join(
  outputDir,
  `${packageJson.build.productName}-${packageJson.version}-win-x64.zip`,
);

assertInsideProject(outputDir);
fs.rmSync(outputDir, { recursive: true, force: true });

run(process.execPath, [path.join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], projectDir);
run(
  process.execPath,
  [path.join(projectDir, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--dir'],
  projectDir,
);

if (!fs.existsSync(path.join(unpackedDir, `${packageJson.build.productName}.exe`))) {
  throw new Error('Electron unpacked application was not created');
}

const sevenZipPath = findSevenZip();
if (sevenZipPath) {
  run(sevenZipPath, ['a', '-tzip', '-mx=7', archivePath, '.'], unpackedDir);
} else {
  run('powershell.exe', [
    '-NoProfile',
    '-Command',
    'Compress-Archive -LiteralPath * -DestinationPath $args[0] -CompressionLevel Optimal',
    archivePath,
  ], unpackedDir);
}

if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size === 0) {
  throw new Error('Portable ZIP was not created');
}
console.log(`Portable package: ${archivePath}`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with exit code ${result.status}`);
  }
}

function findSevenZip() {
  const candidates = [
    process.env.SEVEN_ZIP_PATH,
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function assertInsideProject(targetPath) {
  const projectPrefix = `${projectDir.trimEnd?.() || projectDir}${path.sep}`;
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(projectPrefix)) {
    throw new Error(`Refusing to clean output outside deployment-tool: ${resolved}`);
  }
}
