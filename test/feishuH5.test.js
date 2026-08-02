import assert from 'node:assert/strict';
import test from 'node:test';
import { getFeishuAuthCode } from '../src/integrations/feishuH5.js';

test('Feishu login prefers requestAuthCode when both login APIs are available', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    setTimeout,
    clearTimeout,
  };
  let requestAccessCalls = 0;
  try {
    const code = await getFeishuAuthCode({
      requestAuthCode(options) {
        options.success({ code: 'auth-code' });
      },
      requestAccess() {
        requestAccessCalls += 1;
      },
    }, 'app-id');
    assert.equal(code, 'auth-code');
    assert.equal(requestAccessCalls, 0);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('Feishu login falls back to requestAccess when requestAuthCode is unavailable', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    setTimeout,
    clearTimeout,
  };
  try {
    const code = await getFeishuAuthCode({
      requestAccess(options) {
        assert.equal(options.appID, 'app-id');
        assert.deepEqual(options.scopeList, []);
        options.success({ code: 'access-code' });
      },
    }, 'app-id');
    assert.equal(code, 'access-code');
  } finally {
    globalThis.window = originalWindow;
  }
});
