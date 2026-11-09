import type Database from "better-sqlite3";
import { broadcastNoteDeleted, broadcastNoteUpdated, broadcastToUser, broadcastYjsUpdate } from "./realtime";
import { yReplaceContentAsUpdate } from "./yjs";

export interface SyncPushedNoteChange {
  noteId: string;
  operation: "upsert" | "delete";
}

/**
 * Sync V2 Push 落库后，让打开中的 Web / 桌面编辑器得到与 REST 保存相同的实时更新。
 *
 * 浏览器端不消费 sync.changed（它没有 Sync V2 游标），只认 note:updated、
 * note:list-updated 和 Yjs 更新。历史上 Push 只发 sync.changed，Android 的修改
 * 因此不会出现在打开中的 Web 编辑器里。
 *
 * 与 REST PUT 相同：
 * - Markdown 正文写入活动 / 已持久化的 Y.Doc。否则之后打开的 Markdown 协同会话
 *   会加载旧的 CRDT 状态，并可能把旧正文写回、覆盖 Android 的修改；
 * - 广播只带版本与元数据，编辑器仍经 REST 拉取权威正文。
 *
 * 必须在事务提交后调用；任何失败都不影响已提交的数据（Pull 与补偿检查兜底）。
 */
export function announceSyncPushedNotes(
  db: Database.Database,
  userId: string,
  changes: SyncPushedNoteChange[],
): void {
  const seen = new Set<string>();
  for (const change of [...changes].reverse()) {
    if (seen.has(change.noteId)) continue;
    seen.add(change.noteId);
    try {
      announceOne(db, userId, change);
    } catch (error) {
      console.warn("[sync-v2] push web announce failed:", (error as Error)?.message || error);
    }
  }
}

function announceOne(db: Database.Database, userId: string, change: SyncPushedNoteChange): void {
  const note = db.prepare(`
    SELECT id, notebookId, workspaceId, title, content, contentText, contentFormat,
      isPinned, isTrashed, version, updatedAt
    FROM notes WHERE id = ?
  `).get(change.noteId) as {
    id: string; notebookId: string | null; workspaceId: string | null; title: string; content: string;
    contentText: string; contentFormat: string; isPinned: number; isTrashed: number; version: number; updatedAt: string;
  } | undefined;

  if (change.operation === "delete" || !note) {
    broadcastNoteDeleted(change.noteId, { actorUserId: userId, trashed: false });
    return;
  }

  if (note.contentFormat === "markdown" && hasYjsState(db, note.id) && !/nowen-encrypted/i.test(note.content)) {
    try {
      const result = yReplaceContentAsUpdate(note.id, note.content, userId);
      if (result) broadcastYjsUpdate(note.id, result.updateBase64);
    } catch (error) {
      console.warn("[sync-v2] push yReplaceContentAsUpdate failed:", (error as Error)?.message || error);
    }
  }

  if (note.isTrashed) {
    broadcastNoteDeleted(note.id, { actorUserId: userId, trashed: true });
  } else {
    broadcastNoteUpdated(note.id, {
      version: note.version,
      updatedAt: note.updatedAt,
      title: note.title,
      contentText: note.contentText,
      actorUserId: userId,
    });
  }
  broadcastToUser(userId, {
    type: "note:list-updated",
    note: {
      id: note.id,
      title: note.title,
      contentText: note.contentText,
      updatedAt: note.updatedAt,
      version: note.version,
      isPinned: note.isPinned,
      isTrashed: note.isTrashed,
      notebookId: note.notebookId,
      workspaceId: note.workspaceId,
    },
    actorUserId: userId,
    actorConnectionId: null,
  } as never);
}

/** Notes without Yjs history are seeded from notes.content on first load. */
function hasYjsState(db: Database.Database, noteId: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM note_ysnapshots WHERE noteId = ?
    UNION ALL SELECT 1 FROM note_yupdates WHERE noteId = ? LIMIT 1
  `).get(noteId, noteId);
}
