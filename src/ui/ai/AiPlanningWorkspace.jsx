import { forwardRef, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  Bot,
  Check,
  Clock3,
  CircleHelp,
  FileCheck2,
  FileText,
  LoaderCircle,
  LockKeyhole,
  MessageSquarePlus,
  Send,
  Square,
  TriangleAlert,
  Paperclip,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  archiveAiConversation,
  answerAiConversationQuestions,
  cancelAiConversationRun,
  createAiClientMutationId,
  createAiConversation,
  fetchAiConversation,
  listAiConversations,
  sendAiConversationMessage,
  submitAiPlan,
  subscribeAiConversation,
} from '../../api/aiConversations.js';

const REALTIME_RECONNECT_MESSAGE = '实时连接已断开，正在自动重连';
const RUN_ACTIVITY_STALE_MS = 45_000;
const RUN_PROGRESS_STEPS = Object.freeze([
  { stage: 'queued', label: '排队' },
  { stage: 'starting', label: '启动环境' },
  { stage: 'preparing', label: '准备会话' },
  { stage: 'analyzing', label: '分析项目' },
  { stage: 'composing', label: '整理方案' },
]);

export function AiPlanningWorkspace({
  projectId,
  toolConfig,
  record,
  initialConversationId = '',
  initialFocus = '',
  autoCreateRequest = null,
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
  const [questionAnswers, setQuestionAnswers] = useState({});
  const [additionalContext, setAdditionalContext] = useState('');
  const messageEndRef = useRef(null);
  const questionFocusRef = useRef(null);
  const planFocusRef = useRef(null);
  const failureFocusRef = useRef(null);
  const composerRef = useRef(null);
  const processedAutoCreateRef = useRef('');
  const selectedConversation = conversation?.id === selectedId ? conversation : null;
  const isRunning = ['queued', 'running'].includes(selectedConversation?.status);
  const isAwaitingUser = selectedConversation?.status === 'awaiting_user';
  const canCancel = isRunning || isAwaitingUser;

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
        setSelectedId((current) => (
          current || String(initialConversationId || '').trim() || conversations[0]?.id || ''
        ));
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
  }, [initialConversationId, projectId, record.recordId, toolConfig.toolId]);

  useEffect(() => {
    const requestKey = String(autoCreateRequest?.key || '').trim();
    if (
      state.status !== 'ready'
      || !requestKey
      || processedAutoCreateRef.current === requestKey
    ) {
      return;
    }
    processedAutoCreateRef.current = requestKey;
    void handleCreateConversation({
      clientMutationId: autoCreateRequest.clientMutationId,
      initialComposer: autoCreateRequest.defaultPrompt,
    });
  }, [
    autoCreateRequest?.clientMutationId,
    autoCreateRequest?.defaultPrompt,
    autoCreateRequest?.key,
    state.status,
  ]);

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
        setActionStatus((current) => (
          current.message === REALTIME_RECONNECT_MESSAGE
            ? { type: 'idle', message: '' }
            : current
        ));
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
          setActionStatus((current) => (
            current.type === 'loading' ? current : { type: 'idle', message: '' }
          ));
        }
      },
      'questions-required'() {
        if (active) {
          setActionStatus({ type: 'warning', message: 'Codex 需要你确认关键决策' });
        }
      },
      error() {
        if (active) {
          setActionStatus((current) => (
            current.type === 'loading'
              ? current
              : { type: 'warning', message: REALTIME_RECONNECT_MESSAGE }
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
    const questionSet = selectedConversation?.pendingQuestionSet;
    if (!questionSet) {
      setQuestionAnswers({});
      setAdditionalContext('');
      return;
    }
    setQuestionAnswers(Object.fromEntries(
      (questionSet.questions || []).map((question) => [
        question.id,
        { optionLabel: '', customText: '' },
      ]),
    ));
    setAdditionalContext('');
  }, [selectedConversation?.pendingQuestionSet?.id]);

  useEffect(() => {
    if (!selectedConversation || !initialFocus) {
      return;
    }
    const target = {
      questions: questionFocusRef,
      plan: planFocusRef,
      failure: failureFocusRef,
    }[initialFocus];
    const timer = setTimeout(() => {
      target?.current?.scrollIntoView({ block: 'center' });
      target?.current?.focus?.({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [
    initialFocus,
    selectedConversation?.id,
    selectedConversation?.pendingQuestionSet?.id,
    selectedConversation?.draft?.updatedAt,
    selectedConversation?.latestRun?.finishedAt,
  ]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' });
  }, [selectedConversation?.messages?.length, streamText]);

  useEffect(() => {
    if (!selectedId || !isRunning) {
      return undefined;
    }
    let active = true;
    const timer = setInterval(() => {
      fetchAiConversation(selectedId)
        .then((payload) => {
          if (active && payload.conversation?.id === selectedId) {
            setConversation(payload.conversation);
          }
        })
        .catch(() => {
          // SSE remains the primary update path; polling only prevents stale running states.
        });
    }, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [isRunning, selectedId]);

  async function handleCreateConversation({
    clientMutationId = '',
    initialComposer = '',
  } = {}) {
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
        clientMutationId,
      );
      const next = payload.conversation;
      setState((current) => ({
        ...current,
        status: 'ready',
        conversations: mergeConversationSummary(current.conversations, next),
      }));
      setSelectedId(next.id);
      setConversation(next);
      if (initialComposer) {
        setComposer(initialComposer);
        setTimeout(() => {
          composerRef.current?.focus();
          composerRef.current?.setSelectionRange?.(
            initialComposer.length,
            initialComposer.length,
          );
        }, 0);
      }
      setActionStatus({ type: 'idle', message: '' });
    } catch (error) {
      setActionStatus({ type: 'error', message: formatAiError(error) });
    }
  }

  async function handleArchiveConversation() {
    if (!selectedConversation || canCancel) {
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
    if (!content || !selectedConversation || isRunning || isAwaitingUser) {
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

  async function handleQuestionSubmit(event) {
    event.preventDefault();
    const questionSet = selectedConversation?.pendingQuestionSet;
    if (!questionSet || actionStatus.type === 'loading') {
      return;
    }
    const answers = (questionSet.questions || []).map((question) => ({
      questionId: question.id,
      optionLabel: String(questionAnswers[question.id]?.optionLabel || '').trim(),
      customText: String(questionAnswers[question.id]?.customText || '').trim(),
    }));
    if (!areQuestionAnswersComplete(questionSet.questions, answers)) {
      setActionStatus({ type: 'error', message: '请回答全部问题后再继续' });
      return;
    }
    setActionStatus({ type: 'loading', message: '正在提交答案并继续分析' });
    try {
      const payload = await answerAiConversationQuestions(
        selectedConversation.id,
        questionSet.id,
        {
          expectedVersion: selectedConversation.version,
          clientMutationId: createAiClientMutationId(),
          answers,
          additionalContext: additionalContext.trim(),
        },
      );
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
    if (!selectedConversation || !canCancel) {
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
                onClick={() => handleCreateConversation()}
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
                {actionStatus.message ? (
                  <p className={`ai-inline-status is-${actionStatus.type}`}>
                    {actionStatus.message}
                  </p>
                ) : null}
                <button type="button" className="ai-primary-button" onClick={() => handleCreateConversation()}>
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
                      disabled={canCancel}
                      onClick={handleArchiveConversation}
                    >
                      <Archive aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="ai-message-list" aria-live="polite">
                  {(selectedConversation.messages || []).map((message) => (
                    <AiConversationMessage key={message.id} message={message} />
                  ))}
                  {streamText ? (
                    <article className="ai-message is-assistant is-streaming">
                      <div className="ai-message-author">Codex</div>
                      <div className="ai-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>
                      </div>
                    </article>
                  ) : null}
                  {isRunning ? (
                    <AiRunProgress run={selectedConversation.latestRun} />
                  ) : null}
                  {selectedConversation.latestRun?.attachmentSummary?.discoveredCount > 0 ? (
                    <AiAttachmentSummary summary={selectedConversation.latestRun.attachmentSummary} />
                  ) : null}
                  {!isRunning && !isAwaitingUser ? (
                    <div ref={failureFocusRef} tabIndex={-1}>
                      <AiRunFailure run={selectedConversation.latestRun} />
                    </div>
                  ) : null}
                  {isAwaitingUser && selectedConversation.pendingQuestionSet ? (
                    <AiQuestionForm
                      ref={questionFocusRef}
                      questionSet={selectedConversation.pendingQuestionSet}
                      answers={questionAnswers}
                      additionalContext={additionalContext}
                      disabled={actionStatus.type === 'loading'}
                      onAnswerChange={(questionId, update) => {
                        setQuestionAnswers((current) => ({
                          ...current,
                          [questionId]: {
                            ...(current[questionId] || {}),
                            ...update,
                          },
                        }));
                      }}
                      onAdditionalContextChange={setAdditionalContext}
                      onSubmit={handleQuestionSubmit}
                      onCancel={handleCancel}
                    />
                  ) : null}
                  <div ref={messageEndRef} />
                </div>

                {selectedConversation.draft ? (
                  <section className="ai-plan-draft" ref={planFocusRef} tabIndex={-1}>
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
                  <p className={`ai-inline-status is-${actionStatus.type}`}>
                    {actionStatus.message}
                  </p>
                ) : null}
                <form className="ai-composer" onSubmit={handleSend}>
                  <textarea
                    ref={composerRef}
                    className="allow-text-select"
                    value={composer}
                    maxLength={20_000}
                    rows={3}
                    disabled={isRunning || isAwaitingUser}
                    placeholder={
                      isAwaitingUser
                        ? '请先回答上方问题'
                        : '补充约束、让 Codex 继续调查，或要求调整方案'
                    }
                    onChange={(event) => setComposer(event.target.value)}
                  />
                  {isRunning ? (
                    <button type="button" className="ai-danger-button" onClick={handleCancel}>
                      <Square aria-hidden="true" />
                      停止
                    </button>
                  ) : isAwaitingUser ? (
                    <button type="button" className="ai-danger-button" onClick={handleCancel}>
                      <Square aria-hidden="true" />
                      取消本轮
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
            onSubmitted={(payload) => {
              setSubmitOpen(false);
              const queuedCount = Number(payload?.notificationQueuedCount || 0);
              const recipientCount = Number(payload?.reviewRecipientCount || 0);
              const notificationsEnabled = payload?.notificationDeliveryEnabled !== false;
              setActionStatus({
                type: queuedCount > 0 ? 'success' : 'warning',
                message: queuedCount > 0
                  ? `方案已提交到项目 AI 方案库，已安排通知 ${queuedCount} 位审核人`
                  : recipientCount < 1
                    ? '方案已提交到项目 AI 方案库，但当前工作项没有可通知的处理人或研发超级管理员'
                    : !notificationsEnabled
                      ? '方案已提交到项目 AI 方案库，当前未启用飞书 AI 计划通知'
                      : '方案已提交到项目 AI 方案库，未新增飞书通知任务',
              });
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

function AiConversationMessage({ message }) {
  const questions = message.kind === 'question_set'
    ? message.payload?.questions || []
    : [];
  return (
    <article className={`ai-message is-${message.role} is-${message.kind || 'text'}`}>
      <div className="ai-message-author">
        {message.role === 'user' ? '我' : 'Codex'}
      </div>
      {questions.length > 0 ? (
        <div className="ai-historical-questions">
          <strong>需要确认的决策</strong>
          <ol>
            {questions.map((question) => (
              <li key={question.id}>
                <span>{question.question}</span>
                {question.options?.length > 0 ? (
                  <small>{question.options.map((option) => option.label).join(' / ')}</small>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="ai-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
      )}
    </article>
  );
}

const AiQuestionForm = forwardRef(function AiQuestionForm({
  questionSet,
  answers,
  additionalContext,
  disabled,
  onAnswerChange,
  onAdditionalContextChange,
  onSubmit,
  onCancel,
}, ref) {
  return (
    <form className="ai-question-form" ref={ref} tabIndex={-1} onSubmit={onSubmit}>
      <div className="ai-question-form-heading">
        <CircleHelp aria-hidden="true" />
        <div>
          <strong>等待你的决定</strong>
          <span>回答后 Codex 会继续分析；如仍有关键不确定点，可能再询问一轮。</span>
        </div>
      </div>
      {(questionSet.questions || []).map((question, index) => {
        const answer = answers[question.id] || {};
        return (
          <fieldset key={question.id} className="ai-question-fieldset" disabled={disabled}>
            <legend>
              <span>{question.header || `问题 ${index + 1}`}</span>
              <strong>{question.question}</strong>
            </legend>
            {question.options?.length > 0 ? (
              <div className="ai-question-options">
                {question.options.map((option) => (
                  <label key={option.label}>
                    <input
                      type="radio"
                      name={`ai-question-${questionSet.id}-${question.id}`}
                      checked={answer.optionLabel === option.label}
                      onChange={() => onAnswerChange(question.id, { optionLabel: option.label })}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            <label className="ai-question-custom-answer">
              <span>{question.options?.length > 0 ? '自定义或补充说明' : '你的回答'}</span>
              <textarea
                className="allow-text-select"
                rows={3}
                maxLength={4_000}
                value={answer.customText || ''}
                onChange={(event) => onAnswerChange(question.id, {
                  customText: event.target.value,
                })}
              />
            </label>
          </fieldset>
        );
      })}
      <label className="ai-question-additional-context">
        <span>补充期望效果（可选）</span>
        <textarea
          className="allow-text-select"
          rows={2}
          maxLength={4_000}
          disabled={disabled}
          value={additionalContext}
          onChange={(event) => onAdditionalContextChange(event.target.value)}
        />
      </label>
      <div className="ai-question-actions">
        <button type="button" className="ai-danger-button" disabled={disabled} onClick={onCancel}>
          <Square aria-hidden="true" />
          取消本轮
        </button>
        <button type="submit" className="ai-primary-button" disabled={disabled}>
          <Send aria-hidden="true" />
          {disabled ? '提交中' : '提交答案并继续'}
        </button>
      </div>
    </form>
  );
});

function AiAttachmentSummary({ summary }) {
  return (
    <details className="ai-attachment-summary">
      <summary>
        <Paperclip aria-hidden="true" />
        <span>
          附件：已处理 {summary.processedCount || 0}，跳过 {summary.skippedCount || 0}
        </span>
      </summary>
      <ul>
        {(summary.files || []).map((file, index) => (
          <li key={`${file.name}-${index}`} className={`is-${file.status}`}>
            <strong>{file.name || '附件'}</strong>
            <span>
              {file.status === 'processed'
                ? formatAttachmentKind(file.kind)
                : file.reason || '未处理'}
            </span>
          </li>
        ))}
      </ul>
    </details>
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
      const payload = await submitAiPlan(conversation.id, {
        title: title.trim(),
        summary: summary.trim(),
        markdown: markdown.trim(),
        sourceReferences: draft.sourceReferences || [],
      });
      onSubmitted?.(payload);
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

function AiRunProgress({ run }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const progress = run?.progress || {};
  const currentStage = String(progress.stage || 'queued');
  const currentIndex = Math.max(
    0,
    RUN_PROGRESS_STEPS.findIndex((step) => step.stage === currentStage),
  );
  const startedAtMs = parseTimestamp(run?.startedAt);
  const activityAtMs = parseTimestamp(progress.updatedAt) || startedAtMs;
  const elapsedMs = startedAtMs ? Math.max(0, now - startedAtMs) : 0;
  const inactiveMs = activityAtMs ? Math.max(0, now - activityAtMs) : 0;
  const activityCount = Math.max(0, Number(progress.activityCount || 0));
  const isStale = inactiveMs >= RUN_ACTIVITY_STALE_MS;

  return (
    <section className="ai-run-progress" role="status" aria-live="polite">
      <div className="ai-run-progress-heading">
        <LoaderCircle aria-hidden="true" />
        <div>
          <strong>{progress.message || 'Codex 正在准备只读分析'}</strong>
          <span>服务器任务仍在运行，可随时点击下方“停止”</span>
        </div>
      </div>
      <ol className="ai-run-progress-steps">
        {RUN_PROGRESS_STEPS.map((step, index) => {
          const state = index < currentIndex
            ? 'done'
            : index === currentIndex ? 'current' : 'pending';
          return (
            <li key={step.stage} className={`is-${state}`}>
              <span className="ai-run-progress-node" aria-hidden="true">
                {state === 'done' ? <Check /> : index + 1}
              </span>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>
      <div className="ai-run-progress-meta">
        <span><Clock3 aria-hidden="true" />已运行 {formatDuration(elapsedMs)}</span>
        <span><Activity aria-hidden="true" />最近活动 {formatRelativeDuration(inactiveMs)}</span>
        <span>已记录 {activityCount} 次活动</span>
      </div>
      {isStale ? (
        <div className="ai-run-progress-waiting">
          <TriangleAlert aria-hidden="true" />
          <span>暂未收到新的 Codex 活动，任务仍在等待模型响应</span>
        </div>
      ) : null}
    </section>
  );
}

function AiRunFailure({ run }) {
  if (!['failed', 'interrupted'].includes(run?.status)) {
    return null;
  }
  const interrupted = run.status === 'interrupted';
  const startedAtMs = parseTimestamp(run.startedAt);
  const finishedAtMs = parseTimestamp(run.finishedAt);
  const durationMs = startedAtMs && finishedAtMs
    ? Math.max(0, finishedAtMs - startedAtMs)
    : 0;
  return (
    <section className={`ai-run-failure ${interrupted ? 'is-warning' : 'is-error'}`} role="alert">
      <div className="ai-run-failure-heading">
        <TriangleAlert aria-hidden="true" />
        <div>
          <strong>{interrupted ? '任务已停止' : '生成失败'}</strong>
          <span>{formatRunErrorType(run.errorCode)}</span>
        </div>
      </div>
      <p>{String(run.errorMessage || (interrupted ? '任务已取消' : 'Codex 生成计划失败'))}</p>
      <dl>
        <div>
          <dt>结束阶段</dt>
          <dd>{formatRunStage(run.progress?.stage)}</dd>
        </div>
        <div>
          <dt>运行耗时</dt>
          <dd>{formatDuration(durationMs)}</dd>
        </div>
        <div>
          <dt>开始时间</dt>
          <dd>{formatDateTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt>结束时间</dt>
          <dd>{formatDateTime(run.finishedAt)}</dd>
        </div>
      </dl>
    </section>
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
    awaiting_user: '等待你的决定',
    ready: '已生成',
    failed: '生成失败',
    interrupted: '已取消',
  }[status] || '未知状态';
}

function formatRunStage(stage) {
  return {
    queued: '任务排队',
    starting: '启动 Codex 环境',
    preparing: '准备项目分析会话',
    analyzing: '只读分析项目',
    awaiting_user: '等待用户决定',
    composing: '整理实施计划',
    completed: '生成完成',
  }[stage] || '尚未记录';
}

function formatRunErrorType(errorCode) {
  return {
    interrupted: '用户取消',
    server_restarted: '服务重启中断',
    codex_timeout: '模型响应超时',
    codex_process_exit: 'Codex 进程异常退出',
    codex_runtime_missing: 'Codex 运行环境缺失',
    codex_protocol: 'Codex 通信协议异常',
    codex_empty_output: 'Codex 未返回计划内容',
    codex_invalid_output: 'Codex 返回格式错误',
    codex_failed: 'Codex 调用失败',
  }[errorCode] || 'Codex 运行错误';
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatDuration(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${seconds} 秒`;
  }
  return `${seconds} 秒`;
}

function formatRelativeDuration(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1_000));
  if (totalSeconds < 5) {
    return '刚刚';
  }
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒前`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes} 分钟前`;
}

function formatDateTime(value) {
  const timestamp = parseTimestamp(value);
  return timestamp
    ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
    : '未知';
}

function formatAiError(error) {
  return error instanceof Error && error.message ? error.message : 'AI 请求失败';
}

function areQuestionAnswersComplete(questions, answers) {
  const answerById = new Map(answers.map((answer) => [answer.questionId, answer]));
  return (questions || []).every((question) => {
    const answer = answerById.get(question.id);
    if (!answer) {
      return false;
    }
    return question.options?.length > 0
      ? Boolean(answer.optionLabel || answer.customText)
      : Boolean(answer.customText);
  });
}

function formatAttachmentKind(kind) {
  return {
    image: '图片已发送给 Codex',
    document: '文档文本已提取',
    text: '文本已读取',
  }[kind] || '已处理';
}
