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
- `shared/versionManagementUtils.js`
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
- Requirements and Bugs include `待验收` as an active processing status. Keep it
  in processing totals and pending reminders, exclude it from completed version
  associations, and ensure the option exists on templates and historical tables.
- Reminder collection must honor the user's project and tool permissions, treat
  missing work-item tables as empty, and continue when one project/tool read
  fails.
- Reminder cards show a three-tool count summary and at most ten urgency-sorted
  direct-detail links.
- Project tool badges count assigned initial-waiting items across requirements,
  Bugs, and feedback. Use `待处理` for requirements/feedback and `未处理` for Bugs,
  hide zero counts, and refresh the values after realtime work-item events.
- Opening the authenticated app silently creates a missing personal-settings
  record with notifications disabled. Record creation must not delay or fail the
  normal workspace startup path.
- Comments and status change logs must retain their stored document schemas.
- Realtime updates retain `projectId`, `toolId`, and `recordId`.
- Opening project overview must not create or copy work-item tables.
- Version associations may add only requirements, Bugs, and feedback currently in a
  configured completed group. Store record ID, business ID, and title snapshots;
  retain existing snapshots if the work item is later reopened.
- Project overview may display version data but must read existing version tables
  only. Version Management itself owns first-open provisioning.
- Requirement and Bug detail pages may open a private Codex planning conversation.
  Conversation history is owner-only; submitted Markdown revisions are project
  shared and remain filtered by the viewer's underlying requirement/Bug access.
- Codex first inspects the work item, its regular attachments, requirement
  submission attachments, and configured project roots. It may persist one to
  three material decision questions and continue the same private thread after the
  owner answers; once resolved, it automatically generates the draft.
- AI attachment files and tokens are temporary server-side context only. Browser
  payloads may expose safe processed/skipped summaries but never attachment
  content, tokens, download URLs, or temporary paths.
- Question-required, plan-ready, and run-failed cards notify only the conversation
  owner and deep-link to the exact private conversation. Other project members
  continue to see only explicitly submitted plan revisions.
- If AI planning is globally enabled but the current project lacks a model
  connection or code-root mapping, requirement and Bug details retain a disabled
  AI status action so the configuration issue is visible.

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
