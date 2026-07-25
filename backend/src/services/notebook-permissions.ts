import type { Permission } from "../middleware/acl";
import { memberQueryService } from "../queries";
import { ensureNotebookTreeIntegrityGuards } from "../runtime/notebook-tree-hardening.js";
import {
  capabilitiesToLegacyPermission,
  resolveResourceKnowledgeAccess,
} from "./knowledgeCapabilities.js";

ensureNotebookTreeIntegrityGuards();

export type NotebookRole =
  | "owner"
  | "admin"
  | "editor"
  | "commenter"
  | "viewer"
  | "manage"
  | "write"
  | "comment"
  | "read"
  | "none";

const NOTEBOOK_ROLE_PERMISSIONS: Record<Exclude<NotebookRole, "none">, Permission> = {
  owner: "manage",
  admin: "manage",
  manage: "manage",
  editor: "write",
  write: "write",
  commenter: "comment",
  comment: "comment",
  viewer: "read",
  read: "read",
};

/**
 * `none` 是显式拒绝规则。为阻止工作区角色继续兜底，这里返回一个仅在 ACL 内部使用的
 * truthy 哨兵；hasPermission() 对未知值会稳定返回 false，因此不会授予任何操作。
 */
const DENY_PERMISSION = "deny" as Permission;

export function notebookRoleToPermission(role: string | null | undefined): Permission | null {
  if (role === "none") return DENY_PERMISSION;
  if (role && role in NOTEBOOK_ROLE_PERMISSIONS) {
    return NOTEBOOK_ROLE_PERMISSIONS[role as Exclude<NotebookRole, "none">];
  }
  return null;
}

function explicitKnowledgePermission(
  resourceType: "notebook" | "note",
  resourceId: string,
  userId: string,
): Permission | null | undefined {
  const access = resolveResourceKnowledgeAccess(resourceType, resourceId, userId);
  if (access.source !== "direct" && access.source !== "inherited") return undefined;
  return capabilitiesToLegacyPermission(access.capabilities) || DENY_PERMISSION;
}

export function resolveNotebookMemberPermission(
  notebookId: string,
  userId: string,
): Permission | null {
  const knowledgePermission = explicitKnowledgePermission("notebook", notebookId, userId);
  if (knowledgePermission !== undefined) return knowledgePermission;
  const row = memberQueryService.getNotebookMemberRole(notebookId, userId);
  return notebookRoleToPermission(row?.role);
}

export function resolveNoteNotebookMemberPermission(
  noteId: string,
  userId: string,
): Permission | null {
  const knowledgePermission = explicitKnowledgePermission("note", noteId, userId);
  if (knowledgePermission !== undefined) return knowledgePermission;
  const row = memberQueryService.getNoteNotebookMemberRole(noteId, userId);
  return notebookRoleToPermission(row?.role);
}

export function listSharedNotebookIds(userId: string): string[] {
  return memberQueryService.listSharedNotebookIds(userId);
}
