import { randomUUID } from "node:crypto";

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
import type {
  EffectiveKnowledgeAccess,
  KnowledgeCapabilities,
  KnowledgeRolePreset,
} from "../services/knowledgeCapabilitiesCore";
import { KnowledgeTreeMutationError } from "./knowledgeTreeMutationRepository";
import { createKnowledgeTreeReadRepository } from "./knowledgeTreeReadRepository";

export type KnowledgePermissionUser = {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
};

export type KnowledgePermissionRow = {
  nodeId: string;
  userId: string;
  rolePreset: KnowledgeRolePreset;
  username: string;
  displayName: string | null;
  email: string | null;
  capabilities: KnowledgeCapabilities;
  updatedAt: string;
};

export type KnowledgePermissionsResult = {
  direct: KnowledgePermissionRow[];
  inheritsFromParent: string | null;
  currentUserAccess: EffectiveKnowledgeAccess;
};

type PermissionNodeRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  resourceType: "notebook" | "note" | "mindmap" | "file";
  resourceId: string;
  sortOrder: number | string;
  isDeleted: boolean | number | string;
};

type AclRow = {
  nodeId: string;
  userId: string;
  rolePreset: KnowledgeRolePreset;
  canView: boolean | number | string;
  canComment: boolean | number | string;
  canCreate: boolean | number | string;
  canEdit: boolean | number | string;
  canDelete: boolean | number | string;
  canMove: boolean | number | string;
  canDownload: boolean | number | string;
  canReshare: boolean | number | string;
  canManageMembers: boolean | number | string;
  grantedBy: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  username?: string;
  displayName?: string | null;
  email?: string | null;
};

const NONE: KnowledgeCapabilities = {
  canView: false,
  canComment: false,
  canCreate: false,
  canEdit: false,
  canDelete: false,
  canMove: false,
  canDownload: false,
  canReshare: false,
  canManageMembers: false,
};

const ROLE_PRESETS: Record<KnowledgeRolePreset, KnowledgeCapabilities> = {
  readonly: {
    ...NONE,
    canView: true,
    canDownload: true,
  },
  editor: {
    ...NONE,
    canView: true,
    canComment: true,
    canCreate: true,
    canEdit: true,
    canDownload: true,
  },
  maintainer: {
    ...NONE,
    canView: true,
    canComment: true,
    canCreate: true,
    canEdit: true,
    canDelete: true,
    canMove: true,
    canDownload: true,
  },
  admin: {
    canView: true,
    canComment: true,
    canCreate: true,
    canEdit: true,
    canDelete: true,
    canMove: true,
    canDownload: true,
    canReshare: true,
    canManageMembers: true,
  },
};

const ACL_COLUMNS = [
  "canView",
  "canComment",
  "canCreate",
  "canEdit",
  "canDelete",
  "canMove",
  "canDownload",
  "canReshare",
  "canManageMembers",
] as const;

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

function toBoolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function toNumber(value: number | string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowCapabilities(row: AclRow): KnowledgeCapabilities {
  return {
    canView: toBoolean(row.canView),
    canComment: toBoolean(row.canComment),
    canCreate: toBoolean(row.canCreate),
    canEdit: toBoolean(row.canEdit),
    canDelete: toBoolean(row.canDelete),
    canMove: toBoolean(row.canMove),
    canDownload: toBoolean(row.canDownload),
    canReshare: toBoolean(row.canReshare),
    canManageMembers: toBoolean(row.canManageMembers),
  };
}

function permissionRow(row: AclRow): KnowledgePermissionRow {
  return {
    nodeId: row.nodeId,
    userId: row.userId,
    rolePreset: row.rolePreset,
    username: row.username || row.userId,
    displayName: row.displayName ?? null,
    email: row.email ?? null,
    capabilities: rowCapabilities(row),
    updatedAt: toTimestamp(row.updatedAt),
  };
}

function noneAccess(nodeId: string): EffectiveKnowledgeAccess {
  return {
    nodeId,
    rolePreset: "none",
    capabilities: { ...NONE },
    source: "none",
    sourceNodeId: null,
  };
}

function sameCapabilities(left: KnowledgeCapabilities, right: KnowledgeCapabilities): boolean {
  return ACL_COLUMNS.every((name) => left[name] === right[name]);
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
      "KNOWLEDGE_PERMISSION_STALE",
      409,
      "成员权限已发生变化，请刷新后重试",
    );
  }
  throw error;
}

function actorAuthorizationGuard(
  node: PermissionNodeRow,
  actorUserId: string,
  access: EffectiveKnowledgeAccess,
): DbStatement {
  const structure = `id = ?
    AND scopeKey = ?
    AND COALESCE(parentId, '') = COALESCE(?, '')
    AND sortOrder = ?
    AND isDeleted = 0`;
  const params: unknown[] = [node.id, node.scopeKey, node.parentId, toNumber(node.sortOrder)];

  if (access.source === "owner") {
    return {
      sql: `UPDATE knowledge_tree_nodes
               SET updatedAt = updatedAt
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
      params: [...params, actorUserId, actorUserId],
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
               SET updatedAt = updatedAt
             WHERE ${structure}
               AND EXISTS (
                 SELECT 1 FROM nearest_acl
                  WHERE nodeId = ? AND canManageMembers = 1
               )`,
      params: [node.id, actorUserId, ...params, access.sourceNodeId],
      requireChanges: 1,
    };
  }

  return {
    sql: `UPDATE knowledge_tree_nodes
             SET updatedAt = updatedAt
           WHERE ${structure}
             AND (
               CASE
                 WHEN resourceType = 'notebook' THEN COALESCE((
                   SELECT member.role
                     FROM notebook_members member
                    WHERE member.notebookId = resourceId
                      AND member.userId = ?
                      AND member.status != 'removed'
                    LIMIT 1
                 ), (
                   SELECT workspace_member.role
                     FROM workspace_members workspace_member
                    WHERE workspace_member.workspaceId = workspaceId
                      AND workspace_member.userId = ?
                    LIMIT 1
                 ))
                 WHEN resourceType = 'note' THEN COALESCE((
                   SELECT member.role
                     FROM notes note
                     JOIN notebook_members member ON member.notebookId = note.notebookId
                    WHERE note.id = resourceId
                      AND member.userId = ?
                      AND member.status != 'removed'
                    LIMIT 1
                 ), (
                   SELECT note_permission.permission
                     FROM note_acl note_permission
                    WHERE note_permission.noteId = resourceId
                      AND note_permission.userId = ?
                    LIMIT 1
                 ), (
                   SELECT workspace_member.role
                     FROM workspace_members workspace_member
                    WHERE workspace_member.workspaceId = workspaceId
                      AND workspace_member.userId = ?
                    LIMIT 1
                 ))
                 ELSE (
                   SELECT workspace_member.role
                     FROM workspace_members workspace_member
                    WHERE workspace_member.workspaceId = workspaceId
                      AND workspace_member.userId = ?
                    LIMIT 1
                 )
               END
             ) IN ('manage', 'admin', 'owner')`,
    params: [
      ...params,
      actorUserId,
      actorUserId,
      actorUserId,
      actorUserId,
      actorUserId,
      actorUserId,
    ],
    requireChanges: 1,
  };
}

function targetNotOwnerGuard(node: PermissionNodeRow, targetUserId: string): DbStatement {
  return {
    sql: `UPDATE knowledge_tree_nodes
             SET updatedAt = updatedAt
           WHERE id = ?
             AND scopeKey = ?
             AND (
               (workspaceId IS NULL AND userId != ?)
               OR (
                 workspaceId IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM workspaces workspace
                    WHERE workspace.id = knowledge_tree_nodes.workspaceId
                      AND workspace.ownerId = ?
                 )
               )
             )`,
    params: [node.id, node.scopeKey, targetUserId, targetUserId],
    requireChanges: 1,
  };
}

function aclSnapshotParams(row: AclRow, dialect: DatabaseDialect): unknown[] {
  const capabilities = rowCapabilities(row);
  return [
    row.nodeId,
    row.userId,
    row.rolePreset,
    ...ACL_COLUMNS.map((name) => booleanValue(capabilities[name], dialect)),
    row.grantedBy,
  ];
}

function aclSnapshotWhere(): string {
  return `nodeId = ?
    AND userId = ?
    AND rolePreset = ?
    AND canView = ?
    AND canComment = ?
    AND canCreate = ?
    AND canEdit = ?
    AND canDelete = ?
    AND canMove = ?
    AND canDownload = ?
    AND canReshare = ?
    AND canManageMembers = ?
    AND COALESCE(grantedBy, '') = COALESCE(?, '')`;
}

function metadataExpression(dialect: DatabaseDialect): string {
  return dialect === "postgres" ? "CAST(? AS JSONB)" : "?";
}

export function isKnowledgeRolePreset(value: unknown): value is KnowledgeRolePreset {
  return value === "readonly" || value === "editor" || value === "maintainer" || value === "admin";
}

export function createKnowledgeTreePermissionMutationRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);
  const readRepository = createKnowledgeTreeReadRepository(adapter, dialect);

  async function readNode(
    actorUserId: string,
    workspaceId: string | null,
    nodeId: string,
  ): Promise<PermissionNodeRow> {
    const node = await getAdapter().queryOne<PermissionNodeRow>(
      convertSql(
        `SELECT id, userId, workspaceId, scopeKey, parentId, resourceType,
                resourceId, sortOrder, isDeleted
           FROM knowledge_tree_nodes
          WHERE id = ?`,
        getDialect(),
      ),
      [nodeId],
    );
    if (!node || toBoolean(node.isDeleted)) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_NODE_NOT_FOUND",
        404,
        "内容节点不存在",
      );
    }
    if (node.scopeKey !== scopeKey(actorUserId, workspaceId)) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_TREE_SCOPE_MISMATCH",
        409,
        "内容节点不属于当前空间",
      );
    }
    return node;
  }

  async function effectiveAccess(
    nodeId: string,
    userId: string,
    workspaceId: string | null,
  ): Promise<EffectiveKnowledgeAccess> {
    const node = (await readRepository.list({ userId, workspaceId }))
      .find((entry) => entry.id === nodeId);
    return node?.access || noneAccess(nodeId);
  }

  async function requireManager(
    actorUserId: string,
    workspaceId: string | null,
    nodeId: string,
  ): Promise<{ node: PermissionNodeRow; access: EffectiveKnowledgeAccess }> {
    const node = await readNode(actorUserId, workspaceId, nodeId);
    const access = await effectiveAccess(nodeId, actorUserId, workspaceId);
    if (!access.capabilities.canManageMembers) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_CAPABILITY_FORBIDDEN",
        403,
        "没有成员管理权限",
        { required: "canManageMembers" },
      );
    }
    return { node, access };
  }

  async function resolveSubject(subject: string): Promise<KnowledgePermissionUser> {
    const normalized = subject.trim();
    if (!normalized) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_PERMISSION_USER_NOT_FOUND",
        404,
        "用户不存在",
      );
    }
    const user = await getAdapter().queryOne<KnowledgePermissionUser>(
      convertSql(
        `SELECT id, username, displayName, email
           FROM users
          WHERE id = ?
             OR lower(username) = lower(?)
             OR lower(COALESCE(email, '')) = lower(?)
          LIMIT 1`,
        getDialect(),
      ),
      [normalized, normalized, normalized],
    );
    if (!user) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_PERMISSION_USER_NOT_FOUND",
        404,
        "用户不存在",
      );
    }
    return user;
  }

  async function directAcl(nodeId: string, userId: string): Promise<AclRow | null> {
    return await getAdapter().queryOne<AclRow>(
      convertSql(
        `SELECT nodeId, userId, rolePreset,
                canView, canComment, canCreate, canEdit, canDelete, canMove,
                canDownload, canReshare, canManageMembers,
                grantedBy, createdAt, updatedAt
           FROM knowledge_tree_acl
          WHERE nodeId = ? AND userId = ?`,
        getDialect(),
      ),
      [nodeId, userId],
    ) ?? null;
  }

  async function directAclWithUser(nodeId: string, userId: string): Promise<AclRow> {
    const row = await getAdapter().queryOne<AclRow>(
      convertSql(
        `SELECT acl.nodeId, acl.userId, acl.rolePreset,
                acl.canView, acl.canComment, acl.canCreate, acl.canEdit,
                acl.canDelete, acl.canMove, acl.canDownload, acl.canReshare,
                acl.canManageMembers, acl.grantedBy, acl.createdAt, acl.updatedAt,
                user.username, user.displayName, user.email
           FROM knowledge_tree_acl acl
           JOIN users user ON user.id = acl.userId
          WHERE acl.nodeId = ? AND acl.userId = ?`,
        getDialect(),
      ),
      [nodeId, userId],
    );
    if (!row) {
      throw new KnowledgeTreeMutationError(
        "KNOWLEDGE_PERMISSION_STALE",
        409,
        "成员权限已发生变化，请刷新后重试",
      );
    }
    return row;
  }

  return {
    async listPermissions(input: {
      actorUserId: string;
      workspaceId: string | null;
      nodeId: string;
    }): Promise<KnowledgePermissionsResult> {
      const { node, access } = await requireManager(
        input.actorUserId,
        input.workspaceId,
        input.nodeId,
      );
      const rows = await getAdapter().queryMany<AclRow>(
        convertSql(
          `SELECT acl.nodeId, acl.userId, acl.rolePreset,
                  acl.canView, acl.canComment, acl.canCreate, acl.canEdit,
                  acl.canDelete, acl.canMove, acl.canDownload, acl.canReshare,
                  acl.canManageMembers, acl.grantedBy, acl.createdAt, acl.updatedAt,
                  user.username, user.displayName, user.email
             FROM knowledge_tree_acl acl
             JOIN users user ON user.id = acl.userId
            WHERE acl.nodeId = ?
            ORDER BY lower(COALESCE(user.displayName, user.username)), user.id`,
          getDialect(),
        ),
        [input.nodeId],
      );
      return {
        direct: rows.map(permissionRow),
        inheritsFromParent: node.parentId,
        currentUserAccess: access,
      };
    },

    async setPermission(input: {
      actorUserId: string;
      workspaceId: string | null;
      nodeId: string;
      subject: string;
      rolePreset: KnowledgeRolePreset;
    }): Promise<KnowledgePermissionRow & { effective: EffectiveKnowledgeAccess }> {
      const { node, access } = await requireManager(
        input.actorUserId,
        input.workspaceId,
        input.nodeId,
      );
      const target = await resolveSubject(input.subject);
      if (target.id === input.actorUserId && access.source !== "owner") {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_PERMISSION_SELF_LOCKOUT",
          409,
          "不能修改自己的权限",
        );
      }

      const dialectValue = getDialect();
      const existing = await directAcl(input.nodeId, target.id);
      const capabilities = ROLE_PRESETS[input.rolePreset];
      if (
        existing
        && existing.rolePreset === input.rolePreset
        && sameCapabilities(rowCapabilities(existing), capabilities)
      ) {
        const row = permissionRow(await directAclWithUser(input.nodeId, target.id));
        return {
          ...row,
          effective: await effectiveAccess(input.nodeId, target.id, input.workspaceId),
        };
      }

      const statements: DbStatement[] = [
        actorAuthorizationGuard(node, input.actorUserId, access),
        targetNotOwnerGuard(node, target.id),
      ];
      const presetValues = ACL_COLUMNS.map((name) => booleanValue(capabilities[name], dialectValue));
      if (existing) {
        statements.push({
          sql: `UPDATE knowledge_tree_acl
                   SET rolePreset = ?,
                       canView = ?, canComment = ?, canCreate = ?, canEdit = ?,
                       canDelete = ?, canMove = ?, canDownload = ?, canReshare = ?,
                       canManageMembers = ?, grantedBy = ?, updatedAt = ${nowExpression(dialectValue)}
                 WHERE ${aclSnapshotWhere()}`,
          params: [
            input.rolePreset,
            ...presetValues,
            input.actorUserId,
            ...aclSnapshotParams(existing, dialectValue),
          ],
          requireChanges: 1,
        });
      } else {
        statements.push({
          sql: `INSERT INTO knowledge_tree_acl (
                  nodeId, userId, rolePreset,
                  canView, canComment, canCreate, canEdit, canDelete, canMove,
                  canDownload, canReshare, canManageMembers,
                  grantedBy, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          ${nowExpression(dialectValue)}, ${nowExpression(dialectValue)})`,
          params: [
            input.nodeId,
            target.id,
            input.rolePreset,
            ...presetValues,
            input.actorUserId,
          ],
          requireChanges: 1,
        });
      }
      statements.push({
        sql: `INSERT INTO knowledge_tree_history (
                id, nodeId, action, actorUserId, targetUserId, metadata
              ) VALUES (?, ?, 'permission_set', ?, ?, ${metadataExpression(dialectValue)})`,
        params: [
          randomUUID(),
          input.nodeId,
          input.actorUserId,
          target.id,
          JSON.stringify({ rolePreset: input.rolePreset, capabilities }),
        ],
        requireChanges: 1,
      });

      try {
        await getAdapter().executeStatements(statements.map((statement) => ({
          ...statement,
          sql: convertSql(statement.sql, dialectValue),
        })));
      } catch (error) {
        mapTransactionError(error);
      }

      const row = permissionRow(await directAclWithUser(input.nodeId, target.id));
      return {
        ...row,
        effective: await effectiveAccess(input.nodeId, target.id, input.workspaceId),
      };
    },

    async clearPermission(input: {
      actorUserId: string;
      workspaceId: string | null;
      nodeId: string;
      targetUserId: string;
    }): Promise<{ success: true; removed: boolean; effective: EffectiveKnowledgeAccess }> {
      const { node, access } = await requireManager(
        input.actorUserId,
        input.workspaceId,
        input.nodeId,
      );
      if (input.targetUserId === input.actorUserId && access.source !== "owner") {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_PERMISSION_SELF_LOCKOUT",
          409,
          "不能修改自己的权限",
        );
      }

      const existing = await directAcl(input.nodeId, input.targetUserId);
      if (!existing) {
        return {
          success: true,
          removed: false,
          effective: await effectiveAccess(
            input.nodeId,
            input.targetUserId,
            input.workspaceId,
          ),
        };
      }

      const dialectValue = getDialect();
      const statements: DbStatement[] = [
        actorAuthorizationGuard(node, input.actorUserId, access),
        targetNotOwnerGuard(node, input.targetUserId),
        {
          sql: `DELETE FROM knowledge_tree_acl WHERE ${aclSnapshotWhere()}`,
          params: aclSnapshotParams(existing, dialectValue),
          requireChanges: 1,
        },
        {
          sql: `INSERT INTO knowledge_tree_history (
                  id, nodeId, action, actorUserId, targetUserId, metadata
                ) VALUES (?, ?, 'permission_clear', ?, ?, NULL)`,
          params: [
            randomUUID(),
            input.nodeId,
            input.actorUserId,
            input.targetUserId,
          ],
          requireChanges: 1,
        },
      ];

      try {
        await getAdapter().executeStatements(statements.map((statement) => ({
          ...statement,
          sql: convertSql(statement.sql, dialectValue),
        })));
      } catch (error) {
        mapTransactionError(error);
      }

      return {
        success: true,
        removed: true,
        effective: await effectiveAccess(
          input.nodeId,
          input.targetUserId,
          input.workspaceId,
        ),
      };
    },
  };
}

export const knowledgeTreePermissionMutationRepository =
  createKnowledgeTreePermissionMutationRepository();
