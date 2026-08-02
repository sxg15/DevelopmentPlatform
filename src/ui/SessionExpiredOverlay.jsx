import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import {
  getAuthenticationExpirationSnapshot,
  subscribeAuthenticationExpiration,
} from '../api/authenticationState.js';
import { reloadForFeishuReauthorization } from './authNavigation.js';
import { acquirePageInteractionLock } from './pageInteractionLock.js';

export function SessionExpiredOverlay() {
  const authentication = useSyncExternalStore(
    subscribeAuthenticationExpiration,
    getAuthenticationExpirationSnapshot,
    getAuthenticationExpirationSnapshot,
  );
  const refreshButtonRef = useRef(null);

  useEffect(() => {
    if (!authentication.expired) {
      return undefined;
    }
    return acquirePageInteractionLock(() => refreshButtonRef.current);
  }, [authentication.expired]);

  if (!authentication.expired) {
    return null;
  }

  return createPortal(
    <div
      className="session-expired-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
      aria-describedby="session-expired-description"
    >
      <section className="session-expired-dialog">
        <ShieldAlert aria-hidden="true" />
        <div>
          <h2 id="session-expired-title">登录信息已失效</h2>
          <p id="session-expired-description">
            当前操作已停止，请刷新页面并重新完成飞书登录。
          </p>
        </div>
        <button
          ref={refreshButtonRef}
          type="button"
          onClick={reloadForFeishuReauthorization}
        >
          <RefreshCw aria-hidden="true" />
          <span>刷新并重新登录</span>
        </button>
      </section>
    </div>,
    document.body,
  );
}
