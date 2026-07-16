import { useEffect, useRef, useState } from 'react';
import {
  DEADLINE_FILTER_OPTIONS,
  compareWorkItemStatus,
  createEmptyWorkItemFilters,
  filterWorkItems,
  getWorkItemPersonKey,
  getWorkItemProcessingStatus,
  getWorkItemStatus,
  getWorkItemWaitingStatus,
  hasActiveWorkItemFilters,
  isStatusGroupDefaultCollapsed,
  shouldShowWorkItemRemainingTime,
} from './workItemListUtils.js';

const INITIAL_AUTH_STATE = {
  status: 'loading',
  message: '正在连接飞书',
  user: null,
};

const INITIAL_PROJECT_STATE = {
  status: 'loading',
  message: '',
  projects: [],
};

const INITIAL_REQUIREMENTS_STATE = {
  status: 'idle',
  message: '',
  result: null,
};

const FEISHU_H5_SDK_URL = 'https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js';
const FEISHU_USER_SCOPES = [];

const PROJECT_TOOLS = [
  { id: 'overview', label: '项目总览' },
  { id: 'requirements', label: '需求列表' },
  { id: 'bugs', label: 'Bug列表' },
  { id: 'builds', label: '打包列表' },
  { id: 'review', label: '内容审查' },
];

const WORK_ITEM_TOOL_CONFIGS = {
  requirements: {
    toolId: 'requirements',
    routeSegment: 'requirements',
    listLabel: '需求列表',
    itemLabel: '需求',
    submitLabel: '提交需求',
    countLabel: '项需求',
    unnamedTitle: '未命名需求',
    noIdText: '无需求ID',
    loadingText: '正在准备需求列表',
    idleText: '点击需求列表后会准备项目对应的多维表格。',
    missingTargetText: '目标需求不存在或没有权限查看',
    detailAriaLabel: '需求详情',
  },
  bugs: {
    toolId: 'bugs',
    routeSegment: 'bugs',
    listLabel: 'Bug列表',
    itemLabel: 'Bug',
    submitLabel: '提交Bug',
    countLabel: '个Bug',
    unnamedTitle: '未命名Bug',
    noIdText: '无BugID',
    loadingText: '正在准备Bug列表',
    idleText: '点击Bug列表后会准备项目对应的多维表格。',
    missingTargetText: '目标Bug不存在或没有权限查看',
    detailAriaLabel: 'Bug详情',
  },
};

const REQUIREMENT_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'];

export function App() {
  const [authState, setAuthState] = useState(INITIAL_AUTH_STATE);

  useEffect(() => {
    let isActive = true;

    async function runLogin() {
      try {
        if (shouldUseDebugUser()) {
          const user = await createDebugSession();
          if (isActive) {
            setAuthState({
              status: 'ready',
              message: '',
              user,
            });
          }
          return;
        }

        if (shouldHoldLoadingForDebug()) {
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
            setAuthState({
              status: 'error',
              message: feishuRuntime.message,
              user: null,
            });
          }
          return;
        }

        const config = await fetchAppConfig();
        if (!config.configured || !config.appId) {
          if (isActive) {
            setAuthState({
              status: 'error',
              message: '缺少飞书应用配置',
              user: null,
            });
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
          setAuthState({
            status: 'error',
            message: formatErrorMessage(error),
            user: null,
          });
        }
      }
    }

    runLogin();

    return () => {
      isActive = false;
    };
  }, []);

  return (
    <main className="app-shell" aria-label="开发平台">
      <TopToolbar state={authState} />
      {authState.status === 'ready' && authState.user ? (
        <PlatformWorkspace user={authState.user} />
      ) : (
        <AuthStatusPanel state={authState} />
      )}
    </main>
  );
}

function TopToolbar({ state }) {
  return (
    <header className="top-toolbar" aria-label="顶部工具栏">
      <div className="toolbar-title">开发平台</div>
      <div className="toolbar-user" aria-label="当前飞书用户">
        {state.status === 'ready' && state.user ? (
          <>
            <Avatar user={state.user} />
            <span className="user-name" title={state.user.name}>
              {state.user.name}
            </span>
          </>
        ) : (
          <span className="toolbar-user-placeholder">未登录</span>
        )}
      </div>
    </header>
  );
}

function PlatformWorkspace({ user }) {
  const [activeView, setActiveView] = useState('home');
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectState, setProjectState] = useState(INITIAL_PROJECT_STATE);
  const [directTarget] = useState(() => parseDirectTargetFromLocation());
  const [directNotice, setDirectNotice] = useState({ type: 'idle', message: '' });
  const processedDirectKeyRef = useRef('');

  useEffect(() => {
    let isActive = true;

    async function loadProjects() {
      try {
        const payload = await fetchProjects();
        if (isActive) {
          setProjectState({
            status: 'ready',
            message: '',
            projects: Array.isArray(payload.projects) ? payload.projects : [],
          });
        }
      } catch (error) {
        if (isActive) {
          setProjectState({
            status: 'error',
            message: formatErrorMessage(error),
            projects: [],
          });
        }
      }
    }

    loadProjects();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!directTarget || processedDirectKeyRef.current === directTarget.key || projectState.status !== 'ready') {
      return;
    }

    processedDirectKeyRef.current = directTarget.key;

    if (directTarget.type === 'home') {
      setActiveView('home');
      setSelectedProject(null);
      return;
    }

    if (!directTarget.projectId) {
      setDirectNotice({ type: 'error', message: '直达链接缺少项目ID' });
      return;
    }

    const targetProject = projectState.projects.find((project) => String(project.projectId || '') === directTarget.projectId);
    if (!targetProject) {
      setDirectNotice({ type: 'error', message: '没有权限查看该项目，或项目不存在' });
      return;
    }

    setSelectedProject(targetProject);
    setActiveView('project');
    setDirectNotice({ type: 'loading', message: '正在打开目标位置' });
  }, [directTarget, projectState]);

  function handleHomeClick() {
    setActiveView('home');
    setSelectedProject(null);
    setDirectNotice({ type: 'idle', message: '' });
  }

  function handleProjectSelect(project) {
    setSelectedProject(project);
    setActiveView('project');
    setDirectNotice({ type: 'idle', message: '' });
  }

  return (
    <section className="platform-body" aria-label="开发平台工作区">
      <ProjectSidebar
        projectState={projectState}
        activeView={activeView}
        selectedProjectId={selectedProject?.recordId || ''}
        onHomeClick={handleHomeClick}
        onProjectSelect={handleProjectSelect}
      />
      <div className="platform-main-content">
        {directNotice.message ? <DirectStatusBanner notice={directNotice} /> : null}
        {activeView === 'project' && selectedProject ? (
          <ProjectWorkspace
            project={selectedProject}
            user={user}
            directTarget={directTarget}
            onDirectNotice={setDirectNotice}
          />
        ) : (
          <HomePanel user={user} />
        )}
      </div>
    </section>
  );
}

function ProjectSidebar({ projectState, activeView, selectedProjectId, onHomeClick, onProjectSelect }) {
  return (
    <aside className="project-sidebar" aria-label="项目列表">
      <nav className="sidebar-navigation" aria-label="主要导航">
        <button
          type="button"
          className={`home-button ${activeView === 'home' ? 'is-active' : ''}`}
          onClick={onHomeClick}
        >
          <HomeIcon />
          <span>首页</span>
        </button>
      </nav>

      <section className="project-list-section" aria-label="项目基础信息">
        <div className="project-list-heading">项目列表</div>
        <ProjectList state={projectState} selectedProjectId={selectedProjectId} onProjectSelect={onProjectSelect} />
      </section>

      <div className="add-project-area">
        <button type="button" className="add-project-button" aria-label="添加项目">
          <PlusIcon />
          <span>添加项目</span>
        </button>
      </div>
    </aside>
  );
}

function DirectStatusBanner({ notice }) {
  return (
    <div className={`direct-status direct-status-${notice.type}`} role="status" aria-live="polite">
      {notice.message}
    </div>
  );
}

function ProjectList({ state, selectedProjectId, onProjectSelect }) {
  if (state.status === 'loading') {
    return (
      <div className="project-list-status" aria-live="polite">
        正在加载项目
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="project-list-status project-list-error" aria-live="polite">
        {state.message}
      </div>
    );
  }

  if (state.projects.length === 0) {
    return <div className="project-list-status">暂无项目</div>;
  }

  return (
    <div className="project-list" role="list">
      {state.projects.map((project) => (
        <button
          key={project.recordId}
          type="button"
          className={`project-button ${selectedProjectId === project.recordId ? 'is-active' : ''}`}
          title={formatProjectTitle(project)}
          aria-pressed={selectedProjectId === project.recordId}
          onClick={() => onProjectSelect(project)}
        >
          <ProjectIcon project={project} />
          <span className="project-button-text">
            <span className="project-name">{project.projectName || '未命名项目'}</span>
            <span className="project-id">({project.projectId || '无ID'})</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function ProjectWorkspace({ project, user, directTarget, onDirectNotice }) {
  const [activeToolId, setActiveToolId] = useState(PROJECT_TOOLS[0].id);
  const [workItemStates, setWorkItemStates] = useState(() => createInitialWorkItemStates());
  const [collapsedPriorities, setCollapsedPriorities] = useState(() => new Set());
  const [statusCollapseOverrides, setStatusCollapseOverrides] = useState({});
  const [workItemFilters, setWorkItemFilters] = useState(() => createInitialWorkItemFilters());
  const [selectedWorkItemId, setSelectedWorkItemId] = useState('');
  const [highlightCommentId, setHighlightCommentId] = useState('');
  const processedDirectKeyRef = useRef('');
  const visibleTools = getProjectTools(project);
  const activeTool = visibleTools.find((tool) => tool.id === activeToolId) || visibleTools[0];
  const activeWorkItemConfig = getWorkItemToolConfig(activeToolId);
  const activeWorkItemState = activeWorkItemConfig ? workItemStates[activeWorkItemConfig.toolId] || INITIAL_REQUIREMENTS_STATE : INITIAL_REQUIREMENTS_STATE;
  const projectName = project.projectName || '未命名项目';
  const mentionableUsersByTool = project.mentionableUsersByTool && typeof project.mentionableUsersByTool === 'object'
    ? project.mentionableUsersByTool
    : {};

  useEffect(() => {
    setActiveToolId(getProjectTools(project)[0].id);
    setWorkItemStates(createInitialWorkItemStates());
    setCollapsedPriorities(new Set());
    setStatusCollapseOverrides({});
    setWorkItemFilters(createInitialWorkItemFilters());
    setSelectedWorkItemId('');
    setHighlightCommentId('');
    processedDirectKeyRef.current = '';
  }, [project.recordId]);

  useEffect(() => {
    if (!directTarget || directTarget.projectId !== String(project.projectId || '') || processedDirectKeyRef.current === directTarget.key) {
      return;
    }

    processedDirectKeyRef.current = directTarget.key;
    openDirectTarget(directTarget);
  }, [directTarget, project.recordId]);

  function handleWorkItemGroupToggle(toolId, priority) {
    const groupId = `${toolId}:${priority}`;
    setCollapsedPriorities((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function handleWorkItemStatusToggle(groupId, isCollapsed) {
    setStatusCollapseOverrides((current) => ({
      ...current,
      [groupId]: !isCollapsed,
    }));
  }

  async function handleToolClick(toolId) {
    if (!visibleTools.some((tool) => tool.id === toolId)) {
      return;
    }

    setActiveToolId(toolId);
    setHighlightCommentId('');
    onDirectNotice?.({ type: 'idle', message: '' });

    const toolConfig = getWorkItemToolConfig(toolId);
    if (!toolConfig) {
      setSelectedWorkItemId('');
      return;
    }

    await loadWorkItems(toolConfig);
  }

  async function openDirectTarget(target) {
    const toolId = target.toolId || getDefaultDirectToolId(target.type);
    if (!visibleTools.some((tool) => tool.id === toolId)) {
      onDirectNotice?.({ type: 'error', message: '没有权限使用该功能' });
      return;
    }

    setActiveToolId(toolId);

    const toolConfig = getWorkItemToolConfig(toolId);
    if (!toolConfig) {
      setSelectedWorkItemId('');
      setHighlightCommentId('');
      onDirectNotice?.({ type: 'idle', message: '' });
      return;
    }

    await loadWorkItems(toolConfig, {
      recordId: target.recordId,
      commentId: target.commentId,
      fromDirect: true,
    });
  }

  async function loadWorkItems(toolConfig, options = {}) {
    const targetRecordId = String(options.recordId || '').trim();
    const targetCommentId = String(options.commentId || '').trim();
    setSelectedWorkItemId('');
    setHighlightCommentId('');
    setWorkItemState(toolConfig.toolId, {
      status: 'loading',
      message: toolConfig.loadingText,
      result: null,
    });

    try {
      const payload = await ensureProjectWorkItems(project.projectId, toolConfig);
      const items = getPayloadWorkItems(payload, toolConfig);
      const targetItem = targetRecordId
        ? items.find((item) => isRequirementTarget(item, targetRecordId))
        : null;
      setWorkItemState(toolConfig.toolId, {
        status: 'ready',
        message: buildWorkItemsReadyMessage(payload, toolConfig),
        result: payload,
      });

      if (targetRecordId) {
        if (!targetItem) {
          onDirectNotice?.({ type: 'error', message: toolConfig.missingTargetText });
          return;
        }

        setSelectedWorkItemId(getRequirementStableId(targetItem));
        setHighlightCommentId(targetCommentId);
        onDirectNotice?.({ type: 'idle', message: '' });
        return;
      }

      onDirectNotice?.({ type: 'idle', message: '' });
    } catch (error) {
      setWorkItemState(toolConfig.toolId, {
        status: 'error',
        message: formatErrorMessage(error),
        result: error.payload?.result || null,
      });
      if (options.fromDirect) {
        onDirectNotice?.({ type: 'error', message: formatErrorMessage(error) });
      }
    }
  }

  function setWorkItemState(toolId, state) {
    setWorkItemStates((current) => ({
      ...current,
      [toolId]: state,
    }));
  }

  return (
    <section className="workspace-content workspace-content-project" aria-label={`${projectName}项目内容`}>
      <div className="project-workspace">
        <aside className="project-tool-sidebar" aria-label="项目工具栏">
          <div className="project-tool-header">
            <ProjectIcon project={project} />
            <div className="project-tool-title-group">
              <span className="project-tool-title" title={projectName}>
                {projectName}
              </span>
              <span className="project-tool-id">({project.projectId || '无ID'})</span>
            </div>
          </div>

          <nav className="project-tool-nav" aria-label="项目功能">
            {visibleTools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={`project-tool-button ${activeToolId === tool.id ? 'is-active' : ''}`}
                aria-pressed={activeToolId === tool.id}
                onClick={() => handleToolClick(tool.id)}
              >
                <span className="project-tool-label">{tool.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="project-detail-panel" aria-label={`${activeTool.label}内容`}>
          <div className={`project-detail-surface ${activeWorkItemConfig ? 'project-detail-surface-requirements' : ''}`}>
            {activeWorkItemConfig ? null : (
              <>
                <p className="project-detail-eyebrow">{activeTool.label}</p>
                <h1>{projectName}</h1>
                <p className="project-detail-summary">当前项目 {formatProjectTitle(project)}</p>
              </>
            )}
            {activeWorkItemConfig ? (
      <RequirementsStatus
                toolConfig={activeWorkItemConfig}
                state={activeWorkItemState}
                user={user}
                collapsedPriorities={collapsedPriorities}
                statusCollapseOverrides={statusCollapseOverrides}
                onGroupToggle={handleWorkItemGroupToggle}
                onStatusToggle={handleWorkItemStatusToggle}
                filters={workItemFilters[activeWorkItemConfig.toolId] || createEmptyWorkItemFilters()}
                onFiltersChange={(filters) => {
                  setWorkItemFilters((current) => ({
                    ...current,
                    [activeWorkItemConfig.toolId]: filters,
                  }));
                }}
                selectedRequirementId={selectedWorkItemId}
                highlightCommentId={highlightCommentId}
                onRequirementSelect={(requirement) => {
                  setHighlightCommentId('');
                  setSelectedWorkItemId(getRequirementStableId(requirement));
                }}
                onRequirementBack={() => {
                  setHighlightCommentId('');
                  setSelectedWorkItemId('');
                }}
                projectId={project.projectId}
                mentionableUsers={mentionableUsersByTool[activeWorkItemConfig.toolId] || activeWorkItemState.result?.mentionableUsers || []}
                isSuperAdmin={Boolean(project.isSuperAdmin)}
                onWorkItemCreated={(payload) => {
                  const createdItem = payload.item || payload.requirement;
                  setWorkItemStates((current) => ({
                    ...current,
                    [activeWorkItemConfig.toolId]: mergeCreatedWorkItemsIntoState(current[activeWorkItemConfig.toolId], payload, activeWorkItemConfig),
                  }));
                  if (createdItem) {
                    setSelectedWorkItemId(getRequirementStableId(createdItem));
                  }
                  if (payload.submitNotice?.message) {
                    onDirectNotice?.(payload.submitNotice);
                    return;
                  }

                  const notificationCount = (payload.notificationResults || []).filter((item) => item.ok).length;
                  if (notificationCount > 0) {
                    onDirectNotice?.({
                      type: 'success',
                      message: `${activeWorkItemConfig.itemLabel}已提交，已通知 ${notificationCount} 个处理人`,
                    });
                  }
                }}
                onRequirementUpdated={(requirement) => {
                  setWorkItemStates((current) => ({
                    ...current,
                    [activeWorkItemConfig.toolId]: updateRequirementInState(current[activeWorkItemConfig.toolId], requirement, activeWorkItemConfig),
                  }));
                  setSelectedWorkItemId(getRequirementStableId(requirement));
                }}
                onRequirementDeleted={(payload) => {
                  setWorkItemStates((current) => ({
                    ...current,
                    [activeWorkItemConfig.toolId]: mergeCreatedWorkItemsIntoState(current[activeWorkItemConfig.toolId], payload, activeWorkItemConfig),
                  }));
                  setHighlightCommentId('');
                  setSelectedWorkItemId('');
                }}
              />
            ) : null}
          </div>
        </section>
      </div>
    </section>
  );
}

function RequirementsStatus({
  toolConfig,
  state,
  user,
  collapsedPriorities,
  statusCollapseOverrides,
  onGroupToggle,
  onStatusToggle,
  filters,
  onFiltersChange,
  selectedRequirementId,
  highlightCommentId,
  onRequirementSelect,
  onRequirementBack,
  projectId,
  mentionableUsers,
  isSuperAdmin,
  onWorkItemCreated,
  onRequirementUpdated,
  onRequirementDeleted,
}) {
  const [submitOpen, setSubmitOpen] = useState(false);

  if (state.status === 'idle') {
    return <p className="requirements-status">{toolConfig.idleText}</p>;
  }

  if (state.status === 'loading') {
    return (
      <p className="requirements-status requirements-status-loading" aria-live="polite">
        {state.message}
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="requirements-status requirements-status-error" aria-live="polite">
        <p>{state.message}</p>
        {state.result?.nodeName ? <span>节点：{state.result.nodeName}</span> : null}
      </div>
    );
  }

  const requirements = getPayloadWorkItems(state.result, toolConfig);
  const filteredRequirements = filterWorkItems(requirements, filters);
  const filtersActive = hasActiveWorkItemFilters(filters);
  const fields = Array.isArray(state.result?.fields) ? state.result.fields : [];
  const selectedRequirement = requirements.find((requirement) => isRequirementTarget(requirement, selectedRequirementId)) || null;

  if (selectedRequirement) {
    return (
      <BitableRecordDetail
        toolConfig={toolConfig}
        record={selectedRequirement}
        fields={fields}
        user={user}
        projectId={projectId}
        mentionableUsers={mentionableUsers}
        commentsFieldName={state.result?.commentsFieldName || '留言'}
        statusChangeLogFieldName={state.result?.statusChangeLogFieldName || '处理状态变动记录'}
        highlightCommentId={highlightCommentId}
        statusOptions={state.result?.statusOptions || []}
        editableFields={state.result?.editableFields || []}
        onRequirementUpdated={onRequirementUpdated}
        onRequirementDeleted={onRequirementDeleted}
        canDelete={isSuperAdmin}
        isSuperAdmin={isSuperAdmin}
        onBack={onRequirementBack}
      />
    );
  }

  return (
    <section className="requirements-board" aria-live="polite" aria-label={toolConfig.listLabel}>
      <div className="requirements-board-header">
        <div className="requirements-board-title">
          <h2>{toolConfig.listLabel}</h2>
          <span className="requirements-count">
            {filtersActive ? `${filteredRequirements.length} / ${requirements.length}` : requirements.length} {toolConfig.countLabel}
          </span>
        </div>
        <button type="button" className="workitem-submit-open" onClick={() => setSubmitOpen(true)}>
          {toolConfig.submitLabel}
        </button>
      </div>
      {submitOpen ? (
        <WorkItemSubmitDialog
          toolConfig={toolConfig}
          projectId={projectId}
          statusOptions={state.result?.statusOptions || []}
          priorityColors={state.result?.priorityColors || {}}
          mentionableUsers={mentionableUsers}
          onClose={() => setSubmitOpen(false)}
          onCreated={(payload) => {
            setSubmitOpen(false);
            onWorkItemCreated?.(payload);
          }}
        />
      ) : null}
      <WorkItemFilterBar
        toolConfig={toolConfig}
        requirements={requirements}
        statusOptions={state.result?.statusOptions || []}
        filters={filters}
        onChange={onFiltersChange}
      />
      <RelatedRequirementsSummary toolConfig={toolConfig} requirements={filteredRequirements} user={user} />
      <RequirementGroups
        toolConfig={toolConfig}
        requirements={filteredRequirements}
        priorityColors={state.result?.priorityColors || {}}
        user={user}
        collapsedPriorities={collapsedPriorities}
        statusCollapseOverrides={statusCollapseOverrides}
        onGroupToggle={onGroupToggle}
        onStatusToggle={onStatusToggle}
        onRequirementSelect={onRequirementSelect}
      />
    </section>
  );
}

function WorkItemFilterBar({ toolConfig, requirements, statusOptions, filters, onChange }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const statusNames = getAvailableWorkItemStatuses(toolConfig, requirements, statusOptions);
  const assignees = getWorkItemFilterPeople(requirements, 'assignees');
  const proposers = getWorkItemFilterPeople(requirements, 'proposers');
  const activeFilters = hasActiveWorkItemFilters(filters);
  const dateLabel = toolConfig.toolId === 'bugs' ? '发现时间' : '提出时间';

  useEffect(() => {
    setAdvancedOpen(false);
  }, [toolConfig.toolId]);

  function updateFilter(nextValues) {
    onChange?.({
      ...filters,
      ...nextValues,
    });
  }

  function toggleListFilter(key, value) {
    const currentValues = Array.isArray(filters?.[key]) ? filters[key] : [];
    updateFilter({
      [key]: currentValues.includes(value)
        ? currentValues.filter((item) => item !== value)
        : [...currentValues, value],
    });
  }

  return (
    <section className="workitem-filter-bar" aria-label={`${toolConfig.listLabel}搜索和筛选`}>
      <div className="workitem-filter-summary">
        <label className="workitem-search-field">
          <span className="sr-only">搜索{toolConfig.itemLabel}</span>
          <input
            className="allow-text-select"
            type="search"
            value={filters?.query || ''}
            placeholder={`搜索编号、标题或描述`}
            onChange={(event) => updateFilter({ query: event.target.value })}
          />
        </label>
        <button
          type="button"
          className={`workitem-filter-toggle ${advancedOpen ? 'is-active' : ''}`}
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((current) => !current)}
        >
          高级筛选
        </button>
        {activeFilters ? (
          <button
            type="button"
            className="workitem-filter-clear"
            title="清空搜索和筛选条件"
            aria-label="清空搜索和筛选条件"
            onClick={() => onChange?.(createEmptyWorkItemFilters())}
          >
            ×
          </button>
        ) : null}
      </div>
      {advancedOpen ? (
        <div className="workitem-filter-panel">
          <fieldset className="workitem-filter-group">
            <legend>处理状态</legend>
            <div className="workitem-filter-options">
              {statusNames.map((status) => (
                <label key={status} className="workitem-filter-option">
                  <input
                    type="checkbox"
                    checked={(filters?.statuses || []).includes(status)}
                    onChange={() => toggleListFilter('statuses', status)}
                  />
                  <span>{status}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="workitem-filter-group">
            <legend>优先级</legend>
            <div className="workitem-filter-options">
              {REQUIREMENT_PRIORITIES.map((priority) => (
                <label key={priority} className="workitem-filter-option">
                  <input
                    type="checkbox"
                    checked={(filters?.priorities || []).includes(priority)}
                    onChange={() => toggleListFilter('priorities', priority)}
                  />
                  <span>{priority}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="workitem-filter-group">
            <legend>处理人</legend>
            <div className="workitem-filter-options">
              {assignees.length > 0 ? assignees.map((person) => (
                <label key={person.key} className="workitem-filter-option">
                  <input
                    type="checkbox"
                    checked={(filters?.assigneeKeys || []).includes(person.key)}
                    onChange={() => toggleListFilter('assigneeKeys', person.key)}
                  />
                  <span>{person.name}</span>
                </label>
              )) : <span className="workitem-filter-empty">暂无处理人</span>}
            </div>
          </fieldset>
          <fieldset className="workitem-filter-group">
            <legend>提出人</legend>
            <div className="workitem-filter-options">
              {proposers.length > 0 ? proposers.map((person) => (
                <label key={person.key} className="workitem-filter-option">
                  <input
                    type="checkbox"
                    checked={(filters?.proposerKeys || []).includes(person.key)}
                    onChange={() => toggleListFilter('proposerKeys', person.key)}
                  />
                  <span>{person.name}</span>
                </label>
              )) : <span className="workitem-filter-empty">暂无提出人</span>}
            </div>
          </fieldset>
          <label className="workitem-filter-select">
            <span>时限状态</span>
            <select
              className="allow-text-select"
              value={filters?.deadline || 'all'}
              onChange={(event) => updateFilter({ deadline: event.target.value })}
            >
              {DEADLINE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className="workitem-filter-date-range">
            <label className="workitem-filter-select">
              <span>{dateLabel}开始</span>
              <input
                className="allow-text-select"
                type="date"
                value={filters?.dateFrom || ''}
                onChange={(event) => updateFilter({ dateFrom: event.target.value })}
              />
            </label>
            <label className="workitem-filter-select">
              <span>{dateLabel}结束</span>
              <input
                className="allow-text-select"
                type="date"
                value={filters?.dateTo || ''}
                onChange={(event) => updateFilter({ dateTo: event.target.value })}
              />
            </label>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RelatedRequirementsSummary({ toolConfig, requirements, user }) {
  const mine = requirements.filter((requirement) => isRequirementRelatedToUser(requirement, user));
  const pendingStatus = getWorkItemWaitingStatus(toolConfig.toolId);
  const processingStatus = getWorkItemProcessingStatus(toolConfig.toolId);
  const pendingCount = mine.filter((requirement) => getWorkItemStatus(requirement) === pendingStatus).length;
  const processingCount = mine.filter((requirement) => getWorkItemStatus(requirement) === processingStatus).length;
  const almostOverdueCount = mine.filter((requirement) => {
    const days = Number(requirement.remainingDays);
    return getWorkItemStatus(requirement) === pendingStatus && Number.isFinite(days) && days >= 0 && days < 1;
  }).length;

  return (
    <section className="related-summary" aria-label="与我有关">
      <div className="related-summary-title">与我有关</div>
      <div className="related-summary-items">
        <RelatedSummaryItem label={pendingStatus} value={pendingCount} tone="pending" />
        <RelatedSummaryItem label={processingStatus} value={processingCount} tone="processing" />
        <RelatedSummaryItem label="快逾期" value={almostOverdueCount} tone="urgent" />
      </div>
    </section>
  );
}

function WorkItemSubmitDialog({ toolConfig, projectId, statusOptions, priorityColors, mentionableUsers, onClose, onCreated }) {
  const dialogRef = useRef(null);
  const priorityOptions = REQUIREMENT_PRIORITIES.map((priority) => ({
    name: priority,
    color: priorityColors?.[priority] || '',
  }));
  const defaultPriority = priorityOptions.some((option) => option.name === 'P2') ? 'P2' : priorityOptions[0]?.name || 'P2';
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(defaultPriority);
  const [assignees, setAssignees] = useState([]);
  const [expectedDays, setExpectedDays] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const mentionCandidates = normalizeMentionCandidates(mentionableUsers);
  const statusPreview = normalizeRequirementStatusOptionsForClient(statusOptions)[0]?.name || '自动使用第一个状态';

  function addAttachments(files) {
    const nextFiles = Array.from(files || []).filter((file) => isPasteSupportedAttachment(file));
    if (nextFiles.length === 0) {
      return;
    }

    setAttachments((current) => mergeAttachmentFiles(current, nextFiles));
  }

  function handleAttachmentPaste(event) {
    if (status.type === 'loading') {
      return;
    }

    const supportedFiles = extractSupportedAttachmentsFromClipboard(event.clipboardData);
    if (supportedFiles.length === 0) {
      setStatus({ type: 'error', message: '剪贴板中没有可粘贴的图片或视频' });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    addAttachments(supportedFiles);
    setStatus({ type: 'idle', message: '' });
  }

  function removeAttachment(index) {
    setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  useEffect(() => {
    setAssignees((current) => filterSelectedMentionedUsers(current, mentionCandidates));
  }, [mentionableUsers]);

  useEffect(() => {
    function handleDocumentPaste(event) {
      if (status.type === 'loading') {
        return;
      }

      const supportedFiles = extractSupportedAttachmentsFromClipboard(event.clipboardData);
      if (supportedFiles.length === 0 || !shouldHandleDialogAttachmentPaste(dialogRef.current, event.target)) {
        return;
      }

      event.preventDefault();
      addAttachments(supportedFiles);
      setStatus({ type: 'idle', message: '' });
    }

    document.addEventListener('paste', handleDocumentPaste);
    return () => document.removeEventListener('paste', handleDocumentPaste);
  }, [status.type]);

  async function handleSubmit(event) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedExpectedDays = String(expectedDays || '').trim();

    if (!trimmedTitle || status.type === 'loading') {
      setStatus({ type: 'error', message: `请填写${toolConfig.itemLabel}标题` });
      return;
    }

    const parsedExpectedDays = trimmedExpectedDays ? Number(trimmedExpectedDays) : null;
    if (trimmedExpectedDays && (!Number.isFinite(parsedExpectedDays) || parsedExpectedDays < 0)) {
      setStatus({ type: 'error', message: '期望时限必须是大于等于0的数字' });
      return;
    }

    setStatus({ type: 'loading', message: `正在提交${toolConfig.itemLabel}` });

    try {
      const payload = await createWorkItem(toolConfig, projectId, {
        title: trimmedTitle,
        description: trimmedDescription,
        priority,
        assignees,
        expectedDays: parsedExpectedDays,
        attachments,
      });
      const failedNotifications = (payload.notificationResults || []).filter((item) => !item.ok);
      if (failedNotifications.length > 0) {
        onCreated?.({
          ...payload,
          submitNotice: {
            type: 'warning',
            message: `${toolConfig.itemLabel}已提交，${failedNotifications.length} 个处理人通知发送失败`,
          },
        });
        return;
      }

      onCreated?.(payload);
    } catch (error) {
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  return (
    <div className="workitem-submit-backdrop" role="presentation">
      <section ref={dialogRef} className="workitem-submit-dialog" role="dialog" aria-modal="true" aria-label={toolConfig.submitLabel}>
        <div className="workitem-submit-header">
          <div>
            <h3>{toolConfig.submitLabel}</h3>
            <span>默认状态：{statusPreview}</span>
          </div>
          <button type="button" className="workitem-submit-close" disabled={status.type === 'loading'} onClick={onClose}>
            关闭
          </button>
        </div>

        <form className="workitem-submit-form" onSubmit={handleSubmit}>
          <label className="workitem-submit-field">
            <span>标题</span>
            <input
              className="allow-text-select"
              value={title}
              maxLength={200}
              disabled={status.type === 'loading'}
              placeholder={`输入${toolConfig.itemLabel}标题`}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="workitem-submit-field">
            <span>描述</span>
            <textarea
              className="allow-text-select"
              value={description}
              maxLength={5000}
              rows={5}
              disabled={status.type === 'loading'}
              placeholder={`输入${toolConfig.itemLabel}描述`}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <div className="workitem-submit-grid">
            <label className="workitem-submit-field">
              <span>优先级</span>
              <select className="allow-text-select" value={priority} disabled={status.type === 'loading'} onChange={(event) => setPriority(event.target.value)}>
                {priorityOptions.map((option) => (
                  <option key={option.name} value={option.name}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="workitem-submit-field">
              <span>期望时限（天）</span>
              <input
                className="allow-text-select"
                type="number"
                min="0"
                step="0.1"
                value={expectedDays}
                disabled={status.type === 'loading'}
                placeholder="可不填"
                onChange={(event) => setExpectedDays(event.target.value)}
              />
            </label>
          </div>

          <MentionUserMultiSelect
            selectedPeople={assignees}
            candidates={mentionCandidates}
            onChange={setAssignees}
            disabled={status.type === 'loading'}
            label="处理人员"
            emptyText="暂无可选处理人员"
            selectedLabel="已选择处理人员"
          />

          <div className="workitem-submit-field">
            <span>附件</span>
            <div
              className="workitem-attachment-dropzone allow-text-select"
              tabIndex={status.type === 'loading' ? -1 : 0}
              role="region"
              aria-label="附件粘贴区域"
              onPaste={handleAttachmentPaste}
            >
              <strong>粘贴图片或视频</strong>
              <small>点击这里后按 Ctrl+V，也可以继续选择文件</small>
              <input
                className="allow-text-select"
                type="file"
                multiple
                accept="image/*,video/*"
                disabled={status.type === 'loading'}
                onChange={(event) => {
                  addAttachments(event.target.files || []);
                  event.target.value = '';
                }}
              />
            </div>
          </div>
          {attachments.length > 0 ? (
            <div className="workitem-submit-attachments" aria-label="已选择附件">
              {attachments.map((file, index) => (
                <button
                  key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                  type="button"
                  disabled={status.type === 'loading'}
                  onClick={() => removeAttachment(index)}
                  title="点击移除附件"
                >
                  <span>{file.name}</span>
                  <small>{formatFileSize(file.size)}</small>
                </button>
              ))}
            </div>
          ) : null}

          <div className="workitem-submit-actions">
            <button type="button" className="workitem-submit-secondary" disabled={status.type === 'loading'} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="workitem-submit-primary" disabled={!title.trim() || status.type === 'loading'}>
              {status.type === 'loading' ? '提交中' : toolConfig.submitLabel}
            </button>
          </div>
          {status.message ? <p className={`record-comment-status record-comment-status-${status.type}`}>{status.message}</p> : null}
        </form>
      </section>
    </div>
  );
}

function WorkItemEditDialog({ toolConfig, projectId, record, fields, mentionableUsers, onClose, onSaved }) {
  const dialogRef = useRef(null);
  const rawFields = record?.rawFields && typeof record.rawFields === 'object' ? record.rawFields : {};
  const editableFields = (Array.isArray(fields) ? fields : []).filter((field) => field?.fieldName);
  const mentionCandidates = normalizeMentionCandidates(mentionableUsers);
  const [selectedFieldNames, setSelectedFieldNames] = useState([]);
  const [fieldValues, setFieldValues] = useState(() => buildEditableFieldInitialValues(editableFields, rawFields, projectId, toolConfig));
  const [notifyRelated, setNotifyRelated] = useState(false);
  const [notifyUsers, setNotifyUsers] = useState([]);
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const selectedFieldSet = new Set(selectedFieldNames);
  const selectedFields = editableFields.filter((field) => selectedFieldSet.has(field.fieldName));

  useEffect(() => {
    setNotifyUsers((current) => filterSelectedMentionedUsers(current, mentionCandidates));
  }, [mentionableUsers]);

  function toggleField(fieldName) {
    setSelectedFieldNames((current) => (
      current.includes(fieldName)
        ? current.filter((item) => item !== fieldName)
        : [...current, fieldName]
    ));
  }

  function setFieldValue(fieldName, value) {
    setFieldValues((current) => ({
      ...current,
      [fieldName]: value,
    }));
  }

  function setAttachmentValue(fieldName, updater) {
    setFieldValues((current) => ({
      ...current,
      [fieldName]: updater(current[fieldName] || { existing: [], newFiles: [] }),
    }));
  }

  function addAttachmentFiles(fieldName, files) {
    const nextFiles = Array.from(files || []);
    if (nextFiles.length === 0) {
      return;
    }

    setAttachmentValue(fieldName, (current) => ({
      ...current,
      newFiles: mergeAttachmentFiles(current.newFiles || [], nextFiles),
    }));
  }

  function handleAttachmentPaste(fieldName, event) {
    if (status.type === 'loading') {
      return;
    }

    const supportedFiles = extractSupportedAttachmentsFromClipboard(event.clipboardData);
    if (supportedFiles.length === 0) {
      setStatus({ type: 'error', message: '剪贴板中没有可粘贴的图片或视频' });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    addAttachmentFiles(fieldName, supportedFiles);
    setStatus({ type: 'idle', message: '' });
  }

  useEffect(() => {
    function handleDocumentPaste(event) {
      if (status.type === 'loading') {
        return;
      }

      const supportedFiles = extractSupportedAttachmentsFromClipboard(event.clipboardData);
      const attachmentField = getSelectedAttachmentPasteField(selectedFields, fieldValues);
      if (
        supportedFiles.length === 0 ||
        !attachmentField ||
        !shouldHandleDialogAttachmentPaste(dialogRef.current, event.target)
      ) {
        return;
      }

      event.preventDefault();
      addAttachmentFiles(attachmentField.fieldName, supportedFiles);
      setStatus({ type: 'idle', message: '' });
    }

    document.addEventListener('paste', handleDocumentPaste);
    return () => document.removeEventListener('paste', handleDocumentPaste);
  }, [selectedFields, fieldValues, status.type]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (selectedFields.length === 0 || status.type === 'loading') {
      setStatus({ type: 'error', message: '请选择要修改的字段' });
      return;
    }

    setStatus({ type: 'loading', message: `正在保存${toolConfig.itemLabel}` });
    try {
      const payload = await updateWorkItem(toolConfig, projectId, record.recordId, {
        selectedFields,
        fieldValues,
        notifyRelated,
        notifyUsers,
      });
      onSaved?.(payload);
    } catch (error) {
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  return (
    <div className="workitem-submit-backdrop" role="presentation">
      <section ref={dialogRef} className="workitem-edit-dialog" role="dialog" aria-modal="true" aria-label={`编辑${toolConfig.itemLabel}`}>
        <div className="workitem-submit-header">
          <div>
            <h3>编辑{toolConfig.itemLabel}</h3>
            <span>先勾选字段，再修改内容</span>
          </div>
          <button type="button" className="workitem-submit-close" disabled={status.type === 'loading'} onClick={onClose}>
            关闭
          </button>
        </div>

        <form className="workitem-edit-form" onSubmit={handleSubmit}>
          <div className="workitem-edit-layout">
            <aside className="workitem-edit-field-list" aria-label="可编辑字段">
              {editableFields.length === 0 ? <p>暂无可编辑字段</p> : null}
              {editableFields.map((field) => (
                <label key={field.fieldId || field.fieldName} className={`workitem-edit-field-toggle ${selectedFieldSet.has(field.fieldName) ? 'is-selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedFieldSet.has(field.fieldName)}
                    disabled={status.type === 'loading'}
                    onChange={() => toggleField(field.fieldName)}
                  />
                  <span>
                    <strong>{field.fieldName}</strong>
                    <small>{getEditableFieldTypeLabel(field)}</small>
                  </span>
                </label>
              ))}
            </aside>

            <div className="workitem-edit-fields">
              {selectedFields.length === 0 ? (
                <div className="workitem-edit-empty">请选择左侧字段</div>
              ) : null}
              {selectedFields.map((field) => (
                <EditableFieldControl
                  key={field.fieldId || field.fieldName}
                  field={field}
                  value={fieldValues[field.fieldName]}
                  disabled={status.type === 'loading'}
                  mentionCandidates={mentionCandidates}
                  projectId={projectId}
                  toolConfig={toolConfig}
                  onChange={(value) => setFieldValue(field.fieldName, value)}
                  onAttachmentChange={(updater) => setAttachmentValue(field.fieldName, updater)}
                  onAttachmentFiles={(files) => addAttachmentFiles(field.fieldName, files)}
                  onAttachmentPaste={(event) => handleAttachmentPaste(field.fieldName, event)}
                />
              ))}

              <div className="workitem-edit-notify">
                <label className="record-comment-notify">
                  <input
                    type="checkbox"
                    checked={notifyRelated}
                    disabled={status.type === 'loading'}
                    onChange={(event) => setNotifyRelated(event.target.checked)}
                  />
                  <span>是否通知相关人员</span>
                </label>
                {notifyRelated ? (
                  <MentionUserMultiSelect
                    selectedPeople={notifyUsers}
                    candidates={mentionCandidates}
                    onChange={setNotifyUsers}
                    disabled={status.type === 'loading'}
                    label="通知人员"
                    emptyText="暂无可通知人员"
                    selectedLabel="已选择通知人员"
                  />
                ) : null}
              </div>
            </div>
          </div>

          <div className="workitem-submit-actions">
            <button type="button" className="workitem-submit-secondary" disabled={status.type === 'loading'} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="workitem-submit-primary" disabled={selectedFields.length === 0 || status.type === 'loading'}>
              {status.type === 'loading' ? '保存中' : '保存'}
            </button>
          </div>
          {status.message ? <p className={`record-comment-status record-comment-status-${status.type}`}>{status.message}</p> : null}
        </form>
      </section>
    </div>
  );
}

function EditableFieldControl({
  field,
  value,
  disabled,
  mentionCandidates,
  projectId,
  toolConfig,
  onChange,
  onAttachmentChange,
  onAttachmentFiles,
  onAttachmentPaste,
}) {
  if (isAttachmentField(field, value)) {
    const attachmentValue = value || { existing: [], newFiles: [] };
    return (
      <div className="workitem-edit-control">
        <span>{field.fieldName}</span>
        {attachmentValue.existing?.length > 0 ? (
          <div className="workitem-edit-attachment-list" aria-label="已有附件">
            {attachmentValue.existing.map((attachment, index) => (
              <button
                key={`${attachment.fileToken || attachment.name}-${index}`}
                type="button"
                disabled={disabled}
                onClick={() => onAttachmentChange((current) => ({
                  ...current,
                  existing: (current.existing || []).filter((_, currentIndex) => currentIndex !== index),
                }))}
                title="点击移除已有附件"
              >
                <span>{attachment.name || '附件'}</span>
                <small>已有</small>
              </button>
            ))}
          </div>
        ) : null}
        <div
          className="workitem-attachment-dropzone allow-text-select"
          tabIndex={disabled ? -1 : 0}
          role="region"
          aria-label={`${field.fieldName}附件粘贴区域`}
          onPaste={onAttachmentPaste}
        >
          <strong>粘贴图片或视频</strong>
          <small>点击这里后按 Ctrl+V，也可以继续选择文件</small>
          <input
            className="allow-text-select"
            type="file"
            multiple
            disabled={disabled}
            onChange={(event) => {
              onAttachmentFiles(event.target.files || []);
              event.target.value = '';
            }}
          />
        </div>
        {attachmentValue.newFiles?.length > 0 ? (
          <div className="workitem-submit-attachments" aria-label="新增附件">
            {attachmentValue.newFiles.map((file, index) => (
              <button
                key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                type="button"
                disabled={disabled}
                onClick={() => onAttachmentChange((current) => ({
                  ...current,
                  newFiles: (current.newFiles || []).filter((_, currentIndex) => currentIndex !== index),
                }))}
                title="点击移除新增附件"
              >
                <span>{file.name}</span>
                <small>{formatFileSize(file.size)}</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (isUserField(field, value)) {
    return (
      <div className="workitem-edit-control">
        <MentionUserMultiSelect
          selectedPeople={Array.isArray(value) ? value : []}
          candidates={mentionCandidates}
          onChange={onChange}
          disabled={disabled}
          label={field.fieldName}
          emptyText="暂无可选人员"
          selectedLabel={`已选择${field.fieldName}`}
        />
      </div>
    );
  }

  if (isMultiSelectField(field)) {
    const selectedValues = new Set(Array.isArray(value) ? value : []);
    const options = getFieldSelectOptionNames(field);
    return (
      <label className="workitem-edit-control">
        <span>{field.fieldName}</span>
        <div className="workitem-edit-option-grid">
          {options.length === 0 ? <small>该字段没有可选项</small> : null}
          {options.map((option) => (
            <label key={option} className="workitem-edit-option">
              <input
                type="checkbox"
                checked={selectedValues.has(option)}
                disabled={disabled}
                onChange={(event) => {
                  const next = new Set(selectedValues);
                  if (event.target.checked) {
                    next.add(option);
                  } else {
                    next.delete(option);
                  }
                  onChange(Array.from(next));
                }}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      </label>
    );
  }

  if (isSelectField(field, value)) {
    return (
      <label className="workitem-edit-control">
        <span>{field.fieldName}</span>
        <select className="allow-text-select" value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">未填写</option>
          {getFieldSelectOptionNames(field).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }

  if (isCheckboxField(field)) {
    return (
      <label className="workitem-edit-check">
        <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.fieldName}</span>
      </label>
    );
  }

  if (isDateField(field)) {
    return (
      <label className="workitem-edit-control">
        <span>{field.fieldName}</span>
        <input className="allow-text-select" type="datetime-local" value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      </label>
    );
  }

  if (isNumberLikeEditableField(field)) {
    return (
      <label className="workitem-edit-control">
        <span>{field.fieldName}</span>
        <input className="allow-text-select" type="number" step="any" value={value ?? ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      </label>
    );
  }

  if (isUrlField(field, value)) {
    return (
      <label className="workitem-edit-control">
        <span>{field.fieldName}</span>
        <input className="allow-text-select" value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      </label>
    );
  }

  return (
    <label className="workitem-edit-control">
      <span>{field.fieldName}</span>
      <textarea className="allow-text-select" rows={4} value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function RelatedSummaryItem({ label, value, tone }) {
  return (
    <div className={`related-summary-item related-summary-item-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RequirementGroups({
  toolConfig,
  requirements,
  priorityColors,
  user,
  collapsedPriorities,
  statusCollapseOverrides,
  onGroupToggle,
  onStatusToggle,
  onRequirementSelect,
}) {
  const groupedRequirements = groupRequirementsByPriority(requirements);

  return (
    <div className="requirement-groups">
      {REQUIREMENT_PRIORITIES.map((priority) => {
        const items = groupedRequirements[priority] || [];
        const groupId = `${toolConfig.toolId}:${priority}`;
        const isCollapsed = collapsedPriorities.has(groupId);
        const color = priorityColors[priority] || '';
        const style = color
          ? {
              '--priority-color': color,
              '--priority-soft-color': buildSoftColor(color),
              '--priority-border-color': buildBorderColor(color),
            }
          : undefined;

        return (
          <section key={priority} className="requirement-group" aria-label={`${priority}${toolConfig.itemLabel}`} style={style}>
            <button
              type="button"
              className="requirement-group-header"
              aria-expanded={!isCollapsed}
              onClick={() => onGroupToggle(toolConfig.toolId, priority)}
            >
              <span className={`requirement-chevron ${isCollapsed ? 'is-collapsed' : ''}`} aria-hidden="true">
                ▾
              </span>
              <span className="requirement-priority">{priority}</span>
              <span className="requirement-group-count">{items.length}</span>
            </button>
            {isCollapsed ? null : (
              <div className="requirement-group-body">
                {items.length > 0 ? (
                  <RequirementStatusGroups
                    toolConfig={toolConfig}
                    priority={priority}
                    requirements={items}
                    user={user}
                    statusCollapseOverrides={statusCollapseOverrides}
                    onStatusToggle={onStatusToggle}
                    onRequirementSelect={onRequirementSelect}
                  />
                ) : (
                  <div className="requirement-empty">暂无{toolConfig.itemLabel}</div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RequirementStatusGroups({ toolConfig, priority, requirements, user, statusCollapseOverrides, onStatusToggle, onRequirementSelect }) {
  const groupedStatuses = groupRequirementsByStatus(requirements, toolConfig.toolId);

  return (
    <div className="requirement-status-groups">
      {groupedStatuses.map((group) => {
        const groupId = `${toolConfig.toolId}:${priority}:${group.status}`;
        const override = statusCollapseOverrides?.[groupId];
        const isCollapsed = typeof override === 'boolean'
          ? override
          : isStatusGroupDefaultCollapsed(toolConfig.toolId, group.status);

        return (
          <section key={groupId} className="requirement-status-group" aria-label={`${priority}${group.status}${toolConfig.itemLabel}`}>
            <button
              type="button"
              className="requirement-status-header"
              aria-expanded={!isCollapsed}
              onClick={() => onStatusToggle(groupId, isCollapsed)}
            >
              <span className={`requirement-status-chevron ${isCollapsed ? 'is-collapsed' : ''}`} aria-hidden="true">
                ▾
              </span>
              <span className="requirement-status-name">{group.status}</span>
              <span className="requirement-status-count">{group.items.length}</span>
            </button>
            {isCollapsed ? null : (
              <div className="requirement-status-body">
                {group.items.map((requirement) => (
                  <RequirementItem
                    key={requirement.recordId || requirement.requirementId || requirement.title}
                    toolConfig={toolConfig}
                    requirement={requirement}
                    user={user}
                    onSelect={onRequirementSelect}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RequirementItem({ toolConfig, requirement, user, onSelect }) {
  const assignees = Array.isArray(requirement.assignees) ? requirement.assignees : [];
  const itemId = getWorkItemDisplayId(requirement);

  return (
    <button
      type="button"
      className="requirement-item"
      aria-label={`查看${toolConfig.itemLabel} ${requirement.title || itemId || toolConfig.unnamedTitle}`}
      onClick={() => onSelect(requirement)}
    >
      <div className="requirement-main">
        <span className="requirement-title" title={requirement.title}>
          {requirement.title || toolConfig.unnamedTitle}
        </span>
        <span className="requirement-id" title={itemId || toolConfig.noIdText}>
          {itemId || toolConfig.noIdText}
        </span>
      </div>
      <p className="requirement-description" title={requirement.description || '暂无描述'}>
        {requirement.description || '暂无描述'}
      </p>
      <span className="requirement-state" title={requirement.requirementStatus || '未设置状态'}>
        {requirement.requirementStatus || '未设置状态'}
      </span>
      <AssigneeList assignees={assignees} user={user} />
      {shouldShowWorkItemRemainingTime(toolConfig.toolId, requirement) ? (
        <span className={`requirement-remaining ${Number(requirement.remainingDays) < 0 ? 'is-overdue' : ''}`}>
          {formatRemainingDays(requirement.remainingDays)}
        </span>
      ) : (
        <span className="requirement-remaining-placeholder" aria-hidden="true" />
      )}
    </button>
  );
}

function BitableRecordDetail({
  toolConfig,
  record,
  fields,
  user,
  projectId,
  mentionableUsers,
  commentsFieldName,
  statusChangeLogFieldName,
  highlightCommentId,
  statusOptions,
  editableFields,
  canDelete,
  isSuperAdmin,
  onRequirementUpdated,
  onRequirementDeleted,
  onBack,
}) {
  const rawFields = record?.rawFields && typeof record.rawFields === 'object' ? record.rawFields : {};
  const displayFields = buildDisplayFields(fields, rawFields, [commentsFieldName, statusChangeLogFieldName]);
  const showRemainingTime = shouldShowWorkItemRemainingTime(toolConfig.toolId, record);
  const canUpdateStatus = isRequirementRelatedToUser(record, user);
  const canChangeAssignees = Boolean(isSuperAdmin || canUpdateStatus);
  const canEditContent = Boolean(isSuperAdmin || isWorkItemSubmitter(record, user));
  const [deleteStatus, setDeleteStatus] = useState({ type: 'idle', message: '' });
  const [editOpen, setEditOpen] = useState(false);
  const [editStatus, setEditStatus] = useState({ type: 'idle', message: '' });
  const [activeAction, setActiveAction] = useState('comments');

  useEffect(() => {
    document.documentElement.classList.add('requirement-detail-scroll-lock');
    document.body.classList.add('requirement-detail-scroll-lock');

    return () => {
      document.documentElement.classList.remove('requirement-detail-scroll-lock');
      document.body.classList.remove('requirement-detail-scroll-lock');
    };
  }, []);

  useEffect(() => {
    setActiveAction(canUpdateStatus ? 'status' : canChangeAssignees ? 'assignees' : 'comments');
  }, [record.recordId, canUpdateStatus, canChangeAssignees]);

  async function handleDelete() {
    if (deleteStatus.type === 'loading') {
      return;
    }

    const confirmed = window.confirm(`确定删除当前${toolConfig.itemLabel}吗？删除后无法在开发平台内恢复。`);
    if (!confirmed) {
      return;
    }

    setDeleteStatus({ type: 'loading', message: `正在删除${toolConfig.itemLabel}` });
    try {
      const payload = await deleteWorkItem(toolConfig, projectId, record.recordId);
      setDeleteStatus({ type: 'success', message: `${toolConfig.itemLabel}已删除` });
      onRequirementDeleted?.(payload);
    } catch (error) {
      setDeleteStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  function handleEditSaved(payload) {
    const updatedItem = payload.item || payload.requirement;
    if (updatedItem) {
      onRequirementUpdated?.(updatedItem);
    }

    const failedNotifications = (payload.notificationResults || []).filter((item) => !item.ok);
    if (failedNotifications.length > 0) {
      setEditStatus({ type: 'warning', message: `${toolConfig.itemLabel}已保存，${failedNotifications.length} 个通知发送失败` });
    } else {
      setEditStatus({ type: 'success', message: `${toolConfig.itemLabel}已保存` });
    }
    setEditOpen(false);
  }

  return (
    <section className="bitable-detail" aria-label={toolConfig.detailAriaLabel}>
      <div className="bitable-detail-header">
        <button type="button" className="bitable-back-button" onClick={onBack}>
          返回
        </button>
        <div className="bitable-detail-title-group">
          <h2>{record.title || toolConfig.unnamedTitle}</h2>
          <span>{getWorkItemDisplayId(record) || toolConfig.noIdText}</span>
          {showRemainingTime ? (
            <span className={`bitable-detail-remaining ${Number(record.remainingDays) < 0 ? 'is-overdue' : ''}`}>
              {formatRemainingDays(record.remainingDays)}
            </span>
          ) : null}
        </div>
        <div className="bitable-detail-actions">
          {canEditContent ? (
            <button type="button" className="bitable-edit-button" onClick={() => setEditOpen(true)}>
              编辑内容
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="bitable-delete-button"
              disabled={deleteStatus.type === 'loading'}
              onClick={handleDelete}
            >
              {deleteStatus.type === 'loading' ? '删除中' : '删除'}
            </button>
          ) : null}
        </div>
      </div>
      {editStatus.message ? <p className={`record-comment-status record-comment-status-${editStatus.type}`}>{editStatus.message}</p> : null}
      {deleteStatus.message ? <p className={`record-comment-status record-comment-status-${deleteStatus.type}`}>{deleteStatus.message}</p> : null}
      {editOpen ? (
        <WorkItemEditDialog
          toolConfig={toolConfig}
          projectId={projectId}
          record={record}
          fields={editableFields}
          mentionableUsers={mentionableUsers}
          onClose={() => setEditOpen(false)}
          onSaved={handleEditSaved}
        />
      ) : null}

      <div className="bitable-detail-scroll">
        <div className="bitable-detail-layout">
          <div className="bitable-detail-main">
            <dl className="bitable-detail-fields">
              {displayFields.map((field) => (
                <div
                  key={field.fieldId || field.fieldName}
                  className={`bitable-detail-field ${isWideBitableDetailField(field, rawFields[field.fieldName]) ? 'is-wide' : ''}`}
                >
                  <dt>{field.fieldName || '未命名字段'}</dt>
                  <dd>
                    <BitableFieldValue
                      field={field}
                      value={rawFields[field.fieldName]}
                      user={user}
                      projectId={projectId}
                      toolConfig={toolConfig}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <aside className="bitable-detail-operation-sidebar" aria-label={`${toolConfig.itemLabel}操作`}>
            {canUpdateStatus ? (
              <DetailActionSection
                actionId="status"
                title="更新处理状态"
                isOpen={activeAction === 'status'}
                onToggle={setActiveAction}
              >
                <RequirementStatusUpdatePanel
                  toolConfig={toolConfig}
                  projectId={projectId}
                  record={record}
                  statusOptions={statusOptions}
                  onUpdated={onRequirementUpdated}
                  embedded
                />
              </DetailActionSection>
            ) : null}
            {canChangeAssignees ? (
              <DetailActionSection
                actionId="assignees"
                title="变更处理人"
                isOpen={activeAction === 'assignees'}
                onToggle={setActiveAction}
              >
                <WorkItemAssigneeChangePanel
                  toolConfig={toolConfig}
                  projectId={projectId}
                  record={record}
                  user={user}
                  mentionableUsers={mentionableUsers}
                  commentsParseError={record.commentsParseError || ''}
                  onUpdated={onRequirementUpdated}
                  embedded
                />
              </DetailActionSection>
            ) : null}
            <DetailActionSection
              actionId="comments"
              title="留言"
              isOpen={activeAction === 'comments'}
              onToggle={setActiveAction}
            >
              <RecordCommentsPanel
                toolConfig={toolConfig}
                projectId={projectId}
                record={record}
                user={user}
                mentionableUsers={mentionableUsers}
                highlightCommentId={highlightCommentId}
                embedded
              />
            </DetailActionSection>
          </aside>
        </div>
      </div>
    </section>
  );
}

function DetailActionSection({ actionId, title, isOpen, onToggle, children }) {
  return (
    <section className={`detail-action-section ${isOpen ? 'is-open' : ''}`}>
      <button
        type="button"
        className="detail-action-toggle"
        aria-expanded={isOpen}
        onClick={() => onToggle(isOpen ? '' : actionId)}
      >
        <span>{title}</span>
        <span className={`detail-action-chevron ${isOpen ? '' : 'is-collapsed'}`} aria-hidden="true">▾</span>
      </button>
      {isOpen ? <div className="detail-action-section-body">{children}</div> : null}
    </section>
  );
}

function isWideBitableDetailField(field, value) {
  if (isAttachmentField(field, value)) {
    return true;
  }

  const text = normalizeDisplayText(value);
  return text.length > 120 || text.includes('\n') || (Array.isArray(value) && value.length > 2);
}

function BitableFieldValue({ field, value, user, projectId, toolConfig }) {
  if (isEmptyBitableValue(value)) {
    return <span className="bitable-empty-value">未填写</span>;
  }

  if (isAttachmentField(field, value)) {
    return <AttachmentFieldValue value={value} projectId={projectId} toolConfig={toolConfig} />;
  }

  if (isUserField(field, value)) {
    return <UserFieldValue value={value} user={user} />;
  }

  if (isDateField(field, value)) {
    return <span>{formatBitableDate(value)}</span>;
  }

  if (isSelectField(field, value)) {
    return <SelectFieldValue field={field} value={value} />;
  }

  if (isCheckboxField(field, value)) {
    return <span>{normalizeCheckboxValue(value) ? '是' : '否'}</span>;
  }

  if (isUrlField(field, value)) {
    return <UrlFieldValue value={value} />;
  }

  if (isProgressField(field, value)) {
    return <ProgressFieldValue value={value} />;
  }

  if (isRatingField(field, value)) {
    return <RatingFieldValue value={value} />;
  }

  if (isCurrencyField(field, value)) {
    return <span>{formatCurrencyValue(value)}</span>;
  }

  return <GenericFieldValue value={value} />;
}

function SelectFieldValue({ field, value }) {
  const items = normalizeSelectItems(value);

  if (items.length === 0) {
    return <span className="bitable-empty-value">未填写</span>;
  }

  return (
    <span className="bitable-tag-list">
      {items.map((item, index) => {
        const option = findFieldOption(field, item.name);
        const color = option?.color || item.color || '';
        const style = color
          ? {
              '--tag-color': color,
              '--tag-soft-color': buildSoftColor(color),
              '--tag-border-color': buildBorderColor(color),
            }
          : undefined;

        return (
          <span key={`${item.name}-${index}`} className="bitable-tag" style={style}>
            {item.name || '未命名'}
          </span>
        );
      })}
    </span>
  );
}

function UserFieldValue({ value, user }) {
  const users = normalizeFieldUsers(value);

  if (users.length === 0) {
    return <span className="bitable-empty-value">未填写</span>;
  }

  return (
    <span className="bitable-user-list">
      {users.map((item, index) => {
        const suffix = isSameDisplayUser(item, user) ? '（我）' : '';
        return (
          <span key={`${item.name}-${index}`} className="bitable-user-pill">
            {item.avatarUrl ? <img src={item.avatarUrl} alt="" /> : <span aria-hidden="true">{(item.name || '人').trim()[0] || '人'}</span>}
            <strong>{item.name || '未命名'}{suffix}</strong>
          </span>
        );
      })}
    </span>
  );
}

function UrlFieldValue({ value }) {
  const urls = normalizeUrlItems(value);

  if (urls.length === 0) {
    return <GenericFieldValue value={value} />;
  }

  return (
    <span className="bitable-link-list">
      {urls.map((item, index) => (
        <a key={`${item.url}-${index}`} href={item.url} target="_blank" rel="noreferrer">
          {item.text || item.url}
        </a>
      ))}
    </span>
  );
}

function AttachmentFieldValue({ value, projectId, toolConfig }) {
  const attachments = normalizeAttachmentItems(value, projectId, toolConfig);

  if (attachments.length === 0) {
    return <span className="bitable-empty-value">未填写</span>;
  }

  return (
    <div className="bitable-attachments">
      {attachments.map((attachment, index) => (
        <div key={`${attachment.fileToken || attachment.name}-${index}`} className="bitable-attachment-item">
          {attachment.url && isImageAttachment(attachment) ? (
            <a href={attachment.url} target="_blank" rel="noreferrer" className="bitable-attachment-preview">
              <img src={attachment.url} alt={attachment.name || '附件图片'} />
            </a>
          ) : null}
          {attachment.url && isVideoAttachment(attachment) ? (
            <video className="bitable-attachment-video" src={attachment.url} controls preload="metadata" />
          ) : null}
          {!isImageAttachment(attachment) && !isVideoAttachment(attachment) ? (
            <div className="bitable-file-card">
              <span className="bitable-file-name" title={attachment.name}>
                {attachment.name || '未命名文件'}
              </span>
              <span className="bitable-file-meta">{formatFileSize(attachment.size)}</span>
              {attachment.url ? (
                <a href={attachment.url} download={attachment.name || undefined}>
                  下载
                </a>
              ) : (
                <span>暂不可下载</span>
              )}
            </div>
          ) : (
            <div className="bitable-attachment-caption">
              <span title={attachment.name}>{attachment.name || '附件'}</span>
              <a href={attachment.url} download={attachment.name || undefined}>
                下载
              </a>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ProgressFieldValue({ value }) {
  const number = normalizeNumberDisplayValue(value);
  if (number === null) {
    return <GenericFieldValue value={value} />;
  }

  const percent = Math.max(0, Math.min(number <= 1 ? number * 100 : number, 100));

  return (
    <span className="bitable-progress">
      <span className="bitable-progress-track">
        <span className="bitable-progress-bar" style={{ width: `${percent}%` }} />
      </span>
      <strong>{percent.toFixed(0)}%</strong>
    </span>
  );
}

function RatingFieldValue({ value }) {
  const number = normalizeNumberDisplayValue(value);
  if (number === null) {
    return <GenericFieldValue value={value} />;
  }

  const rating = Math.max(0, Math.min(Math.round(number), 5));

  return (
    <span className="bitable-rating">
      <span aria-hidden="true">{'★'.repeat(rating)}{'☆'.repeat(5 - rating)}</span>
      <strong>{number}</strong>
    </span>
  );
}

function GenericFieldValue({ value }) {
  const text = normalizeDisplayText(value);

  if (!text) {
    return <span className="bitable-empty-value">未填写</span>;
  }

  return <span className="bitable-generic-value">{text}</span>;
}

function RequirementStatusUpdatePanel({ toolConfig, projectId, record, statusOptions, onUpdated, embedded = false }) {
  const options = normalizeRequirementStatusOptionsForClient(statusOptions);
  const currentStatus = String(record.requirementStatus || '未设置状态').trim();
  const selectableOptions = ensureStatusOptionExists(options, currentStatus);
  const firstDifferentStatus = selectableOptions.find((option) => option.name !== currentStatus)?.name || '';
  const [newStatus, setNewStatus] = useState(firstDifferentStatus);
  const [message, setMessage] = useState('');
  const [notifyProposer, setNotifyProposer] = useState(true);
  const [status, setStatus] = useState({ type: 'idle', message: '' });

  useEffect(() => {
    const nextOptions = ensureStatusOptionExists(normalizeRequirementStatusOptionsForClient(statusOptions), currentStatus);
    setNewStatus(nextOptions.find((option) => option.name !== currentStatus)?.name || '');
    setMessage('');
    setNotifyProposer(true);
    setStatus({ type: 'idle', message: '' });
  }, [record.recordId, currentStatus, statusOptions]);

  async function handleSubmit(event) {
    event.preventDefault();
    const trimmedStatus = newStatus.trim();
    const trimmedMessage = message.trim();
    if (!trimmedStatus || status.type === 'loading') {
      setStatus({ type: 'error', message: '请选择处理状态' });
      return;
    }

    if (trimmedStatus === currentStatus) {
      setStatus({ type: 'error', message: '处理状态没有变化' });
      return;
    }

    setStatus({ type: 'loading', message: '正在更新处理状态' });

    try {
      const payload = await updateRequirementStatus(toolConfig, projectId, record.recordId, {
        newStatus: trimmedStatus,
        message: trimmedMessage,
        notifyProposer,
      });
      const updatedItem = payload.item || payload.requirement;
      if (updatedItem) {
        onUpdated?.(updatedItem);
      }

      const failedNotifications = (payload.notificationResults || []).filter((item) => !item.ok);
      if (failedNotifications.length > 0) {
        setStatus({ type: 'warning', message: `处理状态已更新，${failedNotifications.length} 个通知发送失败` });
        return;
      }

      setStatus({ type: 'success', message: '处理状态已更新' });
    } catch (error) {
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  return (
    <section className="requirement-status-update" aria-label="更新处理状态">
      {embedded ? <p className="detail-action-context">当前：{currentStatus}</p> : (
        <div className="requirement-status-update-header">
          <h3>更新处理状态</h3>
          <span>当前：{currentStatus}</span>
        </div>
      )}
      <form className="requirement-status-update-form" onSubmit={handleSubmit}>
        <label className="requirement-status-update-field">
          <span>新的处理状态</span>
          <select
            className="allow-text-select"
            value={newStatus}
            disabled={status.type === 'loading'}
            onChange={(event) => setNewStatus(event.target.value)}
          >
            <option value="">请选择处理状态</option>
            {selectableOptions.map((option) => (
              <option key={option.name} value={option.name} disabled={option.name === currentStatus}>
                {option.name}{option.name === currentStatus ? '（当前）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="requirement-status-update-field">
          <span>留言</span>
          <textarea
            className="allow-text-select"
            rows={3}
            maxLength={2000}
            placeholder="可选填写处理状态变动说明"
            value={message}
            disabled={status.type === 'loading'}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <div className="requirement-status-update-actions">
          <label className="requirement-status-update-notify">
            <input
              type="checkbox"
              checked={notifyProposer}
              disabled={status.type === 'loading'}
              onChange={(event) => setNotifyProposer(event.target.checked)}
            />
            <span>是否通知提出人员</span>
          </label>
          <button type="submit" disabled={!newStatus || newStatus === currentStatus || status.type === 'loading'}>
            {status.type === 'loading' ? '更新中' : '更新'}
          </button>
        </div>
        {status.message ? <p className={`record-comment-status record-comment-status-${status.type}`}>{status.message}</p> : null}
      </form>
    </section>
  );
}

function WorkItemAssigneeChangePanel({ toolConfig, projectId, record, user, mentionableUsers, commentsParseError, onUpdated, embedded = false }) {
  const currentAssignees = Array.isArray(record.assignees) ? record.assignees : [];
  const mentionCandidates = normalizeMentionCandidates(mentionableUsers);
  const currentAssigneeKey = buildDisplayUserSetKey(currentAssignees);
  const [selectedAssignees, setSelectedAssignees] = useState(currentAssignees);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const selectedAssigneeKey = buildDisplayUserSetKey(selectedAssignees);
  const hasInvalidAssignee = selectedAssignees.some((assignee) => !mentionCandidates.some((candidate) => isSameDisplayUser(candidate, assignee)));
  const isUnchanged = Boolean(selectedAssigneeKey && selectedAssigneeKey === currentAssigneeKey);
  const isDisabled = status.type === 'loading' || Boolean(commentsParseError);

  useEffect(() => {
    setSelectedAssignees(currentAssignees);
    setReason('');
    setStatus({ type: 'idle', message: '' });
  }, [record.recordId, currentAssigneeKey]);

  async function handleSubmit(event) {
    event.preventDefault();
    const trimmedReason = reason.trim();

    if (isDisabled) {
      return;
    }

    if (selectedAssignees.length === 0) {
      setStatus({ type: 'error', message: '请选择新的处理人员' });
      return;
    }

    if (hasInvalidAssignee) {
      setStatus({ type: 'error', message: '处理人员不在可选范围内' });
      return;
    }

    if (isUnchanged) {
      setStatus({ type: 'error', message: '处理人员没有变化' });
      return;
    }

    if (!trimmedReason) {
      setStatus({ type: 'error', message: '请填写变更原因' });
      return;
    }

    setStatus({ type: 'loading', message: '正在变更处理人员' });

    try {
      const payload = await changeWorkItemAssignees(toolConfig, projectId, record.recordId, {
        assignees: selectedAssignees,
        reason: trimmedReason,
      });
      const updatedItem = payload.item || payload.requirement;
      if (updatedItem) {
        onUpdated?.(updatedItem);
        setSelectedAssignees(Array.isArray(updatedItem.assignees) ? updatedItem.assignees : selectedAssignees);
      }
      setReason('');

      const failedNotifications = (payload.notificationResults || []).filter((item) => !item.ok);
      if (failedNotifications.length > 0) {
        setStatus({ type: 'warning', message: `处理人员已变更，${failedNotifications.length} 个通知发送失败` });
        return;
      }

      setStatus({ type: 'success', message: '处理人员已变更' });
    } catch (error) {
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  return (
    <section className="workitem-assignee-change" aria-label="变更处理人">
      {embedded ? <p className="detail-action-context">当前：{formatPeopleNames(currentAssignees)}</p> : (
        <div className="workitem-assignee-change-header">
          <h3>变更处理人</h3>
          <span>当前：{formatPeopleNames(currentAssignees)}</span>
        </div>
      )}
      <form className="workitem-assignee-change-form" onSubmit={handleSubmit}>
        <div className="workitem-assignee-current">
          <span>当前处理人员</span>
          <UserFieldValue value={currentAssignees} user={user} />
        </div>
        <MentionUserMultiSelect
          selectedPeople={selectedAssignees}
          candidates={mentionCandidates}
          onChange={setSelectedAssignees}
          disabled={isDisabled}
          label="新的处理人员"
          emptyText="暂无可选处理人员"
          selectedLabel="已选择新的处理人员"
        />
        <label className="workitem-assignee-reason">
          <span>变更原因</span>
          <textarea
            className="allow-text-select"
            rows={3}
            maxLength={2000}
            placeholder="请填写变更处理人的原因"
            value={reason}
            disabled={isDisabled}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {commentsParseError ? (
          <p className="record-comments-error">{commentsParseError}，请先修复多维表格中的留言字段。</p>
        ) : null}
        <div className="workitem-assignee-change-actions">
          <button
            type="submit"
            disabled={isDisabled || selectedAssignees.length === 0 || hasInvalidAssignee || isUnchanged || !reason.trim()}
          >
            {status.type === 'loading' ? '变更中' : '变更'}
          </button>
        </div>
        {status.message ? <p className={`record-comment-status record-comment-status-${status.type}`}>{status.message}</p> : null}
      </form>
    </section>
  );
}

function RecordCommentsPanel({ toolConfig, projectId, record, user, mentionableUsers, highlightCommentId, embedded = false }) {
  const recordComments = normalizeClientComments(record.comments);
  const recordCommentsKey = recordComments.map((comment) => comment.id).join('|');
  const [comments, setComments] = useState(() => recordComments);
  const [content, setContent] = useState('');
  const [mentionedUsers, setMentionedUsers] = useState([]);
  const [notifyMentioned, setNotifyMentioned] = useState(false);
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const [deletingCommentId, setDeletingCommentId] = useState('');
  const commentsPanelRef = useRef(null);
  const commentListRef = useRef(null);
  const commentsParseError = record.commentsParseError || '';
  const mentionCandidates = normalizeMentionCandidates(mentionableUsers);
  const highlightedCommentExists = Boolean(highlightCommentId && comments.some((comment) => comment.id === highlightCommentId));

  useEffect(() => {
    setComments(recordComments);
    setContent('');
    setMentionedUsers([]);
    setNotifyMentioned(false);
    setStatus({ type: 'idle', message: '' });
    setDeletingCommentId('');
  }, [record.recordId, recordCommentsKey]);

  useEffect(() => {
    setMentionedUsers((current) => filterSelectedMentionedUsers(current, mentionCandidates));
  }, [mentionableUsers]);

  useEffect(() => {
    if (!highlightCommentId) {
      return;
    }

    const target = commentListRef.current?.querySelector('[data-comment-highlight="true"]') || commentsPanelRef.current;
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightCommentId, comments]);

  async function handleSubmit(event) {
    event.preventDefault();
    const trimmedContent = content.trim();
    if (!trimmedContent || status.type === 'loading' || commentsParseError) {
      return;
    }

    setStatus({ type: 'loading', message: '正在发送留言' });

    try {
      const payload = await appendRecordComment(toolConfig, projectId, record.recordId, {
        content: trimmedContent,
        mentionedUsers,
        notifyMentioned,
      });
      setComments(normalizeClientComments(payload.comments));
      setContent('');
      setMentionedUsers([]);

      const failedNotifications = (payload.notificationResults || []).filter((item) => !item.ok);
      if (failedNotifications.length > 0) {
        setStatus({
          type: 'warning',
          message: `留言已保存，${failedNotifications.length} 个通知发送失败`,
        });
        return;
      }

      setStatus({ type: 'success', message: '留言已保存' });
    } catch (error) {
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  async function handleDelete(comment) {
    if (!comment?.id || deletingCommentId) {
      return;
    }

    setDeletingCommentId(comment.id);
    setStatus({ type: 'loading', message: '正在删除留言' });

    try {
      const payload = await deleteRecordComment(toolConfig, projectId, record.recordId, comment.id);
      setComments(normalizeClientComments(payload.comments));
      setStatus({ type: 'success', message: '留言已删除' });
    } catch (error) {
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    } finally {
      setDeletingCommentId('');
    }
  }

  return (
    <section className="record-comments" aria-label="留言" ref={commentsPanelRef}>
      {embedded ? <p className="detail-action-context">共 {comments.length} 条留言</p> : (
        <div className="record-comments-header">
          <h3>留言</h3>
          <span>{comments.length} 条</span>
        </div>
      )}

      {commentsParseError ? (
        <p className="record-comments-error">{commentsParseError}，请先修复多维表格中的留言字段。</p>
      ) : null}
      {highlightCommentId && !highlightedCommentExists ? (
        <p className="record-comment-status record-comment-status-warning">目标留言不存在或已被删除</p>
      ) : null}

      <form className="record-comment-form" onSubmit={handleSubmit}>
        <MentionUserMultiSelect
          selectedPeople={mentionedUsers}
          candidates={mentionCandidates}
          onChange={setMentionedUsers}
          disabled={Boolean(commentsParseError)}
        />

        <label className="record-comment-input-label">
          <span>留言内容</span>
          <textarea
            value={content}
            className="record-comment-input allow-text-select"
            rows={3}
            maxLength={2000}
            placeholder="输入留言内容"
            disabled={Boolean(commentsParseError) || status.type === 'loading'}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>

        <div className="record-comment-actions">
          <label className="record-comment-notify">
            <input
              type="checkbox"
              checked={notifyMentioned}
              disabled={Boolean(commentsParseError) || mentionedUsers.length === 0 || status.type === 'loading'}
              onChange={(event) => setNotifyMentioned(event.target.checked)}
            />
            <span>是否通知提及人员</span>
          </label>
          <button
            type="submit"
            className="record-comment-submit"
            disabled={!content.trim() || Boolean(commentsParseError) || status.type === 'loading'}
          >
            {status.type === 'loading' ? '发送中' : '发送'}
          </button>
        </div>

        {status.message ? <p className={`record-comment-status record-comment-status-${status.type}`}>{status.message}</p> : null}
      </form>
      <div className="record-comment-list" aria-live="polite" ref={commentListRef}>
        {comments.length > 0 ? (
          comments.map((comment) => (
            <RecordCommentItem
              key={comment.id}
              comment={comment}
              user={user}
              deleting={deletingCommentId === comment.id}
              highlighted={comment.id === highlightCommentId}
              onDelete={handleDelete}
            />
          ))
        ) : (
          <div className="record-comment-empty">暂无留言</div>
        )}
      </div>
    </section>
  );
}

function RecordCommentItem({ comment, user, deleting, highlighted, onDelete }) {
  const isCurrentUser = isSameDisplayUser({ openId: comment.authorOpenId, name: comment.authorName }, user);
  const authorName = comment.authorName || comment.authorOpenId || '未知用户';
  const mentionedUsers = Array.isArray(comment.mentionedUsers) ? comment.mentionedUsers : [];

  return (
    <article className={`record-comment-item ${highlighted ? 'is-highlighted' : ''}`} data-comment-highlight={highlighted ? 'true' : undefined}>
      <div className="record-comment-avatar" aria-hidden="true">
        {comment.authorAvatarUrl ? <img src={comment.authorAvatarUrl} alt="" /> : <span>{authorName.trim()[0] || '留'}</span>}
      </div>
      <div className="record-comment-body">
        <div className="record-comment-meta">
          <strong>{authorName}{isCurrentUser ? '（我）' : ''}</strong>
          <span>{formatCommentTime(comment.createdAt)}</span>
          {isCurrentUser ? (
            <button
              type="button"
              className="record-comment-delete"
              disabled={deleting}
              onClick={() => onDelete(comment)}
            >
              {deleting ? '删除中' : '删除'}
            </button>
          ) : null}
        </div>
        <p>{comment.content}</p>
        {mentionedUsers.length > 0 || comment.mentionedOpenIds?.length > 0 ? (
          <div className="record-comment-mentions">
            <span>提及</span>
            {(mentionedUsers.length > 0 ? mentionedUsers : comment.mentionedOpenIds.map((openId) => ({ openId, name: openId }))).map((person) => (
              <strong key={person.openId}>{person.name || person.openId}</strong>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function MentionUserMultiSelect({
  selectedPeople,
  candidates,
  onChange,
  disabled,
  label = '提及人员',
  emptyText = '暂无可提及人员',
  selectedLabel = '已选择提及人员',
}) {
  const selectedOpenIds = new Set(selectedPeople.map((person) => person.openId));

  function addPerson(person) {
    if (selectedOpenIds.has(person.openId)) {
      return;
    }

    onChange([...selectedPeople, person]);
  }

  function removePerson(openId) {
    onChange(selectedPeople.filter((person) => person.openId !== openId));
  }

  function togglePerson(person) {
    if (selectedOpenIds.has(person.openId)) {
      removePerson(person.openId);
      return;
    }

    addPerson(person);
  }

  return (
    <div className="people-multi-select">
      <div className="people-search-label">
        <span>{label}</span>
      </div>

      {selectedPeople.length > 0 ? (
        <div className="people-selected-list" aria-label={selectedLabel}>
          {selectedPeople.map((person) => (
            <button
              key={person.openId}
              type="button"
              className="people-selected-pill"
              disabled={disabled}
              onClick={() => removePerson(person.openId)}
            >
              {person.name}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="people-search-results">
        {candidates.length === 0 ? <div className="people-search-state">{emptyText}</div> : null}
        {candidates.map((person) => (
          <label
            key={person.openId}
            className={`people-search-result ${selectedOpenIds.has(person.openId) ? 'is-selected' : ''}`}
          >
            <input
              type="checkbox"
              checked={selectedOpenIds.has(person.openId)}
              disabled={disabled}
              onChange={() => togglePerson(person)}
            />
            <span className="people-search-result-main">
              <PeopleAvatar person={person} />
              <span>
                <strong>{person.name}</strong>
                <small>{person.openId}</small>
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function PeopleAvatar({ person }) {
  if (person.avatarUrl) {
    return <img className="people-avatar" src={person.avatarUrl} alt="" />;
  }

  return (
    <span className="people-avatar people-avatar-fallback" aria-hidden="true">
      {(person.name || '人').trim()[0] || '人'}
    </span>
  );
}

function AssigneeList({ assignees, user }) {
  if (assignees.length === 0) {
    return <span className="assignee-empty">未分配</span>;
  }

  const visibleAssignees = assignees.slice(0, 2);
  const hiddenCount = assignees.length - visibleAssignees.length;
  const names = visibleAssignees.map((assignee) => {
    const suffix = isSameDisplayUser(assignee, user) ? '（我）' : '';
    return `${assignee.name || '未命名'}${suffix}`;
  });

  return (
    <div className="assignee-list" title={assignees.map((assignee) => assignee.name).filter(Boolean).join('、')}>
      <span className="assignee-name">
        {names.join('、')}
        {hiddenCount > 0 ? ` 等${hiddenCount + visibleAssignees.length}人` : ''}
      </span>
    </div>
  );
}

function ProjectIcon({ project }) {
  const [imageFailed, setImageFailed] = useState(false);
  const projectName = project.projectName || '项目';

  if (project.iconUrl && !imageFailed) {
    return (
      <span className="project-icon">
        <img
          className="project-icon-image"
          src={project.iconUrl}
          alt={`${projectName}图标`}
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  return (
    <span className="project-icon project-icon-fallback" aria-hidden="true">
      {projectName.trim()[0] || '项'}
    </span>
  );
}

function HomePanel({ user }) {
  return (
    <section className="workspace-content" aria-label="首页内容">
      <div className="home-panel">
        <p className="home-eyebrow">首页内容</p>
        <h1>欢迎您 {user.name}</h1>
      </div>
    </section>
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
  return (
    <span className="avatar avatar-fallback" aria-hidden="true">
      {initial}
    </span>
  );
}

function HomeIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 10.4 12 3l9 7.4v10.1a.5.5 0 0 1-.5.5H15v-6H9v6H3.5a.5.5 0 0 1-.5-.5V10.4Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="add-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.8 4h2.4v6.8H20v2.4h-6.8V20h-2.4v-6.8H4v-2.4h6.8V4Z" />
    </svg>
  );
}

function parseDirectTargetFromLocation() {
  try {
    const url = new URL(window.location.href);
    const direct = String(url.searchParams.get('direct') || '').trim();
    if (!direct) {
      return null;
    }

    const target = {
      type: direct,
      projectId: String(url.searchParams.get('projectId') || '').trim(),
      toolId: String(url.searchParams.get('tool') || '').trim() || getDefaultDirectToolId(direct),
      recordId: String(url.searchParams.get('recordId') || '').trim(),
      commentId: String(url.searchParams.get('commentId') || '').trim(),
    };

    return {
      ...target,
      key: [target.type, target.projectId, target.toolId, target.recordId, target.commentId].join('|'),
    };
  } catch {
    return null;
  }
}

function getDefaultDirectToolId(targetType) {
  const direct = String(targetType || '').trim();
  if (direct === 'requirement-detail' || direct === 'requirement-comment') {
    return 'requirements';
  }

  if (direct === 'bug-detail' || direct === 'bug-comment') {
    return 'bugs';
  }

  return 'overview';
}

function getRequirementStableId(requirement) {
  return String(requirement?.recordId || requirement?.requirementId || requirement?.title || '').trim();
}

function isRequirementTarget(requirement, targetId) {
  const target = String(targetId || '').trim();
  if (!target) {
    return false;
  }

  return [
    requirement?.recordId,
    requirement?.requirementId,
    requirement?.title,
  ].some((item) => String(item || '').trim() === target);
}

async function fetchCurrentUser() {
  const response = await fetch('/api/me', {
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    return null;
  }

  const payload = await parseJsonResponse(response);
  return payload.user || null;
}

async function fetchAppConfig() {
  const response = await fetch('/api/config', {
    credentials: 'same-origin',
  });
  return parseJsonResponse(response);
}

async function fetchProjects() {
  const response = await fetch('/api/projects', {
    credentials: 'same-origin',
  });
  return parseJsonResponse(response);
}

async function ensureProjectRequirements(projectId) {
  return ensureProjectWorkItems(projectId, getWorkItemToolConfig('requirements'));
}

async function ensureProjectWorkItems(projectId, toolConfig) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/ensure`, {
    method: 'POST',
    credentials: 'same-origin',
  });

  return parseJsonResponse(response);
}

async function createWorkItem(toolConfig, projectId, payload) {
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const formData = new FormData();
  formData.set('title', payload.title || '');
  formData.set('description', payload.description || '');
  formData.set('priority', payload.priority || '');
  formData.set('expectedDays', payload.expectedDays === null || payload.expectedDays === undefined ? '' : String(payload.expectedDays));
  formData.set('assignees', JSON.stringify(payload.assignees || []));
  for (const file of attachments) {
    formData.append('attachments', file);
  }

  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });

  return parseJsonResponse(response);
}

async function updateWorkItem(toolConfig, projectId, recordId, payload) {
  const formData = new FormData();
  const selectedFields = (Array.isArray(payload.selectedFields) ? payload.selectedFields : []).map((field) => field.fieldName).filter(Boolean);
  const updates = {};
  const existingAttachments = {};

  for (const field of payload.selectedFields || []) {
    const fieldName = field.fieldName;
    const value = payload.fieldValues?.[fieldName];
    if (isAttachmentField(field, value)) {
      const attachmentValue = value || { existing: [], newFiles: [] };
      existingAttachments[fieldName] = (attachmentValue.existing || []).map(toEditableAttachmentPayload);
      for (const file of attachmentValue.newFiles || []) {
        formData.append(`attachment:${encodeURIComponent(fieldName)}`, file);
      }
      continue;
    }

    updates[fieldName] = value;
  }

  formData.set('selectedFields', JSON.stringify(selectedFields));
  formData.set('updates', JSON.stringify(updates));
  formData.set('existingAttachments', JSON.stringify(existingAttachments));
  formData.set('notifyRelated', payload.notifyRelated ? 'true' : 'false');
  formData.set('notifyUsers', JSON.stringify(payload.notifyUsers || []));

  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}`, {
    method: 'PUT',
    credentials: 'same-origin',
    body: formData,
  });

  return parseJsonResponse(response);
}

function extractFilesFromClipboard(clipboardData) {
  const files = [];
  const seen = new Set();

  function addClipboardFile(file) {
    if (!file) {
      return;
    }

    const key = getAttachmentDuplicateKey(file);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    files.push(file);
  }

  for (const file of Array.from(clipboardData?.files || [])) {
    addClipboardFile(file);
  }

  for (const item of Array.from(clipboardData?.items || [])) {
    if (item.kind !== 'file') {
      continue;
    }
    const file = item.getAsFile?.();
    addClipboardFile(file);
  }

  return files;
}

function extractSupportedAttachmentsFromClipboard(clipboardData) {
  return extractFilesFromClipboard(clipboardData).filter((file) => isPasteSupportedAttachment(file));
}

function isPasteSupportedAttachment(file) {
  const type = String(file?.type || '').toLowerCase();
  return type.startsWith('image/') || type.startsWith('video/');
}

function shouldHandleDialogAttachmentPaste(dialogElement, target) {
  if (!dialogElement) {
    return false;
  }

  const targetElement = getElementFromEventTarget(target);
  if (!targetElement) {
    return true;
  }

  if (dialogElement.contains(targetElement)) {
    return true;
  }

  const activeElement = document.activeElement;
  return Boolean(
    activeElement &&
    dialogElement.contains(activeElement) &&
    (targetElement === document.body || targetElement === document.documentElement)
  );
}

function getElementFromEventTarget(target) {
  if (!target || typeof target !== 'object') {
    return null;
  }

  if (typeof target.closest === 'function') {
    return target;
  }

  if (target.parentElement) {
    return target.parentElement;
  }

  return null;
}

function getSelectedAttachmentPasteField(selectedFields, fieldValues) {
  return selectedFields.find((field) => isAttachmentField(field, fieldValues?.[field.fieldName])) || null;
}

function mergeAttachmentFiles(currentFiles, newFiles) {
  const result = [...currentFiles];
  const seen = new Set(currentFiles.map(getAttachmentDuplicateKey));

  for (const file of newFiles) {
    const key = getAttachmentDuplicateKey(file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(file);
  }

  return result;
}

function getAttachmentFileKey(file) {
  return [file?.name || '', file?.size || 0, file?.type || '', file?.lastModified || 0].join('|');
}

function getAttachmentDuplicateKey(file) {
  return [
    String(file?.name || '').trim().toLowerCase(),
    Number(file?.size || 0),
    String(file?.type || '').trim().toLowerCase(),
  ].join('|');
}

async function deleteWorkItem(toolConfig, projectId, recordId) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}`,
    {
      method: 'DELETE',
      credentials: 'same-origin',
    },
  );

  return parseJsonResponse(response);
}

async function appendRecordComment(toolConfig, projectId, recordId, payload) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}/comments`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    },
  );

  return parseJsonResponse(response);
}

async function deleteRecordComment(toolConfig, projectId, recordId, commentId) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}/comments/${encodeURIComponent(commentId)}`,
    {
      method: 'DELETE',
      credentials: 'same-origin',
    },
  );

  return parseJsonResponse(response);
}

async function updateRequirementStatus(toolConfig, projectId, recordId, payload) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}/status`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    },
  );

  return parseJsonResponse(response);
}

async function changeWorkItemAssignees(toolConfig, projectId, recordId, payload) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(toolConfig.routeSegment)}/${encodeURIComponent(recordId)}/assignees`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    },
  );

  return parseJsonResponse(response);
}

async function exchangeCodeForUser(code) {
  const response = await fetch('/api/auth/feishu', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ code }),
  });

  const payload = await parseJsonResponse(response);
  return payload.user;
}

async function createDebugSession() {
  const response = await fetch('/api/auth/debug', {
    method: 'POST',
    credentials: 'same-origin',
  });

  const payload = await parseJsonResponse(response);
  return payload.user;
}

async function parseJsonResponse(response) {
  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.message || '请求失败');
    error.payload = payload;
    throw error;
  }

  return payload;
}

function buildRequirementsReadyMessage(payload) {
  return buildWorkItemsReadyMessage(payload, getWorkItemToolConfig('requirements'));
}

function buildWorkItemsReadyMessage(payload, toolConfig) {
  if (payload.created) {
    return `已创建${toolConfig.listLabel}`;
  }

  if (payload.status === 'parent_ready') {
    return `已准备${toolConfig.listLabel}节点`;
  }

  return `已找到${toolConfig.listLabel}`;
}

function updateRequirementInState(state, requirement, toolConfig = getWorkItemToolConfig('requirements')) {
  if (!requirement || state?.status !== 'ready' || !state.result) {
    return state;
  }

  const requirements = getPayloadWorkItems(state.result, toolConfig);
  const nextRequirements = requirements
    .map((item) => (isRequirementTarget(item, requirement.recordId) ? requirement : item))
    .sort((left, right) => compareRequirementsForClient(left, right, toolConfig.toolId));

  return {
    ...state,
    result: {
      ...state.result,
      items: nextRequirements,
      [toolConfig.toolId === 'bugs' ? 'bugs' : 'requirements']: nextRequirements,
      requirements: toolConfig.toolId === 'requirements' ? nextRequirements : state.result.requirements,
    },
  };
}

function mergeCreatedWorkItemsIntoState(state, payload, toolConfig) {
  if (!state?.result || !payload) {
    return state;
  }

  const nextItems = getPayloadWorkItems(payload, toolConfig);
  const item = payload.item || payload.requirement;
  const mergedItems = nextItems.length > 0
    ? nextItems
    : item
      ? [...getPayloadWorkItems(state.result, toolConfig)].concat(item).sort((left, right) => compareRequirementsForClient(left, right, toolConfig.toolId))
      : getPayloadWorkItems(state.result, toolConfig);

  return {
    ...state,
    status: 'ready',
    result: {
      ...state.result,
      fields: Array.isArray(payload.fields) ? payload.fields : state.result.fields,
      editableFields: Array.isArray(payload.editableFields) ? payload.editableFields : state.result.editableFields,
      priorityColors: payload.priorityColors || state.result.priorityColors,
      statusOptions: Array.isArray(payload.statusOptions) ? payload.statusOptions : state.result.statusOptions,
      mentionableUsers: Array.isArray(payload.mentionableUsers) ? payload.mentionableUsers : state.result.mentionableUsers,
      items: mergedItems,
      [toolConfig.toolId === 'bugs' ? 'bugs' : 'requirements']: mergedItems,
      requirements: toolConfig.toolId === 'requirements' ? mergedItems : state.result.requirements,
    },
  };
}

function createInitialWorkItemStates() {
  return Object.fromEntries(Object.keys(WORK_ITEM_TOOL_CONFIGS).map((toolId) => [toolId, INITIAL_REQUIREMENTS_STATE]));
}

function createInitialWorkItemFilters() {
  return Object.fromEntries(Object.keys(WORK_ITEM_TOOL_CONFIGS).map((toolId) => [toolId, createEmptyWorkItemFilters()]));
}

function getWorkItemToolConfig(toolId) {
  return WORK_ITEM_TOOL_CONFIGS[String(toolId || '').trim()] || null;
}

function getPayloadWorkItems(payload, toolConfig) {
  if (!payload || !toolConfig) {
    return [];
  }

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  if (toolConfig.toolId === 'bugs' && Array.isArray(payload.bugs)) {
    return payload.bugs;
  }

  if (Array.isArray(payload.requirements)) {
    return payload.requirements;
  }

  return [];
}

function getAvailableWorkItemStatuses(toolConfig, requirements, statusOptions) {
  const names = new Set(
    normalizeRequirementStatusOptionsForClient(statusOptions)
      .map((option) => option.name)
      .filter(Boolean),
  );

  for (const requirement of requirements || []) {
    names.add(getWorkItemStatus(requirement));
  }

  return [...names].sort((left, right) => compareWorkItemStatus(toolConfig.toolId, left, right));
}

function getWorkItemFilterPeople(requirements, fieldName) {
  const peopleByKey = new Map();

  for (const requirement of requirements || []) {
    for (const person of Array.isArray(requirement?.[fieldName]) ? requirement[fieldName] : []) {
      const key = getWorkItemPersonKey(person);
      if (!key || peopleByKey.has(key)) {
        continue;
      }

      peopleByKey.set(key, {
        key,
        name: normalizeDisplayText(person?.name || person?.openId || person?.email || key),
      });
    }
  }

  return [...peopleByKey.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  }));
}

function getWorkItemDisplayId(item) {
  return String(item?.itemId || item?.bugId || item?.requirementId || '').trim();
}

function groupRequirementsByPriority(requirements) {
  return requirements.reduce((groups, requirement) => {
    const priority = REQUIREMENT_PRIORITIES.includes(requirement.priority) ? requirement.priority : 'P4';
    groups[priority].push(requirement);
    return groups;
  }, Object.fromEntries(REQUIREMENT_PRIORITIES.map((priority) => [priority, []])));
}

function groupRequirementsByStatus(requirements, toolId) {
  const groups = new Map();

  for (const requirement of requirements) {
    const status = requirement.requirementStatus || '未设置状态';
    if (!groups.has(status)) {
      groups.set(status, []);
    }
    groups.get(status).push(requirement);
  }

  return Array.from(groups.entries())
    .map(([status, items]) => ({ status, items }))
    .sort((left, right) => compareWorkItemStatus(toolId, left.status, right.status));
}

function compareRequirementsForClient(left, right, toolId = 'requirements') {
  const leftPriority = REQUIREMENT_PRIORITIES.indexOf(left.priority);
  const rightPriority = REQUIREMENT_PRIORITIES.indexOf(right.priority);
  const priorityDiff = (leftPriority === -1 ? REQUIREMENT_PRIORITIES.length : leftPriority) - (rightPriority === -1 ? REQUIREMENT_PRIORITIES.length : rightPriority);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const statusDiff = compareWorkItemStatus(toolId, getWorkItemStatus(left), getWorkItemStatus(right));
  if (statusDiff !== 0) {
    return statusDiff;
  }

  const remainingDiff = compareRemainingDaysForClient(left.remainingDays, right.remainingDays);
  if (remainingDiff !== 0) {
    return remainingDiff;
  }

  return String(left.requirementId || left.title || '').localeCompare(String(right.requirementId || right.title || ''), 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function compareRemainingDaysForClient(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftValid = Number.isFinite(leftNumber);
  const rightValid = Number.isFinite(rightNumber);

  if (leftValid && rightValid && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }

  return 0;
}

function isRequirementRelatedToUser(requirement, user) {
  const assignees = Array.isArray(requirement.assignees) ? requirement.assignees : [];
  return assignees.some((assignee) => isSameDisplayUser(assignee, user));
}

function isWorkItemSubmitter(item, user) {
  const proposers = Array.isArray(item?.proposers) ? item.proposers : [];
  return proposers.some((proposer) => isSameDisplayUser(proposer, user));
}

function isRequirementStatus(requirement, status) {
  return String(requirement.requirementStatus || '').trim() === status;
}

function getPendingStatusNames(statusOptions) {
  const names = normalizeRequirementStatusOptionsForClient(statusOptions).map((option) => option.name);
  const matched = names.filter((name) => name.includes('待') || name.includes('未'));
  return new Set(matched.length > 0 ? matched : ['待处理', '未处理']);
}

function getProcessingStatusNames(statusOptions) {
  const names = normalizeRequirementStatusOptionsForClient(statusOptions).map((option) => option.name);
  const matched = names.filter((name) => name.includes('中'));
  return new Set(matched.length > 0 ? matched : ['处理中', '修复中']);
}

function formatRemainingDays(value) {
  if (value === null || value === undefined || value === '') {
    return '未设置';
  }

  const days = Number(value);
  if (!Number.isFinite(days)) {
    return '未设置';
  }

  const rounded = Math.abs(days).toFixed(1);
  return days < 0 ? `逾期 ${rounded} 天` : `剩余 ${rounded} 天`;
}

function normalizeClientComments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((comment) => ({
      id: String(comment?.id || ''),
      authorOpenId: String(comment?.authorOpenId || ''),
      authorName: String(comment?.authorName || ''),
      authorAvatarUrl: String(comment?.authorAvatarUrl || ''),
      createdAt: String(comment?.createdAt || ''),
      content: String(comment?.content || ''),
      mentionedOpenIds: Array.isArray(comment?.mentionedOpenIds) ? comment.mentionedOpenIds.map((item) => String(item)).filter(Boolean) : [],
      mentionedUsers: Array.isArray(comment?.mentionedUsers)
        ? comment.mentionedUsers
            .map((person) => ({
              openId: String(person?.openId || ''),
              name: String(person?.name || person?.openId || ''),
              avatarUrl: String(person?.avatarUrl || ''),
            }))
            .filter((person) => person.openId)
        : [],
    }))
    .filter((comment) => comment.id && comment.authorOpenId && comment.content);
}

function normalizeMentionCandidates(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const people = [];
  for (const person of value) {
    const openId = String(person?.openId || person?.open_id || person?.id || '').trim();
    const name = String(person?.name || person?.en_name || person?.nickname || openId || '').trim();
    if (!openId || !name || seen.has(openId)) {
      continue;
    }

    seen.add(openId);
    people.push({
      openId,
      name,
      avatarUrl: String(person?.avatarUrl || person?.avatar_url || person?.avatar_thumb || '').trim(),
    });
  }

  return people;
}

function normalizeRequirementStatusOptionsForClient(value) {
  const fallback = ['待处理', '处理中', '已处理', '已完成', '关闭'].map((name) => ({ name, color: '' }));
  if (!Array.isArray(value) || value.length === 0) {
    return fallback;
  }

  const seen = new Set();
  const options = [];
  for (const item of value) {
    const name = String(item?.name || item || '').trim();
    if (!name || seen.has(name)) {
      continue;
    }

    seen.add(name);
    options.push({
      name,
      color: String(item?.color || '').trim(),
    });
  }

  return options.length > 0 ? options : fallback;
}

function ensureStatusOptionExists(options, currentStatus) {
  const status = String(currentStatus || '').trim();
  if (!status || options.some((option) => option.name === status)) {
    return options;
  }

  return [{ name: status, color: '' }, ...options];
}

function filterSelectedMentionedUsers(selectedPeople, candidates) {
  const candidateOpenIds = new Set(candidates.map((person) => person.openId));
  return selectedPeople.filter((person) => candidateOpenIds.has(person.openId));
}

function formatCommentTime(value) {
  const timestamp = normalizeDateDisplayTimestamp(value);
  if (!timestamp) {
    return '';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function isEmptyBitableValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (typeof value === 'object') {
    return Object.keys(value).length === 0;
  }

  return false;
}

function buildDisplayFields(fields, rawFields, hiddenFieldNames = []) {
  const hiddenNames = new Set(hiddenFieldNames.map((item) => String(item || '').trim()).filter(Boolean));
  const normalizedFields = (Array.isArray(fields) ? fields : [])
    .filter((field) => field?.fieldName)
    .filter((field) => !hiddenNames.has(field.fieldName))
    .sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
  const knownNames = new Set(normalizedFields.map((field) => field.fieldName));
  const extraFields = Object.keys(rawFields || {})
    .filter((fieldName) => !knownNames.has(fieldName))
    .filter((fieldName) => !hiddenNames.has(fieldName))
    .map((fieldName, index) => ({
      fieldId: `raw-${fieldName}`,
      fieldName,
      type: '',
      uiType: '',
      property: {},
      index: normalizedFields.length + index,
    }));

  return [...normalizedFields, ...extraFields];
}

function buildEditableFieldInitialValues(fields, rawFields, projectId, toolConfig) {
  return Object.fromEntries((Array.isArray(fields) ? fields : []).map((field) => {
    const value = rawFields?.[field.fieldName];
    return [field.fieldName, normalizeEditableFieldInitialValue(field, value, projectId, toolConfig)];
  }));
}

function normalizeEditableFieldInitialValue(field, value, projectId, toolConfig) {
  if (isAttachmentField(field, value)) {
    return {
      existing: normalizeAttachmentItems(value, projectId, toolConfig),
      newFiles: [],
    };
  }

  if (isUserField(field, value)) {
    return normalizeFieldUsers(value);
  }

  if (isMultiSelectField(field)) {
    return normalizeSelectItems(value).map((item) => item.name).filter(Boolean);
  }

  if (isSelectField(field, value)) {
    return normalizeSelectItems(value)[0]?.name || '';
  }

  if (isCheckboxField(field)) {
    return normalizeCheckboxValue(value);
  }

  if (isDateField(field)) {
    return formatDateTimeLocalInput(value);
  }

  if (isNumberLikeEditableField(field)) {
    const number = normalizeNumberDisplayValue(value);
    return number === null ? '' : String(number);
  }

  if (isUrlField(field, value)) {
    const url = normalizeUrlItems(value)[0];
    return url?.url || normalizeDisplayText(value);
  }

  return normalizeDisplayText(value);
}

function toEditableAttachmentPayload(attachment) {
  return {
    fileToken: attachment.fileToken || '',
    name: attachment.name || '',
    size: attachment.size || 0,
    mimeType: attachment.mimeType || '',
  };
}

function formatDateTimeLocalInput(value) {
  const timestamp = normalizeDateDisplayTimestamp(value);
  if (!timestamp) {
    return '';
  }

  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getFieldUiType(field) {
  return String(field?.uiType || field?.ui_type || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function getFieldTypeNumber(field) {
  const number = Number(field?.type);
  return Number.isFinite(number) ? number : null;
}

function isAttachmentField(field, value) {
  const uiType = getFieldUiType(field);
  return uiType.includes('attachment') || getFieldTypeNumber(field) === 17 || normalizeAttachmentItems(value).length > 0;
}

function isUserField(field, value) {
  const uiType = getFieldUiType(field);
  return uiType.includes('user') || uiType.includes('person') || getFieldTypeNumber(field) === 11 || looksLikeUserValue(value);
}

function isDateField(field) {
  const uiType = getFieldUiType(field);
  const type = getFieldTypeNumber(field);
  return uiType.includes('date') || uiType.includes('time') || type === 5 || type === 1001 || type === 1002;
}

function isSelectField(field) {
  const uiType = getFieldUiType(field);
  const type = getFieldTypeNumber(field);
  return uiType.includes('select') || type === 3 || type === 4;
}

function isMultiSelectField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('multiselect') || getFieldTypeNumber(field) === 4;
}

function getFieldSelectOptionNames(field) {
  const options = Array.isArray(field?.property?.options) ? field.property.options : [];
  return options.map((option) => normalizeDisplayText(option.name || option.text || option.value)).filter(Boolean);
}

function isCheckboxField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('checkbox') || getFieldTypeNumber(field) === 7;
}

function isUrlField(field, value) {
  const uiType = getFieldUiType(field);
  return uiType === 'url' || uiType.includes('url') || uiType.includes('link') || normalizeUrlItems(value).length > 0;
}

function isProgressField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('progress') || getFieldTypeNumber(field) === 18;
}

function isRatingField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('rating') || getFieldTypeNumber(field) === 19;
}

function isCurrencyField(field) {
  const uiType = getFieldUiType(field);
  return uiType.includes('currency');
}

function isNumberLikeEditableField(field) {
  return isProgressField(field) || isRatingField(field) || isCurrencyField(field) || getFieldTypeNumber(field) === 2 || getFieldUiType(field).includes('number');
}

function getEditableFieldTypeLabel(field) {
  if (isAttachmentField(field, null)) {
    return '附件';
  }
  if (isUserField(field, null)) {
    return '人员';
  }
  if (isMultiSelectField(field)) {
    return '多选';
  }
  if (isSelectField(field, null)) {
    return '单选';
  }
  if (isCheckboxField(field)) {
    return '复选';
  }
  if (isDateField(field)) {
    return '日期';
  }
  if (isNumberLikeEditableField(field)) {
    return '数字';
  }
  if (isUrlField(field, null)) {
    return '链接';
  }
  return '文本';
}

function normalizeSelectItems(value) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) => {
      if (item && typeof item === 'object' && Array.isArray(item.value)) {
        return normalizeSelectItems(item.value);
      }

      return [item];
    })
    .map((item) => {
      if (item && typeof item === 'object') {
        const colorId = Number(item.color);
        return {
          name: normalizeDisplayText(item.name || item.text || item.value || item.id),
          color: Number.isFinite(colorId) ? mapBitableOptionColor(colorId) : '',
        };
      }

      return {
        name: normalizeDisplayText(item),
        color: '',
      };
    })
    .filter((item) => item.name);
}

function findFieldOption(field, name) {
  const options = Array.isArray(field?.property?.options) ? field.property.options : [];
  return options.find((option) => normalizeDisplayText(option.name) === name || normalizeDisplayText(option.text) === name) || null;
}

function normalizeFieldUsers(value) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) => {
      if (item && typeof item === 'object' && Array.isArray(item.value)) {
        return normalizeFieldUsers(item.value);
      }

      return [item];
    })
    .map((item) => {
      if (!item || typeof item !== 'object') {
        const name = normalizeDisplayText(item);
        return name ? { name } : null;
      }

      const name = normalizeDisplayText(item.name || item.en_name || item.nickname || item.email || item.id);
      return {
        id: String(item.id || item.user_id || item.userId || item.open_id || item.openId || item.email || name || '').trim(),
        openId: String(item.open_id || item.openId || item.id || '').trim(),
        unionId: String(item.union_id || item.unionId || '').trim(),
        userId: String(item.user_id || item.userId || '').trim(),
        email: String(item.email || '').trim(),
        name,
        avatarUrl: String(item.avatar_url || item.avatarUrl || item.avatar_thumb || item.avatarThumb || '').trim(),
      };
    })
    .filter((item) => item?.name);
}

function looksLikeUserValue(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => item && typeof item === 'object' && ('open_id' in item || 'openId' in item || 'user_id' in item || 'userId' in item));
}

function normalizeUrlItems(value) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) => {
      if (item && typeof item === 'object' && Array.isArray(item.value)) {
        return normalizeUrlItems(item.value);
      }

      return [item];
    })
    .map((item) => {
      if (typeof item === 'string') {
        return isHttpUrl(item) ? { url: item, text: item } : null;
      }

      if (item && typeof item === 'object') {
        const url = normalizeDisplayText(item.link || item.url || item.href || item.value);
        return isHttpUrl(url)
          ? {
              url,
              text: normalizeDisplayText(item.text || item.name || item.title) || url,
            }
          : null;
      }

      return null;
    })
    .filter(Boolean);
}

function normalizeAttachmentItems(value, projectId = '', toolConfig = getWorkItemToolConfig('requirements')) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const fileToken = String(item.file_token || item.fileToken || item.token || item.attachmentToken || '').trim();
      const name = String(item.name || item.file_name || item.fileName || item.title || fileToken || '').trim();
      const size = Number(item.size || item.file_size || item.fileSize || 0);
      const mimeType = String(item.mime_type || item.mimeType || item.content_type || item.contentType || item.type || '').trim();
      const directUrl = String(item.url || item.download_url || item.downloadUrl || '').trim();
      const routeSegment = toolConfig?.routeSegment || 'requirements';
      const proxyUrl = fileToken && projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(routeSegment)}/attachments/${encodeURIComponent(fileToken)}?name=${encodeURIComponent(name)}`
        : '';

      return {
        fileToken,
        name,
        size: Number.isFinite(size) ? size : 0,
        mimeType,
        url: proxyUrl || directUrl,
      };
    })
    .filter((item) => item?.fileToken || item?.url);
}

function isImageAttachment(attachment) {
  const extension = getFileExtension(attachment.name);
  return attachment.mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension);
}

function isVideoAttachment(attachment) {
  const extension = getFileExtension(attachment.name);
  return attachment.mimeType.startsWith('video/') || ['mp4', 'webm', 'ogg', 'mov', 'm4v'].includes(extension);
}

function getFileExtension(name) {
  const matched = String(name || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return matched ? matched[1] : '';
}

function normalizeCheckboxValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const text = normalizeDisplayText(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'y', '是', '勾选', '已勾选'].includes(text);
}

function formatBitableDate(value) {
  const timestamp = normalizeDateDisplayTimestamp(value);
  if (!timestamp) {
    return normalizeDisplayText(value) || '未填写';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function normalizeDateDisplayTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    const timestamp = value < 10000000000 ? value * 1000 : value;
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return normalizeDateDisplayTimestamp(numeric);
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (Array.isArray(value)) {
    return normalizeDateDisplayTimestamp(value[0]);
  }

  if (typeof value === 'object') {
    return normalizeDateDisplayTimestamp(value.timestamp || value.date || value.value || value.text);
  }

  return null;
}

function normalizeNumberDisplayValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const number = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  if (Array.isArray(value)) {
    return normalizeNumberDisplayValue(value[0]);
  }

  if (value && typeof value === 'object') {
    return normalizeNumberDisplayValue(value.value || value.text || value.number);
  }

  return null;
}

function formatCurrencyValue(value) {
  const text = normalizeDisplayText(value);
  return text || '未填写';
}

function formatFileSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '大小未知';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeDisplayText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }

  if (Array.isArray(value)) {
    const delimiter = shouldJoinArrayWithoutSeparator(value) ? '' : '、';
    return value.map((item) => normalizeDisplayText(item)).filter(Boolean).join(delimiter);
  }

  if (typeof value === 'object') {
    if (Array.isArray(value.value)) {
      return normalizeDisplayText(value.value);
    }

    const directValue = value.text ?? value.name ?? value.title ?? value.link ?? value.url ?? value.value ?? value.en_name;
    if (directValue !== undefined && directValue !== value) {
      return normalizeDisplayText(directValue);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function shouldJoinArrayWithoutSeparator(value) {
  return value.every((item) => item && typeof item === 'object' && !('name' in item) && !('file_token' in item) && !('fileToken' in item));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function mapBitableOptionColor(colorId) {
  const colorMap = {
    0: '#dee0e3',
    1: '#f54a45',
    2: '#ff8f1f',
    3: '#f5c400',
    4: '#34c724',
    5: '#20d2a8',
    6: '#1fb6ff',
    7: '#3370ff',
    8: '#8f4bff',
    9: '#f759ab',
    10: '#c9cdd4',
    11: '#fbbfbc',
    12: '#fed4a4',
    13: '#ffec8a',
    14: '#b7edb1',
    15: '#a9efe6',
    16: '#a6d8ff',
    17: '#bacefd',
    18: '#d7b9ff',
    19: '#ffc2e6',
    20: '#8f959e',
    21: '#d83931',
    22: '#de7802',
    23: '#dc9b04',
    24: '#2ea121',
    25: '#10a893',
    26: '#0788d8',
    27: '#245bdb',
    28: '#6425d0',
    29: '#c2287f',
    30: '#646a73',
    31: '#991b1b',
    32: '#a04a00',
    33: '#8f6b00',
    34: '#1f7a1f',
    35: '#0f766e',
    36: '#0c63b7',
    37: '#1d4ed8',
    38: '#581c87',
    39: '#9d174d',
    40: '#373c43',
  };

  return colorMap[Number(colorId)] || '';
}

function buildSoftColor(color) {
  const rgb = hexToRgb(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.1)` : '';
}

function buildBorderColor(color) {
  const rgb = hexToRgb(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)` : '';
}

function hexToRgb(color) {
  const normalized = String(color || '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }

  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function isSameDisplayUser(left, right) {
  const leftKeys = buildDisplayUserKeys(left);
  const rightKeys = buildDisplayUserKeys(right);

  for (const key of leftKeys) {
    if (rightKeys.has(key)) {
      return true;
    }
  }

  return false;
}

function buildDisplayUserSetKey(users) {
  return [...new Set((users || []).map(getDisplayUserStableKey).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .join('|');
}

function getDisplayUserStableKey(user) {
  return String(user?.openId || user?.unionId || user?.userId || user?.email || user?.id || user?.name || '').trim();
}

function formatPeopleNames(users) {
  const names = (users || []).map((user) => normalizeDisplayText(user?.name || user?.openId || user?.id)).filter(Boolean);
  return names.length > 0 ? names.join('、') : '无';
}

function buildDisplayUserKeys(user) {
  return new Set(
    [user?.openId, user?.unionId, user?.userId, user?.email, user?.name, user?.id]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
}

async function waitForFeishuRuntime() {
  const isFeishuClient = isFeishuUserAgent();

  if (!window.h5sdk && !window.tt && !isFeishuClient) {
    return {
      available: false,
      message: '请在飞书客户端中打开',
    };
  }

  await ensureH5SdkScript();

  const sdkReady = await waitForH5SdkReady();
  const tt = window.tt;
  const hasRequestAccess = typeof tt?.requestAccess === 'function';
  const hasRequestAuthCode = typeof tt?.requestAuthCode === 'function';

  if (sdkReady && (hasRequestAccess || hasRequestAuthCode)) {
    return {
      available: true,
      requestAccess: hasRequestAccess ? tt.requestAccess.bind(tt) : null,
      requestAuthCode: hasRequestAuthCode ? tt.requestAuthCode.bind(tt) : null,
    };
  }

  if (isFeishuClient) {
    return {
      available: false,
      message: '飞书客户端能力未就绪，请刷新或检查网页应用配置',
    };
  }

  return {
    available: false,
    message: '请在飞书客户端中打开',
  };
}

function ensureH5SdkScript() {
  if (window.h5sdk || document.querySelector('script[data-feishu-h5-sdk="true"]')) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = FEISHU_H5_SDK_URL;
    script.async = true;
    script.dataset.feishuH5Sdk = 'true';
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
}

function waitForH5SdkReady() {
  const maxWaitMs = 8000;
  const checkEveryMs = 150;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      if (typeof window.h5sdk?.ready === 'function') {
        window.h5sdk.ready(() => resolve(true));
        return;
      }

      if (typeof window.tt?.requestAccess === 'function' || typeof window.tt?.requestAuthCode === 'function') {
        resolve(true);
        return;
      }

      if (Date.now() - startedAt >= maxWaitMs) {
        resolve(false);
        return;
      }

      window.setTimeout(check, checkEveryMs);
    };

    check();
  });
}

async function getFeishuAuthCode(feishuRuntime, appId) {
  try {
    if (feishuRuntime.requestAccess) {
      return await requestAccessCode(feishuRuntime.requestAccess, appId, FEISHU_USER_SCOPES);
    }
  } catch (error) {
    if (feishuRuntime.requestAccess && shouldRetryWithoutOptionalScopes(error)) {
      return await requestAccessCode(feishuRuntime.requestAccess, appId, []);
    }

    if (!shouldFallbackToRequestAuthCode(error) || !feishuRuntime.requestAuthCode) {
      throw error;
    }
  }

  if (feishuRuntime.requestAuthCode) {
    return requestAuthCode(feishuRuntime.requestAuthCode, appId);
  }

  throw new Error('飞书客户端不支持当前免登接口');
}

function requestAccessCode(requestAccess, appId, scopeList = []) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback) => (value) => {
      if (settled) {
        return;
      }

      settled = true;
      callback(value);
    };

    try {
      requestAccess({
        appID: appId,
        scopeList,
        success: finish((result) => {
          const code = getCodeFromResult(result);
          if (!code) {
            reject(new Error('飞书没有返回授权码'));
            return;
          }
          resolve(code);
        }),
        fail: finish((error) => {
          reject(createFeishuError(error));
        }),
        complete: () => {},
      });
    } catch (error) {
      reject(error);
    }
  });
}

function requestAuthCode(requestAuthCodeApi, appId) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback) => (value) => {
      if (settled) {
        return;
      }

      settled = true;
      callback(value);
    };

    try {
      requestAuthCodeApi({
        appId,
        success: finish((result) => {
          const code = getCodeFromResult(result);
          if (!code) {
            reject(new Error('飞书没有返回授权码'));
            return;
          }
          resolve(code);
        }),
        fail: finish((error) => {
          reject(createFeishuError(error));
        }),
        complete: () => {},
      });
    } catch (error) {
      reject(error);
    }
  });
}

function getCodeFromResult(result) {
  return result?.code || result?.authCode || result?.auth_code || '';
}

function createFeishuError(error) {
  const rawMessage = error?.errString || error?.errMsg || error?.message || '飞书授权失败';
  const message = normalizeFeishuAuthError(rawMessage, error?.errno);
  const feishuError = new Error(message);
  feishuError.errno = error?.errno;
  feishuError.rawMessage = rawMessage;
  return feishuError;
}

function shouldFallbackToRequestAuthCode(error) {
  return error?.errno === 103;
}

function shouldRetryWithoutOptionalScopes(error) {
  const message = `${error?.message || ''} ${error?.rawMessage || ''}`;
  return error?.errno === 2700002
    || message.includes('Authorization terminated unexpectedly')
    || message.includes('99991679');
}

function normalizeFeishuAuthError(message, errno) {
  if (errno === 2700002 || String(message).includes('Authorization terminated unexpectedly')) {
    return '飞书用户授权被中断，请关闭当前网页应用后重新打开';
  }

  return message;
}

function isFeishuUserAgent() {
  const userAgent = navigator.userAgent.toLowerCase();
  return userAgent.includes('feishu') || userAgent.includes('lark');
}

function formatProjectTitle(project) {
  return `${project.projectName || '未命名项目'} (${project.projectId || '无ID'})`;
}

function getProjectTools(project) {
  const tools = Array.isArray(project?.allowedTools) && project.allowedTools.length > 0
    ? project.allowedTools
    : PROJECT_TOOLS;
  const normalizedTools = tools
    .map((tool) => PROJECT_TOOLS.find((item) => item.id === tool.id) || tool)
    .filter((tool) => tool?.id && tool?.label);

  if (!normalizedTools.some((tool) => tool.id === 'overview')) {
    return [PROJECT_TOOLS[0], ...normalizedTools];
  }

  return normalizedTools;
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
