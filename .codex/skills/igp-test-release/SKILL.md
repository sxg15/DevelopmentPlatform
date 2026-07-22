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
validation, and secret-exposure validation.

Use `npm run build` after server module layout or packaging changes. Confirm the
complete backend module tree exists under `Publish/server/`. Never display or
commit `Publish/config.json`.

## Tests

- Shared work-item rules: `test/workItemDefinitions.test.js`,
  `test/workItemAssignmentUtils.test.js`,
  `test/requirementSubmissionAttachmentUtils.test.js`.
- Overview: `test/projectOverviewUtils.test.js`.
- Frontend cache/list/fields: `test/localCacheAndUpdateManifest.test.js`,
  `test/workItemListUtils.test.js`, `test/workItemFieldUtils.test.js`,
  `test/projectOverviewDisplayUtils.test.js`,
  `test/workItemTimelineUtils.test.js`.
- Frontend module binding regression: `test/frontendModuleBindings.test.js`.
- Client runtime diagnostics and redaction: `test/clientErrorUtils.test.js`.
- Backend config/runtime/integrations: `test/serverConfig.test.js`,
  `test/serverRuntime.test.js`, `test/configEditor.test.js`,
  `test/wikiClient.test.js`.
- Personal settings and reminder scheduling:
  `test/personalSettingsUtils.test.js`.
- Version contracts and workflows: `test/versionManagementUtils.test.js`,
  `test/versionManagementService.test.js`,
  `test/versionManagementDisplayUtils.test.js`.
- AI persistence, ownership, scheduling, structured output, and realtime:
  `test/aiPlanning.test.js`; Codex JSON-RPC and key isolation:
  `test/codexAppServerClient.test.js`.
- Same-user settings mutation serialization is covered by
  `test/serverRuntime.test.js`; non-blocking frontend initialization is covered by
  `test/frontendModuleBindings.test.js`.

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
Production packages must also contain `ConfigureWebBackend.bat`,
`StopConfigureWebBackend.bat`, `config-editor/`, `config.example.json`, and the
config editor start/stop helpers and folder picker under `server/config/`. The
config editor must start before dependencies are installed and must not create
`node_modules`.
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
