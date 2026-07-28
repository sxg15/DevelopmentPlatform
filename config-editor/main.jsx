import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Bot,
  Braces,
  Bug,
  Check,
  ChevronRight,
  CircleHelp,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileCog,
  FolderOpen,
  Gauge,
  KeyRound,
  LoaderCircle,
  Network,
  Plus,
  RotateCcw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import './styles.css';

const SECTIONS = [
  { id: 'server', label: '服务与访问', icon: Server },
  { id: 'feishu', label: '飞书应用', icon: KeyRound },
  { id: 'knowledge', label: '知识库与工作项', icon: FileCog },
  { id: 'bitable', label: '多维表格', icon: Database },
  { id: 'dashboard', label: '项目概览', icon: Gauge },
  { id: 'ai', label: 'AI 计划', icon: Bot },
  { id: 'advanced', label: '高级配置', icon: Braces },
];

const WORK_ITEM_FIELD_GROUPS = [
  {
    id: 'requirements',
    label: '需求',
    icon: FileCog,
    basePath: 'knowledgeBase.requirementsFieldNames',
    fields: [
      ['requirementId', '需求 ID'],
      ['itemId', '工作项 ID'],
      ['title', '标题'],
      ['description', '描述'],
      ['proposer', '提出人员'],
      ['priority', '优先级'],
      ['assignees', '处理人员'],
      ['status', '处理状态'],
      ['proposedAt', '提出时间'],
      ['expectedDays', '期望时限'],
      ['attachments', '附件'],
      ['requiresSubmissionAttachment', '需要提交附件'],
      ['submittedAttachments', '提交附件'],
      ['comments', '留言'],
      ['statusChangeLog', '状态变动记录'],
    ],
  },
  {
    id: 'bugs',
    label: 'Bug',
    icon: Bug,
    basePath: 'knowledgeBase.bugsFieldNames',
    fields: [
      ['bugId', 'Bug ID'],
      ['itemId', '工作项 ID'],
      ['title', '标题'],
      ['description', '详细描述'],
      ['proposer', '提出人员'],
      ['priority', '优先级'],
      ['assignees', '处理人员'],
      ['status', '处理状态'],
      ['proposedAt', '发现时间'],
      ['expectedDays', '期望时限'],
      ['attachments', '附件'],
      ['comments', '留言'],
      ['statusChangeLog', '状态变动记录'],
    ],
  },
  {
    id: 'feedback',
    label: '反馈',
    icon: CircleHelp,
    basePath: 'knowledgeBase.feedbackFieldNames',
    fields: [
      ['feedbackId', '反馈 ID'],
      ['itemId', '工作项 ID'],
      ['title', '标题'],
      ['description', '详细描述'],
      ['channel', '渠道'],
      ['proposer', '提出人员'],
      ['assignees', '处理人员'],
      ['status', '处理状态'],
      ['proposedAt', '反馈时间'],
      ['expectedDays', '期望时限'],
      ['contactInfo', '联系信息数据'],
      ['attachments', '附件'],
      ['comments', '留言'],
      ['statusChangeLog', '状态变动记录'],
    ],
  },
];

const STATUS_GROUPS = [
  ['requirements', '需求'],
  ['bugs', 'Bug'],
  ['feedback', '反馈'],
];

const STATUS_CATEGORIES = [
  ['waiting', '待处理'],
  ['processing', '处理中'],
  ['completed', '已完成'],
  ['blocked', '阻塞'],
];

const SECRET_PATHS = ['feishu.appSecret', 'aiPlanning.codex.apiKey'];

function ConfigEditorApp() {
  const [activeSection, setActiveSection] = useState('server');
  const [config, setConfig] = useState(null);
  const [revision, setRevision] = useState('');
  const [secretState, setSecretState] = useState({});
  const [secretChanges, setSecretChanges] = useState(createDefaultSecretChanges());
  const [linksText, setLinksText] = useState('[]');
  const [warnings, setWarnings] = useState([]);
  const [errors, setErrors] = useState([]);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [recovery, setRecovery] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [pickerKey, setPickerKey] = useState('');

  const dirtySnapshot = useMemo(() => (
    config ? JSON.stringify({ config, secretChanges, linksText }) : ''
  ), [config, secretChanges, linksText]);
  const isDirty = Boolean(config && baseline && baseline !== dirtySnapshot);
  const errorMap = useMemo(() => buildMessageMap(errors), [errors]);

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    function preventAccidentalClose(event) {
      if (!isDirty) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', preventAccidentalClose);
    return () => window.removeEventListener('beforeunload', preventAccidentalClose);
  }, [isDirty]);

  async function loadConfig() {
    setStatus('loading');
    setMessage('');
    setErrors([]);
    try {
      const payload = await requestApi('/api/config');
      applyLoadedConfig(payload);
      setRecovery(null);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setRecovery(error.payload || {
        message: error.message || '读取配置失败',
      });
    }
  }

  function applyLoadedConfig(payload) {
    const nextSecretChanges = createDefaultSecretChanges();
    const nextLinksText = JSON.stringify(payload.config?.bitable?.links || [], null, 2);
    setConfig(payload.config);
    setRevision(payload.revision);
    setSecretState(payload.secretState || {});
    setSecretChanges(nextSecretChanges);
    setLinksText(nextLinksText);
    setWarnings(payload.warnings || []);
    setErrors(Array.isArray(payload.errors) ? payload.errors : []);
    setMessage('');
    setBaseline(JSON.stringify({
      config: payload.config,
      secretChanges: nextSecretChanges,
      linksText: nextLinksText,
    }));
  }

  function updateConfig(fieldPath, value) {
    setConfig((current) => setPathValue(current, fieldPath, value));
    setErrors((current) => current.filter((item) => !areRelatedFieldPaths(item.path, fieldPath)));
    setMessage('');
  }

  function updateSecret(fieldPath, change) {
    setSecretChanges((current) => ({
      ...current,
      [fieldPath]: change,
    }));
    setErrors((current) => current.filter((item) => item.path !== fieldPath));
    setMessage('');
  }

  async function saveConfig() {
    let parsedLinks;
    try {
      parsedLinks = JSON.parse(linksText || '[]');
      if (!Array.isArray(parsedLinks)) {
        throw new Error('必须是 JSON 数组');
      }
    } catch (error) {
      setErrors([{
        path: 'bitable.links',
        message: `Bitable links 格式错误：${error.message}`,
      }]);
      setActiveSection('advanced');
      return;
    }

    setStatus('saving');
    setMessage('');
    setErrors([]);
    const submittedConfig = setPathValue(config, 'bitable.links', parsedLinks);
    try {
      const payload = await requestApi('/api/config', {
        method: 'PUT',
        body: JSON.stringify({
          revision,
          config: submittedConfig,
          secretChanges,
        }),
      });

      const nextSecretState = { ...secretState };
      for (const secretPath of SECRET_PATHS) {
        const change = secretChanges[secretPath];
        if (change?.action === 'replace') {
          nextSecretState[secretPath] = true;
        } else if (change?.action === 'clear') {
          nextSecretState[secretPath] = false;
        }
      }
      const nextChanges = createDefaultSecretChanges();
      const nextConfig = setPathValue(submittedConfig, 'bitable.links', parsedLinks);
      setConfig(nextConfig);
      setRevision(payload.revision);
      setSecretState(nextSecretState);
      setSecretChanges(nextChanges);
      setWarnings(payload.warnings || []);
      setErrors([]);
      setLinksText(JSON.stringify(parsedLinks, null, 2));
      setStatus('ready');
      setMessage('配置已保存。请关闭本工具，并重新运行 StartWebBackend.bat。');
      setBaseline(JSON.stringify({
        config: nextConfig,
        secretChanges: nextChanges,
        linksText: JSON.stringify(parsedLinks, null, 2),
      }));
    } catch (error) {
      const payload = error.payload || {};
      const nextErrors = Array.isArray(payload.errors) ? payload.errors : [];
      setErrors(nextErrors);
      setStatus('error');
      setMessage(payload.message || error.message || '保存配置失败');
      if (payload.code === 'CONFIG_CHANGED') {
        setMessage('配置文件已在外部发生变化，请重新载入后再保存。');
      }
      const firstErrorSection = getSectionForPath(nextErrors[0]?.path);
      if (firstErrorSection) {
        setActiveSection(firstErrorSection);
      }
    }
  }

  async function recoverConfig(source) {
    setStatus('saving');
    setMessage('');
    try {
      await requestApi('/api/recovery', {
        method: 'POST',
        body: JSON.stringify({ source }),
      });
      await loadConfig();
      setMessage('配置已恢复，请检查内容后重新启动后端。');
    } catch (error) {
      setStatus('error');
      setMessage(error.payload?.message || error.message || '恢复配置失败');
    }
  }

  async function chooseDirectory(projectIndex, rootIndex, initialPath) {
    const key = `${projectIndex}:${rootIndex}`;
    setPickerKey(key);
    setMessage('');
    try {
      const payload = await requestApi('/api/select-directory', {
        method: 'POST',
        body: JSON.stringify({ initialPath }),
      });
      if (!payload.cancelled && payload.path) {
        updateConfig(`aiPlanning.projects.${projectIndex}.roots.${rootIndex}.path`, payload.path);
      }
    } catch (error) {
      setMessage(error.payload?.message || error.message || '打开目录选择器失败');
    } finally {
      setPickerKey('');
    }
  }

  async function closeEditor() {
    if (isDirty && !window.confirm('存在未保存的配置，确定退出吗？')) {
      return;
    }
    try {
      await requestApi('/api/shutdown', {
        method: 'POST',
        body: '{}',
      });
    } catch {
      // The service may close before the browser receives the response.
    }
    window.close();
    setMessage('配置工具已停止，可以关闭此页面。');
  }

  if (status === 'loading' && !config) {
    return <FullPageState icon={LoaderCircle} spinning text="正在读取运行配置" />;
  }

  if (!config && recovery) {
    return (
      <RecoveryScreen
        recovery={recovery}
        status={status}
        message={message}
        onRecover={recoverConfig}
        onRetry={loadConfig}
        onClose={closeEditor}
      />
    );
  }

  const activeDefinition = SECTIONS.find((section) => section.id === activeSection) || SECTIONS[0];
  const ActiveSectionIcon = activeDefinition.icon;
  const saving = status === 'saving';

  return (
    <main className="config-app">
      <header className="config-toolbar">
        <div className="config-brand">
          <span className="config-brand-icon"><Settings size={20} aria-hidden="true" /></span>
          <div>
            <strong>IGP 运行配置</strong>
            <span>本机配置工具</span>
          </div>
        </div>
        <div className="config-toolbar-actions">
          <span className={`save-state ${isDirty ? 'is-dirty' : ''}`}>
            {isDirty ? '有未保存修改' : '配置已同步'}
          </span>
          <button type="button" className="icon-button" onClick={loadConfig} disabled={saving} title="重新载入">
            <RotateCcw size={17} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" onClick={closeEditor} disabled={saving} title="退出配置工具">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="config-layout">
        <aside className="config-sidebar" aria-label="配置分组">
          <nav>
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const count = errors.filter((error) => getSectionForPath(error.path) === section.id).length;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`config-nav-item ${activeSection === section.id ? 'is-active' : ''}`}
                  onClick={() => setActiveSection(section.id)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{section.label}</span>
                  {count > 0 ? <b>{count}</b> : <ChevronRight size={15} aria-hidden="true" />}
                </button>
              );
            })}
          </nav>
          <div className="local-security-note">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>仅监听本机地址，密钥不会返回页面明文。</span>
          </div>
        </aside>

        <section className="config-workspace">
          <div className="section-title">
            <div>
              <span>运行配置</span>
              <h1>{activeDefinition.label}</h1>
            </div>
            <ActiveSectionIcon size={24} aria-hidden="true" />
          </div>

          {errors.length > 0 ? (
            <Notice type="error" title={`发现 ${errors.length} 个配置错误`}>
              <button
                type="button"
                onClick={() => {
                  const firstError = errors[0];
                  setActiveSection(getSectionForPath(firstError?.path) || activeSection);
                  window.setTimeout(() => focusFirstError(firstError), 0);
                }}
              >
                查看第一个错误
              </button>
            </Notice>
          ) : warnings.length > 0 ? (
            <Notice type="warning" title={`${warnings.length} 项业务配置尚未填写`}>
              未填写项可以分阶段保存，但对应功能在完成配置前不可用。
            </Notice>
          ) : (
            <Notice type="success" title="配置结构完整">
              保存后重新启动 Web 后端即可应用变更。
            </Notice>
          )}

          <div className="config-section-content">
            {activeSection === 'server' ? (
              <ServerSection config={config} errors={errorMap} onChange={updateConfig} />
            ) : null}
            {activeSection === 'feishu' ? (
              <FeishuSection
                config={config}
                errors={errorMap}
                secretState={secretState}
                secretChanges={secretChanges}
                onChange={updateConfig}
                onSecretChange={updateSecret}
              />
            ) : null}
            {activeSection === 'knowledge' ? (
              <KnowledgeSection config={config} errors={errorMap} onChange={updateConfig} />
            ) : null}
            {activeSection === 'bitable' ? (
              <BitableSection config={config} errors={errorMap} onChange={updateConfig} />
            ) : null}
            {activeSection === 'dashboard' ? (
              <DashboardSection config={config} errors={errorMap} onChange={updateConfig} />
            ) : null}
            {activeSection === 'ai' ? (
              <AiSection
                config={config}
                errors={errorMap}
                secretState={secretState}
                secretChanges={secretChanges}
                pickerKey={pickerKey}
                onChange={updateConfig}
                onSecretChange={updateSecret}
                onChooseDirectory={chooseDirectory}
              />
            ) : null}
            {activeSection === 'advanced' ? (
              <AdvancedSection
                value={linksText}
                error={errorMap['bitable.links']}
                onChange={(value) => {
                  setLinksText(value);
                  setErrors((current) => current.filter((item) => item.path !== 'bitable.links'));
                }}
              />
            ) : null}
          </div>
        </section>
      </div>

      <footer className="config-actions">
        <div className={`action-message ${status === 'error' ? 'is-error' : ''}`} role="status">
          {message}
        </div>
        <button type="button" className="secondary-button" onClick={loadConfig} disabled={saving || !isDirty}>
          放弃修改
        </button>
        <button type="button" className="primary-button" onClick={saveConfig} disabled={saving || !isDirty}>
          {saving ? <LoaderCircle className="spinning" size={17} aria-hidden="true" /> : <Save size={17} aria-hidden="true" />}
          <span>{saving ? '保存中' : '保存配置'}</span>
        </button>
      </footer>
    </main>
  );
}

function ServerSection({ config, errors, onChange }) {
  return (
    <>
      <ConfigPanel title="Web 后端" icon={Server}>
        <FieldGrid>
          <TextField label="监听地址" path="server.host" value={config.server.host} error={errors['server.host']} onChange={onChange} />
          <NumberField label="监听端口" path="server.port" value={config.server.port} error={errors['server.port']} onChange={onChange} min={1} max={65535} />
          <TextField label="Web 公开地址" path="webApp.publicBaseUrl" value={config.webApp.publicBaseUrl} error={errors['webApp.publicBaseUrl']} onChange={onChange} wide />
          <SelectField
            label="飞书打开方式"
            path="webApp.openMode"
            value={config.webApp.openMode}
            onChange={onChange}
            options={[
              ['appCenter', '应用中心'],
              ['sidebar', '侧边栏'],
              ['sidebar-semi', '半屏侧边栏'],
            ]}
          />
        </FieldGrid>
      </ConfigPanel>
      <ConfigPanel title="更新与调试" icon={ExternalLink}>
        <FieldGrid>
          <TextField label="更新清单 URL" path="updates.manifestUrl" value={config.updates.manifestUrl} error={errors['updates.manifestUrl']} onChange={onChange} wide />
          <TextField label="调试用户名称" path="debug.userName" value={config.debug.userName} onChange={onChange} />
          <TextField label="调试用户 Open ID" path="debug.openId" value={config.debug.openId} onChange={onChange} wide />
        </FieldGrid>
      </ConfigPanel>
    </>
  );
}

function FeishuSection({
  config,
  errors,
  secretState,
  secretChanges,
  onChange,
  onSecretChange,
}) {
  return (
    <ConfigPanel title="飞书应用凭据" icon={KeyRound}>
      <FieldGrid>
        <TextField label="App ID" path="feishu.appId" value={config.feishu.appId} error={errors['feishu.appId']} onChange={onChange} wide />
        <SecretField
          label="App Secret"
          path="feishu.appSecret"
          configured={secretState['feishu.appSecret']}
          change={secretChanges['feishu.appSecret']}
          error={errors['feishu.appSecret']}
          onChange={onSecretChange}
          wide
        />
      </FieldGrid>
      <InlineInfo icon={ShieldCheck}>
        已保存的 App Secret 不会从本机配置服务返回浏览器。留空时保持原值。
      </InlineInfo>
    </ConfigPanel>
  );
}

function KnowledgeSection({ config, errors, onChange }) {
  return (
    <>
      <ConfigPanel title="知识库结构" icon={FileCog}>
        <FieldGrid>
          <TextField label="知识库空间 ID" path="knowledgeBase.spaceId" value={config.knowledgeBase.spaceId} error={errors['knowledgeBase.spaceId']} onChange={onChange} wide />
        </FieldGrid>
      </ConfigPanel>
      <ConfigPanel title="需求列表" icon={FileCog}>
        <FieldGrid>
          <TextField label="父节点名称" path="knowledgeBase.requirementsParentName" value={config.knowledgeBase.requirementsParentName} onChange={onChange} />
          <TextField label="模板名称" path="knowledgeBase.requirementsTemplateName" value={config.knowledgeBase.requirementsTemplateName} onChange={onChange} />
          <TextField label="模板 App Token" path="knowledgeBase.requirementsTemplateAppToken" value={config.knowledgeBase.requirementsTemplateAppToken} onChange={onChange} wide />
          <TextField label="ID 前缀" path="knowledgeBase.requirementsIdPrefix" value={config.knowledgeBase.requirementsIdPrefix} onChange={onChange} />
          <NumberField label="ID 位数" path="knowledgeBase.requirementsIdDigits" value={config.knowledgeBase.requirementsIdDigits} onChange={onChange} min={1} />
        </FieldGrid>
      </ConfigPanel>
      <ConfigPanel title="Bug 列表" icon={Bug}>
        <FieldGrid>
          <TextField label="父节点名称" path="knowledgeBase.bugsParentName" value={config.knowledgeBase.bugsParentName} onChange={onChange} />
          <TextField label="模板名称" path="knowledgeBase.bugsTemplateName" value={config.knowledgeBase.bugsTemplateName} onChange={onChange} />
          <TextField label="模板 App Token" path="knowledgeBase.bugsTemplateAppToken" value={config.knowledgeBase.bugsTemplateAppToken} onChange={onChange} wide />
          <TextField label="ID 前缀" path="knowledgeBase.bugsIdPrefix" value={config.knowledgeBase.bugsIdPrefix} onChange={onChange} />
          <NumberField label="ID 位数" path="knowledgeBase.bugsIdDigits" value={config.knowledgeBase.bugsIdDigits} onChange={onChange} min={1} />
        </FieldGrid>
      </ConfigPanel>
      <ConfigPanel title="反馈列表" icon={CircleHelp}>
        <FieldGrid>
          <TextField label="父节点名称" path="knowledgeBase.feedbackParentName" value={config.knowledgeBase.feedbackParentName} onChange={onChange} />
          <TextField label="模板名称" path="knowledgeBase.feedbackTemplateName" value={config.knowledgeBase.feedbackTemplateName} onChange={onChange} />
          <TextField label="模板 App Token" path="knowledgeBase.feedbackTemplateAppToken" value={config.knowledgeBase.feedbackTemplateAppToken} onChange={onChange} wide />
          <TextField label="ID 前缀" path="knowledgeBase.feedbackIdPrefix" value={config.knowledgeBase.feedbackIdPrefix} onChange={onChange} />
          <NumberField label="ID 位数" path="knowledgeBase.feedbackIdDigits" value={config.knowledgeBase.feedbackIdDigits} onChange={onChange} min={1} />
        </FieldGrid>
      </ConfigPanel>
      {WORK_ITEM_FIELD_GROUPS.map((group) => (
        <FieldMappingPanel
          key={group.id}
          title={`${group.label}字段映射`}
          icon={group.icon}
          basePath={group.basePath}
          fields={group.fields}
          config={config}
          errors={errors}
          onChange={onChange}
        />
      ))}
    </>
  );
}

function BitableSection({ config, errors, onChange }) {
  return (
    <>
      <ConfigPanel title="项目基础信息" icon={Database}>
        <ResourceFields basePath="bitable.projectBase" config={config} errors={errors} onChange={onChange} includeView />
        <FieldMappingGrid
          basePath="bitable.projectBase.fieldNames"
          fields={[
            ['projectId', '项目 ID'],
            ['projectName', '项目名称'],
            ['projectIcon', '项目图标'],
          ]}
          config={config}
          errors={errors}
          onChange={onChange}
        />
      </ConfigPanel>

      <ConfigPanel title="项目权限" icon={Users}>
        <ResourceFields basePath="bitable.projectPermission" config={config} errors={errors} onChange={onChange} includeView />
        <FieldMappingGrid
          basePath="bitable.projectPermission.fieldNames"
          fields={[
            ['projectId', '项目 ID'],
            ['developmentSuperAdmins', '研发超级管理员'],
          ]}
          config={config}
          errors={errors}
          onChange={onChange}
        />
        <StringListField
          label="拥有项目权限的人员字段"
          path="bitable.projectPermission.fieldNames.permissionUsers"
          values={getPathValue(config, 'bitable.projectPermission.fieldNames.permissionUsers')}
          onChange={onChange}
        />
      </ConfigPanel>

      <ConfigPanel title="工具权限" icon={ShieldCheck}>
        <ResourceFields basePath="bitable.toolPermission" config={config} errors={errors} onChange={onChange} includeView />
        <FieldMappingGrid
          basePath="bitable.toolPermission.fieldNames"
          fields={[['department', '部门字段']]}
          config={config}
          errors={errors}
          onChange={onChange}
        />
        <FieldMappingGrid
          basePath="bitable.toolPermission.fieldNames.tools"
          fields={[
            ['requirements', '需求列表'],
            ['bugs', 'Bug 列表'],
            ['builds', '打包列表'],
            ['review', '内容审查'],
            ['feedback', '反馈列表'],
          ]}
          config={config}
          errors={errors}
          onChange={onChange}
        />
      </ConfigPanel>

      <ConfigPanel title="个人设置" icon={Users}>
        <FieldGrid>
          <TextField label="Wiki 节点 Token" path="bitable.personalSettings.wikiNodeToken" value={config.bitable.personalSettings.wikiNodeToken} onChange={onChange} wide />
          <TextField label="Table ID" path="bitable.personalSettings.tableId" value={config.bitable.personalSettings.tableId} onChange={onChange} />
          <TextField label="View ID" path="bitable.personalSettings.viewId" value={config.bitable.personalSettings.viewId} onChange={onChange} />
          <TextField label="启用值" path="bitable.personalSettings.enabledValue" value={config.bitable.personalSettings.enabledValue} onChange={onChange} />
          <TextField label="默认提醒时间" path="bitable.personalSettings.defaultTime" value={config.bitable.personalSettings.defaultTime} onChange={onChange} type="time" />
          <TextField label="时区" path="bitable.personalSettings.timeZone" value={config.bitable.personalSettings.timeZone} onChange={onChange} />
        </FieldGrid>
        <FieldMappingGrid
          basePath="bitable.personalSettings.fieldNames"
          fields={[
            ['user', '用户'],
            ['receiveTodoNotifications', '接收待办事项通知'],
            ['todoNotificationTime', '待办事项通知时间'],
          ]}
          config={config}
          errors={errors}
          onChange={onChange}
        />
      </ConfigPanel>

      <ConfigPanel title="版本管理" icon={Network}>
        <FieldGrid>
          <TextField label="模板 Wiki 节点 Token" path="bitable.versionManagement.wikiNodeToken" value={config.bitable.versionManagement.wikiNodeToken} onChange={onChange} wide />
          <TextField label="父节点名称" path="bitable.versionManagement.parentName" value={config.bitable.versionManagement.parentName} onChange={onChange} />
          <TextField label="Table ID" path="bitable.versionManagement.tableId" value={config.bitable.versionManagement.tableId} onChange={onChange} />
          <TextField label="View ID" path="bitable.versionManagement.viewId" value={config.bitable.versionManagement.viewId} onChange={onChange} />
        </FieldGrid>
        <FieldMappingGrid
          basePath="bitable.versionManagement.fieldNames"
          fields={[
            ['versionNumber', '版本号'],
            ['status', '状态'],
            ['requirements', '已处理需求'],
            ['bugs', '已处理 Bug'],
            ['feedback', '已处理反馈'],
            ['statusHistory', '状态变动记录'],
            ['comments', '留言'],
            ['previousVersion', '上个版本'],
            ['platform', '平台'],
          ]}
          config={config}
          errors={errors}
          onChange={onChange}
        />
      </ConfigPanel>
    </>
  );
}

function DashboardSection({ config, errors, onChange }) {
  return (
    <>
      <ConfigPanel title="概览计算参数" icon={Gauge}>
        <FieldGrid>
          <NumberField label="缓存时间（毫秒）" path="dashboard.cacheTtlMs" value={config.dashboard.cacheTtlMs} error={errors['dashboard.cacheTtlMs']} onChange={onChange} min={1} />
          <NumberField label="无进展判定（天）" path="dashboard.staleDays" value={config.dashboard.staleDays} error={errors['dashboard.staleDays']} onChange={onChange} min={1} />
          <NumberField label="即将到期（天）" path="dashboard.dueSoonDays" value={config.dashboard.dueSoonDays} error={errors['dashboard.dueSoonDays']} onChange={onChange} min={1} />
        </FieldGrid>
      </ConfigPanel>
      {STATUS_GROUPS.map(([toolId, toolLabel]) => (
        <ConfigPanel key={toolId} title={`${toolLabel}状态分组`} icon={Gauge}>
          <div className="status-group-grid">
            {STATUS_CATEGORIES.map(([categoryId, categoryLabel]) => {
              const fieldPath = `dashboard.statusGroups.${toolId}.${categoryId}`;
              return (
                <StringListField
                  key={categoryId}
                  label={categoryLabel}
                  path={fieldPath}
                  values={getPathValue(config, fieldPath)}
                  error={errors[fieldPath]}
                  onChange={onChange}
                />
              );
            })}
          </div>
        </ConfigPanel>
      ))}
    </>
  );
}

function AiSection({
  config,
  errors,
  secretState,
  secretChanges,
  pickerKey,
  onChange,
  onSecretChange,
  onChooseDirectory,
}) {
  const projects = config.aiPlanning.projects || [];
  const enabledProjects = projects.filter((project) => project?.enabled !== false);
  const projectConfigurationError = errors['aiPlanning.projects']
    || (
      config.aiPlanning.enabled && enabledProjects.length === 0
        ? 'AI 计划已启用，但还没有可用的项目映射。请填写飞书项目 ID 和后端设备上的代码目录。'
        : ''
    );

  function addProject() {
    onChange('aiPlanning.projects', [
      ...projects,
      {
        projectId: '',
        enabled: true,
        roots: [{ id: 'main', path: '', profile: 'auto' }],
      },
    ]);
  }

  function removeProject(projectIndex) {
    if (!window.confirm('确定删除这个 AI 项目配置吗？')) {
      return;
    }
    onChange('aiPlanning.projects', projects.filter((_, index) => index !== projectIndex));
  }

  function addRoot(projectIndex) {
    const roots = projects[projectIndex]?.roots || [];
    const existingIds = new Set(roots.map((root) => root.id));
    let number = roots.length + 1;
    let id = `root${number}`;
    while (existingIds.has(id)) {
      number += 1;
      id = `root${number}`;
    }
    onChange(`aiPlanning.projects.${projectIndex}.roots`, [
      ...roots,
      { id, path: '', profile: 'auto' },
    ]);
  }

  function removeRoot(projectIndex, rootIndex) {
    const roots = projects[projectIndex]?.roots || [];
    onChange(
      `aiPlanning.projects.${projectIndex}.roots`,
      roots.filter((_, index) => index !== rootIndex),
    );
  }

  return (
    <>
      <ConfigPanel title="AI 计划开关" icon={Bot}>
        <ToggleField
          label="启用 AI 计划"
          description="启用后，需求和 Bug 详情页可使用 Codex 只读分析项目并生成计划。"
          checked={config.aiPlanning.enabled}
          onChange={(checked) => onChange('aiPlanning.enabled', checked)}
        />
      </ConfigPanel>

      <ConfigPanel title="Codex 模型" icon={Bot}>
        <FieldGrid>
          <TextField label="模型名称" path="aiPlanning.codex.model" value={config.aiPlanning.codex.model} error={errors['aiPlanning.codex.model']} onChange={onChange} />
          <TextField label="API URL" path="aiPlanning.codex.apiBaseUrl" value={config.aiPlanning.codex.apiBaseUrl} error={errors['aiPlanning.codex.apiBaseUrl']} onChange={onChange} wide />
          <SecretField
            label="API Key"
            path="aiPlanning.codex.apiKey"
            configured={secretState['aiPlanning.codex.apiKey']}
            change={secretChanges['aiPlanning.codex.apiKey']}
            error={errors['aiPlanning.codex.apiKey']}
            onChange={onSecretChange}
            wide
          />
          <TextField
            label="推理等级"
            path="aiPlanning.codex.reasoningEffort"
            value={config.aiPlanning.codex.reasoningEffort}
            onChange={onChange}
            list="reasoning-effort-options"
          />
          <NumberField
            label="请求超时（毫秒）"
            path="aiPlanning.codex.requestTimeoutMs"
            value={config.aiPlanning.codex.requestTimeoutMs}
            error={errors['aiPlanning.codex.requestTimeoutMs']}
            onChange={onChange}
            min={1}
          />
          <NumberField
            label="最大并发任务"
            path="aiPlanning.codex.maxConcurrentRuns"
            value={config.aiPlanning.codex.maxConcurrentRuns}
            error={errors['aiPlanning.codex.maxConcurrentRuns']}
            onChange={onChange}
            min={1}
          />
        </FieldGrid>
        <datalist id="reasoning-effort-options">
          <option value="low" />
          <option value="medium" />
          <option value="high" />
          <option value="xhigh" />
        </datalist>
      </ConfigPanel>

      <ConfigPanel title="附件分析与通知" icon={Bot}>
        <ToggleField
          label="分析工作项附件"
          description="自动下载常见图片、文本和 Office/PDF 附件供 Codex 本轮只读分析；失败时跳过并显示原因。"
          checked={config.aiPlanning.attachments.enabled}
          onChange={(checked) => onChange('aiPlanning.attachments.enabled', checked)}
        />
        <ToggleField
          label="发送 AI 计划飞书通知"
          description="仅在需要回答、方案完成或运行失败时通知当前对话用户。"
          checked={config.aiPlanning.notifications.enabled}
          onChange={(checked) => onChange('aiPlanning.notifications.enabled', checked)}
        />
        <FieldGrid>
          <NumberField
            label="单轮附件数量"
            path="aiPlanning.attachments.maxFiles"
            value={config.aiPlanning.attachments.maxFiles}
            error={errors['aiPlanning.attachments.maxFiles']}
            onChange={onChange}
            min={1}
          />
          <NumberField
            label="单附件字节上限"
            path="aiPlanning.attachments.maxFileBytes"
            value={config.aiPlanning.attachments.maxFileBytes}
            error={errors['aiPlanning.attachments.maxFileBytes']}
            onChange={onChange}
            min={1}
          />
          <NumberField
            label="附件总字节上限"
            path="aiPlanning.attachments.maxTotalBytes"
            value={config.aiPlanning.attachments.maxTotalBytes}
            error={errors['aiPlanning.attachments.maxTotalBytes']}
            onChange={onChange}
            min={1}
          />
          <NumberField
            label="单附件提取字符"
            path="aiPlanning.attachments.maxExtractedCharsPerFile"
            value={config.aiPlanning.attachments.maxExtractedCharsPerFile}
            error={errors['aiPlanning.attachments.maxExtractedCharsPerFile']}
            onChange={onChange}
            min={1}
          />
          <NumberField
            label="提取字符总上限"
            path="aiPlanning.attachments.maxExtractedCharsTotal"
            value={config.aiPlanning.attachments.maxExtractedCharsTotal}
            error={errors['aiPlanning.attachments.maxExtractedCharsTotal']}
            onChange={onChange}
            min={1}
          />
          <NumberField
            label="临时目录保留小时"
            path="aiPlanning.attachments.retentionHours"
            value={config.aiPlanning.attachments.retentionHours}
            error={errors['aiPlanning.attachments.retentionHours']}
            onChange={onChange}
            min={1}
          />
        </FieldGrid>
      </ConfigPanel>

      <div className="panel-heading-row">
        <div>
          <span>项目代码目录</span>
          <strong>AI 项目</strong>
        </div>
        <button type="button" className="outline-button" onClick={addProject}>
          <Plus size={16} aria-hidden="true" />
          <span>添加项目</span>
        </button>
      </div>

      {projectConfigurationError ? (
        <div className="ai-project-config-error" data-field-path="aiPlanning.projects">
          <AlertTriangle size={17} aria-hidden="true" />
          <FieldError>{projectConfigurationError}</FieldError>
        </div>
      ) : null}

      {projects.length === 0 ? (
        <div className="empty-panel">
          <FolderOpen size={24} aria-hidden="true" />
          <strong>尚未配置 AI 项目</strong>
          <span>项目 ID 必须与项目表中的“项目ID”字段完全一致。</span>
          <button type="button" className="outline-button" onClick={addProject}>
            <Plus size={16} aria-hidden="true" />
            <span>添加项目映射</span>
          </button>
        </div>
      ) : projects.map((project, projectIndex) => (
        <section className="ai-project-panel" key={`${project.projectId}-${projectIndex}`}>
          <header>
            <div>
              <span>项目 {projectIndex + 1}</span>
              <strong>{project.projectId || '未命名项目'}</strong>
            </div>
            <div className="project-header-actions">
              <label className="compact-toggle">
                <input
                  type="checkbox"
                  checked={project.enabled !== false}
                  onChange={(event) => onChange(`aiPlanning.projects.${projectIndex}.enabled`, event.target.checked)}
                />
                <span aria-hidden="true" />
                <b>{project.enabled !== false ? '已启用' : '已停用'}</b>
              </label>
              <button type="button" className="danger-icon-button" onClick={() => removeProject(projectIndex)} title="删除项目">
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          </header>

          <TextField
            label="飞书项目 ID"
            path={`aiPlanning.projects.${projectIndex}.projectId`}
            value={project.projectId}
            error={errors[`aiPlanning.projects.${projectIndex}.projectId`]}
            onChange={onChange}
            wide
          />

          <div className="root-list-heading">
            <strong>只读代码目录</strong>
            <button type="button" className="text-button" onClick={() => addRoot(projectIndex)}>
              <Plus size={15} aria-hidden="true" />
              <span>添加目录</span>
            </button>
          </div>
          {errors[`aiPlanning.projects.${projectIndex}.roots`] ? (
            <FieldError>{errors[`aiPlanning.projects.${projectIndex}.roots`]}</FieldError>
          ) : null}
          <div className="root-list">
            {(project.roots || []).map((root, rootIndex) => {
              const pathBase = `aiPlanning.projects.${projectIndex}.roots.${rootIndex}`;
              const activePicker = pickerKey === `${projectIndex}:${rootIndex}`;
              return (
                <div className="root-row" key={`${root.id}-${rootIndex}`}>
                  <TextField label="目录 ID" path={`${pathBase}.id`} value={root.id} error={errors[`${pathBase}.id`]} onChange={onChange} />
                  <div className="form-field root-path-field">
                    <label htmlFor={toFieldId(`${pathBase}.path`)}>绝对路径</label>
                    <div className={`input-with-action ${errors[`${pathBase}.path`] ? 'has-error' : ''}`}>
                      <input
                        id={toFieldId(`${pathBase}.path`)}
                        value={root.path}
                        onChange={(event) => onChange(`${pathBase}.path`, event.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => onChooseDirectory(projectIndex, rootIndex, root.path)}
                        disabled={activePicker}
                        title="选择目录"
                      >
                        {activePicker ? <LoaderCircle className="spinning" size={16} aria-hidden="true" /> : <FolderOpen size={16} aria-hidden="true" />}
                      </button>
                    </div>
                    {errors[`${pathBase}.path`] ? <FieldError>{errors[`${pathBase}.path`]}</FieldError> : null}
                  </div>
                  <SelectField
                    label="项目类型"
                    path={`${pathBase}.profile`}
                    value={root.profile}
                    error={errors[`${pathBase}.profile`]}
                    onChange={onChange}
                    options={[
                      ['auto', '自动识别'],
                      ['web', 'Web'],
                      ['unity', 'Unity'],
                      ['generic', '通用'],
                    ]}
                  />
                  <button type="button" className="danger-icon-button root-delete" onClick={() => removeRoot(projectIndex, rootIndex)} title="删除目录">
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

function AdvancedSection({ value, error, onChange }) {
  return (
    <ConfigPanel title="Bitable links" icon={Braces}>
      <div className="form-field json-field">
        <label htmlFor="bitable-links-json">JSON 数组</label>
        <textarea
          id="bitable-links-json"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck="false"
          aria-invalid={Boolean(error)}
        />
        {error ? <FieldError>{error}</FieldError> : null}
      </div>
      <InlineInfo icon={AlertTriangle}>
        该配置目前没有固定条目结构，保存时会校验必须为 JSON 数组，并完整保留每个条目。
      </InlineInfo>
    </ConfigPanel>
  );
}

function ResourceFields({ basePath, config, errors, onChange, includeView }) {
  return (
    <FieldGrid>
      <TextField label="App Token" path={`${basePath}.appToken`} value={getPathValue(config, `${basePath}.appToken`)} error={errors[`${basePath}.appToken`]} onChange={onChange} wide />
      <TextField label="Table ID" path={`${basePath}.tableId`} value={getPathValue(config, `${basePath}.tableId`)} error={errors[`${basePath}.tableId`]} onChange={onChange} />
      {includeView ? (
        <TextField label="View ID" path={`${basePath}.viewId`} value={getPathValue(config, `${basePath}.viewId`)} error={errors[`${basePath}.viewId`]} onChange={onChange} />
      ) : null}
    </FieldGrid>
  );
}

function FieldMappingPanel({ title, icon, basePath, fields, config, errors, onChange }) {
  return (
    <ConfigPanel title={title} icon={icon}>
      <FieldMappingGrid
        basePath={basePath}
        fields={fields}
        config={config}
        errors={errors}
        onChange={onChange}
      />
    </ConfigPanel>
  );
}

function FieldMappingGrid({ basePath, fields, config, errors, onChange }) {
  return (
    <div className="field-map-grid">
      {fields.map(([fieldId, label]) => {
        const fieldPath = `${basePath}.${fieldId}`;
        return (
          <TextField
            key={fieldPath}
            label={label}
            path={fieldPath}
            value={getPathValue(config, fieldPath)}
            error={errors[fieldPath]}
            onChange={onChange}
          />
        );
      })}
    </div>
  );
}

function ConfigPanel({ title, icon: Icon, children }) {
  return (
    <section className="config-panel">
      <header className="config-panel-header">
        <Icon size={18} aria-hidden="true" />
        <h2>{title}</h2>
      </header>
      <div className="config-panel-body">{children}</div>
    </section>
  );
}

function FieldGrid({ children }) {
  return <div className="field-grid">{children}</div>;
}

function TextField({
  label,
  path,
  value,
  error,
  onChange,
  type = 'text',
  wide = false,
  list,
}) {
  return (
    <div className={`form-field ${wide ? 'is-wide' : ''}`} data-field-path={path}>
      <label htmlFor={toFieldId(path)}>{label}</label>
      <input
        id={toFieldId(path)}
        type={type}
        value={value ?? ''}
        list={list}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(path, event.target.value)}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

function NumberField({ label, path, value, error, onChange, min, max }) {
  return (
    <div className="form-field" data-field-path={path}>
      <label htmlFor={toFieldId(path)}>{label}</label>
      <input
        id={toFieldId(path)}
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step="1"
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(path, event.target.value === '' ? '' : Number(event.target.value))}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

function SelectField({ label, path, value, error, onChange, options }) {
  return (
    <div className="form-field" data-field-path={path}>
      <label htmlFor={toFieldId(path)}>{label}</label>
      <select
        id={toFieldId(path)}
        value={value ?? ''}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(path, event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

function SecretField({ label, path, configured, change, error, onChange, wide }) {
  const [visible, setVisible] = useState(false);
  const action = change?.action || 'keep';
  const value = change?.value || '';
  const stateLabel = action === 'replace'
    ? '将替换现有值'
    : action === 'clear'
      ? '保存后清空'
      : configured
        ? '已配置，留空保持不变'
        : '尚未配置';

  return (
    <div className={`form-field secret-field ${wide ? 'is-wide' : ''}`} data-field-path={path}>
      <label htmlFor={toFieldId(path)}>{label}</label>
      <div className="input-with-action">
        <input
          id={toFieldId(path)}
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={configured && action === 'keep' ? '已安全保存' : ''}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(path, {
            action: event.target.value ? 'replace' : configured ? 'keep' : 'clear',
            value: event.target.value,
          })}
        />
        <button type="button" onClick={() => setVisible((current) => !current)} title={visible ? '隐藏输入' : '显示输入'}>
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      <div className="secret-meta">
        <span className={`secret-state is-${action}`}>{stateLabel}</span>
        {configured && action !== 'clear' ? (
          <button type="button" onClick={() => onChange(path, { action: 'clear', value: '' })}>清空</button>
        ) : null}
        {action !== 'keep' && configured ? (
          <button type="button" onClick={() => onChange(path, { action: 'keep', value: '' })}>恢复保留</button>
        ) : null}
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

function ToggleField({ label, description, checked, onChange }) {
  return (
    <div className="toggle-field">
      <div>
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span aria-hidden="true" />
      </label>
    </div>
  );
}

function StringListField({ label, path, values, error, onChange }) {
  const [input, setInput] = useState('');
  const items = Array.isArray(values) ? values : [];

  function addValues(rawValue) {
    const nextValues = String(rawValue || '')
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (nextValues.length === 0) {
      return;
    }
    onChange(path, [...new Set([...items, ...nextValues])]);
    setInput('');
  }

  return (
    <div className="form-field list-field" data-field-path={path}>
      <label htmlFor={toFieldId(path)}>{label}</label>
      <div className={`tag-editor ${error ? 'has-error' : ''}`}>
        <div className="tag-list">
          {items.map((item) => (
            <span className="config-tag" key={item}>
              <span>{item}</span>
              <button
                type="button"
                onClick={() => onChange(path, items.filter((current) => current !== item))}
                aria-label={`删除 ${item}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
        <input
          id={toFieldId(path)}
          value={input}
          placeholder="输入后按 Enter"
          onChange={(event) => setInput(event.target.value)}
          onBlur={() => addValues(input)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              addValues(input);
            }
          }}
        />
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

function Notice({ type, title, children }) {
  const Icon = type === 'success' ? Check : AlertTriangle;
  return (
    <div className={`config-notice is-${type}`}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{children}</span>
      </div>
    </div>
  );
}

function InlineInfo({ icon: Icon, children }) {
  return (
    <div className="inline-info">
      <Icon size={16} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

function FieldError({ children }) {
  return <span className="field-error">{children}</span>;
}

function FullPageState({ icon: Icon, text, spinning }) {
  return (
    <main className="full-page-state">
      <Icon className={spinning ? 'spinning' : ''} size={28} aria-hidden="true" />
      <strong>{text}</strong>
    </main>
  );
}

function RecoveryScreen({ recovery, status, message, onRecover, onRetry, onClose }) {
  const saving = status === 'saving';
  return (
    <main className="recovery-screen">
      <section className="recovery-panel">
        <span className="recovery-icon"><AlertTriangle size={28} aria-hidden="true" /></span>
        <h1>无法读取运行配置</h1>
        <p>{recovery.message || 'config.json 不可用'}</p>
        {message ? <div className="recovery-message">{message}</div> : null}
        <div className="recovery-actions">
          {recovery.backupAvailable ? (
            <button type="button" className="primary-button" onClick={() => onRecover('backup')} disabled={saving}>
              <RotateCcw size={17} aria-hidden="true" />
              <span>恢复上次备份</span>
            </button>
          ) : null}
          {recovery.exampleAvailable ? (
            <button type="button" className="secondary-button" onClick={() => onRecover('example')} disabled={saving}>
              <FileCog size={17} aria-hidden="true" />
              <span>使用示例配置</span>
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={onRetry} disabled={saving}>重新读取</button>
          <button type="button" className="text-button" onClick={onClose} disabled={saving}>退出</button>
        </div>
      </section>
    </main>
  );
}

function createDefaultSecretChanges() {
  return Object.fromEntries(SECRET_PATHS.map((fieldPath) => [
    fieldPath,
    { action: 'keep', value: '' },
  ]));
}

function getPathValue(value, fieldPath) {
  return fieldPath.split('.').reduce((current, segment) => {
    if (Array.isArray(current)) {
      return current[Number(segment)];
    }
    return current?.[segment];
  }, value);
}

function setPathValue(value, fieldPath, nextValue) {
  const clone = structuredClone(value);
  const segments = fieldPath.split('.');
  let current = clone;
  segments.forEach((segment, index) => {
    const key = Array.isArray(current) ? Number(segment) : segment;
    if (index === segments.length - 1) {
      current[key] = nextValue;
      return;
    }
    current = current[key];
  });
  return clone;
}

function buildMessageMap(items) {
  return Object.fromEntries((items || []).map((item) => [item.path, item.message]));
}

function areRelatedFieldPaths(leftPath = '', rightPath = '') {
  return (
    leftPath === rightPath
    || leftPath.startsWith(`${rightPath}.`)
    || rightPath.startsWith(`${leftPath}.`)
  );
}

function getSectionForPath(fieldPath = '') {
  if (fieldPath.startsWith('server.') || fieldPath.startsWith('webApp.') || fieldPath.startsWith('updates.') || fieldPath.startsWith('debug.')) {
    return 'server';
  }
  if (fieldPath.startsWith('feishu.')) {
    return 'feishu';
  }
  if (fieldPath.startsWith('knowledgeBase.')) {
    return 'knowledge';
  }
  if (fieldPath === 'bitable.links') {
    return 'advanced';
  }
  if (fieldPath.startsWith('bitable.')) {
    return 'bitable';
  }
  if (fieldPath.startsWith('dashboard.')) {
    return 'dashboard';
  }
  if (fieldPath.startsWith('aiPlanning.')) {
    return 'ai';
  }
  return '';
}

function focusFirstError(error) {
  const section = getSectionForPath(error?.path);
  if (section) {
    document.querySelector(`[data-field-path="${CSS.escape(error.path)}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }
}

function toFieldId(fieldPath) {
  return `field-${fieldPath.replaceAll('.', '-')}`;
}

async function requestApi(endpoint, options = {}) {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Config-Editor-Token': token,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || `请求失败：${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('找不到配置编辑器根节点');
}

createRoot(root).render(
  <React.StrictMode>
    <ConfigEditorApp />
  </React.StrictMode>,
);
