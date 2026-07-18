import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
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
  formatWorkItemTimelineTrackDate,
  sliceWorkItemTimelineEvents,
  WORK_ITEM_TIMELINE_EVENT_TYPES,
  WORK_ITEM_TIMELINE_FILTERS,
  WORK_ITEM_TIMELINE_PAGE_SIZE,
} from './workItemTimelineUtils.js';

const TIMELINE_THEME = {
  primary: '#1677ff',
  secondary: '#dbeafe',
  cardBgColor: '#ffffff',
  cardDetailsBackGround: '#ffffff',
  cardDetailsColor: '#172033',
  cardTitleColor: '#101828',
  iconBackgroundColor: '#ffffff',
  iconColor: '#1677ff',
  textColor: '#475467',
  titleColor: '#667085',
  titleColorActive: '#101828',
  timelineBgColor: '#f7f9fc',
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
  const timelineEvents = useMemo(
    () => [...visibleEvents].reverse(),
    [visibleEvents],
  );
  const newestEventIndex = Math.max(0, timelineEvents.length - 1);
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

      {timelineEvents.length > 0 ? (
        <>
          <div className="work-item-timeline-chrono">
            <Chrono
              key={`${record?.recordId || 'record'}:${activeFilter}:${visibleCount}`}
              items={timelineEvents.map((event) => ({
                id: event.id,
                title: formatWorkItemTimelineTrackDate(event.occurredAt),
              }))}
              mode="horizontal-all"
              activeItemIndex={newestEventIndex}
              allowDynamicUpdate
              theme={TIMELINE_THEME}
              layout={{
                cardWidth: 216,
                cardHeight: 164,
                itemWidth: 232,
                lineWidth: 3,
                pointSize: 32,
                timelineHeight: 'auto',
                responsive: {
                  enabled: false,
                },
                positioning: {
                  cardPosition: 'top',
                },
              }}
              interaction={{
                autoScroll: false,
                cardHover: false,
                focusOnLoad: false,
                keyboardNavigation: true,
                pointClick: true,
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
                allCardsVisible: true,
                pointShape: 'circle',
                scrollable: {
                  scrollbar: true,
                },
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
              {timelineEvents.map((event) => (
                <TimelineEventContent key={event.id} event={event} />
              ))}
              <div className="chrono-icons">
                {timelineEvents.map((event) => (
                  <TimelineEventIcon key={event.id} type={event.type} />
                ))}
              </div>
            </Chrono>
          </div>
          <footer className="work-item-timeline-footer">
            <span>已显示 {timelineEvents.length} / {filteredEvents.length} 条</span>
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
  const occurredAtText = formatWorkItemTimelineDateTime(event.occurredAt);

  return (
    <article className={`work-item-timeline-event is-${event.type}`}>
      <header className="work-item-timeline-event-header">
        <TimelineEventIcon type={event.type} />
        <div className="work-item-timeline-event-heading">
          <h4>{event.title}</h4>
          <span>{event.summary}</span>
        </div>
        <time dateTime={new Date(event.occurredAt).toISOString()} title={occurredAtText}>
          {occurredAtText}
        </time>
      </header>
      {event.type === WORK_ITEM_TIMELINE_EVENT_TYPES.STATUS_CHANGED ? (
        <div className="work-item-timeline-status-change" aria-label={`从${event.oldStatus}变更为${event.newStatus}`}>
          <span>{event.oldStatus}</span>
          <RefreshCcw aria-hidden="true" />
          <strong>{event.newStatus}</strong>
        </div>
      ) : null}
      {event.detail ? (
        <div className="work-item-timeline-detail">
          <p className="is-collapsed" title={event.detail}>{event.detail}</p>
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
