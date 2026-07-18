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
- Sessions, SSE, and cache primitives: `server/runtime/`.
- Update manifest fetch: `server/services/updateService.js`.

## Rules

- Preserve existing route paths, methods, request payloads, response payloads,
  status codes, cookies, and SSE event shape unless the request explicitly changes
  the contract.
- Keep HTTP details and integration-specific caches under `server/integrations/`.
- Keep process-local infrastructure state under `server/runtime/`.
- Keep config normalization pure and test it without reading runtime secrets.
- Apply project/tool permission checks before accessing work-item data.
- Do not expose `appSecret`, tenant/user tokens, or runtime config values.
- When adding server modules, keep `scripts/build.ps1` copying the complete
  `server/` tree.
- Prefer `getCachedValue` for shared promise-aware TTL cache behavior.

## Validate

Run syntax checks for changed modules, then:

```powershell
npm test
npm run build
git diff --check
```

When route behavior changes, run a local debug-session API smoke test without
printing secrets.
