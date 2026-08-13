import type { DatabaseAdapter } from "../db/adapters/types";
import { createKnowledgeTreeNodeAccessRepository } from "../repositories/knowledgeTreeNodeAccessRepository";
import { createNoteCoreRuntime } from "./note-core-runtime";

type Permission = "read" | "comment" | "write" | "manage";

const PERMISSION_LEVEL: Record<Permission, number> = {
  read: 1,
  comment: 2,
  write: 3,
  manage: 4,
};

export type AttachmentNoteCapabilities = {
  read: boolean;
  write: boolean;
  manage: boolean;
  download: boolean;
  workspaceId: string | null;
  notebookId: string | null;
};

function hasPermission(permission: Permission | null, required: Permission): boolean {
  return Boolean(permission && PERMISSION_LEVEL[permission] >= PERMISSION_LEVEL[required]);
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return value === 1 || value === "1" || value === "t" || value === "true";
}

export function createAttachmentCapabilitiesRuntime(adapter: DatabaseAdapter) {
  const noteRuntime = createNoteCoreRuntime(adapter, "postgres");
  const treeAccess = createKnowledgeTreeNodeAccessRepository(adapter, "postgres");

  return {
    async resolve(noteId: string, userId: string): Promise<AttachmentNoteCapabilities> {
      if (!noteId || !userId) {
        return {
          read: false,
          write: false,
          manage: false,
          download: false,
          workspaceId: null,
          notebookId: null,
        };
      }

      const scope = await adapter.queryOne<{
        notebookId: string;
        workspaceId: string | null;
      }>(
        `SELECT "notebookId" AS "notebookId", "workspaceId" AS "workspaceId"
           FROM notes
          WHERE id = ? AND "isTrashed" = false`,
        [noteId],
      );
      if (!scope) {
        return {
          read: false,
          write: false,
          manage: false,
          download: false,
          workspaceId: null,
          notebookId: null,
        };
      }

      // The unified knowledge-tree ACL is authoritative whenever a live node exists.
      // It preserves direct/inherited deny rules and canDownload independently from edit rights.
      const node = await adapter.queryOne<{ id: string }>(
        `SELECT id
           FROM knowledge_tree_nodes
          WHERE "resourceType" = 'note'
            AND "resourceId" = ?
            AND "isDeleted" = false
          ORDER BY id ASC
          LIMIT 1`,
        [noteId],
      );
      if (node) {
        const resolved = await treeAccess.resolveOne({ nodeId: node.id, userId });
        if (resolved) {
          return {
            read: resolved.access.capabilities.canView,
            write: resolved.access.capabilities.canEdit,
            manage: resolved.access.capabilities.canManageMembers,
            download: resolved.access.capabilities.canView
              && resolved.access.capabilities.canDownload,
            workspaceId: scope.workspaceId,
            notebookId: scope.notebookId,
          };
        }
      }

      // Historical databases can temporarily contain notes that have not yet received a
      // knowledge-tree node. Reuse the already-tested PG note permission fallback so those
      // notes remain readable during migration without opening the SQLite ACL path.
      const legacy = await noteRuntime.resolveNotePermissionAsync(noteId, userId);
      const permission = legacy.permission as Permission | null;
      const read = hasPermission(permission, "read");
      const write = hasPermission(permission, "write");
      const manage = hasPermission(permission, "manage");
      let download = read;

      // Preserve the legacy per-notebook download restriction for direct notebook members.
      // Modern inherited permissions are handled by the unified tree path above.
      if (read && !manage) {
        const membership = await adapter.queryOne<{ allowDownload: unknown }>(
          `SELECT "allowDownload" AS "allowDownload"
             FROM notebook_members
            WHERE "notebookId" = ?
              AND "userId" = ?
              AND status = 'active'
            LIMIT 1`,
          [scope.notebookId, userId],
        );
        if (membership) download = toBoolean(membership.allowDownload, true);
      }

      return {
        read,
        write,
        manage,
        download,
        workspaceId: scope.workspaceId,
        notebookId: scope.notebookId,
      };
    },
  };
}
