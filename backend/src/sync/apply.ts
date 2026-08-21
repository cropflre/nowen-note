import type Database from "better-sqlite3";
import { runChangeFeedSuppressed } from "./suppression";
import { SyncError } from "./errors";
import type { SyncEntityType, SyncOperation } from "./types";

/**
 * Sync V2 服务端 mutation 应用层。
 *
 * 三条硬性约束：
 *
 * 1. 幂等。客户端请求超时后无法确认服务端是否成功，必然重发同一个
 *    mutationId。重发不能产生第二条数据，必须返回首次的结果语义。
 *    实现方式是"查台账 → 业务写入 → 记台账"全部在同一事务内。
 *
 * 2. 不静默覆盖正文。note 的 upsert 携带 baseVersion，与服务端当前
 *    version 不一致就返回 VERSION_CONFLICT，交由冲突中心处理。
 *
 * 3. 不产生同步回环。应用远端 mutation 属于"来自客户端的真实修改"，
 *    因此**不**抑制 Change Feed（其他设备需要看到它）；
 *    只有客户端把服务端变更写回本地时才抑制，那发生在客户端侧。
 */

export interface ApplyMutationInput {
  userId: string;
  deviceId: string;
  mutationId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  baseVersion?: number;
  payload?: Record<string, unknown>;
}

export interface ApplyMutationResult {
  mutationId: string;
  status: "applied" | "duplicate" | "conflict";
  version?: number;
  code?: string;
  serverVersion?: number;
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

/** 查台账：已处理过的 mutation 直接返回首次结果。 */
function findApplied(
  db: Database.Database,
  mutationId: string,
  userId: string,
): { resultVersion: number | null } | null {
  const row = db.prepare(`
    SELECT resultVersion FROM sync_v2_applied_mutations
    WHERE mutationId = ? AND userId = ?
  `).get(mutationId, userId) as { resultVersion: number | null } | undefined;
  return row || null;
}

function recordApplied(
  db: Database.Database,
  input: ApplyMutationInput,
  resultVersion: number | null,
): void {
  db.prepare(`
    INSERT INTO sync_v2_applied_mutations (
      mutationId, userId, deviceId, entityType, entityId, operation, resultVersion, appliedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    input.mutationId,
    input.userId,
    input.deviceId,
    input.entityType,
    input.entityId,
    input.operation,
    resultVersion,
  );
}

// ---------------------------------------------------------------------------
// 各实体的写入
// ---------------------------------------------------------------------------

function applyNotebook(db: Database.Database, input: ApplyMutationInput): number | null {
  if (input.operation === "delete") {
    // 软删除：notebooks 有 isDeleted 列，硬删会连带级联清掉笔记，
    // 而删除笔记本不应意味着销毁其中的内容。
    db.prepare(`
      UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ? AND userId = ? AND workspaceId IS NULL
    `).run(input.entityId, input.userId);
    return null;
  }

  const p = input.payload || {};
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
    WHERE notebooks.userId = excluded.userId
  `).run(
    input.entityId,
    input.userId,
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
  return null;
}

function applyTag(db: Database.Database, input: ApplyMutationInput): number | null {
  if (input.operation === "delete") {
    db.prepare("DELETE FROM tags WHERE id = ? AND userId = ? AND workspaceId IS NULL")
      .run(input.entityId, input.userId);
    return null;
  }

  const p = input.payload || {};
  db.prepare(`
    INSERT INTO tags (id, userId, name, color, createdAt, workspaceId)
    VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), NULL)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      color = excluded.color
    WHERE tags.userId = excluded.userId
  `).run(
    input.entityId,
    input.userId,
    str(p.name, "未命名标签"),
    str(p.color, "#58a6ff"),
    p.createdAt ?? null,
  );
  return null;
}

/**
 * note 是唯一带版本冲突检测的实体，因为它承载正文。
 *
 * baseVersion 缺失时按"客户端不知道自己在覆盖什么"处理：
 * 若服务端已存在该笔记，一律判冲突，绝不盲目覆盖正文。
 */
function applyNote(db: Database.Database, input: ApplyMutationInput): number | null {
  const existing = db.prepare(`
    SELECT version FROM notes WHERE id = ? AND userId = ? AND workspaceId IS NULL
  `).get(input.entityId, input.userId) as { version: number } | undefined;

  if (input.operation === "delete") {
    if (!existing) return null; // 已不存在：delete 天然幂等
    if (input.baseVersion !== undefined && existing.version !== input.baseVersion) {
      throw new SyncError("VERSION_CONFLICT", `服务端版本 ${existing.version}`);
    }
    db.prepare("DELETE FROM notes WHERE id = ? AND userId = ?")
      .run(input.entityId, input.userId);
    return null;
  }

  const p = input.payload || {};

  if (existing) {
    const base = input.baseVersion;
    if (base === undefined || existing.version !== base) {
      throw new SyncError("VERSION_CONFLICT", `服务端版本 ${existing.version}`);
    }
    const nextVersion = existing.version + 1;
    db.prepare(`
      UPDATE notes SET
        notebookId = ?, title = ?, content = ?, contentText = ?, contentFormat = ?,
        isPinned = ?, isFavorite = ?, isLocked = ?, isArchived = ?, isTrashed = ?,
        trashedAt = ?, sortOrder = ?, version = ?, updatedAt = datetime('now')
      WHERE id = ? AND userId = ? AND workspaceId IS NULL
    `).run(
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
      num(p.sortOrder),
      nextVersion,
      input.entityId,
      input.userId,
    );
    return nextVersion;
  }

  // 新建：客户端生成 UUID，离线也能创建，不依赖服务端分配 ID。
  const version = Math.max(1, num(p.version, 1));
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText, contentFormat,
      isPinned, isFavorite, isLocked, isArchived, isTrashed, trashedAt,
      version, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              COALESCE(?, datetime('now')), datetime('now'))
  `).run(
    input.entityId,
    input.userId,
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
    version,
    num(p.sortOrder),
    p.createdAt ?? null,
  );
  return version;
}

/** entityId 形如 "noteId:tagId"。 */
function applyNoteTag(db: Database.Database, input: ApplyMutationInput): number | null {
  const separator = input.entityId.lastIndexOf(":");
  if (separator <= 0) throw new SyncError("INVALID_PAYLOAD", "note_tag entityId 需为 noteId:tagId");
  const noteId = input.entityId.slice(0, separator);
  const tagId = input.entityId.slice(separator + 1);

  // 校验笔记归属：不能通过关系表把别人的笔记挂上自己的标签。
  const owned = db.prepare(`
    SELECT 1 FROM notes WHERE id = ? AND userId = ? AND workspaceId IS NULL
  `).get(noteId, input.userId);
  if (!owned) throw new SyncError("MISSING_DEPENDENCY", "笔记不存在或无权访问");

  if (input.operation === "delete") {
    db.prepare("DELETE FROM note_tags WHERE noteId = ? AND tagId = ?").run(noteId, tagId);
    return null;
  }

  const tagOwned = db.prepare("SELECT 1 FROM tags WHERE id = ? AND userId = ?")
    .get(tagId, input.userId);
  if (!tagOwned) throw new SyncError("MISSING_DEPENDENCY", "标签不存在或无权访问");

  db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)")
    .run(noteId, tagId);
  return null;
}

/** entityId 形如 "userId:noteId"。 */
function applyFavorite(db: Database.Database, input: ApplyMutationInput): number | null {
  const separator = input.entityId.lastIndexOf(":");
  if (separator <= 0) throw new SyncError("INVALID_PAYLOAD", "favorite entityId 需为 userId:noteId");
  const noteId = input.entityId.slice(separator + 1);

  const owned = db.prepare(`
    SELECT 1 FROM notes WHERE id = ? AND userId = ? AND workspaceId IS NULL
  `).get(noteId, input.userId);
  if (!owned) throw new SyncError("MISSING_DEPENDENCY", "笔记不存在或无权访问");

  if (input.operation === "delete") {
    db.prepare("DELETE FROM favorites WHERE userId = ? AND noteId = ?")
      .run(input.userId, noteId);
    return null;
  }

  db.prepare(`
    INSERT OR IGNORE INTO favorites (userId, noteId, workspaceId, createdAt)
    VALUES (?, ?, NULL, datetime('now'))
  `).run(input.userId, noteId);
  return null;
}

/**
 * 附件只同步元数据。
 *
 * 二进制走独立 upload/download：把文件内容塞进 mutation 会让
 * push 请求体不可控，且上传失败时不应阻塞元数据同步。
 * 因此这里不接受 upsert 创建——附件必须先通过上传接口落地，
 * 只处理 delete 与已存在记录的元数据更新。
 */
function applyAttachment(db: Database.Database, input: ApplyMutationInput): number | null {
  if (input.operation === "delete") {
    db.prepare("DELETE FROM attachments WHERE id = ? AND userId = ?")
      .run(input.entityId, input.userId);
    return null;
  }

  const existing = db.prepare("SELECT 1 FROM attachments WHERE id = ? AND userId = ?")
    .get(input.entityId, input.userId);
  if (!existing) {
    throw new SyncError(
      "MISSING_DEPENDENCY",
      "附件二进制尚未上传，元数据无法先行同步",
    );
  }

  const p = input.payload || {};
  db.prepare(`
    UPDATE attachments SET filename = COALESCE(?, filename)
    WHERE id = ? AND userId = ?
  `).run(typeof p.filename === "string" ? p.filename : null, input.entityId, input.userId);
  return null;
}

// ---------------------------------------------------------------------------
// 阶段 J：其余个人实体
// ---------------------------------------------------------------------------

/**
 * 任务：可变结构化对象。
 *
 * 冲突策略与 note 不同 —— tasks 表没有 version 列，用 updatedAt 作逻辑版本。
 * 但**不做时间戳大小比较**：两台设备的系统时钟可能相差几分钟，
 * 按时间判定"谁更新"会让慢钟设备的修改被永久吞掉。
 * 因此只要双方 updatedAt 不同就判冲突，交给用户决定。
 */
function applyTask(db: Database.Database, input: ApplyMutationInput): number | null {
  if (input.operation === "delete") {
    // 子任务通过 parentId 的 CASCADE 一并删除，与本地删除语义一致。
    db.prepare("DELETE FROM tasks WHERE id = ? AND userId = ?")
      .run(input.entityId, input.userId);
    return null;
  }

  const p = input.payload || {};
  const existing = db.prepare(
    "SELECT updatedAt FROM tasks WHERE id = ? AND userId = ?",
  ).get(input.entityId, input.userId) as { updatedAt: string } | undefined;

  if (existing) {
    // baseVersion 在 task 上承载的是"客户端看到的 updatedAt 哈希"没有意义，
    // 因此直接比对 updatedAt 字符串：不一致说明双方各自改过。
    const clientBase = typeof p.baseUpdatedAt === "string" ? p.baseUpdatedAt : null;
    if (clientBase !== null && clientBase !== existing.updatedAt) {
      throw new SyncError("VERSION_CONFLICT", "任务在服务端已被修改");
    }
  }

  db.prepare(`
    INSERT INTO tasks (
      id, userId, title, isCompleted, completedAt, priority, dueDate,
      noteId, parentId, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      isCompleted = excluded.isCompleted,
      completedAt = excluded.completedAt,
      priority = excluded.priority,
      dueDate = excluded.dueDate,
      noteId = excluded.noteId,
      parentId = excluded.parentId,
      sortOrder = excluded.sortOrder,
      updatedAt = datetime('now')
  `).run(
    input.entityId,
    input.userId,
    typeof p.title === "string" ? p.title : "",
    p.isCompleted ? 1 : 0,
    typeof p.completedAt === "string" ? p.completedAt : null,
    Number.isFinite(p.priority as number) ? Number(p.priority) : 2,
    typeof p.dueDate === "string" ? p.dueDate : null,
    // noteId / parentId 指向可能尚未同步的实体：置 null 而不是报错，
    // 否则一条孤儿引用会让整个任务永远同步不过去。关系会在对端补齐后自然修复。
    typeof p.noteId === "string" && noteExists(db, p.noteId, input.userId) ? p.noteId : null,
    typeof p.parentId === "string" && taskExists(db, p.parentId, input.userId) ? p.parentId : null,
    Number.isFinite(p.sortOrder as number) ? Number(p.sortOrder) : 0,
    typeof p.createdAt === "string" ? p.createdAt : null,
  );
  return null;
}

function noteExists(db: Database.Database, id: string, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM notes WHERE id = ? AND userId = ?").get(id, userId);
}

function taskExists(db: Database.Database, id: string, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM tasks WHERE id = ? AND userId = ?").get(id, userId);
}

/**
 * 任务提醒：依附于 task 的时间型实体。
 *
 * 不参与版本冲突：一条提醒就是 (taskId, offsetMinutes, enabled) 三元组，
 * 两端各自设置同一提醒时结果相同。
 *
 * lastNotifiedAt **不同步** —— 那是"这台设备有没有弹过通知"的本机状态，
 * 同步过来会让另一台设备漏掉提醒。
 */
function applyTaskReminder(db: Database.Database, input: ApplyMutationInput): number | null {
  if (input.operation === "delete") {
    db.prepare("DELETE FROM task_reminders WHERE id = ? AND userId = ?")
      .run(input.entityId, input.userId);
    return null;
  }

  const p = input.payload || {};
  const taskId = typeof p.taskId === "string" ? p.taskId : "";
  if (!taskId || !taskExists(db, taskId, input.userId)) {
    // 提醒无法脱离任务存在：明确报缺依赖，让客户端在 task 同步后重试。
    throw new SyncError("MISSING_DEPENDENCY", "提醒所属任务尚未同步");
  }

  db.prepare(`
    INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled, createdAt)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id) DO UPDATE SET
      offsetMinutes = excluded.offsetMinutes,
      enabled = excluded.enabled
  `).run(
    input.entityId,
    taskId,
    input.userId,
    Number.isFinite(p.offsetMinutes as number) ? Number(p.offsetMinutes) : 30,
    p.enabled === false ? 0 : 1,
    typeof p.createdAt === "string" ? p.createdAt : null,
  );
  return null;
}

/**
 * 说说 / 日记：追加型记录。
 *
 * 表里只有 createdAt 没有 updatedAt —— 这类内容发布后极少修改。
 * 因此用幂等 upsert 而不做冲突检测：同 ID 就是同一条记录。
 *
 * images / media 是 JSON 数组字符串，元素指向 diary_attachments。
 * 那些附件的二进制走独立通道（与 attachments 同理），
 * 此处只同步引用关系。
 */
function applyDiary(db: Database.Database, input: ApplyMutationInput): number | null {
  if (input.operation === "delete") {
    db.prepare("DELETE FROM diaries WHERE id = ? AND userId = ?")
      .run(input.entityId, input.userId);
    return null;
  }

  const p = input.payload || {};
  const asJsonArray = (value: unknown): string => {
    if (typeof value === "string") {
      // 已是 JSON 字符串：校验可解析，坏数据一律退化为空数组，
      // 否则前端 JSON.parse 会直接抛错把整个列表打崩。
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? value : "[]";
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
    input.entityId,
    input.userId,
    typeof p.contentText === "string" ? p.contentText : "",
    typeof p.mood === "string" ? p.mood : "",
    asJsonArray(p.images),
    asJsonArray(p.media),
    typeof p.createdAt === "string" ? p.createdAt : null,
  );
  return null;
}

/**
 * 思维导图：版本化文档。
 *
 * data 是整份图的 JSON。这类实体**必须**防覆盖：
 * 盲目写入会让另一台设备上新增的整个分支瞬间消失，而且无法恢复。
 *
 * 与 note 一样用 baseUpdatedAt 比对，不一致即冲突。
 */
function applyMindmap(db: Database.Database, input: ApplyMutationInput): number | null {
  if (input.operation === "delete") {
    db.prepare("DELETE FROM mindmaps WHERE id = ? AND userId = ?")
      .run(input.entityId, input.userId);
    return null;
  }

  const p = input.payload || {};
  const existing = db.prepare(
    "SELECT updatedAt FROM mindmaps WHERE id = ? AND userId = ?",
  ).get(input.entityId, input.userId) as { updatedAt: string } | undefined;

  if (existing) {
    const clientBase = typeof p.baseUpdatedAt === "string" ? p.baseUpdatedAt : null;
    // 与 note 同一原则：**缺少 base 也判冲突**。
    // 客户端不知道自己在覆盖什么，宁可报冲突也不盲目覆盖整份导图。
    if (clientBase === null || clientBase !== existing.updatedAt) {
      throw new SyncError("VERSION_CONFLICT", "思维导图在服务端已被修改");
    }
  }

  db.prepare(`
    INSERT INTO mindmaps (id, userId, workspaceId, title, data, createdAt, updatedAt)
    VALUES (?, ?, NULL, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      data = excluded.data,
      updatedAt = datetime('now')
  `).run(
    input.entityId,
    input.userId,
    typeof p.title === "string" ? p.title : "无标题导图",
    typeof p.data === "string" ? p.data : JSON.stringify(p.data ?? {}),
    typeof p.createdAt === "string" ? p.createdAt : null,
  );
  return null;
}

const APPLIERS: Record<SyncEntityType, (db: Database.Database, input: ApplyMutationInput) => number | null> = {
  notebook: applyNotebook,
  note: applyNote,
  tag: applyTag,
  note_tag: applyNoteTag,
  favorite: applyFavorite,
  attachment: applyAttachment,
  task: applyTask,
  task_reminder: applyTaskReminder,
  diary: applyDiary,
  mindmap: applyMindmap,
};

/**
 * 应用单条 mutation。
 *
 * 调用方负责开事务——push 的每条 mutation 独立成事务，
 * 这样一条冲突不会回滚同批次已成功的其他条目。
 */
export function applyMutation(
  db: Database.Database,
  input: ApplyMutationInput,
): ApplyMutationResult {
  const already = findApplied(db, input.mutationId, input.userId);
  if (already) {
    // 幂等命中：返回首次的结果，不再执行业务写入。
    return {
      mutationId: input.mutationId,
      status: "duplicate",
      version: already.resultVersion ?? undefined,
    };
  }

  const applier = APPLIERS[input.entityType];
  if (!applier) throw new SyncError("INVALID_PAYLOAD", `不支持的实体：${input.entityType}`);

  const resultVersion = applier(db, input);
  recordApplied(db, input, resultVersion);

  return {
    mutationId: input.mutationId,
    status: "applied",
    version: resultVersion ?? undefined,
  };
}

/**
 * 应用一批远端变更时抑制 Change Feed。
 *
 * 供服务端内部的"从别处导入/回填"路径使用；
 * 常规 push 不走这里，因为其他设备必须看到这些变更。
 */
export function applyWithoutFeed<T>(db: Database.Database, fn: () => T): T {
  return runChangeFeedSuppressed(db, fn);
}
