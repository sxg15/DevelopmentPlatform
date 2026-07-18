import { useState } from 'react';

export function ProjectSidebar({ projectState, relatedWorkItemCounts, activeView, selectedProjectId, onHomeClick, onProjectSelect }) {
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
        <CacheStateNotice message={projectState.status === 'ready' ? projectState.message : ''} />
        <ProjectList
          state={projectState}
          relatedWorkItemCounts={relatedWorkItemCounts}
          selectedProjectId={selectedProjectId}
          onProjectSelect={onProjectSelect}
        />
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

export function ProjectList({ state, relatedWorkItemCounts, selectedProjectId, onProjectSelect }) {
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
      {state.projects.map((project) => {
        const relatedCounts = relatedWorkItemCounts?.[project.projectId];
        const hasRelatedCounts = hasRelatedWorkItemCounts(relatedCounts);

        return (
          <button
            key={project.recordId}
            type="button"
            className={`project-button ${hasRelatedCounts ? 'has-related-counts' : ''} ${selectedProjectId === project.recordId ? 'is-active' : ''}`}
            title={formatProjectTitle(project)}
            aria-pressed={selectedProjectId === project.recordId}
            onClick={() => onProjectSelect(project)}
          >
            <ProjectRelatedWorkItemBadges counts={relatedCounts} />
            <ProjectIcon project={project} />
            <span className="project-button-text">
              <span className="project-name">{project.projectName || '未命名项目'}</span>
              <span className="project-id">({project.projectId || '无ID'})</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function hasRelatedWorkItemCounts(counts) {
  return Number(counts?.requirements) > 0 || Number(counts?.bugs) > 0;
}

export function ProjectRelatedWorkItemBadges({ counts }) {
  const requirements = Math.max(0, Number(counts?.requirements) || 0);
  const bugs = Math.max(0, Number(counts?.bugs) || 0);

  if (requirements === 0 && bugs === 0) {
    return null;
  }

  return (
    <span className="project-related-badges" aria-label={`与我相关：${requirements}个待处理需求，${bugs}个未处理Bug`}>
      {requirements > 0 ? <span className="project-related-badge project-related-badge-requirements">{requirements}需求</span> : null}
      {bugs > 0 ? <span className="project-related-badge project-related-badge-bugs">{bugs}Bug</span> : null}
    </span>
  );
}

export function ProjectIcon({ project }) {
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

export function HomePanel({ user }) {
  return (
    <section className="workspace-content" aria-label="首页内容">
      <div className="home-panel">
        <p className="home-eyebrow">首页内容</p>
        <h1>欢迎您 {user.name}</h1>
      </div>
    </section>
  );
}

export function HomeIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 10.4 12 3l9 7.4v10.1a.5.5 0 0 1-.5.5H15v-6H9v6H3.5a.5.5 0 0 1-.5-.5V10.4Z" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg className="add-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.8 4h2.4v6.8H20v2.4h-6.8V20h-2.4v-6.8H4v-2.4h6.8V4Z" />
    </svg>
  );
}

function CacheStateNotice({ message }) {
  if (!message) {
    return null;
  }

  return <p className="cache-state-notice" role="status">{message}</p>;
}

function formatProjectTitle(project) {
  return `${project.projectName || '未命名项目'} (${project.projectId || '无ID'})`;
}
