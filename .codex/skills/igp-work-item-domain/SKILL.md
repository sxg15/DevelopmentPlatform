---
name: igp-work-item-domain
description: Maintain IGP requirement, Bug, and feedback domain contracts across shared definitions, frontend workflows, backend services, Bitable fields, assignment permissions, comments, status changes, attachments, notifications, and project overview aggregation. Use whenever a request changes work-item fields, roles, statuses, submission or detail behavior, cards, or cross-frontend/backend rules.
---

# IGP Work Item Domain

## Canonical Files

Read `AGENTS.md` and these files before changing workflow behavior:

- `shared/workItemDefinitions.js`
- `shared/workItemAssignmentUtils.js`
- `shared/requirementSubmissionAttachmentUtils.js`
- `shared/workItemRealtimeUtils.js`
- `shared/projectOverviewUtils.js`
- `src/ui/workspace/PlatformWorkspace.jsx`
- `server/index.js`

Treat shared definitions as the canonical frontend/backend contract.

## Invariants

- Tool IDs are `requirements`, `bugs`, and `feedback`; route segments and field
  names come from shared tool definitions plus normalized runtime config.
- Only requirements and Bugs support explicit "不知道该由谁处理".
- An explicitly unassigned requirement/Bug notifies the project's
  `研发超级管理员` for manual assignment.
- `研发超级管理员` may change requirement/Bug assignees but does not receive every
  global super-admin permission.
- Requirement field `需要提交附件` defaults to `否`; `提交附件` stores delivery
  attachments. Required items with no submitted attachment trigger confirmation
  before status update.
- Attachment changes can notify proposers and must add an operation comment that
  describes added and removed files.
- Detail timelines are frontend projections of `proposedAt`, `statusChangeLog`, and
  `comments`; do not add a timeline field or API. Classify comments beginning with
  `变更处理人：` and `提交附件变动：` as key changes, and keep other comments in
  the comment category.
- Timeline creation events must not claim an initial status or assignee because the
  current stored data does not prove those historical values.
- Empty assignees in detail views must remain visibly warned.
- Feedback contact data remains normalized JSON in `联系信息数据`.
- Daily pending reminders include assigned requirements, Bugs, and feedback whose
  current status is not in that tool's configured completed group. Blocked,
  stalled, and unset statuses remain pending.
- Reminder collection must honor the user's project and tool permissions, treat
  missing work-item tables as empty, and continue when one project/tool read
  fails.
- Reminder cards show a three-tool count summary and at most ten urgency-sorted
  direct-detail links.
- Opening the authenticated app silently creates a missing personal-settings
  record with notifications disabled. Record creation must not delay or fail the
  normal workspace startup path.
- Comments and status change logs must retain their stored document schemas.
- Realtime updates retain `projectId`, `toolId`, and `recordId`.
- Opening project overview must not create or copy work-item tables.

## Change Sequence

1. Update shared definitions/utilities first.
2. Update backend normalization, validation, persistence, and notifications.
3. Update frontend form, list, detail, and API behavior.
4. Add focused tests under `test/` for every changed invariant.
5. Verify all three tools, including permission differences and missing optional
   fields.

## Validate

Run:

```powershell
npm test
npx vite build
git diff --check
```
