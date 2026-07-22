import { hasPermission, resolveNotePermission, type Permission } from "../middleware/acl";
import { memberQueryService } from "../queries/memberQueryService";

export interface EffectiveNoteCapabilities {
  permission: Permission | null;
  read: boolean;
  comment: boolean;
  write: boolean;
  manage: boolean;
  download: boolean;
  reshare: boolean;
}

export function resolveEffectiveNoteCapabilities(noteId: string, userId: string): EffectiveNoteCapabilities {
  const { permission } = resolveNotePermission(noteId, userId);
  const access = userId ? memberQueryService.getNoteNotebookMemberAccess(noteId, userId) : undefined;
  const read = hasPermission(permission, "read");
  const comment = hasPermission(permission, "comment");
  const write = hasPermission(permission, "write");
  const manage = hasPermission(permission, "manage");

  return {
    permission,
    read,
    comment,
    write,
    manage,
    download: read && (manage || access?.allowDownload !== 0),
    reshare: manage || Boolean(access?.allowReshare),
  };
}
