import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import {
  deleteKnowledgeNode,
  KnowledgeTreeError,
  type KnowledgeTreeNode,
} from "./knowledgeTreeCore.js";
import { moveKnowledgeNode } from "./knowledgeTreeRootDocuments.js";

const MAX_BATCH_NODE_COUNT = 200;

type SelectionRow = {
  id: string;
  parentId: string | null;
};

function normalizeNodeIds(nodeIds: unknown): string[] {
  if (!Array.isArray(nodeIds)) {
    throw new KnowledgeTreeError("KNOWLEDGE_BATCH_NODE_IDS_REQUIRED", 400, "请选择要操作的内容");
  }
  const result = Array.from(new Set(
    nodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string" && Boolean(nodeId.trim())),
  ));
  if (result.length === 0) {
    throw new KnowledgeTreeError("KNOWLEDGE_BATCH_NODE_IDS_REQUIRED", 400, "请选择要操作的内容");
  }
  if (result.length > MAX_BATCH_NODE_COUNT) {
    throw new KnowledgeTreeError(
      "KNOWLEDGE_BATCH_TOO_LARGE",
      400,
      `单次最多操作 ${MAX_BATCH_NODE_COUNT} 项内容`,
    );
  }
  return result;
}

export function reduceKnowledgeTreeSelection(
  nodeIds: unknown,
  db: Database.Database = getDb(),
): string[] {
  ensureKnowledgeTreeTables(db);
  const normalized = normalizeNodeIds(nodeIds);
  const selected = new Set(normalized);
  const rows = new Map<string, SelectionRow>();

  for (const nodeId of normalized) {
    const row = db.prepare(`
      SELECT id, parentId
      FROM knowledge_tree_nodes
      WHERE id = ? AND isDeleted = 0
    `).get(nodeId) as SelectionRow | undefined;
    if (!row) {
      throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_FOUND", 404, "内容节点不存在", { nodeId });
    }
    rows.set(nodeId, row);
  }

  const parentOf = (nodeId: string): string | null => {
    const selectedRow = rows.get(nodeId);
    if (selectedRow) return selectedRow.parentId;
    const row = db.prepare(`
      SELECT parentId FROM knowledge_tree_nodes WHERE id = ? AND isDeleted = 0
    `).get(nodeId) as { parentId: string | null } | undefined;
    return row?.parentId ?? null;
  };

  return normalized.filter((nodeId) => {
    const visited = new Set<string>([nodeId]);
    let parentId = parentOf(nodeId);
    while (parentId) {
      if (selected.has(parentId)) return false;
      if (visited.has(parentId)) break;
      visited.add(parentId);
      parentId = parentOf(parentId);
    }
    return true;
  });
}

export function moveKnowledgeNodesBatch(input: {
  actorUserId: string;
  nodeIds: unknown;
  parentId: string | null;
  db?: Database.Database;
}): { success: true; nodeIds: string[]; nodes: KnowledgeTreeNode[] } {
  const db = input.db || getDb();
  const nodeIds = reduceKnowledgeTreeSelection(input.nodeIds, db);
  if (input.parentId && nodeIds.includes(input.parentId)) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_CYCLE", 400, "不能移动到已选择的内容中");
  }
  const movedNodeIds = nodeIds.filter((nodeId) => {
    const row = db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = ?")
      .get(nodeId) as { parentId: string | null };
    return (row.parentId ?? null) !== input.parentId;
  });
  const execute = db.transaction(() => movedNodeIds.map((nodeId) => moveKnowledgeNode({
    actorUserId: input.actorUserId,
    nodeId,
    parentId: input.parentId,
    db,
  })));
  return { success: true, nodeIds: movedNodeIds, nodes: execute() };
}

export function deleteKnowledgeNodesBatch(input: {
  actorUserId: string;
  nodeIds: unknown;
  db?: Database.Database;
}): {
  success: true;
  nodeIds: string[];
  affectedNodeIds: string[];
} {
  const db = input.db || getDb();
  const nodeIds = reduceKnowledgeTreeSelection(input.nodeIds, db);
  const execute = db.transaction(() => {
    const affectedNodeIds = new Set<string>();
    for (const nodeId of nodeIds) {
      const result = deleteKnowledgeNode({
        actorUserId: input.actorUserId,
        nodeId,
        mode: "subtree",
        db,
      });
      for (const affectedNodeId of result.affectedNodeIds) affectedNodeIds.add(affectedNodeId);
    }
    return Array.from(affectedNodeIds);
  });
  return { success: true, nodeIds, affectedNodeIds: execute() };
}
