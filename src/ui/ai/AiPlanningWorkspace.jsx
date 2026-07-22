import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  Bot,
  FileCheck2,
  FileText,
  LoaderCircle,
  LockKeyhole,
  MessageSquarePlus,
  Send,
  Square,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  archiveAiConversation,
  cancelAiConversationRun,
  createAiClientMutationId,
  createAiConversation,
  fetchAiConversation,
  listAiConversations,
  sendAiConversationMessage,
  submitAiPlan,
  subscribeAiConversation,
} from '../../api/aiConversations.js';

export function AiPlanningWorkspace({
  projectId,
  toolConfig,
  record,
  onClose,
}) {
  const [state, setState] = useState({
    status: 'loading',
    message: '',
    conversations: [],
  });
  const [selectedId, setSelectedId] = useState('');
  const [conversation, setConversation] = useState(null);
  const [composer, setComposer] = useState('');
  const [streamText, setStreamText] = useState('');
  const [actionStatus, setActionStatus] = useState({ type: 'idle', message: '' });
  const [submitOpen, setSubmitOpen] = useState(false);
  const messageEndRef = useRef(null);
  const selectedConversation = conversation?.id === selectedId ? conversation : null;
  const isRunning = ['queued', 'running'].includes(selectedConversation?.status);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const payload = await listAiConversations(projectId, toolConfig.toolId, record.recordId);
        if (!active) {
          return;
        }
        const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
        setState({ status: 'ready', message: '', conversations });
        setSelectedId((current) => current || conversations[0]?.id || '');
      } catch (error) {
        if (active) {
          setState({ status: 'error', message: formatAiError(error), conversations: [] });
        }
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [projectId, record.recordId, toolConfig.toolId]);

  useEffect(() => {
    if (!selectedId) {
      setConversation(null);
      setStreamText('');
      return undefined;
    }
    let active = true;
    setActionStatus({ type: 'idle', message: '' });
    fetchAiConversation(selectedId)
      .then((payload) => {
        if (active) {
          setConversation(payload.conversation || null);
        }
      })
      .catch((error) => {
        if (active) {
          setActionStatus({ type: 'error', message: formatAiError(error) });
        }
      });

    const unsubscribe = subscribeAiConversation(selectedId, {
      snapshot(snapshot) {
        if (!active || snapshot?.id !== selectedId) {
          return;
        }
        setConversation(snapshot);
        setStreamText('');
        setState((current) => ({
          ...current,
          conversations: mergeConversationSummary(current.conversations, snapshot),
        }));
      },
      'assistant-delta'(payload) {
        if (active) {
          setStreamText((current) => `${current}${String(payload?.delta || '')}`);
        }
      },
      'run-failed'(payload) {
        if (active) {
          setActionStatus({
            type: payload?.status === 'interrupted' ? 'warning' : 'error',
            message: String(payload?.message || 'AI 任务失败'),
          });
        }
      },
      error() {
        if (active) {
          setActionStatus((current) => (
            current.type === 'loading'
              ? current
              : { type: 'warning', message: '实时连接已断开，正在自动重连' }
          ));
        }
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedId]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' });
  }, [selectedConversation?.messages?.length, streamText]);

  async function handleCreateConversation() {
    if (actionStatus.type === 'loading') {
      return;
    }
    setActionStatus({ type: 'loading', message: '正在创建对话' });
    try {
      const payload = await createAiConversation(
        projectId,
        toolConfig.toolId,
        record.recordId,
        `AI计划：${record.title || toolConfig.unnamedTitle}`,
      );
      const next = payload.conversation;
      setState((current) => ({
        ...current,
        status: 'ready',
        conversations: mergeConversationSummary(current.conversations, next),
      }));
      setSelectedId(next.id);
      setConversation(next);
      setActionStatus({ type: 'idle', message: '' });
    } catch (error) {
      setActionStatus({ type: 'error', message: formatAiError(error) });
    }
  }

  async function handleArchiveConversation() {
    if (!selectedConversation || isRunning) {
      return;
    }
    const confirmed = window.confirm('确定删除这条私有 AI 对话吗？已提交的共享方案不会被删除。');
    if (!confirmed) {
      return;
    }
    setActionStatus({ type: 'loading', message: '正在删除对话' });
    try {
      await archiveAiConversation(selectedConversation.id);
      const remaining = state.conversations.filter((item) => item.id !== selectedConversation.id);
      setState((current) => ({ ...current, conversations: remaining }));
      setSelectedId(remaining[0]?.id || '');
      setConversation(null);
      setActionStatus({ type: 'idle', message: '' });
    } catch (error) {
      setActionStatus({ type: 'error', message: formatAiError(error) });
    }
  }

  async function handleSend(event) {
    event.preventDefault();
    const content = composer.trim();
    if (!content || !selectedConversation || isRunning) {
      return;
    }
    setActionStatus({ type: 'loading', message: '已提交，等待 Codex 读取项目' });
    setStreamText('');
    try {
      const payload = await sendAiConversationMessage(selectedConversation.id, {
        content,
        expectedVersion: selectedConversation.version,
        clientMutationId: createAiClientMutationId(),
      });
      setComposer('');
      setConversation(payload.conversation || selectedConversation);
      setActionStatus({ type: 'idle', message: '' });
    } catch (error) {
      if (error?.payload?.conversation) {
        setConversation(error.payload.conversation);
      }
      setActionStatus({ type: 'error', message: formatAiError(error) });
    }
  }

  async function handleCancel() {
    if (!selectedConversation || !isRunning) {
      return;
    }
    setActionStatus({ type: 'loading', message: '正在取消任务' });
    try {
      const payload = await cancelAiConversationRun(selectedConversation.id);
      setConversation(payload.conversation || selectedConversation);
      setStreamText('');
      setActionStatus({ type: 'warning', message: '任务已取消' });
    } catch (error) {
      setActionStatus({ type: 'error', message: formatAiError(error) });
    }
  }

  return (
    <div className="ai-planning-backdrop" role="presentation">
      <section className="ai-planning-workspace" role="dialog" aria-modal="true" aria-label="AI 生成计划">
        <header className="ai-planning-header">
          <div className="ai-planning-heading">
            <Bot aria-hidden="true" />
            <div>
              <h2>AI 生成计划</h2>
              <span>{record.title || toolConfig.unnamedTitle}</span>
            </div>
          </div>
          <button type="button" className="ai-icon-button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="ai-private-notice">
          <LockKeyhole aria-hidden="true" />
          <span>这里的对话仅你可见。提交为方案后，项目内有对应需求或 Bug 权限的成员可以查看。</span>
        </div>

        <div className="ai-planning-layout">
          <aside className="ai-conversation-sidebar" aria-label="我的 AI 对话">
            <div className="ai-conversation-sidebar-header">
              <strong>我的对话</strong>
              <button
                type="button"
                className="ai-icon-button"
                title="新建对话"
                aria-label="新建对话"
                disabled={actionStatus.type === 'loading'}
                onClick={handleCreateConversation}
              >
                <MessageSquarePlus aria-hidden="true" />
              </button>
            </div>
            {state.status === 'loading' ? <AiLoading label="正在加载对话" /> : null}
            {state.status === 'error' ? <p className="ai-inline-status is-error">{state.message}</p> : null}
            <div className="ai-conversation-list">
              {state.conversations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`ai-conversation-row ${item.id === selectedId ? 'is-active' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span>{item.title || '新的 AI 计划'}</span>
                  <small>{formatConversationStatus(item.status)}</small>
                </button>
              ))}
            </div>
          </aside>

          <main className="ai-conversation-main">
            {!selectedConversation ? (
              <div className="ai-empty-state">
                <Bot aria-hidden="true" />
                <strong>创建一条私有对话</strong>
                <span>Codex 会只读检查已配置的项目目录，并围绕当前工作项生成计划。</span>
                <button type="button" className="ai-primary-button" onClick={handleCreateConversation}>
                  <MessageSquarePlus aria-hidden="true" />
                  新建对话
                </button>
              </div>
            ) : (
              <>
                <div className="ai-conversation-toolbar">
                  <div>
                    <strong>{selectedConversation.title}</strong>
                    <span>{formatConversationStatus(selectedConversation.status)}</span>
                  </div>
                  <div className="ai-toolbar-actions">
                    {selectedConversation.draft ? (
                      <button type="button" className="ai-secondary-button" onClick={() => setSubmitOpen(true)}>
                        <FileCheck2 aria-hidden="true" />
                        提交方案
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ai-icon-button"
                      title="删除对话"
                      aria-label="删除对话"
                      disabled={isRunning}
                      onClick={handleArchiveConversation}
                    >
                      <Archive aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="ai-message-list" aria-live="polite">
                  {(selectedConversation.messages || []).map((message) => (
                    <article key={message.id} className={`ai-message is-${message.role}`}>
                      <div className="ai-message-author">
                        {message.role === 'user' ? '我' : 'Codex'}
                      </div>
                      <div className="ai-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                    </article>
                  ))}
                  {streamText ? (
                    <article className="ai-message is-assistant is-streaming">
                      <div className="ai-message-author">Codex</div>
                      <div className="ai-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>
                      </div>
                    </article>
                  ) : null}
                  {isRunning && !streamText ? <AiLoading label="Codex 正在只读分析项目" /> : null}
                  <div ref={messageEndRef} />
                </div>

                {selectedConversation.draft ? (
                  <section className="ai-plan-draft">
                    <div className="ai-plan-draft-heading">
                      <FileText aria-hidden="true" />
                      <div>
                        <strong>{selectedConversation.draft.title}</strong>
                        <span>{selectedConversation.draft.summary || '已生成可提交的 Markdown 方案'}</span>
                      </div>
                    </div>
                    <div className="ai-markdown ai-plan-preview">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {selectedConversation.draft.markdown}
                      </ReactMarkdown>
                    </div>
                  </section>
                ) : null}

                {actionStatus.message ? (
                  <p className={`ai-inline-status is-${actionStatus.type}`}>{actionStatus.message}</p>
                ) : null}
                <form className="ai-composer" onSubmit={handleSend}>
                  <textarea
                    className="allow-text-select"
                    value={composer}
                    maxLength={20_000}
                    rows={3}
                    disabled={isRunning}
                    placeholder="补充约束、让 Codex 继续调查，或要求调整方案"
                    onChange={(event) => setComposer(event.target.value)}
                  />
                  {isRunning ? (
                    <button type="button" className="ai-danger-button" onClick={handleCancel}>
                      <Square aria-hidden="true" />
                      停止
                    </button>
                  ) : (
                    <button type="submit" className="ai-primary-button" disabled={!composer.trim()}>
                      <Send aria-hidden="true" />
                      发送
                    </button>
                  )}
                </form>
              </>
            )}
          </main>
        </div>
        {submitOpen && selectedConversation?.draft ? (
          <AiPlanSubmitDialog
            conversation={selectedConversation}
            onClose={() => setSubmitOpen(false)}
            onSubmitted={() => {
              setSubmitOpen(false);
              setActionStatus({ type: 'success', message: '方案已提交到项目 AI 方案库' });
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

function AiPlanSubmitDialog({ conversation, onClose, onSubmitted }) {
  const draft = conversation.draft;
  const [title, setTitle] = useState(draft.title || '');
  const [summary, setSummary] = useState(draft.summary || '');
  const [markdown, setMarkdown] = useState(draft.markdown || '');
  const [mode, setMode] = useState('edit');
  const [status, setStatus] = useState({ type: 'idle', message: '' });

  async function handleSubmit(event) {
    event.preventDefault();
    if (!title.trim() || !markdown.trim() || status.type === 'loading') {
      setStatus({ type: 'error', message: '标题和 Markdown 不能为空' });
      return;
    }
    setStatus({ type: 'loading', message: '正在提交方案' });
    try {
      await submitAiPlan(conversation.id, {
        title: title.trim(),
        summary: summary.trim(),
        markdown: markdown.trim(),
        sourceReferences: draft.sourceReferences || [],
      });
      onSubmitted?.();
    } catch (error) {
      setStatus({ type: 'error', message: formatAiError(error) });
    }
  }

  return (
    <div className="ai-submit-backdrop" role="presentation">
      <section className="ai-submit-dialog" role="dialog" aria-modal="true" aria-label="提交 AI 方案">
        <header>
          <div>
            <h3>提交 Markdown 方案</h3>
            <span>提交后生成不可变修订，后续修改会形成新版本。</span>
          </div>
          <button type="button" className="ai-icon-button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <form onSubmit={handleSubmit}>
          <label>
            <span>方案标题</span>
            <input className="allow-text-select" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            <span>摘要</span>
            <textarea className="allow-text-select" value={summary} maxLength={2_000} rows={2} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <div className="ai-segmented-control" role="tablist" aria-label="Markdown 模式">
            <button type="button" className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode('edit')}>编辑</button>
            <button type="button" className={mode === 'preview' ? 'is-active' : ''} onClick={() => setMode('preview')}>预览</button>
          </div>
          {mode === 'edit' ? (
            <textarea
              className="ai-markdown-editor allow-text-select"
              value={markdown}
              maxLength={200_000}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          ) : (
            <div className="ai-markdown ai-submit-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          )}
          {status.message ? <p className={`ai-inline-status is-${status.type}`}>{status.message}</p> : null}
          <div className="ai-submit-actions">
            <button type="button" className="ai-secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="ai-primary-button" disabled={status.type === 'loading'}>
              <FileCheck2 aria-hidden="true" />
              {status.type === 'loading' ? '提交中' : '提交方案'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AiLoading({ label }) {
  return (
    <div className="ai-loading" role="status">
      <LoaderCircle aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function mergeConversationSummary(conversations, conversation) {
  const next = [
    conversation,
    ...(conversations || []).filter((item) => item.id !== conversation.id),
  ];
  return next.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    version: item.version,
    updatedAt: item.updatedAt,
  }));
}

function formatConversationStatus(status) {
  return {
    idle: '尚未开始',
    queued: '排队中',
    running: '分析中',
    ready: '已生成',
    failed: '生成失败',
    interrupted: '已取消',
  }[status] || '未知状态';
}

function formatAiError(error) {
  return error instanceof Error && error.message ? error.message : 'AI 请求失败';
}
