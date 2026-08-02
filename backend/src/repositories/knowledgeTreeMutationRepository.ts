import type { DatabaseAdapter, DbStatement } from "../db/adapters/types";
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

export type PatchKnowledgeTreeNodeInput = {
  actorUserId: string;
  workspaceId: string | null;
  nodeId: string;
  title?: string;
  isExpanded?: boolean;
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

export function createKnowledgeTreeMutationRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);
  const readRepository = createKnowledgeTreeReadRepository(adapter, dialect);

  return {
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

      const statements: DbStatement[] = [];
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
        const statement = titleStatement(current, title);
        if (statement) statements.push(statement);
      }

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

      if (statements.length > 0) {
        const activeDialect = getDialect();
        await getAdapter().executeStatements(
          statements.map((statement) => ({
            ...statement,
            sql: convertSql(statement.sql, activeDialect),
          })),
        );
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
