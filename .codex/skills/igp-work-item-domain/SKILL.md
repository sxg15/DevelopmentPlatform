---
name: igp-work-item-domain
description: Maintain IGP requirement, Bug, test-task, and feedback domain contracts across shared definitions, frontend workflows, backend services, Bitable fields, assignment permissions, comments, status changes, attachments, notifications, and project overview aggregation. Use whenever a request changes work-item fields, roles, statuses, submission or detail behavior, cards, or cross-frontend/backend rules.
---

# IGP Work Item Domain

## Canonical Files

Read `AGENTS.md` and these files before changing workflow behavior:

- `shared/workItemDefinitions.js`
- `shared/workItemAssignmentUtils.js`
- `shared/testTaskUtils.js`
- `shared/requirementSubmissionAttachmentUtils.js`
- `shared/workItemRealtimeUtils.js`
- `shared/projectOverviewUtils.js`
- `shared/versionManagementUtils.js`
- `src/ui/workspace/PlatformWorkspace.jsx`
- `server/index.js`

Treat shared definitions as the canonical frontend/backend contract.

## Invariants

- Tool IDs are `requirements`, `bugs`, `testTasks`, and `feedback`; route segments
  and field names come from shared tool definitions plus normalized runtime config.
- `testTasks` uses a dedicated service, API, UI, and stylesheet. Its tool matrix
  field is `测试任务`; project `测试管理员` receive direct access, and tester
  candidates are project `测试` plus `测试管理员`.
- Test-task content and result fields are versioned JSON. Content items use unique
  six-character IDs; result items preserve the matching ID, conclusion, optional
  feedback draft author, attachments, and submitted feedback identity. Normalize
  Feishu rich-text fragments before parsing either JSON document.
- The test-task state flow is `待测试 -> 测试中 -> 已完成`. Only test
  administrators may start, adjust testers, edit results/drafts, or complete;
  starting requires at least one candidate tester and completing requires every
  conclusion.
- Test-task completion creates unfinished feedback drafts idempotently, with the
  draft author as proposer and original task creator as handler. Persist each
  successful feedback association before continuing; any failure leaves the task
  `测试中` and returns retry details.
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
- Feedback uses `待分类 -> 已转需求 / 已转Bug / 已回复`. Migrate only legacy
  unfinished `待处理` and `处理中` records to `待分类`; keep legacy completed
  statuses as historical completed values.
- Current feedback assignees, project development super-admins, and global
  super-admins may classify. A feedback may have only one immutable converted
  requirement or Bug. Store versioned JSON in feedback `关联项` and target
  `关联反馈`, preserve the feedback proposers on the target, and fail closed on
  malformed association data.
- Feedback conversion uses the full target submission contract, including
  assignment validation, explicit unassigned routing, requirement attachment
  settings, selected source attachments, and new uploads. Notify target assignees
  or development super-admins only; do not notify the feedback proposer merely
  because the conversion completed.
- Reply-only resolution requires an internal Feishu proposer and nonempty reply.
  Persist the reply as a feedback comment and set `已回复` before sending its card;
  notification failure does not roll back the mutation.
- Daily pending reminders include requirements, Bugs, test tasks, and feedback
  whose current status is not in that tool's configured completed group. Test
  administrators receive all active test tasks; selected testers receive assigned
  `测试中` tasks. Blocked, stalled, and unset statuses remain pending.
- Requirements and Bugs include `待验收` as an active processing status. Keep it
  in processing totals and pending reminders, exclude it from completed version
  associations, and ensure the option exists on templates and historical tables.
- Reminder collection must honor the user's project and tool permissions, treat
  missing work-item tables as empty, and continue when one project/tool read
  fails.
- Reminder cards show a four-tool count summary and at most ten urgency-sorted
  direct-detail links.
- Project tool badges count actionable items across requirements, Bugs, test tasks,
  and feedback. Use `待处理` for requirements, `未处理` for Bugs, and `待分类`
  for feedback;
  test administrators count `待测试`/`测试中`, selected testers count assigned
  `测试中`, zero counts stay hidden, and realtime events refresh the values.
- `builds` and `review` are visible navigation placeholders for all project
  members even when the permission matrix omits them. Their shared definitions
  carry `disabled: true` and `statusText: '开发中'`; the frontend must render
  `（开发中）` and never select them or issue backend requests.
- Opening the authenticated app silently creates a missing personal-settings
  record with notifications disabled. Record creation must not delay or fail the
  normal workspace startup path.
- Comments and status change logs must retain their stored document schemas.
- Realtime updates retain `projectId`, `toolId`, and `recordId`.
- Opening project overview must not create or copy work-item tables.
- Version associations may add only requirements, Bugs, and feedback currently in a
  configured completed group. Store record ID, business ID, and title snapshots;
  retain existing snapshots if the work item is later reopened unless the user
  explicitly removes selected associations.
- Requirement and Bug status changes use the configured completed-status groups
  as a boundary. Entering the group prompts for selected current `测试开发`
  versions; leaving it prompts for selected existing associations. Browser and
  MCP mutations share the confirmation contract, preserve the status when a later
  association write fails, and reuse the same mutation ID to retry only the
  association without repeating logs, realtime events, or notifications.
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
- Requirement and Bug list rows derive their AI badge from one owner-safe project
  activity summary. Active generation takes precedence over pending questions,
  which takes precedence over an existing private draft or shared pending/approved
  plan. Feedback never receives an AI badge.
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
- `已应用` is a reversible boolean on an approved AI plan, not another review
  status. It may be changed only while the work item exists and the plan remains
  approved. Record actor/time and audit events, make browser and MCP writes
  idempotent, and clear it when that approved plan is superseded.
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
- MCP work-item comments, version comments, external AI-plan submissions,
  approved-plan application changes, and status updates require idempotency IDs.
  Retry matches must not repeat writes, realtime events, audit events, or
  notifications; conflicting reuse must fail. Hidden idempotency metadata stays
  in stored JSON/SQLite rows and is removed from client payloads.
- MCP status updates remain assignee-only, require an expected current status, and
  preserve the requirement attachment and version-association confirmation
  workflows. Mention and proposer notifications are always explicit caller
  choices.
- MCP external AI plans have no private conversation. They join the submitter's
  `conversation_id=''` revision chain for that work item and notify the same
  current reviewers as web submissions.
- The Feishu private-chat assistant may create only requirements and Bugs after a
  confirmation card. It must collect a project, title, actionable description,
  and either stable mentioned assignees or an explicit unassigned-routing choice;
  no name-only assignee matching is permitted.
- Test tasks are intentionally excluded from MCP, version associations, AI
  planning, and Feishu private-chat creation.

## Change Sequence

1. Update shared definitions/utilities first.
2. Update backend normalization, validation, persistence, and notifications.
3. Update frontend form, list, detail, and API behavior.
4. Add focused tests under `test/` for every changed invariant.
5. Verify all four tools, including permission differences and missing optional
   fields.

## Validate

Run:

```powershell
npm test
npx vite build
git diff --check
```
