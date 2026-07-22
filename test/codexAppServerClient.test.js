import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCodexProcessEnvironment,
  createCodexAppServerClient,
  extractFinalAgentMessage,
} from '../server/integrations/codexAppServerClient.js';

test('Codex app-server client uses JSONL and a key-free config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-codex-client-'));
  const fakeServerPath = path.join(root, 'fake-codex.mjs');
  const codexHome = path.join(root, 'codex-home');
  const tempDir = path.join(root, 'tmp');
  const apiKey = 'test-secret-key-value';
  fs.writeFileSync(fakeServerPath, `
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
    input.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'fake' } });
      } else if (message.method === 'thread/start') {
        send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      } else if (message.method === 'thread/resume') {
        send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      } else if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        setTimeout(() => {
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: message.params.threadId,
              turnId: 'turn-1',
              itemId: 'item-1',
              delta: '{"message":"Ready",',
            },
          });
          send({
            method: 'turn/completed',
            params: {
              threadId: message.params.threadId,
              turn: {
                id: 'turn-1',
                status: 'completed',
                items: [{
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: '{"message":"Ready","plan":null}',
                }],
              },
            },
          });
        }, 5);
      } else if (message.method === 'turn/interrupt') {
        send({ id: message.id, result: {} });
      }
    });
  `, 'utf8');

  const deltas = [];
  const client = createCodexAppServerClient({
    rootDir: root,
    codexHome,
    tempDir,
    apiKey,
    apiBaseUrl: 'http://127.0.0.1:9999/v1',
    model: 'codex-test',
    reasoningEffort: 'high',
    requestTimeoutMs: 5_000,
    executablePath: process.execPath,
    codexScriptPath: fakeServerPath,
  });
  try {
    const result = await client.runTurn({
      cwd: root,
      skillPath: path.join(root, 'SKILL.md'),
      prompt: 'Plan this',
      outputSchema: { type: 'object' },
      onDelta: (delta) => deltas.push(delta),
    });
    assert.equal(result.threadId, 'thread-1');
    assert.equal(result.turnId, 'turn-1');
    assert.equal(result.content, '{"message":"Ready","plan":null}');
    assert.match(deltas.join(''), /Ready/);

    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(config, new RegExp(apiKey));
    assert.match(config, /sandbox_mode = "read-only"/);
    assert.match(config, /IGP_CODEX_API_KEY/);
    assert.match(config, /exclude = .*IGP_CODEX_API_KEY/);
  } finally {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex child environment excludes unrelated application secrets', () => {
  const environment = buildCodexProcessEnvironment({
    source: {
      PATH: 'C:\\bin',
      FEISHU_APP_SECRET: 'feishu-secret',
      OTHER_TOKEN: 'other-secret',
    },
    codexHome: 'C:\\codex-home',
    tempDir: 'C:\\temp',
    apiKey: 'codex-key',
  });
  assert.equal(environment.PATH, 'C:\\bin');
  assert.equal(environment.FEISHU_APP_SECRET, undefined);
  assert.equal(environment.OTHER_TOKEN, undefined);
  assert.equal(environment.IGP_CODEX_API_KEY, 'codex-key');
});

test('final Codex agent message prefers the final-answer phase', () => {
  assert.equal(extractFinalAgentMessage({
    items: [
      { type: 'agentMessage', phase: 'commentary', text: 'working' },
      { type: 'agentMessage', phase: 'final_answer', text: 'done' },
    ],
  }), 'done');
});
