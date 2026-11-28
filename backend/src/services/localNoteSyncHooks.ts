import { getDb } from "../db/schema";
import { setLocalNoteHooks } from "../sync/localNoteBridge";
import { broadcastNoteUpdated } from "./realtime";
import { announceSyncPushedNotes } from "./syncPushWebAnnounce";
import { yFlush, yRebaseRoomVersion } from "./yjs";

/**
 * 桌面端同步引擎改动本机笔记后，让本机打开它的编辑器与 Yjs 房间跟上（见 sync/localNoteBridge.ts）。
 * 拉到其他设备的修改沿用服务端收到推送后的同一套处理：刷新 Markdown 的 Yjs 房间并广播给编辑器与侧栏。
 */
export function installLocalNoteSyncHooks(): void {
  setLocalNoteHooks({
    flushNote: (noteId) => yFlush(noteId),
    announceAppliedNotes: (userId, changes) => announceSyncPushedNotes(getDb(), userId, changes),
    announceVersionRebase: ({ noteId, fromVersion, toVersion }) => {
      yRebaseRoomVersion(noteId, fromVersion, toVersion);
      const note = getDb().prepare("SELECT title, contentText, updatedAt FROM notes WHERE id = ?")
        .get(noteId) as { title: string; contentText: string; updatedAt: string } | undefined;
      if (!note) return;
      broadcastNoteUpdated(noteId, {
        version: toVersion,
        rebasedFromVersion: fromVersion,
        updatedAt: note.updatedAt,
        title: note.title,
        contentText: note.contentText,
      });
    },
  });
}
