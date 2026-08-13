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

export type KnowledgeTreeDeleteMode = "subtree" | "promote";

export type DeleteKnowledgeTreeNodeInput = {
  actorUserId: string;
  workspaceId: string | null;
  nodeId: string;
  mode: KnowledgeTreeDeleteMode;
};

export type RestoreKnowledgeTreeNodeInput = {
  actorUserId: string;
  workspaceId: string | null;
  nodeId: string;
  includeSubtree?: boolean;
};

type DatabaseScalar = boolean | number | string | Date | null;

type LifecycleNodeRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: KnowledgeTreeReadNode["nodeType"];
  resourceType: KnowledgeTreeReadNode["resourceType"];
  resourceId: string;
  sortOrder: DatabaseScalar;
  isDeleted: DatabaseScalar;
  depth: DatabaseScalar;
};

type WorkspaceAccessRow = {
  ownerId: string;
  role: string | null;
};

type ParentStateRow = {
  id: string;
  scopeKey: string;
  isDeleted: DatabaseScalar;
};

type TreeContainerRow = {
  id: string;
  parentId: string | null;
  resourceType: KnowledgeTreeReadNode["resourceType"];
  resourceId: string;
};

type SortRow = { nextSortOrder: DatabaseScalar };

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

function toBoolean(value: DatabaseScalar): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function toNumber(value: DatabaseScalar): number {
  if (value === null) return 0;
  if (value === true) return 1;
  if (value === false) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
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

function convertedStatements(
  statements: DbStatement[],
  dialect: DatabaseDialect,
): DbStatement[] {
  return statements.map((statement) => ({
    ...statement,
    sql: convertSql(statement.sql, dialect),
  }));
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

async function readSubtree(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  nodeId: string,
  onlyActive: boolean,
): Promise<LifecycleNodeRow[]> {
  const activeRoot = onlyActive ? "AND isDeleted = 0" : "";
  const activeChild = onlyActive ? "WHERE child.isDeleted = 0" : "";
  return await adapter.queryMany<LifecycleNodeRow>(
    convertSql(
      `WITH RECURSIVE subtree(id, depth) AS (
         SELECT id, 0
           FROM knowledge_tree_nodes
          WHERE id = ? ${activeRoot}
         UNION ALL
         SELECT child.id, subtree.depth + 1
           FROM knowledge_tree_nodes child
           JOIN subtree ON child.parentId = subtree.id
           ${activeChild}
       )
       SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
              node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
              node.isDeleted, subtree.depth AS depth
         FROM subtree
         JOIN knowledge_tree_nodes node ON node.id = subtree.id
        ORDER BY subtree.depth ASC, node.sortOrder ASC, node.id ASC`,
      dialect,
    ),
    [nodeId],
  );
}

async function readActiveChildren(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  nodeId: string,
): Promise<LifecycleNodeRow[]> {
  return await adapter.queryMany<LifecycleNodeRow>(
    convertSql(
      `SELECT id, userId, workspaceId, scopeKey, parentId, nodeType,
              resourceType, resourceId, sortOrder, isDeleted, 1 AS depth
         FROM knowledge_tree_nodes
        WHERE parentId = ? AND isDeleted = 0
        ORDER BY sortOrder ASC, id ASC`,
      dialect,
    ),
    [nodeId],
  );
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
  return Math.max(0, Math.trunc(toNumber(row?.nextSortOrder ?? 0)));
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

function structureGuard(node: LifecycleNodeRow, expectedDeleted: boolean): DbStatement {
  return {
    sql: `UPDATE knowledge_tree_nodes
             SET updatedAt = updatedAt
           WHERE id = ?
             AND scopeKey = ?
             AND COALESCE(parentId, '') = COALESCE(?, '')
             AND sortOrder = ?
             AND isDeleted = ?`,
    params: [
      node.id,
      node.scopeKey,
      node.parentId,
      toNumber(node.sortOrder),
      expectedDeleted ? 1 : 0,
    ],
    requireChanges: 1,
  };
}

function subtreeCardinalityGuard(
  root: LifecycleNodeRow,
  expectedCount: number,
  onlyActive: boolean,
): DbStatement {
  const activeRoot = onlyActive ? "AND isDeleted = 0" : "";
  const activeChild = onlyActive ? "WHERE child.isDeleted = 0" : "";
  return {
    sql: `WITH RECURSIVE subtree(id) AS (
            SELECT id FROM knowledge_tree_nodes WHERE id = ? ${activeRoot}
            UNION ALL
            SELECT child.id
              FROM knowledge_tree_nodes child
              JOIN subtree ON child.parentId = subtree.id
              ${activeChild}
          )
          UPDATE knowledge_tree_nodes
             SET updatedAt = updatedAt
           WHERE id = ?
             AND scopeKey = ?
             AND (SELECT COUNT(*) FROM subtree) = ?`,
    params: [root.id, root.id, root.scopeKey, expectedCount],
    requireChanges: 1,
  };
}

function directChildrenCardinalityGuard(
  root: LifecycleNodeRow,
  expectedCount: number,
): DbStatement {
  return {
    sql: `UPDATE knowledge_tree_nodes
             SET updatedAt = updatedAt
           WHERE id = ?
             AND scopeKey = ?
             AND isDeleted = 0
             AND (
               SELECT COUNT(*) FROM knowledge_tree_nodes child
                WHERE child.parentId = ? AND child.isDeleted = 0
             ) = ?`,
    params: [root.id, root.scopeKey, root.id, expectedCount],
    requireChanges: 1,
  };
}

function businessDeleteStatement(node: LifecycleNodeRow): DbStatement | null {
  if (node.resourceType === "note") {
    return {
      sql: `UPDATE notes
               SET isTrashed = 1, trashedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = ? AND isTrashed = 0`,
      params: [node.resourceId],
      requireChanges: 1,
    };
  }
  if (node.resourceType === "notebook") {
    return {
      sql: `UPDATE notebooks
               SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = ? AND isDeleted = 0`,
      params: [node.resourceId],
      requireChanges: 1,
    };
  }
  return null;
}

function treeDeleteStatement(node: LifecycleNodeRow): DbStatement {
  return {
    sql: `UPDATE knowledge_tree_nodes
             SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
           WHERE id = ? AND scopeKey = ?`,
    params: [node.id, node.scopeKey],
    requireChanges: 1,
  };
}

function businessRestoreStatement(node: LifecycleNodeRow): DbStatement | null {
  if (node.resourceType === "note") {
    return {
      sql: `UPDATE notes
               SET isTrashed = 0, trashedAt = NULL, updatedAt = datetime('now')
             WHERE id = ? AND isTrashed = 1`,
      params: [node.resourceId],
      requireChanges: 1,
    };
  }
  if (node.resourceType === "notebook") {
    return {
      sql: `UPDATE notebooks
               SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now')
             WHERE id = ? AND isDeleted = 1`,
      params: [node.resourceId],
      requireChanges: 1,
    };
  }
  return null;
}

function treeRestoreStatement(node: LifecycleNodeRow): DbStatement {
  return {
    sql: `UPDATE knowledge_tree_nodes
             SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now')
           WHERE id = ? AND scopeKey = ? AND isDeleted = 1`,
    params: [node.id, node.scopeKey],
    requireChanges: 1,
  };
}

function promoteBusinessStatement(
  node: LifecycleNodeRow,
  notebookContainerId: string | null,
  sortOrder: number,
): DbStatement | null {
  if (node.resourceType === "note") {
    if (!notebookContainerId) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED",
        400,
        "文档必须位于可承载文档的目录中",
      );
    }
    return {
      sql: `UPDATE notes
               SET notebookId = ?, workspaceId = ?, sortOrder = ?, updatedAt = datetime('now')
             WHERE id = ? AND isTrashed = 0`,
      params: [notebookContainerId, node.workspaceId, sortOrder, node.resourceId],
      requireChanges: 1,
    };
  }
  if (node.resourceType === "notebook") {
    return {
      sql: `UPDATE notebooks
               SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
             WHERE id = ? AND isDeleted = 0`,
      params: [notebookContainerId, sortOrder, node.resourceId],
      requireChanges: 1,
    };
  }
  return null;
}

async function validateRestoreParents(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  rootScopeKey: string,
  selected: LifecycleNodeRow[],
): Promise<void> {
  const selectedIds = new Set(selected.map((node) => node.id));
  const parentIds = [...new Set(
    selected
      .map((node) => node.parentId)
      .filter((parentId): parentId is string => Boolean(parentId) && !selectedIds.has(parentId!)),
  )];

  for (const parentId of parentIds) {
    const parent = await adapter.queryOne<ParentStateRow>(
      convertSql(
        "SELECT id, scopeKey, isDeleted FROM knowledge_tree_nodes WHERE id = ?",
        dialect,
      ),
      [parentId],
    );
    if (!parent || parent.scopeKey !== rootScopeKey) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_RESTORE_PARENT_INVALID",
        409,
        "原父级不存在或已不属于当前空间",
        { parentId },
      );
    }
    if (toBoolean(parent.isDeleted)) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_RESTORE_PARENT_DELETED",
        409,
        "请先恢复上级目录",
        { parentId },
      );
    }
  }
}

export function createKnowledgeTreeLifecycleMutationRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);
  const readRepository = createKnowledgeTreeReadRepository(adapter, dialect);

  return {
    async deleteNode(input: DeleteKnowledgeTreeNodeInput): Promise<{
      success: true;
      mode: KnowledgeTreeDeleteMode;
      affectedNodeIds: string[];
      promotedNodeIds: string[];
    }> {
      const activeAdapter = getAdapter();
      const activeDialect = getDialect();
      const visibleNodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
      });
      const nodesById = new Map(visibleNodes.map((node) => [node.id, node]));
      const current = nodesById.get(input.nodeId);
      if (!current) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_NOT_FOUND",
          404,
          "内容节点不存在",
        );
      }
      if (!current.access.capabilities.canDelete) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_CAPABILITY_FORBIDDEN",
          403,
          "没有删除权限",
          { required: "canDelete" },
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
      if (sourceSharedRootId === current.id) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_SHARED_ROOT_DELETE_FORBIDDEN",
          403,
          "共享根节点不能由接收者删除",
        );
      }

      const rootRows = await readSubtree(
        activeAdapter,
        activeDialect,
        current.id,
        true,
      );
      const root = rootRows.find((node) => node.id === current.id);
      if (!root) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_STALE",
          409,
          "内容结构已发生变化，请刷新后重试",
        );
      }

      const statements: DbStatement[] = [];
      const affectedNodeIds: string[] = [];
      const promotedNodeIds: string[] = [];

      if (input.mode === "promote") {
        const children = await readActiveChildren(
          activeAdapter,
          activeDialect,
          current.id,
        );
        const parent = current.parentId ? nodesById.get(current.parentId) || null : null;
        if (current.parentId && !parent) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_RESTORE_PARENT_INVALID",
            409,
            "原父级不存在或不可访问",
            { parentId: current.parentId },
          );
        }
        const canTarget = parent
          ? parent.access.capabilities.canCreate || parent.access.capabilities.canMove
          : canTargetWorkspaceRoot(rootAccess, input.actorUserId);
        if (!canTarget) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_CAPABILITY_FORBIDDEN",
            403,
            "没有提升子节点到目标位置的权限",
            { required: "canCreate" },
          );
        }

        const notebookContainerId = await nearestNotebookContainer(
          activeAdapter,
          activeDialect,
          parent,
        );
        let sortOrder = await nextSortOrder(
          activeAdapter,
          activeDialect,
          current.scopeKey,
          current.parentId,
        );

        statements.push(directChildrenCardinalityGuard(root, children.length));
        statements.push(structureGuard(root, false));
        for (const child of children) statements.push(structureGuard(child, false));

        for (const child of children) {
          const business = promoteBusinessStatement(
            child,
            notebookContainerId,
            sortOrder,
          );
          if (business) statements.push(business);
          statements.push({
            sql: `UPDATE knowledge_tree_nodes
                     SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
                   WHERE id = ? AND scopeKey = ? AND isDeleted = 0`,
            params: [current.parentId, sortOrder, child.id, child.scopeKey],
            requireChanges: 1,
          });
          promotedNodeIds.push(child.id);
          sortOrder += 1;
        }

        const rootBusiness = businessDeleteStatement(root);
        if (rootBusiness) statements.push(rootBusiness);
        statements.push(treeDeleteStatement(root));
        affectedNodeIds.push(root.id);
        statements.push({
          sql: `INSERT INTO knowledge_tree_history (
                  id, nodeId, action, actorUserId, fromParentId, metadata
                ) VALUES (?, ?, 'delete_promote', ?, ?, ?)`,
          params: [
            randomUUID(),
            root.id,
            input.actorUserId,
            root.parentId,
            JSON.stringify({ promotedNodeIds }),
          ],
          requireChanges: 1,
        });
      } else {
        statements.push(subtreeCardinalityGuard(root, rootRows.length, true));
        for (const node of rootRows) statements.push(structureGuard(node, false));

        const descending = [...rootRows].sort((left, right) => (
          toNumber(right.depth) - toNumber(left.depth)
          || toNumber(left.sortOrder) - toNumber(right.sortOrder)
          || left.id.localeCompare(right.id)
        ));
        for (const node of descending) {
          const business = businessDeleteStatement(node);
          if (business) statements.push(business);
          statements.push(treeDeleteStatement(node));
          affectedNodeIds.push(node.id);
        }
        statements.push({
          sql: `INSERT INTO knowledge_tree_history (
                  id, nodeId, action, actorUserId, fromParentId, metadata
                ) VALUES (?, ?, 'delete_subtree', ?, ?, ?)`,
          params: [
            randomUUID(),
            root.id,
            input.actorUserId,
            root.parentId,
            JSON.stringify({ affectedNodeIds }),
          ],
          requireChanges: 1,
        });
      }

      try {
        await activeAdapter.executeStatements(
          convertedStatements(statements, activeDialect),
        );
      } catch (error) {
        mapStatementError(error);
      }

      return {
        success: true,
        mode: input.mode,
        affectedNodeIds,
        promotedNodeIds,
      };
    },

    async restoreNode(input: RestoreKnowledgeTreeNodeInput): Promise<{
      success: true;
      restoredNodeIds: string[];
    }> {
      const activeAdapter = getAdapter();
      const activeDialect = getDialect();
      const visibleNodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
        includeDeleted: true,
      });
      const nodesById = new Map(visibleNodes.map((node) => [node.id, node]));
      const current = nodesById.get(input.nodeId);
      if (!current) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_NOT_FOUND",
          404,
          "内容节点不存在",
        );
      }
      if (!current.access.capabilities.canDelete) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_CAPABILITY_FORBIDDEN",
          403,
          "没有恢复权限",
          { required: "canDelete" },
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
      if (sourceSharedRootId === current.id) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_SHARED_ROOT_RESTORE_FORBIDDEN",
          403,
          "共享根节点不能由接收者恢复",
        );
      }

      const allRows = await readSubtree(
        activeAdapter,
        activeDialect,
        current.id,
        false,
      );
      const selected = (input.includeSubtree === false
        ? allRows.filter((node) => node.id === current.id)
        : allRows
      ).filter((node) => toBoolean(node.isDeleted));

      if (selected.length === 0) {
        return { success: true, restoredNodeIds: [] };
      }

      const root = allRows.find((node) => node.id === current.id);
      if (!root) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_STALE",
          409,
          "内容结构已发生变化，请刷新后重试",
        );
      }
      await validateRestoreParents(
        activeAdapter,
        activeDialect,
        root.scopeKey,
        selected,
      );

      const statements: DbStatement[] = [
        subtreeCardinalityGuard(root, allRows.length, false),
      ];
      for (const node of allRows) {
        statements.push(structureGuard(node, toBoolean(node.isDeleted)));
      }

      const ascending = [...selected].sort((left, right) => (
        toNumber(left.depth) - toNumber(right.depth)
        || toNumber(left.sortOrder) - toNumber(right.sortOrder)
        || left.id.localeCompare(right.id)
      ));
      for (const node of ascending) statements.push(treeRestoreStatement(node));
      for (const node of ascending) {
        const business = businessRestoreStatement(node);
        if (business) statements.push(business);
      }

      const restoredNodeIds = ascending.map((node) => node.id);
      statements.push({
        sql: `INSERT INTO knowledge_tree_history (
                id, nodeId, action, actorUserId, toParentId, metadata
              ) VALUES (?, ?, 'restore', ?, ?, ?)`,
        params: [
          randomUUID(),
          root.id,
          input.actorUserId,
          root.parentId,
          JSON.stringify({ restoredNodeIds }),
        ],
        requireChanges: 1,
      });

      try {
        await activeAdapter.executeStatements(
          convertedStatements(statements, activeDialect),
        );
      } catch (error) {
        mapStatementError(error);
      }

      return { success: true, restoredNodeIds };
    },
  };
}

export const knowledgeTreeLifecycleMutationRepository =
  createKnowledgeTreeLifecycleMutationRepository();
