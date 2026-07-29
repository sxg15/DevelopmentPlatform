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
  submission attachments, and configured project roots. It may generate the first
  complete draft directly when the requested outcome is sufficiently clear. When
  a material decision remains unresolved, it may persist one bounded set of one to
  three questions; after the owner answers, the same private thread continues and
  automatically generates the draft.
- A configured project `preludePrompt` is sent once at the start of each new Codex
  thread before attachment inputs and the generated work-item planning prompt.
  Same-thread question answers and later refinements must not resend it.
- AI attachment files and tokens are temporary server-side context only. Browser
  payloads may expose safe processed/skipped summaries but never attachment
  content, tokens, download URLs, or temporary paths.
- Question-required, plan-ready, and run-failed cards notify only the conversation
  owner and deep-link to the exact private conversation. Other project members
  continue to see only explicitly submitted plan revisions.
- If AI planning is globally enabled but the current project lacks a model
  connection or code-root mapping, requirement and Bug details retain a disabled
  AI status action so the configuration issue is visible.
- A `研发` project member who submits a requirement or Bug receives an optional
  post-submit AI planning prompt. The AI action opens a private conversation with
  an unsent default request; declining preserves the normal submission result.
- Submitted AI plans remain bound to the original project, tool, record ID,
  business ID, and title snapshot. Shared plans use immutable review revisions:
  current assignees plus development/global admins may approve, reject, or edit;
  reviewer edits return to pending review and rejection requires a reason.
- Keep one approved plan per work item. Replacing it marks the former approved
  plan superseded while preserving its Markdown, revision chain, and audit events.
- Deleting a shared AI plan removes its complete revision chain and audit events.
  Only the original submitter, project development super-admins, or global
  super-admins may delete; current assignee review permission alone is insufficient.
- New plan review cards target current assignees, or development super-admins for
  unassigned items. Newly assigned handlers receive a single pending-plan notice
  or aggregate notice, and review/edit/replacement outcomes notify the original
  plan submitter even when reviewer and submitter are the same user.
- Development-platform MCP reads expose assigned work summaries, safe details,
  project/version overviews, pending reviews, and approved requirement/Bug plans.
  Approved plans remain visible only while the authenticated user is a current
  assignee with project tool and AI-plan access. Match stable Feishu identifiers
  only and repeat access/assignment checks before returning full Markdown.
- MCP work-item comments, version comments, external AI-plan submissions, and
  status updates require idempotency IDs. Retry matches must not repeat writes,
  realtime events, or notifications; conflicting reuse must fail. Hidden
  idempotency metadata stays in stored JSON/SQLite rows and is removed from client
  payloads.
- MCP status updates remain assignee-only, require an expected current status, and
  preserve the requirement attachment confirmation workflow. Mention and proposer
  notifications are always explicit caller choices.
- MCP external AI plans have no private conversation. They join the submitter's
  `conversation_id=''` revision chain for that work item and notify the same
  current reviewers as web submissions.

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
