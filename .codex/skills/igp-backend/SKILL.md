---
name: igp-backend
description: Maintain the IGP Express backend, runtime configuration, sessions, realtime SSE, update service, and Feishu, Bitable, and Wiki integrations. Use for requests that change server routes, API behavior, permissions, Feishu calls, caches, config defaults, backend module boundaries, or production packaging.
---

# IGP Backend

## Start

Read `AGENTS.md`, then locate the owning layer.

- Route and workflow orchestration: `server/index.js`.
- Config defaults: `server/config/normalizeConfig.js`.
- Config discovery/validation: `server/config/runtimeConfig.js`.
- Portable runtime configuration editor:
  `server/config/configEditorServer.js`,
  `server/config/configEditorStore.js`, and
  `server/config/configEditorUtils.js`.
- Feishu auth and generic requests: `server/integrations/feishuClient.js`.
- Bitable CRUD and caches: `server/integrations/bitableClient.js`.
- Wiki nodes and copy tasks: `server/integrations/wikiClient.js`.
- Sessions, SSE, cache primitives, and client error logging: `server/runtime/`.
- Update manifest fetch: `server/services/updateService.js`.
- Personal settings Bitable workflow:
  `server/services/personalSettingsService.js`.
- Version management provisioning and mutations:
  `server/services/versionManagementService.js`.
- Codex read-only planning: `server/integrations/codexAppServerClient.js`,
  `server/services/aiPlanningService.js`,
  `server/repositories/aiPlanningRepository.js`, and
  `server/runtime/aiDataPaths.js`.
- AI run attachments and temporary roots:
  `server/services/aiRunContextService.js`.
- AI Feishu delivery and durable retries:
  `server/integrations/feishuMessageClient.js` and
  `server/services/aiPlanningNotificationService.js`.
- Daily reminder timing: `server/services/todoNotificationScheduler.js`;
  reminder orchestration and cards remain in `server/index.js`.

## Rules

- Preserve existing route paths, methods, request payloads, response payloads,
  status codes, cookies, and SSE event shape unless the request explicitly changes
  the contract.
- Keep HTTP details and integration-specific caches under `server/integrations/`.
- Keep process-local infrastructure state under `server/runtime/`.
- Keep config normalization pure and test it without reading runtime secrets.
- Apply project/tool permission checks before accessing work-item data.
- Do not expose `appSecret`, tenant/user tokens, or runtime config values.
- Keep `/api/client-errors` available before authentication and rate-limited so
  startup failures can be diagnosed without allowing log flooding. Normalize
  reports through `shared/clientErrorUtils.js`, log them with the `[client-error]`
  prefix, append sanitized JSONL entries to `logs/client-errors.log` in development
  or `Publish/logs/client-errors.log` in production, and retain one 10 MB rotated
  backup. File-write failures must not change the endpoint response. Never persist
  request bodies or identity details beyond the sanitized diagnostic fields.
- Honor `IGP_CONFIG_PATH` and `IGP_CLIENT_ERROR_LOG_PATH` for managed deployments
  while preserving existing development and portable-package path fallbacks.
- When adding server modules, keep `scripts/build.ps1` copying the complete
  `server/` tree.
- Keep the portable package lightweight: bundle Node and npm, but install locked
  production dependencies on first launch through `EnsureDependencies.ps1`.
  Keep first-launch npm progress and network fetch status visible in the startup
  console.
- Keep `ConfigureWebBackend.bat` independent from application `node_modules`.
  The editor must bind only to `127.0.0.1`, require its random session token,
  validate write origins, redact existing `feishu.appSecret` and Codex API keys,
  preserve unknown config keys, detect revision conflicts, and save through a
  backup-and-rollback transaction.
- Stop the portable configuration editor through
  `StopConfigureWebBackend.bat` and its token-authenticated loopback shutdown
  helper. Do not stop arbitrary processes by scanning ports.
- Prefer `getCachedValue` for shared promise-aware TTL cache behavior.
- Resolve personal settings through the configured Wiki node token, validate the
  exact `用户`, `接收待办事项通知`, and `待办事项通知时间` fields, and reject
  duplicate records for the same user.
- Keep reminder scheduling minute-aligned at second five. Do not add startup
  catch-up behavior or send more than once per user and Shanghai calendar day.
- Settings routes are `GET /api/me/settings` and `PUT /api/me/settings`; require a
  session and retain the `{ notifications: ... }` contract.
- `POST /api/me/settings/ensure` creates a missing user record with notifications
  disabled and the configured default time. Existing records must remain
  unchanged.
- Serialize ensure and save operations for the same Open ID through
  `server/runtime/keyedTaskQueue.js` so concurrent app tabs cannot create
  duplicates; different users must remain concurrent.
- Keep version APIs under `/api/projects/:projectId/versions`. All project members
  may ensure/read/comment; require global or development super-admin access for
  create/edit/status/delete.
- Provision a project version Bitable from the configured Wiki template only when
  Version Management is opened. Project overview must call the read-only version
  overview path and never provision it.
- Serialize version mutations by project. For active-slot replacement, move the
  current occupant to `过时`, write the target, and restore the occupant's exact
  status/history only if the target write fails.
- Publish version changes through the existing SSE hub with `toolId: 'versions'`.
- Treat malformed version status/comment JSON as a conflict and do not overwrite it.
- Store private AI conversations and shared plan revisions under the fixed
  `D:\DevelopmentPlatformDB` root. Another user's conversation must resolve as
  not found even for administrators.
- Persist question sets, answers, attachment summaries, and notification outbox
  entries. Preserve pending questions across restart while interrupting only
  queued/running work.
- Run Codex with `read-only`, no approvals, and no tool network access. Keep the
  API key out of generated Codex config, browser payloads, logs, errors, and shell
  tool environments.
- Handle `item/tool/requestUserInput` as a bounded one-to-three-question decision
  request. Persist it before returning a protocol response, interrupt the current
  turn, release scheduler capacity, and continue the same thread after the owner
  answers.
- Include configured work-item and requirement-submission attachments through an
  isolated per-run directory. Images may be local-image inputs; supported text and
  office documents must be normalized for read-only inspection. Skip failures with
  a safe summary, and remove temporary content after every terminal or waiting
  outcome.
- Send durable Feishu cards only for required answers, completed drafts, and
  failures. Notifications target the conversation owner, use exact deep links, and
  never affect the run result.
- Read completed Codex agent output from `item/completed`; use
  `item/agentMessage/delta` only as a bounded fallback and treat
  `turn/completed` as the terminal status signal.
- Persist AI run progress on the `runs` row using the monotonic
  `queued`, `starting`, `preparing`, `analyzing`, `composing`, and
  `completed` stages. Map only safe `item/started` and `item/completed`
  activity labels; never persist or publish commands, absolute paths, item
  payloads, or reasoning text. Progress-write failures must not fail a Codex run.
- Publish owner-only conversation snapshots after progress changes. Browser
  payloads may include the safe stage, message, update time, and activity count,
  while terminal failures retain a sanitized error code/message and timestamps.
- Default AI planning to enabled with model `gpt-5.6-sol`. Missing Codex credentials or
  project roots must not block general backend startup; validate them before
  creating or running AI conversations and shared-plan operations.
- Return only a non-sensitive AI unavailable reason for requirement/Bug projects
  that the current user can access. A missing model connection or project mapping
  must not be represented as an enabled AI action.
- Validate the existing portable config when the editor loads and return field
  paths/messages without returning secret values. Missing AI project mappings must
  remain visible before the user attempts another save.
- Remove Codex thread, turn, run, and conversation-owner identifiers from browser
  payloads. Redact configured absolute project roots from generated text and
  submitted Markdown before persistence or sharing.
- Derive `aiPlans` visibility from requirement/Bug access plus configured project
  roots; do not add it to the Feishu department tool matrix.

## Validate

Run syntax checks for changed modules, then:

```powershell
npm test
npm run build
git diff --check
```

When route behavior changes, run a local debug-session API smoke test without
printing secrets.
