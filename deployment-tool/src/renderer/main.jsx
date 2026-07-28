import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArchiveRestore,
  Bug,
  Check,
  ChevronRight,
  CircleStop,
  Code2,
  Computer,
  FolderOpen,
  KeyRound,
  Laptop,
  LoaderCircle,
  MonitorCog,
  Network,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Upload,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import './styles.css';

const bridge = window.igpDeploy || createPreviewBridge();
const LOG_TABS = [
  ['stdout', '服务输出'],
  ['stderr', '错误输出'],
  ['client', '页面异常'],
  ['audit', '部署审计'],
];

function App() {
  const [state, setState] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    bridge.invoke('app:get-state').then(setState).catch(showError);
    const offState = bridge.onState(setState);
    const offJob = bridge.onJob(setJob);
    return () => {
      offState?.();
      offJob?.();
    };
  }, []);

  function showError(nextError) {
    setError(nextError?.message || String(nextError || '操作失败'));
  }

  async function invoke(channel, payload) {
    setError('');
    try {
      return await bridge.invoke(channel, payload);
    } catch (nextError) {
      showError(nextError);
      throw nextError;
    }
  }

  if (!state || state.initializing) {
    return (
      <FullPageStatus
        icon={error ? Bug : LoaderCircle}
        spinning={!error}
        text={error || '正在启动部署调试工具'}
      />
    );
  }
  if (state.startupError) {
    return <FullPageStatus icon={Bug} text={`启动失败：${state.startupError}`} />;
  }
  if (!state.appMode) {
    return <ModeChooser invoke={invoke} />;
  }
  return (
    <div className="app-shell">
      <AppHeader state={state} invoke={invoke} />
      {error ? (
        <div className="global-error" role="alert">
          <Bug size={16} />
          <span>{error}</span>
          <button className="icon-button" title="关闭" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      ) : null}
      {state.appMode === 'developer'
        ? <DeveloperWorkspace state={state} job={job} invoke={invoke} />
        : <TargetWorkspace state={state} invoke={invoke} />}
    </div>
  );
}

function ModeChooser({ invoke }) {
  const [loading, setLoading] = useState('');
  async function choose(mode) {
    setLoading(mode);
    try {
      await invoke('app:set-mode', { mode });
    } finally {
      setLoading('');
    }
  }
  return (
    <main className="mode-page">
      <div className="mode-mark"><Network size={30} /></div>
      <h1>IGP 局域网部署调试工具</h1>
      <p>选择这台电脑承担的角色。</p>
      <div className="mode-options">
        <button className="mode-option" onClick={() => choose('developer')}>
          <Laptop size={26} />
          <span>
            <strong>开发端</strong>
            <small>构建、发送、控制与远程调试</small>
          </span>
          {loading === 'developer' ? <LoaderCircle className="spin" /> : <ChevronRight />}
        </button>
        <button className="mode-option" onClick={() => choose('target')}>
          <Server size={26} />
          <span>
            <strong>目标端</strong>
            <small>等待连接、管理发布版本与服务进程</small>
          </span>
          {loading === 'target' ? <LoaderCircle className="spin" /> : <ChevronRight />}
        </button>
      </div>
    </main>
  );
}

function AppHeader({ state, invoke }) {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-icon"><Network size={20} /></span>
        <span>
          <strong>IGP Deploy</strong>
          <small>{state.appMode === 'developer' ? '开发端控制台' : '目标端代理'}</small>
        </span>
      </div>
      <div className="header-status">
        <StatusDot ok={state.appMode === 'target' ? true : !state.currentStatus?.error} />
        <span>{state.appMode === 'target' ? '正在等待局域网连接' : state.currentStatus?.error || '控制台已就绪'}</span>
      </div>
      <div className="header-actions">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={Boolean(state.openAtLogin)}
            onChange={(event) => invoke('app:set-login-startup', { enabled: event.target.checked })}
          />
          <span>登录自启</span>
        </label>
        <button
          className="icon-button"
          title="切换工具模式"
          onClick={() => invoke('app:set-mode', {
            mode: state.appMode === 'developer' ? 'target' : 'developer',
          })}
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}

function DeveloperWorkspace({ state, job, invoke }) {
  const targets = state.targets || [];
  const selectedId = state.defaultTargetId || targets[0]?.targetId || '';
  const selected = targets.find((target) => target.targetId === selectedId);
  const [status, setStatus] = useState(state.currentStatus);
  const [pairTarget, setPairTarget] = useState(null);
  const [pairCode, setPairCode] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualAddress, setManualAddress] = useState('');
  const [manualPort, setManualPort] = useState('47322');
  const [logTab, setLogTab] = useState('stdout');
  const [logText, setLogText] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    setStatus(state.currentStatus);
  }, [state.currentStatus, selectedId]);

  async function scan() {
    setBusy('scan');
    try {
      await invoke('developer:scan');
    } finally {
      setBusy('');
    }
  }

  async function refresh() {
    if (!selectedId) return;
    setBusy('refresh');
    try {
      setStatus(await invoke('developer:refresh', { targetId: selectedId }));
    } finally {
      setBusy('');
    }
  }

  async function chooseRepository() {
    const result = await invoke('app:choose-directory', {
      title: '选择 IGPDevelopmentPlatform 仓库',
      defaultPath: state.repositoryPath,
    });
    if (!result.cancelled) {
      await invoke('developer:set-repository', { path: result.path });
    }
  }

  async function deploy() {
    if (!selectedId || !state.repositoryPath) return;
    setBusy('deploy');
    try {
      await invoke('developer:deploy', {
        targetId: selectedId,
        sourcePath: state.repositoryPath,
        sourceType: 'repository',
      });
    } finally {
      setBusy('');
    }
  }

  async function action(action) {
    setBusy(action);
    try {
      await invoke('developer:action', { targetId: selectedId, action });
      await refresh();
    } finally {
      setBusy('');
    }
  }

  async function loadLog(nextTab = logTab) {
    if (!selectedId) return;
    setLogTab(nextTab);
    const payload = await invoke('developer:read-log', {
      targetId: selectedId,
      name: nextTab,
      options: { limit: 512 * 1024 },
    });
    setLogText(payload.text || '');
  }

  async function pair() {
    setBusy('pair');
    try {
      await invoke('developer:pair', { target: pairTarget, code: pairCode });
      setPairTarget(null);
      setPairCode('');
    } finally {
      setBusy('');
    }
  }

  async function probeManualTarget() {
    setBusy('probe');
    try {
      const target = await invoke('developer:probe', {
        address: manualAddress.trim(),
        port: Number(manualPort),
      });
      setManualOpen(false);
      setPairTarget(target);
    } finally {
      setBusy('');
    }
  }

  const discoveries = (state.discoveredTargets || []).filter(
    (target) => !targets.some((saved) => saved.targetId === target.targetId),
  );

  return (
    <main className="workspace developer-layout">
      <aside className="target-sidebar">
        <div className="sidebar-heading">
          <span>目标电脑</span>
          <span className="sidebar-actions">
            <button className="icon-button" title="手动连接" onClick={() => setManualOpen(true)}>
              <Network size={17} />
            </button>
            <button className="icon-button" title="扫描局域网" onClick={scan}>
              {busy === 'scan' ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}
            </button>
          </span>
        </div>
        <div className="target-list">
          {targets.map((target) => (
            <button
              key={target.targetId}
              className={`target-row ${target.targetId === selectedId ? 'active' : ''}`}
              onClick={() => invoke('developer:set-default', { targetId: target.targetId })}
            >
              <Computer size={18} />
              <span>
                <strong>{target.displayName}</strong>
                <small>{target.address}:{target.port}</small>
              </span>
              <StatusDot ok={target.discovered} />
            </button>
          ))}
          {targets.length === 0 ? (
            <div className="empty-state compact">
              <Wifi size={22} />
              <span>扫描并配对目标电脑</span>
            </div>
          ) : null}
        </div>
        {discoveries.length ? (
          <section className="discovered-section">
            <h3>发现的设备</h3>
            {discoveries.map((target) => (
              <button key={target.targetId} className="discovered-row" onClick={() => setPairTarget(target)}>
                <Server size={17} />
                <span>{target.displayName}</span>
                <KeyRound size={15} />
              </button>
            ))}
          </section>
        ) : null}
      </aside>

      <section className="main-console">
        <div className="console-toolbar">
          <div>
            <h1>{selected?.displayName || '未选择目标电脑'}</h1>
            <p>{selected ? `${selected.address}:${selected.port}` : '扫描局域网并完成首次配对'}</p>
          </div>
          <div className="command-bar">
            <button className="icon-button bordered" title="刷新状态" disabled={!selected} onClick={refresh}>
              {busy === 'refresh' ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
            </button>
            <button className="command-button" disabled={!selected} onClick={() => action('start')}>
              <Play size={16} />启动
            </button>
            <button className="command-button" disabled={!selected} onClick={() => action('restart')}>
              <RotateCw size={16} />重启
            </button>
            <button className="command-button danger" disabled={!selected} onClick={() => action('stop')}>
              <CircleStop size={16} />停止
            </button>
          </div>
        </div>

        <StatusStrip status={status} />

        <section className="deploy-section">
          <div className="section-title">
            <div>
              <h2>构建与部署</h2>
              <p>目标端配置和历史日志不会进入上传包。</p>
            </div>
            <button
              className="primary-button"
              disabled={!selected || !state.repositoryPath || job?.status === 'running'}
              onClick={deploy}
            >
              {job?.status === 'running' ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
              构建并部署
            </button>
          </div>
          <div className="path-control">
            <FolderOpen size={18} />
            <span>{state.repositoryPath || '尚未选择项目仓库'}</span>
            <button onClick={chooseRepository}>选择</button>
          </div>
          {job ? <JobProgress job={job} /> : null}
        </section>

        <div className="console-grid">
          <section className="release-panel">
            <div className="section-title compact-title">
              <div>
                <h2>发布版本</h2>
                <p>{status?.deployment?.releases?.length || 0} 个已安装版本</p>
              </div>
              <button
                className="icon-button bordered"
                title="回滚到上一版本"
                disabled={!selected || !status?.deployment?.previousReleaseId}
                onClick={() => action('rollback')}
              >
                <ArchiveRestore size={17} />
              </button>
            </div>
            <ReleaseList deployment={status?.deployment} />
          </section>
          <section className="diagnostic-panel">
            <div className="section-title compact-title">
              <div>
                <h2>远程调试</h2>
                <p>Inspector 仅通过已认证隧道开放。</p>
              </div>
              <button
                className="command-button"
                disabled={!selected || !status?.service?.running}
                onClick={() => invoke('developer:debug', { targetId: selectedId })}
              >
                <Code2 size={16} />打开调试器
              </button>
            </div>
            <DiagnosticFacts status={status} />
          </section>
        </div>

        <LogPanel active={logTab} text={logText} onSelect={loadLog} onRefresh={() => loadLog(logTab)} />
      </section>

      {pairTarget ? (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">
              <KeyRound size={20} />
              <div>
                <h2>配对 {pairTarget.displayName}</h2>
                <p>在目标端界面读取六位配对码。</p>
              </div>
              <button className="icon-button" title="关闭" onClick={() => setPairTarget(null)}>
                <X size={18} />
              </button>
            </div>
            <label className="field">
              <span>配对码</span>
              <input
                autoFocus
                value={pairCode}
                maxLength={6}
                inputMode="numeric"
                onChange={(event) => setPairCode(event.target.value.replace(/\D/g, ''))}
                placeholder="000000"
              />
            </label>
            <div className="fingerprint">
              <ShieldCheck size={16} />
              <span>{formatFingerprint(pairTarget.fingerprint)}</span>
            </div>
            <div className="modal-actions">
              <button onClick={() => setPairTarget(null)}>取消</button>
              <button className="primary-button" disabled={pairCode.length !== 6} onClick={pair}>
                {busy === 'pair' ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                完成配对
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {manualOpen ? (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">
              <Network size={20} />
              <div>
                <h2>手动连接目标端</h2>
                <p>输入目标电脑的局域网地址和控制端口。</p>
              </div>
              <button className="icon-button" title="关闭" onClick={() => setManualOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="manual-fields">
              <label className="field">
                <span>IP 地址或主机名</span>
                <input
                  value={manualAddress}
                  onChange={(event) => setManualAddress(event.target.value)}
                  placeholder="172.16.20.205"
                />
              </label>
              <label className="field port-field">
                <span>端口</span>
                <input
                  value={manualPort}
                  inputMode="numeric"
                  onChange={(event) => setManualPort(event.target.value.replace(/\D/g, ''))}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button onClick={() => setManualOpen(false)}>取消</button>
              <button
                className="primary-button"
                disabled={!manualAddress.trim() || !Number(manualPort)}
                onClick={probeManualTarget}
              >
                {busy === 'probe' ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}
                检查目标端
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function TargetWorkspace({ state, invoke }) {
  const [logTab, setLogTab] = useState('stdout');
  const [logText, setLogText] = useState('');
  const [busy, setBusy] = useState('');

  async function action(actionName) {
    setBusy(actionName);
    try {
      await invoke('target:action', { action: actionName });
    } finally {
      setBusy('');
    }
  }

  async function importConfig() {
    const result = await invoke('app:choose-directory', {
      title: '选择现有 Publish 目录',
    });
    if (!result.cancelled) {
      await invoke('target:import-config', { path: result.path });
    }
  }

  async function loadLog(nextTab = logTab) {
    setLogTab(nextTab);
    const payload = await invoke('target:read-log', {
      name: nextTab,
      options: { limit: 512 * 1024 },
    });
    setLogText(payload.text || '');
  }

  const service = state.service || {};
  return (
    <main className="workspace target-layout">
      <aside className="target-local-sidebar">
        <div className="target-identity">
          <span className="target-machine-icon"><Server size={24} /></span>
          <div>
            <h1>{state.displayName}</h1>
            <p>{state.addresses?.join(' / ') || '未检测到局域网地址'}:{state.controlPort}</p>
          </div>
        </div>
        <div className="pairing-block">
          <div className="pairing-heading">
            <span>开发端配对码</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(state.pairingEnabled)}
                onChange={(event) => invoke('target:pairing', { enabled: event.target.checked })}
              />
              <span />
            </label>
          </div>
          <strong className="pairing-code">{state.pairingCode || '------'}</strong>
          <button
            className="text-button"
            disabled={!state.pairingEnabled}
            onClick={() => invoke('target:refresh-code')}
          >
            <RefreshCw size={15} />刷新配对码
          </button>
        </div>
        <div className="fingerprint target-fingerprint">
          <ShieldCheck size={16} />
          <span>{formatFingerprint(state.fingerprint)}</span>
        </div>
        <section className="paired-clients">
          <h2><Users size={17} />已配对开发端</h2>
          {(state.pairedClients || []).map((client) => (
            <div className="paired-client" key={client.clientId}>
              <Laptop size={16} />
              <span>
                <strong>{client.clientName}</strong>
                <small>{formatTime(client.lastSeenAt)}</small>
              </span>
              <button
                className="icon-button"
                title="撤销配对"
                onClick={() => invoke('target:revoke', { clientId: client.clientId })}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {(state.pairedClients || []).length === 0 ? <p className="muted">暂无已配对开发端</p> : null}
        </section>
      </aside>

      <section className="main-console">
        <div className="console-toolbar">
          <div>
            <h1>目标端运行状态</h1>
            <p>等待开发端连接并管理本机发布服务。</p>
          </div>
          <div className="command-bar">
            <button className="command-button" onClick={() => action('start')}>
              <Play size={16} />启动
            </button>
            <button className="command-button" onClick={() => action('restart')}>
              <RotateCw size={16} />重启
            </button>
            <button className="command-button danger" onClick={() => action('stop')}>
              <CircleStop size={16} />停止
            </button>
          </div>
        </div>

        <StatusStrip status={{ service, deployment: state.deployment }} />

        {!state.deployment?.configAvailable ? (
          <section className="setup-banner">
            <MonitorCog size={24} />
            <div>
              <h2>导入目标端运行配置</h2>
              <p>选择现有 Publish 目录，仅导入其中的 config.json；后续发布不会覆盖它。</p>
            </div>
            <button className="primary-button" onClick={importConfig}>
              <FolderOpen size={17} />选择 Publish
            </button>
          </section>
        ) : null}

        <div className="console-grid">
          <section className="release-panel">
            <div className="section-title compact-title">
              <div>
                <h2>发布版本</h2>
                <p>保留当前、上一版本及最近发布。</p>
              </div>
              <button
                className="icon-button bordered"
                title="回滚到上一版本"
                disabled={!state.deployment?.previousReleaseId}
                onClick={() => action('rollback')}
              >
                <ArchiveRestore size={17} />
              </button>
            </div>
            <ReleaseList deployment={state.deployment} />
          </section>
          <section className="diagnostic-panel">
            <div className="section-title compact-title">
              <div>
                <h2>本机诊断</h2>
                <p>应用端口与 Inspector 仅从持久化状态读取。</p>
              </div>
            </div>
            <DiagnosticFacts status={{ service, deployment: state.deployment }} />
          </section>
        </div>

        <LogPanel active={logTab} text={logText} onSelect={loadLog} onRefresh={() => loadLog(logTab)} />
      </section>
    </main>
  );
}

function StatusStrip({ status }) {
  const service = status?.service || {};
  const deployment = status?.deployment || {};
  return (
    <div className="status-strip">
      <StatusMetric
        icon={Activity}
        label="服务状态"
        value={service.running ? (service.healthy ? '运行正常' : '运行异常') : '已停止'}
        tone={service.running && service.healthy ? 'success' : service.running ? 'warning' : 'neutral'}
      />
      <StatusMetric icon={Upload} label="当前版本" value={deployment.currentReleaseId || '未部署'} />
      <StatusMetric icon={Network} label="应用端口" value={service.appPort || '--'} />
      <StatusMetric icon={TerminalSquare} label="Inspector" value={service.inspectorPort || '--'} />
    </div>
  );
}

function StatusMetric({ icon: Icon, label, value, tone = 'neutral' }) {
  return (
    <div className={`status-metric ${tone}`}>
      <Icon size={19} />
      <span>
        <small>{label}</small>
        <strong>{String(value)}</strong>
      </span>
    </div>
  );
}

function ReleaseList({ deployment }) {
  const releases = useMemo(
    () => [...(deployment?.releases || [])].sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt))),
    [deployment],
  );
  if (!releases.length) {
    return <div className="empty-state"><Upload size={24} /><span>尚未安装发布版本</span></div>;
  }
  return (
    <div className="release-list">
      {releases.map((release) => {
        const current = release.releaseId === deployment.currentReleaseId;
        const previous = release.releaseId === deployment.previousReleaseId;
        return (
          <div className={`release-row ${current ? 'current' : ''}`} key={release.releaseId}>
            <span className="release-marker">{current ? <Check size={14} /> : null}</span>
            <span>
              <strong>{release.appVersion}</strong>
              <small>{release.releaseId}</small>
            </span>
            <time>{formatTime(release.installedAt)}</time>
            {current ? <span className="tag success-tag">当前</span> : previous ? <span className="tag">上一版</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function DiagnosticFacts({ status }) {
  const service = status?.service || {};
  const deployment = status?.deployment || {};
  return (
    <dl className="facts">
      <div><dt>进程 PID</dt><dd>{service.pid || '--'}</dd></div>
      <div><dt>启动时间</dt><dd>{formatTime(service.startedAt)}</dd></div>
      <div><dt>健康检查</dt><dd>{service.healthy ? '通过' : '未通过'}</dd></div>
      <div><dt>配置状态</dt><dd>{deployment.configAvailable ? '已持久化' : '未导入'}</dd></div>
      <div><dt>已安装版本</dt><dd>{deployment.releases?.length || 0}</dd></div>
      <div><dt>上一版本</dt><dd>{deployment.previousReleaseId || '--'}</dd></div>
    </dl>
  );
}

function LogPanel({ active, text, onSelect, onRefresh }) {
  return (
    <section className="log-panel">
      <div className="log-toolbar">
        <div className="tabs">
          {LOG_TABS.map(([id, label]) => (
            <button key={id} className={active === id ? 'active' : ''} onClick={() => onSelect(id)}>
              {label}
            </button>
          ))}
        </div>
        <button className="icon-button" title="刷新日志" onClick={onRefresh}>
          <RefreshCw size={16} />
        </button>
      </div>
      <pre>{text || '选择日志类型并刷新。'}</pre>
    </section>
  );
}

function JobProgress({ job }) {
  const progress = job.progress || {};
  const percentage = progress.totalBytes
    ? Math.min(100, Math.round((progress.uploadedBytes || 0) / progress.totalBytes * 100))
    : job.status === 'completed' ? 100 : 12;
  return (
    <div className={`job-progress ${job.status}`}>
      <div>
        {job.status === 'completed' ? <Check size={17} /> : job.status === 'failed' ? <X size={17} /> : <LoaderCircle className="spin" size={17} />}
        <span>
          <strong>{job.message}</strong>
          <small>{job.error || job.phase}</small>
        </span>
        <b>{percentage}%</b>
      </div>
      <div className="progress-track"><span style={{ width: `${percentage}%` }} /></div>
    </div>
  );
}

function StatusDot({ ok }) {
  return <span className={`status-dot ${ok ? 'online' : ''}`} />;
}

function FullPageStatus({ icon: Icon, text, spinning }) {
  return (
    <main className="full-page-status">
      <Icon className={spinning ? 'spin' : ''} size={28} />
      <span>{text}</span>
    </main>
  );
}

function formatFingerprint(value) {
  return String(value || '').match(/.{1,4}/g)?.join(' ') || '--';
}

function formatTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('zh-CN', { hour12: false });
}

function createPreviewBridge() {
  let stateListener = null;
  let jobListener = null;
  const developerPreviewState = {
    appMode: 'developer',
    mode: 'developer',
    openAtLogin: true,
    clientId: 'client-preview',
    defaultTargetId: 'target-preview',
    repositoryPath: 'D:\\IGPDevelopmentPlatform',
    targets: [{
      targetId: 'target-preview',
      displayName: 'IGP-TEST-01',
      address: '172.16.20.205',
      port: 47322,
      paired: true,
      discovered: true,
    }],
    discoveredTargets: [],
    currentStatus: {
      deployment: {
        configAvailable: true,
        currentReleaseId: '0.1.95-20260728143000-a1b2c3',
        previousReleaseId: '0.1.94-20260727162000-b2c3d4',
        releases: [
          { releaseId: '0.1.95-20260728143000-a1b2c3', appVersion: '0.1.95', installedAt: '2026-07-28T14:30:00+08:00' },
          { releaseId: '0.1.94-20260727162000-b2c3d4', appVersion: '0.1.94', installedAt: '2026-07-27T16:20:00+08:00' },
        ],
      },
      service: {
        running: true,
        healthy: true,
        pid: 14320,
        appPort: 3000,
        inspectorPort: 9231,
        startedAt: '2026-07-28T14:31:00+08:00',
      },
    },
  };
  const targetPreviewState = {
    appMode: 'target',
    mode: 'target',
    openAtLogin: true,
    targetId: 'target-preview',
    displayName: 'IGP-TEST-01',
    addresses: ['172.16.20.205'],
    controlPort: 47322,
    fingerprint: '93d9f3f7139b8ce10d63df595421641b72714b7649ee987251969fc32a7490bc',
    pairingEnabled: true,
    pairingCode: '638204',
    pairedClients: [{
      clientId: 'client-preview',
      clientName: 'DEV-WORKSTATION-01',
      lastSeenAt: '2026-07-28T14:40:00+08:00',
    }],
    deployment: developerPreviewState.currentStatus.deployment,
    service: developerPreviewState.currentStatus.service,
  };
  const previewMode = new URLSearchParams(window.location.search).get('preview');
  const previewState = previewMode === 'target' ? targetPreviewState : developerPreviewState;
  return {
    invoke: async (channel) => {
      if (channel === 'app:get-state') return previewState;
      return {};
    },
    onState: (listener) => {
      stateListener = listener;
      return () => { stateListener = null; };
    },
    onJob: (listener) => {
      jobListener = listener;
      return () => { jobListener = null; };
    },
  };
}

createRoot(document.getElementById('root')).render(<App />);
