---
name: igp-frontend
description: Maintain the IGP React/Vite frontend, including authentication shell, project navigation, project overview, work-item screens, frontend API clients, Feishu H5 authorization, local cache, and CSS. Use for requests that change files under src/, frontend behavior, browser workflows, responsive layout, or UI module boundaries.
---

# IGP Frontend

## Start

Read `AGENTS.md`, then inspect only the owning frontend modules.

- App startup or login: `src/ui/App.jsx`, `src/api/auth.js`,
  `src/integrations/feishuH5.js`.
- Project loading/navigation: `src/ui/workspace/PlatformWorkspace.jsx`,
  `src/ui/workspace/ProjectNavigation.jsx`, `src/api/projects.js`.
- Overview: `src/ui/ProjectOverview.jsx`, `src/api/overview.js`,
  `shared/projectOverviewUtils.js`.
- Work items: `src/ui/workspace/PlatformWorkspace.jsx`,
  `src/ui/work-items/workItemFieldUtils.js`, `src/ui/workItemListUtils.js`,
  `src/api/workItems.js`.
- Cache/drafts: `src/ui/localCache.js`.
- Styling: `src/styles.css` and `src/styles/`.

## Rules

- Put HTTP calls in `src/api/`; do not add direct `fetch` calls to React components.
- Keep Feishu SDK behavior in `src/integrations/`.
- Reuse `shared/workItemDefinitions.js` instead of duplicating route segments,
  labels, statuses, or field contracts.
- Keep pure formatting/filtering logic outside JSX when it can be tested.
- Preserve local snapshot and draft keys when changing workspace state.
- Keep stylesheet import order: base, overview, work items, auth, responsive.
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
