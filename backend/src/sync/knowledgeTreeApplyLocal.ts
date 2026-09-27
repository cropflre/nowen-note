import type Database from "better-sqlite3";
import { runWithOutboxSuppressed } from "./context.js";
import { SyncError } from "./errors.js";
import { runChangeFeedSuppressed } from "./suppression.js";
import type { KnowledgeTreeSnapshotItem } from "./knowledgeTreeSnapshot.js";

interface TreeStructure {
  id: string;
  resourceType: "notebook" | "note" | "mindmap" | "file";
  resourceId: string;
  nodeType: string;
  parentId: string | null;
  sortOrder: number;
  isDeleted: 0 | 1;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ALLOWED_NODE_TYPES: Record<string, string[]> = {
  notebook: ["folder"], note: ["note", "markdown", "word"],
  mindmap: ["mindmap"], file: ["file"],
};

/** Apply a complete, parent-first tree Snapshot after all business entities have been applied. */
export function applyKnowledgeTreeSnapshotLocal(
  db: Database.Database,
  items: KnowledgeTreeSnapshotItem[],
  options: { userId: string; workspaceId: string | null },
): void {
  const { userId, workspaceId } = options;
  const scopeKey = workspaceId ? `workspace:${workspaceId}` : "personal";
  const treeScopeKey = workspaceId ? scopeKey : `personal:${userId}`;
  const parsed: TreeStructure[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const p = item.payload;
    const resourceType = p.resourceType;
    const nodeType = p.nodeType;
    if (typeof resourceType !== "string" || !ALLOWED_NODE_TYPES[resourceType]
      || typeof p.resourceId !== "string" || !p.resourceId
      || p.id !== item.entityId || item.entityId !== `${resourceType}:${p.resourceId}`
      || typeof nodeType !== "string" || !ALLOWED_NODE_TYPES[resourceType].includes(nodeType)
      || (p.parentId !== null && (typeof p.parentId !== "string" || !p.parentId))
      || p.workspaceId !== workspaceId
      || !Number.isSafeInteger(p.sortOrder) || (p.sortOrder as number) < 0
      || (p.isDeleted !== 0 && p.isDeleted !== 1)
      || (p.deletedAt !== null && typeof p.deletedAt !== "string")
      || typeof p.createdAt !== "string" || !p.createdAt
      || typeof p.updatedAt !== "string" || !p.updatedAt
      || seen.has(item.entityId)) {
      throw new SyncError("INVALID_PAYLOAD", "知识树快照结构字段无效");
    }
    seen.add(item.entityId);
    parsed.push({
      id: item.entityId, resourceType: resourceType as TreeStructure["resourceType"],
      resourceId: p.resourceId, nodeType, parentId: p.parentId as string | null,
      sortOrder: p.sortOrder as number, isDeleted: p.isDeleted as 0 | 1,
      deletedAt: p.deletedAt as string | null,
      createdAt: p.createdAt as string,
      updatedAt: p.updatedAt as string,
    });
  }

  runWithOutboxSuppressed(() => db.transaction(() => runChangeFeedSuppressed(db, () => {
    for (const item of parsed) {
      const pending = db.prepare(`SELECT 1 FROM sync_outbox
        WHERE scopeKey = ? AND entityType = 'knowledge_tree_node' AND entityId = ?
          AND status IN ('pending', 'inflight', 'failed') LIMIT 1`).get(scopeKey, item.id);
      if (pending) throw new SyncError("VERSION_CONFLICT", "本地知识树位置仍有待同步修改");

      const tables: Partial<Record<TreeStructure["resourceType"], string>> = {
        notebook: "notebooks", note: "notes", mindmap: "mindmaps",
      };
      const table = tables[item.resourceType];
      const resource = item.resourceType === "file"
        ? db.prepare(`SELECT 1 FROM attachments a JOIN notes n ON n.id = a.noteId
            WHERE a.id = ? AND a.workspaceId IS ? AND n.workspaceId IS ?
              AND (? IS NOT NULL OR a.userId = ?)`)
            .get(item.resourceId, workspaceId, workspaceId, workspaceId, userId)
        : table && db.prepare(`SELECT 1 FROM ${table}
            WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)`)
            .get(item.resourceId, workspaceId, workspaceId, userId);
      if (!resource) throw new SyncError("MISSING_DEPENDENCY", "知识树对应的业务资源尚未同步");

      const existing = db.prepare(`SELECT resourceType, resourceId, scopeKey FROM knowledge_tree_nodes WHERE id = ?`)
        .get(item.id) as { resourceType: string; resourceId: string; scopeKey: string } | undefined;
      if (existing && (existing.resourceType !== item.resourceType || existing.resourceId !== item.resourceId
        || existing.scopeKey !== treeScopeKey)) {
        throw new SyncError("INVALID_PAYLOAD", "知识树节点身份或作用域不一致");
      }
      if (!existing) {
        if (item.resourceType !== "file") {
          throw new SyncError("MISSING_DEPENDENCY", "知识树业务投影尚未创建");
        }
        db.prepare(`INSERT INTO knowledge_tree_nodes
          (id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
           resourceId, sortOrder, isDeleted, deletedAt, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, NULL, ?, 'file', ?, 0, 0, NULL, ?, ?)`).run(
          item.id, userId, workspaceId, treeScopeKey, item.nodeType, item.resourceId,
          item.createdAt, item.updatedAt,
        );
      }
      db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 0, deletedAt = NULL WHERE id = ?")
        .run(item.id);
    }

    const placed = new Set<string>();
    for (const item of parsed) {
      if (item.parentId) {
        const parent = db.prepare(`SELECT scopeKey, isDeleted FROM knowledge_tree_nodes WHERE id = ?`)
          .get(item.parentId) as { scopeKey: string; isDeleted: number } | undefined;
        const current = db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = ?")
          .get(item.id) as { parentId: string | null } | undefined;
        const unchangedDeletedParent = item.isDeleted === 1 && current?.parentId === item.parentId;
        if (!parent || parent.scopeKey !== treeScopeKey
          || (parent.isDeleted && !unchangedDeletedParent)
          || (seen.has(item.parentId) && !placed.has(item.parentId))) {
          throw new SyncError("MISSING_DEPENDENCY", "知识树快照父节点未就绪或顺序错误");
        }
      }
      db.prepare(`UPDATE knowledge_tree_nodes
        SET parentId = ?, sortOrder = ?, nodeType = ?, updatedAt = ? WHERE id = ?`)
        .run(item.parentId, item.sortOrder, item.nodeType, item.updatedAt, item.id);
      placed.add(item.id);
    }
    for (const item of [...parsed].reverse()) {
      if (item.isDeleted) {
        db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 1, deletedAt = ? WHERE id = ?")
          .run(item.deletedAt, item.id);
      }
    }
  }))());
}

/** Apply one incremental tree batch; a failed dependency or pending local edit rolls back all rows. */
export function applyKnowledgeTreeChangesLocal(
  db: Database.Database,
  changes: Array<(KnowledgeTreeSnapshotItem & { operation: "upsert" })
    | { entityId: string; operation: "delete" }>,
  options: { userId: string; workspaceId: string | null },
): void {
  const scopeKey = options.workspaceId ? `workspace:${options.workspaceId}` : "personal";
  const treeScopeKey = options.workspaceId ? scopeKey : `personal:${options.userId}`;
  const upserts = changes.filter((item): item is KnowledgeTreeSnapshotItem & { operation: "upsert" } =>
    item.operation === "upsert");
  const deletions = changes.filter((item) => item.operation === "delete");
  if (changes.some((item) => !item.entityId || typeof item.entityId !== "string")) {
    throw new SyncError("INVALID_PAYLOAD", "知识树增量节点 ID 无效");
  }
  runWithOutboxSuppressed(() => db.transaction(() => runChangeFeedSuppressed(db, () => {
    applyKnowledgeTreeSnapshotLocal(db, upserts, options);
    const remaining = new Map(deletions.map((item) => [item.entityId, item]));
    while (remaining.size > 0) {
      let progressed = false;
      for (const item of remaining.values()) {
        const child = db.prepare("SELECT id FROM knowledge_tree_nodes WHERE parentId = ? LIMIT 1")
          .get(item.entityId) as { id: string } | undefined;
        if (child && remaining.has(child.id)) continue;
        if (child) {
          throw new SyncError("MISSING_DEPENDENCY", "删除知识树父节点前必须先同步子节点结构");
        }
        const pending = db.prepare(`SELECT 1 FROM sync_outbox
          WHERE scopeKey = ? AND entityType = 'knowledge_tree_node' AND entityId = ?
            AND status IN ('pending', 'inflight', 'failed') LIMIT 1`).get(scopeKey, item.entityId);
        if (pending) throw new SyncError("VERSION_CONFLICT", "本地知识树位置仍有待同步修改");
        db.prepare("DELETE FROM knowledge_tree_nodes WHERE id = ? AND scopeKey = ?")
          .run(item.entityId, treeScopeKey);
        remaining.delete(item.entityId);
        progressed = true;
      }
      if (!progressed) throw new SyncError("MISSING_DEPENDENCY", "知识树删除顺序存在循环");
    }
  }))());
}
