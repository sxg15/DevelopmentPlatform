import {
  getWorkItemAcceptanceStatus,
  getWorkItemProcessingStatuses,
} from '../../shared/workItemDefinitions.js';
import {
  fetchBitableFields,
  fetchCachedBitableFields,
  fetchCachedBitableTables,
  invalidateBitableFieldsCache,
  updateBitableField,
} from '../integrations/bitableClient.js';
import {
  findWikiNodeByTitle,
  getCachedWikiChildNodes,
  isWikiBitableNode,
} from '../integrations/wikiClient.js';
import { createKeyedTaskQueue } from '../runtime/keyedTaskQueue.js';

export const WORK_ITEM_ACCEPTANCE_OPTION_COLOR_ID = 3;

export function createWorkItemStatusSchemaService(dependencies = {}) {
  const fetchFields = dependencies.fetchFields || fetchBitableFields;
  const fetchCachedFields = dependencies.fetchCachedFields || fetchCachedBitableFields;
  const updateField = dependencies.updateField || updateBitableField;
  const invalidateFields = dependencies.invalidateFields || invalidateBitableFieldsCache;
  const findParentNode = dependencies.findParentNode || findWikiNodeByTitle;
  const fetchChildNodes = dependencies.fetchChildNodes || getCachedWikiChildNodes;
  const isBitableNode = dependencies.isBitableNode || isWikiBitableNode;
  const resolveTableContext = dependencies.resolveTableContext || resolveWorkItemTableContext;
  const queue = dependencies.queue || createKeyedTaskQueue();
  const verifiedContexts = new Set();

  async function ensureStatusOptions(token, context, toolConfig) {
    const acceptanceStatus = getWorkItemAcceptanceStatus(toolConfig?.toolId);
    if (!acceptanceStatus) {
      return {
        updated: false,
        fields: await fetchCachedFields(token, context.appToken, context.tableId),
      };
    }

    const key = buildStatusSchemaKey(context, toolConfig);
    if (verifiedContexts.has(key)) {
      return {
        updated: false,
        fields: await fetchCachedFields(token, context.appToken, context.tableId),
      };
    }

    return queue.run(key, async () => {
      if (verifiedContexts.has(key)) {
        return {
          updated: false,
          fields: await fetchCachedFields(token, context.appToken, context.tableId),
        };
      }

      const fields = await fetchFields(token, context.appToken, context.tableId);
      const update = buildAcceptanceStatusFieldUpdate(fields, toolConfig);
      if (!update) {
        invalidateFields(context.appToken, context.tableId);
        verifiedContexts.add(key);
        return { updated: false, fields };
      }

      await updateField(
        token,
        context.appToken,
        context.tableId,
        update.fieldId,
        update.body,
      );
      const refreshedFields = await fetchFields(token, context.appToken, context.tableId);
      if (!hasStatusOption(refreshedFields, toolConfig.fieldNames.status, acceptanceStatus)) {
        throw new Error(`${toolConfig.itemLabel}表“${toolConfig.fieldNames.status}”未成功增加“${acceptanceStatus}”选项`);
      }

      invalidateFields(context.appToken, context.tableId);
      verifiedContexts.add(key);
      return { updated: true, fields: refreshedFields };
    });
  }

  async function migrateStatusOptions(token, toolConfigs) {
    const summary = {
      scanned: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      failures: [],
    };

    for (const toolConfig of toolConfigs || []) {
      if (!getWorkItemAcceptanceStatus(toolConfig?.toolId)) {
        continue;
      }

      let parentNode;
      try {
        parentNode = await findParentNode(token, toolConfig.parentName);
        if (!parentNode) {
          throw new Error(`找不到知识库节点：${toolConfig.parentName}`);
        }
      } catch (error) {
        summary.failed += 1;
        summary.failures.push(buildMigrationFailure(toolConfig, toolConfig.parentName, error));
        continue;
      }

      let childNodes;
      try {
        childNodes = await fetchChildNodes(token, parentNode.nodeToken);
      } catch (error) {
        summary.failed += 1;
        summary.failures.push(buildMigrationFailure(toolConfig, toolConfig.parentName, error));
        continue;
      }

      for (const node of childNodes || []) {
        if (!isBitableNode(node)) {
          continue;
        }

        summary.scanned += 1;
        try {
          const context = await resolveTableContext(token, node, toolConfig);
          const result = await ensureStatusOptions(token, context, toolConfig);
          if (result.updated) {
            summary.updated += 1;
          } else {
            summary.unchanged += 1;
          }
        } catch (error) {
          summary.failed += 1;
          summary.failures.push(buildMigrationFailure(toolConfig, node.title, error));
        }
      }
    }

    return summary;
  }

  return {
    ensureStatusOptions,
    migrateStatusOptions,
  };
}

export function buildAcceptanceStatusFieldUpdate(fields, toolConfig) {
  const acceptanceStatus = getWorkItemAcceptanceStatus(toolConfig?.toolId);
  if (!acceptanceStatus) {
    return null;
  }

  const statusFieldName = String(toolConfig?.fieldNames?.status || '').trim();
  const statusField = (fields || []).find((field) => getFieldName(field) === statusFieldName);
  if (!statusField) {
    throw new Error(`${toolConfig.itemLabel}表缺少“${statusFieldName}”字段`);
  }
  if (!isSingleSelectField(statusField)) {
    throw new Error(`${toolConfig.itemLabel}表字段“${statusFieldName}”必须是单选类型`);
  }

  const options = getFieldOptions(statusField);
  if (options.some((option) => getOptionName(option) === acceptanceStatus)) {
    return null;
  }

  const nextOptions = options.map(cloneJsonSafe);
  const primaryProcessingStatus = getWorkItemProcessingStatuses(toolConfig.toolId)[0] || '';
  const anchorIndex = nextOptions.findIndex((option) => getOptionName(option) === primaryProcessingStatus);
  nextOptions.splice(anchorIndex >= 0 ? anchorIndex + 1 : nextOptions.length, 0, {
    name: acceptanceStatus,
    color: WORK_ITEM_ACCEPTANCE_OPTION_COLOR_ID,
  });

  const fieldId = String(statusField.field_id || statusField.fieldId || '').trim();
  if (!fieldId) {
    throw new Error(`${toolConfig.itemLabel}表字段“${statusFieldName}”缺少字段 ID`);
  }

  const property = cloneJsonSafe(statusField.property) || {};
  delete property.option;
  delete property.options_list;
  property.options = nextOptions;

  return {
    fieldId,
    body: {
      field_name: statusFieldName,
      type: Number(statusField.type) || 3,
      property,
    },
  };
}

export async function resolveWorkItemTableContext(token, node, toolConfig) {
  if (!node?.objToken) {
    throw new Error(toolConfig.notLinkedText);
  }

  const tables = await fetchCachedBitableTables(token, node.objToken);
  const firstTable = tables[0] || null;
  const tableId = String(firstTable?.table_id || firstTable?.tableId || '').trim();
  if (!tableId) {
    throw new Error(toolConfig.noTableText);
  }

  return {
    appToken: node.objToken,
    tableId,
  };
}

function buildStatusSchemaKey(context, toolConfig) {
  return [
    toolConfig?.toolId || '',
    context?.appToken || '',
    context?.tableId || '',
    toolConfig?.fieldNames?.status || '',
  ].join('|');
}

function buildMigrationFailure(toolConfig, nodeTitle, error) {
  return {
    toolId: String(toolConfig?.toolId || ''),
    nodeTitle: String(nodeTitle || ''),
    message: error instanceof Error ? error.message : String(error || '迁移失败'),
  };
}

function hasStatusOption(fields, fieldName, optionName) {
  const field = (fields || []).find((item) => getFieldName(item) === fieldName);
  return getFieldOptions(field).some((option) => getOptionName(option) === optionName);
}

function getFieldName(field) {
  return String(field?.field_name || field?.fieldName || '').trim();
}

function getFieldOptions(field) {
  const property = field?.property || {};
  if (Array.isArray(property.options)) {
    return property.options;
  }
  if (Array.isArray(property.option)) {
    return property.option;
  }
  if (Array.isArray(property.options_list)) {
    return property.options_list;
  }
  return [];
}

function getOptionName(option) {
  return String(option?.name || option?.text || option?.value || '').trim();
}

function isSingleSelectField(field) {
  const uiType = String(field?.ui_type || field?.uiType || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
  return Number(field?.type) === 3 || uiType.includes('singleselect');
}

function cloneJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value && typeof value === 'object' ? { ...value } : value;
  }
}

const defaultService = createWorkItemStatusSchemaService();

export const ensureWorkItemStatusOptions = defaultService.ensureStatusOptions;
export const migrateWorkItemStatusOptions = defaultService.migrateStatusOptions;
