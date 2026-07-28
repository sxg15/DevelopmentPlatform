import assert from 'node:assert/strict';
import test from 'node:test';
import { updateBitableField } from '../server/integrations/bitableClient.js';

test('bitable field updates use the field endpoint and preserve the provided body', async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            field: {
              field_id: 'fld-status',
            },
          },
        };
      },
    };
  };

  try {
    const body = {
      field_name: '处理状态',
      type: 3,
      property: {
        options: [{ name: '待验收', color: 3 }],
      },
    };
    const result = await updateBitableField('tenant-token', 'app token', 'table/id', 'field id', body);

    assert.equal(
      request.url,
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app%20token/tables/table%2Fid/fields/field%20id',
    );
    assert.equal(request.options.method, 'PUT');
    assert.equal(request.options.headers.Authorization, 'Bearer tenant-token');
    assert.deepEqual(JSON.parse(request.options.body), body);
    assert.equal(result.field_id, 'fld-status');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
