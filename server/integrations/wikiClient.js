import { runtimeConfig } from '../config/runtimeConfig.js';
import { getCachedValue } from '../runtime/asyncCache.js';
import { readJson } from './feishuClient.js';

const STRUCTURE_CACHE_TTL_MS = 5 * 60 * 1000;
const wikiTitleCache = new Map();
const wikiChildrenCache = new Map();
export function getCachedWikiChildNodes(token, parentNodeToken) {
  const cacheKey = getWikiChildNodesCacheKey(parentNodeToken);
  return getCachedValue(wikiChildrenCache, cacheKey, STRUCTURE_CACHE_TTL_MS, () => fetchWikiChildNodes(token, parentNodeToken));
}

export function invalidateWikiChildNodesCache(parentNodeToken) {
  wikiChildrenCache.delete(getWikiChildNodesCacheKey(parentNodeToken));
}

export function getWikiChildNodesCacheKey(parentNodeToken) {
  return `${runtimeConfig.knowledgeBase.spaceId}|${parentNodeToken || ''}`;
}

export function setCachedWikiNodeByTitle(title, node) {
  if (!title || !node) {
    return;
  }

  wikiTitleCache.set(getWikiTitleCacheKey(title), {
    value: node,
    expiresAt: Date.now() + STRUCTURE_CACHE_TTL_MS,
  });
}

export function getWikiTitleCacheKey(title) {
  return `${runtimeConfig.knowledgeBase.spaceId}|${title || ''}`;
}

export async function findWikiNodeByTitle(token, title) {
  return getCachedValue(wikiTitleCache, getWikiTitleCacheKey(title), STRUCTURE_CACHE_TTL_MS, async () => {
    const rootNodes = await getCachedWikiChildNodes(token, '');
    const queue = [...rootNodes];
    const visited = new Set();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current?.nodeToken || visited.has(current.nodeToken)) {
        continue;
      }

      visited.add(current.nodeToken);

      if (current.title === title) {
        return current;
      }

      const children = await getCachedWikiChildNodes(token, current.nodeToken);
      queue.push(...children);
    }

    return null;
  });
}

export async function fetchWikiNodeByToken(token, nodeToken) {
  const normalizedToken = String(nodeToken || '').trim();
  if (!normalizedToken) {
    throw new Error('缺少知识库节点 Token');
  }

  const query = new URLSearchParams({
    token: normalizedToken,
    obj_type: 'wiki',
  });
  const response = await fetch(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?${query}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '读取知识库节点失败');
  }

  const node = normalizeWikiNode(payload.data?.node || payload.data?.wiki_node || payload.data);
  if (!node?.nodeToken || !node?.objToken) {
    throw new Error('知识库节点没有返回有效的关联对象');
  }

  return node;
}

export async function fetchWikiChildNodes(token, parentNodeToken) {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const nodes = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({ page_size: '50' });
    if (parentNodeToken) {
      query.set('parent_node_token', parentNodeToken);
    }
    if (pageToken) {
      query.set('page_token', pageToken);
    }

    const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(knowledgeBase.spaceId)}/nodes?${query}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = await readJson(response);

    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.msg || '读取知识库节点失败');
    }

    const items = payload.data?.items || payload.data?.nodes || [];
    nodes.push(...items.map(normalizeWikiNode).filter(Boolean));
    pageToken = payload.data?.has_more ? String(payload.data?.page_token || '') : '';
  } while (pageToken);

  return nodes;
}

export async function createWikiNode(token, parentNodeToken, title) {
  const attempts = ['docx', 'doc'];
  let lastError = null;

  for (const objType of attempts) {
    try {
      const node = await createWikiNodeWithType(token, parentNodeToken, title, objType);
      const titledNode = node.title === title ? node : await updateWikiNodeTitle(token, node.nodeToken, title);
      invalidateWikiChildNodesCache(parentNodeToken);
      setCachedWikiNodeByTitle(title, titledNode);
      return titledNode;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('创建知识库节点失败');
}

export async function createWikiNodeWithType(token, parentNodeToken, title, objType) {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const body = {
    obj_type: objType,
    node_type: 'origin',
    title,
  };

  if (parentNodeToken) {
    body.parent_node_token = parentNodeToken;
  }

  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(knowledgeBase.spaceId)}/nodes`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '创建知识库节点失败');
  }

  const node = normalizeWikiNode(payload.data?.node || payload.data?.wiki_node || payload.data);
  if (!node?.nodeToken) {
    throw new Error('创建知识库节点没有返回节点信息');
  }

  return node;
}

export async function updateWikiNodeTitle(token, nodeToken, title) {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(knowledgeBase.spaceId)}/nodes/${encodeURIComponent(nodeToken)}/update_title`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ title }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '更新知识库节点标题失败');
  }

  return normalizeWikiNode(payload.data?.node || payload.data?.wiki_node || payload.data) || {
    nodeToken,
    objToken: '',
    objType: '',
    title,
  };
}

export async function copyWikiNode(token, sourceNodeToken, parentNodeToken, title) {
  const knowledgeBase = runtimeConfig.knowledgeBase;
  const body = {
    target_parent_token: parentNodeToken,
    target_space_id: knowledgeBase.spaceId,
    title,
  };
  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(knowledgeBase.spaceId)}/nodes/${encodeURIComponent(sourceNodeToken)}/copy`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '复制需求模板失败');
  }

  const copiedNode = normalizeWikiNode(payload.data?.node || payload.data?.wiki_node || payload.data);
  if (copiedNode?.nodeToken) {
    invalidateWikiChildNodesCache(parentNodeToken);
    return copiedNode;
  }

  const taskId = payload.data?.task_id || payload.data?.taskId || payload.data?.id;
  if (taskId) {
    const taskNode = await pollWikiTaskForNode(token, taskId);
    invalidateWikiChildNodesCache(parentNodeToken);
    return taskNode;
  }

  invalidateWikiChildNodesCache(parentNodeToken);
  const childNodes = await getCachedWikiChildNodes(token, parentNodeToken);
  const createdNode = findWikiNodeByExactTitle(childNodes, title);
  if (createdNode) {
    return createdNode;
  }

  throw new Error('复制已提交，但没有返回新节点信息');
}

export async function pollWikiTaskForNode(token, taskId) {
  const query = new URLSearchParams({ task_type: 'copy' });
  const url = `https://open.feishu.cn/open-apis/wiki/v2/tasks/${encodeURIComponent(String(taskId))}?${query}`;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = await readJson(response);

    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.msg || '查询知识库复制结果失败');
    }

    const task = payload.data?.task || payload.data || {};
    const status = String(task.status || task.task_status || '').toLowerCase();
    const node = normalizeWikiNode(task.node || task.wiki_node || task.result?.node || task.result);

    if (node?.nodeToken) {
      return node;
    }

    if (status.includes('fail') || status.includes('error')) {
      throw new Error(task.message || task.msg || '复制需求模板失败');
    }

    await wait(800);
  }

  throw new Error('复制需求模板超时');
}

export function normalizeWikiNode(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const nodeToken = String(node.node_token || node.nodeToken || node.token || '');
  const objToken = String(node.obj_token || node.objToken || node.app_token || node.appToken || '');
  const title = String(node.title || node.name || '');

  if (!nodeToken && !objToken && !title) {
    return null;
  }

  return {
    nodeToken,
    objToken,
    objType: String(node.obj_type || node.objType || node.type || ''),
    title,
  };
}

export function findWikiNodeByExactTitle(nodes, title) {
  return nodes.find((node) => node.title === title) || null;
}

export function isWikiBitableNode(node) {
  const type = String(node.objType || '').toLowerCase();
  return type === 'bitable' || type === 'base' || type.includes('bitable');
}

export function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
