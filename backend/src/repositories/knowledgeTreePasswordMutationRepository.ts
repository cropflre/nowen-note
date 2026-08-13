import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import {
  booleanValue,
  convertSql,
  nowExpression,
  type DatabaseDialect,
} from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import type { EffectiveKnowledgeAccess } from "../services/knowledgeCapabilitiesCore";
import { KnowledgeTreeMutationError } from "./knowledgeTreeMutationRepository";
import {
  createKnowledgeTreeNodeAccessRepository,
  type KnowledgeTreeAccessNode,
} from "./knowledgeTreeNodeAccessRepository";

export type KnowledgeTreeFolderPasswordTarget = {
  node: KnowledgeTreeAccessNode;
  access: EffectiveKnowledgeAccess;
  notebookId: string;
  passwordHash: string | null;
  passwordVersion: number;
};

type PasswordRow = {
  passwordHash: string;
  passwordVersion: number | string;
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

function toNumber(value: number | string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function mapTransactionError(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  if (
    error instanceof DbStatementChangeError
    || code === "23505"
    || code === "23503"
    || code.startsWith("SQLITE_CONSTRAINT")
  ) {
    throw new KnowledgeTreeMutationError(
      "FOLDER_PASSWORD_STALE",
      409,
      "文件夹密码已发生变化，请刷新后重试",
    );
  }
  throw error;
}

function actorGuard(
  node: KnowledgeTreeAccessNode,
  actorUserId: string,
  access: EffectiveKnowledgeAccess,
  dialect: DatabaseDialect,
): DbStatement {
  const structure = `id = ?
    AND scopeKey = ?
    AND COALESCE(parentId, '') = COALESCE(?, '')
    AND sortOrder = ?
    AND resourceType = 'notebook'
    AND resourceId = ?
    AND isDeleted = ?`;
  const params: unknown[] = [
    node.id,
    node.scopeKey,
    node.parentId,
    node.sortOrder,
    node.resourceId,
    booleanValue(false, dialect),
  ];
  const setClause = `isExpanded = ?, updatedAt = ${nowExpression(dialect)}`;
  const collapsed = booleanValue(false, dialect);

  if (access.source === "owner") {
    return {
      sql: `UPDATE knowledge_tree_nodes
               SET ${setClause}
             WHERE ${structure}
               AND (
                 (workspaceId IS NULL AND userId = ?)
                 OR (
                   workspaceId IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM workspaces workspace
                      WHERE workspace.id = knowledge_tree_nodes.workspaceId
                        AND workspace.ownerId = ?
                   )
                 )
               )`,
      params: [collapsed, ...params, actorUserId, actorUserId],
      requireChanges: 1,
    };
  }

  if ((access.source === "direct" || access.source === "inherited") && access.sourceNodeId) {
    return {
      sql: `WITH RECURSIVE ancestors(id, parentId, depth) AS (
              SELECT id, parentId, 0
                FROM knowledge_tree_nodes
               WHERE id = ?
              UNION ALL
              SELECT parent.id, parent.parentId, ancestors.depth + 1
                FROM knowledge_tree_nodes parent
                JOIN ancestors ON parent.id = ancestors.parentId
            ), nearest_acl AS (
              SELECT acl.nodeId, acl.canManageMembers
                FROM ancestors
                JOIN knowledge_tree_acl acl
                  ON acl.nodeId = ancestors.id AND acl.userId = ?
               ORDER BY ancestors.depth ASC
               LIMIT 1
            )
            UPDATE knowledge_tree_nodes
               SET ${setClause}
             WHERE ${structure}
               AND EXISTS (
                 SELECT 1 FROM nearest_acl
                  WHERE nodeId = ? AND canManageMembers = ?
               )`,
      params: [
        node.id,
        actorUserId,
        collapsed,
        ...params,
        access.sourceNodeId,
        booleanValue(true, dialect),
      ],
      requireChanges: 1,
    };
  }

  return {
    sql: `UPDATE knowledge_tree_nodes
             SET ${setClause}
           WHERE ${structure}
             AND (
               EXISTS (
                 SELECT 1 FROM notebook_members member
                  WHERE member.notebookId = knowledge_tree_nodes.resourceId
                    AND member.userId = ?
                    AND member.status != 'removed'
                    AND member.role IN ('owner', 'admin', 'manage')
               )
               OR EXISTS (
                 SELECT 1 FROM workspaces workspace
                  WHERE workspace.id = knowledge_tree_nodes.workspaceId
                    AND workspace.ownerId = ?
               )
               OR EXISTS (
                 SELECT 1 FROM workspace_members member
                  WHERE member.workspaceId = knowledge_tree_nodes.workspaceId
                    AND member.userId = ?
                    AND member.role IN ('owner', 'admin', 'manage')
               )
             )`,
    params: [collapsed, ...params, actorUserId, actorUserId, actorUserId],
    requireChanges: 1,
  };
}

export function createKnowledgeTreePasswordMutationRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);
  const accessRepository = createKnowledgeTreeNodeAccessRepository(adapter, dialect);

  async function readTarget(input: {
    actorUserId: string;
    nodeId: string;
    requiredCapability: "canView" | "canManageMembers";
  }): Promise<KnowledgeTreeFolderPasswordTarget> {
    const resolved = await accessRepository.resolveOne({
      nodeId: input.nodeId,
      userId: input.actorUserId,
    });
    if (!resolved || resolved.node.resourceType !== "notebook") {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_FOLDER_NOT_FOUND",
        404,
        "文件夹不存在",
      );
    }
    if (!resolved.access.capabilities[input.requiredCapability]) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_CAPABILITY_FORBIDDEN",
        403,
        input.requiredCapability === "canView" ? "没有查看权限" : "没有密码管理权限",
        { required: input.requiredCapability, source: resolved.access.source },
      );
    }

    const password = await getAdapter().queryOne<PasswordRow>(
      convertSql(
        `SELECT passwordHash, passwordVersion
           FROM notebook_passwords
          WHERE notebookId = ?`,
        getDialect(),
      ),
      [resolved.node.resourceId],
    );

    return {
      node: resolved.node,
      access: resolved.access,
      notebookId: resolved.node.resourceId,
      passwordHash: password?.passwordHash || null,
      passwordVersion: password ? toNumber(password.passwordVersion) : 0,
    };
  }

  return {
    readForUnlock(input: { actorUserId: string; nodeId: string }) {
      return readTarget({ ...input, requiredCapability: "canView" });
    },

    readForUpdate(input: { actorUserId: string; nodeId: string }) {
      return readTarget({ ...input, requiredCapability: "canManageMembers" });
    },

    async setPassword(input: {
      actorUserId: string;
      nodeId: string;
      passwordHash: string;
      expectedPasswordHash: string | null;
      expectedPasswordVersion: number;
    }): Promise<{ success: true; isPasswordProtected: true; passwordVersion: number }> {
      const target = await readTarget({
        actorUserId: input.actorUserId,
        nodeId: input.nodeId,
        requiredCapability: "canManageMembers",
      });
      if (
        target.passwordHash !== input.expectedPasswordHash
        || target.passwordVersion !== input.expectedPasswordVersion
      ) {
        throw new KnowledgeTreeMutationError(
          "FOLDER_PASSWORD_STALE",
          409,
          "文件夹密码已发生变化，请刷新后重试",
        );
      }

      const databaseDialect = getDialect();
      const nextVersion = target.passwordVersion + 1;
      const statements: DbStatement[] = [
        actorGuard(target.node, input.actorUserId, target.access, databaseDialect),
      ];

      if (target.passwordHash) {
        statements.push({
          sql: `UPDATE notebook_passwords
                   SET passwordHash = ?, passwordVersion = ?,
                       updatedAt = ${nowExpression(databaseDialect)}
                 WHERE notebookId = ?
                   AND passwordHash = ?
                   AND passwordVersion = ?`,
          params: [
            input.passwordHash,
            nextVersion,
            target.notebookId,
            target.passwordHash,
            target.passwordVersion,
          ],
          requireChanges: 1,
        });
      } else {
        statements.push({
          sql: `INSERT INTO notebook_passwords (
                  notebookId, passwordHash, passwordVersion, updatedAt
                ) VALUES (?, ?, ?, ${nowExpression(databaseDialect)})`,
          params: [target.notebookId, input.passwordHash, nextVersion],
          requireChanges: 1,
        });
      }

      statements.push({
        sql: `UPDATE notebooks
                 SET isExpanded = ?, updatedAt = ${nowExpression(databaseDialect)}
               WHERE id = ?`,
        params: [booleanValue(false, databaseDialect), target.notebookId],
        requireChanges: 1,
      });

      try {
        await getAdapter().executeStatements(
          statements.map((statement) => ({
            ...statement,
            sql: convertSql(statement.sql, databaseDialect),
          })),
        );
      } catch (error) {
        mapTransactionError(error);
      }

      return {
        success: true,
        isPasswordProtected: true,
        passwordVersion: nextVersion,
      };
    },
  };
}

export const knowledgeTreePasswordMutationRepository =
  createKnowledgeTreePasswordMutationRepository();
