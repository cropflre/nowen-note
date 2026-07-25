import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { memberQueryService } from "../queries/memberQueryService.js";

export type KnowledgeRolePreset = "readonly" | "editor" | "maintainer" | "admin";
export type KnowledgeCapabilityName =
  | "canView"
  | "canComment"
  | "canCreate"
  | "canEdit"
  | "canDelete"
  | "canMove"
  | "canDownload"
  | "canReshare"
  | "canManageMembers";

export interface KnowledgeCapabilities {
  canView: boolean;
  canComment: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canMove: boolean;
  canDownload: boolean;
  canReshare: boolean;
  canManageMembers: boolean;
}

export interface EffectiveKnowledgeAccess {
  nodeId: string;
  rolePreset: KnowledgeRolePreset | "commenter" | "none";
  capabilities: KnowledgeCapabilities;
  source: "owner" | "direct" | "inherited" | "legacy" | "none";
  sourceNodeId: string | null;
}

type TreeNodeRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  resourceType: "notebook" | "note" | "mindmap" | "file";
  resourceId: string;
  isDeleted: number;
};

type AclRow = {
  nodeId: string;
  userId: string;
  rolePreset: KnowledgeRolePreset;
  canView: number;
  canComment: number;
  canCreate: number;
  canEdit: number;
  canDelete: number;
  canMove: number;
  canDownload: number;
  canReshare: number;
  canManageMembers: number;
  grantedBy: string | null;
  createdAt: string;
  updatedAt: string;
  depth?: number;
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

export const KNOWLEDGE_ROLE_PRESETS: Record<KnowledgeRolePreset, KnowledgeCapabilities> = {
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

function cloneCapabilities(value: KnowledgeCapabilities): KnowledgeCapabilities {
  return { ...value };
}

function rowToCapabilities(row: AclRow): KnowledgeCapabilities {
  return {
    canView: row.canView !== 0,
    canComment: row.canComment !== 0,
    canCreate: row.canCreate !== 0,
    canEdit: row.canEdit !== 0,
    canDelete: row.canDelete !== 0,
    canMove: row.canMove !== 0,
    canDownload: row.canDownload !== 0,
    canReshare: row.canReshare !== 0,
    canManageMembers: row.canManageMembers !== 0,
  };
}

function permissionToAccess(permission: string | null | undefined): Pick<EffectiveKnowledgeAccess, "rolePreset" | "capabilities"> {
  if (permission === "manage" || permission === "admin" || permission === "owner") {
    return { rolePreset: "admin", capabilities: cloneCapabilities(KNOWLEDGE_ROLE_PRESETS.admin) };
  }
  if (permission === "write" || permission === "editor") {
    return { rolePreset: "editor", capabilities: cloneCapabilities(KNOWLEDGE_ROLE_PRESETS.editor) };
  }
  if (permission === "comment" || permission === "commenter") {
    return {
      rolePreset: "commenter",
      capabilities: { ...KNOWLEDGE_ROLE_PRESETS.readonly, canComment: true },
    };
  }
  if (permission === "read" || permission === "viewer") {
    return { rolePreset: "readonly", capabilities: cloneCapabilities(KNOWLEDGE_ROLE_PRESETS.readonly) };
  }
  return { rolePreset: "none", capabilities: cloneCapabilities(NONE) };
}

export function capabilitiesToLegacyPermission(capabilities: KnowledgeCapabilities): "read" | "comment" | "write" | "manage" | null {
  if (!capabilities.canView) return null;
  if (capabilities.canManageMembers) return "manage";
  if (capabilities.canEdit || capabilities.canCreate || capabilities.canMove || capabilities.canDelete) return "write";
  if (capabilities.canComment) return "comment";
  return "read";
}

export function parseKnowledgeRolePreset(value: unknown): KnowledgeRolePreset | null {
  return value === "readonly" || value === "editor" || value === "maintainer" || value === "admin"
    ? value
    : null;
}

function readNode(db: Database.Database, nodeId: string): TreeNodeRow | null {
  return (db.prepare(`
    SELECT id, userId, workspaceId, parentId, resourceType, resourceId, isDeleted
    FROM knowledge_tree_nodes WHERE id = ?
  `).get(nodeId) as TreeNodeRow | undefined) || null;
}

export function findKnowledgeNodeByResource(
  resourceType: TreeNodeRow["resourceType"],
  resourceId: string,
  db: Database.Database = getDb(),
): TreeNodeRow | null {
  ensureKnowledgeTreeTables(db);
  return (db.prepare(`
    SELECT id, userId, workspaceId, parentId, resourceType, resourceId, isDeleted
    FROM knowledge_tree_nodes
    WHERE resourceType = ? AND resourceId = ?
    ORDER BY isDeleted ASC, updatedAt DESC
    LIMIT 1
  `).get(resourceType, resourceId) as TreeNodeRow | undefined) || null;
}

function nearestExplicitAcl(db: Database.Database, nodeId: string, userId: string): AclRow | null {
  return (db.prepare(`
    WITH RECURSIVE ancestors(id, parentId, depth) AS (
      SELECT id, parentId, 0 FROM knowledge_tree_nodes WHERE id = ?
      UNION ALL
      SELECT parent.id, parent.parentId, ancestors.depth + 1
      FROM knowledge_tree_nodes parent
      JOIN ancestors ON parent.id = ancestors.parentId
    )
    SELECT acl.*, ancestors.depth
    FROM ancestors
    JOIN knowledge_tree_acl acl ON acl.nodeId = ancestors.id AND acl.userId = ?
    ORDER BY ancestors.depth ASC
    LIMIT 1
  `).get(nodeId, userId) as AclRow | undefined) || null;
}

function legacyAccess(db: Database.Database, node: TreeNodeRow, userId: string): Pick<EffectiveKnowledgeAccess, "rolePreset" | "capabilities"> {
  if (!node.workspaceId) return permissionToAccess(null);

  if (node.resourceType === "notebook") {
    const member = memberQueryService.getNotebookMemberAccess(node.resourceId, userId);
    if (member) return permissionToAccess(member.role);
  } else if (node.resourceType === "note") {
    const member = memberQueryService.getNoteNotebookMemberAccess(node.resourceId, userId);
    if (member) return permissionToAccess(member.role);
    const noteAcl = db.prepare("SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?")
      .get(node.resourceId, userId) as { permission: string } | undefined;
    if (noteAcl) return permissionToAccess(noteAcl.permission);
  }

  const workspaceRole = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(node.workspaceId, userId) as { role: string } | undefined;
  return permissionToAccess(workspaceRole?.role);
}

export function resolveKnowledgeNodeAccess(
  nodeId: string,
  userId: string,
  db: Database.Database = getDb(),
): EffectiveKnowledgeAccess {
  ensureKnowledgeTreeTables(db);
  const node = readNode(db, nodeId);
  if (!node || node.isDeleted) {
    return { nodeId, rolePreset: "none", capabilities: cloneCapabilities(NONE), source: "none", sourceNodeId: null };
  }

  if (node.userId === userId) {
    return {
      nodeId,
      rolePreset: "admin",
      capabilities: cloneCapabilities(KNOWLEDGE_ROLE_PRESETS.admin),
      source: "owner",
      sourceNodeId: node.id,
    };
  }

  const explicit = nearestExplicitAcl(db, nodeId, userId);
  if (explicit) {
    return {
      nodeId,
      rolePreset: explicit.rolePreset,
      capabilities: rowToCapabilities(explicit),
      source: (explicit.depth || 0) === 0 ? "direct" : "inherited",
      sourceNodeId: explicit.nodeId,
    };
  }

  const legacy = legacyAccess(db, node, userId);
  return {
    nodeId,
    ...legacy,
    source: legacy.rolePreset === "none" ? "none" : "legacy",
    sourceNodeId: null,
  };
}

export function resolveResourceKnowledgeAccess(
  resourceType: TreeNodeRow["resourceType"],
  resourceId: string,
  userId: string,
  db: Database.Database = getDb(),
): EffectiveKnowledgeAccess {
  const node = findKnowledgeNodeByResource(resourceType, resourceId, db);
  return node
    ? resolveKnowledgeNodeAccess(node.id, userId, db)
    : { nodeId: "", rolePreset: "none", capabilities: cloneCapabilities(NONE), source: "none", sourceNodeId: null };
}

export function hasKnowledgeCapability(
  access: EffectiveKnowledgeAccess | KnowledgeCapabilities,
  capability: KnowledgeCapabilityName,
): boolean {
  const capabilities = "capabilities" in access ? access.capabilities : access;
  return capabilities[capability] === true;
}

function writeHistory(
  db: Database.Database,
  input: {
    nodeId: string;
    action: "permission_set" | "permission_clear";
    actorUserId: string;
    targetUserId: string;
    metadata?: unknown;
  },
): void {
  db.prepare(`
    INSERT INTO knowledge_tree_history (
      id, nodeId, action, actorUserId, targetUserId, metadata
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), input.nodeId, input.action, input.actorUserId, input.targetUserId,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  );
}

export function setKnowledgeNodeRole(input: {
  nodeId: string;
  targetUserId: string;
  rolePreset: KnowledgeRolePreset;
  actorUserId: string;
  db?: Database.Database;
}): AclRow {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const preset = KNOWLEDGE_ROLE_PRESETS[input.rolePreset];
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO knowledge_tree_acl (
        nodeId, userId, rolePreset,
        canView, canComment, canCreate, canEdit, canDelete, canMove,
        canDownload, canReshare, canManageMembers, grantedBy, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(nodeId, userId) DO UPDATE SET
        rolePreset = excluded.rolePreset,
        canView = excluded.canView,
        canComment = excluded.canComment,
        canCreate = excluded.canCreate,
        canEdit = excluded.canEdit,
        canDelete = excluded.canDelete,
        canMove = excluded.canMove,
        canDownload = excluded.canDownload,
        canReshare = excluded.canReshare,
        canManageMembers = excluded.canManageMembers,
        grantedBy = excluded.grantedBy,
        updatedAt = datetime('now')
    `).run(
      input.nodeId,
      input.targetUserId,
      input.rolePreset,
      Number(preset.canView),
      Number(preset.canComment),
      Number(preset.canCreate),
      Number(preset.canEdit),
      Number(preset.canDelete),
      Number(preset.canMove),
      Number(preset.canDownload),
      Number(preset.canReshare),
      Number(preset.canManageMembers),
      input.actorUserId,
    );
    writeHistory(db, {
      nodeId: input.nodeId,
      action: "permission_set",
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      metadata: { rolePreset: input.rolePreset, capabilities: preset },
    });
  });
  transaction();
  return db.prepare("SELECT * FROM knowledge_tree_acl WHERE nodeId = ? AND userId = ?")
    .get(input.nodeId, input.targetUserId) as AclRow;
}

export function clearKnowledgeNodeRole(input: {
  nodeId: string;
  targetUserId: string;
  actorUserId: string;
  db?: Database.Database;
}): boolean {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  let removed = false;
  const transaction = db.transaction(() => {
    const result = db.prepare("DELETE FROM knowledge_tree_acl WHERE nodeId = ? AND userId = ?")
      .run(input.nodeId, input.targetUserId);
    removed = result.changes > 0;
    if (removed) {
      writeHistory(db, {
        nodeId: input.nodeId,
        action: "permission_clear",
        actorUserId: input.actorUserId,
        targetUserId: input.targetUserId,
      });
    }
  });
  transaction();
  return removed;
}

export function listKnowledgeNodeRoles(nodeId: string, db: Database.Database = getDb()) {
  ensureKnowledgeTreeTables(db);
  const direct = db.prepare(`
    SELECT acl.*, u.username, u.displayName, u.email
    FROM knowledge_tree_acl acl
    JOIN users u ON u.id = acl.userId
    WHERE acl.nodeId = ?
    ORDER BY lower(COALESCE(u.displayName, u.username)), u.id
  `).all(nodeId) as Array<AclRow & { username: string; displayName: string | null; email: string | null }>;
  const parent = db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = ?")
    .get(nodeId) as { parentId: string | null } | undefined;
  return {
    direct: direct.map((row) => ({ ...row, capabilities: rowToCapabilities(row) })),
    inheritsFromParent: parent?.parentId || null,
  };
}

export function resolveKnowledgePermissionSubject(subject: string, db: Database.Database = getDb()): { id: string; username: string; displayName: string | null; email: string | null } | null {
  const normalized = subject.trim();
  if (!normalized) return null;
  return (db.prepare(`
    SELECT id, username, displayName, email
    FROM users
    WHERE id = ? OR lower(username) = lower(?) OR lower(COALESCE(email, '')) = lower(?)
    LIMIT 1
  `).get(normalized, normalized, normalized) as {
    id: string;
    username: string;
    displayName: string | null;
    email: string | null;
  } | undefined) || null;
}
