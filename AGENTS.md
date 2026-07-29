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
- `igp-lan-deploy` for the Electron LAN deployment tool, remote service control,
  logs, Inspector tunneling, and required post-change target verification.

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
- `shared/aiPlanningDefinitions.js`: AI conversation, run-progress, question,
  message, and submitted-plan contracts.
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
- `src/ui/ai/AiPlanningWorkspace.jsx`: owner-private Codex conversation,
  question/answer workflow, attachment summary, progress, failure, and draft
  submission UI.
- `src/ui/ai/AiPlanLibrary.jsx`: project-shared submitted Markdown plan list.
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
- `server/config/configEditorServer.js`: loopback-only portable runtime
  configuration editor server.
- `server/config/configEditorStore.js` and `configEditorUtils.js`: secret-redacted
  config editing, validation, revision conflicts, backups, recovery, and
  transactional writes.
- `server/integrations/feishuClient.js`: Feishu auth, tenant token cache, and JSON API
  helpers.
- `server/integrations/bitableClient.js`: Bitable records/tables/fields CRUD and
  structure caches.
- `server/integrations/wikiClient.js`: Wiki node lookup, creation, copying, polling,
  and caches.
- `server/integrations/codexAppServerClient.js`: read-only Codex app-server
  lifecycle, progress, structured output, local images, user-input requests, and
  same-thread continuation.
- `server/integrations/codexApiBridge.js`: token-authenticated loopback Responses
  forwarding that keeps upstream credentials out of Codex and bypasses stale host
  proxy settings.
- `server/integrations/feishuMessageClient.js`: interactive Feishu message HTTP
  delivery.
- `server/runtime/`: async cache, sessions, SSE hub, network helpers, and sanitized
  client-error log entries. Browser runtime errors append to
  `logs/client-errors.log` in development and `Publish/logs/client-errors.log` in
  production, with one 10 MB rotated backup.
- `server/runtime/keyedTaskQueue.js`: serializes mutations for the same stable key
  while allowing unrelated users to proceed concurrently.
- `server/services/updateService.js`: remote update manifest retrieval.
- `server/services/personalSettingsService.js`: Wiki-backed personal settings
  schema validation, record lookup, creation, and updates.
- `server/mcp/developmentPlatformMcpServer.js`: authenticated stateless
  Streamable HTTP MCP transport, LAN Host/Origin checks, and protocol tool
  registration.
- `server/services/mcpAiPlanService.js`: current-assignee filtering, pagination,
  detail revalidation, and safe serialization for MCP AI plan reads.
- `server/services/versionManagementService.js`: Wiki template provisioning,
  version Bitable schema validation, project-keyed mutations, active-slot
  replacement/rollback, references, associations, status history, and comments.
- `server/repositories/aiPlanningRepository.js`: SQLite persistence for private
  conversations, runs, question sets, drafts, submissions, and notification
  outbox entries.
- `server/services/aiPlanningService.js`: AI state machine, scheduling, prompts,
  answer continuation, submissions, and owner-only realtime snapshots.
- `server/services/aiRunContextService.js`: temporary read-only project junctions,
  attachment download/conversion, limits, summaries, and cleanup.
- `server/services/aiPlanningNotificationService.js`: durable question, completion,
  and failure notification retries.
- `server/services/todoNotificationScheduler.js`: minute-aligned scheduled reminder
  execution.

Keep Feishu HTTP details in `server/integrations/`, process-local state in
`server/runtime/`, config behavior in `server/config/`, and route orchestration in
`server/index.js`.

Managed deployments may set `IGP_CONFIG_PATH` and
`IGP_CLIENT_ERROR_LOG_PATH` so target-specific configuration and browser diagnostics
remain outside replaceable release directories. Preserve the existing path fallback
when those variables are absent.

### LAN Deployment Tool

- `deployment-tool/`: independent Electron/Vite package used on both development
  and target computers. It must not add dependencies to the application package
  copied into `Publish`.
- `deployment-tool/src/main/core/`: target discovery, pinned TLS pairing, secure
  credentials, offline artifacts, chunked uploads, managed releases, process and
  log control, automation, and Node Inspector proxy.
- `deployment-tool/src/renderer/`: dense developer/target operator interfaces.
- `scripts/deploy-debug.js`: loopback-only Codex automation client used by
  `npm run deploy:debug`.
- Deployment-tool packages belong under `deployment-tool/Publish/`; never write
  them into the application's root `Publish/` directory.

The target agent runs outside managed releases. Deployment archives must exclude
`config.json`, logs, credentials, and automation state. Validate archive paths and
all hashes before activation; prepare offline dependencies before stopping the
service; restore the previous release when activation or remote checks fail.
Managed backend services run through the stable target-owned
`managed-runtime/runtime/node.exe`. Keep release-local `runtime/node.exe` as the
verified upgrade/rollback source, and replace the stable runtime transactionally
by hash only while the managed service is stopped.
Windows process inspection must use a bounded timeout. Preserve the recorded PID
and report the inspection failure when WMI does not respond; do not clear service
state or start a duplicate process.
Before accepting a deployment upload, reserve one retention slot by pruning only
unprotected old releases. Clean interrupted uploads and staging directories at
target startup, and abort failed client uploads without deleting the current or
rollback release.

## Domain Compatibility

- Requirements, Bugs, and feedback share route and field contracts through
  `shared/workItemDefinitions.js`; update frontend and backend consumers together.
- Requirement and Bug status fields include `待验收`. It is an active processing
  status: include it in processing totals and pending reminders, exclude it from
  completed version associations, and idempotently ensure it on templates and
  existing project tables.
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
  `接收待办事项通知`, `待办事项通知时间`, and `开发平台令牌`. Enabled
  notifications store the select value `允许`. The backend idempotently ensures
  the token text field, generates owner-visible `igp_` tokens on demand, and
  permits unrestricted regeneration; ordinary notification saves must never
  overwrite the stored token.
- After authentication becomes ready, the frontend silently ensures a personal
  settings record. Missing records are created with notifications disabled and
  the configured default time; initialization failures never block the workspace.
- Automatic settings creation, explicit saves, and token regeneration for the same
  user must run serially to prevent duplicate Bitable records. When settings opens
  without a token, the frontend selects the MCP section and asks the user to
  generate one instead of generating it automatically.
- MCP is served at `POST /mcp` through stateless Streamable HTTP. Every tool
  authenticates with `Authorization: Bearer <开发平台令牌>` before dispatch; the
  token is never a tool argument. Token lookup reads current personal-settings
  records on every request so regeneration invalidates the old token immediately.
- The initial MCP surface contains exactly `get_my_approved_ai_plans`. It returns
  only approved requirement/Bug plans whose current work-item assignee matches the
  authenticated user by Open ID, User ID, Union ID, or email. Never match by name,
  and recheck project/tool access plus current assignment for detail reads.
- MCP Host and Origin checks allow only loopback, local IPv4 addresses, and the
  machine hostname. Missing, malformed, duplicate, or invalid tokens return the
  same 401 challenge; failed authentication is limited per client address.
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
- Requirement and Bug AI planning is a private multi-turn workflow. Before the
  first plan draft, Codex must ask one bounded set of one to three meaningful
  confirmation questions and the owner must answer through the detail page. If
  Codex skips that first question set, retry once in the same thread; if it skips
  again, fail with `codex_protocol` and never persist the premature plan. After the
  required answer round, the same thread continues until it can automatically
  produce a complete plan draft; later questions are optional. The mandatory
  question turn uses at most medium reasoning and no final-plan output schema;
  after the user answers, plan generation returns to the configured reasoning
  effort.
- Recoverable Codex transport failures, including an incomplete response stream,
  receive one automatic retry in the same thread with reduced reasoning effort
  and a concise continuation prompt. Do not resend the project prelude prompt,
  attachments, or full work-item prompt when the interrupted turn was already
  created, and persist a terminal failure only if the retry also fails.
- Shared AI plan deletion removes the complete revision chain and its audit
  events. Only the original submitter, project `研发超级管理员`, or global
  `超级管理员` may delete it. Deleting an approved plan also removes it from MCP
  reads.
- Pending AI questions, answers, attachment summaries, and notification outbox
  entries must survive backend restarts. Restart recovery interrupts only queued or
  running work; it must preserve conversations waiting for user input.
- AI planning includes regular work-item attachments and requirement submission
  attachments within configured limits. Attachment content and download tokens are
  ephemeral and must never be persisted in conversations, browser payloads, logs,
  notifications, or submitted plans.
- Send AI planning Feishu cards only to the private conversation owner when
  questions require input, a plan is ready, or a run fails. Card links must target
  the exact conversation and focused UI section; notification failures never
  change the AI run result.

## Configuration And Secrets

- `config/config.json` and `Publish/config.json` contain runtime secrets. Never print,
  inspect in responses, commit, or copy their values into tests/docs.
- Use `config/config.example.json` for documented configuration changes.
- Keep the portable example's enabled AI project `50` mapped to
  `D:\DevelopmentPlatformProject` with root ID `main` and profile `auto`; the build
  copies this preset to `Publish/config.example.json`.
- AI planning defaults to enabled with Codex model `gpt-5.6-sol`; incomplete Codex
  credentials or project roots must not prevent the rest of the backend from
  starting, but AI endpoints still require complete validation.
- Send Codex Responses traffic through the backend-owned loopback API bridge.
  Bind only to `127.0.0.1`, authenticate with an ephemeral token, allow only the
  Responses endpoints, replace the bridge token with the upstream key server-side,
  stream responses without logging bodies, and prevent the Codex child from
  inheriting HTTP proxy variables.
- Every `aiPlanning.projects` entry includes an optional `preludePrompt`. Send that
  project-specific text as the first text input of a new Codex thread, before
  attachments and the generated work-item prompt; do not resend it when continuing
  the same thread after questions or later user messages.
- AI attachment analysis and owner notifications default to enabled. Keep file
  count, byte, extracted-character, and retention limits configurable through both
  `config.example.json` and the portable visual editor.
- When AI is globally enabled but a project lacks a runnable mapping, requirement
  and Bug details show a disabled AI status instead of silently hiding the action.
  The configuration editor validates existing files on load and must surface the
  missing project mapping next to the project controls.
- Personal settings configuration lives under `bitable.personalSettings`; keep the
  Wiki node token and exact table field names configurable.
- Version template configuration lives under `bitable.versionManagement`. The
  default Wiki template token is `UVqFwm4EIiBcoPkoz9JcOLNfnVg`; keep field names
  configurable and never add the `versions` tool to the department tool matrix.
- The browser may receive `appId` and debug identity only; never expose `appSecret`
  or access tokens.
- Personal settings may return the authenticated user's development-platform token
  and MCP configuration snippets that embed it. Do not log that token, include it
  in client diagnostics, or expose another user's token.
- Client error reports may include only sanitized messages/stacks, component stacks,
  page paths, browser identifiers, timestamps, and diagnostic IDs. Never attach
  form values, work-item payloads, tokens, or runtime configuration.
- `Publish/`, `.htybox/`, logs, and runtime config are generated/ignored artifacts.
- Deployment credentials are stored through Electron `safeStorage`; target state
  stores only token hashes. Inspector binds to target loopback and is reachable only
  through the authenticated tool tunnel. Never add a LAN-bound shell.
- Production packaging must copy the complete `server/` tree because the backend is
  modular.
- Portable packages include `ConfigureWebBackend.bat`,
  `StopConfigureWebBackend.bat`, a static configuration editor, and
  `config.example.json`. The configuration editor must run with the bundled Node
  runtime before application dependencies are installed, bind only to loopback,
  and never return existing secrets to the browser.
- When those configuration launchers run from a managed release, they must edit
  the target-owned `managed-runtime/state/config.json`, use
  `managed-runtime/runtime/node.exe`, and serve the editor assets from the current
  release. Portable packages continue to use their own root for both config and
  assets.

## Change Workflow

1. Inspect the owning module and matching tests before editing.
2. Prefer existing shared definitions and API clients over duplicated constants or
   direct HTTP calls.
3. Keep changes scoped; do not alter unrelated user work in a dirty worktree.
4. Add or update focused Node tests for pure utilities and workflow rules.
5. Run `npm test` and `npx vite build` during implementation.
6. For UI changes, run the local server and verify desktop/mobile behavior in a real
   browser.
7. After any runtime, UI, backend, shared-contract, configuration, or packaging
   change, run `npm run deploy:debug`. The developer tool must be running with a
   paired default target. A failed or unreachable remote deployment is a completion
   blocker unless the user explicitly waives target verification.
8. Diagnose remote failures with `npm run deploy:debug -- --status`,
   `npm run deploy:debug -- --logs stderr`, and
   `npm run deploy:debug -- --logs client`; service actions use
   `npm run deploy:debug -- --action <start|stop|restart|rollback>`.
9. Before release, run `npm run verify` and `git diff --check`.
10. Run `npm run log-change -- "变动说明"` exactly once for the completed release
   change; it increments `package.json`/`package-lock.json` and updates
   `UploadLog.md`.
11. Commit generated version/log changes with the implementation. Do not edit
   `UploadLog.md` manually unless repairing the release tooling itself.

`npm run deploy:debug` is a debug deployment and must not run `log-change` or edit
the repository. It builds the current tree, sends an offline package, starts the
target service, and verifies the running version, process, health endpoint, homepage,
and startup logs.

## Required Validation

```powershell
npm test
npx vite build
npm run deploy-tool:test
npm run deploy-tool:build
npm --prefix deployment-tool run smoke:e2e
npm run verify
npm run deploy:debug
git diff --check
```

Use `npm run build` when changing server module layout or packaging. Confirm the
expected subdirectories exist under `Publish/server/` without displaying
`Publish/config.json`.
