import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;
const FRONTEND_MODULES = [
  'config-editor/main.jsx',
  'src/api/aiConversations.js',
  'src/api/aiPlans.js',
  'src/api/clientErrors.js',
  'src/api/authenticationState.js',
  'src/api/testTasks.js',
  'src/ui/App.jsx',
  'src/ui/AppErrorBoundary.jsx',
  'src/ui/GlobalOperationOverlay.jsx',
  'src/ui/SessionExpiredOverlay.jsx',
  'src/ui/authNavigation.js',
  'src/ui/pageInteractionLock.js',
  'src/ui/ai/AiPlanLibrary.jsx',
  'src/ui/ai/AiPlanningWorkspace.jsx',
  'src/ui/ProjectOverview.jsx',
  'src/ui/projectOverviewDisplayUtils.js',
  'src/ui/test-tasks/TestTaskManagement.jsx',
  'src/ui/versions/VersionManagement.jsx',
  'src/ui/versions/versionManagementDisplayUtils.js',
  'src/ui/workspace/PlatformWorkspace.jsx',
  'src/ui/workspace/ProjectNavigation.jsx',
  'src/ui/workspace/projectToolDisplayUtils.js',
  'src/ui/workspace/projectToolIcons.js',
  'src/ui/work-items/WorkItemTimeline.jsx',
  'src/ui/work-items/WorkItemTimelinePanel.jsx',
  'src/ui/work-items/workItemFieldUtils.js',
  'src/ui/work-items/workItemTimelineUtils.js',
  'src/ui/settings/PersonalSettingsDialog.jsx',
  'src/ui/settings/mcpConfigUtils.js',
  'src/integrations/feishuH5.js',
];
const BROWSER_GLOBALS = new Set([
  'Array',
  'Blob',
  'Boolean',
  'CSS',
  'Date',
  'Error',
  'EventSource',
  'File',
  'FormData',
  'Infinity',
  'Intl',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'ResizeObserver',
  'Set',
  'String',
  'URL',
  'URLSearchParams',
  'clearTimeout',
  'console',
  'document',
  'encodeURIComponent',
  'fetch',
  'navigator',
  'clearInterval',
  'setTimeout',
  'setInterval',
  'structuredClone',
  'undefined',
  'window',
]);

for (const file of FRONTEND_MODULES) {
  test(`${file} has no unbound runtime identifiers`, () => {
    const source = fs.readFileSync(file, 'utf8');
    const ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx'],
    });
    const unresolved = [];

    traverse(ast, {
      ReferencedIdentifier(path) {
        const name = path.node.name;
        if (!path.scope.hasBinding(name) && !BROWSER_GLOBALS.has(name)) {
          unresolved.push(`${name}:${path.node.loc?.start.line || 0}`);
        }
      },
    });

    assert.deepEqual(unresolved, []);
  });
}

test('work item timeline keeps React Chrono custom card content visible', () => {
  const source = fs.readFileSync('src/ui/work-items/WorkItemTimeline.jsx', 'utf8');

  assert.match(source, /compactText:\s*false/);
  assert.doesNotMatch(source, /compactText:\s*true/);
});

test('work item timeline overrides React Chrono card minimum widths', () => {
  const desktopStyles = fs.readFileSync('src/styles/workItems.css', 'utf8');
  const responsiveStyles = fs.readFileSync('src/styles/responsive.css', 'utf8');

  assert.match(
    desktopStyles,
    /\.work-item-timeline-chrono \.timeline-card-content\s*\{[^}]*min-width:\s*216px\s*!important;/s,
  );
  assert.match(
    responsiveStyles,
    /\.work-item-timeline-chrono \.timeline-card-content\s*\{[^}]*min-width:\s*202px\s*!important;/s,
  );
});

test('editable text keeps a visible selection highlight in embedded browsers', () => {
  const baseStyles = fs.readFileSync('src/styles/base.css', 'utf8');

  assert.match(
    baseStyles,
    /input::selection,\s*textarea::selection,\s*\[contenteditable="true"\]::selection,\s*\.allow-text-select::selection\s*\{[^}]*color:\s*#ffffff;[^}]*background-color:\s*#1677ff;[^}]*text-shadow:\s*none;/s,
  );
});

test('app initializes personal settings without awaiting workspace startup', () => {
  const source = fs.readFileSync('src/ui/App.jsx', 'utf8');

  assert.match(source, /ensurePersonalSettingsRecord\(\)\.catch\(\(\) =>/);
  assert.doesNotMatch(source, /await\s+ensurePersonalSettingsRecord\(\)/);
});

test('global operation overlay blocks the application above every existing dialog layer', () => {
  const mainSource = fs.readFileSync('src/main.jsx', 'utf8');
  const overlaySource = fs.readFileSync('src/ui/GlobalOperationOverlay.jsx', 'utf8');
  const pageLockSource = fs.readFileSync('src/ui/pageInteractionLock.js', 'utf8');
  const baseStyles = fs.readFileSync('src/styles/base.css', 'utf8');

  assert.match(mainSource, /<GlobalOperationOverlay\s*\/>/);
  assert.match(overlaySource, /createPortal\([\s\S]*document\.body/);
  assert.match(overlaySource, /acquirePageInteractionLock/);
  assert.match(overlaySource, /OVERLAY_EXIT_DURATION_MS\s*=\s*180/);
  assert.match(overlaySource, /requestAnimationFrame/);
  assert.match(overlaySource, /setShouldRender\(false\)/);
  assert.match(overlaySource, /isVisible \? 'is-visible' : 'is-exiting'/);
  assert.match(pageLockSource, /setAttribute\('inert',\s*''\)/);
  assert.match(overlaySource, /<strong>操作中<\/strong>/);
  assert.match(
    baseStyles,
    /\.global-operation-backdrop\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*2147483646;[^}]*background:\s*rgb\(0 0 0 \/ 68%\);/s,
  );
  assert.match(baseStyles, /\.global-operation-backdrop\.is-visible\s*\{[^}]*opacity:\s*1;/s);
  assert.match(
    baseStyles,
    /\.global-operation-indicator\s*\{[^}]*transform:\s*translateY\(10px\) scale\(0\.96\);[^}]*transition:/s,
  );
});

test('expired sessions render an uncloseable top-level Feishu reauthorization prompt', () => {
  const mainSource = fs.readFileSync('src/main.jsx', 'utf8');
  const overlaySource = fs.readFileSync('src/ui/SessionExpiredOverlay.jsx', 'utf8');
  const navigationSource = fs.readFileSync('src/ui/authNavigation.js', 'utf8');
  const baseStyles = fs.readFileSync('src/styles/base.css', 'utf8');

  assert.match(mainSource, /<SessionExpiredOverlay\s*\/>/);
  assert.match(overlaySource, /<h2 id="session-expired-title">登录信息已失效<\/h2>/);
  assert.match(overlaySource, /刷新并重新登录/);
  assert.match(overlaySource, /acquirePageInteractionLock/);
  assert.doesNotMatch(overlaySource, /onClose|onMouseDown|Escape/);
  assert.match(navigationSource, /searchParams\.set\('forceAuth',\s*'1'\)/);
  assert.match(navigationSource, /window\.location\.replace/);
  assert.match(
    baseStyles,
    /\.session-expired-backdrop\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*2147483647;[^}]*background:\s*rgb\(0 0 0 \/ 74%\);/s,
  );
});

test('Feishu SDK loading and authorization callbacks have bounded waits', () => {
  const source = fs.readFileSync('src/integrations/feishuH5.js', 'utf8');

  assert.match(source, /FEISHU_SDK_LOAD_TIMEOUT_MS\s*=\s*8000/);
  assert.match(source, /FEISHU_AUTH_REQUEST_TIMEOUT_MS\s*=\s*15_000/);
  assert.match(source, /飞书授权超时，请重新打开应用后重试/);
});

test('personal settings exposes token generation and copyable MCP client configs', () => {
  const apiSource = fs.readFileSync('src/api/personalSettings.js', 'utf8');
  const dialogSource = fs.readFileSync('src/ui/settings/PersonalSettingsDialog.jsx', 'utf8');
  const configSource = fs.readFileSync('src/ui/settings/mcpConfigUtils.js', 'utf8');

  assert.match(apiSource, /\/api\/me\/settings\/token\/regenerate/);
  assert.match(dialogSource, /regenerateDevelopmentPlatformToken/);
  assert.match(dialogSource, /developmentPlatformToken/);
  assert.match(dialogSource, /navigator\.clipboard/);
  assert.match(dialogSource, /normalized\.developmentPlatformToken \? 'notifications' : 'mcp'/);
  assert.match(dialogSource, /<span>MCP<\/span>/);
  assert.match(dialogSource, /function McpSettings/);
  assert.match(configSource, /Codex/);
  assert.match(configSource, /Claude Code/);
  assert.match(configSource, /Cursor/);
  assert.match(configSource, /Gemini CLI/);
  assert.match(configSource, /VS Code/);
});

test('version management renders a local snapshot before refreshing it', () => {
  const versionSource = fs.readFileSync('src/ui/versions/VersionManagement.jsx', 'utf8');
  const workspaceSource = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');

  assert.match(versionSource, /loadVersions\(\{\s*readCache:\s*true\s*\}\)/);
  assert.match(versionSource, /await\s+getCachedSnapshot\(snapshotKey\)/);
  assert.match(versionSource, /normalizeVersionManagementPayload\(cachedSnapshot\.value\)/);
  assert.match(versionSource, /saveCachedSnapshot\(cacheUserKey,\s*snapshotKey,\s*payload\)/s);
  assert.match(workspaceSource, /<VersionManagement[\s\S]*cacheUserKey=\{cacheUserKey\}/);
});

test('project tool navigation renders icons and pending work item badges', () => {
  const source = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');

  assert.match(source, /getProjectToolIcon\(tool\.iconKey\)/);
  assert.match(source, /project-tool-pending-badge/);
  assert.match(source, /isProjectToolPendingCountTool\(normalizedToolId\)/);
  assert.match(source, /disabled=\{isDevelopmentTool\}/);
  assert.match(source, /project-tool-development-status/);
  assert.match(source, /（\{tool\.statusText\}）/);
  assert.match(source, /tool\.id === 'testTasks'[\s\S]*\? '待办'[\s\S]*: '未处理'/);
  assert.match(source, /\{pendingCount\}\{pendingLabel\}/);
});

test('workspace removes a deleted realtime work item from state and local cache', () => {
  const source = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');

  assert.match(source, /payload\?\.changeType === 'deleted' \? 'deleted' : 'updated'/);
  assert.match(source, /realtimeEvent\.changeType === 'deleted'/);
  assert.match(source, /removeWorkItemFromState\(currentState, realtimeEvent\.recordId, toolConfig\)/);
  assert.match(source, /removeWorkItemByRecordId/);
});

test('new work item file selection accepts ordinary attachments while paste stays media-only', () => {
  const source = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');
  const submitDialogStart = source.indexOf('function WorkItemSubmitDialog');
  const editDialogStart = source.indexOf('function WorkItemEditDialog');
  const submitDialogSource = source.slice(submitDialogStart, editDialogStart);

  assert.ok(submitDialogStart >= 0);
  assert.ok(editDialogStart > submitDialogStart);
  assert.match(
    submitDialogSource,
    /function addAttachments\(files\)\s*\{\s*const nextFiles = Array\.from\(files \|\| \[\]\);/,
  );
  assert.doesNotMatch(submitDialogSource, /accept="image\/\*,video\/\*"/);
  assert.match(
    submitDialogSource,
    /function handleAttachmentPaste\(event\)[\s\S]*extractSupportedAttachmentsFromClipboard\(event\.clipboardData\)/,
  );
  assert.match(
    source,
    /function extractSupportedAttachmentsFromClipboard\(clipboardData\)\s*\{\s*return extractFilesFromClipboard\(clipboardData\)\.filter\(\(file\) => isPasteSupportedAttachment\(file\)\);/,
  );
});

test('work item status updates bind version association confirmation and idempotent retry', () => {
  const workspaceSource = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');
  const apiSource = fs.readFileSync('src/api/workItems.js', 'utf8');
  const serverSource = fs.readFileSync('server/index.js', 'utf8');
  const mcpSource = fs.readFileSync('server/mcp/developmentPlatformMcpServer.js', 'utf8');

  assert.match(apiSource, /createWorkItemClientMutationId/);
  assert.match(workspaceSource, /WorkItemVersionAssociationDialog/);
  assert.match(workspaceSource, /versionAssociationDecision/);
  assert.match(workspaceSource, /retryVersionAssociation/);
  assert.match(serverSource, /requireVersionAssociationDecision:\s*true/);
  assert.match(serverSource, /inspectWorkItemAssociations/);
  assert.match(serverSource, /applyStatusVersionAssociationDecision/);
  assert.match(mcpSource, /VERSION_ASSOCIATION_DECISION_SCHEMA/);
});

test('feedback resolution binds classification, traceability, and idempotent conversion', () => {
  const workspaceSource = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');
  const apiSource = fs.readFileSync('src/api/workItems.js', 'utf8');
  const serverSource = fs.readFileSync('server/index.js', 'utf8');

  assert.match(apiSource, /\/feedback\/\$\{encodeURIComponent\(recordId\)\}\/resolve/);
  assert.match(workspaceSource, /function FeedbackResolutionDialog/);
  assert.match(workspaceSource, /toolConfig\.toolId !== 'feedback'/);
  assert.match(workspaceSource, /record\.relatedItemParseError/);
  assert.match(workspaceSource, /record\.relatedFeedbackParseError/);
  assert.match(serverSource, /app\.post\('\/api\/projects\/:projectId\/feedback\/:recordId\/resolve'/);
  assert.match(serverSource, /buildFeedbackResolutionSourceMutationId/);
  assert.match(serverSource, /findWorkItemBySourceMutationId\([\s\S]*sourceMutationId,[\s\S]*fingerprint/);
  assert.match(serverSource, /\[feedbackConfig\.fieldNames\.relatedItem\]/);
  assert.match(serverSource, /relatedFeedback:\s*reverseLink/);
  assert.match(serverSource, /submitter:\s*proposers\[0\]/);
});

test('work item version association dialog escapes the sticky detail sidebar stacking context', () => {
  const workspaceSource = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');
  const dialogStart = workspaceSource.indexOf('function WorkItemVersionAssociationDialog');
  const attachmentsStart = workspaceSource.indexOf('function RequirementSubmissionAttachmentsPanel');
  const dialogSource = workspaceSource.slice(dialogStart, attachmentsStart);

  assert.ok(dialogStart >= 0);
  assert.ok(attachmentsStart > dialogStart);
  assert.match(workspaceSource, /import\s*\{\s*createPortal\s*\}\s*from\s*['"]react-dom['"]/);
  assert.match(
    dialogSource,
    /return createPortal\([\s\S]*workitem-version-confirm-backdrop[\s\S]*document\.body,\s*\);/,
  );
});

test('AI planning separates private conversations from shared submissions', () => {
  const workspaceSource = fs.readFileSync('src/ui/ai/AiPlanningWorkspace.jsx', 'utf8');
  const platformWorkspaceSource = fs.readFileSync(
    'src/ui/workspace/PlatformWorkspace.jsx',
    'utf8',
  );
  const librarySource = fs.readFileSync('src/ui/ai/AiPlanLibrary.jsx', 'utf8');
  const aiPlanApiSource = fs.readFileSync('src/api/aiPlans.js', 'utf8');
  const serverSource = fs.readFileSync('server/index.js', 'utf8');
  const buildSource = fs.readFileSync('scripts/build.ps1', 'utf8');
  const dependencyInstallerSource = fs.readFileSync(
    'scripts/ensure-publish-dependencies.ps1',
    'utf8',
  );
  const secretExposureSource = fs.readFileSync('scripts/check-secret-exposure.js', 'utf8');

  assert.match(workspaceSource, /这里的对话仅你可见/);
  assert.match(workspaceSource, /submitAiPlan/);
  assert.match(workspaceSource, /subscribeAiConversation/);
  assert.match(workspaceSource, /answerAiConversationQuestions/);
  assert.match(workspaceSource, /awaiting_user/);
  assert.match(workspaceSource, /提交答案并继续/);
  assert.match(workspaceSource, /setInterval\(\(\) =>/);
  assert.match(workspaceSource, /function AiRunProgress/);
  assert.match(workspaceSource, /暂未收到新的 Codex 活动，任务仍在等待模型响应/);
  assert.match(workspaceSource, /function AiRunFailure/);
  assert.match(workspaceSource, /Codex 返回格式错误/);
  assert.match(workspaceSource, /Codex 网络连接中断/);
  assert.match(platformWorkspaceSource, /directTarget\?\.type === 'ai-conversation'/);
  assert.match(platformWorkspaceSource, /directTarget\?\.type === 'ai-plan'/);
  assert.match(platformWorkspaceSource, /initialConversationId=\{aiDirectTarget\?\.conversationId/);
  assert.match(platformWorkspaceSource, /initialFocus=\{aiDirectTarget\?\.focus/);
  assert.match(platformWorkspaceSource, /前往 AI 生成计划/);
  assert.match(platformWorkspaceSource, /project\.departments\.includes\('研发'\)/);
  assert.match(platformWorkspaceSource, /autoCreateRequest=\{aiAutoCreateRequest\}/);
  assert.match(platformWorkspaceSource, /AI 计划未配置/);
  assert.match(platformWorkspaceSource, /aiPlanningUnavailableReason/);
  assert.match(librarySource, /getAiPlanRawUrl/);
  assert.match(librarySource, /approveAiPlan/);
  assert.match(librarySource, /rejectAiPlan/);
  assert.match(librarySource, /createAiPlanRevision/);
  assert.match(librarySource, /deleteAiPlan/);
  assert.match(librarySource, /setAiPlanApplied/);
  assert.match(librarySource, /permissions\.canSetApplied/);
  assert.match(librarySource, /AiPlanAppliedBadge/);
  assert.match(librarySource, /application_removed/);
  assert.match(librarySource, /permissions\.canDelete/);
  assert.match(librarySource, /全部修订记录/);
  assert.match(librarySource, /修订历史/);
  assert.match(librarySource, /function AiGenerationTaskPanel/);
  assert.match(librarySource, /生成任务/);
  assert.match(platformWorkspaceSource, /fetchAiProjectActivity/);
  assert.match(platformWorkspaceSource, /requirement-ai-status/);
  assert.match(platformWorkspaceSource, /AI 生成中/);
  assert.match(aiPlanApiSource, /\/ai-activity/);
  assert.match(aiPlanApiSource, /export function deleteAiPlan/);
  assert.match(aiPlanApiSource, /export function setAiPlanApplied/);
  assert.match(aiPlanApiSource, /\/applied/);
  assert.match(aiPlanApiSource, /method:\s*'DELETE'/);
  assert.match(serverSource, /app\.delete\('\/api\/projects\/:projectId\/ai-plans\/:submissionId'/);
  assert.match(serverSource, /app\.post\('\/api\/projects\/:projectId\/ai-plans\/:submissionId\/applied'/);
  assert.match(serverSource, /canSetApplied/);
  assert.match(serverSource, /app\.get\('\/api\/projects\/:projectId\/ai-activity'/);
  assert.match(serverSource, /只有原提交者、研发超级管理员或超级管理员可以删除方案/);
  assert.match(buildSource, /runtime\\node\.exe/);
  assert.match(buildSource, /runtime\\npm\\bin\\npm-cli\.js/);
  assert.match(buildSource, /title IGP Web Backend Setup/);
  assert.match(buildSource, /ConfigureWebBackend\.bat/);
  assert.match(buildSource, /StopConfigureWebBackend\.bat/);
  assert.match(buildSource, /--assets-root/);
  assert.match(buildSource, /\.\.\\\.\.\\state\\deployment\.json/);
  assert.match(buildSource, /config-editor\\index\.html/);
  assert.match(buildSource, /config\.example\.json/);
  assert.doesNotMatch(buildSource, /npm\.cmd ci --omit=dev/);
  assert.match(dependencyInstallerSource, /npm-cli\.js/);
  assert.match(dependencyInstallerSource, /'ci'/);
  assert.match(dependencyInstallerSource, /'--progress=true'/);
  assert.match(dependencyInstallerSource, /'--loglevel=http'/);
  assert.match(dependencyInstallerSource, /codex-win32-x64/);
  assert.match(dependencyInstallerSource, /@modelcontextprotocol\\server/);
  assert.match(dependencyInstallerSource, /@modelcontextprotocol\\node/);
  assert.match(dependencyInstallerSource, /zod\\package\.json/);
  assert.match(secretExposureSource, /config-editor/);
  assert.match(secretExposureSource, /Publish\/config-editor/);
});

test('AI planning configuration editor exposes attachment and notification controls', () => {
  const source = fs.readFileSync('config-editor/main.jsx', 'utf8');

  assert.match(source, /aiPlanning\.codex\.maxConcurrentRuns/);
  assert.match(source, /aiPlanning\.codex\.maxConcurrentRunsPerUser/);
  assert.match(source, /aiPlanning\.codex\.maxConcurrentRunsPerProject/);
  assert.match(source, /aiPlanning\.attachments\.enabled/);
  assert.match(source, /aiPlanning\.attachments\.maxFiles/);
  assert.match(source, /aiPlanning\.attachments\.maxTotalBytes/);
  assert.match(source, /aiPlanning\.attachments\.maxExtractedCharsTotal/);
  assert.match(source, /aiPlanning\.notifications\.enabled/);
  assert.match(source, /AI 前置提示词/);
  assert.match(source, /aiPlanning\.projects\.\$\{projectIndex\}\.preludePrompt/);
});
