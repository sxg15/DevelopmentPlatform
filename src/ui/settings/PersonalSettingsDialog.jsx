import { useEffect, useRef, useState } from 'react';
import { Bell, LoaderCircle, Save, X } from 'lucide-react';
import {
  fetchPersonalSettings,
  updatePersonalSettings,
} from '../../api/personalSettings.js';

const DEFAULT_NOTIFICATION_SETTINGS = {
  receiveTodoNotifications: false,
  todoNotificationTime: '11:00',
};

export function PersonalSettingsDialog({ onClose }) {
  const [settings, setSettings] = useState(DEFAULT_NOTIFICATION_SETTINGS);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const dialogRef = useRef(null);

  useEffect(() => {
    let isActive = true;

    async function loadSettings() {
      setStatus('loading');
      setMessage('');
      try {
        const payload = await fetchPersonalSettings();
        if (isActive) {
          setSettings(normalizeSettings(payload));
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
      if (event.key === 'Escape' && status !== 'saving') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, status]);

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
    try {
      const payload = await fetchPersonalSettings();
      setSettings(normalizeSettings(payload));
      setHasLoaded(true);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setMessage(formatErrorMessage(error, '读取个人设置失败'));
    }
  }

  function requestClose(event) {
    if (status === 'saving') {
      return;
    }
    if (!event || event.target === event.currentTarget) {
      onClose();
    }
  }

  const isLoading = status === 'loading';
  const isSaving = status === 'saving';
  const isError = status === 'error';
  const isLoadError = isError && !hasLoaded;

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
            disabled={isSaving}
            aria-label="关闭设置"
            title="关闭"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="personal-settings-layout">
          <nav className="personal-settings-nav" aria-label="设置分组">
            <button type="button" className="personal-settings-nav-item is-active" aria-current="page">
              <Bell size={17} aria-hidden="true" />
              <span>通知</span>
            </button>
          </nav>

          <section className="personal-settings-content" aria-labelledby="notification-settings-title">
            <div className="personal-settings-section-heading">
              <Bell size={19} aria-hidden="true" />
              <h3 id="notification-settings-title">通知</h3>
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
            ) : (
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
                      disabled={isSaving}
                      onChange={(event) => {
                        setSettings((current) => ({
                          ...current,
                          receiveTodoNotifications: event.target.checked,
                        }));
                        setMessage('');
                        if (isError) {
                          setStatus('ready');
                        }
                      }}
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
                      disabled={isSaving}
                      onChange={(event) => {
                        setSettings((current) => ({
                          ...current,
                          todoNotificationTime: event.target.value || '11:00',
                        }));
                        setMessage('');
                      }}
                    />
                  </div>
                ) : null}
              </div>
            )}

            {hasLoaded && message ? (
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
            disabled={isSaving}
          >
            取消
          </button>
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
        </footer>
      </section>
    </div>
  );
}

function normalizeSettings(value) {
  return {
    receiveTodoNotifications: value?.receiveTodoNotifications === true,
    todoNotificationTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value?.todoNotificationTime || ''))
      ? value.todoNotificationTime
      : DEFAULT_NOTIFICATION_SETTINGS.todoNotificationTime,
  };
}

function formatErrorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.trim() || fallback;
}
