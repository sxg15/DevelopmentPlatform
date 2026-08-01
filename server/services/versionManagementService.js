import crypto from 'node:crypto';

import {
  VERSION_ACTIVE_STATUSES,
  VERSION_ASSOCIATION_TOOL_IDS,
  VERSION_PLATFORMS,
  VERSION_STATUSES,
  buildAssociationSnapshots,
  buildVersionComment,
  buildVersionOverview,
  buildVersionStatusChange,
  findActiveVersionConflict,
  isEmptyVersionRecord,
  normalizeVersionFieldNames,
  normalizeVersionRecord,
  parseVersionCommentsDocument,
  parseVersionStatusHistoryDocument,
  serializeVersionCommentForClient,
  serializeVersionRecordForClient,
  serializePreviousVersionDocument,
  serializeVersionItemsDocument,
  validatePreviousVersionReference,
  validateVersionIdentity,
  validateVersionStatus,
} from '../../shared/versionManagementUtils.js';
import {
  WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS,
} from '../../shared/workItemVersionAssociationUtils.js';
import { runtimeConfig } from '../config/runtimeConfig.js';
import {
  createBitableRecord,
  deleteBitableRecord,
  fetchBitableFields,
  fetchBitableRecords,
  fetchBitableTables,
  updateBitableRecordFields,
} from '../integrations/bitableClient.js';
import {
  copyWikiNode,
  createWikiNode,
  findWikiNodeByExactTitle,
  findWikiNodeByTitle,
  getCachedWikiChildNodes,
  isWikiBitableNode,
  wait,
} from '../integrations/wikiClient.js';
import { createKeyedTaskQueue } from '../runtime/keyedTaskQueue.js';
import { findIdempotentMutation } from '../runtime/idempotentMutation.js';

const COPY_RETRY_DELAYS_MS = [0, 1000, 2000, 3000, 5000, 8000];

export function createVersionManagementService({
  config = runtimeConfig.bitable.versionManagement,
  loadCompletedWorkItemCandidates = async () => createEmptyCandidateResult(),
  queue = createKeyedTaskQueue(),
  bitable = {
    createRecord: createBitableRecord,
    deleteRecord: deleteBitableRecord,
    fetchFields: fetchBitableFields,
    fetchRecords: fetchBitableRecords,
    fetchTables: fetchBitableTables,
    updateRecord: updateBitableRecordFields,
  },
  wiki = {
    copyNode: copyWikiNode,
    createNode: createWikiNode,
    findNodeByTitle: findWikiNodeByTitle,
    getChildren: getCachedWikiChildNodes,
  },
  onTableContextResolved = () => {},
  now = () => new Date(),
  randomId = () => crypto.randomUUID(),
} = {}) {
  const normalizedConfig = {
    wikiNodeToken: String(config?.wikiNodeToken || '').trim(),
    parentName: String(config?.parentName || '版本管理').trim(),
    tableId: String(config?.tableId || '').trim(),
    viewId: String(config?.viewId || '').trim(),
    fieldNames: normalizeVersionFieldNames(config?.fieldNames),
  };
  const getCandidateResult = async (token, project, user) => normalizeCandidateResult(
    await loadCompletedWorkItemCandidates(token, project, user),
  );

  async function ensure(token, project, user) {
    return queue.run(buildQueueKey(project), async () => {
      const context = await ensureProjectContext(token, project);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      const cleanedRecordIds = [];
      for (const version of data.versions.filter(isEmptyVersionRecord)) {
        if (!version.recordId) {
          continue;
        }
        await bitable.deleteRecord(token, context.appToken, context.tableId, version.recordId);
        cleanedRecordIds.push(version.recordId);
      }
      const refreshedData = cleanedRecordIds.length > 0
        ? await readContextData(token, context, { consistency: 'fresh' })
        : data;
      return buildReadResult(
        refreshedData,
        await getCandidateResult(token, project, user),
        context.created ? 'created' : 'exists',
      );
    });
  }

  async function readOne(token, project, recordId) {
    const context = await findProjectContext(token, project.projectId);
    if (!context) {
      throw new Error('项目版本管理尚未初始化');
    }
    const data = await readContextData(token, context);
    const version = data.versions.find((item) => item.recordId === recordId && !isEmptyVersionRecord(item));
    if (!version) {
      throw new Error('版本记录不存在');
    }
    return {
      version: serializeVersionRecordForClient(version),
      warnings: data.warnings,
    };
  }

  async function createVersion(token, project, user, payload) {
    return queue.run(buildQueueKey(project), async () => {
      const context = await ensureProjectContext(token, project);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      const versions = data.versions.filter((version) => !isEmptyVersionRecord(version));
      const versionNumber = String(payload?.versionNumber || '').trim();
      const platform = String(payload?.platform || '').trim();
      const status = validateVersionStatus(payload?.status || '测试开发');
      validateVersionIdentity({ versions, versionNumber, platform });
      const previousVersion = validatePreviousVersionReference(versions, {
        previousRecordId: payload?.previousVersionRecordId,
      });
      const candidateResult = await getCandidateResult(token, project, user);
      const associations = buildAssociationFields(payload?.associations, candidateResult.candidates);
      const initialChange = buildVersionStatusChange({
        id: randomId(),
        oldStatus: '',
        newStatus: status,
        changedAt: now(),
        operator: user,
        reason: String(payload?.reason || '').trim() || '创建版本',
      });
      const conflict = findActiveVersionConflict(versions, { platform, status });
      const rollback = conflict
        ? await moveConflictToObsolete(token, context, conflict, user, buildReplacementReason(versionNumber, platform, status))
        : null;
      let targetApplied = false;

      try {
        const createdRecord = await bitable.createRecord(token, context.appToken, context.tableId, {
          [normalizedConfig.fieldNames.versionNumber]: versionNumber,
          [normalizedConfig.fieldNames.status]: status,
          [normalizedConfig.fieldNames.platform]: platform,
          [normalizedConfig.fieldNames.requirements]: serializeVersionItemsDocument(associations.requirements),
          [normalizedConfig.fieldNames.bugs]: serializeVersionItemsDocument(associations.bugs),
          [normalizedConfig.fieldNames.feedback]: serializeVersionItemsDocument(associations.feedback),
          [normalizedConfig.fieldNames.previousVersion]: serializePreviousVersionDocument(previousVersion),
          [normalizedConfig.fieldNames.statusHistory]: serializeVersionItemsDocument([initialChange]),
          [normalizedConfig.fieldNames.comments]: serializeVersionItemsDocument([]),
        });
        targetApplied = true;
        const recordId = getRecordId(createdRecord);
        const refreshed = await readContextData(token, context, { consistency: 'fresh' });
        const version = refreshed.versions.find((item) => item.recordId === recordId)
          || normalizeVersionRecord(createdRecord, normalizedConfig.fieldNames);
        return {
          version: serializeVersionRecordForClient(version),
          versions: serializeVersionsForClient(refreshed.versions),
          replacedVersion: serializeOptionalVersionForClient(rollback?.version),
          warnings: [...refreshed.warnings, ...candidateResult.warnings],
        };
      } catch (error) {
        if (!targetApplied) {
          await restoreConflict(token, context, rollback);
        }
        throw error;
      }
    });
  }

  async function updateVersion(token, project, user, recordId, payload) {
    return queue.run(buildQueueKey(project), async () => {
      const context = await requireProjectContext(token, project.projectId);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      const versions = data.versions.filter((version) => !isEmptyVersionRecord(version));
      const current = requireVersion(versions, recordId);
      const versionNumber = String(payload?.versionNumber || '').trim();
      const platform = String(payload?.platform || '').trim();
      validateVersionIdentity({ versions, recordId, versionNumber, platform });
      const previousVersion = validatePreviousVersionReference(versions, {
        recordId,
        previousRecordId: payload?.previousVersionRecordId,
      });
      const candidateResult = await getCandidateResult(token, project, user);
      const associations = buildAssociationFields(
        payload?.associations,
        candidateResult.candidates,
        current,
      );
      const conflict = findActiveVersionConflict(versions, {
        recordId,
        platform,
        status: current.status,
      });
      const rollback = conflict
        ? await moveConflictToObsolete(
            token,
            context,
            conflict,
            user,
            buildReplacementReason(versionNumber, platform, current.status),
          )
        : null;
      let targetApplied = false;

      try {
        await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
          [normalizedConfig.fieldNames.versionNumber]: versionNumber,
          [normalizedConfig.fieldNames.platform]: platform,
          [normalizedConfig.fieldNames.requirements]: serializeVersionItemsDocument(associations.requirements),
          [normalizedConfig.fieldNames.bugs]: serializeVersionItemsDocument(associations.bugs),
          [normalizedConfig.fieldNames.feedback]: serializeVersionItemsDocument(associations.feedback),
          [normalizedConfig.fieldNames.previousVersion]: serializePreviousVersionDocument(previousVersion),
        });
        targetApplied = true;
        const refreshed = await readContextData(token, context, { consistency: 'fresh' });
        return {
          version: serializeVersionRecordForClient(
            requireVersion(refreshed.versions, recordId),
          ),
          versions: serializeVersionsForClient(refreshed.versions),
          replacedVersion: serializeOptionalVersionForClient(rollback?.version),
          warnings: [...refreshed.warnings, ...candidateResult.warnings],
        };
      } catch (error) {
        if (!targetApplied) {
          await restoreConflict(token, context, rollback);
        }
        throw error;
      }
    });
  }

  async function changeStatus(token, project, user, recordId, payload) {
    return queue.run(buildQueueKey(project), async () => {
      const reason = String(payload?.reason || '').trim();
      if (!reason) {
        throw new Error('状态变更原因不能为空');
      }
      if (reason.length > 2000) {
        throw new Error('状态变更原因不能超过2000字');
      }

      const context = await requireProjectContext(token, project.projectId);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      const versions = data.versions.filter((version) => !isEmptyVersionRecord(version));
      const current = requireVersion(versions, recordId);
      const newStatus = validateVersionStatus(payload?.newStatus);
      if (current.status === newStatus) {
        throw new Error('版本状态没有变化');
      }
      const history = parseVersionStatusHistoryDocument(
        getRawField(data.records, recordId, normalizedConfig.fieldNames.statusHistory),
        { throwOnInvalid: true },
      );
      const change = buildVersionStatusChange({
        id: randomId(),
        oldStatus: current.status,
        newStatus,
        changedAt: now(),
        operator: user,
        reason,
      });
      const conflict = findActiveVersionConflict(versions, {
        recordId,
        platform: current.platform,
        status: newStatus,
      });
      const rollback = conflict
        ? await moveConflictToObsolete(
            token,
            context,
            conflict,
            user,
            buildReplacementReason(current.versionNumber, current.platform, newStatus),
          )
        : null;
      let targetApplied = false;

      try {
        await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
          [normalizedConfig.fieldNames.status]: newStatus,
          [normalizedConfig.fieldNames.statusHistory]: serializeVersionItemsDocument([
            ...history.items,
            change,
          ]),
        });
        targetApplied = true;
        const refreshed = await readContextData(token, context, { consistency: 'fresh' });
        return {
          version: serializeVersionRecordForClient(
            requireVersion(refreshed.versions, recordId),
          ),
          versions: serializeVersionsForClient(refreshed.versions),
          statusChange: change,
          replacedVersion: serializeOptionalVersionForClient(rollback?.version),
          warnings: refreshed.warnings,
        };
      } catch (error) {
        if (!targetApplied) {
          await restoreConflict(token, context, rollback);
        }
        throw error;
      }
    });
  }

  async function deleteVersion(token, project, recordId) {
    return queue.run(buildQueueKey(project), async () => {
      const context = await requireProjectContext(token, project.projectId);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      const versions = data.versions.filter((version) => !isEmptyVersionRecord(version));
      requireVersion(versions, recordId);
      const referencing = versions.find((version) => version.previousVersion?.recordId === recordId);
      if (referencing) {
        throw new Error(`版本“${referencing.versionNumber}”仍引用该版本，不能删除`);
      }
      await bitable.deleteRecord(token, context.appToken, context.tableId, recordId);
      return {
        deletedRecordId: recordId,
        versions: serializeVersionsForClient(
          versions.filter((version) => version.recordId !== recordId),
        ),
      };
    });
  }

  async function createComment(token, project, user, recordId, payload) {
    return queue.run(buildQueueKey(project), async () => {
      const content = String(payload?.content || '').trim();
      if (content.length > 2000) {
        throw new Error('留言内容不能超过2000字');
      }
      const context = await requireProjectContext(token, project.projectId);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      requireVersion(data.versions, recordId);
      const comments = parseVersionCommentsDocument(
        getRawField(data.records, recordId, normalizedConfig.fieldNames.comments),
        { throwOnInvalid: true },
      );
      const clientMutationId = String(payload?.clientMutationId || '').trim().slice(0, 100);
      const mutationFingerprint = String(payload?.mutationFingerprint || '').trim().slice(0, 100);
      const existingComment = findIdempotentMutation({
        items: comments.items,
        clientMutationId,
        mutationFingerprint,
        belongsToActor: (comment) => isSameUser(comment, user),
        conflictMessage: 'clientMutationId 已用于不同的版本留言',
      });
      if (existingComment) {
        return {
          comment: serializeVersionCommentForClient(existingComment),
          version: serializeVersionRecordForClient(
            requireVersion(data.versions, recordId),
          ),
          warnings: data.warnings,
          duplicate: true,
        };
      }
      const comment = buildVersionComment({
        id: randomId(),
        author: user,
        content,
        mentionedUsers: payload?.mentionedUsers,
        createdAt: now(),
        clientMutationId,
        mutationFingerprint,
        notifyMentioned: payload?.notifyMentioned,
      });
      await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
        [normalizedConfig.fieldNames.comments]: serializeVersionItemsDocument([
          ...comments.items,
          comment,
        ]),
      });
      const refreshed = await readContextData(token, context, { consistency: 'fresh' });
      return {
        comment: serializeVersionCommentForClient(comment),
        version: serializeVersionRecordForClient(
          requireVersion(refreshed.versions, recordId),
        ),
        warnings: refreshed.warnings,
        duplicate: false,
      };
    });
  }

  async function deleteComment(token, project, user, recordId, commentId) {
    return queue.run(buildQueueKey(project), async () => {
      const context = await requireProjectContext(token, project.projectId);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      requireVersion(data.versions, recordId);
      const comments = parseVersionCommentsDocument(
        getRawField(data.records, recordId, normalizedConfig.fieldNames.comments),
        { throwOnInvalid: true },
      );
      const comment = comments.items.find((item) => item.id === commentId);
      if (!comment) {
        throw new Error('留言不存在');
      }
      if (!isSameUser(comment, user)) {
        throw new Error('只能删除自己发布的留言');
      }
      await bitable.updateRecord(token, context.appToken, context.tableId, recordId, {
        [normalizedConfig.fieldNames.comments]: serializeVersionItemsDocument(
          comments.items.filter((item) => item.id !== commentId),
        ),
      });
      const refreshed = await readContextData(token, context, { consistency: 'fresh' });
      return {
        version: serializeVersionRecordForClient(
          requireVersion(refreshed.versions, recordId),
        ),
        warnings: refreshed.warnings,
      };
    });
  }

  async function readOverview(token, projectId) {
    const context = await findProjectContext(token, projectId);
    if (!context) {
      return {
        initialized: false,
        platforms: VERSION_PLATFORMS.map((platform) => ({
          platform,
          active: Object.fromEntries(VERSION_ACTIVE_STATUSES.map((status) => [status, null])),
        })),
        recentFormalReleases: [],
        warnings: [],
      };
    }
    const data = await readContextData(token, context);
    return {
      ...buildVersionOverview(data.versions),
      warnings: data.warnings,
    };
  }

  async function ensureProjectContext(token, project) {
    const existing = await findProjectContext(token, project.projectId);
    if (existing) {
      return { ...existing, created: false };
    }
    const parent = (await wiki.findNodeByTitle(token, normalizedConfig.parentName))
      || (await wiki.createNode(token, '', normalizedConfig.parentName));
    if (!parent?.nodeToken) {
      throw new Error('无法创建版本管理知识库节点');
    }
    if (!normalizedConfig.wikiNodeToken) {
      throw new Error('缺少版本管理模板配置');
    }
    const copied = await wiki.copyNode(
      token,
      normalizedConfig.wikiNodeToken,
      parent.nodeToken,
      project.projectId,
    );
    const context = await resolveContextWithRetry(token, copied);
    return registerResolvedContext({ ...context, projectId: project.projectId, created: true });
  }

  async function findProjectContext(token, projectId) {
    const parent = await wiki.findNodeByTitle(token, normalizedConfig.parentName);
    if (!parent?.nodeToken) {
      return null;
    }
    const children = await wiki.getChildren(token, parent.nodeToken);
    const projectNode = findWikiNodeByExactTitle(children, projectId);
    if (!projectNode) {
      return null;
    }
    if (!isWikiBitableNode(projectNode)) {
      throw new Error(`${projectId}的版本管理节点不是多维表格`);
    }
    const context = await resolveContext(token, projectNode);
    return registerResolvedContext({ ...context, projectId });
  }

  async function requireProjectContext(token, projectId) {
    const context = await findProjectContext(token, projectId);
    if (!context) {
      throw new Error('项目版本管理尚未初始化');
    }
    return context;
  }

  async function resolveContextWithRetry(token, node) {
    let lastError = null;
    for (const delay of COPY_RETRY_DELAYS_MS) {
      if (delay > 0) {
        await wait(delay);
      }
      try {
        return await resolveContext(token, node);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('版本管理模板复制超时');
  }

  async function resolveContext(token, node) {
    if (!node?.objToken) {
      throw new Error('版本管理节点没有关联多维表格');
    }
    const tables = await bitable.fetchTables(token, node.objToken);
    const configuredTable = normalizedConfig.tableId
      ? tables.find((table) => getTableId(table) === normalizedConfig.tableId)
      : null;
    const table = configuredTable || tables[0];
    const tableId = getTableId(table);
    if (!tableId) {
      throw new Error('版本管理多维表格没有可读取的数据表');
    }
    return {
      node,
      appToken: node.objToken,
      tableId,
      viewId: normalizedConfig.viewId,
    };
  }

  async function readContextData(token, context, { consistency = 'cache' } = {}) {
    const [fields, records] = await Promise.all([
      bitable.fetchFields(token, context.appToken, context.tableId),
      bitable.fetchRecords(token, {
        appToken: context.appToken,
        tableId: context.tableId,
        viewId: context.viewId,
        fieldNames: normalizedConfig.fieldNames,
      }, { consistency }),
    ]);
    validateSchema(fields);
    const versions = records.map((record) => normalizeVersionRecord(record, normalizedConfig.fieldNames));
    return {
      fields,
      records,
      versions,
      warnings: versions.flatMap((version) => version.warnings),
    };
  }

  async function inspectWorkItemAssociations(token, project, {
    toolId,
    workItemRecordId,
    operation,
  }) {
    validateWorkItemAssociationOperation(toolId, operation);
    return queue.run(buildQueueKey(project), async () => {
      const context = await findProjectContext(token, project.projectId);
      if (!context) {
        return {
          initialized: false,
          operation,
          versions: [],
        };
      }

      const data = await readContextData(token, context, { consistency: 'fresh' });
      const versions = data.versions.filter((version) => !isEmptyVersionRecord(version));
      const relevantVersions = operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.ASSOCIATE
        ? versions.filter((version) => version.status === '测试开发')
        : versions;
      assertAssociationDocumentsReadable(relevantVersions, toolId);
      const normalizedRecordId = String(workItemRecordId || '').trim();
      const candidates = relevantVersions.filter((version) => {
        const associated = version[toolId].some((item) => item.recordId === normalizedRecordId);
        return operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.ASSOCIATE
          ? !associated
          : associated;
      });

      return {
        initialized: true,
        operation,
        versions: candidates.map(toAssociationVersionSnapshot),
      };
    });
  }

  async function applyWorkItemAssociationDecision(token, project, {
    toolId,
    workItem,
    operation,
    versionRecordIds,
  }) {
    validateWorkItemAssociationOperation(toolId, operation);
    const requestedRecordIds = [...new Set(
      (Array.isArray(versionRecordIds) ? versionRecordIds : [])
        .map((recordId) => String(recordId || '').trim())
        .filter(Boolean),
    )];
    if (requestedRecordIds.length === 0) {
      return {
        operation,
        requestedVersionRecordIds: [],
        changedVersions: [],
        unchangedVersionRecordIds: [],
      };
    }
    const associationSnapshot = normalizeWorkItemAssociationSnapshot(workItem);

    return queue.run(buildQueueKey(project), async () => {
      const context = await requireProjectContext(token, project.projectId);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      const versions = data.versions.filter((version) => !isEmptyVersionRecord(version));
      const versionByRecordId = new Map(versions.map((version) => [version.recordId, version]));
      const selectedVersions = requestedRecordIds.map((recordId) => {
        const version = versionByRecordId.get(recordId);
        if (!version) {
          throw createVersionConflictError('所选版本已不存在，请重新选择');
        }
        return version;
      });
      if (
        operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.ASSOCIATE
        && selectedVersions.some((version) => version.status !== '测试开发')
      ) {
        throw createVersionConflictError('所选版本已不再是测试开发版本，请重新选择');
      }
      assertAssociationDocumentsReadable(selectedVersions, toolId);

      const fieldName = normalizedConfig.fieldNames[toolId];
      const changes = selectedVersions.flatMap((version) => {
        const existing = Array.isArray(version[toolId]) ? version[toolId] : [];
        const alreadyAssociated = existing.some(
          (item) => item.recordId === associationSnapshot.recordId,
        );
        if (
          (operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.ASSOCIATE && alreadyAssociated)
          || (operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.UNLINK && !alreadyAssociated)
        ) {
          return [];
        }
        const nextItems = operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.ASSOCIATE
          ? [...existing, associationSnapshot]
          : existing.filter((item) => item.recordId !== associationSnapshot.recordId);
        return [{
          version,
          originalValue: getRawField(data.records, version.recordId, fieldName),
          nextValue: serializeVersionItemsDocument(nextItems),
        }];
      });
      const applied = [];

      try {
        for (const change of changes) {
          await bitable.updateRecord(token, context.appToken, context.tableId, change.version.recordId, {
            [fieldName]: change.nextValue,
          });
          applied.push(change);
        }
      } catch (error) {
        let rollbackFailure = null;
        for (const change of [...applied].reverse()) {
          try {
            await bitable.updateRecord(token, context.appToken, context.tableId, change.version.recordId, {
              [fieldName]: change.originalValue,
            });
          } catch (rollbackError) {
            rollbackFailure = rollbackError;
            break;
          }
        }
        if (rollbackFailure) {
          throw createVersionConflictError(
            `版本关联写入失败，且回滚失败：${rollbackFailure instanceof Error ? rollbackFailure.message : '未知错误'}`,
          );
        }
        throw error;
      }

      const changedRecordIds = new Set(changes.map((change) => change.version.recordId));
      return {
        operation,
        requestedVersionRecordIds: requestedRecordIds,
        changedVersions: selectedVersions
          .filter((version) => changedRecordIds.has(version.recordId))
          .map(toAssociationVersionSnapshot),
        unchangedVersionRecordIds: requestedRecordIds.filter(
          (recordId) => !changedRecordIds.has(recordId),
        ),
      };
    });
  }

  async function validateWorkItemAssociationDecision(token, project, {
    toolId,
    operation,
    versionRecordIds,
  }) {
    validateWorkItemAssociationOperation(toolId, operation);
    const requestedRecordIds = [...new Set(
      (Array.isArray(versionRecordIds) ? versionRecordIds : [])
        .map((recordId) => String(recordId || '').trim())
        .filter(Boolean),
    )];
    if (requestedRecordIds.length === 0) {
      return { versions: [] };
    }

    return queue.run(buildQueueKey(project), async () => {
      const context = await requireProjectContext(token, project.projectId);
      const data = await readContextData(token, context, { consistency: 'fresh' });
      const versionByRecordId = new Map(
        data.versions
          .filter((version) => !isEmptyVersionRecord(version))
          .map((version) => [version.recordId, version]),
      );
      const selectedVersions = requestedRecordIds.map((recordId) => {
        const version = versionByRecordId.get(recordId);
        if (!version) {
          throw createVersionConflictError('所选版本已不存在，请重新选择');
        }
        return version;
      });
      if (
        operation === WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS.ASSOCIATE
        && selectedVersions.some((version) => version.status !== '测试开发')
      ) {
        throw createVersionConflictError('所选版本已不再是测试开发版本，请重新选择');
      }
      assertAssociationDocumentsReadable(selectedVersions, toolId);
      return {
        versions: selectedVersions.map(toAssociationVersionSnapshot),
      };
    });
  }

  function registerResolvedContext(context) {
    try {
      onTableContextResolved({
        appToken: context.appToken,
        tableId: context.tableId,
        viewId: context.viewId,
        fieldNames: normalizedConfig.fieldNames,
        projectId: context.projectId,
        toolId: 'versions',
      });
    } catch {
      // Realtime registration is optional and must not block version reads.
    }
    return context;
  }

  function validateSchema(fields) {
    const fieldByName = new Map((Array.isArray(fields) ? fields : []).map((field) => [
      String(field?.field_name || field?.fieldName || '').trim(),
      field,
    ]));
    const missing = Object.values(normalizedConfig.fieldNames).filter((fieldName) => !fieldByName.has(fieldName));
    if (missing.length > 0) {
      throw new Error(`版本管理模板缺少字段：${missing.join('、')}`);
    }
    for (const key of [
      'versionNumber',
      'requirements',
      'bugs',
      'feedback',
      'statusHistory',
      'comments',
      'previousVersion',
    ]) {
      validateFieldType(fieldByName.get(normalizedConfig.fieldNames[key]), 1, normalizedConfig.fieldNames[key]);
    }
    validateFieldType(fieldByName.get(normalizedConfig.fieldNames.status), 3, normalizedConfig.fieldNames.status);
    validateFieldType(fieldByName.get(normalizedConfig.fieldNames.platform), 3, normalizedConfig.fieldNames.platform);
    validateSelectFieldOptions(fieldByName.get(normalizedConfig.fieldNames.status), VERSION_STATUSES, '状态');
    validateSelectFieldOptions(fieldByName.get(normalizedConfig.fieldNames.platform), VERSION_PLATFORMS, '平台');
  }

  async function moveConflictToObsolete(token, context, version, operator, reason) {
    const rawRecord = await findRawRecord(token, context, version.recordId);
    const rawHistory = getRawFieldFromRecord(rawRecord, normalizedConfig.fieldNames.statusHistory);
    const history = parseVersionStatusHistoryDocument(rawHistory, { throwOnInvalid: true });
    const automaticChange = buildVersionStatusChange({
      id: randomId(),
      oldStatus: version.status,
      newStatus: '过时',
      changedAt: now(),
      operator,
      reason,
      automatic: true,
    });
    await bitable.updateRecord(token, context.appToken, context.tableId, version.recordId, {
      [normalizedConfig.fieldNames.status]: '过时',
      [normalizedConfig.fieldNames.statusHistory]: serializeVersionItemsDocument([
        ...history.items,
        automaticChange,
      ]),
    });
    return {
      version,
      recordId: version.recordId,
      originalFields: {
        [normalizedConfig.fieldNames.status]: getRawFieldFromRecord(rawRecord, normalizedConfig.fieldNames.status),
        [normalizedConfig.fieldNames.statusHistory]: rawHistory,
      },
    };
  }

  async function restoreConflict(token, context, rollback) {
    if (!rollback) {
      return;
    }
    try {
      await bitable.updateRecord(
        token,
        context.appToken,
        context.tableId,
        rollback.recordId,
        rollback.originalFields,
      );
    } catch (error) {
      const rollbackError = new Error(`版本变更失败，且自动替换状态回滚失败：${error instanceof Error ? error.message : '未知错误'}`);
      rollbackError.cause = error;
      throw rollbackError;
    }
  }

  async function findRawRecord(token, context, recordId) {
    const records = await bitable.fetchRecords(token, {
      appToken: context.appToken,
      tableId: context.tableId,
      viewId: context.viewId,
      fieldNames: normalizedConfig.fieldNames,
    }, { consistency: 'fresh' });
    const record = records.find((item) => getRecordId(item) === recordId);
    if (!record) {
      throw new Error('版本记录不存在');
    }
    return record;
  }

  return {
    ensure,
    readOne,
    createVersion,
    updateVersion,
    changeStatus,
    deleteVersion,
    createComment,
    deleteComment,
    readOverview,
    inspectWorkItemAssociations,
    validateWorkItemAssociationDecision,
    applyWorkItemAssociationDecision,
  };
}

function buildReadResult(data, candidateResult, status) {
  return {
    status,
    created: status === 'created',
    existed: status === 'exists',
    versions: serializeVersionsForClient(data.versions),
    statusOptions: VERSION_STATUSES,
    platformOptions: VERSION_PLATFORMS,
    completedWorkItems: candidateResult.candidates,
    warnings: [...data.warnings, ...candidateResult.warnings],
  };
}

function serializeVersionsForClient(versions) {
  return (Array.isArray(versions) ? versions : [])
    .filter((version) => !isEmptyVersionRecord(version))
    .map(serializeVersionRecordForClient);
}

function serializeOptionalVersionForClient(version) {
  return version ? serializeVersionRecordForClient(version) : null;
}

function createEmptyCandidateResult() {
  return {
    candidates: Object.fromEntries(VERSION_ASSOCIATION_TOOL_IDS.map((toolId) => [toolId, []])),
    warnings: [],
  };
}

function normalizeCandidateResult(value) {
  const fallback = createEmptyCandidateResult();
  return {
    candidates: Object.fromEntries(VERSION_ASSOCIATION_TOOL_IDS.map((toolId) => [
      toolId,
      Array.isArray(value?.candidates?.[toolId]) ? value.candidates[toolId] : fallback.candidates[toolId],
    ])),
    warnings: Array.isArray(value?.warnings)
      ? value.warnings.map((warning) => String(warning || '').trim()).filter(Boolean)
      : [],
  };
}

function buildAssociationFields(value, candidates, current = null) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(VERSION_ASSOCIATION_TOOL_IDS.map((toolId) => [
    toolId,
    buildAssociationSelection(
      source[toolId],
      candidates?.[toolId],
      current?.[toolId],
    ),
  ]));
}

function buildAssociationSelection(selectedIds, candidates, existing) {
  const selected = [...new Set(
    (Array.isArray(selectedIds) ? selectedIds : [])
      .map((recordId) => String(recordId || '').trim())
      .filter(Boolean),
  )];
  const completedSnapshots = buildAssociationSnapshots(
    selected.filter((recordId) => (candidates || []).some((candidate) => candidate.recordId === recordId)),
    candidates,
  );
  const snapshotsById = new Map(completedSnapshots.map((item) => [item.recordId, item]));
  for (const item of Array.isArray(existing) ? existing : []) {
    if (selected.includes(item.recordId) && !snapshotsById.has(item.recordId)) {
      snapshotsById.set(item.recordId, item);
    }
  }
  if (snapshotsById.size !== selected.length) {
    throw new Error('只能新增当前已完成或已关闭的工作项关联');
  }
  return selected.map((recordId) => snapshotsById.get(recordId));
}

function requireVersion(versions, recordId) {
  const version = (Array.isArray(versions) ? versions : []).find((item) => item.recordId === recordId);
  if (!version) {
    throw new Error('版本记录不存在');
  }
  return version;
}

function buildReplacementReason(versionNumber, platform, status) {
  return `版本 ${versionNumber} 占用 ${platform} 的“${status}”状态槽位`;
}

function validateWorkItemAssociationOperation(toolId, operation) {
  if (!VERSION_ASSOCIATION_TOOL_IDS.includes(String(toolId || '').trim())) {
    throw new Error('版本关联工作项类型不受支持');
  }
  if (!Object.values(WORK_ITEM_VERSION_ASSOCIATION_OPERATIONS).includes(operation)) {
    throw new Error('版本关联操作不在可选范围内');
  }
}

function assertAssociationDocumentsReadable(versions, toolId) {
  const malformed = (Array.isArray(versions) ? versions : []).find(
    (version) => String(version?.parseErrors?.[toolId] || '').trim(),
  );
  if (malformed) {
    throw createVersionConflictError(
      `版本“${malformed.versionNumber || malformed.recordId}”的关联字段不是合法 JSON`,
    );
  }
}

function normalizeWorkItemAssociationSnapshot(workItem) {
  const recordId = String(workItem?.recordId || workItem?.record_id || '').trim();
  if (!recordId) {
    throw new Error('缺少工作项记录ID');
  }
  return {
    recordId,
    itemId: String(
      workItem?.itemId
      || workItem?.requirementId
      || workItem?.bugId
      || workItem?.feedbackId
      || '',
    ).trim(),
    title: String(workItem?.title || '').trim() || '未命名工作项',
  };
}

function toAssociationVersionSnapshot(version) {
  return {
    recordId: String(version?.recordId || '').trim(),
    versionNumber: String(version?.versionNumber || '').trim(),
    platform: String(version?.platform || '').trim(),
    status: String(version?.status || '').trim(),
  };
}

function createVersionConflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function buildQueueKey(project) {
  return `version-management:${String(project?.projectId || project || '').trim()}`;
}

function getRecordId(record) {
  return String(record?.record_id || record?.recordId || record?.id || '').trim();
}

function getTableId(table) {
  return String(table?.table_id || table?.tableId || table?.id || '').trim();
}

function getRawField(records, recordId, fieldName) {
  const record = (Array.isArray(records) ? records : []).find((item) => getRecordId(item) === recordId);
  return getRawFieldFromRecord(record, fieldName);
}

function getRawFieldFromRecord(record, fieldName) {
  return record?.fields?.[fieldName] ?? '';
}

function validateSelectFieldOptions(field, expectedOptions, label) {
  const options = field?.property?.options || field?.property?.option || [];
  const names = (Array.isArray(options) ? options : [])
    .map((option) => String(option?.name || option?.label || option || '').trim())
    .filter(Boolean);
  const missing = expectedOptions.filter((option) => !names.includes(option));
  if (names.length > 0 && missing.length > 0) {
    throw new Error(`版本管理“${label}”字段缺少选项：${missing.join('、')}`);
  }
}

function validateFieldType(field, expectedType, label) {
  const type = Number(field?.type ?? field?.field_type ?? field?.fieldType);
  if (Number.isFinite(type) && type !== expectedType) {
    throw new Error(`版本管理“${label}”字段类型不正确`);
  }
}

function isSameUser(comment, user) {
  const authorOpenId = String(comment?.authorOpenId || '').trim();
  const openId = String(user?.openId || user?.open_id || '').trim();
  if (authorOpenId && openId) {
    return authorOpenId === openId;
  }
  return String(comment?.authorName || '').trim() === String(user?.name || '').trim();
}
