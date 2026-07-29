import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexApiBridge } from '../server/integrations/codexApiBridge.js';
import {
  buildCodexProcessEnvironment,
  createCodexAppServerClient,
  extractFinalAgentMessage,
} from '../server/integrations/codexAppServerClient.js';
import { isRecoverableCodexTransportError } from '../server/integrations/codexErrorUtils.js';

test('Codex app-server client uses JSONL and a key-free config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-codex-client-'));
  const fakeServerPath = path.join(root, 'fake-codex.mjs');
  const codexHome = path.join(root, 'codex-home');
  const tempDir = path.join(root, 'tmp');
  const apiKey = 'test-secret-key-value';
  fs.writeFileSync(fakeServerPath, `
    import readline from 'node:readline';
    if (process.env.IGP_CODEX_API_KEY === ${JSON.stringify(apiKey)}) {
      process.exit(17);
    }
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
    input.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        if (message.params.capabilities.experimentalApi !== true) {
          send({ id: message.id, error: { message: 'experimentalApi required' } });
        } else {
          send({ id: message.id, result: { userAgent: 'fake' } });
        }
      } else if (message.method === 'thread/start') {
        send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      } else if (message.method === 'thread/resume') {
        send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      } else if (message.method === 'turn/start') {
        const textItems = message.params.input.filter((item) => item.type === 'text');
        if (
          textItems.length !== 2
          || textItems[0].text !== 'Project-specific instructions'
          || textItems[1].text !== 'Plan this'
          || message.params.effort !== 'medium'
        ) {
          send({ id: message.id, error: { message: 'prompt order is incorrect' } });
          return;
        }
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        setTimeout(() => {
          send({
            method: 'item/started',
            params: {
              threadId: message.params.threadId,
              turnId: 'turn-1',
              item: {
                id: 'command-1',
                type: 'commandExecution',
                command: 'Get-Content C:\\\\private\\\\source.js',
                cwd: 'C:\\\\private',
              },
            },
          });
          send({
            method: 'item/completed',
            params: {
              threadId: message.params.threadId,
              turnId: 'turn-1',
              item: {
                id: 'command-1',
                type: 'commandExecution',
                command: 'Get-Content C:\\\\private\\\\source.js',
                cwd: 'C:\\\\private',
                status: 'completed',
              },
            },
          });
          send({
            method: 'item/started',
            params: {
              threadId: message.params.threadId,
              turnId: 'turn-1',
              item: {
                id: 'reasoning-1',
                type: 'reasoning',
                summary: ['private internal reasoning'],
              },
            },
          });
          send({
            method: 'item/completed',
            params: {
              threadId: message.params.threadId,
              turnId: 'turn-1',
              item: {
                id: 'reasoning-1',
                type: 'reasoning',
                summary: ['private internal reasoning'],
              },
            },
          });
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
            method: 'item/completed',
            params: {
              threadId: message.params.threadId,
              turnId: 'turn-1',
              completedAtMs: Date.now(),
              item: {
                id: 'item-1',
                type: 'agentMessage',
                phase: 'final_answer',
                text: '{"message":"Ready","plan":null}',
                memoryCitation: null,
              },
            },
          });
          send({
            method: 'turn/completed',
            params: {
              threadId: message.params.threadId,
              turn: {
                id: 'turn-1',
                status: 'completed',
                items: [],
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
  const progressEvents = [];
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
      preludePrompt: 'Project-specific instructions',
      prompt: 'Plan this',
      outputSchema: { type: 'object' },
      reasoningEffort: 'medium',
      onDelta: (delta) => deltas.push(delta),
      onProgress: (progress) => progressEvents.push(progress),
    });
    assert.equal(result.threadId, 'thread-1');
    assert.equal(result.turnId, 'turn-1');
    assert.equal(result.content, '{"message":"Ready","plan":null}');
    assert.match(deltas.join(''), /Ready/);
    assert.deepEqual(
      [...new Set(progressEvents.map((progress) => progress.stage))],
      ['preparing', 'analyzing', 'composing'],
    );
    const serializedProgress = JSON.stringify(progressEvents);
    assert.doesNotMatch(serializedProgress, /Get-Content|private|source\.js/i);
    assert.match(serializedProgress, /读取项目结构|分析代码关系|整理最终实施计划/);

    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(config, new RegExp(apiKey));
    assert.doesNotMatch(config, /127\.0\.0\.1:9999/);
    assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    assert.match(config, /sandbox_mode = "read-only"/);
    assert.match(config, /\[features\][\s\S]*respect_system_proxy = false/);
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
      HTTP_PROXY: 'http://127.0.0.1:7892',
      HTTPS_PROXY: 'http://127.0.0.1:7892',
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
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.NO_PROXY, '127.0.0.1,localhost');
  assert.equal(environment.no_proxy, '127.0.0.1,localhost');
  assert.equal(environment.IGP_CODEX_API_KEY, 'codex-key');
});

test('Codex API bridge authenticates loopback requests and streams through the upstream response', async () => {
  const upstreamState = {
    requests: 0,
    authorization: '',
    path: '',
    body: '',
  };
  const upstreamServer = http.createServer((request, response) => {
    upstreamState.requests += 1;
    upstreamState.authorization = String(request.headers.authorization || '');
    upstreamState.path = String(request.url || '');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      upstreamState.body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      response.flushHeaders();
      response.write('data: first\n\n');
      if (upstreamState.body === '{"disconnect":true}') {
        setTimeout(() => response.destroy(), 20);
        return;
      }
      setTimeout(() => response.end('data: second\n\n'), 20);
    });
  });
  const upstreamPort = await listenOnLoopback(upstreamServer);
  const bridge = createCodexApiBridge({
    apiBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'upstream-secret',
    bridgeToken: 'bridge-token',
    requestTimeoutMs: 5_000,
  });

  try {
    await bridge.start();
    const unauthorized = await requestText(`${bridge.baseUrl}/responses`, {
      method: 'POST',
      body: '{"test":false}',
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(upstreamState.requests, 0);

    const invalidHost = await requestText(`${bridge.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer bridge-token',
        Host: 'example.test',
      },
      body: '{"test":false}',
    });
    assert.equal(invalidHost.statusCode, 403);
    assert.equal(upstreamState.requests, 0);

    const response = await requestText(`${bridge.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer bridge-token',
        'Content-Type': 'application/json',
      },
      body: '{"test":true}',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'data: first\n\ndata: second\n\n');
    assert.ok(response.chunkCount >= 2);
    assert.equal(upstreamState.requests, 1);
    assert.equal(upstreamState.authorization, 'Bearer upstream-secret');
    assert.equal(upstreamState.path, '/v1/responses');
    assert.equal(upstreamState.body, '{"test":true}');

    const unknownPath = await requestText(`${bridge.baseUrl}/models`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer bridge-token',
      },
    });
    assert.equal(unknownPath.statusCode, 404);
    assert.equal(upstreamState.requests, 1);

    await assert.rejects(requestText(`${bridge.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer bridge-token',
        'Content-Type': 'application/json',
      },
      body: '{"disconnect":true}',
    }));

    const recovered = await requestText(`${bridge.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer bridge-token',
        'Content-Type': 'application/json',
      },
      body: '{"recovered":true}',
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(upstreamState.requests, 3);
  } finally {
    await bridge.stop();
    await closeServer(upstreamServer);
  }
});

test('Codex app-server user questions interrupt the turn and resolve as awaiting user', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-codex-question-'));
  const fakeServerPath = path.join(root, 'fake-codex.mjs');
  fs.writeFileSync(fakeServerPath, `
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
    let userInputAnswered = false;
    input.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send({ id: message.id, result: {} });
      } else if (message.method === 'thread/start') {
        send({ id: message.id, result: { thread: { id: 'thread-question' } } });
      } else if (message.method === 'turn/start') {
        if (
          Object.prototype.hasOwnProperty.call(message.params, 'outputSchema')
          || message.params.effort !== 'medium'
        ) {
          send({ id: message.id, error: { message: 'question turn options are incorrect' } });
          return;
        }
        send({ id: message.id, result: { turn: { id: 'turn-question' } } });
        setTimeout(() => send({
          id: 91,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thread-question',
            turnId: 'turn-question',
            itemId: 'question-item',
            questions: [{
              id: 'q1',
              header: '范围',
              question: '选择实现范围',
              isOther: true,
              isSecret: false,
              options: [
                { label: '完整实现', description: '覆盖全部流程' },
                { label: '最小实现', description: '仅覆盖主流程' }
              ]
            }],
            autoResolutionMs: null
          }
        }), 5);
      } else if (message.id === 91 && message.result) {
        userInputAnswered = JSON.stringify(message.result) === JSON.stringify({ answers: {} });
      } else if (message.method === 'turn/interrupt') {
        if (!userInputAnswered) {
          send({ id: message.id, error: { message: 'requestUserInput response missing' } });
          return;
        }
        setTimeout(() => send({ id: message.id, result: {} }), 10);
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-question',
            turn: { id: 'turn-question', status: 'interrupted', items: [] }
          }
        });
      }
    });
  `, 'utf8');

  const questions = [];
  const client = createCodexAppServerClient({
    rootDir: root,
    codexHome: path.join(root, 'codex-home'),
    tempDir: path.join(root, 'tmp'),
    apiKey: 'test-key',
    apiBaseUrl: 'http://127.0.0.1:9999/v1',
    model: 'codex-test',
    requestTimeoutMs: 5_000,
    executablePath: process.execPath,
    codexScriptPath: fakeServerPath,
  });
  try {
    const result = await client.runTurn({
      cwd: root,
      skillPath: path.join(root, 'SKILL.md'),
      prompt: 'Plan this',
      reasoningEffort: 'medium',
      async onRequestUserInput(value) {
        questions.push(...value);
      },
    });
    assert.equal(result.awaitingUser, true);
    assert.equal(questions[0].id, 'q1');
    assert.equal(questions[0].options[0].label, '完整实现');
  } finally {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('final Codex agent message prefers the final-answer phase', () => {
  assert.equal(extractFinalAgentMessage({
    items: [
      { type: 'agentMessage', phase: 'commentary', text: 'working' },
      { type: 'agentMessage', phase: 'final_answer', text: 'done' },
    ],
  }), 'done');
});

test('Codex transport errors only classify known temporary connection failures as recoverable', () => {
  assert.equal(isRecoverableCodexTransportError(new Error(
    'stream disconnected before completion: error sending request for url (https://example.test/responses)',
  )), true);
  assert.equal(isRecoverableCodexTransportError(new Error(
    'connection reset while reading response body',
  )), true);
  assert.equal(isRecoverableCodexTransportError(Object.assign(
    new Error('Codex 生成计划超时'),
    { code: 'codex_timeout' },
  )), false);
  assert.equal(isRecoverableCodexTransportError(new Error(
    'invalid_request_error: model is not available',
  )), false);
});

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(Number(server.address()?.port || 0));
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestText(url, {
  method = 'GET',
  headers = {},
  body = '',
} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method,
      headers,
    }, (response) => {
      const chunks = [];
      let chunkCount = 0;
      response.on('data', (chunk) => {
        chunks.push(chunk);
        chunkCount += 1;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          chunkCount,
        });
      });
      response.on('aborted', () => reject(new Error('Response aborted')));
      response.on('error', reject);
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}
