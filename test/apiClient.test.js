import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  clearAuthenticationExpiration,
  getAuthenticationExpirationSnapshot,
} from '../src/api/authenticationState.js';
import {
  getGlobalOperationSnapshot,
  subscribeGlobalOperation,
} from '../src/api/requestActivity.js';
import { requestJson } from '../src/api/client.js';

afterEach(() => {
  clearAuthenticationExpiration();
});

test('write requests publish one blocking operation until the response is parsed', async () => {
  const originalFetch = globalThis.fetch;
  const snapshots = [];
  let resolveFetch;
  let resolvePayload;
  globalThis.fetch = () => new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const unsubscribe = subscribeGlobalOperation(() => {
    snapshots.push(getGlobalOperationSnapshot());
  });

  try {
    const pending = requestJson('/api/example', {
      method: 'POST',
      body: JSON.stringify({ value: true }),
      timeoutMs: 1000,
    });
    assert.equal(getGlobalOperationSnapshot().active, true);
    resolveFetch({
      ok: true,
      json: () => new Promise((resolve) => {
        resolvePayload = resolve;
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(getGlobalOperationSnapshot().active, true);
    resolvePayload({ ok: true });
    assert.deepEqual(await pending, { ok: true });
    assert.equal(getGlobalOperationSnapshot().active, false);
    assert.equal(snapshots.some((snapshot) => snapshot.active), true);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test('read requests have a timeout without opening the blocking operation overlay', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({ items: [] }),
  });

  try {
    const payload = await requestJson('/api/example', { timeoutMs: 1000 });
    assert.deepEqual(payload, { items: [] });
    assert.equal(getGlobalOperationSnapshot().active, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP errors retain their status for bounded authentication checks', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: false,
    status: 401,
    json: async () => ({ message: '未登录' }),
  });

  try {
    await assert.rejects(
      requestJson('/api/me', {
        timeoutMs: 1000,
        detectAuthenticationExpiration: false,
      }),
      (error) => error?.status === 401 && error.message === '未登录',
    );
    assert.equal(getAuthenticationExpirationSnapshot().expired, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticated business requests publish one sticky authentication expiration state', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = () => {
    fetchCount += 1;
    return Promise.resolve({
      ok: false,
      status: 401,
      json: async () => ({
        code: 'AUTH_EXPIRED',
        message: '登录信息已失效',
      }),
    });
  };

  try {
    await assert.rejects(
      requestJson('/api/projects', { timeoutMs: 1000 }),
      (error) => error?.status === 401,
    );
    assert.deepEqual(
      {
        expired: getAuthenticationExpirationSnapshot().expired,
        code: getAuthenticationExpirationSnapshot().code,
      },
      {
        expired: true,
        code: 'AUTH_EXPIRED',
      },
    );
    await assert.rejects(
      requestJson('/api/projects/related-counts', { timeoutMs: 1000 }),
      /登录信息已失效/,
    );
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy Feishu authorization expiry messages also activate the global login prompt', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: false,
    status: 502,
    json: async () => ({ message: '飞书登录授权已失效，请重新打开网页应用' }),
  });

  try {
    await assert.rejects(
      requestJson('/api/example', { timeoutMs: 1000 }),
      /登录授权已失效/,
    );
    assert.equal(getAuthenticationExpirationSnapshot().code, 'FEISHU_AUTH_EXPIRED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timed out write requests release the operation overlay and return a localized error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});

  try {
    await assert.rejects(
      requestJson('/api/slow-operation', {
        method: 'PUT',
        timeoutMs: 20,
      }),
      (error) => error?.code === 'REQUEST_TIMEOUT' && error.message === '操作超时，请稍后重试',
    );
    assert.equal(getGlobalOperationSnapshot().active, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('silent background writes can explicitly opt out of the operation overlay', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({ ok: true }),
  });

  try {
    await requestJson('/api/background', {
      method: 'POST',
      globalOperation: false,
      timeoutMs: 1000,
    });
    assert.equal(getGlobalOperationSnapshot().active, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
