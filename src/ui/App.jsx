import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { compareSemanticVersions } from '../../shared/updateManifest.js';
import {
  createLocalCacheUserKey,
  initializeLocalCache,
  readLocalPreference,
  writeLocalPreference,
} from './localCache.js';
import {
  createDebugSession,
  exchangeCodeForUser,
  fetchAppConfig,
  fetchCurrentUser,
} from '../api/auth.js';
import { fetchUpdates } from '../api/projects.js';
import { ensurePersonalSettingsRecord } from '../api/personalSettings.js';
import {
  consumePublicEntryAuthorization,
  getFeishuAuthCode,
  waitForFeishuRuntime,
} from '../integrations/feishuH5.js';
import { PlatformWorkspace } from './workspace/PlatformWorkspace.jsx';
import { PersonalSettingsDialog } from './settings/PersonalSettingsDialog.jsx';

const INITIAL_AUTH_STATE = {
  status: 'loading',
  message: '正在连接飞书',
  user: null,
};

export function App() {
  const [authState, setAuthState] = useState(INITIAL_AUTH_STATE);
  const [updateDialog, setUpdateDialog] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    let isActive = true;

    async function runLogin() {
      try {
        if (shouldUseDebugUser()) {
          const user = await createDebugSession();
          if (isActive) {
            setAuthState({ status: 'ready', message: '', user });
          }
          return;
        }

        if (shouldHoldLoadingForDebug()) {
          return;
        }

        const publicEntryAuthorization = consumePublicEntryAuthorization();
        if (publicEntryAuthorization.code) {
          const user = await exchangeCodeForUser(
            publicEntryAuthorization.code,
            {
              publicEntryOAuth: publicEntryAuthorization.publicEntryOAuth,
            },
          );
          if (isActive) {
            clearForceAuthQueryParam();
            setAuthState({ status: 'ready', message: '', user });
          }
          return;
        }

        const forceAuth = shouldForceFeishuAuthorization();
        if (!forceAuth) {
          const existingUser = await fetchCurrentUser();
          if (existingUser) {
            if (isActive) {
              setAuthState({ status: 'ready', message: '', user: existingUser });
            }
            return;
          }
        }

        const feishuRuntime = await waitForFeishuRuntime();
        if (!feishuRuntime.available) {
          if (isActive) {
            setAuthState({ status: 'error', message: feishuRuntime.message, user: null });
          }
          return;
        }

        const config = await fetchAppConfig();
        if (!config.configured || !config.appId) {
          if (isActive) {
            setAuthState({ status: 'error', message: '缺少飞书应用配置', user: null });
          }
          return;
        }

        const code = await getFeishuAuthCode(feishuRuntime, config.appId);
        const user = await exchangeCodeForUser(code);

        if (isActive) {
          clearForceAuthQueryParam();
          setAuthState({ status: 'ready', message: '', user });
        }
      } catch (error) {
        if (isActive) {
          setAuthState({ status: 'error', message: formatErrorMessage(error), user: null });
        }
      }
    }

    runLogin();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (authState.status !== 'ready' || !authState.user) {
      return;
    }

    ensurePersonalSettingsRecord().catch(() => {
      // Personal settings initialization must not block normal workspace use.
    });
  }, [authState.status, authState.user]);

  useEffect(() => {
    if (authState.status !== 'ready' || !authState.user) {
      return undefined;
    }

    let isActive = true;
    const userKey = createLocalCacheUserKey(authState.user);

    async function prepareLocalData() {
      await initializeLocalCache(authState.user);
      if (!isActive) {
        return;
      }

      try {
        const lastOpenedVersion = readLocalPreference(userKey, 'last-opened-update-version', '');
        const payload = await fetchUpdates(lastOpenedVersion);
        if (!isActive || !payload?.enabled || !payload.latestVersion) {
          return;
        }

        if (!lastOpenedVersion) {
          writeLocalPreference(userKey, 'last-opened-update-version', payload.latestVersion);
          return;
        }

        if (
          payload.updateAvailable
          && compareSemanticVersions(payload.latestVersion, lastOpenedVersion) > 0
        ) {
          setUpdateDialog(payload);
        }
      } catch {
        // Update checks must not delay login or project data loading.
      }
    }

    prepareLocalData();
    return () => {
      isActive = false;
    };
  }, [authState.status, authState.user]);

  const cacheUserKey = authState.user ? createLocalCacheUserKey(authState.user) : '';

  function closeUpdateDialog() {
    if (updateDialog?.latestVersion && cacheUserKey) {
      writeLocalPreference(cacheUserKey, 'last-opened-update-version', updateDialog.latestVersion);
    }
    setUpdateDialog(null);
  }

  return (
    <main className="app-shell" aria-label="开发平台">
      <TopToolbar state={authState} onOpenSettings={() => setSettingsOpen(true)} />
      {authState.status === 'ready' && authState.user ? (
        <PlatformWorkspace user={authState.user} cacheUserKey={cacheUserKey} />
      ) : (
        <AuthStatusPanel state={authState} />
      )}
      {updateDialog ? <UpdateLogDialog update={updateDialog} onClose={closeUpdateDialog} /> : null}
      {settingsOpen && authState.user ? (
        <PersonalSettingsDialog onClose={() => setSettingsOpen(false)} />
      ) : null}
    </main>
  );
}

function TopToolbar({ state, onOpenSettings }) {
  return (
    <header className="top-toolbar" aria-label="顶部工具栏">
      <div className="toolbar-title">开发平台</div>
      <div className="toolbar-user" aria-label="当前飞书用户">
        {state.status === 'ready' && state.user ? (
          <>
            <button
              type="button"
              className="toolbar-settings-button"
              onClick={onOpenSettings}
              aria-label="打开个人设置"
              title="个人设置"
            >
              <Settings size={18} aria-hidden="true" />
            </button>
            <Avatar user={state.user} />
            <span className="user-name" title={state.user.name}>{state.user.name}</span>
          </>
        ) : (
          <span className="toolbar-user-placeholder">未登录</span>
        )}
      </div>
    </header>
  );
}

function UpdateLogDialog({ update, onClose }) {
  const releases = Array.isArray(update?.releases) ? update.releases : [];

  return (
    <div className="workitem-submit-backdrop" role="presentation">
      <section className="update-log-dialog" role="dialog" aria-modal="true" aria-label="更新日志">
        <div className="workitem-submit-header">
          <div>
            <h3>发现新版本 {update.latestVersion}</h3>
            <span>当前版本 {update.currentVersion}</span>
          </div>
          <button type="button" className="workitem-submit-close" onClick={onClose}>关闭</button>
        </div>
        <div className="update-log-content">
          {releases.length > 0 ? releases.map((release) => (
            <section key={release.version} className="update-log-release">
              <div>
                <strong>{release.version}</strong>
                <span>{formatUpdatePublishedAt(release.publishedAt)}</span>
              </div>
              <ul>
                {release.changes.map((change, index) => <li key={`${release.version}-${index}`}>{change}</li>)}
              </ul>
            </section>
          )) : (
            <p className="update-log-empty">服务器已发布新版本，暂未提供可显示的变更记录。</p>
          )}
        </div>
        <div className="update-log-actions">
          <button type="button" className="workitem-submit-primary" onClick={onClose}>我知道了</button>
        </div>
      </section>
    </div>
  );
}

function AuthStatusPanel({ state }) {
  return (
    <section className={`auth-panel auth-panel-${state.status}`} aria-live="polite">
      {state.status === 'loading' ? (
        <span className="loading-mark" aria-hidden="true">
          <span className="loading-ring" />
          <span className="loading-core" />
        </span>
      ) : null}
      <span className="status-message">{state.message}</span>
    </section>
  );
}

function Avatar({ user }) {
  if (user.avatarUrl) {
    return <img className="avatar" src={user.avatarUrl} alt={`${user.name}的头像`} />;
  }

  const initial = user.name?.trim()?.[0]?.toUpperCase() || '飞';
  return <span className="avatar avatar-fallback" aria-hidden="true">{initial}</span>;
}

function formatUpdatePublishedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return String(value || '');
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-') + ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) {
    return '请求失败';
  }

  if (message === 'Failed to fetch' || message.includes('NetworkError')) {
    return '无法连接本地后端，请确认网页后端服务正在运行';
  }

  if (message.includes('wiki space permission denied') || message.includes('tenant needs read permission')) {
    return '飞书应用没有该知识库的读取权限，请在飞书开放平台和知识库权限中授权';
  }

  return message;
}

function shouldHoldLoadingForDebug() {
  return new URLSearchParams(window.location.search).get('debugLoading') === '1';
}

function shouldUseDebugUser() {
  return new URLSearchParams(window.location.search).get('debugUser') === '1';
}

function shouldForceFeishuAuthorization() {
  return new URLSearchParams(window.location.search).get('forceAuth') === '1';
}

function clearForceAuthQueryParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('forceAuth')) {
    return;
  }

  url.searchParams.delete('forceAuth');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}
