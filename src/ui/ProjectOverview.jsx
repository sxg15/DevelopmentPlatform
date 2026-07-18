import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import {
  Activity,
  AlertTriangle,
  ChartNoAxesColumnIncreasing,
  ChartPie,
  ChartSpline,
  ChevronRight,
  CircleCheck,
  Clock3,
  ListTodo,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  UserRoundX,
  Users,
  Wrench,
} from 'lucide-react';

import {
  createProjectOverviewSnapshotKey,
  getCachedSnapshot,
  readLocalPreference,
  saveCachedSnapshot,
  writeLocalPreference,
} from './localCache.js';
import { fetchProjectOverview } from '../api/overview.js';

echarts.use([
  AriaComponent,
  BarChart,
  CanvasRenderer,
  GridComponent,
  LegendComponent,
  LineChart,
  PieChart,
  TooltipComponent,
]);

const STATUS_COLORS = {
  waiting: '#d97706',
  processing: '#2563eb',
  completed: '#16a34a',
  blocked: '#64748b',
  other: '#0f766e',
};

const PRIORITY_COLORS = {
  P0: '#dc2626',
  P1: '#ea580c',
  P2: '#ca8a04',
  P3: '#2563eb',
  P4: '#64748b',
};

const RISK_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'unassigned', label: '未分配' },
  { id: 'overdue', label: '逾期' },
  { id: 'dueSoon', label: '即将到期' },
  { id: 'stale', label: '长期无进展' },
  { id: 'missingAttachment', label: '缺少附件' },
];

export function ProjectOverview({
  project,
  cacheUserKey,
  realtimeEvent,
  onOpenItem,
  onOpenStatus,
}) {
  const projectId = String(project?.projectId || '').trim();
  const preferenceName = `project-overview:${projectId}`;
  const storedPreference = readLocalPreference(cacheUserKey, preferenceName, {}) || {};
  const [scope, setScope] = useState(storedPreference.scope === 'mine' ? 'mine' : 'project');
  const [trendDays, setTrendDays] = useState([14, 30, 90].includes(Number(storedPreference.trendDays))
    ? Number(storedPreference.trendDays)
    : 30);
  const [state, setState] = useState({
    status: 'loading',
    message: '',
    data: null,
  });
  const [riskFilter, setRiskFilter] = useState('all');
  const requestIdRef = useRef(0);
  const realtimeTimerRef = useRef(null);
  const riskSectionRef = useRef(null);

  useEffect(() => {
    writeLocalPreference(cacheUserKey, preferenceName, { scope, trendDays });
  }, [cacheUserKey, preferenceName, scope, trendDays]);

  useEffect(() => {
    void loadOverview({ readCache: true });
    return () => {
      requestIdRef.current += 1;
    };
  }, [projectId, scope, trendDays]);

  useEffect(() => {
    if (!realtimeEvent || realtimeEvent.projectId !== projectId) {
      return undefined;
    }

    clearTimeout(realtimeTimerRef.current);
    realtimeTimerRef.current = setTimeout(() => {
      void loadOverview({ readCache: false });
    }, 500);
    return () => clearTimeout(realtimeTimerRef.current);
  }, [projectId, realtimeEvent?.id]);

  async function loadOverview({ readCache }) {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const snapshotKey = createProjectOverviewSnapshotKey(
      cacheUserKey,
      projectId,
      scope,
      trendDays,
    );
    let cachedSnapshot = null;

    if (readCache) {
      cachedSnapshot = await getCachedSnapshot(snapshotKey);
      if (requestIdRef.current !== requestId) {
        return;
      }
      if (cachedSnapshot?.value) {
        setState({
          status: 'refreshing',
          message: buildOverviewCacheMessage(cachedSnapshot.savedAt, true),
          data: cachedSnapshot.value,
        });
      } else {
        setState({ status: 'loading', message: '正在加载项目总览', data: null });
      }
    } else {
      setState((current) => ({
        ...current,
        status: current.data ? 'refreshing' : 'loading',
        message: current.data ? '正在刷新项目总览' : '正在加载项目总览',
      }));
    }

    try {
      const payload = await fetchProjectOverview(projectId, scope, trendDays);
      await saveCachedSnapshot(cacheUserKey, snapshotKey, payload);
      if (requestIdRef.current === requestId) {
        setState({ status: 'ready', message: '', data: payload });
      }
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setState((current) => {
        const cachedData = cachedSnapshot?.value || current.data;
        return cachedData
          ? {
              status: 'ready',
              message: buildOverviewCacheMessage(
                cachedSnapshot?.savedAt || cachedData.generatedAt,
                false,
                formatOverviewError(error),
              ),
              data: cachedData,
            }
          : { status: 'error', message: formatOverviewError(error), data: null };
      });
    }
  }

  function showRiskFilter(filter) {
    setRiskFilter(filter);
    window.requestAnimationFrame(() => {
      riskSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  if (!state.data && state.status === 'loading') {
    return (
      <div className="project-overview-state" aria-live="polite">
        <LoaderCircle className="is-spinning" aria-hidden="true" />
        <span>{state.message}</span>
      </div>
    );
  }

  if (!state.data && state.status === 'error') {
    return (
      <div className="project-overview-state project-overview-state-error" aria-live="polite">
        <AlertTriangle aria-hidden="true" />
        <span>{state.message}</span>
        <button type="button" onClick={() => loadOverview({ readCache: false })}>重新加载</button>
      </div>
    );
  }

  const data = state.data || createEmptyOverviewData();
  const filteredRisks = riskFilter === 'all'
    ? data.risks || []
    : (data.risks || []).filter((item) => item.riskKinds?.includes(riskFilter));
  const statusOption = buildStatusChartOption(data.statusByTool || []);
  const priorityOption = buildPriorityChartOption(data.priorityDistribution || []);
  const trendOption = buildTrendChartOption(data.trend || []);
  const assigneeOption = buildAssigneeChartOption(data.assigneeLoad || []);

  return (
    <section className="project-overview" aria-label={`${project.projectName || '项目'}总览`}>
      <header className="project-overview-header">
        <div className="project-overview-identity">
          <OverviewProjectIcon project={project} />
          <div>
            <h1>{project.projectName || '未命名项目'}</h1>
            <span>{project.projectId || '无项目ID'}</span>
          </div>
        </div>
        <div className="project-overview-controls">
          <div className="project-overview-scope" role="group" aria-label="总览范围">
            <button
              type="button"
              className={scope === 'project' ? 'is-active' : ''}
              aria-pressed={scope === 'project'}
              onClick={() => setScope('project')}
            >
              项目全局
            </button>
            <button
              type="button"
              className={scope === 'mine' ? 'is-active' : ''}
              aria-pressed={scope === 'mine'}
              onClick={() => setScope('mine')}
            >
              我的任务
            </button>
          </div>
          <div className="project-overview-control-meta">
            <span className="project-overview-updated">
              更新于 {formatDateTime(data.generatedAt)}
            </span>
            <button
              type="button"
              className="project-overview-refresh"
              title="刷新项目总览"
              aria-label="刷新项目总览"
              disabled={state.status === 'refreshing'}
              onClick={() => loadOverview({ readCache: false })}
            >
              <RefreshCw className={state.status === 'refreshing' ? 'is-spinning' : ''} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {state.message ? <p className="project-overview-notice">{state.message}</p> : null}
      {(data.unavailableTools || []).length > 0 ? (
        <div className="project-overview-warning">
          <AlertTriangle aria-hidden="true" />
          <span>
            {(data.unavailableTools || []).map((item) => item.label).join('、')} 暂无统计数据
          </span>
        </div>
      ) : null}

      <div className="project-overview-kpis">
        <OverviewKpi icon={ListTodo} label="活跃工作项" value={data.summary?.active} />
        <OverviewKpi icon={Clock3} label="待处理" value={data.summary?.waiting} />
        <OverviewKpi icon={Wrench} label="处理中" value={data.summary?.processing} />
        <OverviewKpi
          icon={TriangleAlert}
          label="已逾期"
          value={data.summary?.overdue}
          tone="danger"
          onView={() => showRiskFilter('overdue')}
        />
        <OverviewKpi
          icon={UserRoundX}
          label="未分配"
          value={data.summary?.unassigned}
          tone="warning"
          onView={() => showRiskFilter('unassigned')}
        />
        <OverviewKpi icon={CircleCheck} label="本周完成" value={data.summary?.completedThisWeek} tone="success" />
      </div>

      <div className="project-overview-primary-grid">
        <OverviewPanel
          className="project-overview-panel-status"
          icon={ChartNoAxesColumnIncreasing}
          title="各类型处理状态"
          meta="当前快照"
        >
          <OverviewChart
            option={statusOption}
            empty={(data.statusByTool || []).length === 0}
            emptyText="暂无工作项状态数据"
            ariaLabel="需求、Bug和反馈处理状态分布"
            onClick={(params) => {
              const tool = data.statusByTool?.[params.dataIndex];
              const category = tool?.categories?.find((item) => item.key === params.seriesId);
              if (tool && category?.statuses?.length > 0) {
                onOpenStatus?.(tool.toolId, category.statuses.map((item) => item.name));
              }
            }}
          />
        </OverviewPanel>

        <OverviewPanel
          icon={ChartPie}
          title="活跃事项优先级"
          meta="需求与Bug"
        >
          <OverviewChart
            option={priorityOption}
            empty={!(data.priorityDistribution || []).some((item) => item.count > 0)}
            emptyText="暂无活跃需求或Bug"
            ariaLabel="活跃需求和Bug优先级分布"
          />
        </OverviewPanel>
      </div>

      <div className="project-overview-secondary-grid">
        <OverviewPanel
          className="project-overview-panel-trend"
          icon={ChartSpline}
          title="新增与完成趋势"
          meta={data.historyNotice}
          actions={(
            <div className="project-overview-range" role="group" aria-label="趋势周期">
              {[14, 30, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  className={trendDays === days ? 'is-active' : ''}
                  aria-pressed={trendDays === days}
                  onClick={() => setTrendDays(days)}
                >
                  {days}天
                </button>
              ))}
            </div>
          )}
        >
          <OverviewChart
            option={trendOption}
            empty={(data.trend || []).length === 0}
            emptyText="暂无趋势数据"
            ariaLabel={`最近${trendDays}天工作项新增和完成趋势`}
          />
        </OverviewPanel>

        <OverviewPanel icon={Users} title="处理人员任务分布" meta="多人任务会计入每位处理人">
          <OverviewChart
            option={assigneeOption}
            empty={(data.assigneeLoad || []).length === 0}
            emptyText="暂无已分配的活跃工作项"
            ariaLabel="处理人员活跃任务分布"
          />
        </OverviewPanel>
      </div>

      <div className="project-overview-bottom-grid">
        <section ref={riskSectionRef} className="project-overview-panel project-overview-risk-panel" aria-label="需要关注">
          <div className="project-overview-panel-header">
            <div className="project-overview-panel-title">
              <TriangleAlert aria-hidden="true" />
              <div>
                <h2>需要关注</h2>
                <span>{filteredRisks.length} 项</span>
              </div>
            </div>
          </div>
          <div className="project-overview-risk-filters" role="group" aria-label="风险筛选">
            {RISK_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={riskFilter === filter.id ? 'is-active' : ''}
                aria-pressed={riskFilter === filter.id}
                onClick={() => setRiskFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="project-overview-risk-list">
            {filteredRisks.length === 0 ? (
              <p className="project-overview-empty">当前筛选下没有需要关注的工作项</p>
            ) : filteredRisks.slice(0, 10).map((item) => (
              <button
                key={`${item.toolId}:${item.recordId}`}
                type="button"
                className="project-overview-risk-item"
                onClick={() => onOpenItem?.(item)}
              >
                <span className={`project-overview-tool-mark is-${item.toolId}`}>{item.toolLabel}</span>
                <span className="project-overview-risk-main">
                  <strong>{item.itemId ? `${item.itemId} · ` : ''}{item.title}</strong>
                  <small>
                    {item.status} · {formatAssigneeNames(item.assignees)} · {formatRemainingDays(item.remainingDays)}
                  </small>
                </span>
                <span className="project-overview-risk-tags">
                  {(item.riskLabels || []).slice(0, 2).map((label) => <span key={label}>{label}</span>)}
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>

        <OverviewPanel icon={Activity} title="最近动态" meta="平台内记录">
          <div className="project-overview-activity-list">
            {(data.recentActivity || []).length === 0 ? (
              <p className="project-overview-empty">暂无最近动态</p>
            ) : (data.recentActivity || []).slice(0, 10).map((activity) => (
              <button
                key={activity.id}
                type="button"
                className="project-overview-activity-item"
                onClick={() => onOpenItem?.(activity)}
              >
                <span className={`project-overview-activity-mark is-${activity.type}`} aria-hidden="true" />
                <span>
                  <strong>{activity.operatorName}</strong>
                  <span>{activity.text}</span>
                  <small>{activity.toolLabel} · {activity.itemId || activity.title} · {formatRelativeTime(activity.occurredAt)}</small>
                </span>
              </button>
            ))}
          </div>
        </OverviewPanel>
      </div>
    </section>
  );
}

function OverviewKpi({ icon: Icon, label, value, tone = 'default', onView }) {
  const content = (
    <>
      <span className={`project-overview-kpi-icon is-${tone}`}><Icon aria-hidden="true" /></span>
      <span className="project-overview-kpi-data">
        <small>{label}</small>
        <strong>{Math.max(0, Number(value) || 0)}</strong>
      </span>
      {onView ? <ChevronRight aria-hidden="true" /> : null}
    </>
  );

  return onView ? (
    <button type="button" className="project-overview-kpi is-action" onClick={onView}>
      {content}
    </button>
  ) : (
    <div className="project-overview-kpi">{content}</div>
  );
}

function OverviewPanel({ icon: Icon, title, meta, actions, className = '', children }) {
  return (
    <section className={`project-overview-panel ${className}`.trim()}>
      <div className="project-overview-panel-header">
        <div className="project-overview-panel-title">
          <Icon aria-hidden="true" />
          <div>
            <h2>{title}</h2>
            {meta ? <span>{meta}</span> : null}
          </div>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function OverviewChart({ option, empty, emptyText, ariaLabel, onClick }) {
  const elementRef = useRef(null);
  const chartRef = useRef(null);
  const clickHandlerRef = useRef(onClick);
  clickHandlerRef.current = onClick;

  useEffect(() => {
    if (!elementRef.current || empty) {
      return undefined;
    }

    const chart = echarts.init(elementRef.current, null, { renderer: 'canvas' });
    chartRef.current = chart;
    const handleClick = (params) => clickHandlerRef.current?.(params);
    chart.on('click', handleClick);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => chart.resize())
      : null;
    resizeObserver?.observe(elementRef.current);
    const handleWindowResize = () => chart.resize();
    if (!resizeObserver) {
      window.addEventListener('resize', handleWindowResize);
    }

    return () => {
      chart.off('click', handleClick);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, [empty]);

  useEffect(() => {
    if (!empty && chartRef.current) {
      chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true });
    }
  }, [empty, option]);

  if (empty) {
    return <div className="project-overview-chart-empty">{emptyText}</div>;
  }

  return <div ref={elementRef} className="project-overview-chart" role="img" aria-label={ariaLabel} />;
}

function OverviewProjectIcon({ project }) {
  const [failed, setFailed] = useState(false);
  const name = String(project?.projectName || '项目').trim();
  if (project?.iconUrl && !failed) {
    return (
      <span className="project-overview-project-icon">
        <img src={project.iconUrl} alt={`${name}图标`} onError={() => setFailed(true)} />
      </span>
    );
  }
  return <span className="project-overview-project-icon is-fallback" aria-hidden="true">{name[0] || '项'}</span>;
}

function buildStatusChartOption(statusByTool) {
  const categories = ['waiting', 'processing', 'completed', 'blocked', 'other'];
  const labels = {
    waiting: '待处理',
    processing: '处理中',
    completed: '已完成',
    blocked: '阻塞',
    other: '其他活跃',
  };
  return {
    animationDuration: 350,
    aria: { enabled: true },
    color: categories.map((key) => STATUS_COLORS[key]),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 10 },
    grid: { left: 54, right: 20, top: 18, bottom: 52, containLabel: true },
    xAxis: { type: 'value', minInterval: 1, axisLine: { show: false }, splitLine: { lineStyle: { color: '#e6eeeb' } } },
    yAxis: {
      type: 'category',
      data: statusByTool.map((item) => item.label),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#a9bbb5' } },
      axisLabel: { color: '#30433e', fontWeight: 700 },
    },
    series: categories.map((key) => ({
      id: key,
      name: labels[key],
      type: 'bar',
      stack: 'total',
      barMaxWidth: 30,
      emphasis: { focus: 'series' },
      data: statusByTool.map((tool) => tool.categories?.find((item) => item.key === key)?.count || 0),
    })),
  };
}

function buildPriorityChartOption(priorityDistribution) {
  const total = priorityDistribution.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  return {
    animationDuration: 350,
    aria: { enabled: true },
    color: priorityDistribution.map((item) => PRIORITY_COLORS[item.priority] || '#64748b'),
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 10 },
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: '39%',
        style: {
          text: String(total),
          fill: '#071411',
          fontSize: 28,
          fontWeight: 800,
          textAlign: 'center',
        },
      },
      {
        type: 'text',
        left: 'center',
        top: '52%',
        style: {
          text: '活跃事项',
          fill: '#5d706b',
          fontSize: 12,
          fontWeight: 700,
          textAlign: 'center',
        },
      },
    ],
    series: [
      {
        name: '优先级',
        type: 'pie',
        radius: ['48%', '70%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        label: { show: false },
        emphasis: { label: { show: true, fontWeight: 800 } },
        data: priorityDistribution.filter((item) => item.count > 0).map((item) => ({
          name: item.priority,
          value: item.count,
        })),
      },
    ],
  };
}

function buildTrendChartOption(trend) {
  return {
    animationDuration: 350,
    aria: { enabled: true },
    color: ['#0f766e', '#2563eb'],
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, itemWidth: 12, itemHeight: 8 },
    grid: { left: 20, right: 20, top: 18, bottom: 54, containLabel: true },
    xAxis: {
      type: 'category',
      data: trend.map((item) => item.date.slice(5)),
      axisTick: { show: false },
      axisLabel: { color: '#5d706b', hideOverlap: true },
      axisLine: { lineStyle: { color: '#a9bbb5' } },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#e6eeeb' } },
    },
    series: [
      {
        name: '新增',
        type: 'bar',
        barMaxWidth: 18,
        data: trend.map((item) => item.created),
      },
      {
        name: '完成',
        type: 'line',
        smooth: true,
        symbolSize: 6,
        lineStyle: { width: 3 },
        data: trend.map((item) => item.completed),
      },
    ],
  };
}

function buildAssigneeChartOption(load) {
  return {
    animationDuration: 350,
    aria: { enabled: true },
    color: [STATUS_COLORS.waiting, STATUS_COLORS.processing, '#dc2626'],
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 10 },
    grid: { left: 16, right: 20, top: 18, bottom: 52, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#e6eeeb' } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: load.map((item) => item.name),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#a9bbb5' } },
      axisLabel: { color: '#30433e', width: 76, overflow: 'truncate' },
    },
    series: [
      {
        name: '待处理',
        type: 'bar',
        stack: 'work',
        barMaxWidth: 18,
        data: load.map((item) => item.waiting),
      },
      {
        name: '处理中',
        type: 'bar',
        stack: 'work',
        barMaxWidth: 18,
        data: load.map((item) => item.processing),
      },
      {
        name: '其中逾期',
        type: 'bar',
        barMaxWidth: 10,
        data: load.map((item) => item.overdue),
      },
    ],
  };
}

function createEmptyOverviewData() {
  return {
    generatedAt: Date.now(),
    summary: {},
    statusByTool: [],
    priorityDistribution: [],
    trend: [],
    assigneeLoad: [],
    risks: [],
    recentActivity: [],
    unavailableTools: [],
  };
}

function buildOverviewCacheMessage(savedAt, refreshing, errorMessage = '') {
  const time = formatDateTime(savedAt);
  return refreshing
    ? `已加载本地缓存（最后同步：${time}），正在后台更新`
    : `已显示本地缓存（最后同步：${time}）。服务器更新失败：${errorMessage || '请求失败'}`;
}

function formatDateTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) {
    return '未知时间';
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatRelativeTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    return '时间未知';
  }
  const difference = Date.now() - timestamp;
  if (difference < 60 * 1000) {
    return '刚刚';
  }
  if (difference < 60 * 60 * 1000) {
    return `${Math.floor(difference / (60 * 1000))}分钟前`;
  }
  if (difference < 24 * 60 * 60 * 1000) {
    return `${Math.floor(difference / (60 * 60 * 1000))}小时前`;
  }
  if (difference < 7 * 24 * 60 * 60 * 1000) {
    return `${Math.floor(difference / (24 * 60 * 60 * 1000))}天前`;
  }
  return formatDateTime(timestamp);
}

function formatAssigneeNames(assignees) {
  const names = (Array.isArray(assignees) ? assignees : []).map((item) => item.name).filter(Boolean);
  return names.length > 0 ? names.join('、') : '未分配';
}

function formatRemainingDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) {
    return '未设置时限';
  }
  if (days < 0) {
    return `逾期 ${Math.abs(days).toFixed(1)} 天`;
  }
  if (days < 1) {
    return '1天内到期';
  }
  return `剩余 ${days.toFixed(1)} 天`;
}

function formatOverviewError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message === 'Failed to fetch' || message.includes('NetworkError')) {
    return '无法连接本地后端，请确认服务正在运行';
  }
  return message || '获取项目总览失败';
}
