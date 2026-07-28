import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const baseUrl = process.env.IGP_DEPLOY_PREVIEW_URL || 'http://127.0.0.1:4177/';
const outputDir = path.join(os.tmpdir(), `igp-deploy-ui-${Date.now()}`);
fs.mkdirSync(outputDir, { recursive: true });
const require = createRequire(import.meta.url);
const electronPath = require('electron');

for (const preview of [
  { name: 'developer-desktop', mode: 'developer', width: 1360, height: 860 },
  { name: 'developer-narrow', mode: 'developer', width: 760, height: 900 },
  { name: 'target-desktop', mode: 'target', width: 1360, height: 860 },
  { name: 'target-narrow', mode: 'target', width: 760, height: 900 },
]) {
  const capturePath = path.join(outputDir, `${preview.name}.png`);
  const result = spawnSync(electronPath, [
    '.',
    `--dev-server=${baseUrl}`,
    `--preview=${preview.mode}`,
    `--capture=${capturePath}`,
    `--window-width=${preview.width}`,
    `--window-height=${preview.height}`,
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0 || !fs.existsSync(capturePath)) {
    throw result.error || new Error(`UI capture failed: ${preview.name}`);
  }
}

console.log(outputDir);
