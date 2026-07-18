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
- Feishu auth and generic requests: `server/integrations/feishuClient.js`.
- Bitable CRUD and caches: `server/integrations/bitableClient.js`.
- Wiki nodes and copy tasks: `server/integrations/wikiClient.js`.
- Sessions, SSE, cache primitives, and client error logging: `server/runtime/`.
- Update manifest fetch: `server/services/updateService.js`.
- Personal settings Bitable workflow:
  `server/services/personalSettingsService.js`.
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
- When adding server modules, keep `scripts/build.ps1` copying the complete
  `server/` tree.
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

## Validate

Run syntax checks for changed modules, then:

```powershell
npm test
npm run build
git diff --check
```

When route behavior changes, run a local debug-session API smoke test without
printing secrets.
