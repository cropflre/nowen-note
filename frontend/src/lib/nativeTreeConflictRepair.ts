import type { NativeDatabase } from "./nativeDatabase";
import { newLocalId } from "./localRepository";
import {
  applyNativePersonalTree, assertNativePersonalTreeEntry, assertNativePersonalTreeGraph,
  NATIVE_TREE_ENTITY_SET, nativeTreeSubscriptionKey,
} from "./nativeKnowledgeTreeSync";
import {
  nativeTreeMutationPayload, personalWriteProofs, sameNativeTreePosition,
  syncNativeNotebookMoveParents, type NativeTreeWriteContext,
} from "./nativePersonalTreeWrites";

export type NativeTreeRepairStrategy = "keep-remote" | "keep-local";
type Node = Record<string, unknown> & { id: string; parentId: string | null; isDeleted: number; sortOrder: number };
type Conflict = { id: string; entityId: string; localPayload: string | null; remotePayload: string | null };
type Outbox = { id: string; entityType: string; entityId: string; operation: string; status: string; payload: string | null };

const resources = {
  notebook: { table: "notebooks", title: "name" },
  note: { table: "notes", title: "title" },
  mindmap: { table: "mindmaps", title: "title" },
  file: { table: "attachments", title: "filename" },
} as const;

const treeMutationFields = new Set([
  "id", "userId", "workspaceId", "scopeKey", "parentId", "nodeType", "resourceType", "resourceId", "sortOrder", "isDeleted",
  "deletedAt", "createdAt", "updatedAt", "baseParentId", "baseSortOrder", "baseIsDeleted",
]);

export function rejectNativeTreeRepair(message: string): never {
  throw Object.assign(new Error(message), { code: "TREE_REPAIR_BLOCKED" });
}

export async function nativeTreeResourceTitle(db: NativeDatabase, nodeId: string, userId: string): Promise<string | null> {
  const separator = nodeId.indexOf(":");
  const type = nodeId.slice(0, separator);
  if (separator < 1 || !Object.hasOwn(resources, type)) return null;
  const { table, title } = resources[type as keyof typeof resources];
  const rows = await db.query<{title: string}>(`SELECT ${title} AS title FROM ${table}
    WHERE scopeKey='personal' AND workspaceId IS NULL AND id=? AND userId=?`, [nodeId.slice(separator + 1), userId]);
  return rows[0]?.title ?? null;
}

export async function readNativeTreeRepairPlan(
  tx: NativeDatabase, context: NativeTreeWriteContext, strategy: NativeTreeRepairStrategy, conflictIds: string[],
  baseline: { sequence: number; accessFingerprint: string; nodes: Map<string, Record<string, unknown>> },
) {
  const { profileId, userId } = context;
  const state = (await tx.query<{lastSequence: number; accessFingerprint: string; accessStatus: string}>(`
    SELECT lastSequence,accessFingerprint,accessStatus FROM sync_state WHERE profileId=? AND scopeKey='personal'`, [profileId]))[0];
  const binding = (await tx.query<{value: string}>("SELECT value FROM native_runtime_meta WHERE key=?", [nativeTreeSubscriptionKey(profileId)]))[0];
  const profile = (await tx.query<{enabled: number; authStatus: string}>("SELECT enabled,authStatus FROM sync_profiles WHERE id=?", [profileId]))[0];
  if (profile?.enabled !== 1 || profile.authStatus !== "ready" || binding?.value !== NATIVE_TREE_ENTITY_SET ||
      state?.accessStatus !== "active" || state.lastSequence !== baseline.sequence || state.accessFingerprint !== baseline.accessFingerprint) {
    rejectNativeTreeRepair("本机与云端的同步进度或权限尚未确认。请先同步，再重新预览。");
  }

  const conflicts = await tx.query<Conflict>(`SELECT id,entityId,localPayload,remotePayload FROM sync_conflicts
    WHERE profileId=? AND scopeKey='personal' AND entityType='knowledge_tree_node' AND status='unresolved' ORDER BY id`, [profileId]);
  const requested = new Set(conflictIds);
  const selected = conflicts.filter((row) => requested.has(row.id));
  const targetIds = new Set(selected.map((row) => row.entityId));
  if (selected.length !== requested.size || targetIds.size !== selected.length) {
    rejectNativeTreeRepair("选中的知识树冲突已变化，请刷新后重新预览。");
  }
  if (conflicts.some((row) => {
    const local = JSON.parse(row.localPayload || "null");
    const remote = JSON.parse(row.remotePayload || "null");
    return local?.lifecycle || remote?.lifecycle || local?.__delete || remote?.__delete || remote?.lifecycleSubtree ||
      (local && remote && local.isDeleted !== undefined && remote.isDeleted !== undefined && local.isDeleted !== remote.isDeleted);
  }) || (await tx.query(`SELECT id FROM sync_conflicts WHERE profileId=? AND scopeKey='personal'
    AND entityType<>'knowledge_tree_node' AND status='unresolved' LIMIT 1`, [profileId])).length) {
    rejectNativeTreeRepair("还有删除、恢复或内容冲突。请先处理这些冲突，再批量修复目录位置。");
  }
  if ((await tx.query(`SELECT id FROM attachments WHERE scopeKey='personal'
    AND transferStatus IN ('local','pending_upload','uploading','failed') LIMIT 1`)).length) {
    rejectNativeTreeRepair("个人空间还有未确认上传的附件，请先同步或导出备份。");
  }

  const localNodes = await tx.query<Node>(`SELECT id,userId,workspaceId,parentId,nodeType,resourceType,resourceId,
    sortOrder,isDeleted,deletedAt,createdAt,updatedAt FROM native_knowledge_tree_nodes WHERE scopeKey='personal' ORDER BY id`);
  const localById = new Map(localNodes.map((node) => [node.id, node]));
  const outbox = await tx.query<Outbox>(`SELECT id,entityType,entityId,operation,status,payload FROM sync_outbox
    WHERE profileId=? AND scopeKey='personal' ORDER BY id`, [profileId]);
  for (const row of outbox) {
    if (row.entityType !== "knowledge_tree_node" || !targetIds.has(row.entityId) || row.operation !== "upsert" || row.status !== "pending") {
      rejectNativeTreeRepair("还有待同步写入。请先同步正文、附件或其他目录更改，再重新预览。");
    }
    const payload = JSON.parse(row.payload || "null") as Record<string, unknown> | null;
    if (!payload || payload.lifecycle || payload.__delete || payload.baseIsDeleted !== 0 || payload.isDeleted !== 0 ||
        Object.keys(payload).some((key) => !treeMutationFields.has(key)) ||
        !localById.has(row.entityId) || payload.resourceType !== "notebook" ||
        (payload.baseParentId !== null && typeof payload.baseParentId !== "string") || !Number.isSafeInteger(payload.baseSortOrder)) {
      rejectNativeTreeRepair("待同步目录更改的类型或基线无法确认。请先导出备份并单条检查。");
    }
    assertNativePersonalTreeEntry(row.entityId, payload, userId);
  }

  for (const id of targetIds) {
    const queued = outbox.filter((row) => row.entityId === id);
    if (queued.length && !queued.some((row) => sameNativeTreePosition(JSON.parse(row.payload!), localById.get(id)!))) {
      rejectNativeTreeRepair("待同步目录更改与本机结构不一致。请先导出备份并单条检查。");
    }
  }

  const localProof = strategy === "keep-local" ? await personalWriteProofs(tx, context) : null;
  const changes = [];
  for (const row of selected) {
    const local = localById.get(row.entityId) ?? null;
    const remote = baseline.nodes.get(row.entityId);
    if (!remote || remote.isDeleted !== 0 || remote.deletedAt !== null ||
        (local && (local.isDeleted !== 0 || local.deletedAt !== null))) {
      rejectNativeTreeRepair("云端节点缺失或涉及删除状态。请先检查云端目录并同步，或单条处理。");
    }
    const title = await nativeTreeResourceTitle(tx, row.entityId, userId);
    if (title === null) rejectNativeTreeRepair("本机业务资源尚未同步。请先下载或恢复对应资源，再重新预览。");
    assertNativePersonalTreeEntry(row.entityId, remote, userId);
    if (local) {
      assertNativePersonalTreeEntry(row.entityId, local, userId);
      if (local.nodeType !== remote.nodeType) rejectNativeTreeRepair("两端节点类型不同，请先同步业务资源。");
    }
    if (localProof && (!local || local.resourceType !== "notebook" || !localProof(row.entityId).access.capabilities.canMove ||
        (local.parentId && !localProof(local.parentId).access.capabilities.canCreate))) {
      rejectNativeTreeRepair("本机位置或移动权限无法确认。请在线检查该文件夹和上级目录。");
    }
    changes.push({ id: row.id, title, local, remote: remote as Node });
  }

  const targets = changes.map(({ local, remote }) => strategy === "keep-remote" ? remote : local!);
  const targetById = new Map(targets.map((node) => [node.id, node]));
  const finalTree = [...localNodes.filter((node) => !targetById.has(node.id)), ...targets];
  assertNativePersonalTreeGraph(finalTree);
  const finalCloudTree = [...baseline.nodes.values()].map((node) =>
    (strategy === "keep-local" ? targetById.get(String(node.id)) : undefined) ?? node as Node);
  assertNativePersonalTreeGraph(finalCloudTree);
  const finalCloudById = new Map(finalCloudTree.map((node) => [node.id, node]));
  // New ancestry must already exist on this device and belong to the current account.
  const finalById = new Map(finalTree.map((node) => [node.id, node]));
  const verified = new Set<string>();
  for (const target of targets) {
    let node: Node | undefined = target;
    while (node && !verified.has(node.id)) {
      assertNativePersonalTreeEntry(node.id, node, userId);
      const cloud = finalCloudById.get(node.id);
      if (!cloud || cloud.parentId !== node.parentId || cloud.isDeleted !== node.isDeleted) {
        rejectNativeTreeRepair("上级目录仍存在结构差异，请一并选择相关冲突，或先同步后重试。");
      }
      if (await nativeTreeResourceTitle(tx, node.id, userId) === null) {
        rejectNativeTreeRepair("上级目录的业务资源尚未同步，请先补齐资源。");
      }
      verified.add(node.id);
      node = node.parentId ? finalById.get(node.parentId) : undefined;
    }
  }

  // Push replays each CAS separately. Queue parent changes first so a valid
  // final topology that reverses ancestry cannot produce a temporary cycle.
  const depth = (node: Node): number => {
    let current = node;
    let level = 0;
    while (current.parentId) { current = finalCloudById.get(current.parentId)!; level++; }
    return level;
  };
  if (strategy === "keep-local") changes.sort((left, right) => depth(left.local!) - depth(right.local!));

  return { changes, outbox, selected, targets, fingerprint: JSON.stringify({
    profileId, strategy, sequence: baseline.sequence, accessFingerprint: baseline.accessFingerprint, changes, outbox, selected, localNodes,
  }) };
}

export async function applyNativeTreeRepair(
  tx: NativeDatabase, context: NativeTreeWriteContext, strategy: NativeTreeRepairStrategy,
  plan: Awaited<ReturnType<typeof readNativeTreeRepairPlan>>,
): Promise<{resolved: number; backupId: string}> {
  const { profileId, deviceId, userId } = context;
  const backupId = newLocalId();
  const timestamp = new Date().toISOString();
  await tx.run("INSERT INTO native_runtime_meta(key,value,updatedAt) VALUES (?,?,?)", [
    `knowledgeTreeRepairBackup:${profileId}:${backupId}`,
    JSON.stringify({ strategy, conflicts: plan.selected.map(({ id, entityId }) => ({ id, entityId })), changes: plan.changes, outbox: plan.outbox }),
    timestamp,
  ]);
  if (strategy === "keep-remote") {
    await applyNativePersonalTree(tx, plan.targets.map((payload) => ({ entityId: payload.id, payload })), userId, false);
    await syncNativeNotebookMoveParents(tx, plan.targets.map((node) => node.id));
    // Existing cached ACL paths cannot authorize the new ancestry. The next
    // online tree request re-establishes its complete owner/password proofs.
    await tx.run("DELETE FROM native_runtime_meta WHERE key IN ('knowledgeTreeSnapshot:v1:personal:0','knowledgeTreeSnapshot:v1:personal:1')");
  }
  for (const row of plan.outbox) {
    await tx.run("DELETE FROM sync_outbox WHERE id=? AND profileId=?", [row.id, profileId]);
  }
  for (const { id } of plan.selected) {
    await tx.run("UPDATE sync_conflicts SET status='resolved',resolvedAt=? WHERE id=? AND profileId=?", [timestamp, id, profileId]);
  }
  if (strategy === "keep-local") for (const { local, remote } of plan.changes) {
    if (!local || sameNativeTreePosition(local, remote)) continue;
    await tx.run(`INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,status,retryCount,createdAt)
      VALUES (?,?,?,?,'personal','knowledge_tree_node',?,'upsert',?,'pending',0,?)`,
    [newLocalId(), newLocalId(), profileId, deviceId, local.id, JSON.stringify(nativeTreeMutationPayload(local, remote)), timestamp]);
  }
  return { resolved: plan.selected.length, backupId };
}
