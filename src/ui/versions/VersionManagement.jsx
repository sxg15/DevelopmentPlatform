import { useEffect, useRef, useState } from 'react';
import {
  Boxes,
  Bug,
  Check,
  ChevronRight,
  FileText,
  Filter,
  GitBranch,
  History,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Send,
  Tag,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';

import {
  appendVersionComment,
  createVersionRecord,
  deleteVersionComment,
  deleteVersionRecord,
  ensureProjectVersions,
  updateVersionRecord,
  updateVersionStatus,
} from '../../api/versions.js';
import {
  createVersionManagementSnapshotKey,
  getCachedSnapshot,
  saveCachedSnapshot,
} from '../localCache.js';
import {
  buildActiveVersionMatrix,
  filterVersionAssociationCandidates,
  filterVersions,
  mergeVersionPayload,
  normalizeVersionManagementPayload,
  normalizeVersion,
} from './versionManagementDisplayUtils.js';

const ASSOCIATION_DEFINITIONS = [
  { id: 'requirements', label: '已处理需求', icon: FileText },
  { id: 'bugs', label: '已处理Bug', icon: Bug },
  { id: 'feedback', label: '已处理反馈', icon: MessageSquare },
];

export function VersionManagement({
  project,
  user,
  cacheUserKey,
  realtimeEvent,
  directTarget,
  targetRecordId,
  onDirectNotice,
}) {
  const projectId = String(project?.projectId || '').trim();
  const [state, setState] = useState({ status: 'loading', message: '', data: null });
  const [selectedRecordId, setSelectedRecordId] = useState('');
  const [highlightCommentId, setHighlightCommentId] = useState('');
  const [filters, setFilters] = useState({ search: '', platform: 'all', status: 'all' });
  const [editor, setEditor] = useState(null);
  const [statusEditor, setStatusEditor] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const requestRef = useRef(0);
  const dataRef = useRef(null);
  const processedRealtimeRef = useRef('');
  const processedDirectRef = useRef('');

  useEffect(() => {
    dataRef.current = null;
    void loadVersions({ readCache: true });
    return () => {
      requestRef.current += 1;
    };
  }, [cacheUserKey, projectId]);

  useEffect(() => {
    if (
      !realtimeEvent
      || realtimeEvent.projectId !== projectId
      || realtimeEvent.toolId !== 'versions'
      || processedRealtimeRef.current === realtimeEvent.id
    ) {
      return;
    }
    processedRealtimeRef.current = realtimeEvent.id;
    void loadVersions({ keepSelection: true, quiet: true });
  }, [projectId, realtimeEvent?.id]);

  useEffect(() => {
    if (
      !directTarget
      || directTarget.projectId !== projectId
      || directTarget.toolId !== 'versions'
      || processedDirectRef.current === directTarget.key
    ) {
      return;
    }
    processedDirectRef.current = directTarget.key;
    if (directTarget.recordId) {
      setSelectedRecordId(directTarget.recordId);
      setHighlightCommentId(directTarget.commentId || '');
    }
  }, [directTarget, projectId]);

  useEffect(() => {
    const recordId = String(targetRecordId || '').trim();
    if (recordId && state.data?.versions?.some((version) => version.recordId === recordId)) {
      setSelectedRecordId(recordId);
      setHighlightCommentId('');
    }
  }, [state.data, targetRecordId]);

  async function loadVersions({
    keepSelection = false,
    quiet = false,
    readCache = false,
  } = {}) {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const snapshotKey = createVersionManagementSnapshotKey(cacheUserKey, projectId);
    let cachedSnapshot = null;

    if (readCache) {
      setState({
        status: 'loading',
        message: '正在加载版本管理',
        data: null,
      });
      cachedSnapshot = await getCachedSnapshot(snapshotKey);
      if (requestRef.current !== requestId) {
        return;
      }
      if (cachedSnapshot?.value) {
        const cachedPayload = normalizeVersionManagementPayload(cachedSnapshot.value);
        dataRef.current = cachedPayload;
        setState({
          status: 'refreshing',
          message: buildVersionCacheMessage(cachedSnapshot.savedAt, true),
          data: cachedPayload,
        });
        selectPreferredVersion(cachedPayload, keepSelection);
      }
    } else if (!quiet) {
      setState((current) => ({
        ...current,
        status: current.data ? 'refreshing' : 'loading',
        message: current.data ? '正在刷新版本管理' : '正在准备版本管理',
      }));
    }
    try {
      const payload = normalizeVersionManagementPayload(await ensureProjectVersions(projectId));
      if (requestRef.current !== requestId) {
        return;
      }
      dataRef.current = payload;
      setState({ status: 'ready', message: '', data: payload });
      void saveCachedSnapshot(cacheUserKey, snapshotKey, payload);
      selectPreferredVersion(payload, keepSelection);
      if (directTarget?.toolId === 'versions' && directTarget.recordId) {
        const exists = payload.versions.some((version) => version.recordId === directTarget.recordId);
        onDirectNotice?.(exists
          ? { type: 'idle', message: '' }
          : { type: 'error', message: '目标版本不存在或没有权限查看' });
      }
    } catch (error) {
      if (requestRef.current === requestId) {
        setState((current) => ({
          status: current.data ? 'ready' : 'error',
          message: cachedSnapshot?.value
            ? buildVersionCacheMessage(cachedSnapshot.savedAt, false, formatError(error))
            : formatError(error),
          data: current.data,
        }));
      }
    }
  }

  function selectPreferredVersion(payload, keepSelection) {
    setSelectedRecordId((current) => {
      const directRecordId = directTarget?.toolId === 'versions' ? directTarget.recordId : '';
      const preferred = directRecordId || (keepSelection ? current : '');
      if (preferred && payload.versions.some((version) => version.recordId === preferred)) {
        return preferred;
      }
      return payload.versions[0]?.recordId || '';
    });
  }

  function applyMutationPayload(payload, preferredRecordId = '') {
    const data = mergeVersionPayload(dataRef.current, payload);
    dataRef.current = data;
    setState({ status: 'ready', message: '', data });
    void saveCachedSnapshot(
      cacheUserKey,
      createVersionManagementSnapshotKey(cacheUserKey, projectId),
      data,
    );
    if (preferredRecordId) {
      setSelectedRecordId(preferredRecordId);
    }
  }

  if (!state.data && state.status === 'loading') {
    return <VersionState icon={LoaderCircle} spinning text={state.message} />;
  }
  if (!state.data && state.status === 'error') {
    return (
      <VersionState icon={TriangleAlert} text={state.message} tone="error">
        <button type="button" onClick={() => loadVersions()}>重新加载</button>
      </VersionState>
    );
  }

  const data = normalizeVersionManagementPayload(state.data);
  const filteredVersions = filterVersions(data.versions, filters);
  const selectedVersion = data.versions.find((version) => version.recordId === selectedRecordId) || null;
  const activeMatrix = buildActiveVersionMatrix(
    data.versions,
    data.platformOptions,
    data.statusOptions,
  );

  return (
    <section className="version-management" aria-label={`${project.projectName || '项目'}版本管理`}>
      <header className="version-management-header">
        <div>
          <span className="version-management-eyebrow">版本管理</span>
          <h1>{project.projectName || '未命名项目'}</h1>
          <p>维护各平台开发、测试发布和正式发布版本。</p>
        </div>
        <div className="version-management-header-actions">
          <button
            type="button"
            className="version-icon-button"
            title="刷新版本管理"
            aria-label="刷新版本管理"
            disabled={state.status === 'refreshing'}
            onClick={() => loadVersions({ keepSelection: true })}
          >
            <RefreshCw className={state.status === 'refreshing' ? 'is-spinning' : ''} aria-hidden="true" />
          </button>
          {data.canManageVersions ? (
            <button type="button" className="version-primary-button" onClick={() => setEditor(createEditorState(null, data))}>
              <Plus aria-hidden="true" />
              <span>创建版本</span>
            </button>
          ) : null}
        </div>
      </header>

      {state.message ? <p className="version-management-notice">{state.message}</p> : null}
      {data.warnings.length > 0 ? (
        <div className="version-management-warning" role="status">
          <TriangleAlert aria-hidden="true" />
          <span>{data.warnings.join('；')}</span>
        </div>
      ) : null}

      <section className="version-active-section" aria-label="当前活跃版本">
        <div className="version-section-heading">
          <div>
            <Rocket aria-hidden="true" />
            <h2>当前版本</h2>
          </div>
          <span>同一平台的每个活跃状态仅保留一个版本</span>
        </div>
        <div className="version-active-matrix">
          <div className="version-active-row is-heading">
            <span>平台</span>
            {['测试开发', '测试发布', '正式发布'].map((status) => <span key={status}>{status}</span>)}
          </div>
          {activeMatrix.map((row) => (
            <div className="version-active-row" key={row.platform}>
              <strong>{row.platform}</strong>
              {['测试开发', '测试发布', '正式发布'].map((status) => {
                const version = row.slots[status];
                return version ? (
                  <button
                    key={status}
                    type="button"
                    className={`version-active-slot ${getStatusClass(status)}`}
                    onClick={() => setSelectedRecordId(version.recordId)}
                  >
                    <span>{version.versionNumber}</span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                ) : (
                  <span key={status} className="version-active-slot is-empty">未设置</span>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <div className="version-management-workspace">
        <aside className="version-list-pane" aria-label="版本列表">
          <div className="version-list-toolbar">
            <label className="version-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                value={filters.search}
                placeholder="搜索版本或关联事项"
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              />
            </label>
            <div className="version-filter-row">
              <Filter aria-hidden="true" />
              <select
                value={filters.platform}
                aria-label="按平台筛选"
                onChange={(event) => setFilters((current) => ({ ...current, platform: event.target.value }))}
              >
                <option value="all">全部平台</option>
                {data.platformOptions.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
              </select>
              <select
                value={filters.status}
                aria-label="按状态筛选"
                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="all">全部状态</option>
                {data.statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </div>
          </div>
          <div className="version-list-count">{filteredVersions.length} 个版本</div>
          <div className="version-list">
            {filteredVersions.length === 0 ? (
              <p className="version-empty">当前筛选下没有版本</p>
            ) : filteredVersions.map((version) => (
              <button
                key={version.recordId}
                type="button"
                className={`version-list-item ${selectedRecordId === version.recordId ? 'is-active' : ''}`}
                onClick={() => {
                  setSelectedRecordId(version.recordId);
                  setHighlightCommentId('');
                }}
              >
                <span className={`version-list-status ${getStatusClass(version.status)}`} aria-hidden="true" />
                <span>
                  <strong>{version.versionNumber}</strong>
                  <small>{version.platform} · {version.status}</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            ))}
          </div>
        </aside>

        <div className="version-detail-pane">
          {selectedVersion ? (
            <VersionDetail
              version={selectedVersion}
              versions={data.versions}
              user={user}
              mentionableUsers={data.mentionableUsers}
              canManageVersions={data.canManageVersions}
              highlightCommentId={highlightCommentId}
              onSelectVersion={setSelectedRecordId}
              onEdit={() => setEditor(createEditorState(selectedVersion, data))}
              onChangeStatus={() => setStatusEditor({
                recordId: selectedVersion.recordId,
                currentStatus: selectedVersion.status,
                newStatus: data.statusOptions.find((status) => status !== selectedVersion.status) || '',
                reason: '',
                saving: false,
                error: '',
              })}
              onDelete={() => setDeleteTarget(selectedVersion)}
              onCommentAdded={(payload) => applyMutationPayload(payload, selectedVersion.recordId)}
              onCommentDeleted={(payload) => applyMutationPayload(payload, selectedVersion.recordId)}
              projectId={projectId}
            />
          ) : (
            <div className="version-detail-empty">
              <Boxes aria-hidden="true" />
              <span>选择一个版本查看详细信息</span>
            </div>
          )}
        </div>
      </div>

      {editor ? (
        <VersionEditorDialog
          state={editor}
          data={data}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSubmit={async () => {
            const payload = buildEditorPayload(editor);
            setEditor((current) => ({ ...current, saving: true, error: '' }));
            try {
              const result = editor.recordId
                ? await updateVersionRecord(projectId, editor.recordId, payload)
                : await createVersionRecord(projectId, payload);
              const version = normalizeVersion(result.version);
              applyMutationPayload(result, version.recordId);
              setEditor(null);
            } catch (error) {
              setEditor((current) => ({ ...current, saving: false, error: formatError(error) }));
            }
          }}
        />
      ) : null}

      {statusEditor ? (
        <StatusEditorDialog
          state={statusEditor}
          statusOptions={data.statusOptions}
          onChange={setStatusEditor}
          onClose={() => setStatusEditor(null)}
          onSubmit={async () => {
            setStatusEditor((current) => ({ ...current, saving: true, error: '' }));
            try {
              const result = await updateVersionStatus(projectId, statusEditor.recordId, {
                newStatus: statusEditor.newStatus,
                reason: statusEditor.reason,
              });
              applyMutationPayload(result, statusEditor.recordId);
              setStatusEditor(null);
            } catch (error) {
              setStatusEditor((current) => ({ ...current, saving: false, error: formatError(error) }));
            }
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDeleteDialog
          version={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            try {
              const result = await deleteVersionRecord(projectId, deleteTarget.recordId);
              applyMutationPayload(result);
              setSelectedRecordId(result.versions?.[0]?.recordId || '');
              setDeleteTarget(null);
            } catch (error) {
              setDeleteTarget((current) => ({ ...current, error: formatError(error) }));
            }
          }}
        />
      ) : null}
    </section>
  );
}

function VersionDetail({
  version,
  versions,
  user,
  mentionableUsers,
  canManageVersions,
  highlightCommentId,
  onSelectVersion,
  onEdit,
  onChangeStatus,
  onDelete,
  onCommentAdded,
  onCommentDeleted,
  projectId,
}) {
  const [comment, setComment] = useState('');
  const [mentionedOpenIds, setMentionedOpenIds] = useState([]);
  const [notifyMentioned, setNotifyMentioned] = useState(true);
  const [commentState, setCommentState] = useState({ saving: false, error: '' });
  const highlightedRef = useRef(null);

  useEffect(() => {
    if (highlightCommentId) {
      window.requestAnimationFrame(() => highlightedRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      }));
    }
  }, [highlightCommentId, version.recordId]);

  const previousExists = versions.some((item) => item.recordId === version.previousVersion?.recordId);

  return (
    <article className="version-detail">
      <header className="version-detail-header">
        <div>
          <span className={`version-status-badge ${getStatusClass(version.status)}`}>{version.status}</span>
          <h2>{version.versionNumber}</h2>
          <p>{version.platform}</p>
        </div>
        {canManageVersions ? (
          <div className="version-detail-actions">
            <button type="button" className="version-secondary-button" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              <span>编辑</span>
            </button>
            <button type="button" className="version-secondary-button" onClick={onChangeStatus}>
              <GitBranch aria-hidden="true" />
              <span>变更状态</span>
            </button>
            <button type="button" className="version-danger-icon" title="删除版本" aria-label="删除版本" onClick={onDelete}>
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </header>

      {version.warnings.length > 0 ? (
        <div className="version-management-warning">
          <TriangleAlert aria-hidden="true" />
          <span>{version.warnings.join('；')}</span>
        </div>
      ) : null}

      <section className="version-metadata-section">
        <div className="version-section-heading">
          <div><Tag aria-hidden="true" /><h3>版本信息</h3></div>
        </div>
        <dl className="version-metadata-grid">
          <div><dt>版本号</dt><dd>{version.versionNumber}</dd></div>
          <div><dt>平台</dt><dd>{version.platform}</dd></div>
          <div><dt>当前状态</dt><dd>{version.status}</dd></div>
          <div>
            <dt>上个版本</dt>
            <dd>
              {version.previousVersion ? (
                <button
                  type="button"
                  className="version-inline-link"
                  disabled={!previousExists}
                  onClick={() => onSelectVersion(version.previousVersion.recordId)}
                >
                  {version.previousVersion.versionNumber} · {version.previousVersion.platform}
                </button>
              ) : '未设置'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="version-associations-section">
        <div className="version-section-heading">
          <div><Check aria-hidden="true" /><h3>已处理工作项</h3></div>
        </div>
        <div className="version-association-columns">
          {ASSOCIATION_DEFINITIONS.map(({ id, label, icon: Icon }) => (
            <div className="version-association-group" key={id}>
              <h4><Icon aria-hidden="true" />{label}<span>{version[id].length}</span></h4>
              {version[id].length > 0 ? (
                <ul>
                  {version[id].map((item) => (
                    <li key={item.recordId}>
                      <strong>{item.itemId || '无编号'}</strong>
                      <span>{item.title}</span>
                    </li>
                  ))}
                </ul>
              ) : <p>暂无关联</p>}
            </div>
          ))}
        </div>
      </section>

      <section className="version-history-section">
        <div className="version-section-heading">
          <div><History aria-hidden="true" /><h3>状态历史</h3></div>
        </div>
        <div className="version-history-list">
          {[...version.statusHistory].reverse().map((item) => (
            <div className="version-history-item" key={item.id}>
              <span className={`version-history-dot ${getStatusClass(item.newStatus)}`} aria-hidden="true" />
              <div>
                <strong>{item.oldStatus ? `${item.oldStatus} → ${item.newStatus}` : `创建为${item.newStatus}`}</strong>
                <span>{item.operatorName} · {formatDateTime(item.changedAt)}{item.automatic ? ' · 自动变更' : ''}</span>
                <p>{item.reason || '未填写原因'}</p>
              </div>
            </div>
          ))}
          {version.statusHistory.length === 0 ? <p className="version-empty">暂无状态变动记录</p> : null}
        </div>
      </section>

      <section className="version-comments-section">
        <div className="version-section-heading">
          <div><MessageSquare aria-hidden="true" /><h3>留言</h3></div>
          <span>{version.comments.length} 条</span>
        </div>
        <div className="version-comment-list">
          {version.comments.map((item) => {
            const isHighlighted = item.id === highlightCommentId;
            return (
              <div
                key={item.id}
                ref={isHighlighted ? highlightedRef : null}
                className={`version-comment ${isHighlighted ? 'is-highlighted' : ''}`}
              >
                <Avatar user={{ name: item.authorName, avatarUrl: item.authorAvatarUrl }} />
                <div>
                  <div className="version-comment-meta">
                    <strong>{item.authorName}</strong>
                    <span>{formatDateTime(item.createdAt)}</span>
                    {isSameUser(item, user) ? (
                      <button
                        type="button"
                        title="删除留言"
                        aria-label="删除留言"
                        onClick={async () => {
                          try {
                            onCommentDeleted(await deleteVersionComment(projectId, version.recordId, item.id));
                          } catch (error) {
                            setCommentState({ saving: false, error: formatError(error) });
                          }
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                  <p>{item.content}</p>
                </div>
              </div>
            );
          })}
          {version.comments.length === 0 ? <p className="version-empty">暂无留言</p> : null}
        </div>
        <div className="version-comment-editor">
          <textarea
            value={comment}
            maxLength={2000}
            placeholder="输入留言内容"
            onChange={(event) => setComment(event.target.value)}
          />
          {mentionableUsers.length > 0 ? (
            <label>
              <span>提及项目成员</span>
              <select
                multiple
                value={mentionedOpenIds}
                onChange={(event) => setMentionedOpenIds(
                  Array.from(event.target.selectedOptions).map((option) => option.value),
                )}
              >
                {mentionableUsers.map((person) => (
                  <option key={person.openId} value={person.openId}>{person.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {mentionedOpenIds.length > 0 ? (
            <label className="version-checkbox">
              <input
                type="checkbox"
                checked={notifyMentioned}
                onChange={(event) => setNotifyMentioned(event.target.checked)}
              />
              <span>发送飞书通知</span>
            </label>
          ) : null}
          {commentState.error ? <p className="version-form-error">{commentState.error}</p> : null}
          <div className="version-comment-actions">
            <span>{comment.length}/2000</span>
            <button
              type="button"
              className="version-primary-button"
              disabled={!comment.trim() || commentState.saving}
              onClick={async () => {
                setCommentState({ saving: true, error: '' });
                try {
                  const mentionedUsers = mentionableUsers.filter((person) => mentionedOpenIds.includes(person.openId));
                  const result = await appendVersionComment(projectId, version.recordId, {
                    content: comment,
                    mentionedUsers,
                    notifyMentioned: notifyMentioned && mentionedUsers.length > 0,
                  });
                  onCommentAdded(result);
                  setComment('');
                  setMentionedOpenIds([]);
                  setCommentState({ saving: false, error: '' });
                } catch (error) {
                  setCommentState({ saving: false, error: formatError(error) });
                }
              }}
            >
              <Send aria-hidden="true" />
              <span>发送留言</span>
            </button>
          </div>
        </div>
      </section>
    </article>
  );
}

function VersionEditorDialog({ state, data, onChange, onClose, onSubmit }) {
  const isEditing = Boolean(state.recordId);
  const [associationSearch, setAssociationSearch] = useState(() => Object.fromEntries(
    ASSOCIATION_DEFINITIONS.map(({ id }) => [id, '']),
  ));
  return (
    <DialogShell title={isEditing ? '编辑版本' : '创建版本'} icon={isEditing ? Pencil : Plus} onClose={onClose}>
      <div className="version-form-grid">
        <label>
          <span>版本号</span>
          <input
            value={state.versionNumber}
            maxLength={100}
            onChange={(event) => onChange((current) => ({ ...current, versionNumber: event.target.value }))}
          />
        </label>
        <label>
          <span>平台</span>
          <select
            value={state.platform}
            onChange={(event) => onChange((current) => ({ ...current, platform: event.target.value }))}
          >
            {data.platformOptions.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
          </select>
        </label>
        {!isEditing ? (
          <label>
            <span>初始状态</span>
            <select
              value={state.status}
              onChange={(event) => onChange((current) => ({ ...current, status: event.target.value }))}
            >
              {data.statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
        ) : null}
        <label>
          <span>上个版本</span>
          <select
            value={state.previousVersionRecordId}
            onChange={(event) => onChange((current) => ({ ...current, previousVersionRecordId: event.target.value }))}
          >
            <option value="">不设置</option>
            {data.versions.filter((version) => version.recordId !== state.recordId).map((version) => (
              <option key={version.recordId} value={version.recordId}>
                {version.versionNumber} · {version.platform}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="version-form-associations">
        {ASSOCIATION_DEFINITIONS.map(({ id, label, icon: Icon }) => {
          const candidates = mergeAssociationCandidates(data.completedWorkItems[id], state.existingAssociations[id]);
          const selectedRecordIds = Array.isArray(state.associations[id]) ? state.associations[id] : [];
          const filteredCandidates = filterVersionAssociationCandidates(candidates, associationSearch[id]);
          return (
            <section className="version-form-association-group" key={id}>
              <header>
                <span><Icon aria-hidden="true" />{label}</span>
                <strong>已选 {selectedRecordIds.length}</strong>
              </header>
              <label className="version-form-association-search">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  value={associationSearch[id]}
                  placeholder="搜索编号或标题"
                  aria-label={`搜索${label}`}
                  onChange={(event) => setAssociationSearch((current) => ({
                    ...current,
                    [id]: event.target.value,
                  }))}
                />
              </label>
              <div className="version-form-association-options" role="group" aria-label={label}>
                {filteredCandidates.length ? filteredCandidates.map((item) => {
                  const selected = selectedRecordIds.includes(item.recordId);
                  return (
                    <label
                      className={`version-form-association-option ${selected ? 'is-selected' : ''}`}
                      key={item.recordId}
                    >
                      <span className="version-form-association-option-copy">
                        <strong>{item.itemId || '无编号'}</strong>
                        <span title={item.title}>{item.title}</span>
                        {item.isExistingOnly ? <small>历史关联</small> : null}
                      </span>
                      <input
                        type="checkbox"
                        checked={selected}
                        aria-label={`${selected ? '取消选择' : '选择'}${item.itemId || item.title}`}
                        onChange={(event) => onChange((current) => {
                          const currentIds = Array.isArray(current.associations[id])
                            ? current.associations[id]
                            : [];
                          return {
                            ...current,
                            associations: {
                              ...current.associations,
                              [id]: event.target.checked
                                ? [...new Set([...currentIds, item.recordId])]
                                : currentIds.filter((recordId) => recordId !== item.recordId),
                            },
                          };
                        })}
                      />
                    </label>
                  );
                }) : (
                  <p className="version-form-association-empty">
                    {candidates.length ? '没有匹配的工作项' : '暂无可关联的工作项'}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {!isEditing ? (
        <label className="version-form-reason">
          <span>创建说明</span>
          <textarea
            value={state.reason}
            maxLength={2000}
            placeholder="可填写版本创建说明"
            onChange={(event) => onChange((current) => ({ ...current, reason: event.target.value }))}
          />
        </label>
      ) : null}
      {state.error ? <p className="version-form-error">{state.error}</p> : null}
      <div className="version-dialog-actions">
        <button type="button" className="version-secondary-button" onClick={onClose}>取消</button>
        <button
          type="button"
          className="version-primary-button"
          disabled={state.saving || !state.versionNumber.trim()}
          onClick={onSubmit}
        >
          {state.saving ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Check aria-hidden="true" />}
          <span>{isEditing ? '保存变动' : '创建版本'}</span>
        </button>
      </div>
    </DialogShell>
  );
}

function StatusEditorDialog({ state, statusOptions, onChange, onClose, onSubmit }) {
  return (
    <DialogShell title="变更版本状态" icon={GitBranch} onClose={onClose}>
      <div className="version-status-change-summary">
        <span className={`version-status-badge ${getStatusClass(state.currentStatus)}`}>{state.currentStatus}</span>
        <ChevronRight aria-hidden="true" />
        <span className={`version-status-badge ${getStatusClass(state.newStatus)}`}>{state.newStatus || '请选择'}</span>
      </div>
      <label className="version-form-reason">
        <span>新状态</span>
        <select
          value={state.newStatus}
          onChange={(event) => onChange((current) => ({ ...current, newStatus: event.target.value }))}
        >
          {statusOptions.filter((status) => status !== state.currentStatus).map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
      </label>
      <label className="version-form-reason">
        <span>变更原因</span>
        <textarea
          value={state.reason}
          maxLength={2000}
          placeholder="请填写状态变更原因"
          onChange={(event) => onChange((current) => ({ ...current, reason: event.target.value }))}
        />
      </label>
      <p className="version-dialog-hint">目标状态已被同平台其他版本占用时，原版本会自动变更为过时。</p>
      {state.error ? <p className="version-form-error">{state.error}</p> : null}
      <div className="version-dialog-actions">
        <button type="button" className="version-secondary-button" onClick={onClose}>取消</button>
        <button
          type="button"
          className="version-primary-button"
          disabled={state.saving || !state.newStatus || !state.reason.trim()}
          onClick={onSubmit}
        >
          {state.saving ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
          <span>确认变更</span>
        </button>
      </div>
    </DialogShell>
  );
}

function ConfirmDeleteDialog({ version, onClose, onConfirm }) {
  return (
    <DialogShell title="删除版本" icon={Trash2} onClose={onClose} tone="danger">
      <p className="version-delete-copy">
        确认删除版本 <strong>{version.versionNumber}</strong>（{version.platform}）？此操作不能撤销。
      </p>
      {version.error ? <p className="version-form-error">{version.error}</p> : null}
      <div className="version-dialog-actions">
        <button type="button" className="version-secondary-button" onClick={onClose}>取消</button>
        <button type="button" className="version-danger-button" onClick={onConfirm}>
          <Trash2 aria-hidden="true" />
          <span>删除版本</span>
        </button>
      </div>
    </DialogShell>
  );
}

function DialogShell({ title, icon: Icon, onClose, tone = '', children }) {
  return (
    <div className="version-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className={`version-dialog ${tone ? `is-${tone}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div><Icon aria-hidden="true" /><h2>{title}</h2></div>
          <button type="button" title="关闭" aria-label="关闭" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="version-dialog-body">{children}</div>
      </section>
    </div>
  );
}

function VersionState({ icon: Icon, text, spinning = false, tone = '', children }) {
  return (
    <div className={`version-management-state ${tone ? `is-${tone}` : ''}`}>
      <Icon className={spinning ? 'is-spinning' : ''} aria-hidden="true" />
      <span>{text}</span>
      {children}
    </div>
  );
}

function Avatar({ user }) {
  if (user?.avatarUrl) {
    return <span className="version-avatar"><img src={user.avatarUrl} alt="" /></span>;
  }
  return <span className="version-avatar is-fallback" aria-hidden="true">{String(user?.name || '人')[0]}</span>;
}

function createEditorState(version, data) {
  return {
    recordId: version?.recordId || '',
    versionNumber: version?.versionNumber || '',
    platform: version?.platform || data.platformOptions[0] || 'IGP',
    status: version?.status || data.statusOptions[0] || '测试开发',
    previousVersionRecordId: version?.previousVersion?.recordId || '',
    reason: '',
    associations: Object.fromEntries(ASSOCIATION_DEFINITIONS.map(({ id }) => [
      id,
      version?.[id]?.map((item) => item.recordId) || [],
    ])),
    existingAssociations: Object.fromEntries(ASSOCIATION_DEFINITIONS.map(({ id }) => [
      id,
      version?.[id] || [],
    ])),
    saving: false,
    error: '',
  };
}

function buildEditorPayload(editor) {
  return {
    versionNumber: editor.versionNumber,
    platform: editor.platform,
    status: editor.status,
    previousVersionRecordId: editor.previousVersionRecordId,
    reason: editor.reason,
    associations: editor.associations,
  };
}

function mergeAssociationCandidates(candidates, existing) {
  const result = new Map(
    (Array.isArray(candidates) ? candidates : []).map((item) => [item.recordId, item]),
  );
  for (const item of Array.isArray(existing) ? existing : []) {
    if (!result.has(item.recordId)) {
      result.set(item.recordId, { ...item, isExistingOnly: true });
    }
  }
  return [...result.values()];
}

function getStatusClass(status) {
  if (status === '测试开发') {
    return 'is-development';
  }
  if (status === '测试发布') {
    return 'is-testing';
  }
  if (status === '正式发布') {
    return 'is-released';
  }
  return 'is-obsolete';
}

function formatDateTime(value) {
  const timestamp = Date.parse(value);
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

function buildVersionCacheMessage(savedAt, refreshing, errorMessage = '') {
  const time = formatCacheTime(savedAt);
  return refreshing
    ? `已加载本地缓存（最后同步：${time}），正在后台更新`
    : `已显示本地缓存（最后同步：${time}）。服务器更新失败：${errorMessage || '请求失败'}`;
}

function formatCacheTime(value) {
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

function isSameUser(comment, user) {
  const left = String(comment?.authorOpenId || '').trim();
  const right = String(user?.openId || user?.open_id || '').trim();
  return Boolean(left && right && left === right);
}

function formatError(error) {
  return error instanceof Error && error.message ? error.message : '请求失败';
}
