import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ClipboardCheck,
  FilePlus2,
  ListChecks,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  TEST_TASK_STATUSES,
  buildDefaultTestFeedbackTitle,
  createUniqueTestTaskItemId,
} from '../../../shared/testTaskUtils.js';
import {
  appendRecordComment,
  deleteRecordComment,
} from '../../api/workItems.js';
import {
  completeTestTask,
  createTestTask,
  createTestTaskMutationId,
  deleteTestTask,
  ensureProjectTestTasks,
  fetchTestTask,
  saveTestTaskResults,
  startTestTask,
  updateTestTask,
  updateTestTaskTesters,
} from '../../api/testTasks.js';
import {
  createWorkItemsSnapshotKey,
  getCachedSnapshot,
  saveCachedSnapshot,
} from '../localCache.js';
import { WORK_ITEM_TOOL_DEFINITIONS } from '../../../shared/workItemDefinitions.js';
import { WorkItemTimelinePanel } from '../work-items/WorkItemTimelinePanel.jsx';

const TOOL_CONFIG = WORK_ITEM_TOOL_DEFINITIONS.testTasks;
const STATUS_ORDER = [
  TEST_TASK_STATUSES.waiting,
  TEST_TASK_STATUSES.testing,
  TEST_TASK_STATUSES.completed,
];

export function TestTaskManagement({
  project,
  user,
  cacheUserKey,
  realtimeEvent,
  directTarget,
  onDirectNotice,
  onPendingCountChange,
}) {
  const [state, setState] = useState({ status: 'loading', message: '', payload: null });
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState('');
  const [comment, setComment] = useState('');
  const snapshotKey = createWorkItemsSnapshotKey(cacheUserKey, project.projectId, 'testTasks');
  const tasks = state.payload?.testTasks || [];
  const selectedTask = tasks.find((task) => task.recordId === selectedId) || null;

  useEffect(() => {
    let active = true;
    async function load() {
      const cached = await getCachedSnapshot(snapshotKey).catch(() => null);
      if (cached && active) {
        applyPayload(cached.value, '正在显示本地缓存，后台同步中');
      }
      try {
        const payload = await ensureProjectTestTasks(project.projectId);
        if (!active) return;
        await saveCachedSnapshot(cacheUserKey, snapshotKey, payload);
        applyPayload(payload, '');
      } catch (error) {
        if (!active) return;
        setState((current) => ({
          status: current.payload ? 'ready' : 'error',
          message: formatError(error),
          payload: current.payload,
        }));
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [project.projectId, snapshotKey]);

  useEffect(() => {
    if (
      realtimeEvent?.projectId !== String(project.projectId)
      || realtimeEvent?.toolId !== 'testTasks'
    ) {
      return;
    }
    if (realtimeEvent.changeType === 'deleted') {
      setState((current) => updatePayload(current, (payload) => ({
        ...payload,
        testTasks: payload.testTasks.filter((task) => task.recordId !== realtimeEvent.recordId),
      })));
      if (selectedId === realtimeEvent.recordId) setSelectedId('');
      return;
    }
    void refreshOne(realtimeEvent.recordId);
  }, [realtimeEvent?.id]);

  useEffect(() => {
    if (
      directTarget?.projectId === String(project.projectId)
      && directTarget?.toolId === 'testTasks'
      && directTarget?.recordId
    ) {
      setSelectedId(directTarget.recordId);
    }
  }, [directTarget?.key, project.projectId]);

  useEffect(() => {
    if (!state.payload) return;
    void saveCachedSnapshot(cacheUserKey, snapshotKey, state.payload);
    const pending = tasks.filter((task) => (
      state.payload.isTestAdmin
        ? ['待测试', '测试中'].includes(task.status)
        : task.status === '测试中' && hasUser(task.testers, user)
    )).length;
    onPendingCountChange?.(pending);
  }, [state.payload, cacheUserKey, snapshotKey, user?.openId]);

  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return STATUS_ORDER.map((status) => ({
      status,
      tasks: tasks.filter((task) => (
        task.status === status
        && (!normalizedQuery || [
          task.itemId,
          task.title,
          ...task.content.items.map((item) => `${item.id} ${item.content}`),
        ].join('\n').toLocaleLowerCase('zh-CN').includes(normalizedQuery))
      )),
    }));
  }, [query, tasks]);

  if (selectedTask) {
    return (
      <>
        <TestTaskDetail
          task={selectedTask}
          project={project}
          user={user}
          payload={state.payload}
          busy={busy}
          comment={comment}
          onCommentChange={setComment}
          onBack={() => setSelectedId('')}
          onDialog={setDialog}
          onRefresh={() => refreshOne(selectedTask.recordId)}
          onComment={handleComment}
          onDeleteComment={handleDeleteComment}
        />
        {dialog ? (
          <TestTaskDialog
            dialog={dialog}
            payload={state.payload}
            busy={busy}
            onChange={setDialog}
            onClose={() => setDialog(null)}
            onSubmit={handleDialogSubmit}
          />
        ) : null}
      </>
    );
  }

  return (
    <section className="test-task-management">
      <header className="test-task-header">
        <div>
          <span>测试执行</span>
          <h1>{project.projectName || '未命名项目'}的测试任务</h1>
          <p>按子任务记录测试结论，并在完成时自动提交已准备的反馈。</p>
        </div>
        <button className="test-task-primary" type="button" onClick={() => setDialog(createTaskDialog())}>
          <Plus aria-hidden="true" />
          创建测试任务
        </button>
      </header>
      {state.message ? <p className="test-task-notice">{state.message}</p> : null}
      <div className="test-task-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索任务名称、任务 ID 或测试内容"
          aria-label="搜索测试任务"
        />
        <button type="button" className="test-task-icon-button" title="刷新" onClick={() => reload()}>
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      {state.status === 'loading' && !state.payload ? (
        <div className="test-task-empty"><LoaderCircle className="is-spinning" />正在读取测试任务</div>
      ) : null}
      {state.status === 'error' && !state.payload ? (
        <div className="test-task-empty">{state.message || '测试任务读取失败'}</div>
      ) : null}
      <div className="test-task-groups">
        {filteredGroups.map((group) => (
          <section key={group.status} className="test-task-group">
            <div className="test-task-group-heading">
              <strong>{group.status}</strong>
              <span>{group.tasks.length}</span>
            </div>
            {group.tasks.length ? group.tasks.map((task) => (
              <button
                key={task.recordId}
                type="button"
                className="test-task-row"
                onClick={() => setSelectedId(task.recordId)}
              >
                <span className={`test-task-status is-${statusClass(task.status)}`}>{task.status}</span>
                <span className="test-task-row-main">
                  <strong>{task.title}</strong>
                  <small>{task.itemId || '无任务ID'} · {task.content.items.length} 个子任务</small>
                </span>
                <span>{formatPeople(task.testers) || (task.status === '待测试' ? '待分配' : '未设置')}</span>
                <span>{countConclusions(task)}/{task.content.items.length} 已记录</span>
              </button>
            )) : <p className="test-task-group-empty">暂无{group.status}任务</p>}
          </section>
        ))}
      </div>
      {dialog ? (
        <TestTaskDialog
          dialog={dialog}
          payload={state.payload}
          busy={busy}
          onChange={setDialog}
          onClose={() => setDialog(null)}
          onSubmit={handleDialogSubmit}
        />
      ) : null}
    </section>
  );

  function applyPayload(payload, message) {
    setState({ status: 'ready', message, payload });
    const pending = (payload.testTasks || []).filter((task) => (
      payload.isTestAdmin
        ? ['待测试', '测试中'].includes(task.status)
        : task.status === '测试中' && hasUser(task.testers, user)
    )).length;
    onPendingCountChange?.(pending);
  }

  async function reload() {
    setBusy('refresh');
    try {
      const payload = await ensureProjectTestTasks(project.projectId);
      await saveCachedSnapshot(cacheUserKey, snapshotKey, payload);
      applyPayload(payload, '');
    } catch (error) {
      onDirectNotice?.({ type: 'error', message: formatError(error) });
    } finally {
      setBusy('');
    }
  }

  async function refreshOne(recordId) {
    try {
      const payload = await fetchTestTask(project.projectId, recordId);
      if (!payload.task) return;
      setState((current) => updatePayload(current, (value) => ({
        ...value,
        testTasks: replaceTask(value.testTasks, payload.task),
      })));
    } catch {
      void reload();
    }
  }

  async function handleDialogSubmit() {
    setBusy(dialog.type);
    try {
      let result;
      if (dialog.type === 'create') {
        result = await createTestTask(project.projectId, {
          title: dialog.title,
          items: dialog.items,
          clientMutationId: createTestTaskMutationId(),
        });
        applyPayload(result, '');
        setSelectedId(result.task?.recordId || '');
      } else if (dialog.type === 'edit') {
        result = await updateTestTask(project.projectId, dialog.task.recordId, {
          title: dialog.title,
          items: dialog.items,
          expectedRevision: dialog.task.content.revision,
          clientMutationId: createTestTaskMutationId(),
        });
        mergeTask(result.task);
      } else if (dialog.type === 'start') {
        result = await startTestTask(project.projectId, dialog.task.recordId, {
          testers: dialog.testers,
          clientMutationId: createTestTaskMutationId(),
        });
        mergeTask(result.task);
      } else if (dialog.type === 'testers') {
        result = await updateTestTaskTesters(project.projectId, dialog.task.recordId, {
          testers: dialog.testers,
          reason: dialog.reason,
          clientMutationId: createTestTaskMutationId(),
        });
        mergeTask(result.task);
      } else if (dialog.type === 'results') {
        result = await saveTestTaskResults(project.projectId, dialog.task.recordId, {
          results: dialog.results,
          expectedRevision: dialog.task.results.revision,
          clientMutationId: createTestTaskMutationId(),
        });
        mergeTask(result.task);
      } else if (dialog.type === 'complete') {
        result = await completeTestTask(project.projectId, dialog.task.recordId, {
          expectedRevision: dialog.task.results.revision,
          clientMutationId: createTestTaskMutationId(),
        });
        mergeTask(result.task);
      } else if (dialog.type === 'delete') {
        await deleteTestTask(project.projectId, dialog.task.recordId);
        setState((current) => updatePayload(current, (value) => ({
          ...value,
          testTasks: value.testTasks.filter((task) => task.recordId !== dialog.task.recordId),
        })));
        setSelectedId('');
      }
      setDialog(null);
    } catch (error) {
      setDialog((current) => ({
        ...current,
        ...(error.payload?.task ? { task: error.payload.task } : {}),
        error: formatError(error),
      }));
      if (error.payload?.task) {
        mergeTask(error.payload.task);
      }
    } finally {
      setBusy('');
    }
  }

  async function handleComment() {
    if (!comment.trim() || !selectedTask) return;
    setBusy('comment');
    try {
      const result = await appendRecordComment(TOOL_CONFIG, project.projectId, selectedTask.recordId, {
        content: comment.trim(),
        mentionedUsers: [],
        notifyMentioned: false,
        clientMutationId: createTestTaskMutationId(),
      });
      mergeTask({ ...selectedTask, comments: result.comments });
      setComment('');
    } catch (error) {
      onDirectNotice?.({ type: 'error', message: formatError(error) });
    } finally {
      setBusy('');
    }
  }

  async function handleDeleteComment(commentId) {
    if (!selectedTask) return;
    try {
      const result = await deleteRecordComment(
        TOOL_CONFIG,
        project.projectId,
        selectedTask.recordId,
        commentId,
      );
      mergeTask({ ...selectedTask, comments: result.comments });
    } catch (error) {
      onDirectNotice?.({ type: 'error', message: formatError(error) });
    }
  }

  function mergeTask(task) {
    if (!task) return;
    setState((current) => updatePayload(current, (value) => ({
      ...value,
      testTasks: replaceTask(value.testTasks, task),
    })));
  }
}

function TestTaskDetail({
  task,
  project,
  user,
  payload,
  busy,
  comment,
  onCommentChange,
  onBack,
  onDialog,
  onRefresh,
  onComment,
  onDeleteComment,
}) {
  return (
    <section className="test-task-management test-task-detail">
      <header className="test-task-detail-header">
        <button type="button" className="test-task-icon-button" title="返回列表" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <div>
          <span>{task.itemId || '无任务ID'} · {task.status}</span>
          <h1>{task.title}</h1>
          <p>创建人：{formatPeople(task.creators) || '未知'} · 测试人员：{formatPeople(task.testers) || '未设置'}</p>
        </div>
        <div className="test-task-detail-actions">
          {task.permissions.canEditContent ? (
            <button type="button" className="test-task-secondary" onClick={() => onDialog(editTaskDialog(task))}>
              <Pencil />编辑
            </button>
          ) : null}
          {task.permissions.canStart ? (
            <button type="button" className="test-task-primary" onClick={() => onDialog(peopleDialog('start', task, payload))}>
              <Play />开始测试
            </button>
          ) : null}
          {task.permissions.canAdjustTesters ? (
            <button type="button" className="test-task-secondary" onClick={() => onDialog(peopleDialog('testers', task, payload))}>
              <Users />调整人员
            </button>
          ) : null}
          {task.permissions.canEditResults ? (
            <button type="button" className="test-task-primary" onClick={() => onDialog(resultsDialog(task))}>
              <ClipboardCheck />填写结果
            </button>
          ) : null}
          {task.permissions.canComplete ? (
            <button type="button" className="test-task-primary" onClick={() => onDialog({ type: 'complete', task, error: '' })}>
              <Check />完成
            </button>
          ) : null}
          {task.permissions.canDelete ? (
            <button type="button" className="test-task-danger-icon" title="删除" onClick={() => onDialog({ type: 'delete', task, error: '' })}>
              <Trash2 />
            </button>
          ) : null}
          <button type="button" className="test-task-icon-button" title="刷新" onClick={onRefresh}>
            <RefreshCw />
          </button>
        </div>
      </header>
      <div className="test-task-summary-strip">
        <span>{task.content.items.length} 个子任务</span>
        <span>{countConclusions(task)} 项已记录结论</span>
        <span>{task.relatedFeedback.items?.length || 0} 条关联反馈</span>
      </div>
      <section className="test-task-items">
        {task.content.items.map((item) => {
          const result = task.results.items.find((entry) => entry.itemId === item.id);
          return (
            <article key={item.id} className="test-task-item">
              <div className="test-task-item-heading">
                <code>{item.id}</code>
                <strong>{item.content}</strong>
              </div>
              <div className="test-task-conclusion">
                <span>测试结论</span>
                <p>{result?.conclusion || '尚未填写'}</p>
              </div>
              {result?.feedbackDraft ? (
                <div className="test-task-feedback-draft">
                  <MessageSquarePlus />
                  <div>
                    <strong>{result.feedbackDraft.title}</strong>
                    <p>{result.feedbackDraft.feedbackRecordId ? '反馈已提交' : '完成任务时自动提交反馈'}</p>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </section>
      <WorkItemTimelinePanel toolConfig={TOOL_CONFIG} record={task} />
      <section className="test-task-comments">
        <h2>留言</h2>
        <div className="test-task-comment-compose">
          <textarea value={comment} onChange={(event) => onCommentChange(event.target.value)} placeholder="添加留言" />
          <button type="button" className="test-task-primary" disabled={busy === 'comment'} onClick={onComment}>
            <MessageSquarePlus />发送
          </button>
        </div>
        {task.comments.map((item) => (
          <article key={item.id} className="test-task-comment">
            <div>
              <strong>{item.authorName || '未知用户'}</strong>
              <span>{formatDate(item.createdAt)}</span>
            </div>
            <p>{item.content}</p>
            {hasUser([{ openId: item.authorOpenId }], user) ? (
              <button type="button" title="删除留言" onClick={() => onDeleteComment(item.id)}><Trash2 /></button>
            ) : null}
          </article>
        ))}
      </section>
    </section>
  );
}

function TestTaskDialog({ dialog, payload, busy, onChange, onClose, onSubmit }) {
  const titleMap = {
    create: '创建测试任务',
    edit: '编辑测试任务',
    start: '开始测试',
    testers: '调整测试人员',
    results: '填写测试结果',
    complete: '完成测试任务',
    delete: '删除测试任务',
  };
  return (
    <div className="test-task-dialog-backdrop" role="presentation">
      <section className="test-task-dialog" role="dialog" aria-modal="true" aria-label={titleMap[dialog.type]}>
        <header>
          <h2>{titleMap[dialog.type]}</h2>
          <button type="button" className="test-task-icon-button" title="关闭" onClick={onClose}><X /></button>
        </header>
        {['create', 'edit'].includes(dialog.type) ? (
          <TaskFields dialog={dialog} onChange={onChange} />
        ) : null}
        {['start', 'testers'].includes(dialog.type) ? (
          <TesterFields dialog={dialog} candidates={payload?.testerCandidates || []} onChange={onChange} />
        ) : null}
        {dialog.type === 'results' ? <ResultFields dialog={dialog} onChange={onChange} /> : null}
        {dialog.type === 'complete' ? <p>确认所有测试结论无误并完成任务？已建立的反馈草稿会立即提交。</p> : null}
        {dialog.type === 'delete' ? <p>确认永久删除“{dialog.task.title}”？此操作不会删除已经创建的反馈。</p> : null}
        {dialog.error ? <p className="test-task-dialog-error">{dialog.error}</p> : null}
        <footer>
          <button type="button" className="test-task-secondary" onClick={onClose}>取消</button>
          <button type="button" className={dialog.type === 'delete' ? 'test-task-danger' : 'test-task-primary'} disabled={Boolean(busy)} onClick={onSubmit}>
            {busy ? <LoaderCircle className="is-spinning" /> : dialog.type === 'delete' ? <Trash2 /> : <Save />}
            确认
          </button>
        </footer>
      </section>
    </div>
  );
}

function TaskFields({ dialog, onChange }) {
  return (
    <div className="test-task-form">
      <label>任务名称<input value={dialog.title} onChange={(event) => onChange({ ...dialog, title: event.target.value })} maxLength={200} /></label>
      <div className="test-task-form-heading">
        <strong>测试子任务</strong>
        <button type="button" className="test-task-secondary" onClick={() => {
          const id = createUniqueTestTaskItemId(dialog.items.map((item) => item.id));
          onChange({ ...dialog, items: [...dialog.items, { id, content: '' }] });
        }}><Plus />添加</button>
      </div>
      {dialog.items.map((item, index) => (
        <div key={item.id} className="test-task-item-editor">
          <code>{item.id}</code>
          <textarea value={item.content} onChange={(event) => onChange({
            ...dialog,
            items: dialog.items.map((entry) => entry.id === item.id ? { ...entry, content: event.target.value } : entry),
          })} maxLength={2000} />
          <div className="test-task-item-editor-actions">
            <button
              type="button"
              title="上移"
              disabled={index === 0}
              onClick={() => onChange({ ...dialog, items: moveItem(dialog.items, index, index - 1) })}
            ><ArrowUp /></button>
            <button
              type="button"
              title="下移"
              disabled={index === dialog.items.length - 1}
              onClick={() => onChange({ ...dialog, items: moveItem(dialog.items, index, index + 1) })}
            ><ArrowDown /></button>
            <button
              type="button"
              title="移除"
              disabled={dialog.items.length === 1}
              onClick={() => onChange({ ...dialog, items: dialog.items.filter((entry) => entry.id !== item.id) })}
            ><Trash2 /></button>
          </div>
          <span>{index + 1}</span>
        </div>
      ))}
    </div>
  );
}

function TesterFields({ dialog, candidates, onChange }) {
  return (
    <div className="test-task-form">
      <div className="test-task-tester-grid">
        {candidates.map((candidate) => {
          const checked = hasUser(dialog.testers, candidate);
          return (
            <label key={candidate.openId || candidate.name}>
              <input type="checkbox" checked={checked} onChange={() => onChange({
                ...dialog,
                testers: checked
                  ? dialog.testers.filter((item) => !hasUser([item], candidate))
                  : [...dialog.testers, candidate],
              })} />
              <span>{candidate.name}</span>
            </label>
          );
        })}
      </div>
      {dialog.type === 'testers' ? (
        <label>调整原因<textarea value={dialog.reason} onChange={(event) => onChange({ ...dialog, reason: event.target.value })} /></label>
      ) : null}
    </div>
  );
}

function ResultFields({ dialog, onChange }) {
  return (
    <div className="test-task-result-editors">
      {dialog.task.content.items.map((contentItem) => {
        const result = dialog.results.find((item) => item.itemId === contentItem.id);
        const draft = result.feedbackDraft;
        return (
          <section key={contentItem.id} className="test-task-result-editor">
            <div><code>{contentItem.id}</code><strong>{contentItem.content}</strong></div>
            <label>测试结论<textarea value={result.conclusion} onChange={(event) => updateDialogResult(onChange, dialog, contentItem.id, { conclusion: event.target.value })} maxLength={5000} /></label>
            <label className="test-task-feedback-toggle">
              <input type="checkbox" checked={Boolean(draft)} onChange={(event) => updateDialogResult(onChange, dialog, contentItem.id, {
                feedbackDraft: event.target.checked ? {
                  title: buildDefaultTestFeedbackTitle(dialog.task.title, contentItem.content),
                  content: result.conclusion,
                  attachments: [],
                  newFiles: [],
                } : null,
              })} />
              为该结论创建反馈草稿
            </label>
            {draft ? (
              <div className="test-task-feedback-fields">
                <label>反馈标题<input value={draft.title} onChange={(event) => updateDraft(onChange, dialog, contentItem.id, { title: event.target.value })} maxLength={200} /></label>
                <label>反馈内容<textarea value={draft.content} onChange={(event) => updateDraft(onChange, dialog, contentItem.id, { content: event.target.value })} maxLength={5000} /></label>
                <label className="test-task-file-picker"><FilePlus2 />添加附件<input type="file" multiple onChange={(event) => updateDraft(onChange, dialog, contentItem.id, { newFiles: [...(draft.newFiles || []), ...event.target.files] })} /></label>
                <span>{(draft.attachments?.length || 0) + (draft.newFiles?.length || 0)} 个附件</span>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function createTaskDialog() {
  return {
    type: 'create',
    title: '',
    items: [{ id: createUniqueTestTaskItemId([]), content: '' }],
    error: '',
  };
}

function editTaskDialog(task) {
  return { type: 'edit', task, title: task.title, items: task.content.items, error: '' };
}

function peopleDialog(type, task, payload) {
  return {
    type,
    task,
    testers: type === 'testers' ? task.testers : [],
    candidates: payload?.testerCandidates || [],
    reason: '',
    error: '',
  };
}

function resultsDialog(task) {
  return {
    type: 'results',
    task,
    results: task.results.items.map((item) => ({
      ...item,
      feedbackDraft: item.feedbackDraft ? { ...item.feedbackDraft, newFiles: [] } : null,
    })),
    error: '',
  };
}

function updateDialogResult(onChange, dialog, itemId, updates) {
  onChange({
    ...dialog,
    results: dialog.results.map((item) => item.itemId === itemId ? { ...item, ...updates } : item),
  });
}

function updateDraft(onChange, dialog, itemId, updates) {
  const result = dialog.results.find((item) => item.itemId === itemId);
  updateDialogResult(onChange, dialog, itemId, {
    feedbackDraft: { ...result.feedbackDraft, ...updates },
  });
}

function replaceTask(tasks, task) {
  const exists = tasks.some((item) => item.recordId === task.recordId);
  return exists
    ? tasks.map((item) => item.recordId === task.recordId ? task : item)
    : [task, ...tasks];
}

function moveItem(items, fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function updatePayload(state, updater) {
  if (!state.payload) return state;
  const payload = updater(state.payload);
  return { ...state, status: 'ready', payload };
}

function countConclusions(task) {
  return task.results.items.filter((item) => item.conclusion?.trim()).length;
}

function formatPeople(people) {
  return (people || []).map((item) => item.name || item.openId).filter(Boolean).join('、');
}

function hasUser(people, user) {
  const wanted = new Set([user?.openId, user?.userId, user?.unionId, user?.email].filter(Boolean));
  return (people || []).some((item) => [item?.openId, item?.userId, item?.unionId, item?.email]
    .filter(Boolean)
    .some((key) => wanted.has(key)));
}

function statusClass(status) {
  return status === '待测试' ? 'waiting' : status === '测试中' ? 'testing' : 'completed';
}

function formatDate(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
    : '';
}

function formatError(error) {
  return error?.payload?.message || error?.message || '操作失败';
}
