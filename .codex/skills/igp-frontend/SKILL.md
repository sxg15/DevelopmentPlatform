---
name: igp-frontend
description: Maintain the IGP React/Vite frontend, including authentication shell, project navigation, project overview, work-item screens, frontend API clients, Feishu H5 authorization, local cache, and CSS. Use for requests that change files under src/, frontend behavior, browser workflows, responsive layout, or UI module boundaries.
---

# IGP Frontend

## Start

Read `AGENTS.md`, then inspect only the owning frontend modules.

- App startup or login: `src/main.jsx`, `src/ui/App.jsx`,
  `src/ui/AppErrorBoundary.jsx`, `src/api/auth.js`,
  `src/api/clientErrors.js`, `src/integrations/feishuH5.js`.
- Personal settings: `src/ui/settings/PersonalSettingsDialog.jsx`,
  `src/api/personalSettings.js`, `src/styles/settings.css`.
- Project loading/navigation: `src/ui/workspace/PlatformWorkspace.jsx`,
  `src/ui/workspace/ProjectNavigation.jsx`, `src/api/projects.js`.
- Overview: `src/ui/ProjectOverview.jsx`, `src/api/overview.js`,
  `src/ui/projectOverviewDisplayUtils.js`, `shared/projectOverviewUtils.js`.
- Work items: `src/ui/workspace/PlatformWorkspace.jsx`,
  `src/ui/work-items/workItemFieldUtils.js`,
  `src/ui/work-items/WorkItemTimelinePanel.jsx`,
  `src/ui/work-items/WorkItemTimeline.jsx`,
  `src/ui/work-items/workItemTimelineUtils.js`,
  `src/ui/workItemListUtils.js`, `src/api/workItems.js`.
- Cache/drafts: `src/ui/localCache.js`.
- Styling: `src/styles.css` and `src/styles/`.

## Rules

- Put HTTP calls in `src/api/`; do not add direct `fetch` calls to React components.
- Keep the root error boundary and global runtime reporting active. Client reports
  must use `shared/clientErrorUtils.js` and must not include form values, work-item
  payloads, query strings, tokens, or runtime configuration.
- Normalize cached or remote overview payloads before rendering; do not trust old
  IndexedDB snapshots to retain the current schema.
- Isolate ECharts initialization, option updates, resize callbacks, and disposal so
  a chart failure cannot unmount the application.
- Keep Feishu SDK behavior in `src/integrations/`.
- Keep the settings dialog isolated from `App.jsx`; the app shell owns only open
  state, while loading and saving belong to the settings component and API client.
- Personal notification settings use
  `{ receiveTodoNotifications, todoNotificationTime }`, with `HH:mm` time values.
- Reuse `shared/workItemDefinitions.js` instead of duplicating route segments,
  labels, statuses, or field contracts.
- Keep pure formatting/filtering logic outside JSX when it can be tested.
- Keep React Chrono lazy-loaded behind `WorkItemTimelinePanel`; a timeline load or
  render failure must not replace the work-item detail page.
- Keep work-item detail timelines horizontal on desktop and mobile. Present the
  currently loaded events from oldest to newest, show each compact event card
  directly above its corresponding node, and preserve horizontal scrolling
  instead of switching to a vertical layout at narrow widths.
- React Chrono must use `content.compactText: false` for these custom cards;
  enabling compact text maps to the library's low-density mode and hides custom
  event content.
- Override the custom timeline card's `width`, `min-width`, and `max-width`
  together. React Chrono supplies a 280px minimum width that otherwise makes
  adjacent compact cards overlap their fixed-width node columns.
- Load React Chrono's global stylesheet before project styles so local base and
  work-item rules retain cascade ownership.
- Preserve local snapshot and draft keys when changing workspace state.
- Keep stylesheet import order: base, overview, work items, auth, settings,
  responsive.
- Add component-specific CSS to the owning stylesheet; add cross-module responsive
  overrides to `responsive.css`.
- Maintain existing dense operational UI patterns and verify text does not truncate
  or overlap on desktop and mobile.

## Validate

Run:

```powershell
npm test
npx vite build
git diff --check
```

For visible UI changes, start `npm run dev` and inspect the affected workflow in a
browser at desktop and mobile widths.
