import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTodoNotificationDedupeKey,
  collectPendingTodoNotificationItems,
  getZonedDateTimeParts,
  isTodoNotificationDue,
  normalizePersonalNotificationSettings,
  normalizeTodoNotificationTime,
  summarizeTodoNotificationItems,
} from '../shared/personalSettingsUtils.js';
import {
  createTodoNotificationScheduler,
  getDelayToNextMinuteCheck,
} from '../server/services/todoNotificationScheduler.js';

test('personal notification settings normalize defaults and Feishu time values', () => {
  assert.deepEqual(normalizePersonalNotificationSettings({}), {
    receiveTodoNotifications: false,
    todoNotificationTime: '11:00',
  });
  assert.equal(normalizeTodoNotificationTime('09:35'), '09:35');
  assert.equal(
    normalizeTodoNotificationTime(Date.parse('2026-07-18T03:20:00.000Z')),
    '11:20',
  );
});

test('notification due checks and dedupe keys use Asia Shanghai calendar time', () => {
  const now = new Date('2026-07-18T03:00:15.000Z');

  assert.deepEqual(getZonedDateTimeParts(now), {
    dateKey: '2026-07-18',
    time: '11:00',
  });
  assert.equal(isTodoNotificationDue({
    receiveTodoNotifications: true,
    todoNotificationTime: '11:00',
  }, now), true);
  assert.equal(isTodoNotificationDue({
    receiveTodoNotifications: false,
    todoNotificationTime: '11:00',
  }, now), false);
  assert.equal(
    buildTodoNotificationDedupeKey({ openId: 'ou_user' }, now),
    'ou_user|2026-07-18',
  );
});

test('todo notification items include assigned unfinished work across all four tools', () => {
  const user = { openId: 'ou_current', name: '当前用户' };
  const sources = [
    {
      toolId: 'requirements',
      project: { projectId: 'P-1', projectName: '项目一' },
      items: [
        {
          recordId: 'req-1',
          itemId: 'R-0001',
          title: '处理需求',
          itemStatus: '处理中',
          assignees: [{ openId: 'ou_current' }],
          remainingDays: 2,
          proposedAt: Date.parse('2026-07-10T00:00:00Z'),
        },
        {
          recordId: 'req-2',
          title: '完成需求',
          itemStatus: '已完成',
          assignees: [{ openId: 'ou_current' }],
          remainingDays: -3,
        },
        {
          recordId: 'req-3',
          title: '待验收需求',
          itemStatus: '待验收',
          assignees: [{ openId: 'ou_current' }],
          remainingDays: 1,
        },
      ],
    },
    {
      toolId: 'bugs',
      project: { projectId: 'P-1', projectName: '项目一' },
      items: [
        {
          recordId: 'bug-1',
          itemId: 'B-0001',
          title: '阻塞Bug',
          itemStatus: '已搁置',
          assignees: [{ openId: 'ou_current' }],
          remainingDays: -1,
        },
      ],
    },
    {
      toolId: 'feedback',
      project: { projectId: 'P-2', projectName: '项目二' },
      items: [
        {
          recordId: 'feedback-1',
          itemId: 'F-0001',
          title: '其他人的反馈',
          itemStatus: '处理中',
          assignees: [{ openId: 'ou_other' }],
        },
      ],
    },
  ];
  const items = collectPendingTodoNotificationItems(sources, user, {
    requirements: { completed: ['已完成', '关闭'] },
    bugs: { completed: ['已修复', '关闭'] },
    feedback: { completed: ['已完成', '关闭'] },
    testTasks: { completed: ['已完成'] },
  });

  assert.deepEqual(items.map((item) => item.recordId), ['bug-1', 'req-3', 'req-1']);
  assert.deepEqual(summarizeTodoNotificationItems(items), {
    total: 3,
    counts: {
      requirements: 2,
      bugs: 1,
      testTasks: 0,
      feedback: 0,
    },
    displayedItems: items,
    hiddenCount: 0,
  });
});

test('minute scheduler aligns checks to second five and reschedules after a run', async () => {
  assert.equal(getDelayToNextMinuteCheck(new Date('2026-07-18T11:00:02.000Z')), 3000);
  assert.equal(getDelayToNextMinuteCheck(new Date('2026-07-18T11:00:05.000Z')), 60_000);
  assert.equal(getDelayToNextMinuteCheck(new Date('2026-07-18T11:00:10.000Z')), 55_000);

  let current = new Date('2026-07-18T11:00:02.000Z');
  const scheduled = [];
  let runCount = 0;
  const scheduler = createTodoNotificationScheduler({
    now: () => current,
    run: async () => {
      runCount += 1;
      current = new Date('2026-07-18T11:00:05.000Z');
    },
    setTimer(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    clearTimer() {},
  });

  scheduler.start();
  scheduler.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 3000);

  await scheduled[0].callback();
  assert.equal(runCount, 1);
  assert.equal(scheduled[1].delay, 60_000);

  scheduler.stop();
  assert.equal(scheduler.isStarted(), false);
});
