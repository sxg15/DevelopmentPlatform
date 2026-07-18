import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CirclePlus,
  MessageSquare,
  Paperclip,
  RefreshCcw,
  UserRoundCog,
} from 'lucide-react';
import { Chrono } from 'react-chrono';
import {
  buildWorkItemTimelineEvents,
  filterWorkItemTimelineEvents,
  formatWorkItemTimelineDateTime,
  sliceWorkItemTimelineEvents,
  WORK_ITEM_TIMELINE_EVENT_TYPES,
  WORK_ITEM_TIMELINE_FILTERS,
  WORK_ITEM_TIMELINE_PAGE_SIZE,
} from './workItemTimelineUtils.js';

const TIMELINE_THEME = {
  primary: '#0f766e',
  secondary: '#dbe7e3',
  cardBgColor: '#ffffff',
  cardDetailsBackGround: '#ffffff',
  cardDetailsColor: '#20312d',
  cardTitleColor: '#071411',
  iconBackgroundColor: '#ffffff',
  iconColor: '#0f766e',
  textColor: '#425650',
  titleColor: '#425650',
  titleColorActive: '#071411',
  timelineBgColor: '#ffffff',
};

export default function WorkItemTimeline({ toolConfig, record }) {
  const [activeFilter, setActiveFilter] = useState('all');
  const [visibleCount, setVisibleCount] = useState(WORK_ITEM_TIMELINE_PAGE_SIZE);
  const events = useMemo(
    () => buildWorkItemTimelineEvents(toolConfig, record),
    [toolConfig, record],
  );
  const filteredEvents = useMemo(
    () => filterWorkItemTimelineEvents(events, activeFilter),
    [events, activeFilter],
  );
  const visibleEvents = useMemo(
    () => sliceWorkItemTimelineEvents(filteredEvents, visibleCount),
    [filteredEvents, visibleCount],
  );
  const parseWarnings = [
    record?.statusChangeLogParseError,
    record?.commentsParseError,
  ].map((item) => String(item || '').trim()).filter(Boolean);

  useEffect(() => {
    setActiveFilter('all');
    setVisibleCount(WORK_ITEM_TIMELINE_PAGE_SIZE);
  }, [record?.recordId]);

  function handleFilterChange(filterId) {
    setActiveFilter(filterId);
    setVisibleCount(WORK_ITEM_TIMELINE_PAGE_SIZE);
  }

  return (
    <section className="work-item-timeline" aria-label={`${toolConfig?.itemLabel || '事项'}时间轴`}>
      <header className="work-item-timeline-header">
        <div>
          <h3>时间轴</h3>
          <span>{events.length} 条动态</span>
        </div>
        <div className="work-item-timeline-filters" role="group" aria-label="筛选时间轴">
          {WORK_ITEM_TIMELINE_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={activeFilter === filter.id ? 'is-active' : ''}
              aria-pressed={activeFilter === filter.id}
              onClick={() => handleFilterChange(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </header>

      {parseWarnings.length > 0 ? (
        <div className="work-item-timeline-warning" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>{parseWarnings.join('；')}，时间轴仅显示能够读取的历史动态。</span>
        </div>
      ) : null}

      {visibleEvents.length > 0 ? (
        <>
          <div className="work-item-timeline-chrono">
            <Chrono
              items={visibleEvents.map((event) => ({
                id: event.id,
                title: '',
              }))}
              mode="vertical"
              allowDynamicUpdate
              theme={TIMELINE_THEME}
              layout={{
                cardWidth: 900,
                lineWidth: 2,
                pointSize: 30,
                timelineHeight: 'auto',
                responsive: {
                  enabled: true,
                  breakpoint: 720,
                },
              }}
              interaction={{
                autoScroll: false,
                cardHover: false,
                focusOnLoad: false,
                keyboardNavigation: true,
                pointClick: false,
              }}
              content={{
                allowHTML: false,
                compactText: true,
                readMore: false,
                semanticTags: {
                  title: 'div',
                  subtitle: 'div',
                },
              }}
              display={{
                borderless: true,
                pointShape: 'circle',
                scrollable: false,
                toolbar: {
                  enabled: false,
                },
              }}
              animation={{
                slideshow: {
                  enabled: false,
                },
              }}
              darkMode={{
                enabled: false,
                showToggle: false,
              }}
            >
              {visibleEvents.map((event) => (
                <TimelineEventContent key={event.id} event={event} />
              ))}
              <div className="chrono-icons">
                {visibleEvents.map((event) => (
                  <TimelineEventIcon key={event.id} type={event.type} />
                ))}
              </div>
            </Chrono>
          </div>
          <footer className="work-item-timeline-footer">
            <span>已显示 {visibleEvents.length} / {filteredEvents.length} 条</span>
            {visibleEvents.length < filteredEvents.length ? (
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + WORK_ITEM_TIMELINE_PAGE_SIZE)}
              >
                <ChevronDown aria-hidden="true" />
                显示更多
              </button>
            ) : null}
          </footer>
        </>
      ) : (
        <p className="work-item-timeline-empty">暂无可显示的历史动态</p>
      )}
    </section>
  );
}

function TimelineEventContent({ event }) {
  const [expanded, setExpanded] = useState(false);
  const occurredAtText = formatWorkItemTimelineDateTime(event.occurredAt);
  const shouldCollapse = event.detail.length > 120 || event.detail.split(/\r?\n/).length > 3;

  return (
    <article className={`work-item-timeline-event is-${event.type}`}>
      <time dateTime={new Date(event.occurredAt).toISOString()} title={occurredAtText}>
        {occurredAtText}
      </time>
      <div className="work-item-timeline-event-heading">
        <h4>{event.title}</h4>
        <span>{event.summary}</span>
      </div>
      {event.type === WORK_ITEM_TIMELINE_EVENT_TYPES.STATUS_CHANGED ? (
        <div className="work-item-timeline-status-change" aria-label={`从${event.oldStatus}变更为${event.newStatus}`}>
          <span>{event.oldStatus}</span>
          <RefreshCcw aria-hidden="true" />
          <strong>{event.newStatus}</strong>
        </div>
      ) : null}
      {event.detail ? (
        <div className="work-item-timeline-detail">
          <p className={!expanded && shouldCollapse ? 'is-collapsed' : ''}>{event.detail}</p>
          {shouldCollapse ? (
            <button type="button" onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              {expanded ? '收起' : '展开'}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TimelineEventIcon({ type }) {
  const Icon = getTimelineEventIcon(type);
  return (
    <span className={`work-item-timeline-icon is-${type}`} aria-hidden="true">
      <Icon />
    </span>
  );
}

function getTimelineEventIcon(type) {
  if (type === WORK_ITEM_TIMELINE_EVENT_TYPES.STATUS_CHANGED) {
    return RefreshCcw;
  }
  if (type === WORK_ITEM_TIMELINE_EVENT_TYPES.ASSIGNEE_CHANGED) {
    return UserRoundCog;
  }
  if (type === WORK_ITEM_TIMELINE_EVENT_TYPES.ATTACHMENTS_CHANGED) {
    return Paperclip;
  }
  if (type === WORK_ITEM_TIMELINE_EVENT_TYPES.COMMENT_ADDED) {
    return MessageSquare;
  }
  return CirclePlus;
}
