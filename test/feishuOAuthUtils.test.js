import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFeishuOAuthTokenPayload } from '../server/integrations/feishuOAuthUtils.js';

test('OAuth token payload includes redirect URI only for redirect-based codes', () => {
  const base = {
    appId: 'cli_test',
    appSecret: 'secret',
    code: 'code',
  };
  assert.deepEqual(buildFeishuOAuthTokenPayload(base), {
    grant_type: 'authorization_code',
    client_id: 'cli_test',
    client_secret: 'secret',
    code: 'code',
  });
  assert.deepEqual(buildFeishuOAuthTokenPayload({
    ...base,
    redirectUri: 'http://47.100.74.169/',
  }), {
    grant_type: 'authorization_code',
    client_id: 'cli_test',
    client_secret: 'secret',
    code: 'code',
    redirect_uri: 'http://47.100.74.169/',
  });
});
