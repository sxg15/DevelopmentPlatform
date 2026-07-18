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
  `test/serverRuntime.test.js`, `test/wikiClient.test.js`.
- Personal settings and reminder scheduling:
  `test/personalSettingsUtils.test.js`.

Add focused Node tests for pure behavior. Use browser verification for visible UI
changes and local API smoke tests for route changes.

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
