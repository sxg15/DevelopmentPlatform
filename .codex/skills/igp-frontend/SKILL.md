---
name: igp-frontend
description: Maintain the IGP React/Vite frontend, including authentication shell, project navigation, project overview, work-item screens, frontend API clients, Feishu H5 authorization, local cache, and CSS. Use for requests that change files under src/, frontend behavior, browser workflows, responsive layout, or UI module boundaries.
---

# IGP Frontend

## Start

Read `AGENTS.md`, then inspect only the owning frontend modules.

- App startup or login: `src/main.jsx`, `src/ui/App.jsx`,
  `src/ui/AppErrorBoundary.jsx`, `src/api/auth.js`,
  `src/api/clientErrors.js`, `src/integrations/feishuH5.js`.
- Personal settings: `src/ui/settings/PersonalSettingsDialog.jsx`,
  `src/ui/settings/mcpConfigUtils.js`, `src/api/personalSettings.js`, and
  `src/styles/settings.css`.
- Project loading/navigation: `src/ui/workspace/PlatformWorkspace.jsx`,
  `src/ui/workspace/ProjectNavigation.jsx`,
  `src/ui/workspace/projectToolDisplayUtils.js`,
  `src/ui/workspace/projectToolIcons.js`, `src/api/projects.js`.
- Overview: `src/ui/ProjectOverview.jsx`, `src/api/overview.js`,
  `src/ui/projectOverviewDisplayUtils.js`, `shared/projectOverviewUtils.js`.
- Version management: `src/ui/versions/VersionManagement.jsx`,
  `src/ui/versions/versionManagementDisplayUtils.js`, `src/api/versions.js`,
  `src/styles/versionManagement.css`, `shared/versionManagementUtils.js`.
- AI planning: `src/ui/ai/AiPlanningWorkspace.jsx`,
  `src/ui/ai/AiPlanLibrary.jsx`, `src/api/aiConversations.js`,
  `src/api/aiPlans.js`, and `src/styles/aiPlanning.css`.
- Work items: `src/ui/workspace/PlatformWorkspace.jsx`,
  `src/ui/work-items/workItemFieldUtils.js`,
  `src/ui/work-items/WorkItemTimelinePanel.jsx`,
  `src/ui/work-items/WorkItemTimeline.jsx`,
  `src/ui/work-items/workItemTimelineUtils.js`,
  `src/ui/workItemListUtils.js`, `src/api/workItems.js`.
- Cache/drafts: `src/ui/localCache.js`.
- Styling: `src/styles.css` and `src/styles/`.

## Rules

- Put HTTP calls in `src/api/`; do not add direct `fetch` calls to React components.
- Keep the root error boundary and global runtime reporting active. Client reports
  must use `shared/clientErrorUtils.js` and must not include form values, work-item
  payloads, query strings, tokens, or runtime configuration.
- Normalize cached or remote overview payloads before rendering; do not trust old
  IndexedDB snapshots to retain the current schema.
- Isolate ECharts initialization, option updates, resize callbacks, and disposal so
  a chart failure cannot unmount the application.
- Keep Feishu SDK behavior in `src/integrations/`.
- Keep the settings dialog isolated from `App.jsx`; the app shell owns only open
  state, while loading and saving belong to the settings component and API client.
- When authentication becomes ready, call the personal-settings ensure endpoint
  without awaiting it. Swallow initialization failures so project loading and
  normal use remain available.
- Personal notification settings use
  `{ receiveTodoNotifications, todoNotificationTime }`, with `HH:mm` time values.
- Personal settings expose separate development-platform-token and MCP sections.
  Select MCP when the loaded token is missing and require an explicit token-create
  action there. The token section supports reveal, copy, and unrestricted
  regeneration. Token actions must preserve unsaved notification edits, and
  notification update requests must omit the token.
- MCP settings render backend-provided endpoint choices and copyable Codex,
  Claude Code, Cursor, Gemini CLI, and VS Code snippets. Snippets intentionally
  embed the current user's token and must update immediately after regeneration.
  Keep exact config generation in `mcpConfigUtils.js`, not in JSX.
- Reuse `shared/workItemDefinitions.js` instead of duplicating route segments,
  labels, statuses, or field contracts.
- Keep pure formatting/filtering logic outside JSX when it can be tested.
- Keep React Chrono lazy-loaded behind `WorkItemTimelinePanel`; a timeline load or
  render failure must not replace the work-item detail page.
- Keep work-item detail timelines horizontal on desktop and mobile. Present the
  currently loaded events from oldest to newest, show each compact event card
  directly above its corresponding node, and preserve horizontal scrolling
  instead of switching to a vertical layout at narrow widths.
- React Chrono must use `content.compactText: false` for these custom cards;
  enabling compact text maps to the library's low-density mode and hides custom
  event content.
- Override the custom timeline card's `width`, `min-width`, and `max-width`
  together. React Chrono supplies a 280px minimum width that otherwise makes
  adjacent compact cards overlap their fixed-width node columns.
- Load React Chrono's global stylesheet before project styles so local base and
  work-item rules retain cascade ownership.
- Preserve local snapshot and draft keys when changing workspace state.
- Render every project tool with its required shared `iconKey`; keep a generic
  Lucide fallback for stale cached tool definitions.
- Keep stylesheet import order: base, overview, work items, AI planning, auth, settings,
  responsive.
- Add component-specific CSS to the owning stylesheet; add cross-module responsive
  overrides to `responsive.css`.
- Maintain existing dense operational UI patterns and verify text does not truncate
  or overlap on desktop and mobile.
- Keep Version Management outside `PlatformWorkspace.jsx`. Render its per-platform
  active matrix, filterable list, details, associations, history, and comments in
  the owning component.
- Show create/edit/status/delete controls only when `canManageVersions` is true.
  Comments remain available to all project members.
- Support `version-detail` and `version-comment` direct targets plus realtime
  refresh events with `toolId: 'versions'`.
- Handle realtime work-item `changeType: 'deleted'` by removing the item from the
  loaded state and local snapshot, then recomputing pending counts.
- Normalize cached overview version data before rendering. An absent version table
  is a quiet uninitialized state, not an error and not a provisioning trigger.
- Version Management uses a user/project-isolated IndexedDB snapshot for its
  normalized payload. Render the snapshot first, refresh it in the background, and
  update the snapshot after successful version mutations.
- Keep work-item AI conversations private and scoped to the current user. Only
  explicitly submitted Markdown revisions appear in the project AI plan library.
- Stream conversation updates through the AI API module; do not create EventSource
  connections directly in workspace components.
- When a conversation is `awaiting_user`, render the persisted question set,
  support recommended choices plus custom/free-text answers, allow optional overall
  desired-effect context, disable the normal composer, and resume through the
  question-answer API with an idempotent client mutation ID.
- Show attachment processed/skipped totals and safe per-file reasons without
  exposing attachment tokens, temporary paths, or extracted content.
- Support `ai-conversation` direct targets with `conversationId` and
  `focus=questions|plan|failure`. Open the owning requirement/Bug detail first,
  then the private conversation and focused section; non-owners must receive the
  normal not-found behavior.
- While an AI run is active, show its persisted stage sequence, elapsed time,
  latest-activity age, and activity count without inventing a percentage. After
  45 seconds without new activity, state that the server task is still waiting
  for Codex and keep the stop action available.
- Render terminal AI failures as persistent details with the sanitized error
  message, human-readable error type, ending stage, timestamps, and duration.
  Do not duplicate the same terminal failure in the transient action-status row.
- Label an exhausted recoverable transport retry as `Codex 网络连接中断` instead
  of the generic Codex failure type.
- When AI is globally enabled but the selected requirement/Bug project is not
  runnable, show a disabled `AI 计划未配置` action with the server-provided
  non-sensitive reason instead of silently removing the action.
- After a user whose project role includes `研发` submits a requirement or Bug,
  offer `不了` and an emphasized `前往 AI 生成计划` action when AI planning is
  runnable. Opening it creates or selects an idempotent private conversation and
  prefills an unsent prompt; never start Codex until the user sends the prompt.
- The shared AI plan library supports `ai-plan` direct targets, status filters,
  original-work-item navigation, revision history, audit events, and
  Markdown download. Render approve/reject/edit controls from server permissions,
  require a rejection reason, and create a new revision for reviewer edits.
- Show the independent `已应用` marker in AI plan list and detail views. Only
  render its toggle when `permissions.canSetApplied` is true, keep it separate
  from review status, and show the persisted actor and time when applied.
- Poll the project-level AI activity summary instead of issuing per-work-item
  requests. Requirement/Bug rows show animated generation, pending-question, or
  existing-plan badges; the AI Plan navigation uses an `x待审核` badge; and the AI
  Plan page shows owner-private active tasks that open the exact conversation.
- Keep AI visuals vivid but operational: use cyan/teal with magenta and amber
  accents, reserve animation for active generation, and disable it under
  `prefers-reduced-motion`.
- Show shared-plan deletion only when the detail payload grants `canDelete`.
  Confirm that deletion removes the complete revision history and clear the
  selected detail before refreshing the list.
- Distinguish successful plan mutations from Feishu notification outcomes. State
  whether notification delivery is disabled, no reviewer exists, or no new outbox
  job was created instead of claiming a card was sent.

## Validate

Run:

```powershell
npm test
npx vite build
git diff --check
```

For visible UI changes, start `npm run dev` and inspect the affected workflow in a
browser at desktop and mobile widths.
