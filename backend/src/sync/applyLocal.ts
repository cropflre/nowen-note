import type Database from "better-sqlite3";
import { runWithOutboxSuppressed } from "./context";
import { runChangeFeedSuppressed } from "./suppression";
import type { SyncEntityType } from "./types";

/**
 * 把远端变更写入本地 SQLite。
 *
 * 这是同步链路上最危险的一段，两条硬性约束：
 *
 * 1. **必须抑制 Outbox**。否则形成死循环：
 *    Pull → 写本地 → 变更被捕获 → 进 Outbox → Push 回服务端 → 其他设备再 Pull…
 *    这里同时抑制两层：
 *      - runWithOutboxSuppressed：Node 侧的 repository/enqueue 路径；
 *      - runChangeFeedSuppressed：SQLite 触发器（读不到 Node 上下文）。
 *    只抑制其中一层都会漏。
 *
 * 2. **不得摧毁未同步的本地修改**。若某实体在 Outbox 里还有待推送的 mutation，
 *    远端版本不能直接盖上去——那是用户尚未上传的内容。此时交给冲突流程，
 *    由调用方决定如何处置。
 */

export interface RemoteEntityPayload {
  entityType: SyncEntityType;
  entityId: string;
  operation: "upsert" | "delete";
  payload?: Record<string, unknown>;
}

export interface ApplyLocalOptions {
  /** 本地用户 id（桌面端为本机账号）。 */
  userId: string;
}

export interface ApplyLocalResult {
  applied: number;
  skipped: number;
  /** 因本地有未同步修改而需要走冲突流程的实体。 */
  pendingConflicts: RemoteEntityPayload[];
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bit(value: unknown): number {
  return value ? 1 : 0;
}

/**
 * 该实体是否有未推送的本地修改。
 *
 * 有则说明本地和远端各改了一份，属于真实冲突，
 * 不能让远端内容静默覆盖本地未上传的编辑。
 */
function hasPendingLocalChange(
  db: Database.Database,
  entityType: SyncEntityType,
  entityId: string,
): boolean {
  const row = db.prepare(`
    SELECT 1 AS hit FROM sync_outbox
    WHERE entityType = ? AND entityId = ? AND status IN ('pending', 'inflight', 'failed')
    LIMIT 1
  `).get(entityType, entityId) as { hit: number } | undefined;
  return !!row;
}

function applyNotebookLocal(db: Database.Database, item: RemoteEntityPayload, userId: string): void {
  if (item.operation === "delete") {
    db.prepare(`
      UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ? AND userId = ?
    `).run(item.entityId, userId);
    return;
  }
  const p = item.payload || {};
  db.prepare(`
    INSERT INTO notebooks (
      id, userId, parentId, name, description, icon, color,
      sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt, workspaceId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'), NULL)
    ON CONFLICT(id) DO UPDATE SET
      parentId = excluded.parentId,
      name = excluded.name,
      description = excluded.description,
      icon = excluded.icon,
      color = excluded.color,
      sortOrder = excluded.sortOrder,
      isExpanded = excluded.isExpanded,
      isDeleted = excluded.isDeleted,
      deletedAt = excluded.deletedAt,
      updatedAt = datetime('now')
  `).run(
    item.entityId,
    userId,
    p.parentId ?? null,
    str(p.name, "未命名笔记本"),
    p.description ?? null,
    str(p.icon, "📒"),
    p.color ?? null,
    num(p.sortOrder),
    bit(p.isExpanded ?? 1),
    bit(p.isDeleted),
    p.deletedAt ?? null,
    p.createdAt ?? null,
  );
}

function applyTagLocal(db: Database.Database, item: RemoteEntityPayload, userId: string): void {
  if (item.operation === "delete") {
    db.prepare("DELETE FROM tags WHERE id = ? AND userId = ?").run(item.entityId, userId);
    return;
  }
  const p = item.payload || {};
  db.prepare(`
    INSERT INTO tags (id, userId, name, color, createdAt, workspaceId)
    VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), NULL)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color
  `).run(
    item.entityId,
    userId,
    str(p.name, "未命名标签"),
    str(p.color, "#58a6ff"),
    p.createdAt ?? null,
  );
}

function applyNoteLocal(db: Database.Database, item: RemoteEntityPayload, userId: string): void {
  if (item.operation === "delete") {
    db.prepare("DELETE FROM notes WHERE id = ? AND userId = ?").run(item.entityId, userId);
    return;
  }
  const p = item.payload || {};
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText, contentFormat,
      isPinned, isFavorite, isLocked, isArchived, isTrashed, trashedAt,
      version, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      notebookId = excluded.notebookId,
      title = excluded.title,
      content = excluded.content,
      contentText = excluded.contentText,
      contentFormat = excluded.contentFormat,
      isPinned = excluded.isPinned,
      isFavorite = excluded.isFavorite,
      isLocked = excluded.isLocked,
      isArchived = excluded.isArchived,
      isTrashed = excluded.isTrashed,
      trashedAt = excluded.trashedAt,
      version = excluded.version,
      sortOrder = excluded.sortOrder,
      updatedAt = datetime('now')
  `).run(
    item.entityId,
    userId,
    str(p.notebookId),
    str(p.title, "无标题笔记"),
    str(p.content, "{}"),
    str(p.contentText),
    str(p.contentFormat, "richtext"),
    bit(p.isPinned),
    bit(p.isFavorite),
    bit(p.isLocked),
    bit(p.isArchived),
    bit(p.isTrashed),
    p.trashedAt ?? null,
    Math.max(1, num(p.version, 1)),
    num(p.sortOrder),
    p.createdAt ?? null,
  );
}

function applyNoteTagLocal(db: Database.Database, item: RemoteEntityPayload): void {
  const separator = item.entityId.lastIndexOf(":");
  if (separator <= 0) return;
  const noteId = item.entityId.slice(0, separator);
  const tagId = item.entityId.slice(separator + 1);

  if (item.operation === "delete") {
    db.prepare("DELETE FROM note_tags WHERE noteId = ? AND tagId = ?").run(noteId, tagId);
    return;
  }
  // 父实体可能还没拉下来（分页顺序或部分失败）；此时跳过，
  // 下一轮 Pull 会重新带上这条变更。硬插会违反外键。
  const ready = db.prepare("SELECT 1 FROM notes WHERE id = ?").get(noteId)
    && db.prepare("SELECT 1 FROM tags WHERE id = ?").get(tagId);
  if (!ready) return;
  db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(noteId, tagId);
}

function applyFavoriteLocal(db: Database.Database, item: RemoteEntityPayload, userId: string): void {
  const separator = item.entityId.lastIndexOf(":");
  if (separator <= 0) return;
  const noteId = item.entityId.slice(separator + 1);

  if (item.operation === "delete") {
    db.prepare("DELETE FROM favorites WHERE userId = ? AND noteId = ?").run(userId, noteId);
    return;
  }
  if (!db.prepare("SELECT 1 FROM notes WHERE id = ?").get(noteId)) return;
  db.prepare(`
    INSERT OR IGNORE INTO favorites (userId, noteId, workspaceId, createdAt)
    VALUES (?, ?, NULL, datetime('now'))
  `).run(userId, noteId);
}

/**
 * 附件元数据。
 *
 * 二进制单独下载，因此这里只维护记录。path 使用占位值并标记为待下载——
 * 远端不会（也不应该）把服务器文件路径告诉客户端。
 */
function applyAttachmentLocal(db: Database.Database, item: RemoteEntityPayload, userId: string): void {
  if (item.operation === "delete") {
    db.prepare("DELETE FROM attachments WHERE id = ? AND userId = ?").run(item.entityId, userId);
    return;
  }
  const p = item.payload || {};
  const noteId = str(p.noteId);
  if (!noteId || !db.prepare("SELECT 1 FROM notes WHERE id = ?").get(noteId)) return;

  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id) DO UPDATE SET filename = excluded.filename
  `).run(
    item.entityId,
    noteId,
    userId,
    str(p.filename, "attachment"),
    str(p.mimeType, "application/octet-stream"),
    num(p.size),
    // 二进制尚未下载，用可识别的占位；下载完成后由附件服务改写。
    `pending-sync:${item.entityId}`,
    p.createdAt ?? null,
  );
}

// ---------------------------------------------------------------------------
// 阶段 J：其余个人实体的本地应用（下行）
// ---------------------------------------------------------------------------
//
// 这一组与 apply.ts 里的服务端版本成对存在，缺任何一半都算"只做了单向"。
// 本地版本不做版本冲突检测 —— 冲突判定发生在 Push 时（服务端返回
// VERSION_CONFLICT），Pull 阶段的职责是把已确定的远端状态落库。
// 但引擎在 applyRemoteChanges 之前会检查该实体是否还有未推送的本地修改，
// 有则转入冲突而不覆盖（RULE 3）。

function applyTaskLocal(db: Database.Database, item: RemoteEntityPayload, userId: string): void {
  if (item.operation === "delete") {
    db.prepare("DELETE FROM tasks WHERE id = ? AND userId = ?").run(item.entityId, userId);
    return;
  }
  const p = item.payload || {};
  // noteId / parentId 若指向本地尚不存在的实体则置 null：
  // 外键会拒绝写入，导致整条任务永远同步不下来。
  const noteId = typeof p.noteId === "string"
    && db.prepare("SELECT 1 FROM notes WHERE id = ?").get(p.noteId) ? p.noteId : null;
  const parentId = typeof p.parentId === "string"
    && db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(p.parentId) ? p.parentId : null;

  db.prepare(`
    INSERT INTO tasks (
      id, userId, title, isCompleted, completedAt, priority, dueDate,
      noteId, parentId, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      isCompleted = excluded.isCompleted,
      completedAt = excluded.completedAt,
      priority = excluded.priority,
      dueDate = excluded.dueDate,
      noteId = excluded.noteId,
      parentId = excluded.parentId,
      sortOrder = excluded.sortOrder,
      updatedAt = excluded.updatedAt
  `).run(
    item.entityId,
    userId,
    str(p.title, ""),
    p.isCompleted ? 1 : 0,
    p.completedAt ?? null,
    num(p.priority) || 2,
    p.dueDate ?? null,
    noteId,
    parentId,
    num(p.sortOrder),
    p.createdAt ?? null,
    // 保留远端 updatedAt 而不是写 now()：
    // 它是下一次 Push 的 baseUpdatedAt 依据，改写会导致误判冲突。
    p.updatedAt ?? null,
  );
}

function applyTaskReminderLocal(
  db: Database.Database,
  item: RemoteEntityPayload,
  userId: string,
): void {
  if (item.operation === "delete") {
    db.prepare("DELETE FROM task_reminders WHERE id = ? AND userId = ?")
      .run(item.entityId, userId);
    return;
  }
  const p = item.payload || {};
  const taskId = typeof p.taskId === "string" ? p.taskId : "";
  // 任务还没同步下来：跳过而不是报错。下一轮 Pull 会重新带上这条提醒
  // （Change Feed 是幂等的），届时任务已存在。
  if (!taskId || !db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) return;

  db.prepare(`
    INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled, createdAt)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id) DO UPDATE SET
      offsetMinutes = excluded.offsetMinutes,
      enabled = excluded.enabled
  `).run(
    item.entityId,
    taskId,
    userId,
    num(p.offsetMinutes) || 30,
    p.enabled === false ? 0 : 1,
    p.createdAt ?? null,
  );
  // lastNotifiedAt 刻意不同步：它是"本机是否已弹过通知"的状态，
  // 从别的设备同步过来会让本机漏掉提醒。
}

function applyDiaryLocal(db: Database.Database, item: RemoteEntityPayload, userId: string): void {
  if (item.operation === "delete") {
    db.prepare("DELETE FROM diaries WHERE id = ? AND userId = ?").run(item.entityId, userId);
    return;
  }
  const p = item.payload || {};
  const asJsonArray = (value: unknown): string => {
    if (typeof value === "string") {
      try {
        return Array.isArray(JSON.parse(value)) ? value : "[]";
      } catch {
        return "[]";
      }
    }
    return Array.isArray(value) ? JSON.stringify(value) : "[]";
  };

  db.prepare(`
    INSERT INTO diaries (id, userId, contentText, mood, images, media, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id) DO UPDATE SET
      contentText = excluded.contentText,
      mood = excluded.mood,
      images = excluded.images,
      media = excluded.media
  `).run(
    item.entityId,
    userId,
    str(p.contentText, ""),
    str(p.mood, ""),
    asJsonArray(p.images),
    asJsonArray(p.media),
    p.createdAt ?? null,
  );
}

function applyMindmapLocal(db: Database.Database, item: RemoteEntityPayload, userId: string): void {
  if (item.operation === "delete") {
    db.prepare("DELETE FROM mindmaps WHERE id = ? AND userId = ?").run(item.entityId, userId);
    return;
  }
  const p = item.payload || {};
  db.prepare(`
    INSERT INTO mindmaps (id, userId, workspaceId, title, data, createdAt, updatedAt)
    VALUES (?, ?, NULL, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      data = excluded.data,
      updatedAt = excluded.updatedAt
  `).run(
    item.entityId,
    userId,
    str(p.title, "无标题导图"),
    typeof p.data === "string" ? p.data : JSON.stringify(p.data ?? {}),
    p.createdAt ?? null,
    // 同 task：保留远端 updatedAt 作为下次 Push 的 base。
    p.updatedAt ?? null,
  );
}

const LOCAL_APPLIERS: Record<
  SyncEntityType,
  (db: Database.Database, item: RemoteEntityPayload, userId: string) => void
> = {
  notebook: applyNotebookLocal,
  note: applyNoteLocal,
  tag: applyTagLocal,
  note_tag: (db, item) => applyNoteTagLocal(db, item),
  favorite: applyFavoriteLocal,
  attachment: applyAttachmentLocal,
  task: applyTaskLocal,
  task_reminder: applyTaskReminderLocal,
  diary: applyDiaryLocal,
  mindmap: applyMindmapLocal,
};

/**
 * 应用一批远端变更。
 *
 * 整批包在一个事务 + 双层抑制里：
 * 事务保证崩溃时不留半写状态，抑制保证不产生回环。
 */
export function applyRemoteChanges(
  db: Database.Database,
  items: RemoteEntityPayload[],
  options: ApplyLocalOptions,
): ApplyLocalResult {
  const result: ApplyLocalResult = { applied: 0, skipped: 0, pendingConflicts: [] };

  const run = db.transaction(() => {
    for (const item of items) {
      // 本地有未推送的修改 → 不覆盖，交冲突流程。
      if (hasPendingLocalChange(db, item.entityType, item.entityId)) {
        result.pendingConflicts.push(item);
        result.skipped += 1;
        continue;
      }
      const applier = LOCAL_APPLIERS[item.entityType];
      if (!applier) {
        result.skipped += 1;
        continue;
      }
      applier(db, item, options.userId);
      result.applied += 1;
    }
  });

  // 双层抑制：Node 侧 enqueue 与 SQLite 触发器都要跳过。
  runWithOutboxSuppressed(() => {
    runChangeFeedSuppressed(db, () => {
      run();
    });
  });

  return result;
}
