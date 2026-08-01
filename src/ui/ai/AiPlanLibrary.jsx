import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  BadgeCheck,
  Bot,
  Check,
  CircleHelp,
  Download,
  ExternalLink,
  FileText,
  History,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  approveAiPlan,
  createAiPlanRevision,
  deleteAiPlan,
  fetchAiPlan,
  getAiPlanRawUrl,
  listAiPlans,
  rejectAiPlan,
  setAiPlanApplied,
  withdrawAiPlan,
} from '../../api/aiPlans.js';
import { createAiClientMutationId } from '../../api/aiConversations.js';

export function AiPlanLibrary({
  project,
  activity = null,
  directTarget = null,
  onActivityChange,
  onOpenWorkItem,
}) {
  const [filters, setFilters] = useState({ toolId: '', status: '', search: '' });
  const [state, setState] = useState({
    status: 'loading',
    message: '',
    submissions: [],
    allowedToolIds: [],
  });
  const [selectedId, setSelectedId] = useState(
    () => String(directTarget?.submissionId || '').trim(),
  );
  const [detailState, setDetailState] = useState({
    status: 'idle',
    message: '',
    submission: null,
    revisions: [],
    events: [],
    permissions: {},
    workItem: null,
  });
  const [actionStatus, setActionStatus] = useState({ type: 'idle', message: '' });
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    const submissionId = String(directTarget?.submissionId || '').trim();
    if (directTarget?.type === 'ai-plan' && submissionId) {
      setSelectedId(submissionId);
    }
  }, [directTarget?.key, directTarget?.submissionId, directTarget?.type]);

  useEffect(() => {
    let active = true;
    const timeout = setTimeout(async () => {
      try {
        const payload = await listAiPlans(project.projectId, filters);
        if (!active) {
          return;
        }
        const submissions = Array.isArray(payload.submissions) ? payload.submissions : [];
        setState({
          status: 'ready',
          message: '',
          submissions,
          allowedToolIds: payload.allowedToolIds || [],
        });
        setSelectedId((current) => {
          const directSubmissionId = String(directTarget?.submissionId || '').trim();
          if (directSubmissionId && current === directSubmissionId) {
            return current;
          }
          return submissions.some((item) => item.id === current)
            ? current
            : submissions[0]?.id || '';
        });
      } catch (error) {
        if (active) {
          setState((current) => ({
            ...current,
            status: 'error',
            message: formatPlanError(error),
            submissions: [],
          }));
        }
      }
    }, filters.search ? 250 : 0);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [directTarget?.submissionId, filters, project.projectId, refreshSequence]);

  useEffect(() => {
    if (!selectedId) {
      setDetailState({
        status: 'idle',
        message: '',
        submission: null,
        revisions: [],
        events: [],
        permissions: {},
        workItem: null,
      });
      return undefined;
    }
    let active = true;
    setDetailState((current) => ({ ...current, status: 'loading', message: '' }));
    fetchAiPlan(project.projectId, selectedId)
      .then((payload) => {
        if (active) {
          setDetailState({
            status: 'ready',
            message: '',
            submission: payload.submission || null,
            revisions: Array.isArray(payload.revisions) ? payload.revisions : [],
            events: Array.isArray(payload.events) ? payload.events : [],
            permissions: payload.permissions || {},
            workItem: payload.workItem || null,
          });
        }
      })
      .catch((error) => {
        if (active) {
          setDetailState((current) => ({
            ...current,
            status: 'error',
            message: formatPlanError(error),
            submission: null,
          }));
        }
      });
    return () => {
      active = false;
    };
  }, [project.projectId, refreshSequence, selectedId]);

  const detail = detailState.submission;

  async function handleApprove() {
    if (!detail || actionStatus.type === 'loading') {
      return;
    }
    if (!window.confirm('确定通过这份 AI 方案吗？它将成为当前工作项的已通过方案。')) {
      return;
    }
    setActionStatus({ type: 'loading', message: '正在通过方案' });
    try {
      const result = await approveAiPlan(project.projectId, detail.id);
      setActionStatus({
        type: 'success',
        message: formatReviewNotificationMessage(result, '方案已通过审核'),
      });
      onActivityChange?.();
      setRefreshSequence((current) => current + 1);
    } catch (error) {
      setActionStatus({ type: 'error', message: formatPlanError(error) });
    }
  }

  async function handleReject(reason) {
    setActionStatus({ type: 'loading', message: '正在拒绝方案' });
    try {
      const result = await rejectAiPlan(project.projectId, detail.id, reason);
      setRejectOpen(false);
      setActionStatus({
        type: 'success',
        message: formatReviewNotificationMessage(result, '方案已拒绝'),
      });
      onActivityChange?.();
      setRefreshSequence((current) => current + 1);
    } catch (error) {
      setActionStatus({ type: 'error', message: formatPlanError(error) });
    }
  }

  async function handleAppliedChange(applied) {
    if (!detail || actionStatus.type === 'loading') {
      return;
    }
    setActionStatus({
      type: 'loading',
      message: applied ? '正在标记方案为已应用' : '正在取消已应用标记',
    });
    try {
      const result = await setAiPlanApplied(
        project.projectId,
        detail.id,
        applied,
        createAiClientMutationId(),
      );
      setActionStatus({
        type: 'success',
        message: applied ? '方案已标记为已应用' : '已取消方案的已应用标记',
      });
      setDetailState((current) => ({
        ...current,
        submission: result.submission || current.submission,
      }));
      setState((current) => ({
        ...current,
        submissions: current.submissions.map((submission) => (
          submission.id === detail.id
            ? { ...submission, ...(result.submission || {}) }
            : submission
        )),
      }));
      setRefreshSequence((current) => current + 1);
    } catch (error) {
      setActionStatus({ type: 'error', message: formatPlanError(error) });
    }
  }

  async function handleEdit(payload) {
    setActionStatus({ type: 'loading', message: '正在创建新修订' });
    try {
      const result = await createAiPlanRevision(project.projectId, detail.id, payload);
      setEditOpen(false);
      setSelectedId(result.submission.id);
      setActionStatus({
        type: 'success',
        message: formatReviewNotificationMessage(
          result,
          '已创建新修订并重新进入待审核',
        ),
      });
      onActivityChange?.();
      setRefreshSequence((current) => current + 1);
    } catch (error) {
      setActionStatus({ type: 'error', message: formatPlanError(error) });
    }
  }

  async function handleWithdraw() {
    if (!detail || actionStatus.type === 'loading') {
      return;
    }
    if (!window.confirm('确定撤回这份待审核方案吗？撤回后仍会保留在修订历史中。')) {
      return;
    }
    setActionStatus({ type: 'loading', message: '正在撤回方案' });
    try {
      await withdrawAiPlan(project.projectId, detail.id);
      setActionStatus({ type: 'success', message: '方案已撤回' });
      onActivityChange?.();
      setRefreshSequence((current) => current + 1);
    } catch (error) {
      setActionStatus({ type: 'error', message: formatPlanError(error) });
    }
  }

  async function handleDelete() {
    if (!detail || actionStatus.type === 'loading') {
      return;
    }
    if (!window.confirm('确定删除这份 AI 方案及其全部修订记录吗？删除后不可恢复。')) {
      return;
    }
    setActionStatus({ type: 'loading', message: '正在删除方案' });
    try {
      await deleteAiPlan(project.projectId, detail.id);
      setSelectedId('');
      setDetailState({
        status: 'idle',
        message: '',
        submission: null,
        revisions: [],
        events: [],
        permissions: {},
        workItem: null,
      });
      setActionStatus({ type: 'success', message: '方案及其修订记录已删除' });
      onActivityChange?.();
      setRefreshSequence((current) => current + 1);
    } catch (error) {
      setActionStatus({ type: 'error', message: formatPlanError(error) });
    }
  }

  return (
    <section className="ai-plan-library" aria-label="AI 方案库">
      <header className="ai-plan-library-header">
        <div>
          <h1><Sparkles aria-hidden="true" />AI 方案</h1>
          <span>查看需求与 Bug 的实施计划、审核状态和修订记录</span>
        </div>
      </header>
      <AiGenerationTaskPanel
        activity={activity}
        onOpen={(task) => onOpenWorkItem?.(
          task.toolId,
          task.recordId,
          {
            conversationId: task.conversationId,
            focus: task.status === 'awaiting_user' ? 'questions' : '',
          },
        )}
      />
      <div className="ai-plan-filters">
        <label className="ai-plan-search">
          <Search aria-hidden="true" />
          <input
            className="allow-text-select"
            value={filters.search}
            placeholder="搜索标题、摘要、工作项或提交人"
            onChange={(event) => setFilters((current) => ({
              ...current,
              search: event.target.value,
            }))}
          />
        </label>
        <select
          className="allow-text-select"
          value={filters.toolId}
          onChange={(event) => setFilters((current) => ({
            ...current,
            toolId: event.target.value,
          }))}
        >
          <option value="">全部类型</option>
          {state.allowedToolIds.includes('requirements') ? <option value="requirements">需求</option> : null}
          {state.allowedToolIds.includes('bugs') ? <option value="bugs">Bug</option> : null}
        </select>
        <select
          className="allow-text-select"
          value={filters.status}
          onChange={(event) => setFilters((current) => ({
            ...current,
            status: event.target.value,
          }))}
        >
          <option value="">待审核与已通过</option>
          <option value="pending_review">待审核</option>
          <option value="approved">已通过</option>
          <option value="rejected">已拒绝</option>
          <option value="withdrawn">已撤回</option>
          <option value="superseded">已被替代</option>
          <option value="all">全部历史</option>
        </select>
      </div>

      <div className="ai-plan-library-layout">
        <aside className="ai-plan-list" aria-label="方案列表">
          {state.status === 'loading' ? <PlanLoading label="正在加载方案" /> : null}
          {state.status === 'error' ? <p className="ai-inline-status is-error">{state.message}</p> : null}
          {state.status === 'ready' && state.submissions.length === 0 ? (
            <div className="ai-plan-list-empty">
              <FileText aria-hidden="true" />
              <span>暂无符合条件的方案</span>
            </div>
          ) : null}
          {state.submissions.map((submission) => (
            <button
              key={submission.id}
              type="button"
              className={`ai-plan-list-row ${submission.id === selectedId ? 'is-active' : ''}`}
              onClick={() => {
                setActionStatus({ type: 'idle', message: '' });
                setSelectedId(submission.id);
              }}
            >
              <div>
                <span className={`ai-plan-status is-${submission.status}`}>
                  {formatPlanStatus(submission.status)}
                </span>
                {submission.applied ? <AiPlanAppliedBadge compact /> : null}
                <span>{submission.toolId === 'bugs' ? 'Bug' : '需求'} · {submission.workItemId || submission.recordId}</span>
              </div>
              <strong>{submission.title}</strong>
              <p>{submission.workItemTitle ? `${submission.workItemTitle} · ${submission.summary || '无摘要'}` : submission.summary || '无摘要'}</p>
              <small>
                {submission.authorName} · 修订 {submission.revision} · {formatPlanTime(submission.submittedAt)}
              </small>
            </button>
          ))}
        </aside>

        <main className="ai-plan-detail">
          {detailState.status === 'loading' ? <PlanLoading label="正在读取方案详情" /> : null}
          {detailState.status === 'error' ? (
            <p className="ai-inline-status is-error">{detailState.message}</p>
          ) : null}
          {actionStatus.message ? (
            <p className={`ai-inline-status is-${actionStatus.type}`}>{actionStatus.message}</p>
          ) : null}
          {detailState.status !== 'loading' && !detail ? (
            <div className="ai-plan-detail-empty">
              <FileText aria-hidden="true" />
              <span>从左侧选择一份方案</span>
            </div>
          ) : null}
          {detail ? (
            <>
              <header className="ai-plan-detail-header">
                <div>
                  <div className="ai-plan-detail-meta">
                    <span className={`ai-plan-status is-${detail.status}`}>{formatPlanStatus(detail.status)}</span>
                    {detail.applied ? <AiPlanAppliedBadge /> : null}
                    <span>{detail.toolId === 'bugs' ? 'Bug' : '需求'} · {detail.workItemId || detail.recordId}</span>
                    <span>修订 {detail.revision}</span>
                  </div>
                  <h2>{detail.title}</h2>
                  <p>{detail.summary || '无摘要'}</p>
                  <small>
                    {detail.authorName} 提交于 {formatPlanTime(detail.submittedAt)}
                    {detail.revisionAuthorName && detail.revisionAuthorName !== detail.authorName
                      ? ` · 本修订由 ${detail.revisionAuthorName} 编辑`
                      : ''}
                  </small>
                </div>
                <div className="ai-plan-detail-actions">
                  <button
                    type="button"
                    className="ai-secondary-button"
                    onClick={() => onOpenWorkItem?.(detail.toolId, detail.recordId)}
                  >
                    <ExternalLink aria-hidden="true" />
                    原工作项
                  </button>
                  <a
                    className="ai-secondary-button"
                    href={getAiPlanRawUrl(project.projectId, detail.id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Download aria-hidden="true" />
                    Markdown
                  </a>
                  {detailState.permissions.canEdit ? (
                    <button type="button" className="ai-secondary-button" onClick={() => setEditOpen(true)}>
                      <Pencil aria-hidden="true" />
                      编辑
                    </button>
                  ) : null}
                  {detailState.permissions.canReject ? (
                    <button type="button" className="ai-danger-button" onClick={() => setRejectOpen(true)}>
                      <XCircle aria-hidden="true" />
                      拒绝
                    </button>
                  ) : null}
                  {detailState.permissions.canApprove ? (
                    <button type="button" className="ai-primary-button" onClick={handleApprove}>
                      <Check aria-hidden="true" />
                      通过
                    </button>
                  ) : null}
                  {detailState.permissions.canWithdraw ? (
                    <button type="button" className="ai-danger-button" onClick={handleWithdraw}>
                      <RotateCcw aria-hidden="true" />
                      撤回
                    </button>
                  ) : null}
                  {detailState.permissions.canDelete ? (
                    <button type="button" className="ai-danger-button" onClick={handleDelete}>
                      <Trash2 aria-hidden="true" />
                      删除
                    </button>
                  ) : null}
                </div>
              </header>

              {!detailState.workItem?.exists ? (
                <p className="ai-inline-status is-warning">
                  原工作项已不存在或暂时无法读取，方案关联和审核记录仍会保留。
                </p>
              ) : null}
              {detail.status === 'approved' ? (
                <section className="ai-plan-application-row" aria-label="方案应用状态">
                  <div>
                    <span>应用状态</span>
                    {detail.applied ? (
                      <>
                        <AiPlanAppliedBadge />
                        <small>
                          {detail.appliedByName || '处理人'} · {formatPlanTime(detail.appliedAt)}
                        </small>
                      </>
                    ) : (
                      <strong>未应用</strong>
                    )}
                  </div>
                  {detailState.permissions.canSetApplied ? (
                    <label className="ai-plan-application-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={detail.applied === true}
                        disabled={actionStatus.type === 'loading'}
                        onChange={(event) => handleAppliedChange(event.target.checked)}
                      />
                      <span aria-hidden="true" />
                      <strong>{detail.applied ? '已应用' : '未应用'}</strong>
                    </label>
                  ) : null}
                </section>
              ) : null}
              {detail.reviewReason ? (
                <section className="ai-plan-review-note">
                  <strong>审核意见</strong>
                  <span>{detail.reviewReason}</span>
                  <small>
                    {detail.reviewedByName || '审核人'} · {formatPlanTime(detail.reviewedAt)}
                  </small>
                </section>
              ) : null}
              {detailState.revisions.length > 1 ? (
                <section className="ai-plan-revisions" aria-label="修订历史">
                  <div className="ai-plan-section-heading">
                    <History aria-hidden="true" />
                    <strong>修订历史</strong>
                  </div>
                  <div className="ai-plan-revision-list">
                    {detailState.revisions.map((revision) => (
                      <button
                        key={revision.id}
                        type="button"
                        className={revision.id === detail.id ? 'is-active' : ''}
                        onClick={() => {
                          setActionStatus({ type: 'idle', message: '' });
                          setSelectedId(revision.id);
                        }}
                      >
                        <span>修订 {revision.revision}</span>
                        <small>{formatPlanStatus(revision.status)} · {revision.revisionAuthorName || revision.authorName}</small>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {detailState.events.length > 0 ? (
                <section className="ai-plan-audit" aria-label="审核记录">
                  <div className="ai-plan-section-heading">
                    <History aria-hidden="true" />
                    <strong>审核记录</strong>
                  </div>
                  <ol>
                    {detailState.events.map((event) => (
                      <li key={event.id}>
                        <span>{formatPlanEvent(event)}</span>
                        <small>{formatPlanTime(event.createdAt)}</small>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              <article className="ai-markdown ai-plan-document">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.markdown}</ReactMarkdown>
              </article>
              {detail.sourceReferences?.length > 0 ? (
                <section className="ai-source-references">
                  <h3>源文件参考</h3>
                  <ul>
                    {detail.sourceReferences.map((reference) => (
                      <li key={`${reference.rootId}:${reference.relativePath}:${reference.startLine}`}>
                        <code>{reference.rootId}:{reference.relativePath}:{reference.startLine}-{reference.endLine}</code>
                        {reference.note ? <span>{reference.note}</span> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null}
        </main>
      </div>

      {rejectOpen && detail ? (
        <AiPlanRejectDialog
          disabled={actionStatus.type === 'loading'}
          onClose={() => setRejectOpen(false)}
          onSubmit={handleReject}
        />
      ) : null}
      {editOpen && detail ? (
        <AiPlanEditDialog
          submission={detail}
          disabled={actionStatus.type === 'loading'}
          onClose={() => setEditOpen(false)}
          onSubmit={handleEdit}
        />
      ) : null}
    </section>
  );
}

function AiGenerationTaskPanel({ activity, onOpen }) {
  const tasks = Array.isArray(activity?.tasks) ? activity.tasks : [];
  const isLoading = activity?.status === 'idle' || activity?.status === 'loading';

  return (
    <section className="ai-generation-task-panel" aria-label="AI 生成任务">
      <div className="ai-generation-task-heading">
        <span className="ai-generation-task-heading-icon" aria-hidden="true">
          <Bot />
        </span>
        <div>
          <strong>生成任务</strong>
          <span>仅显示你在当前项目中的私有任务</span>
        </div>
        <span className={`ai-generation-task-count ${tasks.length > 0 ? 'has-tasks' : ''}`}>
          {tasks.length > 0 ? `${tasks.length} 项进行中` : '当前无任务'}
        </span>
      </div>
      <div className="ai-generation-task-list">
        {isLoading ? (
          <span className="ai-generation-task-empty">
            <LoaderCircle aria-hidden="true" />
            正在同步任务
          </span>
        ) : null}
        {activity?.status === 'error' ? (
          <span className="ai-generation-task-empty is-error">任务状态暂时无法同步</span>
        ) : null}
        {activity?.status === 'ready' && tasks.length === 0 ? (
          <span className="ai-generation-task-empty">
            <Sparkles aria-hidden="true" />
            新任务开始后会显示在这里
          </span>
        ) : null}
        {tasks.map((task) => {
          const awaitingUser = task.status === 'awaiting_user';
          const queued = task.progress?.stage === 'queued';
          const label = awaitingUser ? '待你确认' : queued ? '排队中' : '生成中';
          return (
            <button
              key={task.conversationId}
              type="button"
              className={`ai-generation-task is-${awaitingUser ? 'awaiting' : 'running'}`}
              onClick={() => onOpen?.(task)}
            >
              <span className="ai-generation-task-state" aria-hidden="true">
                {awaitingUser ? <CircleHelp /> : <LoaderCircle />}
              </span>
              <span className="ai-generation-task-content">
                <span>
                  <b>{label}</b>
                  <small>{task.toolId === 'bugs' ? 'Bug' : '需求'}</small>
                </span>
                <strong>{task.title || 'AI 计划任务'}</strong>
                <small>{task.progress?.message || (awaitingUser ? '等待你回答关键问题' : 'Codex 正在处理')}</small>
              </span>
              <span className="ai-generation-task-open" title="打开任务" aria-label="打开任务">
                <ArrowUpRight aria-hidden="true" />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AiPlanRejectDialog({ disabled, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  return (
    <div className="ai-submit-backdrop" role="presentation">
      <section className="ai-review-dialog" role="dialog" aria-modal="true" aria-label="拒绝 AI 方案">
        <header>
          <div>
            <h3>拒绝 AI 方案</h3>
            <span>拒绝原因会记录在审核历史中并通知原提交者。</span>
          </div>
          <button type="button" className="ai-icon-button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) {
              onSubmit(reason.trim());
            }
          }}
        >
          <label>
            <span>拒绝原因</span>
            <textarea
              className="allow-text-select"
              value={reason}
              maxLength={2000}
              rows={6}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="ai-submit-actions">
            <button type="button" className="ai-secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="ai-danger-button" disabled={disabled || !reason.trim()}>
              <XCircle aria-hidden="true" />
              确认拒绝
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AiPlanEditDialog({ submission, disabled, onClose, onSubmit }) {
  const [title, setTitle] = useState(submission.title || '');
  const [summary, setSummary] = useState(submission.summary || '');
  const [markdown, setMarkdown] = useState(submission.markdown || '');
  const [mode, setMode] = useState('edit');
  return (
    <div className="ai-submit-backdrop" role="presentation">
      <section className="ai-submit-dialog" role="dialog" aria-modal="true" aria-label="编辑 AI 方案">
        <header>
          <div>
            <h3>编辑方案并创建新修订</h3>
            <span>原修订不会被覆盖，新修订会重新进入待审核。</span>
          </div>
          <button type="button" className="ai-icon-button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && markdown.trim()) {
              onSubmit({
                title: title.trim(),
                summary: summary.trim(),
                markdown: markdown.trim(),
              });
            }
          }}
        >
          <label>
            <span>方案标题</span>
            <input className="allow-text-select" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            <span>摘要</span>
            <textarea className="allow-text-select" value={summary} maxLength={2000} rows={2} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <div className="ai-segmented-control" role="tablist" aria-label="Markdown 模式">
            <button type="button" className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode('edit')}>编辑</button>
            <button type="button" className={mode === 'preview' ? 'is-active' : ''} onClick={() => setMode('preview')}>预览</button>
          </div>
          {mode === 'edit' ? (
            <textarea
              className="ai-markdown-editor allow-text-select"
              value={markdown}
              maxLength={200000}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          ) : (
            <div className="ai-markdown ai-submit-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          )}
          <div className="ai-submit-actions">
            <button type="button" className="ai-secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="ai-primary-button" disabled={disabled || !title.trim() || !markdown.trim()}>
              <Pencil aria-hidden="true" />
              创建新修订
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function PlanLoading({ label }) {
  return (
    <div className="ai-loading" role="status">
      <LoaderCircle aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function AiPlanAppliedBadge({ compact = false }) {
  return (
    <span className={`ai-plan-applied-badge ${compact ? 'is-compact' : ''}`}>
      <BadgeCheck aria-hidden="true" />
      已应用
    </span>
  );
}

function formatPlanStatus(status) {
  return {
    pending_review: '待审核',
    approved: '已通过',
    rejected: '已拒绝',
    withdrawn: '已撤回',
    superseded: '已被替代',
  }[status] || '未知';
}

function formatPlanEvent(event) {
  const actor = event.actorName || '系统';
  const labels = {
    submitted: `${actor}提交了方案`,
    revision_submitted: `${actor}提交了新修订`,
    review_revision_created: `${actor}编辑并创建了新修订`,
    approved: `${actor}通过了方案`,
    rejected: `${actor}拒绝了方案${event.reason ? `：${event.reason}` : ''}`,
    withdrawn: `${actor}撤回了方案`,
    superseded: '方案已被后续修订或通过方案替代',
    applied: `${actor}将方案标记为已应用`,
    application_removed: `${actor}移除了已应用标记${event.reason ? `：${event.reason}` : ''}`,
  };
  return labels[event.eventType] || `${actor}更新了方案`;
}

function formatPlanTime(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    return '未知时间';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatPlanError(error) {
  return error instanceof Error && error.message ? error.message : '读取方案失败';
}

function formatReviewNotificationMessage(payload, successMessage) {
  const queuedCount = Number(payload?.notificationQueuedCount || 0);
  if (queuedCount > 0) {
    return `${successMessage}，已安排 ${queuedCount} 条飞书通知`;
  }
  if (payload?.notificationDeliveryEnabled === false) {
    return `${successMessage}，当前未启用飞书 AI 计划通知`;
  }
  return `${successMessage}，未新增飞书通知任务`;
}
