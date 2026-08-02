---
name: igp-test-release
description: Verify, package, version, document, and publish changes to the IGP Development Platform. Use for test planning, regression checks, production builds, secret-exposure checks, UploadLog updates, version bumps, release commits, branch pushes, or diagnosing CI and packaging failures.
---

# IGP Test And Release

## Verification Order

Read `AGENTS.md`, inspect `package.json`, and run targeted checks while editing.
Before release run:

```powershell
npm run verify
git diff --check
```

`npm run verify` runs Node tests, the production package build, upload-log
validation, and secret-exposure validation. Root Node tests also invoke the
independent `public-entry-gateway` test suite.

Use `npm run build` after server module layout or packaging changes. Confirm the
complete backend module tree exists under `Publish/server/`. Never display or
commit `Publish/config.json`.
Confirm the embedded Gateway package exists under
`Publish/public-entry-gateway/`, while its standalone build remains under
`public-entry-gateway/Publish/` with bundled Node and start/stop BAT files.

After runtime-affecting changes, keep the developer-side LAN tool running and run:

```powershell
npm run deploy:debug
```

Treat a failed target upload, activation, startup, version check, health check,
homepage check, or startup-log check as unfinished work unless the user explicitly
waives remote verification. Use `--status`, `--logs stderr`, and `--logs client`
for diagnosis. This debug deployment does not replace `log-change`.

For deployment-tool changes also run:

```powershell
npm run deploy-tool:test
npm run deploy-tool:build
npm --prefix deployment-tool run smoke:e2e
```

Managed target services must execute the fixed target-owned
`managed-runtime/runtime/node.exe` path. Deployment-tool tests must verify that
different release runtimes update that file without changing its path, interrupted
runtime replacement recovers, and the spawned Windows process does not execute the
release-local Node copy. Also cover bounded process inspection and preservation of
the recorded PID when WMI times out. Cover pre-upload release-slot reservation,
startup cleanup of interrupted artifacts, and failed-upload removal without pruning
the current or rollback release.

## Tests

- Shared work-item rules: `test/workItemDefinitions.test.js`,
  `test/workItemAssignmentUtils.test.js`,
  `test/requirementSubmissionAttachmentUtils.test.js`.
- Overview: `test/projectOverviewUtils.test.js`.
- Frontend cache/list/fields: `test/localCacheAndUpdateManifest.test.js`,
  `test/workItemListUtils.test.js`, `test/workItemFieldUtils.test.js`,
  `test/projectOverviewDisplayUtils.test.js`,
  `test/workItemTimelineUtils.test.js`, and
  `test/projectToolDisplayUtils.test.js`. Keep coverage for the always-visible,
  disabled `builds` and `review` development placeholders.
- Frontend module binding regression: `test/frontendModuleBindings.test.js`.
- Test-task JSON, permissions, transitions, feedback retries, and service behavior:
  `test/testTaskUtils.test.js` and `test/testTaskService.test.js`.
- Feedback classification statuses, association JSON, schema migration, list
  grouping, and frontend route bindings:
  `test/feedbackResolutionUtils.test.js`,
  `test/workItemRelationSchemaService.test.js`,
  `test/workItemStatusSchemaService.test.js`,
  `test/workItemListUtils.test.js`, and
  `test/frontendModuleBindings.test.js`.
- Client runtime diagnostics and redaction: `test/clientErrorUtils.test.js`.
- Frontend request timeout and global operation activity:
  `test/apiClient.test.js`.
- Shared authentication-expiration contracts and reauthorization navigation:
  `test/authenticationErrorUtils.test.js`.
- Feishu H5 code-only login API selection:
  `test/feishuH5.test.js`.
- Backend config/runtime/integrations: `test/serverConfig.test.js`,
  `test/serverRuntime.test.js`, `test/configEditor.test.js`,
  `test/wikiClient.test.js`, and `test/feishuAssistant.test.js`.
- Personal settings and reminder scheduling:
  `test/personalSettingsUtils.test.js`,
  `test/personalSettingsService.test.js`.
- MCP authentication, twelve-tool transport/dispatch, mutation idempotency,
  AI-plan filtering, and client configuration:
  `test/developmentPlatformMcpServer.test.js`,
  `test/developmentPlatformMcpService.test.js`,
  `test/idempotentMutation.test.js`,
  `test/mcpAiPlanService.test.js`, and
  `test/mcpConfigUtils.test.js`.
- Version contracts and workflows: `test/versionManagementUtils.test.js`,
  `test/versionManagementService.test.js`,
  `test/versionManagementDisplayUtils.test.js`.
- AI persistence, ownership, scheduling, structured output, and realtime:
  `test/aiPlanning.test.js`; Codex JSON-RPC and key isolation:
  `test/codexAppServerClient.test.js`. Keep coverage for the authenticated
  loopback Responses bridge, upstream key replacement, proxy isolation, and SSE
  streaming, plus legacy run-schema
  migration, monotonic progress persistence, owner-only progress snapshots,
  safe item-event mapping, inactivity UI text, persistent failure details,
  durable question/answer continuation, restart preservation, attachment cleanup,
  notification outbox idempotency, and the required response/interruption ordering
  for `item/tool/requestUserInput`. Verify that a valid first-turn plan is accepted
  without a confirmation question, while material unresolved decisions can still
  persist a bounded question set and continue in the same thread after answers.
  Verify project `preludePrompt` input ordering and that same-thread continuations
  do not resend it. Cover one same-thread retry for recoverable Codex stream
  disconnects using a concise continuation, reduced reasoning effort, the plan
  output schema, and no repeated prelude or attachment inputs. Also cover legacy shared-plan
  migration, immutable revision
  chains, pending/approved uniqueness, reviewer edits, rejection reasons,
  full-chain deletion and notification cleanup, notification dedupe counts,
  idempotent post-submit conversation creation, and MCP external submission
  revision/idempotency behavior without exposing internal mutation metadata.
- Same-user settings mutation serialization is covered by
  `test/serverRuntime.test.js`; non-blocking frontend initialization is covered by
  `test/frontendModuleBindings.test.js`.
- Public-entry Agent IP/CIDR decisions, health freshness, reverse tunnel arguments,
  maintenance handling, ordinary-browser redirects, Feishu OAuth state/callback
  handling, required authorization scope, callback source marker, self-contained
  403/503 status-page guidance, and HTTP responses are covered by
  `public-entry-gateway/test/gateway.test.js`. Managed package replacement,
  target-owned state, verified stops, and maintenance markers are covered by
  `test/publicEntryGatewayService.test.js`.

Add focused Node tests for pure behavior. Use browser verification for visible UI
changes and local API smoke tests for route changes.

For version management, cover active-slot replacement/rollback, provisioning
concurrency, completed-only associations, reference cycles/deletion, overview
read-only behavior, defensive frontend normalization, and direct/realtime bindings.

Production packages must contain `runtime/node.exe`, the bundled npm runtime,
the dependency lock stamp, and the packaged planning Skill. Do not preinstall
application `node_modules` during packaging. `StartWebBackend.bat` must run the
bundled dependency installer, which uses `npm ci --omit=dev` and downloads the
locked Express and Codex production dependencies only when missing or stale.
Keep npm attached to the visible startup console with native progress enabled and
HTTP fetch status output so first-launch downloads never look stalled.
Portable backend start/stop must use the packaged verified PID controller; smoke
tests must never rely on scanning a port and terminating whichever process owns it.
Production packages must also contain `ConfigureWebBackend.bat`,
`StopConfigureWebBackend.bat`, `config-editor/`, `config.example.json`, and the
config editor start/stop helpers and folder picker under `server/config/`. The
config editor must start before dependencies are installed and must not create
`node_modules`.
Verify that the packaged launchers keep portable config local but switch managed
releases to the target-owned state config and stable Node runtime while serving
assets from the active release.
The packaged `config.example.json` must retain the enabled AI project `50` preset
with root ID `main`, path `D:\DevelopmentPlatformProject`, and profile `auto`.
Use `scripts/smoke-portable.ps1` to copy `Publish` to a temporary relocated path,
verify that dependencies are initially absent, exercise the token-protected config
editor without exposing an existing secret or installing dependencies, then
install dependencies through the bundled npm runtime, start with a generated
non-secret config, and verify `/api/health`.

## Release Log

After implementation and verification are complete, run exactly once:

```powershell
npm run log-change -- "变动说明"
```

This increments `package.json` and `package-lock.json` and appends the dated release
entry to `UploadLog.md`. Do not manually duplicate the entry. Re-run
`npm run verify` after the version/log update.

Commit the implementation, tests, generated version, and upload log. Push the
feature branch and any required main checkpoint without force-pushing or rewriting
unrelated history.
