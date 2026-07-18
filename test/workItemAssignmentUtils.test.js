import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canManageWorkItemAssignees,
  getAssignmentNotificationTargetLabel,
  getRoleGrantedWorkItemToolIds,
  supportsUnassignedWorkItemRouting,
  validateWorkItemAssignmentChoice,
} from '../shared/workItemAssignmentUtils.js';

test('only requirements and bugs support explicit unassigned routing', () => {
  assert.equal(supportsUnassignedWorkItemRouting('requirements'), true);
  assert.equal(supportsUnassignedWorkItemRouting('bugs'), true);
  assert.equal(supportsUnassignedWorkItemRouting('feedback'), false);
});

test('requirement and bug submissions require one assignment choice', () => {
  assert.equal(validateWorkItemAssignmentChoice({
    toolId: 'requirements',
    assignees: [],
    needsAssigneeAssignment: false,
  }), '请选择处理人员，或点击“不知道该由谁处理”');

  assert.equal(validateWorkItemAssignmentChoice({
    toolId: 'bugs',
    assignees: [{ openId: 'ou_assignee' }],
    needsAssigneeAssignment: true,
  }), '选择“不知道该由谁处理”后不能再选择处理人员');

  assert.equal(validateWorkItemAssignmentChoice({
    toolId: 'requirements',
    assignees: [{ openId: 'ou_assignee' }],
    needsAssigneeAssignment: false,
  }), '');

  assert.equal(validateWorkItemAssignmentChoice({
    toolId: 'bugs',
    assignees: [],
    needsAssigneeAssignment: true,
  }), '');
});

test('development super admins can assign work without global admin privileges', () => {
  assert.equal(canManageWorkItemAssignees({
    toolId: 'requirements',
    isSuperAdmin: false,
    isDevelopmentSuperAdmin: true,
    isCurrentAssignee: false,
  }), true);
  assert.equal(canManageWorkItemAssignees({
    toolId: 'requirements',
    isSuperAdmin: false,
    isDevelopmentSuperAdmin: false,
    isCurrentAssignee: false,
  }), false);
  assert.equal(canManageWorkItemAssignees({
    toolId: 'feedback',
    isSuperAdmin: false,
    isDevelopmentSuperAdmin: true,
    isCurrentAssignee: false,
  }), false);

  assert.deepEqual(
    [...getRoleGrantedWorkItemToolIds({
      isSuperAdmin: false,
      isDevelopmentSuperAdmin: true,
      allToolIds: ['requirements', 'bugs', 'feedback', 'builds', 'review'],
    })].sort(),
    ['bugs', 'requirements'],
  );
});

test('notification labels distinguish assignees from development super admins', () => {
  assert.equal(getAssignmentNotificationTargetLabel(false), '处理人');
  assert.equal(getAssignmentNotificationTargetLabel(true), '研发超级管理员');
});
