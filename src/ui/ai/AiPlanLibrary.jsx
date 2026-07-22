import { useEffect, useState } from 'react';
import {
  Check,
  Download,
  FileText,
  LoaderCircle,
  RotateCcw,
  Search,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  adoptAiPlan,
  fetchAiPlan,
  getAiPlanRawUrl,
  listAiPlans,
  withdrawAiPlan,
} from '../../api/aiPlans.js';

export function AiPlanLibrary({ project }) {
  const [filters, setFilters] = useState({ toolId: '', status: '', search: '' });
  const [state, setState] = useState({
    status: 'loading',
    message: '',
    submissions: [],
    allowedToolIds: [],
    canAdopt: false,
  });
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [actionStatus, setActionStatus] = useState({ type: 'idle', message: '' });

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
          canAdopt: Boolean(payload.canAdopt),
        });
        setSelectedId((current) => (
          submissions.some((item) => item.id === current) ? current : submissions[0]?.id || ''
        ));
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
  }, [filters, project.projectId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return undefined;
    }
    let active = true;
    setActionStatus({ type: 'idle', message: '' });
    fetchAiPlan(project.projectId, selectedId)
      .then((payload) => {
        if (active) {
          setDetail(payload.submission || null);
          setState((current) => ({ ...current, canAdopt: Boolean(payload.canAdopt) }));
        }
      })
      .catch((error) => {
        if (active) {
          setActionStatus({ type: 'error', message: formatPlanError(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [project.projectId, selectedId]);

  async function handleAdopt() {
    if (!detail || actionStatus.type === 'loading') {
      return;
    }
    setActionStatus({ type: 'loading', message: '正在采纳方案' });
    try {
      const payload = await adoptAiPlan(project.projectId, detail.id);
      mergeUpdatedSubmission(payload.submission);
      setActionStatus({ type: 'success', message: '已将该方案设为当前采纳方案' });
    } catch (error) {
      setActionStatus({ type: 'error', message: formatPlanError(error) });
    }
  }

  async function handleWithdraw() {
    if (!detail || actionStatus.type === 'loading') {
      return;
    }
    const confirmed = window.confirm('确定撤回这份方案吗？撤回后不会出现在默认方案列表中。');
    if (!confirmed) {
      return;
    }
    setActionStatus({ type: 'loading', message: '正在撤回方案' });
    try {
      await withdrawAiPlan(project.projectId, detail.id);
      const remaining = state.submissions.filter((item) => item.id !== detail.id);
      setState((current) => ({ ...current, submissions: remaining }));
      setSelectedId(remaining[0]?.id || '');
      setDetail(null);
      setActionStatus({ type: 'idle', message: '' });
    } catch (error) {
      setActionStatus({ type: 'error', message: formatPlanError(error) });
    }
  }

  function mergeUpdatedSubmission(submission) {
    setDetail(submission);
    setState((current) => ({
      ...current,
      submissions: current.submissions.map((item) => {
        if (
          item.toolId === submission.toolId
          && item.recordId === submission.recordId
          && item.status === 'adopted'
          && item.id !== submission.id
        ) {
          return { ...item, status: 'candidate' };
        }
        return item.id === submission.id ? { ...item, ...submission } : item;
      }),
    }));
  }

  return (
    <section className="ai-plan-library" aria-label="AI 方案库">
      <header className="ai-plan-library-header">
        <div>
          <h1>AI 方案</h1>
          <span>项目成员提交的需求与 Bug 实施计划</span>
        </div>
      </header>
      <div className="ai-plan-filters">
        <label className="ai-plan-search">
          <Search aria-hidden="true" />
          <input
            className="allow-text-select"
            value={filters.search}
            placeholder="搜索标题、摘要、工作项或提交人"
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
          />
        </label>
        <select
          className="allow-text-select"
          value={filters.toolId}
          onChange={(event) => setFilters((current) => ({ ...current, toolId: event.target.value }))}
        >
          <option value="">全部类型</option>
          {state.allowedToolIds.includes('requirements') ? <option value="requirements">需求</option> : null}
          {state.allowedToolIds.includes('bugs') ? <option value="bugs">Bug</option> : null}
        </select>
        <select
          className="allow-text-select"
          value={filters.status}
          onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
        >
          <option value="">有效方案</option>
          <option value="candidate">候选</option>
          <option value="adopted">已采纳</option>
          <option value="withdrawn">已撤回</option>
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
              onClick={() => setSelectedId(submission.id)}
            >
              <div>
                <span className={`ai-plan-status is-${submission.status}`}>
                  {formatPlanStatus(submission.status)}
                </span>
                <span>{submission.toolId === 'bugs' ? 'Bug' : '需求'} · {submission.workItemId || submission.recordId}</span>
              </div>
              <strong>{submission.title}</strong>
              <p>{submission.workItemTitle ? `${submission.workItemTitle} · ${submission.summary || '无摘要'}` : submission.summary || '无摘要'}</p>
              <small>{submission.authorName} · 修订 {submission.revision} · {formatPlanTime(submission.submittedAt)}</small>
            </button>
          ))}
        </aside>

        <main className="ai-plan-detail">
          {!detail ? (
            <div className="ai-plan-detail-empty">
              <FileText aria-hidden="true" />
              <span>从左侧选择一份方案</span>
            </div>
          ) : (
            <>
              <header className="ai-plan-detail-header">
                <div>
                  <div className="ai-plan-detail-meta">
                    <span className={`ai-plan-status is-${detail.status}`}>{formatPlanStatus(detail.status)}</span>
                    <span>{detail.toolId === 'bugs' ? 'Bug' : '需求'} · {detail.workItemId || detail.recordId}</span>
                    <span>修订 {detail.revision}</span>
                  </div>
                  <h2>{detail.title}</h2>
                  <p>{detail.summary || '无摘要'}</p>
                  <small>{detail.authorName} 提交于 {formatPlanTime(detail.submittedAt)}</small>
                </div>
                <div className="ai-plan-detail-actions">
                  <a
                    className="ai-secondary-button"
                    href={getAiPlanRawUrl(project.projectId, detail.id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Download aria-hidden="true" />
                    原始 Markdown
                  </a>
                  {state.canAdopt && detail.status !== 'adopted' && detail.status !== 'withdrawn' ? (
                    <button type="button" className="ai-primary-button" onClick={handleAdopt}>
                      <Check aria-hidden="true" />
                      采纳
                    </button>
                  ) : null}
                  {detail.isOwnPlan && detail.status === 'candidate' ? (
                    <button type="button" className="ai-danger-button" onClick={handleWithdraw}>
                      <RotateCcw aria-hidden="true" />
                      撤回
                    </button>
                  ) : null}
                </div>
              </header>
              {actionStatus.message ? <p className={`ai-inline-status is-${actionStatus.type}`}>{actionStatus.message}</p> : null}
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
          )}
        </main>
      </div>
    </section>
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

function formatPlanStatus(status) {
  return {
    candidate: '候选',
    adopted: '已采纳',
    withdrawn: '已撤回',
  }[status] || '未知';
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
