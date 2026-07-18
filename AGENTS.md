# IGP Development Platform Agent Guide

## Scope

This repository is a React/Vite frontend plus an Express backend for a Feishu-hosted
development platform. It manages projects and requirement, Bug, and feedback work
items stored in Feishu Bitable and Wiki.

Read this file before changing code. Also load the matching project skill under
`.codex/skills/`:

- `igp-frontend` for React, browser integration, local cache, and CSS.
- `igp-backend` for Express, runtime state, config, and Feishu clients.
- `igp-work-item-domain` for requirement/Bug/feedback fields and workflow rules.
- `igp-test-release` for verification, versioning, packaging, and release logs.

Update the relevant skill whenever module ownership, workflow rules, configuration,
or validation commands change.

## Architecture

### Shared contracts

- `shared/workItemDefinitions.js`: canonical project tool and work-item definitions.
- `shared/workItemAssignmentUtils.js`: assignment permissions and explicit
  unassigned routing.
- `shared/requirementSubmissionAttachmentUtils.js`: requirement delivery attachment
  rules and change descriptions.
- `shared/projectOverviewUtils.js`: overview aggregation, risk detection, and trends.
- `shared/versionManagementUtils.js`: version fields, JSON documents, active-slot
  uniqueness, association snapshots, previous-version validation, permissions, and
  overview projections.
- `shared/workItemRealtimeUtils.js`: client/server realtime item helpers.
- `shared/personalSettingsUtils.js`: personal notification time normalization,
  scheduled reminder matching, pending-item filtering, sorting, and summaries.
- `shared/clientErrorUtils.js`: runtime-neutral client error redaction, truncation,
  and diagnostic identifiers.
- `shared/updateManifest.js`: update manifest and semantic version handling.

Shared modules must remain runtime-neutral and importable from Node tests.

### Frontend

- `src/main.jsx`: React bootstrap, global runtime error reporting, and aggregate
  stylesheet import.
- `src/ui/App.jsx`: authentication shell, update checks, toolbar, and login states.
- `src/ui/settings/PersonalSettingsDialog.jsx`: personal settings modal and
  notification preferences.
- `src/ui/AppErrorBoundary.jsx`: root fallback for React render and effect errors.
- `src/ui/workspace/PlatformWorkspace.jsx`: project/work-item orchestration.
- `src/ui/workspace/ProjectNavigation.jsx`: project sidebar and home navigation.
- `src/ui/workspace/projectToolDisplayUtils.js`: defensive project-tool pending
  count normalization and badge eligibility.
- `src/ui/workspace/projectToolIcons.js`: project-tool `iconKey` to Lucide mapping
  with a generic fallback for stale definitions.
- `src/ui/ProjectOverview.jsx`: project overview dashboard.
- `src/ui/versions/VersionManagement.jsx`: version matrix, list/detail workflow,
  administrator mutations, status history, associations, and comments.
- `src/ui/versions/versionManagementDisplayUtils.js`: defensive version payload
  normalization, filtering, mutation merging, and active matrix projection.
- `src/ui/projectOverviewDisplayUtils.js`: defensive normalization for overview
  snapshots before rendering.
- `src/ui/work-items/workItemFieldUtils.js`: pure Bitable field, attachment, person,
  and formatting helpers.
- `src/ui/work-items/WorkItemTimelinePanel.jsx`: lazy timeline boundary that isolates
  loading and render failures from the work-item detail page.
- `src/ui/work-items/WorkItemTimeline.jsx`: React Chrono work-item history view.
- `src/ui/work-items/workItemTimelineUtils.js`: pure timeline event classification,
  ordering, filtering, pagination, and timestamp helpers.
- `src/ui/workItemListUtils.js`: pure list filtering, grouping, and sorting rules.
- `src/ui/localCache.js`: browser cache, drafts, snapshots, and preferences.
- `src/api/`: all frontend HTTP clients, including personal settings and sanitized
  client-error reporting. Version requests belong in `src/api/versions.js`.
  Do not add direct `fetch` calls to UI files.
- `src/integrations/feishuH5.js`: Feishu H5 SDK loading and authorization.
- `src/styles.css`: stylesheet aggregator. Keep imports in cascade order.
- `src/styles/`: base, overview, work-item, authentication, and responsive styles.

### Backend

- `server/index.js`: Express route registration and business orchestration. Keep
  route paths, payloads, status codes, and permission checks backward compatible.
- `server/config/normalizeConfig.js`: pure config schema normalization and defaults.
- `server/config/runtimeConfig.js`: config discovery, runtime paths, validation, and
  config-file access blocking.
- `server/integrations/feishuClient.js`: Feishu auth, tenant token cache, and JSON API
  helpers.
- `server/integrations/bitableClient.js`: Bitable records/tables/fields CRUD and
  structure caches.
- `server/integrations/wikiClient.js`: Wiki node lookup, creation, copying, polling,
  and caches.
- `server/runtime/`: async cache, sessions, SSE hub, network helpers, and sanitized
  client-error log entries. Browser runtime errors append to
  `logs/client-errors.log` in development and `Publish/logs/client-errors.log` in
  production, with one 10 MB rotated backup.
- `server/runtime/keyedTaskQueue.js`: serializes mutations for the same stable key
  while allowing unrelated users to proceed concurrently.
- `server/services/updateService.js`: remote update manifest retrieval.
- `server/services/personalSettingsService.js`: Wiki-backed personal settings
  schema validation, record lookup, creation, and updates.
- `server/services/versionManagementService.js`: Wiki template provisioning,
  version Bitable schema validation, project-keyed mutations, active-slot
  replacement/rollback, references, associations, status history, and comments.
- `server/services/todoNotificationScheduler.js`: minute-aligned scheduled reminder
  execution.

Keep Feishu HTTP details in `server/integrations/`, process-local state in
`server/runtime/`, config behavior in `server/config/`, and route orchestration in
`server/index.js`.

## Domain Compatibility

- Requirements, Bugs, and feedback share route and field contracts through
  `shared/workItemDefinitions.js`; update frontend and backend consumers together.
- Every project tool definition includes an `iconKey`; the project navigation maps
  it to a Lucide icon and uses a generic icon only for stale or unknown tool data.
- Explicit "不知道该由谁处理" routing is supported only for requirements and Bugs.
  It sends assignment cards to the project's `研发超级管理员`.
- `研发超级管理员` can assign requirement/Bug handlers but does not inherit all
  global super-admin capabilities.
- Requirement templates include `需要提交附件` and `提交附件`. Attachment-required
  requirements must preserve the status-update confirmation workflow.
- Work-item timelines derive creation, status, assignee, attachment, and comment
  events from existing normalized record data. They render as a horizontally
  scrollable oldest-to-newest track with one compact event card directly above
  each node. Assignee and attachment events use the stored system-comment
  prefixes; do not create a separate timeline field.
- Feedback stores normalized identity/contact data in `联系信息数据`.
- Personal settings use the Wiki-backed Bitable fields `用户`,
  `接收待办事项通知`, and `待办事项通知时间`. Enabled notifications store
  the select value `允许`.
- After authentication becomes ready, the frontend silently ensures a personal
  settings record. Missing records are created with notifications disabled and
  the configured default time; initialization failures never block the workspace.
- Automatic settings creation and explicit saves for the same user must run
  serially to prevent duplicate Bitable records.
- Daily pending notifications include assigned requirement, Bug, and feedback
  records whose statuses are not in the configured completed groups. Missing
  work-item tables count as empty; blocked and unset statuses remain pending.
- Project navigation pending badges count only work assigned to the current user in
  the tool's initial waiting status: `待处理` for requirements/feedback and
  `未处理` for Bugs.
- Notification checks run in `Asia/Shanghai` at second five of each minute, do not
  catch up after downtime, and send at most once per user and calendar day.
- Project overview reads existing work-item tables and must not create Wiki nodes or
  copy templates. Version overview is also read-only and reports an uninitialized
  state when the project version table does not exist.
- Realtime events use `projectId`, `toolId`, and `recordId`; preserve this payload.
- Version management is always visible to project members. Only global
  `超级管理员` and project `研发超级管理员` may create, edit, change status, or
  delete versions; all project members may view and comment.
- Per platform, `测试开发`, `测试发布`, and `正式发布` each have one active slot.
  Occupying a used slot automatically moves the previous version to `过时`; perform
  this under the project-keyed queue and restore the previous record if the target
  write fails.
- Version associations store snapshots of completed/closed requirements, Bugs, and
  feedback. Existing snapshots remain valid after a work item is reopened.
- Version Management stores its normalized read payload in a user/project-isolated
  IndexedDB snapshot, renders cached data first, refreshes in the background, and
  updates the snapshot after successful mutations.
- `上个版本` is manual and may cross platforms, but must not self-reference or form
  a cycle. Block deletion while another version references the target.
- Version association, previous-version, status-history, and comment text fields use
  versioned JSON. Surface malformed documents and never overwrite malformed status
  or comment history during a mutation.

## Configuration And Secrets

- `config/config.json` and `Publish/config.json` contain runtime secrets. Never print,
  inspect in responses, commit, or copy their values into tests/docs.
- Use `config/config.example.json` for documented configuration changes.
- Personal settings configuration lives under `bitable.personalSettings`; keep the
  Wiki node token and exact table field names configurable.
- Version template configuration lives under `bitable.versionManagement`. The
  default Wiki template token is `UVqFwm4EIiBcoPkoz9JcOLNfnVg`; keep field names
  configurable and never add the `versions` tool to the department tool matrix.
- The browser may receive `appId` and debug identity only; never expose `appSecret`
  or access tokens.
- Client error reports may include only sanitized messages/stacks, component stacks,
  page paths, browser identifiers, timestamps, and diagnostic IDs. Never attach
  form values, work-item payloads, tokens, or runtime configuration.
- `Publish/`, `.htybox/`, logs, and runtime config are generated/ignored artifacts.
- Production packaging must copy the complete `server/` tree because the backend is
  modular.

## Change Workflow

1. Inspect the owning module and matching tests before editing.
2. Prefer existing shared definitions and API clients over duplicated constants or
   direct HTTP calls.
3. Keep changes scoped; do not alter unrelated user work in a dirty worktree.
4. Add or update focused Node tests for pure utilities and workflow rules.
5. Run `npm test` and `npx vite build` during implementation.
6. For UI changes, run the local server and verify desktop/mobile behavior in a real
   browser.
7. Before release, run `npm run verify` and `git diff --check`.
8. Run `npm run log-change -- "变动说明"` exactly once for the completed release
   change; it increments `package.json`/`package-lock.json` and updates
   `UploadLog.md`.
9. Commit generated version/log changes with the implementation. Do not edit
   `UploadLog.md` manually unless repairing the release tooling itself.

## Required Validation

```powershell
npm test
npx vite build
npm run verify
git diff --check
```

Use `npm run build` when changing server module layout or packaging. Confirm the
expected subdirectories exist under `Publish/server/` without displaying
`Publish/config.json`.
