import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findWikiNodeByExactTitle,
  isWikiBitableNode,
  normalizeWikiNode,
} from '../server/integrations/wikiClient.js';

test('wiki nodes normalize Feishu response aliases', () => {
  const node = normalizeWikiNode({
    node_token: 'wikcn_node',
    obj_token: 'bascn_app',
    obj_type: 'bitable',
    title: 'P-1001',
  });

  assert.deepEqual(node, {
    nodeToken: 'wikcn_node',
    objToken: 'bascn_app',
    objType: 'bitable',
    title: 'P-1001',
  });
  assert.equal(isWikiBitableNode(node), true);
  assert.equal(findWikiNodeByExactTitle([node], 'P-1001'), node);
});

test('wiki node helpers reject empty and non-bitable nodes', () => {
  assert.equal(normalizeWikiNode({}), null);
  assert.equal(isWikiBitableNode({ objType: 'docx' }), false);
  assert.equal(findWikiNodeByExactTitle([], 'missing'), null);
});
