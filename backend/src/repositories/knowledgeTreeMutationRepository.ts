import { randomUUID } from "node:crypto";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import { booleanValue, convertSql, type DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import {
  createKnowledgeTreeReadRepository,
  type KnowledgeTreeReadNode,
} from "./knowledgeTreeReadRepository";

export type KnowledgeTreeMutationStatus = 400 | 403 | 404 | 409;

export class KnowledgeTreeMutationError extends Error {
  constructor(
    readonly code: string,
    readonly status: KnowledgeTreeMutationStatus,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "KnowledgeTreeMutationError";
  }
}

export type CreateKnowledgeTreeNodeInput = {
  actorUserId: string;
  workspaceId: string | null;
  parentId: string | null;
  nodeType: "folder" | "note" | "markdown" | "word";
  title: string;
};

export type PatchKnowledgeTreeNodeInput = {
  actorUserId: string;
  workspaceId: string | null;
  nodeId: string;
  title?: string;
  isExpanded?: boolean;
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

type SortOrderRow = {
  value: number | string | null;
};

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

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function titleStatement(node: KnowledgeTreeReadNode, title: string): DbStatement | null {
  if (node.resourceType === "notebook") {
    return {
      sql: "UPDATE notebooks SET name = ?, updatedAt = datetime('now') WHERE id = ?",
      params: [title, node.resourceId],
      requireChanges: 1,
    };
  }
  if (node.resourceType === "note") {
    return {
      sql: "UPDATE notes SET title = ?, version = version + 1, updatedAt = datetime('now') WHERE id = ?",
      params: [title, node.resourceId],
      requireChanges: 1,
    };
  }
  if (node.resourceType === "mindmap") {
    return {
      sql: "UPDATE mindmaps SET title = ?, updatedAt = datetime('now') WHERE id = ?",
      params: [title, node.resourceId],
      requireChanges: 1,
    };
  }
  return null;
}

function mapStatementError(error: unknown): never {
  if (error instanceof DbStatementChangeError) {
    throw new KnowledgeTreeMutationError(
      "KNOWLEDGE_NODE_STALE",
      409,
      "内容已发生变化，请刷新后重试",
    );
  }
  throw error;
}

async function canCreateAtWorkspaceRoot(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  actorUserId: string,
  workspaceId: string | null,
): Promise<boolean> {
  if (!workspaceId) return true;

  const row = await adapter.queryOne<WorkspaceAccessRow>(
    convertSql(
      `SELECT workspace.ownerId AS ownerId, member.role AS role
         FROM workspaces workspace
         LEFT JOIN workspace_members member
           ON member.workspaceId = workspace.id AND member.userId = ?
        WHERE workspace.id = ?`,
      dialect,
    ),
    [actorUserId, workspaceId],
  );
  if (!row) return false;
  if (row.ownerId === actorUserId) return true;
  return ["owner", "admin", "manage", "editor", "write"].includes(row.role || "");
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

async function nextSortOrder(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
  key: string,
  parentId: string | null,
): Promise<number> {
  const row = parentId
    ? await adapter.queryOne<SortOrderRow>(
        convertSql(
          `SELECT COALESCE(MAX(sortOrder), -1) AS value
             FROM knowledge_tree_nodes
            WHERE scopeKey = ? AND parentId = ? AND isDeleted = 0`,
          dialect,
        ),
        [key, parentId],
      )
    : await adapter.queryOne<SortOrderRow>(
        convertSql(
          `SELECT COALESCE(MAX(sortOrder), -1) AS value
             FROM knowledge_tree_nodes
            WHERE scopeKey = ? AND parentId IS NULL AND isDeleted = 0`,
          dialect,
        ),
        [key],
      );
  const current = Number(row?.value ?? -1);
  return (Number.isFinite(current) ? current : -1) + 1;
}

export function createKnowledgeTreeMutationRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);
  const readRepository = createKnowledgeTreeReadRepository(adapter, dialect);

  return {
    async createNode(input: CreateKnowledgeTreeNodeInput): Promise<KnowledgeTreeReadNode> {
      const activeAdapter = getAdapter();
      const activeDialect = getDialect();
      const visibleNodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
      });
      const parent = input.parentId
        ? visibleNodes.find((node) => node.id === input.parentId) || null
        : null;

      if (input.parentId && !parent) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_NOT_FOUND",
          404,
          "父级内容节点不存在",
        );
      }
      if (parent && !parent.access.capabilities.canCreate) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_CAPABILITY_FORBIDDEN",
          403,
          "没有在此处新建内容的权限",
          { required: "canCreate" },
        );
      }
      if (!parent && !(await canCreateAtWorkspaceRoot(
        activeAdapter,
        activeDialect,
        input.actorUserId,
        input.workspaceId,
      ))) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_CAPABILITY_FORBIDDEN",
          403,
          "没有在此处新建内容的权限",
          { required: "canCreate" },
        );
      }

      const normalizedWorkspaceId = parent ? parent.workspaceId : input.workspaceId;
      const resourceOwnerUserId = parent && !parent.workspaceId
        ? parent.userId
        : input.actorUserId;
      const key = parent?.scopeKey || scopeKey(resourceOwnerUserId, normalizedWorkspaceId);
      const title = input.title.trim()
        || (input.nodeType === "folder" ? "新建文件夹" : "无标题笔记");
      const sortOrder = await nextSortOrder(
        activeAdapter,
        activeDialect,
        key,
        input.parentId,
      );
      const notebookContainerId = await nearestNotebookContainer(
        activeAdapter,
        activeDialect,
        parent,
      );

      if (input.nodeType !== "folder" && !notebookContainerId) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED",
          400,
          "根级文档需要先创建文件夹",
        );
      }

      const resourceId = randomUUID();
      const nodeId = `${input.nodeType === "folder" ? "notebook" : "note"}:${resourceId}`;
      const statements: DbStatement[] = [];

      if (input.nodeType === "folder") {
        statements.push({
          sql: `INSERT INTO notebooks (
                  id, userId, workspaceId, parentId, name, icon, sortOrder
                ) VALUES (?, ?, ?, ?, ?, '📁', ?)`,
          params: [
            resourceId,
            resourceOwnerUserId,
            normalizedWorkspaceId,
            notebookContainerId,
            title,
            sortOrder,
          ],
          requireChanges: 1,
        });
      } else {
        const contentFormat = input.nodeType === "markdown" ? "markdown" : "tiptap-json";
        const noteType = input.nodeType === "word" ? "word" : "normal";
        const content = contentFormat === "markdown" ? `# ${title}\n\n` : "{}";
        statements.push({
          sql: `INSERT INTO notes (
                  id, userId, workspaceId, notebookId, title, content, contentText,
                  contentFormat, note_type, sortOrder
                ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
          params: [
            resourceId,
            resourceOwnerUserId,
            normalizedWorkspaceId,
            notebookContainerId,
            title,
            content,
            contentFormat,
            noteType,
            sortOrder,
          ],
          requireChanges: 1,
        });
      }

      statements.push(
        {
          sql: `UPDATE knowledge_tree_nodes
                   SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
                 WHERE id = ? AND scopeKey = ? AND isDeleted = 0`,
          params: [input.parentId, sortOrder, nodeId, key],
          requireChanges: 1,
        },
        {
          sql: `INSERT INTO knowledge_tree_history (
                  id, nodeId, action, actorUserId, fromParentId, toParentId, metadata
                ) VALUES (?, ?, 'create', ?, NULL, ?, ?)`,
          params: [
            randomUUID(),
            nodeId,
            input.actorUserId,
            input.parentId,
            JSON.stringify({ nodeType: input.nodeType, title }),
          ],
          requireChanges: 1,
        },
      );

      try {
        await activeAdapter.executeStatements(
          statements.map((statement) => ({
            ...statement,
            sql: convertSql(statement.sql, activeDialect),
          })),
        );
      } catch (error) {
        mapStatementError(error);
      }

      const refreshedNodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: normalizedWorkspaceId,
      });
      const created = refreshedNodes.find((node) => node.id === nodeId);
      if (!created) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_SYNC_FAILED",
          409,
          "内容节点同步失败",
        );
      }
      return created;
    },

    async patchNode(input: PatchKnowledgeTreeNodeInput): Promise<KnowledgeTreeReadNode> {
      const currentNodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
      });
      const current = currentNodes.find((node) => node.id === input.nodeId);
      if (!current) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_NOT_FOUND",
          404,
          "内容节点不存在",
        );
      }

      let titleMutation: DbStatement | null = null;
      if (input.title !== undefined) {
        if (!current.access.capabilities.canEdit) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_CAPABILITY_FORBIDDEN",
            403,
            "没有重命名权限",
            { required: "canEdit" },
          );
        }
        const title = input.title.trim();
        if (!title) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_TITLE_REQUIRED",
            400,
            "名称不能为空",
          );
        }
        titleMutation = titleStatement(current, title);
      }

      const statements: DbStatement[] = [];
      if (input.isExpanded !== undefined) {
        if (!current.access.capabilities.canView) {
          throw new KnowledgeTreeMutationError(
            "KNOWLEDGE_CAPABILITY_FORBIDDEN",
            403,
            "权限不足",
            { required: "canView" },
          );
        }
        const expanded = booleanValue(input.isExpanded, getDialect());
        statements.push({
          sql: "UPDATE knowledge_tree_nodes SET isExpanded = ?, updatedAt = datetime('now') WHERE id = ? AND isDeleted = 0",
          params: [expanded, current.id],
          requireChanges: 1,
        });
        if (current.resourceType === "notebook") {
          statements.push({
            sql: "UPDATE notebooks SET isExpanded = ?, updatedAt = datetime('now') WHERE id = ?",
            params: [expanded, current.resourceId],
            requireChanges: 1,
          });
        }
      }
      if (titleMutation) statements.push(titleMutation);

      if (statements.length > 0) {
        const activeDialect = getDialect();
        try {
          await getAdapter().executeStatements(
            statements.map((statement) => ({
              ...statement,
              sql: convertSql(statement.sql, activeDialect),
            })),
          );
        } catch (error) {
          mapStatementError(error);
        }
      }

      const refreshedNodes = await readRepository.list({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
      });
      const refreshed = refreshedNodes.find((node) => node.id === input.nodeId);
      if (!refreshed) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_NOT_FOUND",
          404,
          "内容节点不存在",
        );
      }
      return refreshed;
    },
  };
}

export const knowledgeTreeMutationRepository = createKnowledgeTreeMutationRepository();
