import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;
const FRONTEND_MODULES = [
  'src/api/clientErrors.js',
  'src/ui/App.jsx',
  'src/ui/AppErrorBoundary.jsx',
  'src/ui/ProjectOverview.jsx',
  'src/ui/projectOverviewDisplayUtils.js',
  'src/ui/versions/VersionManagement.jsx',
  'src/ui/versions/versionManagementDisplayUtils.js',
  'src/ui/workspace/PlatformWorkspace.jsx',
  'src/ui/workspace/ProjectNavigation.jsx',
  'src/ui/workspace/projectToolDisplayUtils.js',
  'src/ui/workspace/projectToolIcons.js',
  'src/ui/work-items/WorkItemTimeline.jsx',
  'src/ui/work-items/WorkItemTimelinePanel.jsx',
  'src/ui/work-items/workItemFieldUtils.js',
  'src/ui/work-items/workItemTimelineUtils.js',
  'src/ui/settings/PersonalSettingsDialog.jsx',
];
const BROWSER_GLOBALS = new Set([
  'Array',
  'Blob',
  'Boolean',
  'Date',
  'Error',
  'EventSource',
  'File',
  'FormData',
  'Infinity',
  'Intl',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'ResizeObserver',
  'Set',
  'String',
  'URL',
  'URLSearchParams',
  'clearTimeout',
  'console',
  'document',
  'encodeURIComponent',
  'navigator',
  'setTimeout',
  'structuredClone',
  'undefined',
  'window',
]);

for (const file of FRONTEND_MODULES) {
  test(`${file} has no unbound runtime identifiers`, () => {
    const source = fs.readFileSync(file, 'utf8');
    const ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx'],
    });
    const unresolved = [];

    traverse(ast, {
      ReferencedIdentifier(path) {
        const name = path.node.name;
        if (!path.scope.hasBinding(name) && !BROWSER_GLOBALS.has(name)) {
          unresolved.push(`${name}:${path.node.loc?.start.line || 0}`);
        }
      },
    });

    assert.deepEqual(unresolved, []);
  });
}

test('work item timeline keeps React Chrono custom card content visible', () => {
  const source = fs.readFileSync('src/ui/work-items/WorkItemTimeline.jsx', 'utf8');

  assert.match(source, /compactText:\s*false/);
  assert.doesNotMatch(source, /compactText:\s*true/);
});

test('work item timeline overrides React Chrono card minimum widths', () => {
  const desktopStyles = fs.readFileSync('src/styles/workItems.css', 'utf8');
  const responsiveStyles = fs.readFileSync('src/styles/responsive.css', 'utf8');

  assert.match(
    desktopStyles,
    /\.work-item-timeline-chrono \.timeline-card-content\s*\{[^}]*min-width:\s*216px\s*!important;/s,
  );
  assert.match(
    responsiveStyles,
    /\.work-item-timeline-chrono \.timeline-card-content\s*\{[^}]*min-width:\s*202px\s*!important;/s,
  );
});

test('editable text keeps a visible selection highlight in embedded browsers', () => {
  const baseStyles = fs.readFileSync('src/styles/base.css', 'utf8');

  assert.match(
    baseStyles,
    /input::selection,\s*textarea::selection,\s*\[contenteditable="true"\]::selection,\s*\.allow-text-select::selection\s*\{[^}]*color:\s*#ffffff;[^}]*background-color:\s*#1677ff;[^}]*text-shadow:\s*none;/s,
  );
});

test('app initializes personal settings without awaiting workspace startup', () => {
  const source = fs.readFileSync('src/ui/App.jsx', 'utf8');

  assert.match(source, /ensurePersonalSettingsRecord\(\)\.catch\(\(\) =>/);
  assert.doesNotMatch(source, /await\s+ensurePersonalSettingsRecord\(\)/);
});

test('version management renders a local snapshot before refreshing it', () => {
  const versionSource = fs.readFileSync('src/ui/versions/VersionManagement.jsx', 'utf8');
  const workspaceSource = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');

  assert.match(versionSource, /loadVersions\(\{\s*readCache:\s*true\s*\}\)/);
  assert.match(versionSource, /await\s+getCachedSnapshot\(snapshotKey\)/);
  assert.match(versionSource, /normalizeVersionManagementPayload\(cachedSnapshot\.value\)/);
  assert.match(versionSource, /saveCachedSnapshot\(cacheUserKey,\s*snapshotKey,\s*payload\)/s);
  assert.match(workspaceSource, /<VersionManagement[\s\S]*cacheUserKey=\{cacheUserKey\}/);
});

test('project tool navigation renders icons and pending work item badges', () => {
  const source = fs.readFileSync('src/ui/workspace/PlatformWorkspace.jsx', 'utf8');

  assert.match(source, /getProjectToolIcon\(tool\.iconKey\)/);
  assert.match(source, /project-tool-pending-badge/);
  assert.match(source, /\{pendingCount\}未处理/);
  assert.match(source, /isProjectToolPendingCountTool\(normalizedToolId\)/);
});
