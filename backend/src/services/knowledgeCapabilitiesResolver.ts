import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { memberQueryService } from "../queries/memberQueryService.js";
import {
  KNOWLEDGE_ROLE_PRESETS,
  type EffectiveKnowledgeAccess,
  type KnowledgeCapabilities,
  type KnowledgeRolePreset,
} from "./knowledgeCapabilitiesCore.js";

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
  depth: number;
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

function clone(value: KnowledgeCapabilities): KnowledgeCapabilities {
  return { ...value };
}

function readNode(db: Database.Database, nodeId: string): TreeNodeRow | null {
  return (db.prepare(`
    SELECT id, userId, workspaceId, parentId, resourceType, resourceId, isDeleted
    FROM knowledge_tree_nodes WHERE id = ?
  `).get(nodeId) as TreeNodeRow | undefined) || null;
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
    SELECT acl.nodeId, acl.rolePreset,
           acl.canView, acl.canComment, acl.canCreate, acl.canEdit,
           acl.canDelete, acl.canMove, acl.canDownload, acl.canReshare,
           acl.canManageMembers, ancestors.depth
    FROM ancestors
    JOIN knowledge_tree_acl acl ON acl.nodeId = ancestors.id AND acl.userId = ?
    ORDER BY ancestors.depth ASC
    LIMIT 1
  `).get(nodeId, userId) as AclRow | undefined) || null;
}

function rowCapabilities(row: AclRow): KnowledgeCapabilities {
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

function legacyPermission(permission: string | null | undefined): Pick<EffectiveKnowledgeAccess, "rolePreset" | "capabilities"> {
  if (permission === "manage" || permission === "admin" || permission === "owner") {
    return { rolePreset: "admin", capabilities: clone(KNOWLEDGE_ROLE_PRESETS.admin) };
  }
  if (permission === "write" || permission === "editor") {
    return { rolePreset: "editor", capabilities: clone(KNOWLEDGE_ROLE_PRESETS.editor) };
  }
  if (permission === "comment" || permission === "commenter") {
    return {
      rolePreset: "commenter",
      capabilities: { ...KNOWLEDGE_ROLE_PRESETS.readonly, canComment: true },
    };
  }
  if (permission === "read" || permission === "viewer") {
    return { rolePreset: "readonly", capabilities: clone(KNOWLEDGE_ROLE_PRESETS.readonly) };
  }
  return { rolePreset: "none", capabilities: clone(NONE) };
}

function workspaceOwnerId(db: Database.Database, workspaceId: string): string | null {
  return ((db.prepare("SELECT ownerId FROM workspaces WHERE id = ?").get(workspaceId) as
    | { ownerId: string }
    | undefined)?.ownerId) || null;
}

function legacyAccess(db: Database.Database, node: TreeNodeRow, userId: string) {
  if (!node.workspaceId) return legacyPermission(null);

  if (node.resourceType === "notebook") {
    const member = memberQueryService.getNotebookMemberAccess(node.resourceId, userId);
    if (member) return legacyPermission(member.role);
  } else if (node.resourceType === "note") {
    const member = memberQueryService.getNoteNotebookMemberAccess(node.resourceId, userId);
    if (member) return legacyPermission(member.role);
    const noteAcl = db.prepare("SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?")
      .get(node.resourceId, userId) as { permission: string } | undefined;
    if (noteAcl) return legacyPermission(noteAcl.permission);
  }

  const workspaceRole = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(node.workspaceId, userId) as { role: string } | undefined;
  return legacyPermission(workspaceRole?.role);
}

/**
 * A resource creator is only the owner in personal space. In a workspace, ownership belongs to
 * the workspace owner and the creator continues to inherit the team's role/capabilities. This
 * prevents an editor from gaining delete/member-management rights merely by creating a document.
 */
export function resolveKnowledgeNodeAccess(
  nodeId: string,
  userId: string,
  db: Database.Database = getDb(),
): EffectiveKnowledgeAccess {
  ensureKnowledgeTreeTables(db);
  const node = readNode(db, nodeId);
  if (!node || node.isDeleted) {
    return { nodeId, rolePreset: "none", capabilities: clone(NONE), source: "none", sourceNodeId: null };
  }

  const ownsPersonalNode = !node.workspaceId && node.userId === userId;
  const ownsWorkspace = !!node.workspaceId && workspaceOwnerId(db, node.workspaceId) === userId;
  if (ownsPersonalNode || ownsWorkspace) {
    return {
      nodeId,
      rolePreset: "admin",
      capabilities: clone(KNOWLEDGE_ROLE_PRESETS.admin),
      source: "owner",
      sourceNodeId: node.id,
    };
  }

  const explicit = nearestExplicitAcl(db, nodeId, userId);
  if (explicit) {
    return {
      nodeId,
      rolePreset: explicit.rolePreset,
      capabilities: rowCapabilities(explicit),
      source: explicit.depth === 0 ? "direct" : "inherited",
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
  ensureKnowledgeTreeTables(db);
  const node = (db.prepare(`
    SELECT id, userId, workspaceId, parentId, resourceType, resourceId, isDeleted
    FROM knowledge_tree_nodes
    WHERE resourceType = ? AND resourceId = ?
    ORDER BY isDeleted ASC, updatedAt DESC
    LIMIT 1
  `).get(resourceType, resourceId) as TreeNodeRow | undefined) || null;
  return node
    ? resolveKnowledgeNodeAccess(node.id, userId, db)
    : { nodeId: "", rolePreset: "none", capabilities: clone(NONE), source: "none", sourceNodeId: null };
}
