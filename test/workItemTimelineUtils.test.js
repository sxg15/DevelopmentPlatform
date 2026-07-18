import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkItemTimelineEvents,
  classifyWorkItemTimelineComment,
  filterWorkItemTimelineEvents,
  normalizeWorkItemTimelineTimestamp,
  sliceWorkItemTimelineEvents,
  sortWorkItemTimelineEvents,
  WORK_ITEM_TIMELINE_EVENT_TYPES,
} from '../src/ui/work-items/workItemTimelineUtils.js';

const TOOL_CONFIGS = {
  requirements: { toolId: 'requirements', itemLabel: '需求' },
  bugs: { toolId: 'bugs', itemLabel: 'Bug' },
  feedback: { toolId: 'feedback', itemLabel: '反馈' },
};

test('creation events use the work item label without inventing initial status or assignee', () => {
  for (const [toolId, expectedTitle] of [
    ['requirements', '创建需求'],
    ['bugs', '创建Bug'],
    ['feedback', '创建反馈'],
  ]) {
    const [event] = buildWorkItemTimelineEvents(TOOL_CONFIGS[toolId], {
      recordId: `${toolId}-1`,
      proposedAt: '2026-07-18T08:00:00.000Z',
      proposers: [{ name: '张三' }],
    });

    assert.equal(event.title, expectedTitle);
    assert.equal(event.summary, `张三提交了${TOOL_CONFIGS[toolId].itemLabel}`);
    assert.equal('oldStatus' in event, false);
    assert.equal('newStatus' in event, false);
  }
});

test('status events retain old and new statuses, operator, and message', () => {
  const events = buildWorkItemTimelineEvents(TOOL_CONFIGS.requirements, {
    statusChangeLog: [{
      id: 'status-1',
      oldStatus: '待处理',
      newStatus: '处理中',
      changedAt: '2026-07-18T09:00:00.000Z',
      operatorName: '李四',
      message: '开始实现',
    }],
  });

  assert.deepEqual(events[0], {
    id: 'status:status-1',
    type: WORK_ITEM_TIMELINE_EVENT_TYPES.STATUS_CHANGED,
    category: 'key',
    occurredAt: Date.parse('2026-07-18T09:00:00.000Z'),
    actorName: '李四',
    title: '处理状态变更',
    summary: '李四变更了处理状态',
    detail: '开始实现',
    oldStatus: '待处理',
    newStatus: '处理中',
    sourceOrder: 0,
  });
});

test('system comment prefixes classify assignee and attachment changes', () => {
  assert.deepEqual(classifyWorkItemTimelineComment('变更处理人：张三 -> 李四。原因：模块调整'), {
    type: WORK_ITEM_TIMELINE_EVENT_TYPES.ASSIGNEE_CHANGED,
    title: '处理人变更',
    detail: '张三 -> 李四。原因：模块调整',
  });
  assert.deepEqual(classifyWorkItemTimelineComment('提交附件变动：新增：验收报告.pdf；删除：旧说明.docx。'), {
    type: WORK_ITEM_TIMELINE_EVENT_TYPES.ATTACHMENTS_CHANGED,
    title: '提交附件变更',
    detail: '新增：验收报告.pdf；删除：旧说明.docx。',
  });
});

test('ordinary comments are not misclassified as system changes', () => {
  const classified = classifyWorkItemTimelineComment('请补充复现步骤，文中提到了提交附件变动。');
  assert.equal(classified.type, WORK_ITEM_TIMELINE_EVENT_TYPES.COMMENT_ADDED);
  assert.equal(classified.detail, '请补充复现步骤，文中提到了提交附件变动。');
});

test('events are stably sorted newest first and invalid timestamps are excluded', () => {
  const events = buildWorkItemTimelineEvents(TOOL_CONFIGS.bugs, {
    proposedAt: 'invalid',
    statusChangeLog: [
      { id: 'invalid-status', newStatus: '处理中', changedAt: '', operatorName: '甲' },
      { id: 'first', newStatus: '处理中', changedAt: 2000, operatorName: '乙' },
      { id: 'second', newStatus: '已处理', changedAt: 2000, operatorName: '丙' },
    ],
    comments: [
      { id: 'newest', createdAt: 3000, authorOpenId: 'ou_1', authorName: '丁', content: '已验证' },
      { id: 'invalid-comment', createdAt: 'not-a-date', authorOpenId: 'ou_2', content: '无效' },
    ],
  });

  assert.deepEqual(events.map((event) => event.id), [
    'comment:newest',
    'status:first',
    'status:second',
  ]);
  assert.equal(normalizeWorkItemTimelineTimestamp('not-a-date'), null);

  const stable = sortWorkItemTimelineEvents([
    { id: 'a', occurredAt: 10 },
    { id: 'b', occurredAt: 10 },
  ]);
  assert.deepEqual(stable.map((event) => event.id), ['a', 'b']);
});

test('filters and pagination separate key events from ordinary comments', () => {
  const events = [
    { id: 'created', category: 'key' },
    { id: 'status', category: 'key' },
    { id: 'comment', category: 'comments' },
  ];

  assert.deepEqual(filterWorkItemTimelineEvents(events, 'key').map((event) => event.id), ['created', 'status']);
  assert.deepEqual(filterWorkItemTimelineEvents(events, 'comments').map((event) => event.id), ['comment']);
  assert.deepEqual(filterWorkItemTimelineEvents(events, 'all').map((event) => event.id), ['created', 'status', 'comment']);

  const manyEvents = Array.from({ length: 25 }, (_, index) => ({ id: String(index) }));
  assert.equal(sliceWorkItemTimelineEvents(manyEvents).length, 20);
  assert.equal(sliceWorkItemTimelineEvents(manyEvents, 40).length, 25);
});

test('empty and malformed event arrays produce an empty timeline safely', () => {
  assert.deepEqual(buildWorkItemTimelineEvents(TOOL_CONFIGS.feedback, {
    statusChangeLog: {},
    comments: 'invalid',
  }), []);
  assert.deepEqual(filterWorkItemTimelineEvents(null, 'all'), []);
  assert.deepEqual(sliceWorkItemTimelineEvents(undefined), []);
});
