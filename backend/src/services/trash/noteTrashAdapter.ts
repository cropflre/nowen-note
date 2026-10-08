import { getDb } from "../../db/schema.js";
import { resolveTrashedNotePermission, hasPermission } from "../../middleware/acl.js";
import { deleteAttachmentFilesByNoteIds } from "../../routes/attachments.js";
import { noteLinksRepository } from "../../repositories/index.js";
import { yDestroyDoc } from "../yjs.js";
import { reclaimSpace } from "../../lib/reclaimSpace.js";
import { emitWebhook } from "../webhook.js";
import { logAudit } from "../audit.js";
import { broadcastNoteDeleted } from "../realtime.js";
import { KnowledgeTreeError } from "../knowledgeTree.js";

// Shared by the legacy note endpoint and the unified trash lifecycle.
export function permanentlyDeleteNote(id: string, userId: string, deferReclaim = false): number {
  const db = getDb();
  // 永久删除只针对回收站生命周期；tombstone 继续按删除前 Knowledge ACL 校验。
  const { permission } = resolveTrashedNotePermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    // editor 不能永久删除，只能放入回收站
    throw new KnowledgeTreeError("FORBIDDEN", 403, "仅笔记 owner 或工作区管理员可永久删除");
  }

  const note = db.prepare("SELECT isLocked FROM notes WHERE id = ?").get(id) as { isLocked: number } | undefined;
  if (note && note.isLocked === 1) {
    throw new KnowledgeTreeError("NOTE_LOCKED", 403, "Note is locked");
  }

  // ⚠ 先清理磁盘附件物理文件（必须在 DELETE FROM notes 之前，否则 CASCADE 后查不到 path）
  let removedFiles = 0;
  try {
    removedFiles = deleteAttachmentFilesByNoteIds([id]);
  } catch (e) {
    console.warn("[notes.delete] deleteAttachmentFilesByNoteIds failed:", e);
  }

  // BACKLINKS-02-RV1: 永久删除笔记前清理 note_links 引用关系
  // 作为 source 或 target 的引用记录都需要清除，避免孤儿数据残留
  try {
    noteLinksRepository.deleteByNoteId(id);
  } catch (e) {
    console.warn("[notes.delete] cleanup note_links failed:", e);
  }

  // 估算本次释放的字节数——仅用于判断是否值当做全量 VACUUM。
  // 失败时当作 0，后续只会做 checkpoint + incremental_vacuum，不会误触发 VACUUM。
  let freedBytesEstimate = 0;
  try {
    const attBytes = db
      .prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE noteId = ?")
      .get(id) as { bytes: number } | undefined;
    freedBytesEstimate += attBytes?.bytes || 0;
    const noteBytes = db
      .prepare(
        `SELECT COALESCE(LENGTH(content), 0)
              + COALESCE(LENGTH(contentText), 0)
              + COALESCE(LENGTH(title), 0) AS bytes
           FROM notes WHERE id = ?`,
      )
      .get(id) as { bytes: number } | undefined;
    freedBytesEstimate += noteBytes?.bytes || 0;
  } catch { /* ignore */ }

  db.prepare("DELETE FROM notes WHERE id = ?").run(id);

  // TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01: 永久删除笔记后清理未使用的标签
  // 删除该用户下没有任何笔记引用的标签（只删除个人空间标签，不删除工作区标签）
  try {
    db.prepare(`
      DELETE FROM tags
      WHERE userId = ?
        AND workspaceId IS NULL
        AND id NOT IN (
          SELECT DISTINCT nt.tagId
          FROM note_tags nt
          JOIN notes n ON n.id = nt.noteId
          WHERE n.userId = ? AND n.isTrashed = 0
        )
    `).run(userId, userId);
  } catch (e) {
    console.warn("[notes.delete] prune unused tags failed:", e);
  }

  // Phase 3: 释放内存 Y.Doc（CASCADE 已清 note_yupdates/note_ysnapshots）
  try { yDestroyDoc(id); } catch {}

  // 回收磁盘空间：与"清空回收站"一致的 checkpoint + incremental_vacuum 策略。
  // 没有这一步，单删笔记永远不会让 .db 主文件缩小（SQLite 默认不归还 free page），
  // 用户感知就是"删了笔记占用不降"，这是此前的缺陷。
  if (!deferReclaim) reclaimSpace(db, { freedBytesEstimate, tag: "notes.delete" });

  emitWebhook("note.deleted", userId, { noteId: id, removedFiles });
  logAudit(userId, "note", "delete", { noteId: id, removedFiles }, { targetType: "note", targetId: id });

  // Phase 2: 广播永久删除
  try {
    broadcastNoteDeleted(id, { actorUserId: userId, trashed: false });
  } catch {}
  return freedBytesEstimate;
}
