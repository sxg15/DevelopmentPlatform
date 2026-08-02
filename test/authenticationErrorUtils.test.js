import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTHENTICATION_ERROR_CODES,
  getAuthenticationErrorCode,
  normalizeAuthenticationErrorResponse,
} from '../shared/authenticationErrorUtils.js';
import { buildFeishuReauthorizationUrl } from '../src/ui/authNavigation.js';

test('authentication errors use stable codes for session and Feishu authorization expiry', () => {
  assert.equal(
    getAuthenticationErrorCode({ status: 401, message: '请先登录飞书' }),
    AUTHENTICATION_ERROR_CODES.SESSION_EXPIRED,
  );
  assert.equal(
    getAuthenticationErrorCode({ status: 502, message: '飞书登录授权已失效，请重新打开网页应用' }),
    AUTHENTICATION_ERROR_CODES.FEISHU_AUTH_EXPIRED,
  );
  assert.equal(getAuthenticationErrorCode({ status: 403, message: '没有项目权限' }), '');
});

test('backend authentication responses normalize to 401 without changing ordinary errors', () => {
  assert.deepEqual(
    normalizeAuthenticationErrorResponse(401, { message: '未登录' }),
    {
      status: 401,
      payload: {
        message: '未登录',
        code: AUTHENTICATION_ERROR_CODES.SESSION_EXPIRED,
      },
    },
  );
  assert.deepEqual(
    normalizeAuthenticationErrorResponse(502, { message: '飞书登录授权已失效，请重新登录' }),
    {
      status: 401,
      payload: {
        message: '飞书登录授权已失效，请重新登录',
        code: AUTHENTICATION_ERROR_CODES.FEISHU_AUTH_EXPIRED,
      },
    },
  );
  assert.deepEqual(
    normalizeAuthenticationErrorResponse(409, { message: '数据已变化' }),
    {
      status: 409,
      payload: { message: '数据已变化' },
    },
  );
});

test('reauthorization URL preserves the current target and forces a fresh Feishu login', () => {
  const url = new URL(buildFeishuReauthorizationUrl(
    'http://127.0.0.1:3000/workspace?projectId=50&toolId=bugs#record-1',
  ));

  assert.equal(url.searchParams.get('projectId'), '50');
  assert.equal(url.searchParams.get('toolId'), 'bugs');
  assert.equal(url.searchParams.get('forceAuth'), '1');
  assert.equal(url.hash, '#record-1');
});
