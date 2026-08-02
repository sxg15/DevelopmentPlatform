const DEFAULT_FEISHU_SDK_URL =
  'https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SDK_BYTES = 1024 * 1024;

export const FEISHU_SDK_PUBLIC_PATH = '/__igp/feishu-h5-js-sdk-1.5.44.js';

export class FeishuSdkProvider {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.sdkUrl = options.sdkUrl || DEFAULT_FEISHU_SDK_URL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.cachedSdk = null;
    this.pendingLoad = null;
  }

  async getSdk() {
    if (this.cachedSdk) {
      return this.cachedSdk;
    }
    if (!this.pendingLoad) {
      this.pendingLoad = this.loadSdk()
        .then((sdk) => {
          this.cachedSdk = sdk;
          return sdk;
        })
        .finally(() => {
          this.pendingLoad = null;
        });
    }
    return this.pendingLoad;
  }

  async loadSdk() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.sdkUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/javascript,text/javascript;q=0.9,*/*;q=0.1',
        },
      });
      if (!response.ok) {
        throw new Error(`飞书 H5 SDK 下载失败：HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers?.get?.('content-length') || 0);
      if (declaredLength > MAX_SDK_BYTES) {
        throw new Error('飞书 H5 SDK 超过允许大小');
      }
      const sdk = Buffer.from(await response.arrayBuffer());
      if (sdk.length === 0 || sdk.length > MAX_SDK_BYTES) {
        throw new Error('飞书 H5 SDK 内容大小无效');
      }
      const source = sdk.toString('utf8');
      if (!source.includes('requestAuthCode') || !source.includes('window.tt')) {
        throw new Error('飞书 H5 SDK 内容校验失败');
      }
      return sdk;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('飞书 H5 SDK 下载超时');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
