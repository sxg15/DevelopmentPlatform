import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumePublicEntryAuthCode,
  getFeishuAuthCode,
} from '../src/integrations/feishuH5.js';

test('public entry authorization codes are consumed and removed from the URL', () => {
  const originalWindow = globalThis.window;
  let replacedUrl = '';
  globalThis.window = {
    location: {
      href: 'http://172.16.20.205:3000/projects/50?tool=bugs&igpFeishuAuthCode=code-1#detail',
    },
    history: {
      replaceState(_state, _title, url) {
        replacedUrl = url;
      },
    },
  };
  try {
    assert.equal(consumePublicEntryAuthCode(), 'code-1');
    assert.equal(replacedUrl, '/projects/50?tool=bugs#detail');
  } finally {
    globalThis.window = originalWindow;
  }
});

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
