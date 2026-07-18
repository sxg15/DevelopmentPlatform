import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;
const FRONTEND_MODULES = [
  'src/ui/App.jsx',
  'src/ui/ProjectOverview.jsx',
  'src/ui/workspace/PlatformWorkspace.jsx',
  'src/ui/workspace/ProjectNavigation.jsx',
  'src/ui/work-items/workItemFieldUtils.js',
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
