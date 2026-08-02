import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Bug,
  CircleHelp,
  ClipboardList,
  ExternalLink,
  Link2,
  LoaderCircle,
  MessageSquareReply,
  Paperclip,
  Send,
  Sparkles,
  Trash2,
  Unlink2,
  X,
} from 'lucide-react';
import {
  DEADLINE_FILTER_OPTIONS,
  compareWorkItemStatus,
  createEmptyWorkItemFilters,
  filterWorkItems,
  getWorkItemPersonKey,
  getWorkItemProcessingStatus,
  getWorkItemProcessingStatuses,
  getWorkItemStatus,
  getWorkItemWaitingStatus,
  hasActiveAdvancedWorkItemFilters,
  hasActiveWorkItemFilters,
  isStatusGroupDefaultCollapsed,
  shouldShowWorkItemRemainingTime,
} from '../workItemListUtils.js';
import {
  clearLocalDraft,
  createDraftKey,
  createLocalCacheUserKey,
  createProjectsSnapshotKey,
  createWorkItemsSnapshotKey,
  getCachedSnapshot,
  getLocalDraft,
  initializeLocalCache,
  readLocalPreference,
  saveCachedSnapshot,
  saveLocalDraft,
  writeLocalPreference,
} from '../localCache.js';
import {
  countWaitingAssignedWorkItems,
  removeWorkItemByRecordId,
  replaceWorkItemByRecordId,
} from '../../../shared/workItemRealtimeUtils.js';
import {
  canManageWorkItemAssignees,
  getAssignmentNotificationTargetLabel,
  supportsUnassignedWorkItemRouting,
  validateWorkItemAssignmentChoice,
} from '../../../shared/workItemAssignmentUtils.js';
import {
  getSubmissionAttachmentToken,
  shouldConfirmStatusUpdateWithoutSubmissionAttachments,
} from '../../../shared/requirementSubmissionAttachmentUtils.js';
import {
  FEEDBACK_LEGACY_ACTIVE_STATUSES,
  FEEDBACK_STATUSES,
  PROJECT_TOOL_DEFINITIONS as PROJECT_TOOLS,
  REQUIREMENT_PRIORITIES,
  WORK_ITEM_TOOL_DEFINITIONS as WORK_ITEM_TOOL_CONFIGS,
} from '../../../shared/workItemDefinitions.js';
import { FEEDBACK_RESOLUTION_TYPES } from '../../../shared/feedbackResolutionUtils.js';
import {
  WORK_ITEM_VERSION_ASSOCIATION_CONFIRMATION_TYPE,
  WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS,
} from '../../../shared/workItemVersionAssociationUtils.js';
import {
  fetchProjects,
  fetchRelatedWorkItemCounts,
} from '../../api/projects.js';
import {
  appendRecordComment,
  changeWorkItemAssignees,
  createWorkItemClientMutationId,
  createWorkItem,
  deleteRecordComment,
  deleteWorkItem,
  ensureProjectWorkItems,
  fetchWorkItemRecord,
  resolveFeedback,
  updateRequirementSubmissionAttachments,
  updateWorkItem,
  updateWorkItemStatus as updateRequirementStatus,
} from '../../api/workItems.js';
import { ProjectOverview } from '../ProjectOverview.jsx';
import { VersionManagement } from '../versions/VersionManagement.jsx';
import { AiPlanLibrary } from '../ai/AiPlanLibrary.jsx';
import { AiPlanningWorkspace } from '../ai/AiPlanningWorkspace.jsx';
import { TestTaskManagement } from '../test-tasks/TestTaskManagement.jsx';
import { fetchAiProjectActivity } from '../../api/aiPlans.js';
import {
  getProjectToolPendingCount,
  getProjectToolsForDisplay,
  isDevelopmentProjectTool,
  isProjectToolPendingCountTool,
  normalizeRelatedWorkItemCounts,
} from './projectToolDisplayUtils.js';
import { getProjectToolIcon } from './projectToolIcons.js';
import {
  buildDisplayFields,
  buildDisplayUserKeys,
  buildDisplayUserSetKey,
  buildEditableFieldInitialValues,
  buildBorderColor,
  buildSoftColor,
  findFieldOption,
  formatBitableDate,
  formatCurrencyValue,
  formatDateTimeLocalInput,
  formatFileSize,
  formatPeopleNames,
  getEditableFieldTypeLabel,
  getFieldSelectOptionNames,
  isAttachmentField,
  isCheckboxField,
  isCurrencyField,
  isDateField,
  isEmptyBitableValue,
  isFeedbackContactInfoField,
  isHttpUrl,
  isImageAttachment,
  isMultiSelectField,
  isNumberLikeEditableField,
  isProgressField,
  isRatingField,
  isSameDisplayUser,
  isSelectField,
  isUrlField,
  isUserField,
  isVideoAttachment,
  mapBitableOptionColor,
  normalizeAttachmentItems,
  normalizeCheckboxValue,
  normalizeDateDisplayTimestamp,
  normalizeDisplayText,
  normalizeEditableFeedbackContactInfo,
  normalizeFieldUsers,
  normalizeNumberDisplayValue,
  normalizeSelectItems,
  normalizeUrlItems,
  parseFeedbackContactInfoForClient,
  toEditableAttachmentPayload,
} from '../work-items/workItemFieldUtils.js';
import { WorkItemTimelinePanel } from '../work-items/WorkItemTimelinePanel.jsx';
import {
  HomePanel,
  ProjectIcon,
  ProjectSidebar,
} from './ProjectNavigation.jsx';

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

const INITIAL_AI_ACTIVITY_STATE = {
  status: 'idle',
  message: '',
  tasks: [],
  items: [],
  pendingReviewCount: 0,
  activeTaskCount: 0,
  allowedToolIds: [],
};

export function PlatformWorkspace({ user, cacheUserKey }) {
  const [activeView, setActiveView] = useState('home');
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectOpenSequence, setProjectOpenSequence] = useState(0);
  const [projectState, setProjectState] = useState(INITIAL_PROJECT_STATE);
  const [relatedWorkItemCounts, setRelatedWorkItemCounts] = useState({});
  const [realtimeEvent, setRealtimeEvent] = useState(null);
  const [directTarget] = useState(() => parseDirectTargetFromLocation());
  const [directNotice, setDirectNotice] = useState({ type: 'idle', message: '' });
  const processedDirectKeyRef = useRef('');
  const projectCountKey = projectState.status === 'ready'
    ? projectState.projects.map((project) => String(project.projectId || '').trim()).filter(Boolean).join('|')
    : '';

  useEffect(() => {
    let isActive = true;

    async function loadProjects() {
      let cachedSnapshot = null;
      try {
        cachedSnapshot = await getCachedSnapshot(createProjectsSnapshotKey(cacheUserKey));
        if (cachedSnapshot && isActive) {
          setProjectState({
            status: 'ready',
            message: buildLocalCacheMessage(cachedSnapshot.savedAt, true),
            projects: Array.isArray(cachedSnapshot.value?.projects) ? cachedSnapshot.value.projects : [],
          });
        }

        const payload = await fetchProjects();
        await saveCachedSnapshot(cacheUserKey, createProjectsSnapshotKey(cacheUserKey), payload);
        if (isActive) {
          setProjectState({
            status: 'ready',
            message: '',
            projects: Array.isArray(payload.projects) ? payload.projects : [],
          });
        }
      } catch (error) {
        if (isActive) {
          if (cachedSnapshot) {
            setProjectState({
              status: 'ready',
              message: buildLocalCacheMessage(cachedSnapshot.savedAt, false, formatErrorMessage(error)),
              projects: Array.isArray(cachedSnapshot.value?.projects) ? cachedSnapshot.value.projects : [],
            });
          } else {
            setProjectState({
              status: 'error',
              message: formatErrorMessage(error),
              projects: [],
            });
          }
        }
      }
    }

    loadProjects();

    return () => {
      isActive = false;
    };
  }, [cacheUserKey]);

  useEffect(() => {
    if (!projectCountKey) {
      setRelatedWorkItemCounts({});
      return undefined;
    }

    let isActive = true;

    async function loadRelatedWorkItemCounts() {
      try {
        const payload = await fetchRelatedWorkItemCounts();
        if (isActive) {
          setRelatedWorkItemCounts(normalizeRelatedWorkItemCounts(payload?.counts));
        }
      } catch {
        // Counts are supplemental and must not hide an otherwise usable project list.
      }
    }

    loadRelatedWorkItemCounts();

    return () => {
      isActive = false;
    };
  }, [projectCountKey]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return undefined;
    }

    const source = new EventSource('/api/realtime/stream');

    function handleWorkItemUpdated(event) {
      try {
        const payload = JSON.parse(event.data || '{}');
        const projectId = String(payload?.projectId || '').trim();
        const toolId = String(payload?.toolId || '').trim();
        const recordId = String(payload?.recordId || '').trim();
        if (!projectId || !toolId || !recordId) {
          return;
        }

        void refreshRelatedWorkItemCounts(projectId);
        setRealtimeEvent({
          id: `${projectId}:${toolId}:${recordId}:${payload.occurredAt || Date.now()}`,
          projectId,
          toolId,
          recordId,
          changeType: payload?.changeType === 'deleted' ? 'deleted' : 'updated',
        });
      } catch {
        // Ignore malformed realtime messages and let EventSource continue reconnecting.
      }
    }

    source.addEventListener('work-item-updated', handleWorkItemUpdated);
    return () => {
      source.removeEventListener('work-item-updated', handleWorkItemUpdated);
      source.close();
    };
  }, [cacheUserKey]);

  useEffect(() => {
    if (
      directTarget
      || projectState.status !== 'ready'
      || selectedProject
      || projectState.projects.length === 0
    ) {
      return;
    }

    const selectedRecordId = String(readLocalPreference(cacheUserKey, 'selected-project-record-id', '') || '').trim();
    const savedProject = projectState.projects.find((project) => String(project.recordId || '') === selectedRecordId);
    if (savedProject) {
      setSelectedProject(savedProject);
      setActiveView('project');
    }
  }, [cacheUserKey, directTarget, projectState, selectedProject]);

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
    writeLocalPreference(cacheUserKey, 'selected-project-record-id', '');
  }

  function handleProjectSelect(project) {
    setSelectedProject(project);
    setProjectOpenSequence((current) => current + 1);
    setActiveView('project');
    setDirectNotice({ type: 'idle', message: '' });
    writeLocalPreference(cacheUserKey, 'selected-project-record-id', project.recordId || '');
  }

  return (
    <section className="platform-body" aria-label="开发平台工作区">
      <ProjectSidebar
        projectState={projectState}
        relatedWorkItemCounts={relatedWorkItemCounts}
        activeView={activeView}
        selectedProjectId={selectedProject?.recordId || ''}
        onHomeClick={handleHomeClick}
        onProjectSelect={handleProjectSelect}
      />
      <div className="platform-main-content">
        {directNotice.message ? <DirectStatusBanner notice={directNotice} /> : null}
        {activeView === 'project' && selectedProject ? (
          <ProjectWorkspace
            key={`${selectedProject.recordId || selectedProject.projectId}:${projectOpenSequence}`}
            project={selectedProject}
            user={user}
            cacheUserKey={cacheUserKey}
            relatedWorkItemCounts={relatedWorkItemCounts?.[selectedProject.projectId]}
            realtimeEvent={realtimeEvent}
            onRelatedCountChange={handleRelatedCountChange}
            directTarget={directTarget}
            onDirectNotice={setDirectNotice}
          />
        ) : (
          <HomePanel user={user} />
        )}
      </div>
    </section>
  );

  async function refreshRelatedWorkItemCounts(projectId = '') {
    try {
      const payload = await fetchRelatedWorkItemCounts(projectId);
      const nextCounts = normalizeRelatedWorkItemCounts(payload?.counts);
      setRelatedWorkItemCounts((current) => (
        projectId
          ? {
              ...current,
              [projectId]: nextCounts[projectId] || {
                requirements: 0,
                bugs: 0,
                testTasks: 0,
                feedback: 0,
              },
            }
          : nextCounts
      ));
    } catch {
      // Keep the last known values until the next successful realtime update.
    }
  }

  function handleRelatedCountChange(projectId, toolId, count) {
    const normalizedProjectId = String(projectId || '').trim();
    const normalizedToolId = String(toolId || '').trim();
    if (!normalizedProjectId || !isProjectToolPendingCountTool(normalizedToolId)) {
      return;
    }

    setRelatedWorkItemCounts((current) => ({
      ...current,
      [normalizedProjectId]: {
        requirements: Number(current[normalizedProjectId]?.requirements || 0),
        bugs: Number(current[normalizedProjectId]?.bugs || 0),
        testTasks: Number(current[normalizedProjectId]?.testTasks || 0),
        feedback: Number(current[normalizedProjectId]?.feedback || 0),
        [normalizedToolId]: Math.max(0, Number(count) || 0),
      },
    }));
  }
}

function DirectStatusBanner({ notice }) {
  return (
    <div className={`direct-status direct-status-${notice.type}`} role="status" aria-live="polite">
      {notice.message}
    </div>
  );
}

function CacheStateNotice({ message }) {
  if (!message) {
    return null;
  }

  return <p className="cache-state-notice" role="status">{message}</p>;
}

function AiPlanningOfferDialog({ offer, onDecline, onOpen }) {
  return (
    <div className="ai-offer-backdrop" role="presentation">
      <section
        className="ai-offer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${offer.itemLabel}已提交`}
      >
        <div className="ai-offer-icon" aria-hidden="true">
          <Bot />
        </div>
        <div className="ai-offer-content">
          <h3>{offer.itemLabel}已提交</h3>
          <p>
            是否让 AI 结合当前工作项、附件和项目代码生成一份实现方案，帮助处理人更快理解、评估并推进处理？
          </p>
          {offer.submitNotice?.type === 'warning' ? (
            <span className="ai-offer-warning">{offer.submitNotice.message}</span>
          ) : null}
        </div>
        <div className="ai-offer-actions">
          <button type="button" className="ai-secondary-button" onClick={onDecline}>
            不了
          </button>
          <button type="button" className="ai-primary-button ai-offer-primary" onClick={onOpen}>
            <Bot aria-hidden="true" />
            前往 AI 生成计划
          </button>
        </div>
      </section>
    </div>
  );
}

function ProjectWorkspace({
  project,
  user,
  cacheUserKey,
  relatedWorkItemCounts,
  realtimeEvent,
  onRelatedCountChange,
  directTarget,
  onDirectNotice,
}) {
  const [activeToolId, setActiveToolId] = useState(() => getInitialWorkspacePreferences(cacheUserKey, project).activeToolId);
  const [workItemStates, setWorkItemStates] = useState(() => createInitialWorkItemStates());
  const [collapsedPriorities, setCollapsedPriorities] = useState(() => new Set(getInitialWorkspacePreferences(cacheUserKey, project).collapsedPriorities));
  const [statusCollapseOverrides, setStatusCollapseOverrides] = useState(() => getInitialWorkspacePreferences(cacheUserKey, project).statusCollapseOverrides);
  const [workItemFilters, setWorkItemFilters] = useState(() => getInitialWorkspacePreferences(cacheUserKey, project).workItemFilters);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [selectedTestTaskId, setSelectedTestTaskId] = useState('');
  const [highlightCommentId, setHighlightCommentId] = useState('');
  const [aiPlanningOffer, setAiPlanningOffer] = useState(null);
  const [aiPlanningLaunch, setAiPlanningLaunch] = useState(null);
  const [aiConversationTarget, setAiConversationTarget] = useState(null);
  const [aiActivity, setAiActivity] = useState(INITIAL_AI_ACTIVITY_STATE);
  const [aiActivityRefreshSequence, setAiActivityRefreshSequence] = useState(0);
  const processedDirectKeyRef = useRef('');
  const processedRealtimeEventRef = useRef('');
  const visibleTools = getProjectToolsForDisplay(project, PROJECT_TOOLS);
  const activeTool = visibleTools.find((tool) => tool.id === activeToolId) || visibleTools[0];
  const activeWorkItemConfig = activeToolId === 'testTasks'
    ? null
    : getWorkItemToolConfig(activeToolId);
  const activeWorkItemState = activeWorkItemConfig ? workItemStates[activeWorkItemConfig.toolId] || INITIAL_REQUIREMENTS_STATE : INITIAL_REQUIREMENTS_STATE;
  const projectName = project.projectName || '未命名项目';
  const mentionableUsersByTool = project.mentionableUsersByTool && typeof project.mentionableUsersByTool === 'object'
    ? project.mentionableUsersByTool
    : {};
  const aiActivityByWorkItem = indexAiActivityItems(aiActivity.items);

  useEffect(() => {
    const preferences = getInitialWorkspacePreferences(cacheUserKey, project);
    setActiveToolId(preferences.activeToolId);
    setWorkItemStates(createInitialWorkItemStates());
    setCollapsedPriorities(new Set(preferences.collapsedPriorities));
    setStatusCollapseOverrides(preferences.statusCollapseOverrides);
    setWorkItemFilters(preferences.workItemFilters);
    setSelectedWorkItemId('');
    setSelectedVersionId('');
    setSelectedTestTaskId('');
    setHighlightCommentId('');
    setAiPlanningOffer(null);
    setAiPlanningLaunch(null);
    setAiConversationTarget(null);
    setAiActivity(INITIAL_AI_ACTIVITY_STATE);
    processedDirectKeyRef.current = '';
    processedRealtimeEventRef.current = '';
  }, [cacheUserKey, project.recordId]);

  useEffect(() => {
    if (!visibleTools.some((tool) => tool.id === 'aiPlans')) {
      setAiActivity(INITIAL_AI_ACTIVITY_STATE);
      return undefined;
    }

    let active = true;
    let timer = null;

    async function loadAiActivity() {
      try {
        const payload = await fetchAiProjectActivity(project.projectId);
        if (!active) {
          return;
        }
        const next = normalizeAiProjectActivity(payload);
        setAiActivity({
          ...next,
          status: 'ready',
          message: '',
        });
        timer = setTimeout(
          loadAiActivity,
          next.activeTaskCount > 0 ? 5_000 : 15_000,
        );
      } catch (error) {
        if (!active) {
          return;
        }
        setAiActivity((current) => ({
          ...current,
          status: 'error',
          message: formatErrorMessage(error),
        }));
        timer = setTimeout(loadAiActivity, 15_000);
      }
    }

    void loadAiActivity();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [aiActivityRefreshSequence, project.projectId]);

  useEffect(() => {
    writeLocalPreference(cacheUserKey, getWorkspacePreferenceName(project), {
      activeToolId,
      collapsedPriorities: [...collapsedPriorities],
      statusCollapseOverrides,
      workItemFilters,
    });
  }, [activeToolId, cacheUserKey, collapsedPriorities, project, statusCollapseOverrides, workItemFilters]);

  useEffect(() => {
    if (!directTarget || directTarget.projectId !== String(project.projectId || '') || processedDirectKeyRef.current === directTarget.key) {
      return;
    }

    processedDirectKeyRef.current = directTarget.key;
    openDirectTarget(directTarget);
  }, [directTarget, project.recordId]);

  useEffect(() => {
    if (
      !realtimeEvent
      || realtimeEvent.projectId !== String(project.projectId || '')
      || processedRealtimeEventRef.current === realtimeEvent.id
    ) {
      return;
    }

    const toolConfig = getWorkItemToolConfig(realtimeEvent.toolId);
    const targetState = toolConfig ? workItemStates[toolConfig.toolId] : null;
    if (!toolConfig || targetState?.status !== 'ready') {
      return;
    }

    processedRealtimeEventRef.current = realtimeEvent.id;

    if (realtimeEvent.changeType === 'deleted') {
      updateWorkItemState(
        toolConfig.toolId,
        (currentState) => removeWorkItemFromState(currentState, realtimeEvent.recordId, toolConfig),
      );
      setSelectedWorkItemId((current) => (
        current === realtimeEvent.recordId ? '' : current
      ));
      return;
    }

    async function refreshChangedWorkItem() {
      await refreshWorkItemFromServer(toolConfig, realtimeEvent.recordId);
    }

    refreshChangedWorkItem();
  }, [project.projectId, realtimeEvent, workItemStates]);

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
    const selectedTool = visibleTools.find((tool) => tool.id === toolId);
    if (!selectedTool || isDevelopmentProjectTool(selectedTool)) {
      return;
    }

    setActiveToolId(toolId);
    setHighlightCommentId('');
    onDirectNotice?.({ type: 'idle', message: '' });

    const toolConfig = getWorkItemToolConfig(toolId);
    if (toolId === 'testTasks') {
      setSelectedWorkItemId('');
      return;
    }
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
    if (toolId === 'testTasks') {
      setSelectedTestTaskId(String(target.recordId || '').trim());
      setSelectedWorkItemId('');
      setHighlightCommentId('');
      onDirectNotice?.({ type: 'idle', message: '' });
      return;
    }
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
    let cachedSnapshot = null;
    setSelectedWorkItemId('');
    setHighlightCommentId('');
    setWorkItemState(toolConfig.toolId, {
      status: 'loading',
      message: toolConfig.loadingText,
      result: null,
    });

    try {
      cachedSnapshot = await getCachedSnapshot(createWorkItemsSnapshotKey(cacheUserKey, project.projectId, toolConfig.toolId));
      if (cachedSnapshot) {
        const cachedPayload = cachedSnapshot.value;
        const cachedTargetItem = targetRecordId
          ? getPayloadWorkItems(cachedPayload, toolConfig).find((item) => isRequirementTarget(item, targetRecordId))
          : null;
        setWorkItemState(toolConfig.toolId, {
          status: 'ready',
          message: buildLocalCacheMessage(cachedSnapshot.savedAt, true),
          result: cachedPayload,
        });
        if (cachedTargetItem) {
          setSelectedWorkItemId(getRequirementStableId(cachedTargetItem));
          setHighlightCommentId(targetCommentId);
        }
      }
    } catch {
      cachedSnapshot = null;
    }

    try {
      const payload = await ensureProjectWorkItems(project.projectId, toolConfig);
      const items = getPayloadWorkItems(payload, toolConfig);
      const targetItem = targetRecordId
        ? items.find((item) => isRequirementTarget(item, targetRecordId))
        : null;
      await saveCachedSnapshot(cacheUserKey, createWorkItemsSnapshotKey(cacheUserKey, project.projectId, toolConfig.toolId), payload);
      setWorkItemState(toolConfig.toolId, {
        status: 'ready',
        message: '',
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
      if (cachedSnapshot) {
        setWorkItemState(toolConfig.toolId, {
          status: 'ready',
          message: buildLocalCacheMessage(cachedSnapshot.savedAt, false, formatErrorMessage(error)),
          result: cachedSnapshot.value,
        });
      } else {
        setWorkItemState(toolConfig.toolId, {
          status: 'error',
          message: formatErrorMessage(error),
          result: error.payload?.result || null,
        });
      }
      if (options.fromDirect) {
        onDirectNotice?.({ type: 'error', message: formatErrorMessage(error) });
      }
    }
  }

  function setWorkItemState(toolId, state) {
    notifyRelatedCount(toolId, state);
    setWorkItemStates((current) => ({
      ...current,
      [toolId]: state,
    }));
  }

  function updateWorkItemState(toolId, update) {
    setWorkItemStates((current) => {
      const nextState = update(current[toolId]);
      if (nextState?.status === 'ready' && nextState.result) {
        void saveCachedSnapshot(
          cacheUserKey,
          createWorkItemsSnapshotKey(cacheUserKey, project.projectId, toolId),
          nextState.result,
        );
        notifyRelatedCount(toolId, nextState);
      }
      return {
        ...current,
        [toolId]: nextState,
      };
    });
  }

  function notifyRelatedCount(toolId, state) {
    if (state?.status !== 'ready' || !state.result) {
      return;
    }

    onRelatedCountChange?.(
      project.projectId,
      toolId,
      countWaitingAssignedWorkItems(toolId, getPayloadWorkItems(state.result, getWorkItemToolConfig(toolId)), user),
    );
  }

  async function refreshWorkItemFromServer(toolConfig, recordId) {
    try {
      const payload = await fetchWorkItemRecord(project.projectId, toolConfig, recordId);
      if (payload.item) {
        updateWorkItemState(
          toolConfig.toolId,
          (currentState) => updateRequirementInState(currentState, payload.item, toolConfig),
        );
      }
    } catch {
      // The next list refresh will reconcile records that were deleted or made unavailable.
    }
  }

  function handleWorkItemUpdated(toolConfig, requirement) {
    updateWorkItemState(
      toolConfig.toolId,
      (currentState) => updateRequirementInState(currentState, requirement, toolConfig),
    );
    setSelectedWorkItemId(getRequirementStableId(requirement));
    void refreshWorkItemFromServer(toolConfig, requirement.recordId);
  }

  async function handleOverviewItemOpen(item) {
    if (item?.toolId === 'testTasks') {
      if (!visibleTools.some((tool) => tool.id === 'testTasks')) {
        onDirectNotice?.({ type: 'error', message: '没有权限查看该测试任务' });
        return;
      }
      setSelectedTestTaskId(String(item?.recordId || '').trim());
      setActiveToolId('testTasks');
      return;
    }
    const toolConfig = getWorkItemToolConfig(item?.toolId);
    if (!toolConfig || !visibleTools.some((tool) => tool.id === toolConfig.toolId)) {
      onDirectNotice?.({ type: 'error', message: '没有权限查看该工作项' });
      return;
    }

    setActiveToolId(toolConfig.toolId);
    await loadWorkItems(toolConfig, {
      recordId: item?.recordId,
      commentId: item?.commentId,
    });
  }

  async function handleRelatedWorkItemOpen(toolId, recordId) {
    const toolConfig = getWorkItemToolConfig(toolId);
    if (
      !toolConfig
      || !recordId
      || !visibleTools.some((tool) => tool.id === toolConfig.toolId)
    ) {
      onDirectNotice?.({ type: 'error', message: '没有权限查看关联工作项' });
      return;
    }
    setActiveToolId(toolConfig.toolId);
    await loadWorkItems(toolConfig, { recordId });
  }

  async function handleOverviewStatusOpen(toolId, statuses) {
    if (toolId === 'testTasks') {
      setActiveToolId('testTasks');
      return;
    }
    const toolConfig = getWorkItemToolConfig(toolId);
    if (!toolConfig || !visibleTools.some((tool) => tool.id === toolConfig.toolId)) {
      onDirectNotice?.({ type: 'error', message: '没有权限查看该列表' });
      return;
    }

    setWorkItemFilters((current) => ({
      ...current,
      [toolConfig.toolId]: {
        ...createEmptyWorkItemFilters(),
        statuses: [...new Set((statuses || []).map((status) => String(status || '').trim()).filter(Boolean))],
      },
    }));
    setActiveToolId(toolConfig.toolId);
    await loadWorkItems(toolConfig);
  }

  function handleOverviewVersionOpen(version) {
    const recordId = String(version?.recordId || '').trim();
    if (!recordId || !visibleTools.some((tool) => tool.id === 'versions')) {
      onDirectNotice?.({ type: 'error', message: '没有权限查看该版本' });
      return;
    }
    setSelectedVersionId(recordId);
    setActiveToolId('versions');
    onDirectNotice?.({ type: 'idle', message: '' });
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
            {visibleTools.map((tool) => {
              const ToolIcon = getProjectToolIcon(tool.iconKey);
              const isDevelopmentTool = isDevelopmentProjectTool(tool);
              const pendingCount = tool.id === 'aiPlans'
                ? aiActivity.pendingReviewCount
                : getProjectToolPendingCount(relatedWorkItemCounts, tool.id);
              const pendingLabel = tool.id === 'aiPlans'
                ? '待审核'
                : tool.id === 'testTasks'
                  ? '待办'
                  : tool.id === 'feedback'
                    ? '待分类'
                    : '未处理';
              return (
                <button
                  key={tool.id}
                  type="button"
                  className={[
                    'project-tool-button',
                    `project-tool-button-${tool.id}`,
                    activeToolId === tool.id ? 'is-active' : '',
                    pendingCount > 0 ? 'has-pending-count' : '',
                    isDevelopmentTool ? 'is-development' : '',
                  ].filter(Boolean).join(' ')}
                  aria-label={
                    isDevelopmentTool
                      ? `${tool.label}，${tool.statusText}`
                      : pendingCount > 0
                        ? `${tool.label}，${pendingCount}${pendingLabel}`
                        : tool.label
                  }
                  aria-pressed={activeToolId === tool.id}
                  disabled={isDevelopmentTool}
                  onClick={isDevelopmentTool ? undefined : () => handleToolClick(tool.id)}
                >
                  <ToolIcon className="project-tool-icon" aria-hidden="true" />
                  <span className="project-tool-copy">
                    <span className="project-tool-label">{tool.label}</span>
                    {isDevelopmentTool ? (
                      <span className="project-tool-development-status">（{tool.statusText}）</span>
                    ) : null}
                  </span>
                  {pendingCount > 0 ? (
                    <span className="project-tool-pending-badge">{pendingCount}{pendingLabel}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </aside>

        <section className="project-detail-panel" aria-label={`${activeTool.label}内容`}>
          <div className={[
            'project-detail-surface',
            activeWorkItemConfig ? 'project-detail-surface-requirements' : '',
            activeToolId === 'overview' ? 'project-detail-surface-overview' : '',
            activeToolId === 'versions' ? 'project-detail-surface-versions' : '',
            activeToolId === 'aiPlans' ? 'project-detail-surface-ai-plans' : '',
            activeToolId === 'testTasks' ? 'project-detail-surface-test-tasks' : '',
          ].filter(Boolean).join(' ')}>
            {!activeWorkItemConfig && !['overview', 'versions', 'aiPlans', 'testTasks'].includes(activeToolId) ? (
              <>
                <p className="project-detail-eyebrow">{activeTool.label}</p>
                <h1>{projectName}</h1>
                <p className="project-detail-summary">当前项目 {formatProjectTitle(project)}</p>
              </>
            ) : null}
            {activeToolId === 'overview' ? (
              <ProjectOverview
                project={project}
                cacheUserKey={cacheUserKey}
                realtimeEvent={realtimeEvent}
                onOpenItem={handleOverviewItemOpen}
                onOpenStatus={handleOverviewStatusOpen}
                onOpenVersion={handleOverviewVersionOpen}
              />
            ) : null}
            {activeToolId === 'versions' ? (
              <VersionManagement
                project={project}
                user={user}
                cacheUserKey={cacheUserKey}
                realtimeEvent={realtimeEvent}
                directTarget={directTarget}
                targetRecordId={selectedVersionId}
                onDirectNotice={onDirectNotice}
              />
            ) : null}
            {activeToolId === 'aiPlans' ? (
              <AiPlanLibrary
                project={project}
                activity={aiActivity}
                onActivityChange={() => setAiActivityRefreshSequence((current) => current + 1)}
                directTarget={
                  directTarget?.type === 'ai-plan'
                  && directTarget.projectId === String(project.projectId || '')
                    ? directTarget
                    : null
                }
                onOpenWorkItem={(toolId, recordId, aiTarget = null) => {
                  const toolConfig = getWorkItemToolConfig(toolId);
                  if (toolConfig) {
                    setAiConversationTarget(aiTarget
                      ? {
                          key: `ai-activity-${Date.now()}-${aiTarget.conversationId || recordId}`,
                          type: 'ai-conversation',
                          projectId: String(project.projectId || ''),
                          toolId,
                          recordId,
                          conversationId: aiTarget.conversationId || '',
                          focus: aiTarget.focus || '',
                        }
                      : null);
                    setActiveToolId(toolId);
                    void loadWorkItems(toolConfig, { recordId });
                  }
                }}
              />
            ) : null}
            {activeToolId === 'testTasks' ? (
              <TestTaskManagement
                project={project}
                user={user}
                cacheUserKey={cacheUserKey}
                realtimeEvent={realtimeEvent}
                directTarget={selectedTestTaskId
                  ? {
                      key: `test-task:${selectedTestTaskId}`,
                      projectId: String(project.projectId || ''),
                      toolId: 'testTasks',
                      recordId: selectedTestTaskId,
                    }
                  : directTarget}
                onDirectNotice={onDirectNotice}
                onPendingCountChange={(count) => onRelatedCountChange?.(
                  project.projectId,
                  'testTasks',
                  count,
                )}
              />
            ) : null}
            {activeWorkItemConfig ? (
              <RequirementsStatus
                toolConfig={activeWorkItemConfig}
                state={activeWorkItemState}
                user={user}
                cacheUserKey={cacheUserKey}
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
                mentionableUsersByTool={mentionableUsersByTool}
                allowedToolIds={visibleTools.map((tool) => tool.id)}
                isSuperAdmin={Boolean(project.isSuperAdmin)}
                isDevelopmentSuperAdmin={Boolean(project.isDevelopmentSuperAdmin)}
                aiPlanningEnabled={Boolean(
                  project.aiPlanning?.enabled
                  && project.aiPlanning?.supportedToolIds?.includes(activeWorkItemConfig.toolId)
                )}
                aiPlanningUnavailableReason={
                  project.aiPlanning?.supportedToolIds?.includes(activeWorkItemConfig.toolId)
                    ? project.aiPlanning?.unavailableReason || ''
                    : ''
                }
                aiActivityByWorkItem={aiActivityByWorkItem}
                aiDirectTarget={
                  aiConversationTarget?.type === 'ai-conversation'
                  && aiConversationTarget.toolId === activeWorkItemConfig.toolId
                    ? aiConversationTarget
                    : directTarget?.type === 'ai-conversation'
                  && directTarget.projectId === String(project.projectId || '')
                  && directTarget.toolId === activeWorkItemConfig.toolId
                    ? directTarget
                    : null
                }
                onAiDirectTargetConsumed={aiConversationTarget
                  ? () => setAiConversationTarget(null)
                  : undefined}
                aiLaunchRequest={
                  aiPlanningLaunch?.toolId === activeWorkItemConfig.toolId
                    ? aiPlanningLaunch
                    : null
                }
                onAiLaunchConsumed={() => setAiPlanningLaunch(null)}
                onAiActivityChange={() => setAiActivityRefreshSequence((current) => current + 1)}
                onWorkItemCreated={(payload) => {
                  const createdItem = payload.item || payload.requirement;
                  updateWorkItemState(
                    activeWorkItemConfig.toolId,
                    (currentState) => mergeCreatedWorkItemsIntoState(currentState, payload, activeWorkItemConfig),
                  );
                  if (createdItem) {
                    setSelectedWorkItemId(getRequirementStableId(createdItem));
                  }
                  const notificationCount = (payload.notificationResults || []).filter((item) => item.ok).length;
                  const targetLabel = getAssignmentNotificationTargetLabel(payload.assignmentEscalated);
                  const submitNotice = payload.submitNotice?.message
                    ? payload.submitNotice
                    : {
                        type: 'success',
                        message: notificationCount > 0
                          ? `${activeWorkItemConfig.itemLabel}已提交，已通知 ${notificationCount} 个${targetLabel}`
                          : `${activeWorkItemConfig.itemLabel}已提交`,
                      };
                  const shouldOfferAiPlanning = Boolean(
                    createdItem
                    && ['requirements', 'bugs'].includes(activeWorkItemConfig.toolId)
                    && Array.isArray(project.departments)
                    && project.departments.includes('研发')
                    && project.aiPlanning?.enabled
                    && project.aiPlanning?.supportedToolIds?.includes(activeWorkItemConfig.toolId)
                    && !project.aiPlanning?.unavailableReason
                  );
                  if (shouldOfferAiPlanning) {
                    setAiPlanningOffer({
                      toolId: activeWorkItemConfig.toolId,
                      itemLabel: activeWorkItemConfig.itemLabel,
                      recordId: createdItem.recordId,
                      title: createdItem.title || activeWorkItemConfig.unnamedTitle,
                      submitNotice,
                    });
                  } else {
                    onDirectNotice?.(submitNotice);
                  }
                }}
                onRequirementUpdated={(requirement) => handleWorkItemUpdated(activeWorkItemConfig, requirement)}
                onOpenRelatedItem={handleRelatedWorkItemOpen}
                onRequirementDeleted={(payload) => {
                  updateWorkItemState(
                    activeWorkItemConfig.toolId,
                    (currentState) => mergeCreatedWorkItemsIntoState(currentState, payload, activeWorkItemConfig),
                  );
                  setHighlightCommentId('');
                  setSelectedWorkItemId('');
                }}
              />
            ) : null}
          </div>
        </section>
      </div>
      {aiPlanningOffer ? (
        <AiPlanningOfferDialog
          offer={aiPlanningOffer}
          onDecline={() => {
            onDirectNotice?.(aiPlanningOffer.submitNotice);
            setAiPlanningOffer(null);
          }}
          onOpen={() => {
            const actionLabel = aiPlanningOffer.toolId === 'bugs' ? '修复' : '实现';
            onDirectNotice?.(aiPlanningOffer.submitNotice);
            setAiPlanningLaunch({
              key: `ai-offer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
              toolId: aiPlanningOffer.toolId,
              recordId: aiPlanningOffer.recordId,
              clientMutationId: `ai-offer-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
              defaultPrompt: `请结合当前${aiPlanningOffer.itemLabel}、附件和项目代码，生成一份可执行的${actionLabel}计划；如果存在关键不确定项，请先向我提问。`,
            });
            setAiPlanningOffer(null);
          }}
        />
      ) : null}
    </section>
  );
}

function RequirementsStatus({
  toolConfig,
  state,
  user,
  cacheUserKey,
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
  mentionableUsersByTool,
  allowedToolIds,
  isSuperAdmin,
  isDevelopmentSuperAdmin,
  aiPlanningEnabled,
  aiPlanningUnavailableReason,
  aiActivityByWorkItem,
  aiDirectTarget,
  onAiDirectTargetConsumed,
  aiLaunchRequest,
  onAiLaunchConsumed,
  onAiActivityChange,
  onWorkItemCreated,
  onRequirementUpdated,
  onOpenRelatedItem,
  onRequirementDeleted,
}) {
  const [submitOpen, setSubmitOpen] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);

  useEffect(() => {
    setAdvancedFiltersOpen(false);
  }, [toolConfig.toolId]);

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

  function handleRelatedSummaryView(view) {
    const userKey = getWorkItemPersonKey(user);
    const assigneeKeys = getRelatedAssigneeFilterKeys(requirements, user);
    if (!userKey && assigneeKeys.length === 0) {
      return;
    }

    const nextFilters = {
      ...createEmptyWorkItemFilters(),
      assigneeKeys: assigneeKeys.length > 0 ? assigneeKeys : [userKey],
    };

    if (view === 'processing') {
      nextFilters.statuses = getWorkItemProcessingStatuses(toolConfig.toolId);
    } else {
      nextFilters.statuses = [getWorkItemWaitingStatus(toolConfig.toolId)];
    }

    if (view === 'urgent') {
      nextFilters.deadline = 'urgent';
    }

    onFiltersChange?.(nextFilters);
    setAdvancedFiltersOpen(true);
  }

  if (selectedRequirement) {
    return (
      <BitableRecordDetail
        toolConfig={toolConfig}
        record={selectedRequirement}
        fields={fields}
        user={user}
        cacheUserKey={cacheUserKey}
        projectId={projectId}
        mentionableUsers={mentionableUsers}
        mentionableUsersByTool={mentionableUsersByTool}
        allowedToolIds={allowedToolIds}
        commentsFieldName={state.result?.commentsFieldName || '留言'}
        statusChangeLogFieldName={state.result?.statusChangeLogFieldName || '处理状态变动记录'}
        highlightCommentId={highlightCommentId}
        statusOptions={state.result?.statusOptions || []}
        editableFields={state.result?.editableFields || []}
        onRequirementUpdated={onRequirementUpdated}
        onOpenRelatedItem={onOpenRelatedItem}
        onRequirementDeleted={onRequirementDeleted}
        canDelete={isSuperAdmin}
        isSuperAdmin={isSuperAdmin}
        isDevelopmentSuperAdmin={isDevelopmentSuperAdmin}
        aiPlanningEnabled={aiPlanningEnabled}
        aiPlanningUnavailableReason={aiPlanningUnavailableReason}
        aiDirectTarget={aiDirectTarget}
        onAiDirectTargetConsumed={onAiDirectTargetConsumed}
        aiLaunchRequest={aiLaunchRequest}
        onAiLaunchConsumed={onAiLaunchConsumed}
        onAiActivityChange={onAiActivityChange}
        onBack={onRequirementBack}
      />
    );
  }

  return (
    <section className="requirements-board" aria-live="polite" aria-label={toolConfig.listLabel}>
      <CacheStateNotice message={state.message} />
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
          cacheUserKey={cacheUserKey}
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
        advancedOpen={advancedFiltersOpen}
        onAdvancedOpenChange={setAdvancedFiltersOpen}
      />
      {toolConfig.supportsPriority !== false ? (
        <RelatedRequirementsSummary
          toolConfig={toolConfig}
          requirements={requirements}
          user={user}
          onView={handleRelatedSummaryView}
        />
      ) : null}
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
        aiActivityByWorkItem={aiActivityByWorkItem}
      />
    </section>
  );
}

function WorkItemFilterBar({
  toolConfig,
  requirements,
  statusOptions,
  filters,
  onChange,
  advancedOpen,
  onAdvancedOpenChange,
}) {
  const statusNames = getAvailableWorkItemStatuses(toolConfig, requirements, statusOptions);
  const assignees = getWorkItemFilterPeople(requirements, 'assignees');
  const proposers = getWorkItemFilterPeople(requirements, 'proposers');
  const [draftFilters, setDraftFilters] = useState(() => ({
    ...createEmptyWorkItemFilters(),
    ...filters,
  }));
  const hasAdvancedFilters = hasActiveAdvancedWorkItemFilters(filters);
  const dateLabel = toolConfig.dateLabel || '提出时间';

  useEffect(() => {
    if (advancedOpen) {
      setDraftFilters({
        ...createEmptyWorkItemFilters(),
        ...filters,
      });
    }
  }, [advancedOpen, filters]);

  function updateFilter(nextValues) {
    onChange?.({
      ...filters,
      ...nextValues,
    });
  }

  function updateDraftFilters(nextValues) {
    setDraftFilters((current) => ({
      ...current,
      ...nextValues,
    }));
  }

  function toggleDraftListFilter(key, value) {
    const currentValues = Array.isArray(draftFilters?.[key]) ? draftFilters[key] : [];
    updateDraftFilters({
      [key]: currentValues.includes(value)
        ? currentValues.filter((item) => item !== value)
        : [...currentValues, value],
    });
  }

  function applyAdvancedFilters() {
    onChange?.({
      ...createEmptyWorkItemFilters(),
      ...draftFilters,
      query: filters?.query || '',
    });
    onAdvancedOpenChange?.(false);
  }

  function clearAdvancedFilters() {
    onChange?.({
      ...createEmptyWorkItemFilters(),
      query: filters?.query || '',
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
          className={`workitem-filter-toggle ${hasAdvancedFilters ? 'is-applied' : ''}`}
          aria-expanded={advancedOpen}
          onClick={() => onAdvancedOpenChange?.(true)}
        >
          高级筛选
        </button>
        {hasAdvancedFilters ? (
          <button
            type="button"
            className="workitem-filter-clear"
            onClick={clearAdvancedFilters}
          >
            清空筛选
          </button>
        ) : null}
      </div>
      {advancedOpen ? (
        <div className="workitem-submit-backdrop" role="presentation">
          <section className="workitem-filter-dialog" role="dialog" aria-modal="true" aria-label={`高级筛选${toolConfig.listLabel}`}>
            <div className="workitem-submit-header">
              <div>
                <h3>高级筛选</h3>
              </div>
              <button type="button" className="workitem-submit-close" onClick={() => onAdvancedOpenChange?.(false)}>
                关闭
              </button>
            </div>
            <div className="workitem-filter-dialog-content">
              <div className="workitem-filter-panel">
                <fieldset className="workitem-filter-group">
                  <legend>处理状态</legend>
                  <div className="workitem-filter-options">
                    {statusNames.map((status) => (
                      <label key={status} className="workitem-filter-option">
                        <input
                          type="checkbox"
                          checked={(draftFilters?.statuses || []).includes(status)}
                          onChange={() => toggleDraftListFilter('statuses', status)}
                        />
                        <span>{status}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {toolConfig.supportsPriority !== false ? (
                  <fieldset className="workitem-filter-group">
                    <legend>优先级</legend>
                    <div className="workitem-filter-options">
                      {REQUIREMENT_PRIORITIES.map((priority) => (
                        <label key={priority} className="workitem-filter-option">
                          <input
                            type="checkbox"
                            checked={(draftFilters?.priorities || []).includes(priority)}
                            onChange={() => toggleDraftListFilter('priorities', priority)}
                          />
                          <span>{priority}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
                <fieldset className="workitem-filter-group">
                  <legend>处理人</legend>
                  <div className="workitem-filter-options">
                    {assignees.length > 0 ? assignees.map((person) => (
                      <label key={person.key} className="workitem-filter-option">
                        <input
                          type="checkbox"
                          checked={(draftFilters?.assigneeKeys || []).includes(person.key)}
                          onChange={() => toggleDraftListFilter('assigneeKeys', person.key)}
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
                          checked={(draftFilters?.proposerKeys || []).includes(person.key)}
                          onChange={() => toggleDraftListFilter('proposerKeys', person.key)}
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
                    value={draftFilters?.deadline || 'all'}
                    onChange={(event) => updateDraftFilters({ deadline: event.target.value })}
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
                      value={draftFilters?.dateFrom || ''}
                      onChange={(event) => updateDraftFilters({ dateFrom: event.target.value })}
                    />
                  </label>
                  <label className="workitem-filter-select">
                    <span>{dateLabel}结束</span>
                    <input
                      className="allow-text-select"
                      type="date"
                      value={draftFilters?.dateTo || ''}
                      onChange={(event) => updateDraftFilters({ dateTo: event.target.value })}
                    />
                  </label>
                </div>
              </div>
            </div>
            <div className="workitem-submit-actions">
              <button type="button" className="workitem-submit-secondary" onClick={() => onAdvancedOpenChange?.(false)}>
                取消
              </button>
              <button type="button" className="workitem-submit-primary" onClick={applyAdvancedFilters}>
                应用筛选
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function RelatedRequirementsSummary({ toolConfig, requirements, user, onView }) {
  const mine = requirements.filter((requirement) => isRequirementRelatedToUser(requirement, user));
  const canView = Boolean(getWorkItemPersonKey(user));
  const pendingStatus = getWorkItemWaitingStatus(toolConfig.toolId);
  const processingStatus = getWorkItemProcessingStatus(toolConfig.toolId);
  const processingStatuses = new Set(getWorkItemProcessingStatuses(toolConfig.toolId));
  const pendingCount = mine.filter((requirement) => getWorkItemStatus(requirement) === pendingStatus).length;
  const processingCount = mine.filter((requirement) => processingStatuses.has(getWorkItemStatus(requirement))).length;
  const almostOverdueCount = mine.filter((requirement) => {
    const days = Number(requirement.remainingDays);
    return getWorkItemStatus(requirement) === pendingStatus && Number.isFinite(days) && days >= 0 && days < 1;
  }).length;

  return (
    <section className="related-summary" aria-label="与我有关">
      <div className="related-summary-title">与我有关</div>
      <div className="related-summary-items">
        <RelatedSummaryItem label={pendingStatus} value={pendingCount} tone="pending" onView={() => onView?.('pending')} disabled={!canView} />
        <RelatedSummaryItem label={processingStatus} value={processingCount} tone="processing" onView={() => onView?.('processing')} disabled={!canView} />
        <RelatedSummaryItem label="快逾期" value={almostOverdueCount} tone="urgent" onView={() => onView?.('urgent')} disabled={!canView} />
      </div>
    </section>
  );
}

function WorkItemSubmitDialog({ toolConfig, projectId, cacheUserKey, statusOptions, priorityColors, mentionableUsers, onClose, onCreated }) {
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
  const [needsAssigneeAssignment, setNeedsAssigneeAssignment] = useState(false);
  const [requiresSubmissionAttachment, setRequiresSubmissionAttachment] = useState(false);
  const [expectedDays, setExpectedDays] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [allowDeveloperFollowUp, setAllowDeveloperFollowUp] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const mentionCandidates = normalizeMentionCandidates(mentionableUsers);
  const statusPreview = normalizeRequirementStatusOptionsForClient(statusOptions)[0]?.name || '自动使用第一个状态';
  const draftKey = createDraftKey(cacheUserKey, 'submit', projectId, toolConfig.toolId);

  useLocalDraft(
    cacheUserKey,
    draftKey,
    {
      title,
      description,
      priority,
      assignees,
      needsAssigneeAssignment,
      requiresSubmissionAttachment,
      expectedDays,
      contactPhone,
      contactEmail,
      allowDeveloperFollowUp,
      attachments,
    },
    (draft) => {
      setTitle(String(draft?.title || ''));
      setDescription(String(draft?.description || ''));
      setPriority(String(draft?.priority || defaultPriority));
      setAssignees(Array.isArray(draft?.assignees) ? draft.assignees : []);
      setNeedsAssigneeAssignment(Boolean(draft?.needsAssigneeAssignment));
      setRequiresSubmissionAttachment(Boolean(draft?.requiresSubmissionAttachment));
      setExpectedDays(String(draft?.expectedDays || ''));
      setContactPhone(String(draft?.contactPhone || ''));
      setContactEmail(String(draft?.contactEmail || ''));
      setAllowDeveloperFollowUp(Boolean(draft?.allowDeveloperFollowUp));
    },
    (draft) => (
      !draft.title
      && !draft.description
      && !draft.expectedDays
      && !draft.contactPhone
      && !draft.contactEmail
      && !draft.allowDeveloperFollowUp
      && !draft.needsAssigneeAssignment
      && !draft.requiresSubmissionAttachment
      && !(draft.assignees || []).length
    ),
  );

  function closeAndDiscardDraft() {
    void clearLocalDraft(draftKey);
    onClose?.();
  }

  function addAttachments(files) {
    const nextFiles = Array.from(files || []);
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
    if (needsAssigneeAssignment && assignees.length > 0) {
      setAssignees([]);
    }
  }, [needsAssigneeAssignment, assignees.length]);

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

    const assignmentError = validateWorkItemAssignmentChoice({
      toolId: toolConfig.toolId,
      assignees,
      needsAssigneeAssignment,
    });
    if (assignmentError) {
      setStatus({ type: 'error', message: assignmentError });
      return;
    }

    const parsedExpectedDays = trimmedExpectedDays ? Number(trimmedExpectedDays) : null;
    if (toolConfig.supportsPriority !== false && trimmedExpectedDays && (!Number.isFinite(parsedExpectedDays) || parsedExpectedDays < 0)) {
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
        needsAssigneeAssignment,
        requiresSubmissionAttachment,
        expectedDays: parsedExpectedDays,
        contactInfo: toolConfig.toolId === 'feedback'
          ? {
              phone: contactPhone.trim(),
              email: contactEmail.trim(),
              allowDeveloperFollowUp,
            }
          : null,
        attachments,
      });
      const failedNotifications = (payload.notificationResults || []).filter((item) => !item.ok);
      if (failedNotifications.length > 0) {
        const targetLabel = getAssignmentNotificationTargetLabel(payload.assignmentEscalated);
        void clearLocalDraft(draftKey);
        onCreated?.({
          ...payload,
          submitNotice: {
            type: 'warning',
            message: `${toolConfig.itemLabel}已提交，${failedNotifications.length} 个${targetLabel}通知发送失败`,
          },
        });
        return;
      }

      void clearLocalDraft(draftKey);
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
          <button type="button" className="workitem-submit-close" disabled={status.type === 'loading'} onClick={closeAndDiscardDraft}>
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

          {toolConfig.supportsPriority !== false ? (
            <>
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
                {toolConfig.toolId === 'requirements' ? (
                  <label className="workitem-submit-field workitem-submit-field-wide">
                    <span>需要提交附件</span>
                    <select
                      className="allow-text-select"
                      value={requiresSubmissionAttachment ? '是' : '否'}
                      disabled={status.type === 'loading'}
                      onChange={(event) => setRequiresSubmissionAttachment(event.target.value === '是')}
                    >
                      <option value="否">否</option>
                      <option value="是">是</option>
                    </select>
                  </label>
                ) : null}
              </div>

              <section
                className={`workitem-assignee-choice ${needsAssigneeAssignment ? 'is-undetermined' : ''}`}
                aria-label="处理人员选择"
              >
                {toolConfig.supportsUnassignedRouting && supportsUnassignedWorkItemRouting(toolConfig.toolId) ? (
                  <button
                    type="button"
                    className="workitem-assignee-undetermined"
                    aria-pressed={needsAssigneeAssignment}
                    disabled={status.type === 'loading'}
                    onClick={() => {
                      setNeedsAssigneeAssignment((current) => {
                        const next = !current;
                        if (next) {
                          setAssignees([]);
                        }
                        return next;
                      });
                      setStatus({ type: 'idle', message: '' });
                    }}
                  >
                    不知道该由谁处理
                  </button>
                ) : null}
                <MentionUserMultiSelect
                  selectedPeople={assignees}
                  candidates={mentionCandidates}
                  onChange={setAssignees}
                  disabled={status.type === 'loading' || needsAssigneeAssignment}
                  label="处理人员"
                  emptyText="暂无可选处理人员"
                  selectedLabel="已选择处理人员"
                />
              </section>
            </>
          ) : (
            <section className="feedback-contact-fields" aria-label="联系信息">
              <div className="feedback-contact-heading">
                <strong>联系信息</strong>
                <span>当前飞书身份将自动关联</span>
              </div>
              <div className="workitem-submit-grid">
                <label className="workitem-submit-field">
                  <span>联系电话</span>
                  <input
                    className="allow-text-select"
                    type="tel"
                    value={contactPhone}
                    maxLength={50}
                    disabled={status.type === 'loading'}
                    placeholder="可不填"
                    onChange={(event) => setContactPhone(event.target.value)}
                  />
                </label>
                <label className="workitem-submit-field">
                  <span>联系邮箱</span>
                  <input
                    className="allow-text-select"
                    type="email"
                    value={contactEmail}
                    maxLength={200}
                    disabled={status.type === 'loading'}
                    placeholder="可不填"
                    onChange={(event) => setContactEmail(event.target.value)}
                  />
                </label>
              </div>
              <label className="feedback-contact-follow-up">
                <input
                  type="checkbox"
                  checked={allowDeveloperFollowUp}
                  disabled={status.type === 'loading'}
                  onChange={(event) => setAllowDeveloperFollowUp(event.target.checked)}
                />
                <span>允许开发者回访</span>
              </label>
            </section>
          )}

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
            <button type="button" className="workitem-submit-secondary" disabled={status.type === 'loading'} onClick={closeAndDiscardDraft}>
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

function WorkItemEditDialog({ toolConfig, projectId, cacheUserKey, record, fields, mentionableUsers, onClose, onSaved }) {
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
  const draftKey = createDraftKey(cacheUserKey, 'edit', projectId, toolConfig.toolId, record.recordId);

  useLocalDraft(
    cacheUserKey,
    draftKey,
    { selectedFieldNames, fieldValues, notifyRelated, notifyUsers },
    (draft) => {
      setSelectedFieldNames(Array.isArray(draft?.selectedFieldNames) ? draft.selectedFieldNames.filter((item) => typeof item === 'string') : []);
      setFieldValues((current) => ({
        ...current,
        ...(draft?.fieldValues && typeof draft.fieldValues === 'object' ? draft.fieldValues : {}),
      }));
      setNotifyRelated(Boolean(draft?.notifyRelated));
      setNotifyUsers(Array.isArray(draft?.notifyUsers) ? draft.notifyUsers : []);
    },
    (draft) => !(draft.selectedFieldNames || []).length,
  );

  function closeAndDiscardDraft() {
    void clearLocalDraft(draftKey);
    onClose?.();
  }

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
      void clearLocalDraft(draftKey);
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
          <button type="button" className="workitem-submit-close" disabled={status.type === 'loading'} onClick={closeAndDiscardDraft}>
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
            <button type="button" className="workitem-submit-secondary" disabled={status.type === 'loading'} onClick={closeAndDiscardDraft}>
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
  if (isFeedbackContactInfoField(field, toolConfig)) {
    const contact = normalizeEditableFeedbackContactInfo(value);
    return (
      <FeedbackContactInfoEditor
        value={contact}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

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

function FeedbackContactInfoEditor({ value, disabled, onChange }) {
  function update(nextValues) {
    onChange({
      ...value,
      ...nextValues,
    });
  }

  return (
    <section className="feedback-contact-fields feedback-contact-fields-edit" aria-label="联系信息数据">
      <div className="feedback-contact-heading">
        <strong>联系信息数据</strong>
        <span>飞书身份由系统保留</span>
      </div>
      <div className="feedback-contact-readonly">
        <span>飞书用户：{value.isFeishuUser ? '是' : '否'}</span>
        <span>飞书用户ID：{value.feishuUserId || '未填写'}</span>
      </div>
      <div className="workitem-submit-grid">
        <label className="workitem-edit-control">
          <span>联系电话</span>
          <input
            className="allow-text-select"
            type="tel"
            maxLength={50}
            value={value.phone}
            disabled={disabled}
            onChange={(event) => update({ phone: event.target.value })}
          />
        </label>
        <label className="workitem-edit-control">
          <span>联系邮箱</span>
          <input
            className="allow-text-select"
            type="email"
            maxLength={200}
            value={value.email}
            disabled={disabled}
            onChange={(event) => update({ email: event.target.value })}
          />
        </label>
      </div>
      <label className="feedback-contact-follow-up">
        <input
          type="checkbox"
          checked={value.allowDeveloperFollowUp}
          disabled={disabled}
          onChange={(event) => update({ allowDeveloperFollowUp: event.target.checked })}
        />
        <span>允许开发者回访</span>
      </label>
    </section>
  );
}

function RelatedSummaryItem({ label, value, tone, onView, disabled }) {
  return (
    <div className={`related-summary-item related-summary-item-${tone}`}>
      <div className="related-summary-item-data">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <button type="button" className="related-summary-view" onClick={onView} disabled={disabled}>
        查看
      </button>
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
  aiActivityByWorkItem,
}) {
  if (toolConfig.supportsPriority === false) {
    return (
      <div className="requirement-groups feedback-groups">
        {requirements.length > 0 ? (
          <RequirementStatusGroups
            toolConfig={toolConfig}
            priority=""
            requirements={requirements}
            user={user}
            statusCollapseOverrides={statusCollapseOverrides}
            onStatusToggle={onStatusToggle}
            onRequirementSelect={onRequirementSelect}
            aiActivityByWorkItem={aiActivityByWorkItem}
          />
        ) : (
          <div className="requirement-empty">暂无{toolConfig.itemLabel}</div>
        )}
      </div>
    );
  }

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
                    aiActivityByWorkItem={aiActivityByWorkItem}
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

function RequirementStatusGroups({
  toolConfig,
  priority,
  requirements,
  user,
  statusCollapseOverrides,
  onStatusToggle,
  onRequirementSelect,
  aiActivityByWorkItem,
}) {
  const groupedStatuses = groupRequirementsByStatus(requirements, toolConfig.toolId);

  return (
    <div className="requirement-status-groups">
      {groupedStatuses.map((group) => {
        const groupId = [toolConfig.toolId, priority, group.status].filter(Boolean).join(':');
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
                    aiActivity={aiActivityByWorkItem?.[buildAiWorkItemKey(
                      toolConfig.toolId,
                      requirement.recordId,
                    )]}
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

function RequirementItem({ toolConfig, requirement, user, aiActivity, onSelect }) {
  const assignees = Array.isArray(requirement.assignees) ? requirement.assignees : [];
  const itemId = getWorkItemDisplayId(requirement);
  const aiStatusLabel = formatAiWorkItemStatus(aiActivity?.state);

  return (
    <button
      type="button"
      className="requirement-item"
      aria-label={[
        `查看${toolConfig.itemLabel} ${requirement.title || itemId || toolConfig.unnamedTitle}`,
        aiStatusLabel,
      ].filter(Boolean).join('，')}
      onClick={() => onSelect(requirement)}
    >
      <div className="requirement-main">
        <span className="requirement-title" title={requirement.title}>
          {requirement.title || toolConfig.unnamedTitle}
        </span>
        <span className="requirement-id-row">
          <span className="requirement-id" title={itemId || toolConfig.noIdText}>
            {itemId || toolConfig.noIdText}
          </span>
          {aiStatusLabel ? (
            <span className={`requirement-ai-status is-${aiActivity.state}`}>
              {aiActivity.state === 'generating' ? <LoaderCircle aria-hidden="true" /> : null}
              {aiActivity.state === 'awaiting_user' ? <CircleHelp aria-hidden="true" /> : null}
              {aiActivity.state === 'generated' ? <Sparkles aria-hidden="true" /> : null}
              {aiStatusLabel}
            </span>
          ) : null}
        </span>
      </div>
      <p className="requirement-description" title={requirement.description || '暂无描述'}>
        {requirement.description || '暂无描述'}
      </p>
      <div className="requirement-state-row">
        <span className="requirement-state" title={requirement.requirementStatus || '未设置状态'}>
          {requirement.requirementStatus || '未设置状态'}
        </span>
        {toolConfig.toolId === 'feedback' && requirement.channel ? (
          <span className="feedback-channel" title={requirement.channel}>{requirement.channel}</span>
        ) : null}
      </div>
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
  cacheUserKey,
  projectId,
  mentionableUsers,
  mentionableUsersByTool,
  allowedToolIds,
  commentsFieldName,
  statusChangeLogFieldName,
  highlightCommentId,
  statusOptions,
  editableFields,
  canDelete,
  isSuperAdmin,
  isDevelopmentSuperAdmin,
  aiPlanningEnabled,
  aiPlanningUnavailableReason,
  aiDirectTarget,
  onAiDirectTargetConsumed,
  aiLaunchRequest,
  onAiLaunchConsumed,
  onAiActivityChange,
  onRequirementUpdated,
  onOpenRelatedItem,
  onRequirementDeleted,
  onBack,
}) {
  const rawFields = record?.rawFields && typeof record.rawFields === 'object' ? record.rawFields : {};
  const hiddenFieldNames = [
    commentsFieldName,
    statusChangeLogFieldName,
    record.submittedAttachmentsFieldName,
    record.relatedItemFieldName,
    record.relatedFeedbackFieldName,
  ].filter(Boolean);
  const displayFields = buildDisplayFields(fields, rawFields, hiddenFieldNames);
  const showRemainingTime = shouldShowWorkItemRemainingTime(toolConfig.toolId, record);
  const canUpdateStatus = isRequirementRelatedToUser(record, user);
  const canResolveFeedback = Boolean(
    toolConfig.toolId === 'feedback'
    && (isSuperAdmin || isDevelopmentSuperAdmin || canUpdateStatus)
    && (
      getWorkItemStatus(record) === FEEDBACK_STATUSES.waiting
      || FEEDBACK_LEGACY_ACTIVE_STATUSES.includes(getWorkItemStatus(record))
    )
    && !record.relatedItem?.recordId
    && !record.relatedItemParseError
  );
  const canSubmitRequirementAttachments = Boolean(
    toolConfig.toolId === 'requirements'
    && canUpdateStatus
    && record.requiresSubmissionAttachment,
  );
  const canChangeAssignees = canManageWorkItemAssignees({
    toolId: toolConfig.toolId,
    isSuperAdmin,
    isDevelopmentSuperAdmin,
    isCurrentAssignee: canUpdateStatus,
  });
  const canEditContent = Boolean(isSuperAdmin || isWorkItemSubmitter(record, user));
  const [deleteStatus, setDeleteStatus] = useState({ type: 'idle', message: '' });
  const [editOpen, setEditOpen] = useState(false);
  const [editStatus, setEditStatus] = useState({ type: 'idle', message: '' });
  const [activeAction, setActiveAction] = useState('comments');
  const [aiPlanningOpen, setAiPlanningOpen] = useState(false);
  const [aiAutoCreateRequest, setAiAutoCreateRequest] = useState(null);
  const [feedbackResolutionType, setFeedbackResolutionType] = useState('');

  useEffect(() => {
    document.documentElement.classList.add('requirement-detail-scroll-lock');
    document.body.classList.add('requirement-detail-scroll-lock');

    return () => {
      document.documentElement.classList.remove('requirement-detail-scroll-lock');
      document.body.classList.remove('requirement-detail-scroll-lock');
    };
  }, []);

  useEffect(() => {
    setActiveAction(
      canResolveFeedback
        ? 'feedback-resolution'
        : canUpdateStatus && toolConfig.toolId !== 'feedback'
          ? 'status'
          : canChangeAssignees
            ? 'assignees'
            : 'comments',
    );
  }, [record.recordId]);

  useEffect(() => {
    if (
      aiDirectTarget?.type === 'ai-conversation'
      && String(aiDirectTarget.recordId || '') === String(record.recordId || '')
    ) {
      setAiPlanningOpen(true);
      onAiDirectTargetConsumed?.();
    }
  }, [
    aiDirectTarget?.key,
    aiDirectTarget?.recordId,
    aiDirectTarget?.type,
    onAiDirectTargetConsumed,
    record.recordId,
  ]);

  useEffect(() => {
    if (
      aiLaunchRequest?.key
      && String(aiLaunchRequest.recordId || '') === String(record.recordId || '')
    ) {
      setAiAutoCreateRequest(aiLaunchRequest);
      setAiPlanningOpen(true);
      onAiLaunchConsumed?.();
    }
  }, [
    aiLaunchRequest?.key,
    aiLaunchRequest?.recordId,
    onAiLaunchConsumed,
    record.recordId,
  ]);

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
          {aiPlanningEnabled ? (
            <button
              type="button"
              className="bitable-ai-plan-button"
              onClick={() => setAiPlanningOpen(true)}
            >
              <Bot aria-hidden="true" />
              AI 计划
            </button>
          ) : aiPlanningUnavailableReason ? (
            <button
              type="button"
              className="bitable-ai-plan-button"
              disabled
              title={aiPlanningUnavailableReason}
            >
              <Bot aria-hidden="true" />
              AI 计划未配置
            </button>
          ) : null}
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
          cacheUserKey={cacheUserKey}
          record={record}
          fields={editableFields}
          mentionableUsers={mentionableUsers}
          onClose={() => setEditOpen(false)}
          onSaved={handleEditSaved}
        />
      ) : null}
      {feedbackResolutionType ? (
        <FeedbackResolutionDialog
          resolutionType={feedbackResolutionType}
          projectId={projectId}
          record={record}
          mentionableUsers={mentionableUsersByTool?.[feedbackResolutionType] || []}
          onClose={() => setFeedbackResolutionType('')}
          onResolved={(payload) => {
            setFeedbackResolutionType('');
            if (payload.feedback) {
              onRequirementUpdated?.(payload.feedback);
            }
            const failedNotifications = (payload.notificationResults || [])
              .filter((item) => !item.ok);
            setEditStatus({
              type: failedNotifications.length > 0 ? 'warning' : 'success',
              message: failedNotifications.length > 0
                ? `反馈已处理，${failedNotifications.length} 个飞书通知发送失败`
                : payload.resolution?.type === FEEDBACK_RESOLUTION_TYPES.reply
                  ? '已回复反馈提出人'
                  : `反馈已转为${payload.resolution?.type === 'bugs' ? 'Bug' : '需求'}`,
            });
          }}
        />
      ) : null}
      {aiPlanningOpen ? (
        <AiPlanningWorkspace
          projectId={projectId}
          toolConfig={toolConfig}
          record={record}
          initialConversationId={aiDirectTarget?.conversationId || ''}
          initialFocus={aiDirectTarget?.focus || ''}
          autoCreateRequest={aiAutoCreateRequest}
          onActivityChange={onAiActivityChange}
          onClose={() => {
            setAiPlanningOpen(false);
            setAiAutoCreateRequest(null);
          }}
        />
      ) : null}

      <div className="bitable-detail-scroll">
        <div className="bitable-detail-layout">
          <div className="bitable-detail-main">
            <WorkItemRelationPanel
              toolConfig={toolConfig}
              record={record}
              onOpenRelatedItem={onOpenRelatedItem}
            />
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
            {canResolveFeedback ? (
              <DetailActionSection
                actionId="feedback-resolution"
                title="分配反馈"
                isOpen={activeAction === 'feedback-resolution'}
                onToggle={setActiveAction}
              >
                <FeedbackResolutionPanel
                  allowedToolIds={allowedToolIds}
                  canReply={Boolean(
                    record.contactInfo?.valid
                    && record.contactInfo?.isFeishuUser
                    && record.contactInfo?.feishuUserId
                    && record.proposers?.some((person) => person.openId)
                  )}
                  onSelect={setFeedbackResolutionType}
                />
              </DetailActionSection>
            ) : null}
            {canUpdateStatus && toolConfig.toolId !== 'feedback' ? (
              <DetailActionSection
                actionId="status"
                title="更新处理状态"
                isOpen={activeAction === 'status'}
                onToggle={setActiveAction}
              >
                <RequirementStatusUpdatePanel
                  toolConfig={toolConfig}
                  projectId={projectId}
                  cacheUserKey={cacheUserKey}
                  record={record}
                  statusOptions={statusOptions}
                  onRequestSubmissionAttachments={() => setActiveAction('submission-attachments')}
                  onUpdated={onRequirementUpdated}
                  embedded
                />
              </DetailActionSection>
            ) : null}
            {canSubmitRequirementAttachments ? (
              <DetailActionSection
                actionId="submission-attachments"
                title="提交附件"
                isOpen={activeAction === 'submission-attachments'}
                onToggle={setActiveAction}
              >
                <RequirementSubmissionAttachmentsPanel
                  toolConfig={toolConfig}
                  projectId={projectId}
                  record={record}
                  commentsParseError={record.commentsParseError || ''}
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
                  cacheUserKey={cacheUserKey}
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
                cacheUserKey={cacheUserKey}
                record={record}
                user={user}
                mentionableUsers={mentionableUsers}
                highlightCommentId={highlightCommentId}
                onCommentsUpdated={(comments) => onRequirementUpdated?.({ ...record, comments })}
                embedded
              />
            </DetailActionSection>
          </aside>
        </div>
        <WorkItemTimelinePanel toolConfig={toolConfig} record={record} />
      </div>
    </section>
  );
}

function WorkItemRelationPanel({ toolConfig, record, onOpenRelatedItem }) {
  if (toolConfig.toolId === 'feedback') {
    if (record.relatedItemParseError) {
      return (
        <section className="workitem-relation-panel is-error" role="alert">
          <strong>关联项格式异常</strong>
          <span>{record.relatedItemParseError}</span>
        </section>
      );
    }
    if (record.relatedItem?.recordId) {
      const label = record.relatedItem.type === 'bugs' ? '关联Bug' : '关联需求';
      return (
        <section className="workitem-relation-panel">
          <div>
            <strong>{label}</strong>
            <span>
              {record.relatedItem.title || '未命名工作项'}
              {record.relatedItem.itemId ? ` (${record.relatedItem.itemId})` : ''}
            </span>
          </div>
          <button
            type="button"
            title={`打开${label}`}
            onClick={() => onOpenRelatedItem?.(
              record.relatedItem.type,
              record.relatedItem.recordId,
            )}
          >
            <ExternalLink aria-hidden="true" />
            打开
          </button>
        </section>
      );
    }
    if (getWorkItemStatus(record) === FEEDBACK_STATUSES.replied) {
      return (
        <section className="workitem-relation-panel">
          <div>
            <strong>处理结果</strong>
            <span>已回复提出人</span>
          </div>
          <MessageSquareReply aria-hidden="true" />
        </section>
      );
    }
    return null;
  }

  if (!['requirements', 'bugs'].includes(toolConfig.toolId)) {
    return null;
  }
  if (record.relatedFeedbackParseError) {
    return (
      <section className="workitem-relation-panel is-error" role="alert">
        <strong>关联反馈格式异常</strong>
        <span>{record.relatedFeedbackParseError}</span>
      </section>
    );
  }
  if (!record.relatedFeedback?.recordId) {
    return null;
  }
  return (
    <section className="workitem-relation-panel">
      <div>
        <strong>源反馈</strong>
        <span>
          {record.relatedFeedback.title || '未命名反馈'}
          {record.relatedFeedback.feedbackId
            ? ` (${record.relatedFeedback.feedbackId})`
            : ''}
        </span>
      </div>
      <button
        type="button"
        title="打开源反馈"
        onClick={() => onOpenRelatedItem?.('feedback', record.relatedFeedback.recordId)}
      >
        <ExternalLink aria-hidden="true" />
        打开
      </button>
    </section>
  );
}

function FeedbackResolutionPanel({
  allowedToolIds,
  canReply,
  onSelect,
}) {
  const allowed = new Set(Array.isArray(allowedToolIds) ? allowedToolIds : []);
  return (
    <div className="feedback-resolution-actions">
      {allowed.has('requirements') ? (
        <button
          type="button"
          onClick={() => onSelect(FEEDBACK_RESOLUTION_TYPES.requirements)}
        >
          <ClipboardList aria-hidden="true" />
          转为需求
        </button>
      ) : null}
      {allowed.has('bugs') ? (
        <button
          type="button"
          onClick={() => onSelect(FEEDBACK_RESOLUTION_TYPES.bugs)}
        >
          <Bug aria-hidden="true" />
          转为Bug
        </button>
      ) : null}
      <button
        type="button"
        disabled={!canReply}
        title={canReply ? '回复飞书提出人' : '仅支持具有有效飞书提出人的内部反馈'}
        onClick={() => onSelect(FEEDBACK_RESOLUTION_TYPES.reply)}
      >
        <MessageSquareReply aria-hidden="true" />
        仅回复
      </button>
    </div>
  );
}

function FeedbackResolutionDialog({
  resolutionType,
  projectId,
  record,
  mentionableUsers,
  onClose,
  onResolved,
}) {
  const isReply = resolutionType === FEEDBACK_RESOLUTION_TYPES.reply;
  const targetConfig = resolutionType === FEEDBACK_RESOLUTION_TYPES.bugs
    ? WORK_ITEM_TOOL_CONFIGS.bugs
    : WORK_ITEM_TOOL_CONFIGS.requirements;
  const [title, setTitle] = useState(record.title || '');
  const [description, setDescription] = useState(record.description || '');
  const [priority, setPriority] = useState('P2');
  const [expectedDays, setExpectedDays] = useState(
    record.expectedDays === null || record.expectedDays === undefined
      ? ''
      : String(record.expectedDays),
  );
  const [assignees, setAssignees] = useState([]);
  const [needsAssigneeAssignment, setNeedsAssigneeAssignment] = useState(false);
  const [requiresSubmissionAttachment, setRequiresSubmissionAttachment] = useState(false);
  const [sourceAttachmentTokens, setSourceAttachmentTokens] = useState(
    () => (record.attachments || []).map((attachment) => attachment.fileToken).filter(Boolean),
  );
  const [attachments, setAttachments] = useState([]);
  const [replyContent, setReplyContent] = useState('');
  const [clientMutationId] = useState(() => createWorkItemClientMutationId());
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const mentionCandidates = normalizeMentionCandidates(mentionableUsers);

  useEffect(() => {
    setAssignees((current) => filterSelectedMentionedUsers(current, mentionCandidates));
  }, [mentionableUsers]);

  useEffect(() => {
    if (needsAssigneeAssignment && assignees.length > 0) {
      setAssignees([]);
    }
  }, [needsAssigneeAssignment, assignees.length]);

  function addAttachments(files) {
    setAttachments((current) => mergeAttachmentFiles(current, Array.from(files || [])));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (status.type === 'loading') {
      return;
    }
    if (isReply) {
      if (!replyContent.trim()) {
        setStatus({ type: 'error', message: '请填写回复内容' });
        return;
      }
    } else {
      if (!title.trim()) {
        setStatus({ type: 'error', message: `请填写${targetConfig.itemLabel}标题` });
        return;
      }
      const assignmentError = validateWorkItemAssignmentChoice({
        toolId: targetConfig.toolId,
        assignees,
        needsAssigneeAssignment,
      });
      if (assignmentError) {
        setStatus({ type: 'error', message: assignmentError });
        return;
      }
      const expected = String(expectedDays || '').trim();
      if (expected && (!Number.isFinite(Number(expected)) || Number(expected) < 0)) {
        setStatus({ type: 'error', message: '期望时限必须是大于等于0的数字' });
        return;
      }
      if (sourceAttachmentTokens.length + attachments.length > 5) {
        setStatus({ type: 'error', message: '转换后的工作项最多包含5个附件' });
        return;
      }
    }

    setStatus({ type: 'loading', message: '正在处理反馈' });
    try {
      const payload = await resolveFeedback(projectId, record.recordId, {
        resolutionType,
        clientMutationId,
        title: title.trim(),
        description: description.trim(),
        priority,
        expectedDays: String(expectedDays || '').trim()
          ? Number(expectedDays)
          : null,
        assignees,
        needsAssigneeAssignment,
        requiresSubmissionAttachment,
        sourceAttachmentTokens,
        replyContent: replyContent.trim(),
        attachments,
      });
      onResolved?.(payload);
    } catch (error) {
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  return (
    <div className="workitem-submit-backdrop" role="presentation">
      <section
        className="workitem-submit-dialog feedback-resolution-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isReply ? '回复反馈提出人' : `反馈转为${targetConfig.itemLabel}`}
      >
        <div className="workitem-submit-header">
          <div>
            <h3>{isReply ? '回复反馈提出人' : `转为${targetConfig.itemLabel}`}</h3>
            <span>{record.feedbackId || record.itemId || '无反馈ID'}</span>
          </div>
          <button
            type="button"
            className="workitem-submit-close"
            disabled={status.type === 'loading'}
            onClick={onClose}
          >
            <X aria-hidden="true" />
            <span className="sr-only">关闭</span>
          </button>
        </div>
        <form className="workitem-submit-form" onSubmit={handleSubmit}>
          {isReply ? (
            <label className="workitem-submit-field">
              <span>回复内容</span>
              <textarea
                value={replyContent}
                rows={8}
                maxLength={2000}
                disabled={status.type === 'loading'}
                onChange={(event) => setReplyContent(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="workitem-submit-field">
                <span>标题</span>
                <input
                  value={title}
                  maxLength={200}
                  disabled={status.type === 'loading'}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="workitem-submit-field">
                <span>描述</span>
                <textarea
                  value={description}
                  rows={6}
                  maxLength={5000}
                  disabled={status.type === 'loading'}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <div className="workitem-submit-grid">
                <label className="workitem-submit-field">
                  <span>优先级</span>
                  <select
                    value={priority}
                    disabled={status.type === 'loading'}
                    onChange={(event) => setPriority(event.target.value)}
                  >
                    {REQUIREMENT_PRIORITIES.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label className="workitem-submit-field">
                  <span>期望时限（天）</span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={expectedDays}
                    disabled={status.type === 'loading'}
                    onChange={(event) => setExpectedDays(event.target.value)}
                  />
                </label>
                {resolutionType === FEEDBACK_RESOLUTION_TYPES.requirements ? (
                  <label className="workitem-submit-field workitem-submit-field-wide">
                    <span>需要提交附件</span>
                    <select
                      value={requiresSubmissionAttachment ? '是' : '否'}
                      disabled={status.type === 'loading'}
                      onChange={(event) => setRequiresSubmissionAttachment(
                        event.target.value === '是',
                      )}
                    >
                      <option value="否">否</option>
                      <option value="是">是</option>
                    </select>
                  </label>
                ) : null}
              </div>
              <section className="workitem-assignee-choice" aria-label="处理人员选择">
                <button
                  type="button"
                  className="workitem-assignee-undetermined"
                  aria-pressed={needsAssigneeAssignment}
                  disabled={status.type === 'loading'}
                  onClick={() => {
                    setNeedsAssigneeAssignment((current) => !current);
                    setStatus({ type: 'idle', message: '' });
                  }}
                >
                  不知道该由谁处理
                </button>
                <MentionUserMultiSelect
                  selectedPeople={assignees}
                  candidates={mentionCandidates}
                  onChange={setAssignees}
                  disabled={status.type === 'loading' || needsAssigneeAssignment}
                  label="处理人员"
                  emptyText="暂无可选处理人员"
                  selectedLabel="已选择处理人员"
                />
              </section>
              {(record.attachments || []).length > 0 ? (
                <section className="feedback-source-attachments">
                  <strong>源反馈附件</strong>
                  {(record.attachments || []).map((attachment) => {
                    const checked = sourceAttachmentTokens.includes(attachment.fileToken);
                    return (
                      <label key={attachment.fileToken}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={status.type === 'loading'}
                          onChange={() => setSourceAttachmentTokens((current) => (
                            checked
                              ? current.filter((token) => token !== attachment.fileToken)
                              : [...current, attachment.fileToken]
                          ))}
                        />
                        <Paperclip aria-hidden="true" />
                        <span>{attachment.name || attachment.fileToken}</span>
                        <small>{formatFileSize(attachment.size)}</small>
                      </label>
                    );
                  })}
                </section>
              ) : null}
              <label className="workitem-submit-field">
                <span>新增附件</span>
                <input
                  type="file"
                  multiple
                  disabled={status.type === 'loading'}
                  onChange={(event) => {
                    addAttachments(event.target.files);
                    event.target.value = '';
                  }}
                />
              </label>
              {attachments.length > 0 ? (
                <div className="feedback-new-attachments">
                  {attachments.map((file, index) => (
                    <div key={`${file.name}-${file.size}-${index}`}>
                      <span>{file.name}</span>
                      <small>{formatFileSize(file.size)}</small>
                      <button
                        type="button"
                        title="移除附件"
                        disabled={status.type === 'loading'}
                        onClick={() => setAttachments((current) => (
                          current.filter((_, currentIndex) => currentIndex !== index)
                        ))}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
          {status.message ? (
            <p className={`record-comment-status record-comment-status-${status.type}`}>
              {status.message}
            </p>
          ) : null}
          <div className="workitem-submit-actions">
            <button
              type="button"
              className="workitem-submit-cancel"
              disabled={status.type === 'loading'}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="workitem-submit-confirm"
              disabled={status.type === 'loading'}
            >
              {isReply ? <Send aria-hidden="true" /> : <Link2 aria-hidden="true" />}
              {status.type === 'loading'
                ? '处理中'
                : isReply
                  ? '发送回复'
                  : `创建${targetConfig.itemLabel}`}
            </button>
          </div>
        </form>
      </section>
    </div>
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
  if (isFeedbackContactInfoField(field)) {
    return true;
  }

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

  if (isFeedbackContactInfoField(field, toolConfig)) {
    return <FeedbackContactInfoValue value={value} />;
  }

  if (isCurrencyField(field, value)) {
    return <span>{formatCurrencyValue(value)}</span>;
  }

  return <GenericFieldValue value={value} />;
}

function FeedbackContactInfoValue({ value }) {
  const contact = parseFeedbackContactInfoForClient(value);
  if (!contact.valid) {
    return <span className="bitable-empty-value">联系信息数据格式异常</span>;
  }

  return (
    <dl className="feedback-contact-info">
      <div>
        <dt>飞书用户</dt>
        <dd>{contact.isFeishuUser ? '是' : '否'}</dd>
      </div>
      <div>
        <dt>飞书用户ID</dt>
        <dd>{contact.feishuUserId || '未填写'}</dd>
      </div>
      <div>
        <dt>联系电话</dt>
        <dd>{contact.phone || '未填写'}</dd>
      </div>
      <div>
        <dt>联系邮箱</dt>
        <dd>{contact.email || '未填写'}</dd>
      </div>
      <div>
        <dt>允许开发者回访</dt>
        <dd>{contact.allowDeveloperFollowUp ? '是' : '否'}</dd>
      </div>
    </dl>
  );
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

function RequirementStatusUpdatePanel({
  toolConfig,
  projectId,
  cacheUserKey,
  record,
  statusOptions,
  onRequestSubmissionAttachments,
  onUpdated,
  embedded = false,
}) {
  const options = normalizeRequirementStatusOptionsForClient(statusOptions);
  const currentStatus = String(record.requirementStatus || '未设置状态').trim();
  const selectableOptions = ensureStatusOptionExists(options, currentStatus);
  const firstDifferentStatus = selectableOptions.find((option) => option.name !== currentStatus)?.name || '';
  const [newStatus, setNewStatus] = useState(firstDifferentStatus);
  const [message, setMessage] = useState('');
  const [notifyProposer, setNotifyProposer] = useState(true);
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [versionConfirmation, setVersionConfirmation] = useState(null);
  const [associationRetry, setAssociationRetry] = useState(null);
  const associationRetryRef = useRef(null);
  const completedStatusUpdateRef = useRef('');
  const draftKey = createDraftKey(cacheUserKey, 'status', projectId, toolConfig.toolId, record.recordId);

  useLocalDraft(
    cacheUserKey,
    draftKey,
    { newStatus, message, notifyProposer },
    (draft) => {
      setNewStatus(String(draft?.newStatus || firstDifferentStatus));
      setMessage(String(draft?.message || ''));
      setNotifyProposer(draft?.notifyProposer !== false);
    },
    (draft) => (
      !draft.message
      && draft.newStatus === firstDifferentStatus
      && draft.notifyProposer !== false
    ),
  );

  useEffect(() => {
    const isOwnCompletedUpdate = completedStatusUpdateRef.current === currentStatus;
    if (isOwnCompletedUpdate) {
      completedStatusUpdateRef.current = '';
    }
    const nextOptions = ensureStatusOptionExists(normalizeRequirementStatusOptionsForClient(statusOptions), currentStatus);
    setNewStatus(nextOptions.find((option) => option.name !== currentStatus)?.name || '');
    setMessage('');
    setNotifyProposer(true);
    if (!isOwnCompletedUpdate) {
      setStatus({ type: 'idle', message: '' });
    }
    setPendingConfirmation(null);
    setVersionConfirmation(null);
    if (associationRetryRef.current?.values?.newStatus !== currentStatus) {
      associationRetryRef.current = null;
      setAssociationRetry(null);
    }
  }, [record.recordId, currentStatus, statusOptions]);

  async function applyStatusUpdate(
    values,
    skipAttachmentCheck = false,
    allowDuplicateRetry = false,
  ) {
    const trimmedStatus = String(values.newStatus || '').trim();
    const trimmedMessage = String(values.message || '').trim();
    if (!trimmedStatus || status.type === 'loading') {
      setStatus({ type: 'error', message: '请选择处理状态' });
      return;
    }

    if (trimmedStatus === currentStatus && !allowDuplicateRetry) {
      setStatus({ type: 'error', message: '处理状态没有变化' });
      return;
    }

    if (
      !skipAttachmentCheck
      && shouldConfirmStatusUpdateWithoutSubmissionAttachments({
        toolId: toolConfig.toolId,
        requiresSubmissionAttachment: record.requiresSubmissionAttachment,
        submittedAttachments: record.submittedAttachments,
      })
    ) {
      setPendingConfirmation({
        ...values,
        newStatus: trimmedStatus,
        message: trimmedMessage,
      });
      return;
    }

    setStatus({ type: 'loading', message: '正在更新处理状态' });

    try {
      const payload = await updateRequirementStatus(toolConfig, projectId, record.recordId, {
        newStatus: trimmedStatus,
        message: trimmedMessage,
        notifyProposer: values.notifyProposer,
        expectedCurrentStatus: values.expectedCurrentStatus || currentStatus,
        confirmWithoutRequiredAttachment: Boolean(values.confirmWithoutRequiredAttachment),
        clientMutationId: values.clientMutationId,
        versionAssociationDecision: values.versionAssociationDecision,
      });
      const updatedItem = payload.item || payload.requirement;
      const versionAssociation = normalizeClientVersionAssociationResult(
        payload.versionAssociation,
      );
      if (!versionAssociation.ok && values.versionAssociationDecision?.apply) {
        const retry = {
          values: {
            ...values,
            newStatus: trimmedStatus,
            message: trimmedMessage,
          },
        };
        associationRetryRef.current = retry;
        setAssociationRetry(retry);
      } else {
        associationRetryRef.current = null;
        setAssociationRetry(null);
      }
      if (updatedItem) {
        completedStatusUpdateRef.current = trimmedStatus;
        onUpdated?.(updatedItem);
      }
      void clearLocalDraft(draftKey);

      const failedNotifications = (payload.notificationResults || []).filter((item) => !item.ok);
      if (!versionAssociation.ok) {
        setStatus({
          type: 'warning',
          message: `处理状态已更新，但版本关联失败：${versionAssociation.message || '请重试'}`,
        });
        return;
      }
      if (failedNotifications.length > 0) {
        setStatus({ type: 'warning', message: `处理状态已更新，${failedNotifications.length} 个通知发送失败` });
        return;
      }

      const changedVersionCount = versionAssociation.changedVersions.length;
      const successMessage = changedVersionCount > 0
        ? versionAssociation.operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.UNLINK
          ? `处理状态已更新，已取消 ${changedVersionCount} 个版本关联`
          : `处理状态已更新，已关联 ${changedVersionCount} 个版本`
        : '处理状态已更新';
      setStatus({ type: 'success', message: successMessage });
    } catch (error) {
      const versionDetails = normalizeClientVersionAssociationConfirmation(
        error?.payload?.result,
      );
      if (versionDetails) {
        setVersionConfirmation({
          ...versionDetails,
          selectedVersionIds: [],
          values: {
            ...values,
            newStatus: trimmedStatus,
            message: trimmedMessage,
          },
        });
        setStatus({ type: 'idle', message: '' });
        return;
      }
      if (error?.payload?.result?.confirmField === 'confirmWithoutRequiredAttachment') {
        setPendingConfirmation({
          ...values,
          newStatus: trimmedStatus,
          message: trimmedMessage,
        });
        setStatus({ type: 'idle', message: '' });
        return;
      }
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    associationRetryRef.current = null;
    setAssociationRetry(null);
    void applyStatusUpdate({
      newStatus,
      message,
      notifyProposer,
      expectedCurrentStatus: currentStatus,
      confirmWithoutRequiredAttachment: false,
      clientMutationId: createWorkItemClientMutationId(),
      versionAssociationDecision: null,
    });
  }

  async function retryVersionAssociation() {
    const retry = associationRetryRef.current;
    if (!retry || status.type === 'loading') {
      return;
    }
    setStatus({ type: 'loading', message: '正在重试版本关联' });
    await applyStatusUpdate(retry.values, true, true);
  }

  return (
    <>
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
          {status.message ? (
            <div className={`record-comment-status record-comment-status-${status.type}`}>
              <span>{status.message}</span>
              {associationRetry ? (
                <button
                  type="button"
                  className="requirement-status-retry"
                  disabled={status.type === 'loading'}
                  onClick={() => void retryVersionAssociation()}
                >
                  重试版本关联
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
      </section>
      {pendingConfirmation ? (
        <div className="workitem-submit-backdrop requirement-attachment-confirm-backdrop" role="presentation">
          <section className="requirement-attachment-confirm-dialog" role="dialog" aria-modal="true" aria-label="确认更新处理状态">
            <h3>还未提交任何附件</h3>
            <p>当前需求要求提交附件，但还没有提交过任何附件，是否继续更新处理状态？</p>
            <div className="requirement-attachment-confirm-actions">
              <button
                type="button"
                className="workitem-submit-secondary"
                onClick={() => {
                  setPendingConfirmation(null);
                  onRequestSubmissionAttachments?.();
                }}
              >
                提交附件
              </button>
              <button
                type="button"
                className="workitem-submit-primary"
                onClick={() => {
                  const values = pendingConfirmation;
                  setPendingConfirmation(null);
                  void applyStatusUpdate({
                    ...values,
                    confirmWithoutRequiredAttachment: true,
                  }, true);
                }}
              >
                继续更新
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {versionConfirmation ? (
        <WorkItemVersionAssociationDialog
          confirmation={versionConfirmation}
          busy={status.type === 'loading'}
          onCancel={() => setVersionConfirmation(null)}
          onSelectionChange={(recordId, selected) => {
            setVersionConfirmation((current) => {
              if (!current) {
                return current;
              }
              const next = new Set(current.selectedVersionIds);
              if (selected) {
                next.add(recordId);
              } else {
                next.delete(recordId);
              }
              return {
                ...current,
                selectedVersionIds: [...next],
              };
            });
          }}
          onSkip={() => {
            const current = versionConfirmation;
            setVersionConfirmation(null);
            void applyStatusUpdate({
              ...current.values,
              versionAssociationDecision: {
                operation: current.operation,
                apply: false,
                versionRecordIds: [],
              },
            }, true);
          }}
          onApply={() => {
            const current = versionConfirmation;
            setVersionConfirmation(null);
            void applyStatusUpdate({
              ...current.values,
              versionAssociationDecision: {
                operation: current.operation,
                apply: true,
                versionRecordIds: current.selectedVersionIds,
              },
            }, true);
          }}
        />
      ) : null}
    </>
  );
}

function WorkItemVersionAssociationDialog({
  confirmation,
  busy,
  onCancel,
  onSelectionChange,
  onSkip,
  onApply,
}) {
  const unlinking = confirmation.operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.UNLINK;
  const Icon = unlinking ? Unlink2 : Link2;
  const selected = new Set(confirmation.selectedVersionIds);

  return createPortal(
    <div className="workitem-submit-backdrop workitem-version-confirm-backdrop" role="presentation">
      <section
        className="workitem-version-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={unlinking ? '取消版本关联' : '关联测试开发版本'}
      >
        <header className="workitem-version-confirm-header">
          <div>
            <Icon aria-hidden="true" />
            <h3>{unlinking ? '取消版本关联' : '关联测试开发版本'}</h3>
          </div>
          <button type="button" title="取消更新" aria-label="取消更新" disabled={busy} onClick={onCancel}>
            <X aria-hidden="true" />
          </button>
        </header>
        <p>
          {unlinking
            ? '该工作项将离开已完成状态。请选择需要取消的版本关联。'
            : '该工作项将进入已完成状态。请选择需要关联的当前测试开发版本。'}
        </p>
        <div className="workitem-version-confirm-list" role="group" aria-label="可选版本">
          {confirmation.versions.map((version) => (
            <label
              className={`workitem-version-confirm-option ${selected.has(version.recordId) ? 'is-selected' : ''}`}
              key={version.recordId}
            >
              <input
                type="checkbox"
                checked={selected.has(version.recordId)}
                disabled={busy}
                onChange={(event) => onSelectionChange(version.recordId, event.target.checked)}
              />
              <span>
                <strong>{version.versionNumber || '未命名版本'}</strong>
                <small>{version.platform || '未设置平台'} · {version.status || '未设置状态'}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="workitem-version-confirm-actions">
          <button type="button" className="workitem-submit-secondary" disabled={busy} onClick={onCancel}>
            取消更新
          </button>
          <button type="button" className="workitem-submit-secondary" disabled={busy} onClick={onSkip}>
            {unlinking ? '保留关联并更新' : '仅更新状态'}
          </button>
          <button
            type="button"
            className="workitem-submit-primary"
            disabled={busy || selected.size === 0}
            onClick={onApply}
          >
            {unlinking ? '取消所选关联并更新' : '关联所选版本并更新'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function RequirementSubmissionAttachmentsPanel({
  toolConfig,
  projectId,
  record,
  commentsParseError,
  onUpdated,
  embedded = false,
}) {
  const rawFields = record?.rawFields && typeof record.rawFields === 'object' ? record.rawFields : {};
  const fieldName = record.submittedAttachmentsFieldName || '提交附件';
  const recordAttachments = normalizeAttachmentItems(rawFields[fieldName], projectId, toolConfig);
  const recordAttachmentKey = buildAttachmentTokenSetKey(recordAttachments);
  const [existingAttachments, setExistingAttachments] = useState(recordAttachments);
  const [newFiles, setNewFiles] = useState([]);
  const [notifyProposer, setNotifyProposer] = useState(true);
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const isDisabled = status.type === 'loading' || Boolean(commentsParseError);
  const hasChanges = newFiles.length > 0
    || buildAttachmentTokenSetKey(existingAttachments) !== recordAttachmentKey;

  useEffect(() => {
    setExistingAttachments(recordAttachments);
    setNewFiles([]);
  }, [record.recordId, recordAttachmentKey]);

  useEffect(() => {
    setNotifyProposer(true);
    setStatus({ type: 'idle', message: '' });
  }, [record.recordId]);

  function addFiles(files) {
    const nextFiles = Array.from(files || []);
    if (nextFiles.length === 0) {
      return;
    }

    setNewFiles((current) => mergeAttachmentFiles(current, nextFiles));
    setStatus({ type: 'idle', message: '' });
  }

  function handlePaste(event) {
    if (isDisabled) {
      return;
    }

    const files = extractSupportedAttachmentsFromClipboard(event.clipboardData);
    if (files.length === 0) {
      setStatus({ type: 'error', message: '剪贴板中没有可粘贴的图片或视频' });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    addFiles(files);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isDisabled) {
      return;
    }
    if (!hasChanges) {
      setStatus({ type: 'error', message: '提交附件没有变化' });
      return;
    }

    setStatus({ type: 'loading', message: '正在应用附件变动' });
    try {
      const payload = await updateRequirementSubmissionAttachments(projectId, record.recordId, {
        existingAttachments,
        newFiles,
        notifyProposer,
      });
      const updatedItem = payload.item || payload.requirement;
      if (updatedItem) {
        onUpdated?.(updatedItem);
      }

      const failedNotifications = (payload.notificationResults || []).filter((item) => !item.ok);
      if (failedNotifications.length > 0) {
        setStatus({
          type: 'warning',
          message: `附件变动已应用，${failedNotifications.length} 个提出人通知发送失败`,
        });
        return;
      }

      setStatus({ type: 'success', message: '附件变动已应用' });
    } catch (error) {
      setStatus({ type: 'error', message: formatErrorMessage(error) });
    }
  }

  return (
    <section className="requirement-submission-attachments" aria-label="提交附件">
      {embedded ? (
        <p className="detail-action-context">已提交 {recordAttachments.length} 个附件</p>
      ) : (
        <div className="requirement-submission-attachments-header">
          <h3>提交附件</h3>
          <span>{recordAttachments.length} 个</span>
        </div>
      )}
      <form className="requirement-submission-attachments-form" onSubmit={handleSubmit}>
        <div className="requirement-submission-attachment-list" aria-label="已经提交的附件">
          {existingAttachments.length === 0 ? (
            <p className="requirement-submission-attachment-empty">还没有提交附件</p>
          ) : existingAttachments.map((attachment, index) => (
            <div key={`${attachment.fileToken || attachment.name}-${index}`} className="requirement-submission-attachment-row">
              <div>
                {attachment.url ? (
                  <a href={attachment.url} target="_blank" rel="noreferrer">
                    {attachment.name || '附件'}
                  </a>
                ) : (
                  <strong>{attachment.name || '附件'}</strong>
                )}
                <small>{formatFileSize(attachment.size)}</small>
              </div>
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => setExistingAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index))}
              >
                删除
              </button>
            </div>
          ))}
        </div>

        <div
          className="workitem-attachment-dropzone allow-text-select"
          tabIndex={isDisabled ? -1 : 0}
          role="region"
          aria-label="提交附件粘贴区域"
          onPaste={handlePaste}
        >
          <strong>添加附件</strong>
          <small>可选择文件，图片或视频也可直接粘贴</small>
          <input
            className="allow-text-select"
            type="file"
            multiple
            disabled={isDisabled}
            onChange={(event) => {
              addFiles(event.target.files || []);
              event.target.value = '';
            }}
          />
        </div>

        {newFiles.length > 0 ? (
          <div className="workitem-submit-attachments" aria-label="待新增附件">
            {newFiles.map((file, index) => (
              <button
                key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                type="button"
                disabled={isDisabled}
                onClick={() => setNewFiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                title="点击移除待新增附件"
              >
                <span>{file.name}</span>
                <small>{formatFileSize(file.size)}</small>
              </button>
            ))}
          </div>
        ) : null}

        {commentsParseError ? (
          <p className="record-comments-error">{commentsParseError}，请先修复多维表格中的留言字段。</p>
        ) : null}

        <div className="requirement-submission-attachment-actions">
          <label className="requirement-status-update-notify">
            <input
              type="checkbox"
              checked={notifyProposer}
              disabled={isDisabled}
              onChange={(event) => setNotifyProposer(event.target.checked)}
            />
            <span>是否通知提出人员</span>
          </label>
          <button type="submit" disabled={isDisabled || !hasChanges}>
            {status.type === 'loading' ? '变动中' : '变动'}
          </button>
        </div>
        {status.message ? <p className={`record-comment-status record-comment-status-${status.type}`}>{status.message}</p> : null}
      </form>
    </section>
  );
}

function WorkItemAssigneeChangePanel({ toolConfig, projectId, cacheUserKey, record, user, mentionableUsers, commentsParseError, onUpdated, embedded = false }) {
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
  const draftKey = createDraftKey(cacheUserKey, 'assignees', projectId, toolConfig.toolId, record.recordId);

  useLocalDraft(
    cacheUserKey,
    draftKey,
    { selectedAssignees, reason },
    (draft) => {
      setSelectedAssignees(Array.isArray(draft?.selectedAssignees) ? draft.selectedAssignees : currentAssignees);
      setReason(String(draft?.reason || ''));
    },
    (draft) => (
      !draft.reason
      && buildDisplayUserSetKey(draft.selectedAssignees || currentAssignees) === currentAssigneeKey
    ),
  );

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
      void clearLocalDraft(draftKey);

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
        {supportsUnassignedWorkItemRouting(toolConfig.toolId) && currentAssignees.length === 0 ? (
          <div className="workitem-assignee-unassigned-warning" role="alert">
            当前还没有分配处理人，请选择新的处理人员。
          </div>
        ) : null}
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

function RecordCommentsPanel({ toolConfig, projectId, cacheUserKey, record, user, mentionableUsers, highlightCommentId, onCommentsUpdated, embedded = false }) {
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
  const draftKey = createDraftKey(cacheUserKey, 'comment', projectId, toolConfig.toolId, record.recordId);

  useLocalDraft(
    cacheUserKey,
    draftKey,
    { content, mentionedUsers, notifyMentioned },
    (draft) => {
      setContent(String(draft?.content || ''));
      setMentionedUsers(Array.isArray(draft?.mentionedUsers) ? draft.mentionedUsers : []);
      setNotifyMentioned(Boolean(draft?.notifyMentioned));
    },
    (draft) => !draft.content && !(draft.mentionedUsers || []).length && !draft.notifyMentioned,
  );

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
      const nextComments = normalizeClientComments(payload.comments);
      setComments(nextComments);
      onCommentsUpdated?.(nextComments);
      setContent('');
      setMentionedUsers([]);
      void clearLocalDraft(draftKey);

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
      const nextComments = normalizeClientComments(payload.comments);
      setComments(nextComments);
      onCommentsUpdated?.(nextComments);
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
      conversationId: String(url.searchParams.get('conversationId') || '').trim(),
      submissionId: String(url.searchParams.get('submissionId') || '').trim(),
      focus: String(url.searchParams.get('focus') || '').trim(),
    };

    return {
      ...target,
      key: [
        target.type,
        target.projectId,
        target.toolId,
        target.recordId,
        target.commentId,
        target.conversationId,
        target.submissionId,
        target.focus,
      ].join('|'),
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

  if (direct === 'ai-conversation') {
    return '';
  }

  if (direct === 'ai-plan') {
    return 'aiPlans';
  }

  if (direct === 'feedback-detail' || direct === 'feedback-comment') {
    return 'feedback';
  }

  if (direct === 'test-task-detail' || direct === 'test-task-comment') {
    return 'testTasks';
  }

  if (direct === 'version-detail' || direct === 'version-comment') {
    return 'versions';
  }

  return 'overview';
}

function getRequirementStableId(requirement) {
  return String(requirement?.recordId || requirement?.feedbackId || requirement?.requirementId || requirement?.title || '').trim();
}

function isRequirementTarget(requirement, targetId) {
  const target = String(targetId || '').trim();
  if (!target) {
    return false;
  }

  return [
    requirement?.recordId,
    requirement?.feedbackId,
    requirement?.requirementId,
    requirement?.title,
  ].some((item) => String(item || '').trim() === target);
}

function useLocalDraft(cacheUserKey, draftKey, draft, restoreDraft, isEmptyDraft = () => false) {
  const restoredRef = useRef(false);
  const restoreDraftRef = useRef(restoreDraft);
  const isEmptyDraftRef = useRef(isEmptyDraft);
  restoreDraftRef.current = restoreDraft;
  isEmptyDraftRef.current = isEmptyDraft;

  useEffect(() => {
    let isActive = true;
    restoredRef.current = false;

    async function restore() {
      const storedDraft = await getLocalDraft(draftKey);
      if (!isActive) {
        return;
      }

      if (storedDraft?.value) {
        restoreDraftRef.current(storedDraft.value);
      }
      restoredRef.current = true;
    }

    restore();

    return () => {
      isActive = false;
    };
  }, [cacheUserKey, draftKey]);

  useEffect(() => {
    if (!restoredRef.current || !cacheUserKey || !draftKey) {
      return;
    }

    if (isEmptyDraftRef.current(draft)) {
      void clearLocalDraft(draftKey);
      return;
    }

    void saveLocalDraft(cacheUserKey, draftKey, draft);
  }, [cacheUserKey, draft, draftKey]);
}

function getWorkspacePreferenceName(project) {
  return `workspace:${String(project?.recordId || project?.projectId || '').trim() || 'unknown'}`;
}

function getInitialWorkspacePreferences(cacheUserKey, project) {
  const visibleTools = getProjectToolsForDisplay(project, PROJECT_TOOLS);
  const stored = readLocalPreference(cacheUserKey, getWorkspacePreferenceName(project), {}) || {};
  const defaultToolId = visibleTools.some((tool) => tool.id === 'overview')
    ? 'overview'
    : visibleTools[0]?.id || PROJECT_TOOLS[0].id;
  const filters = createInitialWorkItemFilters();

  for (const toolId of Object.keys(filters)) {
    if (stored.workItemFilters?.[toolId] && typeof stored.workItemFilters[toolId] === 'object') {
      filters[toolId] = {
        ...createEmptyWorkItemFilters(),
        ...stored.workItemFilters[toolId],
      };
    }
  }

  return {
    activeToolId: defaultToolId,
    collapsedPriorities: Array.isArray(stored.collapsedPriorities)
      ? stored.collapsedPriorities.filter((item) => typeof item === 'string')
      : [],
    statusCollapseOverrides: stored.statusCollapseOverrides && typeof stored.statusCollapseOverrides === 'object'
      ? Object.fromEntries(Object.entries(stored.statusCollapseOverrides).filter(([, value]) => typeof value === 'boolean'))
      : {},
    workItemFilters: filters,
  };
}

function buildLocalCacheMessage(savedAt, isRefreshing, errorMessage = '') {
  const timestamp = formatLocalCacheTime(savedAt);
  if (isRefreshing) {
    return `已加载本地缓存（最后同步：${timestamp}），正在后台更新`;
  }

  return `已显示本地缓存（最后同步：${timestamp}）。服务器更新失败：${errorMessage || '请求失败'}`;
}

function formatLocalCacheTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) {
    return '未知时间';
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-') + ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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

function buildAttachmentTokenSetKey(attachments) {
  return [...new Set(
    (attachments || []).map(getSubmissionAttachmentToken).filter(Boolean),
  )].sort((left, right) => left.localeCompare(right)).join('|');
}

function getAttachmentDuplicateKey(file) {
  return [
    String(file?.name || '').trim().toLowerCase(),
    Number(file?.size || 0),
    String(file?.type || '').trim().toLowerCase(),
  ].join('|');
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
  const nextRequirements = replaceWorkItemByRecordId(requirements, requirement)
    .sort((left, right) => compareRequirementsForClient(left, right, toolConfig.toolId));

  return {
    ...state,
    result: {
      ...state.result,
      items: nextRequirements,
      [toolConfig.toolId === 'bugs' ? 'bugs' : toolConfig.toolId === 'feedback' ? 'feedbacks' : 'requirements']: nextRequirements,
      requirements: toolConfig.toolId === 'requirements' ? nextRequirements : state.result.requirements,
    },
  };
}

function removeWorkItemFromState(state, recordId, toolConfig = getWorkItemToolConfig('requirements')) {
  if (state?.status !== 'ready' || !state.result) {
    return state;
  }

  const nextRequirements = removeWorkItemByRecordId(
    getPayloadWorkItems(state.result, toolConfig),
    recordId,
  );
  return {
    ...state,
    result: {
      ...state.result,
      items: nextRequirements,
      [toolConfig.toolId === 'bugs' ? 'bugs' : toolConfig.toolId === 'feedback' ? 'feedbacks' : 'requirements']: nextRequirements,
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
      [toolConfig.toolId === 'bugs' ? 'bugs' : toolConfig.toolId === 'feedback' ? 'feedbacks' : 'requirements']: mergedItems,
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

  if (toolConfig.toolId === 'feedback' && Array.isArray(payload.feedbacks)) {
    return payload.feedbacks;
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

function getRelatedAssigneeFilterKeys(requirements, user) {
  const keys = new Set();

  for (const requirement of requirements || []) {
    for (const assignee of Array.isArray(requirement?.assignees) ? requirement.assignees : []) {
      if (isSameDisplayUser(assignee, user)) {
        const key = getWorkItemPersonKey(assignee);
        if (key) {
          keys.add(key);
        }
      }
    }
  }

  return [...keys];
}

function getWorkItemDisplayId(item) {
  return String(item?.itemId || item?.feedbackId || item?.bugId || item?.requirementId || '').trim();
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
  const matched = names.filter((name) => name.includes('中') || name === '待验收');
  return new Set(matched.length > 0 ? matched : ['处理中', '修复中', '待验收']);
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

function normalizeAiProjectActivity(payload) {
  const tasks = Array.isArray(payload?.tasks)
    ? payload.tasks
        .map((task) => {
          const toolId = String(task?.toolId || '').trim();
          const recordId = String(task?.recordId || '').trim();
          const conversationId = String(task?.conversationId || '').trim();
          const status = String(task?.status || '').trim();
          if (
            !['requirements', 'bugs'].includes(toolId)
            || !recordId
            || !conversationId
            || !['queued', 'running', 'awaiting_user'].includes(status)
          ) {
            return null;
          }
          return {
            conversationId,
            toolId,
            recordId,
            title: String(task?.title || '').trim(),
            status,
            startedAt: String(task?.startedAt || '').trim(),
            updatedAt: String(task?.updatedAt || '').trim(),
            progress: {
              stage: String(task?.progress?.stage || '').trim(),
              message: String(task?.progress?.message || '').trim(),
              updatedAt: String(task?.progress?.updatedAt || '').trim(),
            },
          };
        })
        .filter(Boolean)
    : [];
  const items = Array.isArray(payload?.items)
    ? payload.items
        .map((item) => {
          const toolId = String(item?.toolId || '').trim();
          const recordId = String(item?.recordId || '').trim();
          const state = String(item?.state || '').trim();
          if (
            !['requirements', 'bugs'].includes(toolId)
            || !recordId
            || !['generating', 'awaiting_user', 'generated'].includes(state)
          ) {
            return null;
          }
          return {
            toolId,
            recordId,
            state,
            conversationId: String(item?.conversationId || '').trim(),
            hasSharedPlan: Boolean(item?.hasSharedPlan),
            hasPrivateDraft: Boolean(item?.hasPrivateDraft),
            pendingReviewCount: Math.max(0, Number(item?.pendingReviewCount || 0)),
            updatedAt: String(item?.updatedAt || '').trim(),
          };
        })
        .filter(Boolean)
    : [];
  return {
    tasks,
    items,
    pendingReviewCount: Math.max(0, Number(payload?.pendingReviewCount || 0)),
    activeTaskCount: tasks.length,
    allowedToolIds: Array.isArray(payload?.allowedToolIds)
      ? payload.allowedToolIds.filter((toolId) => ['requirements', 'bugs'].includes(toolId))
      : [],
  };
}

function indexAiActivityItems(items) {
  return Object.fromEntries(
    (Array.isArray(items) ? items : []).map((item) => [
      buildAiWorkItemKey(item.toolId, item.recordId),
      item,
    ]),
  );
}

function buildAiWorkItemKey(toolId, recordId) {
  return `${String(toolId || '').trim()}:${String(recordId || '').trim()}`;
}

function formatAiWorkItemStatus(state) {
  return {
    generating: 'AI 生成中',
    awaiting_user: 'AI 待你确认',
    generated: '已有 AI 方案',
  }[String(state || '')] || '';
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
  const fallback = ['待处理', '处理中', '待验收', '已处理', '已完成', '关闭'].map((name) => ({ name, color: '' }));
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

function normalizeClientVersionAssociationConfirmation(value) {
  if (
    value?.confirmationType !== WORK_ITEM_VERSION_ASSOCIATION_CONFIRMATION_TYPE
    || !Object.values(WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS).includes(value?.operation)
  ) {
    return null;
  }

  const versions = (Array.isArray(value.versions) ? value.versions : [])
    .map((version) => {
      const recordId = String(version?.recordId || '').trim();
      if (!recordId) {
        return null;
      }
      return {
        recordId,
        versionNumber: String(version?.versionNumber || '').trim(),
        platform: String(version?.platform || '').trim(),
        status: String(version?.status || '').trim(),
      };
    })
    .filter(Boolean);
  if (versions.length === 0) {
    return null;
  }

  return {
    operation: value.operation,
    currentStatus: String(value.currentStatus || '').trim(),
    requestedStatus: String(value.requestedStatus || '').trim(),
    versions,
  };
}

function normalizeClientVersionAssociationResult(value) {
  const source = value && typeof value === 'object' ? value : {};
  const operation = Object.values(WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS)
    .includes(source.operation)
    ? source.operation
    : '';
  return {
    operation,
    applied: Boolean(source.applied),
    ok: source.ok !== false,
    changedVersions: (Array.isArray(source.changedVersions) ? source.changedVersions : [])
      .map((version) => ({
        recordId: String(version?.recordId || '').trim(),
        versionNumber: String(version?.versionNumber || '').trim(),
        platform: String(version?.platform || '').trim(),
        status: String(version?.status || '').trim(),
      }))
      .filter((version) => version.recordId),
    message: String(source.message || '').trim(),
  };
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

function formatProjectTitle(project) {
  return `${project.projectName || '未命名项目'} (${project.projectId || '无ID'})`;
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
