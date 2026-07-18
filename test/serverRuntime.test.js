import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  getSession,
  getSessionId,
  parseCookies,
} from '../server/runtime/sessionStore.js';
import { createWorkItemRealtimeHub } from '../server/runtime/workItemRealtime.js';
import { getCachedValue } from '../server/runtime/asyncCache.js';

test('async cache shares pending loads and evicts failed values', async () => {
  const cache = new Map();
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    return { value: 'cached' };
  };

  const [left, right] = await Promise.all([
    getCachedValue(cache, 'key', 1000, loader),
    getCachedValue(cache, 'key', 1000, loader),
  ]);

  assert.equal(loadCount, 1);
  assert.strictEqual(left, right);

  await assert.rejects(
    getCachedValue(cache, 'failed', 1000, async () => {
      throw new Error('load failed');
    }),
    /load failed/,
  );
  assert.equal(cache.has('failed'), false);
});

test('session store creates, reads and clears request sessions', () => {
  const user = { name: '测试用户', openId: 'ou_test' };
  const sessionId = createSession(user, 'user-token');
  const request = {
    headers: {
      cookie: `theme=dark; igp_session=${encodeURIComponent(sessionId)}`,
    },
  };

  assert.equal(getSessionId(request), sessionId);
  assert.deepEqual(getSession(request), {
    user,
    userAccessToken: 'user-token',
    createdAt: getSession(request).createdAt,
  });
  assert.equal(parseCookies('a=1; b=hello%20world').b, 'hello world');
  assert.match(buildSessionCookie(sessionId), /HttpOnly/);
  assert.match(buildClearSessionCookie(), /Max-Age=0/);

  deleteSession(sessionId);
  assert.equal(getSession(request), null);
});

test('realtime hub only publishes events allowed for each project and tool', () => {
  const published = [];
  const writes = [];
  const response = {
    write(value) {
      writes.push(value);
    },
  };
  const hub = createWorkItemRealtimeHub({
    onPublish(payload) {
      published.push(payload);
    },
  });
  const unsubscribe = hub.subscribe(response, new Map([
    ['project-1', new Set(['requirements'])],
  ]));

  hub.publishWorkItemUpdated({
    projectId: 'project-1',
    toolId: 'bugs',
    recordId: 'bug-1',
  });
  hub.publishWorkItemUpdated({
    projectId: 'project-1',
    toolId: 'requirements',
    recordId: 'requirement-1',
  });
  unsubscribe();

  assert.equal(published.length, 2);
  assert.match(writes[0], /^event: ready/);
  assert.equal(writes.filter((value) => value.startsWith('event: work-item-updated')).length, 1);
  assert.match(writes.at(-1), /requirement-1/);
});
