import { spawn } from 'node:child_process';
import process from 'node:process';
import { resolveNpmInvocation } from '../src/main/core/npmRunner.js';

const viteCommand = resolveNpmInvocation(['exec', 'vite', '--', '--host', '127.0.0.1']);
const vite = spawn(viteCommand.command, viteCommand.args, {
  cwd: process.cwd(),
  stdio: 'inherit',
  windowsHide: true,
});

let electron;
let stopping = false;

setTimeout(() => {
  const electronCommand = resolveNpmInvocation([
    'exec',
    'electron',
    '--',
    '.',
    '--dev-server=http://127.0.0.1:5173',
  ]);
  electron = spawn(electronCommand.command, electronCommand.args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
  });
  electron.on('exit', stop);
}, 1500);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, stop);
}

function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  electron?.kill();
  vite.kill();
  setTimeout(() => process.exit(0), 200).unref();
}
