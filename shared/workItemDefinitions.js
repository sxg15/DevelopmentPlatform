export const REQUIREMENT_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'];
export const WORK_ITEM_ACCEPTANCE_STATUS = '待验收';
export const FEEDBACK_STATUSES = Object.freeze({
  waiting: '待分类',
  convertedToRequirement: '已转需求',
  convertedToBug: '已转Bug',
  replied: '已回复',
});
export const FEEDBACK_LEGACY_ACTIVE_STATUSES = Object.freeze(['待处理', '处理中']);
export const FEEDBACK_LEGACY_COMPLETED_STATUSES = Object.freeze(['已完成', '已搁置', '已拒绝', '关闭']);

export const PROJECT_TOOL_DEFINITIONS = Object.freeze([
  { id: 'overview', label: '项目总览', iconKey: 'LayoutDashboard' },
  { id: 'versions', label: '版本管理', iconKey: 'Tags' },
  { id: 'aiPlans', label: 'AI方案', iconKey: 'FileText' },
  { id: 'requirements', label: '需求列表', iconKey: 'ClipboardList' },
  { id: 'bugs', label: 'Bug列表', iconKey: 'Bug' },
  { id: 'testTasks', label: '测试任务', iconKey: 'ListChecks' },
  { id: 'feedback', label: '反馈列表', iconKey: 'MessageSquare' },
  { id: 'builds', label: '打包列表', iconKey: 'PackageCheck' },
  { id: 'review', label: '内容审查', iconKey: 'ScanSearch' },
]);

export const WORK_ITEM_TOOL_DEFINITIONS = Object.freeze({
  requirements: Object.freeze({
    toolId: 'requirements',
    routeSegment: 'requirements',
    listLabel: '需求列表',
    itemLabel: '需求',
    itemNameLabel: '需求名称',
    submitLabel: '提交需求',
    countLabel: '项需求',
    itemsKey: 'requirements',
    legacyItemsKey: 'requirements',
    itemIdKey: 'requirementId',
    directDetailType: 'requirement-detail',
    directCommentType: 'requirement-comment',
    unnamedTitle: '未命名需求',
    noIdText: '无需求ID',
    loadingText: '正在准备需求列表',
    idleText: '点击需求列表后会准备项目对应的多维表格。',
    missingTargetText: '目标需求不存在或没有权限查看',
    detailAriaLabel: '需求详情',
    missingTemplatePrefix: '找不到需求模板',
    missingNodeText: '找不到项目需求表',
    notLinkedText: '需求列表没有关联多维表格',
    noTableText: '需求列表没有可读取的数据表',
    missingRecordText: '需求记录不存在',
    supportsPriority: true,
    supportsUnassignedRouting: true,
    dateLabel: '提出时间',
    processingStatuses: Object.freeze(['处理中', WORK_ITEM_ACCEPTANCE_STATUS]),
    acceptanceStatus: WORK_ITEM_ACCEPTANCE_STATUS,
  }),
  bugs: Object.freeze({
    toolId: 'bugs',
    routeSegment: 'bugs',
    listLabel: 'Bug列表',
    itemLabel: 'Bug',
    itemNameLabel: 'Bug名称',
    submitLabel: '提交Bug',
    countLabel: '个Bug',
    itemsKey: 'bugs',
    legacyItemsKey: 'bugs',
    itemIdKey: 'bugId',
    directDetailType: 'bug-detail',
    directCommentType: 'bug-comment',
    unnamedTitle: '未命名Bug',
    noIdText: '无BugID',
    loadingText: '正在准备Bug列表',
    idleText: '点击Bug列表后会准备项目对应的多维表格。',
    missingTargetText: '目标Bug不存在或没有权限查看',
    detailAriaLabel: 'Bug详情',
    missingTemplatePrefix: '找不到Bug模板',
    missingNodeText: '找不到项目Bug表',
    notLinkedText: 'Bug列表没有关联多维表格',
    noTableText: 'Bug列表没有可读取的数据表',
    missingRecordText: 'Bug记录不存在',
    supportsPriority: true,
    supportsUnassignedRouting: true,
    dateLabel: '发现时间',
    processingStatuses: Object.freeze(['修复中', WORK_ITEM_ACCEPTANCE_STATUS]),
    acceptanceStatus: WORK_ITEM_ACCEPTANCE_STATUS,
  }),
  testTasks: Object.freeze({
    toolId: 'testTasks',
    routeSegment: 'test-tasks',
    listLabel: '测试任务',
    itemLabel: '测试任务',
    itemNameLabel: '任务名称',
    submitLabel: '创建测试任务',
    countLabel: '个测试任务',
    itemsKey: 'testTasks',
    legacyItemsKey: 'testTasks',
    itemIdKey: 'taskId',
    directDetailType: 'test-task-detail',
    directCommentType: 'test-task-comment',
    unnamedTitle: '未命名测试任务',
    noIdText: '无任务ID',
    loadingText: '正在准备测试任务',
    idleText: '点击测试任务后会准备项目对应的多维表格。',
    missingTargetText: '目标测试任务不存在或没有权限查看',
    detailAriaLabel: '测试任务详情',
    missingTemplatePrefix: '找不到测试任务模板',
    missingNodeText: '找不到项目测试任务表',
    notLinkedText: '测试任务没有关联多维表格',
    noTableText: '测试任务没有可读取的数据表',
    missingRecordText: '测试任务记录不存在',
    supportsPriority: false,
    supportsUnassignedRouting: false,
    dateLabel: '创建时间',
    processingStatuses: Object.freeze(['测试中']),
    acceptanceStatus: '',
  }),
  feedback: Object.freeze({
    toolId: 'feedback',
    routeSegment: 'feedback',
    listLabel: '反馈列表',
    itemLabel: '反馈',
    itemNameLabel: '反馈标题',
    submitLabel: '提交反馈',
    countLabel: '条反馈',
    itemsKey: 'feedbacks',
    legacyItemsKey: 'feedbacks',
    itemIdKey: 'feedbackId',
    directDetailType: 'feedback-detail',
    directCommentType: 'feedback-comment',
    unnamedTitle: '未命名反馈',
    noIdText: '无反馈ID',
    loadingText: '正在准备反馈列表',
    idleText: '点击反馈列表后会准备项目对应的多维表格。',
    missingTargetText: '目标反馈不存在或没有权限查看',
    detailAriaLabel: '反馈详情',
    missingTemplatePrefix: '找不到反馈模板',
    missingNodeText: '找不到项目反馈表',
    notLinkedText: '反馈列表没有关联多维表格',
    noTableText: '反馈列表没有可读取的数据表',
    missingRecordText: '反馈记录不存在',
    supportsPriority: false,
    supportsUnassignedRouting: false,
    dateLabel: '反馈时间',
    channelValue: '内部开发平台',
    processingStatuses: Object.freeze([]),
    acceptanceStatus: '',
  }),
});

export function getWorkItemToolDefinition(toolId, fallbackToolId = 'requirements') {
  const normalizedToolId = String(toolId || '').trim();
  return WORK_ITEM_TOOL_DEFINITIONS[normalizedToolId]
    || WORK_ITEM_TOOL_DEFINITIONS[fallbackToolId]
    || WORK_ITEM_TOOL_DEFINITIONS.requirements;
}

export function getWorkItemProcessingStatuses(toolId) {
  const definition = getWorkItemToolDefinition(toolId);
  return [...(definition.processingStatuses || [])];
}

export function getWorkItemAcceptanceStatus(toolId) {
  return String(getWorkItemToolDefinition(toolId).acceptanceStatus || '').trim();
}

export function getWorkItemWaitingStatus(toolId) {
  const normalizedToolId = String(toolId || '').trim();
  if (normalizedToolId === 'bugs') {
    return '未处理';
  }
  if (normalizedToolId === 'feedback') {
    return FEEDBACK_STATUSES.waiting;
  }
  if (normalizedToolId === 'testTasks') {
    return '待测试';
  }
  return '待处理';
}
