import { TASK_SYNC_FIELDS, taskSyncValues } from "./taskFields.js";
import { removeTaskOccurrences } from "../lib/taskRecurrenceDeletion.js";
import { withEncryptedBlockWrite } from "../lib/encryptedBlockWrites.js";
import type Database from "better-sqlite3";
import { runWithOutboxSuppressed } from "./context";
import { runChangeFeedSuppressed } from "./suppression";
import type { SyncEntityType } from "./types";
import { isSyncEntityType, isSyncOperation } from "./types";
import { SyncError, type SyncFailureDiagnostic } from "./errors";
import { logSyncWarn } from "./log";
import { classifyApplyFailure, redactEntityId, structureFailureMessage } from "./diagnostics";
import { applyNotebookUpserts, withNotebookLive } from "./notebookApply";
import { normalizeNoteThemeId } from "../lib/noteThemeId";
import { registerRemoteAttachment } from './attachments';
import { getActiveProfile } from './profile';
import { EncryptedNotePayloadError, guardEncryptedNoteMutation, guardEncryptedBlockWriter } from "../lib/encryptedNotes.js";

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
  scopeKey?: string;
  workspaceId?: string | null;
}

export interface ApplyLocalResult {
  applied: number;
  skipped: number;
  /** 因本地有未同步修改而需要走冲突流程的实体。 */
  pendingConflicts: RemoteEntityPayload[];
  /** 远端目录结构本身有异常（悬空/跨作用域父目录、自引用、成环）而被回退处理的目录数。 */
  structureRepairs: number;
}

/** Validate before conflict storage or cursor advancement, including brand-new devices. */
export function validateEncryptedRemoteNotes(db: Database.Database, items: ReadonlyArray<RemoteEntityPayload>, options: ApplyLocalOptions): void {
  for (const item of items) {
    if (item.entityType !== "note" || item.operation !== "upsert") continue;
    const workspaceId = options.workspaceId ?? null;
    const current = db.prepare(`SELECT content, contentFormat FROM notes WHERE id = ? AND workspaceId IS ?
      AND (? IS NOT NULL OR userId = ?)`).get(item.entityId, workspaceId, workspaceId, options.userId) as
      { content: string; contentFormat: string } | undefined;
    try {
      const effective = { ...item.payload, content: str(item.payload?.content, "{}"), contentFormat: str(item.payload?.contentFormat, "richtext") };
      guardEncryptedNoteMutation(effective, current); guardEncryptedBlockWriter(effective, current);
    }
    catch (error) {
      if (!(error instanceof EncryptedNotePayloadError)) throw error;
      throw new SyncError("INVALID_PAYLOAD", "加密笔记同步载荷无效，原密文已保留");
    }
  }
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
 * 返回最早的待推送操作，用其基线区分服务端回传与真正的远端修改。
 */
function getPendingLocalChange(
  db: Database.Database,
  entityType: SyncEntityType,
  entityId: string,
  scopeKey: string,
): { baseVersion: number | null } | undefined {
  const row = db.prepare(`
    SELECT baseVersion FROM sync_outbox
    WHERE entityType = ? AND entityId = ? AND scopeKey = ?
      AND status IN ('pending', 'inflight', 'failed')
    ORDER BY createdAt ASC, rowid ASC LIMIT 1
  `).get(entityType, entityId, scopeKey) as { baseVersion: number | null } | undefined;
  return row;
}

/**
 * 目录的 upsert 要看整批的父子关系才能正确落库，统一走 applyNotebookUpserts
 *（见 notebookApply.ts）；applyRemoteChanges 会把整批 upsert 先一起交给它。
 * 这里保留的单条入口只处理删除，以及作为字典完整性的兜底。
 */
function applyNotebookLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { userId, workspaceId = null } = options;
  if (item.operation === "delete") {
    db.prepare(`
      UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
    `).run(item.entityId,workspaceId,workspaceId,userId);
    return;
  }
  applyNotebookUpserts(db, [item], options, {});
}

/**
 * 标签名称在空间内唯一（个人空间 userId + 规范化名称，工作区 workspaceId + 规范化名称），
 * 同名就是同一个标签——v59 迁移合并历史重复标签用的也是这条规则。
 *
 * 但同步按 ID 对账。首次下载时本机库里常有安装时播种的默认标签（重要/技术/灵感），
 * 与服务器上的同名标签 ID 不同，直接写入会撞唯一索引，整个下载就此停在标签这一步。
 * 这里采用服务器上的标签身份，把本机标签的笔记关联并入它，不丢任何关联。
 *
 * 本机标签自己还有未上传的改动（标签本身或它的笔记关联）时不自动合并：
 * 待上传的修改引用的是本机标签的 ID，合并会让它们悬空，保持明确失败交给人处理。
 */
function localTagWithSameName(
  db: Database.Database,
  remoteId: string,
  name: string,
  userId: string,
  workspaceId: string | null,
): string | null {
  const row = db.prepare(`
    SELECT id FROM tags
    WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?) AND lower(trim(name)) = lower(trim(?)) AND id <> ?
  `).get(workspaceId, workspaceId, userId, name, remoteId) as { id: string } | undefined;
  if (!row) return null;
  const pending = db.prepare(`
    SELECT 1 FROM sync_outbox
    WHERE status IN ('pending', 'inflight', 'failed')
      AND ((entityType = 'tag' AND entityId = ?) OR (entityType = 'note_tag' AND entityId LIKE ?))
    LIMIT 1
  `).get(row.id, `%:${row.id}`);
  if (pending) {
    throw new SyncError("DATA_STRUCTURE", structureFailureMessage("TAG_NAME_COLLISION"), {
      step: "tag", entityType: "tag", entityId: redactEntityId(remoteId), reason: "TAG_NAME_COLLISION",
    });
  }
  return row.id;
}

function applyTagLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { userId, workspaceId = null } = options;
  if (item.operation === "delete") {
    db.prepare("DELETE FROM tags WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)")
      .run(item.entityId,workspaceId,workspaceId,userId);
    return;
  }
  const p = item.payload || {};
  const name = str(p.name, "未命名标签");
  const merged = localTagWithSameName(db, item.entityId, name, userId, workspaceId);
  // 先把本机标签的名称让出来，服务器上的标签才能以原名写入。
  if (merged) db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(`__merging__:${merged}`, merged);
  db.prepare(`
    INSERT INTO tags (id, userId, name, color, createdAt, workspaceId)
    VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color
  `).run(
    item.entityId,
    userId,
    name,
    str(p.color, "#58a6ff"),
    p.createdAt ?? null,
    workspaceId,
  );
  if (merged) {
    db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) SELECT noteId, ? FROM note_tags WHERE tagId = ?")
      .run(item.entityId, merged);
    db.prepare("DELETE FROM tags WHERE id = ?").run(merged); // 旧关联随外键级联清掉，新关联已经在上一步建好
    logSyncWarn("apply.tag-merged", { entityType: "tag", entityId: redactEntityId(item.entityId), state: "same-name" });
  }
}

function applyNoteLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { userId, workspaceId = null } = options;
  if (item.operation === "delete") {
    db.prepare("DELETE FROM notes WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)")
      .run(item.entityId,workspaceId,workspaceId,userId);
    return;
  }
  const p = item.payload || {};
  const hasThemeId = Object.prototype.hasOwnProperty.call(p, "themeId");
  const write = () => withEncryptedBlockWrite(db, item.entityId, str(p.content, "{}"), str(p.contentFormat, "richtext"), () => db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText, contentFormat,
      isPinned, isFavorite, isLocked, isArchived, isTrashed, trashedAt,
      themeId, version, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
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
      themeId = CASE WHEN ? THEN excluded.themeId ELSE notes.themeId END,
      version = excluded.version,
      sortOrder = excluded.sortOrder,
      updatedAt = datetime('now')
  `).run(
    item.entityId,
    userId,
    str(p.notebookId),
    workspaceId,
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
    normalizeNoteThemeId(p.themeId),
    Math.max(1, num(p.version, 1)),
    num(p.sortOrder),
    p.createdAt ?? null,
    hasThemeId ? 1 : 0,
  ), p.encryptedBlocksVersion);
  // 新笔记或换了目录的笔记，若目标目录已删除（已删子树里的笔记），要让目录临时可用，
  // 笔记的知识树父节点才会与服务端一致；目录没变的更新不会重算树父节点，直接写。
  const placed = db.prepare("SELECT notebookId FROM notes WHERE id = ? AND workspaceId IS ?")
    .get(item.entityId, workspaceId) as { notebookId: string } | undefined;
  if (!placed || placed.notebookId !== str(p.notebookId)) withNotebookLive(db, { userId, workspaceId }, str(p.notebookId), write);
  else write();
}

function applyNoteTagLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { workspaceId = null } = options;
  const separator = item.entityId.lastIndexOf(":");
  if (separator <= 0) return;
  const noteId = item.entityId.slice(0, separator);
  const tagId = item.entityId.slice(separator + 1);

  if (item.operation === "delete") {
    db.prepare(`DELETE FROM note_tags WHERE noteId = ? AND tagId = ? AND noteId IN (
      SELECT id FROM notes WHERE workspaceId IS ?
    )`).run(noteId,tagId,workspaceId);
    return;
  }
  // 父实体可能还没拉下来（分页顺序或部分失败）；此时跳过，
  // 下一轮 Pull 会重新带上这条变更。硬插会违反外键。
  const ready = db.prepare("SELECT 1 FROM notes WHERE id = ? AND workspaceId IS ?").get(noteId,workspaceId)
    && db.prepare("SELECT 1 FROM tags WHERE id = ? AND workspaceId IS ?").get(tagId,workspaceId);
  if (!ready) return;
  db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(noteId, tagId);
}

function applyFavoriteLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { userId, workspaceId = null } = options;
  const separator = item.entityId.lastIndexOf(":");
  if (separator <= 0) return;
  const noteId = item.entityId.slice(separator + 1);

  if (item.operation === "delete") {
    db.prepare("DELETE FROM favorites WHERE userId = ? AND noteId = ?").run(userId, noteId);
    return;
  }
  if (!db.prepare("SELECT 1 FROM notes WHERE id = ? AND workspaceId IS ?").get(noteId,workspaceId)) return;
  db.prepare(`
    INSERT OR IGNORE INTO favorites (userId, noteId, workspaceId, createdAt)
    VALUES (?, ?, ?, datetime('now'))
  `).run(userId,noteId,workspaceId);
}

/**
 * 附件元数据。
 *
 * 二进制单独下载，因此这里只维护记录。path 使用占位值并标记为待下载——
 * 远端不会（也不应该）把服务器文件路径告诉客户端。
 */
function applyAttachmentLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { userId, workspaceId = null } = options;
  if (item.operation === "delete") {
    db.prepare("DELETE FROM attachments WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)")
      .run(item.entityId,workspaceId,workspaceId,userId);
    return;
  }
  const p = item.payload || {};
  const noteId = str(p.noteId);
  if (!noteId || !db.prepare("SELECT 1 FROM notes WHERE id = ? AND workspaceId IS ?").get(noteId,workspaceId)) return;
  const previous = db.prepare('SELECT path,hash,size FROM attachments WHERE id=? AND workspaceId IS ?').get(item.entityId,workspaceId) as {path:string;hash:string|null;size:number} | undefined;

  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt, workspaceId, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      noteId=excluded.noteId,filename=excluded.filename,mimeType=excluded.mimeType,
      size=excluded.size,workspaceId=excluded.workspaceId,hash=COALESCE(excluded.hash,attachments.hash)
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
    workspaceId,
    typeof p.hash === "string" ? p.hash : null,
  );
  // Metadata can arrive before bytes, including during the initial automatic
  // download. Preserve a completed local file when replaying unchanged metadata.
  if (!previous || !previous.path || previous.path.startsWith('pending-sync:')
    || previous.size !== num(p.size) || (typeof p.hash === 'string' && p.hash !== previous.hash)) {
    registerRemoteAttachment(db,item.entityId,getActiveProfile(db)?.id ?? null);
  }
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

function applyTaskLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { userId, workspaceId = null } = options;
  if (item.operation === "delete") {
    const task = db.prepare("SELECT * FROM tasks WHERE id=? AND workspaceId IS ?").get(item.entityId,workspaceId) as any;
    if (task) removeTaskOccurrences(db,task,"single",false);
    else db.prepare("INSERT OR IGNORE INTO task_deletion_tombstones(id,userId,workspaceId,deletedAt) VALUES(?,?,?,?)").run(item.entityId,userId,workspaceId,new Date().toISOString());
    db.prepare("DELETE FROM tasks WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)")
      .run(item.entityId,workspaceId,workspaceId,userId);
    return;
  }
  const p = item.payload || {};
  if (db.prepare("SELECT 1 FROM task_deletion_tombstones WHERE id=?").get(item.entityId)) return;
  const groupId = typeof p.repeatGroupId === "string" ? p.repeatGroupId : item.entityId;
  const scopeKey = workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
  if (p.recurrenceAction === "stop") db.prepare(`INSERT INTO task_recurrence_state(groupId,scopeKey,action,updatedAt) VALUES(?,?,'stop',?)
    ON CONFLICT(groupId,scopeKey) DO UPDATE SET action=CASE WHEN action='series' THEN action ELSE excluded.action END,updatedAt=excluded.updatedAt`).run(groupId,scopeKey,new Date().toISOString());
  const lifecycle = db.prepare("SELECT action FROM task_recurrence_state WHERE groupId=? AND scopeKey=?").get(groupId,scopeKey) as {action:string} | undefined;
  if (lifecycle?.action === "series") return;
  if (lifecycle?.action === "stop") p.repeatRule = "none";
  // noteId / parentId 若指向本地尚不存在的实体则置 null：
  // 外键会拒绝写入，导致整条任务永远同步不下来。
  const noteId = typeof p.noteId === "string"
    && db.prepare("SELECT 1 FROM notes WHERE id = ? AND workspaceId IS ?").get(p.noteId,workspaceId) ? p.noteId : null;
  const parentId = typeof p.parentId === "string"
    && db.prepare("SELECT 1 FROM tasks WHERE id = ? AND workspaceId IS ?").get(p.parentId,workspaceId) ? p.parentId : null;

  const current = db.prepare("SELECT * FROM tasks WHERE id=? AND workspaceId IS ?").get(item.entityId, workspaceId) as Record<string, unknown> | undefined;
  const archivedAt = Object.prototype.hasOwnProperty.call(p,"archivedAt") ? (typeof p.archivedAt === "string" ? p.archivedAt : null) : (current?.archivedAt ?? null);
  db.prepare(`
    INSERT INTO tasks (
      id, userId, title, isCompleted, completedAt, archivedAt, priority, dueDate,
      noteId, parentId, sortOrder, createdAt, updatedAt, workspaceId, ${TASK_SYNC_FIELDS.join(",")}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?, ${TASK_SYNC_FIELDS.map(() => "?").join(",")})
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      isCompleted = excluded.isCompleted,
      completedAt = excluded.completedAt,
      archivedAt = excluded.archivedAt,
      priority = excluded.priority,
      dueDate = excluded.dueDate,
      noteId = excluded.noteId,
      parentId = excluded.parentId,
      sortOrder = excluded.sortOrder,
      updatedAt = excluded.updatedAt,
      ${TASK_SYNC_FIELDS.map(field => `${field}=excluded.${field}`).join(",")}
  `).run(
    item.entityId,
    userId,
    str(p.title, ""),
    p.isCompleted ? 1 : 0,
    p.completedAt ?? null,
    archivedAt,
    num(p.priority) || 2,
    p.dueDate ?? null,
    noteId,
    parentId,
    num(p.sortOrder),
    p.createdAt ?? null,
    // 保留远端 updatedAt 而不是写 now()：
    // 它是下一次 Push 的 baseUpdatedAt 依据，改写会导致误判冲突。
    p.updatedAt ?? null,
    workspaceId,
    ...taskSyncValues(p, current),
  );
}

function applyTaskReminderLocal(
  db: Database.Database,
  item: RemoteEntityPayload,
  options: ApplyLocalOptions,
): void {
  const { userId, workspaceId = null } = options;
  if (item.operation === "delete") {
    db.prepare(`DELETE FROM task_reminders WHERE id = ? AND taskId IN (
      SELECT id FROM tasks WHERE workspaceId IS ?
    )`).run(item.entityId,workspaceId);
    return;
  }
  const p = item.payload || {};
  const taskId = typeof p.taskId === "string" ? p.taskId : "";
  // 任务还没同步下来：跳过而不是报错。下一轮 Pull 会重新带上这条提醒
  // （Change Feed 是幂等的），届时任务已存在。
  if (!taskId || !db.prepare("SELECT 1 FROM tasks WHERE id = ? AND workspaceId IS ?").get(taskId,workspaceId)) return;

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

function applyDiaryLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { userId, workspaceId = null } = options;
  if (item.operation === "delete") {
    db.prepare("DELETE FROM diaries WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)")
      .run(item.entityId,workspaceId,workspaceId,userId);
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
    INSERT INTO diaries (id, userId, contentText, mood, images, media, createdAt, workspaceId)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
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
    workspaceId,
  );
}

function applyMindmapLocal(db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions): void {
  const { userId, workspaceId = null } = options;
  if (item.operation === "delete") {
    db.prepare("DELETE FROM mindmaps WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)")
      .run(item.entityId,workspaceId,workspaceId,userId);
    return;
  }
  const p = item.payload || {};
  db.prepare(`
    INSERT INTO mindmaps (id, userId, workspaceId, title, data, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      data = excluded.data,
      updatedAt = excluded.updatedAt
  `).run(
    item.entityId,
    userId,
    workspaceId,
    str(p.title, "无标题导图"),
    typeof p.data === "string" ? p.data : JSON.stringify(p.data ?? {}),
    p.createdAt ?? null,
    // 同 task：保留远端 updatedAt 作为下次 Push 的 base。
    p.updatedAt ?? null,
  );
}

const LOCAL_APPLIERS: Record<
  SyncEntityType,
  (db: Database.Database, item: RemoteEntityPayload, options: ApplyLocalOptions) => void
> = {
  notebook: applyNotebookLocal,
  note: applyNoteLocal,
  tag: applyTagLocal,
  note_tag: applyNoteTagLocal,
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
  validateEncryptedRemoteNotes(db, items, options);
  for (const item of items) {
    if (!isSyncEntityType(item.entityType) || !isSyncOperation(item.operation)) {
      throw new SyncError("SERVER_ERROR", "收到当前客户端不支持的同步实体或操作");
    }
  }
  const result: ApplyLocalResult = { applied: 0, skipped: 0, pendingConflicts: [], structureRepairs: 0 };
  const scopeKey = options.scopeKey || (options.workspaceId ? `workspace:${options.workspaceId}` : "personal");
  const applyOptions = { ...options, scopeKey, workspaceId: options.workspaceId ?? null };
  // 失败现场：随处理进度更新，出错时据此生成诊断（只含阶段、脱敏 ID，不含任何内容）。
  const failure: SyncFailureDiagnostic = { step: "apply" };

  /** 本地有未推送的修改 → 不覆盖，交冲突流程。返回 true 表示可以应用。 */
  const mayApply = (item: RemoteEntityPayload): boolean => {
    const pending = getPendingLocalChange(db,item.entityType,item.entityId,scopeKey);
    if (!pending) return true;
    // The remote note still equals the base of the unsent edits (including
    // our own Push echo). Preserve local content without inventing a conflict.
    if (!(item.entityType === "note" && item.operation === "upsert"
      && pending.baseVersion !== null && item.payload?.version === pending.baseVersion)) {
      result.pendingConflicts.push(item);
    }
    result.skipped += 1;
    return false;
  };
  const isNotebookUpsert = (item: RemoteEntityPayload) =>
    item.entityType === "notebook" && item.operation === "upsert";

  const run = db.transaction(() => {
    // 目录先于其他实体，且整批一起处理：子目录经常先于父目录到达，
    // 笔记的 notebookId 外键也要求目录已经落库。
    const notebookUpserts = items.filter((item) => isNotebookUpsert(item) && mayApply(item));
    if (notebookUpserts.length > 0) {
      const report = applyNotebookUpserts(db, notebookUpserts, applyOptions, failure);
      result.applied += report.applied;
      result.structureRepairs += report.repairs.length;
    }

    for (const item of items) {
      if (isNotebookUpsert(item) || !mayApply(item)) continue;
      failure.step = item.entityType;
      failure.entityType = item.entityType;
      failure.entityId = redactEntityId(item.entityId);
      const applier = LOCAL_APPLIERS[item.entityType];
      if (!applier) {
        throw new SyncError("SERVER_ERROR", "收到当前客户端不支持的同步实体");
      }
      applier(db,item,applyOptions);
      result.applied += 1;
    }
  });

  try {
    // 双层抑制：Node 侧 enqueue 与 SQLite 触发器都要跳过。
    runWithOutboxSuppressed(() => {
      runChangeFeedSuppressed(db, () => {
        run();
      });
    });
  } catch (error) {
    // 整批已随事务回滚。约束类失败不可重试，其余保持可重试；都带上脱敏的失败现场。
    throw classifyApplyFailure(error, { ...failure });
  }

  return result;
}
