import {
  FEEDBACK_LEGACY_ACTIVE_STATUSES,
  FEEDBACK_STATUSES,
} from '../../shared/workItemDefinitions.js';
import {
  ensureBitableTextField,
  fetchBitableFields,
  fetchBitableRecords,
  invalidateBitableFieldsCache,
  updateBitableRecordFields,
} from '../integrations/bitableClient.js';
import {
  findWikiNodeByTitle,
  getCachedWikiChildNodes,
  isWikiBitableNode,
} from '../integrations/wikiClient.js';
import { createKeyedTaskQueue } from '../runtime/keyedTaskQueue.js';
import { resolveWorkItemTableContext } from './workItemStatusSchemaService.js';

export function createWorkItemRelationSchemaService(dependencies = {}) {
  const fetchFields = dependencies.fetchFields || fetchBitableFields;
  const ensureTextField = dependencies.ensureTextField || ensureBitableTextField;
  const invalidateFields = dependencies.invalidateFields || invalidateBitableFieldsCache;
  const fetchRecords = dependencies.fetchRecords || fetchBitableRecords;
  const updateRecord = dependencies.updateRecord || updateBitableRecordFields;
  const findParentNode = dependencies.findParentNode || findWikiNodeByTitle;
  const fetchChildNodes = dependencies.fetchChildNodes || getCachedWikiChildNodes;
  const isBitableNode = dependencies.isBitableNode || isWikiBitableNode;
  const resolveTableContext = dependencies.resolveTableContext || resolveWorkItemTableContext;
  const queue = dependencies.queue || createKeyedTaskQueue();

  async function ensureSchema(token, context, toolConfig, options = {}) {
    const fieldNames = getRequiredRelationFieldNames(toolConfig);
    if (fieldNames.length === 0) {
      return { updated: false, migratedRecords: 0, fields: [] };
    }

    const key = [
      'work-item-relation-schema',
      toolConfig.toolId,
      context.appToken,
      context.tableId,
    ].join('|');
    return queue.run(key, async () => {
      let fields = await fetchFields(token, context.appToken, context.tableId);
      let updated = false;
      for (const fieldName of fieldNames) {
        const existing = findField(fields, fieldName);
        if (existing) {
          assertTextField(existing, toolConfig, fieldName);
          continue;
        }
        await ensureTextField(token, context.appToken, context.tableId, fieldName);
        invalidateFields(context.appToken, context.tableId);
        fields = await fetchFields(token, context.appToken, context.tableId);
        const created = findField(fields, fieldName);
        if (!created) {
          throw new Error(`${toolConfig.itemLabel}表未成功增加“${fieldName}”字段`);
        }
        assertTextField(created, toolConfig, fieldName);
        updated = true;
      }

      const migratedRecords = options.migrateLegacyFeedbackStatuses
        && toolConfig.toolId === 'feedback'
        ? await migrateLegacyFeedbackStatuses(
            token,
            context,
            toolConfig,
            fetchRecords,
            updateRecord,
          )
        : 0;

      return { updated, migratedRecords, fields };
    });
  }

  async function migrateSchemas(token, toolConfigs) {
    const summary = {
      scanned: 0,
      updated: 0,
      unchanged: 0,
      migratedRecords: 0,
      failed: 0,
      failures: [],
    };

    for (const toolConfig of toolConfigs || []) {
      if (getRequiredRelationFieldNames(toolConfig).length === 0) {
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
        summary.failures.push(buildFailure(toolConfig, toolConfig.parentName, error));
        continue;
      }

      let childNodes;
      try {
        childNodes = await fetchChildNodes(token, parentNode.nodeToken);
      } catch (error) {
        summary.failed += 1;
        summary.failures.push(buildFailure(toolConfig, toolConfig.parentName, error));
        continue;
      }

      for (const node of childNodes || []) {
        if (!isBitableNode(node)) {
          continue;
        }
        summary.scanned += 1;
        try {
          const context = await resolveTableContext(token, node, toolConfig);
          const result = await ensureSchema(token, context, toolConfig, {
            migrateLegacyFeedbackStatuses: true,
          });
          summary.migratedRecords += result.migratedRecords;
          if (result.updated || result.migratedRecords > 0) {
            summary.updated += 1;
          } else {
            summary.unchanged += 1;
          }
        } catch (error) {
          summary.failed += 1;
          summary.failures.push(buildFailure(toolConfig, node.title, error));
        }
      }
    }

    return summary;
  }

  return {
    ensureSchema,
    migrateSchemas,
  };
}

export function getRequiredRelationFieldNames(toolConfig) {
  if (toolConfig?.toolId === 'feedback') {
    return [String(toolConfig?.fieldNames?.relatedItem || '').trim()].filter(Boolean);
  }
  if (toolConfig?.toolId === 'requirements' || toolConfig?.toolId === 'bugs') {
    return [String(toolConfig?.fieldNames?.relatedFeedback || '').trim()].filter(Boolean);
  }
  return [];
}

async function migrateLegacyFeedbackStatuses(
  token,
  context,
  toolConfig,
  fetchRecords,
  updateRecord,
) {
  const statusField = String(toolConfig?.fieldNames?.status || '').trim();
  if (!statusField) {
    return 0;
  }
  const records = await fetchRecords(token, {
    appToken: context.appToken,
    tableId: context.tableId,
    viewId: '',
    fieldNames: { status: statusField },
  });
  let updated = 0;
  for (const record of records || []) {
    const status = normalizeTextValue(record?.fields?.[statusField]);
    if (!FEEDBACK_LEGACY_ACTIVE_STATUSES.includes(status)) {
      continue;
    }
    const recordId = String(record?.record_id || record?.recordId || '').trim();
    if (!recordId) {
      continue;
    }
    await updateRecord(token, context.appToken, context.tableId, recordId, {
      [statusField]: FEEDBACK_STATUSES.waiting,
    });
    updated += 1;
  }
  return updated;
}

function findField(fields, fieldName) {
  return (fields || []).find(
    (field) => String(field?.field_name || field?.fieldName || '').trim() === fieldName,
  ) || null;
}

function assertTextField(field, toolConfig, fieldName) {
  const type = Number(field?.type);
  const uiType = String(field?.ui_type || field?.uiType || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
  if (type !== 1 && !uiType.includes('text')) {
    throw new Error(`${toolConfig.itemLabel}表字段“${fieldName}”必须是文本类型`);
  }
}

function normalizeTextValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeTextValue).join('');
  }
  if (value && typeof value === 'object') {
    return normalizeTextValue(value.text ?? value.value ?? value.name ?? '');
  }
  return String(value ?? '').trim();
}

function buildFailure(toolConfig, nodeTitle, error) {
  return {
    toolId: String(toolConfig?.toolId || ''),
    nodeTitle: String(nodeTitle || ''),
    message: error instanceof Error ? error.message : String(error || '迁移失败'),
  };
}

const defaultService = createWorkItemRelationSchemaService();

export const ensureWorkItemRelationSchema = defaultService.ensureSchema;
export const migrateWorkItemRelationSchemas = defaultService.migrateSchemas;
