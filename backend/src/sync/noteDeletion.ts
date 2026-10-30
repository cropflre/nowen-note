import type Database from "better-sqlite3";
import { resolveResourceKnowledgeAccessForTombstone } from "../services/knowledgeCapabilities";
import { SyncError } from "./errors";

/** The same lifecycle guard is used by HTTP and Sync; a matching version is also required by Sync. */
export function assertPermanentNoteDeletion(
  db: Database.Database,
  id: string,
  userId: string,
): void {
  const access = resolveResourceKnowledgeAccessForTombstone(
    "note",
    id,
    userId,
    db,
  );
  // Canonical tree ACLs include restricted/deny and tombstone ancestry. A truly
  // pre-tree resource only grants its canonical owner; never infer collaborator rights.
  const legacyOwner =
    !access.nodeId &&
    Boolean(
      db.prepare("SELECT 1 FROM notes WHERE id=? AND userId=?").get(id, userId),
    );
  if (
    !(access.nodeId
      ? access.capabilities.canView && access.capabilities.canManageMembers
      : legacyOwner)
  )
    throw new SyncError("SCOPE_FORBIDDEN", "仅笔记 owner 或管理员可永久删除");
  const note = db
    .prepare("SELECT isLocked,isTrashed FROM notes WHERE id=?")
    .get(id) as { isLocked: number; isTrashed: number } | undefined;
  if (note?.isLocked === 1)
    throw new SyncError("NOTE_LOCKED", "Note is locked");
  if (!note || note.isTrashed !== 1)
    throw new SyncError("NOTE_NOT_TRASHED", "请先将笔记移入回收站，再永久删除");
  if (
    db
      .prepare(
        "SELECT 1 FROM attachments WHERE noteId=? AND trashedAt IS NOT NULL LIMIT 1",
      )
      .get(id)
  )
    throw new SyncError(
      "ATTACHMENT_TRASH_RETAINED",
      "请先恢复或永久删除这篇笔记的文件回收站内容",
    );
}

type Attachment = { id: string; path: string };
export function pendingNoteDeletionAttachments(
  db: Database.Database,
): Attachment[] {
  const pending = db
    .prepare(
      "SELECT payload FROM sync_outbox WHERE entityType='note' AND operation='delete' UNION ALL SELECT localPayload AS payload FROM sync_conflicts WHERE entityType='note'",
    )
    .all() as { payload: string | null }[];
  return pending.flatMap(({ payload }) => {
    try {
      const entries = JSON.parse(payload || "{}")._deletionRecovery
        ?.attachments;
      return Array.isArray(entries)
        ? entries.filter(
            (a) => typeof a?.path === "string" && typeof a?.id === "string",
          )
        : [];
    } catch {
      return [];
    }
  });
}

/** Runs after the DB commit/ACK. Shared paths and unacknowledged recovery bytes are retained. */
export async function cleanupNoteDeletionFiles(
  db: Database.Database,
  attachments: Attachment[],
): Promise<void> {
  const { deleteAttachmentObject, getAttachmentsDir } =
    await import("../services/attachment-storage");
  const { deleteThumbnailsFor } = await import("../services/thumbnails");
  const pending = new Set(
    pendingNoteDeletionAttachments(db).map((a) => a.path),
  );
  for (const attachment of attachments) {
    if (
      pending.has(attachment.path) ||
      db
        .prepare("SELECT 1 FROM attachments WHERE path=? LIMIT 1")
        .get(attachment.path)
    )
      continue;
    await deleteAttachmentObject(attachment.path);
    deleteThumbnailsFor(getAttachmentsDir(), attachment.id);
  }
}

/** Durable cleanup jobs prevent filesystem side effects inside a mutation transaction. */
export async function finishSyncNoteDeletions(
  db: Database.Database,
): Promise<void> {
  const jobs = db
    .prepare(
      "SELECT mutationId,noteId,attachments FROM sync_note_deletion_cleanup",
    )
    .all() as { mutationId: string; noteId: string; attachments: string }[];
  for (const job of jobs) {
    try {
      await cleanupNoteDeletionFiles(db, JSON.parse(job.attachments));
      const { yDestroyDoc } = await import("../services/yjs");
      try {
        yDestroyDoc(job.noteId);
      } catch {
        /* A document may already be closed. */
      }
      db.prepare(
        "DELETE FROM sync_note_deletion_cleanup WHERE mutationId=?",
      ).run(job.mutationId);
    } catch {
      /* Keep the durable job for the next Push/retry; deletion is already committed. */
    }
  }
}
