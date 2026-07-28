import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Network,
  RefreshCw,
  Save,
  X,
} from 'lucide-react';
import {
  fetchPersonalSettings,
  regenerateDevelopmentPlatformToken,
  updatePersonalSettings,
} from '../../api/personalSettings.js';
import {
  MCP_CLIENT_DEFINITIONS,
  buildMcpClientConfigs,
} from './mcpConfigUtils.js';

const DEFAULT_SETTINGS = {
  receiveTodoNotifications: false,
  todoNotificationTime: '11:00',
  developmentPlatformToken: '',
};

export function PersonalSettingsDialog({ onClose }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [activeSection, setActiveSection] = useState('notifications');
  const [mcpSettings, setMcpSettings] = useState({ serverUrls: [] });
  const [selectedMcpUrl, setSelectedMcpUrl] = useState('');
  const [selectedMcpClientId, setSelectedMcpClientId] = useState(
    MCP_CLIENT_DEFINITIONS[0].id,
  );
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenAction, setTokenAction] = useState('idle');
  const [tokenMessage, setTokenMessage] = useState({ type: '', text: '' });
  const [mcpMessage, setMcpMessage] = useState({ type: '', text: '' });
  const dialogRef = useRef(null);

  useEffect(() => {
    let isActive = true;

    async function loadSettings() {
      setStatus('loading');
      setMessage('');
      setTokenMessage({ type: '', text: '' });
      setMcpMessage({ type: '', text: '' });
      try {
        const payload = await fetchPersonalSettings();
        if (isActive) {
          const normalized = normalizeSettings(payload.settings);
          const normalizedMcp = normalizeMcpSettings(payload.mcp);
          setSettings(normalized);
          setMcpSettings(normalizedMcp);
          setSelectedMcpUrl(normalizedMcp.serverUrls[0] || '');
          setActiveSection(normalized.developmentPlatformToken ? 'notifications' : 'mcp');
          setHasLoaded(true);
          setStatus('ready');
        }
      } catch (error) {
        if (isActive) {
          setHasLoaded(false);
          setStatus('error');
          setMessage(formatErrorMessage(error, '读取个人设置失败'));
        }
      }
    }

    loadSettings();
    dialogRef.current?.focus();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape' && status !== 'saving' && tokenAction !== 'generating') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, status, tokenAction]);

  async function handleSave() {
    setStatus('saving');
    setMessage('');
    try {
      const payload = await updatePersonalSettings(settings);
      setSettings(normalizeSettings(payload));
      setHasLoaded(true);
      setStatus('ready');
      setMessage('设置已保存');
    } catch (error) {
      setStatus('error');
      setMessage(formatErrorMessage(error, '保存个人设置失败'));
    }
  }

  async function handleRetry() {
    setHasLoaded(false);
    setStatus('loading');
    setMessage('');
    setTokenMessage({ type: '', text: '' });
    setMcpMessage({ type: '', text: '' });
    try {
      const payload = await fetchPersonalSettings();
      const normalized = normalizeSettings(payload.settings);
      const normalizedMcp = normalizeMcpSettings(payload.mcp);
      setSettings(normalized);
      setMcpSettings(normalizedMcp);
      setSelectedMcpUrl(normalizedMcp.serverUrls[0] || '');
      setActiveSection(normalized.developmentPlatformToken ? 'notifications' : 'mcp');
      setHasLoaded(true);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setMessage(formatErrorMessage(error, '读取个人设置失败'));
    }
  }

  async function handleRegenerateToken() {
    const wasMissing = !settings.developmentPlatformToken;
    setTokenAction('generating');
    setTokenMessage({ type: '', text: '' });
    setMcpMessage({ type: '', text: '' });
    try {
      const payload = normalizeSettings(await regenerateDevelopmentPlatformToken());
      setSettings((current) => ({
        ...current,
        developmentPlatformToken: payload.developmentPlatformToken,
      }));
      setTokenVisible(true);
      setTokenMessage({
        type: 'success',
        text: wasMissing ? '令牌已生成' : '令牌已重新生成',
      });
      setMcpMessage({
        type: 'success',
        text: wasMissing ? '令牌已创建，配置已更新' : '令牌已重新生成，配置已更新',
      });
    } catch (error) {
      const errorMessage = {
        type: 'error',
        text: formatErrorMessage(error, '生成开发平台令牌失败'),
      };
      setTokenMessage(errorMessage);
      setMcpMessage(errorMessage);
    } finally {
      setTokenAction('idle');
    }
  }

  async function handleCopyToken() {
    if (!settings.developmentPlatformToken) {
      return;
    }
    try {
      await copyText(settings.developmentPlatformToken);
      setTokenMessage({ type: 'success', text: '令牌已复制' });
    } catch (error) {
      setTokenMessage({
        type: 'error',
        text: formatErrorMessage(error, '复制令牌失败'),
      });
    }
  }

  async function handleCopyMcpConfig(value) {
    try {
      await copyText(value);
      setMcpMessage({ type: 'success', text: 'MCP 配置已复制' });
    } catch (error) {
      setMcpMessage({
        type: 'error',
        text: formatErrorMessage(error, '复制 MCP 配置失败'),
      });
    }
  }

  function requestClose(event) {
    if (status === 'saving' || tokenAction === 'generating') {
      return;
    }
    if (!event || event.target === event.currentTarget) {
      onClose();
    }
  }

  const isLoading = status === 'loading';
  const isSaving = status === 'saving';
  const isGeneratingToken = tokenAction === 'generating';
  const isBusy = isSaving || isGeneratingToken;
  const isError = status === 'error';
  const isLoadError = isError && !hasLoaded;
  const isNotificationsSection = activeSection === 'notifications';
  const isTokenSection = activeSection === 'token';
  const isMcpSection = activeSection === 'mcp';
  const sectionHeading = getSectionHeading(activeSection);
  const SectionIcon = sectionHeading.Icon;

  return (
    <div className="personal-settings-backdrop" role="presentation" onMouseDown={requestClose}>
      <section
        ref={dialogRef}
        className="personal-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="personal-settings-title"
        tabIndex="-1"
      >
        <header className="personal-settings-header">
          <h2 id="personal-settings-title">设置</h2>
          <button
            type="button"
            className="personal-settings-icon-button"
            onClick={() => requestClose()}
            disabled={isBusy}
            aria-label="关闭设置"
            title="关闭"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="personal-settings-layout">
          <nav className="personal-settings-nav" aria-label="设置分组">
            <button
              type="button"
              className={`personal-settings-nav-item ${isNotificationsSection ? 'is-active' : ''}`}
              aria-current={isNotificationsSection ? 'page' : undefined}
              disabled={isBusy}
              onClick={() => {
                setActiveSection('notifications');
                setTokenMessage({ type: '', text: '' });
                setMcpMessage({ type: '', text: '' });
              }}
            >
              <Bell size={17} aria-hidden="true" />
              <span>通知</span>
            </button>
            <button
              type="button"
              className={`personal-settings-nav-item ${isTokenSection ? 'is-active' : ''}`}
              aria-current={isTokenSection ? 'page' : undefined}
              disabled={isBusy}
              onClick={() => {
                setActiveSection('token');
                setMessage('');
                setMcpMessage({ type: '', text: '' });
              }}
            >
              <KeyRound size={17} aria-hidden="true" />
              <span>令牌</span>
            </button>
            <button
              type="button"
              className={`personal-settings-nav-item ${isMcpSection ? 'is-active' : ''}`}
              aria-current={isMcpSection ? 'page' : undefined}
              disabled={isBusy}
              onClick={() => {
                setActiveSection('mcp');
                setMessage('');
                setTokenMessage({ type: '', text: '' });
              }}
            >
              <Network size={17} aria-hidden="true" />
              <span>MCP</span>
            </button>
          </nav>

          <section
            className="personal-settings-content"
            aria-labelledby={sectionHeading.id}
          >
            <div className="personal-settings-section-heading">
              <SectionIcon size={19} aria-hidden="true" />
              <h3 id={sectionHeading.id}>{sectionHeading.label}</h3>
            </div>

            {isLoading ? (
              <div className="personal-settings-state" aria-live="polite">
                <LoaderCircle className="is-spinning" size={20} aria-hidden="true" />
                <span>正在读取设置</span>
              </div>
            ) : isLoadError ? (
              <div className="personal-settings-state is-error" role="alert">
                <span>{message}</span>
                <button type="button" onClick={handleRetry}>重试</button>
              </div>
            ) : isNotificationsSection ? (
              <NotificationSettings
                settings={settings}
                disabled={isSaving}
                onChange={(patch) => {
                  setSettings((current) => ({ ...current, ...patch }));
                  setMessage('');
                  if (isError) {
                    setStatus('ready');
                  }
                }}
              />
            ) : isTokenSection ? (
              <DevelopmentPlatformTokenSettings
                token={settings.developmentPlatformToken}
                visible={tokenVisible}
                generating={isGeneratingToken}
                message={tokenMessage}
                onToggleVisible={() => setTokenVisible((current) => !current)}
                onCopy={handleCopyToken}
                onRegenerate={handleRegenerateToken}
              />
            ) : (
              <McpSettings
                token={settings.developmentPlatformToken}
                settings={mcpSettings}
                selectedUrl={selectedMcpUrl}
                selectedClientId={selectedMcpClientId}
                generating={isGeneratingToken}
                message={mcpMessage}
                onGenerateToken={handleRegenerateToken}
                onSelectUrl={(value) => {
                  setSelectedMcpUrl(value);
                  setMcpMessage({ type: '', text: '' });
                }}
                onSelectClient={(value) => {
                  setSelectedMcpClientId(value);
                  setMcpMessage({ type: '', text: '' });
                }}
                onCopy={handleCopyMcpConfig}
              />
            )}

            {isNotificationsSection && hasLoaded && message ? (
              <div
                className={`personal-settings-message ${isError ? 'is-error' : 'is-success'}`}
                role={isError ? 'alert' : 'status'}
              >
                <span>{message}</span>
                {isError ? (
                  <button type="button" onClick={handleSave} disabled={isSaving}>重新保存</button>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>

        <footer className="personal-settings-actions">
          <button
            type="button"
            className="personal-settings-secondary"
            onClick={() => requestClose()}
            disabled={isBusy}
          >
            {isNotificationsSection ? '取消' : '关闭'}
          </button>
          {isNotificationsSection ? (
            <button
              type="button"
              className="personal-settings-primary"
              onClick={handleSave}
              disabled={isLoading || isSaving || !hasLoaded}
            >
              {isSaving ? (
                <LoaderCircle className="is-spinning" size={16} aria-hidden="true" />
              ) : (
                <Save size={16} aria-hidden="true" />
              )}
              <span>{isSaving ? '保存中' : '保存设置'}</span>
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function McpSettings({
  token,
  settings,
  selectedUrl,
  selectedClientId,
  generating,
  message,
  onGenerateToken,
  onSelectUrl,
  onSelectClient,
  onCopy,
}) {
  if (!token) {
    return (
      <div className="personal-settings-token-empty personal-settings-mcp-empty">
        <Network size={24} aria-hidden="true" />
        <strong>尚未创建开发平台令牌</strong>
        <button
          type="button"
          className="personal-settings-primary"
          onClick={onGenerateToken}
          disabled={generating}
        >
          {generating ? (
            <LoaderCircle className="is-spinning" size={16} aria-hidden="true" />
          ) : (
            <KeyRound size={16} aria-hidden="true" />
          )}
          <span>{generating ? '创建中' : '创建令牌'}</span>
        </button>
        <TokenMessage message={message} />
      </div>
    );
  }

  const serverUrls = Array.isArray(settings?.serverUrls) ? settings.serverUrls : [];
  const configs = buildMcpClientConfigs({
    serverUrl: selectedUrl || serverUrls[0] || '',
    token,
  });
  const selectedConfig = configs.find((config) => config.id === selectedClientId)
    || configs[0];

  return (
    <div className="personal-settings-mcp-panel">
      <div className="personal-settings-mcp-endpoint">
        <label htmlFor="personal-settings-mcp-url">
          <strong>MCP 地址</strong>
        </label>
        <select
          id="personal-settings-mcp-url"
          value={selectedUrl || serverUrls[0] || ''}
          onChange={(event) => onSelectUrl(event.target.value)}
        >
          {serverUrls.map((serverUrl) => (
            <option key={serverUrl} value={serverUrl}>{serverUrl}</option>
          ))}
        </select>
      </div>

      <div className="personal-settings-mcp-clients" role="tablist" aria-label="MCP 客户端">
        {configs.map((config) => (
          <button
            key={config.id}
            type="button"
            role="tab"
            aria-selected={config.id === selectedConfig.id}
            className={config.id === selectedConfig.id ? 'is-active' : ''}
            onClick={() => onSelectClient(config.id)}
          >
            {config.label}
          </button>
        ))}
      </div>

      <div className="personal-settings-mcp-config">
        <div className="personal-settings-mcp-config-heading">
          <span>{selectedConfig.fileName}</span>
          <button
            type="button"
            className="personal-settings-icon-button personal-settings-token-icon-button"
            onClick={() => onCopy(selectedConfig.value)}
            aria-label={`复制 ${selectedConfig.label} MCP 配置`}
            title="复制配置"
          >
            <Copy size={17} aria-hidden="true" />
          </button>
        </div>
        <pre tabIndex="0"><code>{selectedConfig.value}</code></pre>
      </div>

      <TokenMessage message={message} />
    </div>
  );
}

function NotificationSettings({ settings, disabled, onChange }) {
  return (
    <div className="personal-settings-fields">
      <div className="personal-settings-field-row">
        <label htmlFor="receive-todo-notifications">
          <strong>接收待办事项通知</strong>
        </label>
        <label className="personal-settings-switch">
          <input
            id="receive-todo-notifications"
            type="checkbox"
            checked={settings.receiveTodoNotifications}
            disabled={disabled}
            onChange={(event) => onChange({
              receiveTodoNotifications: event.target.checked,
            })}
          />
          <span aria-hidden="true" />
        </label>
      </div>

      {settings.receiveTodoNotifications ? (
        <div className="personal-settings-field-row personal-settings-time-row">
          <label htmlFor="todo-notification-time">
            <strong>待办事项通知时间</strong>
          </label>
          <input
            id="todo-notification-time"
            className="personal-settings-time-input"
            type="time"
            step="60"
            value={settings.todoNotificationTime}
            disabled={disabled}
            onChange={(event) => onChange({
              todoNotificationTime: event.target.value || '11:00',
            })}
          />
        </div>
      ) : null}
    </div>
  );
}

function DevelopmentPlatformTokenSettings({
  token,
  visible,
  generating,
  message,
  onToggleVisible,
  onCopy,
  onRegenerate,
}) {
  if (!token) {
    return (
      <div className="personal-settings-token-empty">
        <KeyRound size={24} aria-hidden="true" />
        <strong>尚未生成开发平台令牌</strong>
        <button
          type="button"
          className="personal-settings-primary"
          onClick={onRegenerate}
          disabled={generating}
        >
          {generating ? (
            <LoaderCircle className="is-spinning" size={16} aria-hidden="true" />
          ) : (
            <KeyRound size={16} aria-hidden="true" />
          )}
          <span>{generating ? '生成中' : '生成令牌'}</span>
        </button>
        <TokenMessage message={message} />
      </div>
    );
  }

  return (
    <div className="personal-settings-token-panel">
      <div className="personal-settings-token-field">
        <label htmlFor="development-platform-token">
          <strong>开发平台令牌</strong>
        </label>
        <div className="personal-settings-token-input-row">
          <input
            id="development-platform-token"
            className="personal-settings-token-input"
            type={visible ? 'text' : 'password'}
            value={token}
            readOnly
            autoComplete="off"
            spellCheck="false"
          />
          <button
            type="button"
            className="personal-settings-icon-button personal-settings-token-icon-button"
            onClick={onToggleVisible}
            aria-label={visible ? '隐藏令牌' : '显示令牌'}
            title={visible ? '隐藏令牌' : '显示令牌'}
          >
            {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="personal-settings-icon-button personal-settings-token-icon-button"
            onClick={onCopy}
            aria-label="复制令牌"
            title="复制令牌"
          >
            <Copy size={17} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="personal-settings-token-actions">
        <span>重新生成后原令牌立即失效</span>
        <button
          type="button"
          className="personal-settings-token-regenerate"
          onClick={onRegenerate}
          disabled={generating}
        >
          {generating ? (
            <LoaderCircle className="is-spinning" size={16} aria-hidden="true" />
          ) : (
            <RefreshCw size={16} aria-hidden="true" />
          )}
          <span>{generating ? '生成中' : '重新生成'}</span>
        </button>
      </div>

      <TokenMessage message={message} />
    </div>
  );
}

function TokenMessage({ message }) {
  if (!message?.text) {
    return null;
  }
  return (
    <div
      className={`personal-settings-message ${message.type === 'error' ? 'is-error' : 'is-success'}`}
      role={message.type === 'error' ? 'alert' : 'status'}
    >
      <span>{message.text}</span>
    </div>
  );
}

function normalizeSettings(value) {
  return {
    receiveTodoNotifications: value?.receiveTodoNotifications === true,
    todoNotificationTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value?.todoNotificationTime || ''))
      ? value.todoNotificationTime
      : DEFAULT_SETTINGS.todoNotificationTime,
    developmentPlatformToken: String(value?.developmentPlatformToken || '').trim().slice(0, 200),
  };
}

function normalizeMcpSettings(value) {
  const serverUrls = [...new Set(
    (Array.isArray(value?.serverUrls) ? value.serverUrls : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )];
  if (serverUrls.length === 0 && typeof window !== 'undefined') {
    serverUrls.push(new URL('/mcp', window.location.origin).toString());
  }
  return { serverUrls };
}

function getSectionHeading(sectionId) {
  if (sectionId === 'token') {
    return {
      id: 'development-platform-token-title',
      label: '开发平台令牌',
      Icon: KeyRound,
    };
  }
  if (sectionId === 'mcp') {
    return {
      id: 'mcp-settings-title',
      label: 'MCP',
      Icon: Network,
    };
  }
  return {
    id: 'notification-settings-title',
    label: '通知',
    Icon: Bell,
  };
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('浏览器未允许复制');
  }
}

function formatErrorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.trim() || fallback;
}
