---
name: igp-feishu-realtime-cache
description: Maintain Feishu long-connection Bitable events, memory-only table snapshots, cache-aware reads and writes, realtime SSE reconciliation, and portable backend process control.
---

# IGP Feishu Realtime Cache

## Use When

Use this skill for changes to Bitable read latency, Feishu event subscriptions,
long connections, cache invalidation, work-item/version realtime delivery,
`StartWebBackend.bat`, `StopWebBackend.bat`, or `/api/health` cache status.

## Ownership

- Snapshot cache: `server/runtime/tableSnapshotCache.js`.
- Portable process lock and verified stop: `server/runtime/backendProcessController.js`.
- Bitable record HTTP access: `server/integrations/bitableClient.js`.
- Feishu WebSocket and document subscription adapters:
  `server/integrations/feishuLongConnectionClient.js` and
  `server/integrations/feishuDocumentEventSubscriptionClient.js`.
- Cache-aware Bitable gateway and event coordination:
  `server/services/bitableTableDataService.js` and
  `server/services/feishuBitableEventService.js`.
- Route wiring remains in `server/index.js`; do not move domain rules into the
  event service.

## Invariants

- Cache is process-memory only. Do not add SQLite, files, or tokens to the cache.
- Cache keys are Bitable identity and projection, never access tokens or users.
- List snapshots cache only complete `fetchRecords` projections. Never use a
  create/update response to patch a snapshot because Feishu may return only the
  submitted fields.
- Full-record cache entries are populated only by `fetchRecord`. Any local write
  or delete invalidates the affected table snapshot and record entry before SSE
  publication; the mutation response must be rebuilt from a fresh single-record
  read when the caller needs complete fields.
- Snapshot invalidation must advance a generation so an earlier in-flight list
  request cannot repopulate invalidated data after a write or event.
- Serialize all same work-item mutations by project, tool, and record. Read the
  current record with `consistency: 'fresh'` inside that queue before modifying
  status history, comments, assignees, or attachment documents.
- Preserve SSE `projectId`, `toolId`, and `recordId`; `changeType` is optional
  and may only be `updated` or `deleted`.
- Event callbacks enqueue work and return promptly. Dedupe event IDs and serialize
  a record's refresh. Refresh a changed record with the Bitable single-record API.
- Subscription and long-connection failures are degraded health states, never
  startup blockers for ordinary Bitable reads.
- Do not log raw event payloads, Bitable fields, App Secret, tenant tokens, or
  document tokens.
- Context registration is lazy after a work-item/version table is resolved.
- A recovered long connection force-refreshes registered hot tables, diffs the
  previous list snapshot, and publishes matching updated/deleted SSE events.
- `StopWebBackend.bat` must use the recorded PID and verified command line. Never
  scan ports or terminate an unrelated process.

## Configuration And Validation

- Normalize and validate `feishu.events.enabled` and `bitable.cache`.
- Keep defaults: 30s fresh, 5m stale-while-revalidate, 128 snapshots, 500ms event
  debounce, 24h event dedupe, and 10,000 dedupe IDs.
- Add pure tests for cache races, LRU, event normalization/debounce, delete SSE,
  config validation, and verified process control.
- Run `npm test`, `npx vite build`, `npm run build`, `npm run verify`, and
  `npm run deploy:debug` for completed changes.
