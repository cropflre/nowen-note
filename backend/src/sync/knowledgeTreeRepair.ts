import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getConflict, listUnresolvedConflicts, resolveConflict } from "./conflict.js";
import { toConflictDetail } from "./resolve.js";
import { applyKnowledgeTreeSnapshotLocal } from "./knowledgeTreeApplyLocal.js";
import { prepareKnowledgeTreeSnapshot, type KnowledgeTreeSnapshotItem } from "./knowledgeTreeSnapshot.js";
import { isKnowledgeTreeSyncReady } from "./knowledgeTreeReadiness.js";
import { SyncError } from "./errors.js";
import { enqueueMutation } from "./outbox.js";
import { getActiveProfile, getSyncState } from "./profile.js";
import type { RemoteSnapshotPage, SyncRemoteClient } from "./remote.js";
import { SYNC_V2_NEGOTIATED_ENTITY_TYPES, type SyncOutboxRow, type SyncNegotiatedEntityType } from "./types.js";

export type TreeRepairStrategy = "keep-local" | "keep-remote";
interface RepairRequest {
  userId: string;
  profileId: string;
  strategy: TreeRepairStrategy;
  conflictIds: string[];
}

const scopeKey = "personal";
const subscription = { entityTypes: SYNC_V2_NEGOTIATED_ENTITY_TYPES };
const snapshotFields = [
  "id", "userId", "workspaceId", "parentId", "nodeType", "resourceType", "resourceId",
  "sortOrder", "isDeleted", "deletedAt", "createdAt", "updatedAt",
];

function blocked(reason: string): never {
  throw new SyncError("VERSION_CONFLICT", reason);
}

function assertSafeLocalState(db: Database.Database, request: RepairRequest) {
  const profile = getActiveProfile(db);
  if (profile?.id !== request.profileId) blocked("同步账号已变化，请重新打开冲突中心");
  const outbox = db.prepare(`SELECT * FROM sync_outbox WHERE profileId = ? AND scopeKey = ?
    AND status IN ('pending', 'inflight', 'failed') ORDER BY rowid`)
    .all(profile.id, scopeKey) as SyncOutboxRow[];
  const selected = new Set(request.conflictIds);
  const targets = new Set(listUnresolvedConflicts(db, profile.id, scopeKey)
    .filter((row) => selected.has(row.id) && row.entityType === "knowledge_tree_node")
    .map((row) => row.entityId));
  const allowedFields = new Set([...snapshotFields, "scopeKey",
    "baseParentId", "baseSortOrder", "baseIsDeleted", "baseDeletedAt"]);
  const latest = new Map(outbox.map((mutation) => [mutation.entityId, mutation.id]));
  for (const mutation of outbox) {
    if (mutation.entityType !== "knowledge_tree_node" || !targets.has(mutation.entityId)
      || mutation.operation !== "upsert" || mutation.status !== "pending") {
      blocked("个人空间仍有其他待同步的修改，请先同步或导出备份");
    }
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(mutation.payload ?? "null"); } catch { /* Reject an unreadable intent. */ }
    const local = db.prepare(`SELECT ${snapshotFields.join(", ")} FROM knowledge_tree_nodes
      WHERE id = ? AND userId = ? AND workspaceId IS NULL AND scopeKey = ?`)
      .get(mutation.entityId, request.userId, `personal:${request.userId}`) as Record<string, unknown> | undefined;
    const identity = ["id", "resourceType", "resourceId", "nodeType"];
    const position = ["parentId", "sortOrder", "isDeleted", "deletedAt"];
    if (!payload || !local || Object.keys(payload).some((key) => !allowedFields.has(key))
      || payload.userId !== request.userId || payload.workspaceId !== null
      || payload.isDeleted !== 0 || payload.deletedAt !== null || payload.baseIsDeleted !== 0
      || (payload.baseDeletedAt !== null && payload.baseDeletedAt !== undefined)
      || (payload.baseParentId !== null && typeof payload.baseParentId !== "string")
      || !Number.isSafeInteger(payload.baseSortOrder) || !Number.isSafeInteger(payload.sortOrder)
      || (payload.parentId !== null && typeof payload.parentId !== "string")
      || identity.some((key) => payload![key] !== local[key])
      || (latest.get(mutation.entityId) === mutation.id && position.some((key) => payload![key] !== local[key]))) {
      blocked("待同步结构与本机状态或安全基线不一致，请同步后重新预览");
    }
  }
  if (db.prepare(`SELECT 1 FROM attachments a JOIN notes n ON n.id = a.noteId
      LEFT JOIN attachment_sync_state s ON s.attachmentId = a.id
      WHERE n.userId = ? AND n.workspaceId IS NULL
        AND COALESCE(s.status, 'local') IN ('local', 'pending', 'uploading', 'failed')
        AND COALESCE(s.remoteOnly, 0) = 0 LIMIT 1`).get(request.userId)) {
    blocked("仍有未上传的附件，请先完成上传或导出备份");
  }
  if (db.prepare(`SELECT 1 FROM sync_conflicts WHERE profileId = ? AND scopeKey = ?
      AND status = 'unresolved' AND entityType <> 'knowledge_tree_node' LIMIT 1`).get(profile.id, scopeKey)) {
    blocked("请先处理正文、附件或其他资源冲突，再修复目录结构");
  }
  const state = getSyncState(db, profile.id, scopeKey);
  if (!state) blocked("尚未建立同步游标，请先同步");
  return { profile, sequence: state.lastSequence, outbox };
}

export async function fetchTreeRepairSnapshot(
  db: Database.Database, client: SyncRemoteClient, request: RepairRequest,
) {
  const { profile, sequence } = assertSafeLocalState(db, request);
  const expectedFingerprint = profile.remoteUserId
    ? createHash("sha256").update(`personal:${profile.remoteUserId}`).digest("hex") : null;
  const checkPlan = async () => {
    const plan = await client.plan(sequence, scopeKey, subscription);
    if (plan.scopeKey !== scopeKey || !plan.accessFingerprint || plan.resetRequired
      || plan.serverSequence !== sequence
      || (expectedFingerprint && plan.accessFingerprint !== expectedFingerprint)) {
      blocked("云端或同步游标已变化，请先同步再重新预览");
    }
    return plan.accessFingerprint;
  };
  const fingerprint = await checkPlan();
  const items = new Map<string, Record<string, unknown>>();
  // A read-only tree phase. Omitting deviceId avoids modifying the current
  // subscription or ACKing a snapshot whose business rows we did not apply.
  let cursor: string | null = "knowledge_tree_node:";
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor) || seen.size >= 2000) blocked("云端知识树快照分页无效");
    seen.add(cursor);
    const page: RemoteSnapshotPage<SyncNegotiatedEntityType> = await client.snapshot(cursor, sequence, 500, scopeKey, subscription);
    if (page.scopeKey !== scopeKey || page.accessFingerprint !== fingerprint
      || page.snapshotSequence !== sequence || page.hasMore !== Boolean(page.nextCursor)) {
      blocked("云端知识树快照已变化，请重新预览");
    }
    for (const item of page.items) {
      if (item.entityType !== "knowledge_tree_node" || item.payload.__delete) blocked("云端目录快照无效");
      if (items.has(item.entityId) || item.payload.id !== item.entityId || item.payload.workspaceId !== null) {
        blocked("云端知识树包含重复或跨空间节点");
      }
      items.set(item.entityId, Object.fromEntries(snapshotFields.map((key) => [key, item.payload[key]])));
    }
    cursor = page.nextCursor;
  }
  if (await checkPlan() !== fingerprint) blocked("云端访问范围已变化，请重新预览");
  return { sequence, fingerprint, items, checkPlan };
}

type Snapshot = Record<string, unknown>;

function orderedRepairs(graph: Map<string, Snapshot>, selected: Set<string>): KnowledgeTreeSnapshotItem[] {
  const ordered: KnowledgeTreeSnapshotItem[] = [];
  const visited = new Set<string>();
  for (const id of graph.keys()) {
    const path = new Map<string, Snapshot>();
    let current: string | null = id;
    while (current !== null && !visited.has(current)) {
      if (path.has(current)) blocked("修复后的目录会形成循环，请调整所选冲突");
      const node = graph.get(current);
      if (!node) blocked("修复所需的父目录缺失或不在个人空间，请先同步");
      path.set(current, node);
      const parent = node.parentId;
      if (parent !== null && (typeof parent !== "string" || !parent)) blocked("目录父节点无效");
      if (typeof parent === "string" && node.isDeleted === 0 && graph.get(parent)?.isDeleted === 1) {
        blocked("修复会把活动节点放入已删除目录，请先处理回收站冲突");
      }
      current = parent as string | null;
    }
    for (const [entityId, payload] of [...path].reverse()) {
      visited.add(entityId);
      if (selected.has(entityId)) ordered.push({ entityId, payload });
    }
  }
  return ordered;
}

export function treeRepairTitle(db: Database.Database, node: Snapshot | null, userId: string): string | null {
  const source = node?.resourceType === "notebook" ? "notebooks.name"
    : node?.resourceType === "note" ? "notes.title"
    : node?.resourceType === "mindmap" ? "mindmaps.title"
    : node?.resourceType === "file" ? "attachments.filename" : null;
  if (!source || !node || typeof node.resourceId !== "string") return null;
  const [table, column] = source.split(".");
  const row = db.prepare(`SELECT ${column} AS title FROM ${table}
    WHERE id = ? AND workspaceId IS NULL AND userId = ?`).get(node.resourceId, userId) as
    | { title: string } | undefined;
  return row?.title ?? null;
}

function prepareRepair(
  db: Database.Database, request: RepairRequest,
  snapshot: Awaited<ReturnType<typeof fetchTreeRepairSnapshot>>,
) {
  const { sequence, outbox } = assertSafeLocalState(db, request);
  if (sequence !== snapshot.sequence) blocked("本机同步游标已变化，请重新预览");
  const localRows = db.prepare(`SELECT ${snapshotFields.join(", ")} FROM knowledge_tree_nodes
    WHERE scopeKey = ? AND workspaceId IS NULL AND userId = ? ORDER BY id`)
    .all(`personal:${request.userId}`, request.userId) as Array<Snapshot & { id: string }>;
  const localGraph = new Map(localRows.map((node) => [node.id, node]));
  const selected = new Set<string>();
  const rows = [...request.conflictIds].sort().map((id) => {
    const row = getConflict(db, id, request.profileId);
    if (!row || row.status !== "unresolved" || row.scopeKey !== scopeKey
      || row.entityType !== "knowledge_tree_node") {
      blocked("所选冲突已变化，或属于暂不支持批量修复的工作区");
    }
    selected.add(row.entityId);
    return row;
  });
  // Do not leave an unresolved duplicate behind to block tree baseline binding.
  const open = listUnresolvedConflicts(db, request.profileId, scopeKey);
  for (const row of open) {
    const { local, remote } = toConflictDetail(row);
    if (local?.lifecycle || remote?.lifecycle || remote?.lifecycleSubtree || local?.__delete || remote?.__delete
      || (local && remote && local.isDeleted !== undefined && remote.isDeleted !== undefined
        && local.isDeleted !== remote.isDeleted)) {
      blocked("仍有删除或恢复冲突，请先核对并处理回收站状态");
    }
  }
  const ids = new Set(request.conflictIds);
  if (open.some((row) => selected.has(row.entityId) && !ids.has(row.id))) {
    blocked("同一节点存在多条冲突，请一并选择");
  }
  if (request.strategy === "keep-local" && open.length !== rows.length
    && !isKnowledgeTreeSyncReady(db, request.profileId, scopeKey)) {
    blocked("首次建立知识树同步时，请一并选择个人空间内的所有结构冲突");
  }

  const graph = request.strategy === "keep-remote"
    ? new Map<string, Snapshot>(localGraph) : new Map(snapshot.items);
  const changes = rows.map((row) => {
    const local = localGraph.get(row.entityId) ?? null;
    const remote = snapshot.items.get(row.entityId);
    if (!remote) blocked("云端缺少所选节点。请在云端恢复对应资源或检查同步诊断");
    if (!local && request.strategy === "keep-local") blocked("本机缺少所选节点，请先同步并检查对应资源");
    if (remote.isDeleted !== 0 || (local && (local.isDeleted !== remote.isDeleted || local.deletedAt !== remote.deletedAt))) {
      blocked("所选节点涉及删除或恢复，请先核对并处理回收站状态");
    }
    if (!Number.isSafeInteger(remote.sortOrder) || (remote.isDeleted !== 0 && remote.isDeleted !== 1)) {
      blocked("云端结构字段无效，请检查同步诊断");
    }
    if (local && (local.resourceType !== remote.resourceType || local.resourceId !== remote.resourceId
      || local.nodeType !== remote.nodeType)) {
      blocked("两端资源身份或类型不同，请先完成业务资源同步");
    }
    graph.set(row.entityId, request.strategy === "keep-remote" ? remote : local!);
    return { id: row.id, title: treeRepairTitle(db, local ?? remote, request.userId), local, remote };
  });
  const ordered = orderedRepairs(graph, selected);
  const token = createHash("sha256").update(JSON.stringify({
    request: { ...request, conflictIds: [...ids].sort() },
    sequence, fingerprint: snapshot.fingerprint, rows, changes, localRows, outbox,
    remote: [...snapshot.items],
  })).digest("hex");
  return { token, changes, ordered, rows, localGraph, selected, outbox };
}

export function previewTreeRepair(
  db: Database.Database, request: RepairRequest,
  snapshot: Awaited<ReturnType<typeof fetchTreeRepairSnapshot>>,
) {
  const previewRollback = new Error("preview");
  const plan = prepareRepair(db, request, snapshot);
  // Exercise the real local snapshot validator (including resource ownership and
  // projection checks) without committing any tree or ledger updates.
  try {
    db.transaction(() => {
      for (const mutation of plan.outbox) {
        db.prepare("DELETE FROM sync_outbox WHERE id = ? AND profileId = ?").run(mutation.id, request.profileId);
      }
      applyKnowledgeTreeSnapshotLocal(db, request.strategy === "keep-remote" ? plan.ordered
        : orderedRepairs(plan.localGraph, plan.selected), {
        userId: request.userId, workspaceId: null, allowMissingProjection: request.strategy === "keep-remote",
      });
      prepareKnowledgeTreeSnapshot(db, request.userId, null);
      throw previewRollback;
    })();
  } catch (error) {
    if (error !== previewRollback) throw error;
  }
  return { token: plan.token, changes: plan.changes };
}

export function applyTreeRepair(
  db: Database.Database, request: RepairRequest,
  snapshot: Awaited<ReturnType<typeof fetchTreeRepairSnapshot>>,
  token: string, deviceId: string,
) {
  return db.transaction(() => {
    const plan = prepareRepair(db, request, snapshot);
    if (token !== plan.token) blocked("预览后结构或同步状态已变化，请重新预览");
    for (const mutation of plan.outbox) {
      db.prepare("DELETE FROM sync_outbox WHERE id = ? AND profileId = ?").run(mutation.id, request.profileId);
    }
    if (request.strategy === "keep-remote") {
      applyKnowledgeTreeSnapshotLocal(db, plan.ordered, {
        userId: request.userId, workspaceId: null, allowMissingProjection: true,
      });
    } else {
      for (const { entityId, payload } of plan.ordered) {
        const remote = snapshot.items.get(entityId)!;
        enqueueMutation(db, {
          profileId: request.profileId, scopeKey, deviceId,
          entityType: "knowledge_tree_node", entityId, operation: "upsert",
          payload: {
            ...payload, baseParentId: remote.parentId, baseSortOrder: remote.sortOrder,
            baseIsDeleted: remote.isDeleted, baseDeletedAt: remote.deletedAt,
          },
        });
      }
    }
    prepareKnowledgeTreeSnapshot(db, request.userId, null);
    for (const row of plan.rows) resolveConflict(db, row.id);
    return { resolved: plan.rows.length };
  })();
}
