import { getDb } from "../db/schema";
import { setAttachmentExternalAccessEnabled } from "./attachment-link-policy";

/** Caller rechecks management permission and deletion risk in this transaction. */
export function retainAttachmentInTrash(id: string, userId: string): void {
  getDb().prepare(`UPDATE attachments SET trashedAt=datetime('now'),trashedBy=?,originalFolderId=folderId,folderId=NULL
    WHERE id=? AND trashedAt IS NULL`).run(userId, id);
  // Old public links remain revoked after restoration; sharing requires a new explicit action.
  setAttachmentExternalAccessEnabled(id, false);
}
