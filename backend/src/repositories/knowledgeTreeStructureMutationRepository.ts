import { randomUUID } from "node:crypto";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import { convertSql, type DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import { KnowledgeTreeMutationError } from "./knowledgeTreeMutationRepository";
import {
  createKnowledgeTreeReadRepository,
  type KnowledgeTreeReadNode,
} from "./knowledgeTreeReadRepository";

export type MoveKnowledgeTreeNodeInput = {
  actorUserId: string;
  workspaceId: string | null;
  nodeId: string;
  parentId: string | null;
  sortOrder?: number;
};

export type ReorderKnowledgeTreeNodesInput = {
  actorUserId: string;
  workspaceId: string | null;
  items: Array<{ id: string; sortOrder: number }>;
};

type TreeContainerRow = {
  id: string;
  parentId: string | null;
  resourceType: KnowledgeTreeReadNode["resourceType"];
  resourceId: string;
};

type WorkspaceAccessRow = {
  ownerId: string;
  role: string | null;
};

type FoundRow = { found: boolean | number | string };
type SortRow = { nextSortOrder: number | string | null };

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveDialect(dialect?: DatabaseDialect): DatabaseDialect {
  if (dialect) return dialect;
  try {
    return getDatabaseDialect();
  } catch {
    return "sqlite";
  }
}

function normalizeSortOrder(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback;
}

function mapStatementError(error: unknown): never {
  if (error instanceof DbStatementChangeError) {
    throw new KnowledgeTreeMutationError(
      "KNOWLEDGE_NODE_STALE",
      409,
      "内容结构已发生变化，请刷新后重试",
    );
  }
  throw error;
}

async function workspaceAccess(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  actorUserId: string,
  workspaceId: string | null,
): Promise<WorkspaceAccessRow | null> {
  if (!workspaceId) return null;
  return await adapter.queryOne<WorkspaceAccessRow>(
    convertSql(
      `SELECT workspace.ownerId AS ownerId, member.role AS role
         FROM workspaces workspace
         LEFT JOIN workspace_members member
           ON member.workspaceId = workspace.id AND member.userId = ?
        WHERE workspace.id = ?`,
      dialect,
    ),
    [actorUserId, workspaceId],
  ) ?? null;
}

function isWorkspaceParticipant(access: WorkspaceAccessRow | null, actorUserId: string): boolean {
  return Boolean(access && (access.ownerId === actorUserId || access.role));
}

function canTargetWorkspaceRoot(access: WorkspaceAccessRow | null, actorUserId: string): boolean {
  if (!access) return true;
  if (access.ownerId === actorUserId) return true;
  return ["owner", "admin", "manage", "editor", "write"].includes(access.role || "");
}

function sharedRootId(
  node: KnowledgeTreeReadNode,
  nodesById: Map<string, KnowledgeTreeReadNode>,
  actorUserId: string,
  workspaceParticipant: boolean,
): string | null {
  if (node.access.source === "owner") return null;
  if (!node.workspaceId && node.userId === actorUserId) return null;
  if (node.workspaceId && workspaceParticipant) return null;

  let cursor = node;
  const visited = new Set<string>();
  while (cursor.parentId) {
    if (visited.has(cursor.id)) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_TREE_CYCLE",
        409,
        "目录结构存在循环",
      );
    }
    visited.add(cursor.id);
    const parent = nodesById.get(cursor.parentId);
    if (!parent) break;
    cursor = parent;
  }
  return cursor.id;
}

async function isDescendant(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  ancestorId: string,
  candidateId: string,
): Promise<boolean> {
  const row = await adapter.queryOne<FoundRow>(
    convertSql(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM knowledge_tree_nodes WHERE parentId = ? AND isDeleted = 0
         UNION ALL
         SELECT child.id
           FROM knowledge_tree_nodes child
           JOIN descendants parent ON child.parentId = parent.id
          WHERE child.isDeleted = 0
       )
       SELECT 1 AS found FROM descendants WHERE id = ? LIMIT 1`,
      dialect,
    ),
    [ancestorId, candidateId],
  );
  return Boolean(row?.found);
}

async function nextSortOrder(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  scopeKey: string,
  parentId: string | null,
): Promise<number> {
  const row = await adapter.queryOne<SortRow>(
    convertSql(
      `SELECT COALESCE(MAX(sortOrder), -1) + 1 AS nextSortOrder
         FROM knowledge_tree_nodes
        WHERE scopeKey = ?
          AND COALESCE(parentId, '') = COALESCE(?, '')
          AND isDeleted = 0`,
      dialect,
    ),
    [scopeKey, parentId],
  );
  return normalizeSortOrder(row?.nextSortOrder, 0);
}

async function nearestNotebookContainer(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  parent: KnowledgeTreeReadNode | null,
): Promise<string | null> {
  let cursor: TreeContainerRow | null = parent
    ? {
        id: parent.id,
        parentId: parent.parentId,
        resourceType: parent.resourceType,
        resourceId: parent.resourceId,
      }
    : null;
  const visited = new Set<string>();

  while (cursor) {
    if (visited.has(cursor.id)) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_TREE_CYCLE",
        409,
        "目录结构存在循环",
      );
    }
    visited.add(cursor.id);

    if (cursor.resourceType === "notebook") return cursor.resourceId;
    if (cursor.resourceType === "note") {
      const note = await adapter.queryOne<{ notebookId: string }>(
        convertSql("SELECT notebookId FROM notes WHERE id = ?", dialect),
        [cursor.resourceId],
      );
      if (note?.notebookId) return note.notebookId;
    }
    if (!cursor.parentId) return null;

    cursor = await adapter.queryOne<TreeContainerRow>(
      convertSql(
        `SELECT id, parentId, resourceType, resourceId
           FROM knowledge_tree_nodes
          WHERE id = ? AND isDeleted = 0`,
        dialect,
      ),
      [cursor.parentId],
    ) ?? null;
  }

  return null;
}

function structureGuard(node: KnowledgeTreeReadNode): DbStatement {
  return {
    sql: `UPDATE knowledge_tree_nodes
             SET updatedAt = updatedAt
           WHERE id = ?
             AND scopeKey = ?
             AND COALESCE(parentId, '') = COALESCE(?, '')
             AND sortOrder = ?
             AND isDeleted = 0`,
    params: [node.id, node.scopeKey, node.parentId, node.sortOrder],
    requireChanges: 1,
  };
}

function businessParentStatements(
  node: KnowledgeTreeReadNode,
  notebookContainerId: string | null,
): DbStatement[] {
  if (node.resourceType === "note") {
    if (!notebookContainerId) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED",
        400,
        "文档必须位于可承载文档的目录中",
      );
    }
    return [{
      sql: `UPDATE notes
               SET notebookId = ?, workspaceId = ?, updatedAt = datetime('now')
             WHERE id = ?`,
      params: [notebookContainerId, node.workspaceId, node.resourceId],
      requireChanges: 1,
    }];
  }
  if (node.resourceType === "notebook") {
    return [{
      sql: `UPDATE notebooks
               SET parentId = ?, updatedAt = datetime('now')
             WHERE id = ?`,
      params: [notebookContainerId, node.resourceId],
      requireChanges: 1,
    }];
  }
  return [];
}

function businessSortStatement(node: KnowledgeTreeReadNode, sortOrder: number): DbStatement | null {
  if (node.resourceType === "note") {
    return {
      sql: "UPDATE notes SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?",
      params: [sortOrder, node.resourceId],
      requireChanges: 1,
    };
  }
  if (node.resourceType === "notebook") {
    return {
      sql: "UPDATE notebooks SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?",
      params: [sortOrder, node.resourceId],
      requireChanges: 1,
    };
  }
  return null;
}

function convertedStatements(
  statements: DbStatement[],
  dialect: DatabaseDialect,
): DbStatement[] {
  return statements.map((statement) => ({
    ...statement,
    sql: convertSql(statement.sql, dialect),
  }));
}

export function createKnowledgeTreeStructureMutationRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);
  const readRepository = createKnowledgeTreeReadRepository(adapter, dialect);

  return {
    async moveNode(input: MoveKnowledgeTreeNodeInput): Promise<KnowledgeTreeReadNode> {
      const activeAdapter = getAdapter();
      const activeDialect = getDialect();
      const nodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
      });
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const current = nodesById.get(input.nodeId);
      if (!current) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_NOT_FOUND",
          404,
          "内容节点不存在",
        );
      }
      if (!current.access.capabilities.canMove) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_CAPABILITY_FORBIDDEN",
          403,
          "没有移动权限",
          { required: "canMove" },
        );
      }

      const parent = input.parentId ? nodesById.get(input.parentId) || null : null;
      if (input.parentId && !parent) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_NOT_FOUND",
          404,
          "目标父级不存在或不可访问",
        );
      }
      if (parent && parent.scopeKey !== current.scopeKey) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_TREE_SCOPE_MISMATCH",
          400,
          "不能跨空间移动内容",
        );
      }
      if (
        input.parentId === current.id
        || (input.parentId && await isDescendant(
          activeAdapter,
          activeDialect,
          current.id,
          input.parentId,
        ))
      ) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_TREE_CYCLE",
          400,
          "不能移动到自身或自己的后代节点",
        );
      }

      const rootAccess = await workspaceAccess(
        activeAdapter,
        activeDialect,
        input.actorUserId,
        current.workspaceId,
      );
      const participant = isWorkspaceParticipant(rootAccess, input.actorUserId);
      const sourceSharedRootId = sharedRootId(
        current,
        nodesById,
        input.actorUserId,
        participant,
      );
      if (sourceSharedRootId) {
        if (current.id === sourceSharedRootId) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_SHARED_ROOT_MOVE_FORBIDDEN",
            403,
            "共享根节点不能由接收者移动",
          );
        }
        const targetSharedRootId = parent
          ? sharedRootId(parent, nodesById, input.actorUserId, participant)
          : null;
        if (!parent || targetSharedRootId !== sourceSharedRootId) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_SHARED_ROOT_SCOPE_MISMATCH",
            403,
            "共享内容只能在同一个共享根内移动",
            { sourceSharedRootId, targetSharedRootId },
          );
        }
      }

      const canTarget = parent
        ? parent.access.capabilities.canCreate || parent.access.capabilities.canMove
        : canTargetWorkspaceRoot(rootAccess, input.actorUserId);
      if (!canTarget) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_CAPABILITY_FORBIDDEN",
          403,
          "没有移动到目标位置的权限",
          { required: "canCreate" },
        );
      }

      const notebookContainerId = await nearestNotebookContainer(
        activeAdapter,
        activeDialect,
        parent,
      );
      const fallbackSortOrder = await nextSortOrder(
        activeAdapter,
        activeDialect,
        current.scopeKey,
        input.parentId,
      );
      const sortOrder = normalizeSortOrder(input.sortOrder, fallbackSortOrder);
      const statements: DbStatement[] = [
        structureGuard(current),
        ...businessParentStatements(current, notebookContainerId),
        {
          sql: `UPDATE knowledge_tree_nodes
                   SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
                 WHERE id = ? AND scopeKey = ? AND isDeleted = 0`,
          params: [input.parentId, sortOrder, current.id, current.scopeKey],
          requireChanges: 1,
        },
        {
          sql: `INSERT INTO knowledge_tree_history (
                  id, nodeId, action, actorUserId, fromParentId, toParentId, metadata
                ) VALUES (?, ?, 'move', ?, ?, ?, ?)`,
          params: [
            randomUUID(),
            current.id,
            input.actorUserId,
            current.parentId,
            input.parentId,
            JSON.stringify({ sortOrder }),
          ],
          requireChanges: 1,
        },
      ];

      try {
        await activeAdapter.executeStatements(
          convertedStatements(statements, activeDialect),
        );
      } catch (error) {
        mapStatementError(error);
      }

      const refreshedNodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
      });
      const moved = refreshedNodes.find((node) => node.id === current.id);
      if (!moved) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_SYNC_FAILED",
          409,
          "内容节点同步失败",
        );
      }
      return moved;
    },

    async reorderNodes(
      input: ReorderKnowledgeTreeNodesInput,
    ): Promise<{ success: true; updated: number }> {
      if (input.items.length > 500) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_REORDER_TOO_LARGE",
          400,
          "单次最多排序 500 个节点",
        );
      }

      const duplicateIds = new Set<string>();
      const seenIds = new Set<string>();
      for (const item of input.items) {
        if (seenIds.has(item.id)) duplicateIds.add(item.id);
        seenIds.add(item.id);
      }
      if (duplicateIds.size > 0) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_REORDER_DUPLICATE_NODE",
          400,
          "排序列表包含重复节点",
          { nodeIds: [...duplicateIds] },
        );
      }

      const activeAdapter = getAdapter();
      const activeDialect = getDialect();
      const nodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
      });
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const statements: DbStatement[] = [];

      for (const item of input.items) {
        const node = nodesById.get(item.id);
        if (!node) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_NODE_NOT_FOUND",
            404,
            "内容节点不存在",
            { nodeId: item.id },
          );
        }
        if (!node.access.capabilities.canMove) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_CAPABILITY_FORBIDDEN",
            403,
            "没有排序权限",
            { nodeId: item.id, required: "canMove" },
          );
        }

        const sortOrder = normalizeSortOrder(item.sortOrder, 0);
        statements.push(structureGuard(node));
        statements.push({
          sql: `UPDATE knowledge_tree_nodes
                   SET sortOrder = ?, updatedAt = datetime('now')
                 WHERE id = ? AND scopeKey = ? AND isDeleted = 0`,
          params: [sortOrder, node.id, node.scopeKey],
          requireChanges: 1,
        });
        const resourceStatement = businessSortStatement(node, sortOrder);
        if (resourceStatement) statements.push(resourceStatement);
        statements.push({
          sql: `INSERT INTO knowledge_tree_history (
                  id, nodeId, action, actorUserId, fromParentId, toParentId, metadata
                ) VALUES (?, ?, 'reorder', ?, ?, ?, ?)`,
          params: [
            randomUUID(),
            node.id,
            input.actorUserId,
            node.parentId,
            node.parentId,
            JSON.stringify({ sortOrder }),
          ],
          requireChanges: 1,
        });
      }

      if (statements.length > 0) {
        try {
          await activeAdapter.executeStatements(
            convertedStatements(statements, activeDialect),
          );
        } catch (error) {
          mapStatementError(error);
        }
      }

      return { success: true, updated: input.items.length };
    },
  };
}

export const knowledgeTreeStructureMutationRepository =
  createKnowledgeTreeStructureMutationRepository();
