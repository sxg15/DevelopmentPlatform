import { randomBytes } from 'node:crypto';

const FEISHU_AUTHORIZE_URL =
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const DEFAULT_STATE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STATES = 1000;

export class FeishuOAuthStateStore {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.randomBytesImpl = options.randomBytesImpl || randomBytes;
    this.ttlMs = options.ttlMs || DEFAULT_STATE_TTL_MS;
    this.maxStates = options.maxStates || DEFAULT_MAX_STATES;
    this.states = new Map();
  }

  create(targetUrl) {
    this.prune();
    while (this.states.size >= this.maxStates) {
      const oldestState = this.states.keys().next().value;
      this.states.delete(oldestState);
    }
    let state;
    do {
      state = this.randomBytesImpl(24).toString('base64url');
    } while (this.states.has(state));
    this.states.set(state, {
      targetUrl: String(targetUrl),
      expiresAt: this.now() + this.ttlMs,
    });
    return state;
  }

  consume(state) {
    this.prune();
    const normalizedState = String(state || '');
    const entry = this.states.get(normalizedState);
    if (!entry) {
      return '';
    }
    this.states.delete(normalizedState);
    return entry.targetUrl;
  }

  prune() {
    const now = this.now();
    for (const [state, entry] of this.states) {
      if (entry.expiresAt <= now) {
        this.states.delete(state);
      }
    }
  }
}

export function buildFeishuAuthorizationUrl({
  appId,
  redirectUri,
  scope,
  state,
}) {
  const url = new URL(FEISHU_AUTHORIZE_URL);
  url.searchParams.set('client_id', String(appId));
  url.searchParams.set('redirect_uri', String(redirectUri));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', String(scope));
  url.searchParams.set('state', String(state));
  return url.toString();
}
