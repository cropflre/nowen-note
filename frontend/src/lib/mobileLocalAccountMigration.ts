import { newLocalId } from "./localRepository";
import type { NativeAttachmentStore, NativeAttachmentFileInfo } from "./nativeAttachmentStore";
import type { NativeDatabase } from "./nativeDatabase";

const MIGRATION_KEY = "mobileLocalAccountMigrationV1";

type EntityType = "notebook" | "note" | "tag" | "note_tag" | "favorite" | "attachment"
  | "task" | "task_reminder" | "diary" | "mindmap";

interface MigrationMap {
  status: "running" | "complete";
  notebooks: Record<string, string>;
  notes: Record<string, string>;
  tags: Record<string, string>;
  attachments: Record<string, string>;
  tasks: Record<string, string>;
  taskReminders: Record<string, string>;
  diaries: Record<string, string>;
  mindmaps: Record<string, string>;
  noteTags: Record<string, string>;
  favorites: Record<string, string>;
}

interface MigrationOptions {
  sourceDb: NativeDatabase;
  sourceAttachments: NativeAttachmentStore;
  targetDb: NativeDatabase;
  targetAttachments: NativeAttachmentStore;
  targetUserId: string;
  profileId: string;
  deviceId: string;
}

interface AttachmentCopy {
  source: Record<string, unknown>;
  stored: NativeAttachmentFileInfo;
}

function now(): string {
  return new Date().toISOString();
}

function emptyMap(): MigrationMap {
  return {
    status: "running",
    notebooks: {},
    notes: {},
    tags: {},
    attachments: {},
    tasks: {},
    taskReminders: {},
    diaries: {},
    mindmaps: {},
    noteTags: {},
    favorites: {},
  };
}

function parseMap(value: string | undefined): MigrationMap {
  if (!value) return emptyMap();
  try {
    const parsed = JSON.parse(value) as Partial<MigrationMap>;
    return {
      status: parsed.status === "complete" ? "complete" : "running",
      notebooks: parsed.notebooks || {},
      notes: parsed.notes || {},
      tags: parsed.tags || {},
      attachments: parsed.attachments || {},
      tasks: parsed.tasks || {},
      taskReminders: parsed.taskReminders || {},
      diaries: parsed.diaries || {},
      mindmaps: parsed.mindmaps || {},
      noteTags: parsed.noteTags || {},
      favorites: parsed.favorites || {},
    };
  } catch {
    return emptyMap();
  }
}

function ensureId(map: Record<string, string>, sourceId: string): boolean {
  if (map[sourceId]) return false;
  map[sourceId] = newLocalId();
  return true;
}

async function saveMap(db: NativeDatabase, map: MigrationMap): Promise<void> {
  await db.run(
    `INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,
    [MIGRATION_KEY, JSON.stringify(map), now()],
  );
}

async function enqueue(
  db: NativeDatabase,
  profileId: string,
  deviceId: string,
  entityType: EntityType,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const mutationId = `mobile-local-v1:${entityType}:${entityId}`;
  await db.run(`INSERT OR IGNORE INTO sync_outbox (
    id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,status,retryCount,createdAt
  ) VALUES (?,?,?,?,? ,?,?, 'upsert',?,'pending',0,?)`, [
    newLocalId(),mutationId,profileId,deviceId,"personal",entityType,entityId,JSON.stringify(payload),now(),
  ]);
}

/**
 * 首次登录时把 Android 游客库复制到账户库，并为复制的数据创建同步 Outbox。
 * 游客库始终保留为本地备份；映射写入账户库，迁移中断后可使用相同目标 ID 重试。
 */
export async function migrateMobileLocalAccount(options: MigrationOptions): Promise<void> {
  const marker = (await options.targetDb.query<{ value: string }>(
    "SELECT value FROM native_runtime_meta WHERE key=?",
    [MIGRATION_KEY],
  ))[0]?.value;
  const mapping = parseMap(marker);
  let moduleMigrationRecorded = false;
  try {
    const saved = marker ? JSON.parse(marker) as Record<string, unknown> : {};
    moduleMigrationRecorded = ["tasks", "taskReminders", "diaries", "mindmaps"]
      .every((key) => Object.prototype.hasOwnProperty.call(saved, key));
  } catch {
    moduleMigrationRecorded = false;
  }
  if (mapping.status === "complete" && moduleMigrationRecorded) return;
  mapping.status = "running";

  const [notebooks, notes, tags, noteTags, favorites, attachments, tasks, taskReminders, diaries, mindmaps] = await Promise.all([
    options.sourceDb.query<Record<string, unknown>>(
      "SELECT * FROM notebooks WHERE scopeKey='personal' ORDER BY parentId IS NOT NULL,createdAt",
    ),
    options.sourceDb.query<Record<string, unknown>>(
      "SELECT * FROM notes WHERE scopeKey='personal' ORDER BY createdAt",
    ),
    options.sourceDb.query<Record<string, unknown>>(
      "SELECT * FROM tags WHERE scopeKey='personal' ORDER BY createdAt",
    ),
    options.sourceDb.query<Record<string, unknown>>(
      "SELECT * FROM note_tags WHERE scopeKey='personal' ORDER BY createdAt",
    ),
    options.sourceDb.query<Record<string, unknown>>(
      "SELECT * FROM favorites WHERE scopeKey='personal' ORDER BY createdAt",
    ),
    options.sourceDb.query<Record<string, unknown>>(
      "SELECT * FROM attachments WHERE scopeKey='personal' AND available=1 ORDER BY createdAt",
    ),
    options.sourceDb.query<Record<string, unknown>>("SELECT * FROM tasks WHERE scopeKey='personal' ORDER BY createdAt"),
    options.sourceDb.query<Record<string, unknown>>("SELECT * FROM task_reminders ORDER BY createdAt"),
    options.sourceDb.query<Record<string, unknown>>("SELECT * FROM diaries WHERE scopeKey='personal' ORDER BY createdAt"),
    options.sourceDb.query<Record<string, unknown>>("SELECT * FROM mindmaps WHERE scopeKey='personal' ORDER BY createdAt"),
  ]);

  if (!notebooks.length && !notes.length && !tags.length && !attachments.length && !tasks.length && !diaries.length && !mindmaps.length) {
    mapping.status = "complete";
    await saveMap(options.targetDb, mapping);
    return;
  }

  for (const row of notebooks) ensureId(mapping.notebooks, String(row.id));
  for (const row of notes) ensureId(mapping.notes, String(row.id));
  for (const row of tags) ensureId(mapping.tags, String(row.id));
  for (const row of attachments) ensureId(mapping.attachments, String(row.id));
  for (const row of tasks) ensureId(mapping.tasks, String(row.id));
  for (const row of taskReminders) ensureId(mapping.taskReminders, String(row.id));
  for (const row of diaries) ensureId(mapping.diaries, String(row.id));
  for (const row of mindmaps) ensureId(mapping.mindmaps, String(row.id));
  for (const row of noteTags) {
    const sourceKey = `${String(row.noteId)}:${String(row.tagId)}`;
    if (!mapping.noteTags[sourceKey]) mapping.noteTags[sourceKey] = sourceKey;
  }
  for (const row of favorites) {
    const sourceKey = `${String(row.userId)}:${String(row.noteId)}`;
    if (!mapping.favorites[sourceKey]) mapping.favorites[sourceKey] = sourceKey;
  }
  mapping.status = "running";
  await saveMap(options.targetDb, mapping);

  const copiedAttachments = new Map<string, AttachmentCopy>();
  for (const row of attachments) {
    const sourceId = String(row.id);
    const targetId = mapping.attachments[sourceId];
    const targetNoteId = mapping.notes[String(row.noteId)];
    if (!targetId || !targetNoteId) continue;
    try {
      const blob = await options.sourceAttachments.read(
        sourceId,
        String(row.mimeType || "application/octet-stream"),
      );
      const stored = await options.targetAttachments.save({
        attachmentId: targetId,
        data: blob,
        expectedSize: Number(row.size) || undefined,
        expectedHash: typeof row.hash === "string" ? row.hash : undefined,
      });
      copiedAttachments.set(sourceId, { source: row, stored });
    } catch (error) {
      console.warn("[mobile-local-first] 游客附件迁移失败，保留原文件等待后续处理", sourceId, error);
    }
  }

  await options.targetDb.transaction(async (tx) => {
    for (const row of notebooks) {
      const id = mapping.notebooks[String(row.id)];
      const parentId = row.parentId ? mapping.notebooks[String(row.parentId)] || null : null;
      const payload = { ...row, id, scopeKey: "personal", workspaceId: null, userId: options.targetUserId, parentId };
      await tx.run(`INSERT OR IGNORE INTO notebooks (
        id,scopeKey,workspaceId,userId,parentId,name,description,icon,color,sortOrder,isExpanded,isDeleted,deletedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id,"personal",null,options.targetUserId,parentId,row.name,row.description,row.icon,row.color,row.sortOrder,
        row.isExpanded,row.isDeleted,row.deletedAt,row.createdAt,row.updatedAt,
      ]);
      await enqueue(tx,options.profileId,options.deviceId,"notebook",id,payload);
    }

    const usedTagNames = new Set((await tx.query<{ name: string }>(
      "SELECT name FROM tags WHERE scopeKey='personal'",
    )).map((row) => row.name));
    for (const row of tags) {
      const id = mapping.tags[String(row.id)];
      const baseName = String(row.name || "标签");
      let name = baseName;
      if (usedTagNames.has(name)) name = `${baseName}（本地 ${id.slice(0, 6)}）`;
      usedTagNames.add(name);
      const payload = { ...row, id, scopeKey: "personal", workspaceId: null, userId: options.targetUserId, name };
      await tx.run(
        "INSERT OR IGNORE INTO tags (id,scopeKey,workspaceId,userId,name,color,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)",
        [id,"personal",null,options.targetUserId,name,row.color,row.createdAt,row.updatedAt],
      );
      await enqueue(tx,options.profileId,options.deviceId,"tag",id,payload);
    }

    for (const row of notes) {
      const id = mapping.notes[String(row.id)];
      const notebookId = mapping.notebooks[String(row.notebookId)];
      if (!notebookId) continue;
      const payload = { ...row, id, scopeKey: "personal", workspaceId: null, userId: options.targetUserId, notebookId };
      await tx.run(`INSERT OR IGNORE INTO notes (
        id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id,"personal",null,options.targetUserId,notebookId,row.title,row.content,row.contentText,row.contentFormat,
        row.isPinned,row.isFavorite,row.isLocked,row.isArchived,row.isTrashed,row.trashedAt,row.version,row.sortOrder,row.createdAt,row.updatedAt,
      ]);
      await enqueue(tx,options.profileId,options.deviceId,"note",id,payload);
    }

    for (const row of tasks) {
      const id = mapping.tasks[String(row.id)];
      const payload: Record<string, any> = {
        ...row,id,scopeKey:"personal",workspaceId:null,userId:options.targetUserId,
        noteId:row.noteId ? mapping.notes[String(row.noteId)] || null : null,
        parentId:row.parentId ? mapping.tasks[String(row.parentId)] || null : null,
      };
      await tx.run(`INSERT OR IGNORE INTO tasks (
        id,scopeKey,workspaceId,userId,title,description,isCompleted,completedAt,priority,dueDate,dueAt,startDate,noteId,parentId,sortOrder,projectId,status,createdAt,updatedAt
      ) VALUES (?,'personal',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
        id,options.targetUserId,payload.title,payload.description,payload.isCompleted,payload.completedAt,payload.priority,
        payload.dueDate,payload.dueAt,payload.startDate,payload.noteId,payload.parentId,payload.sortOrder,payload.projectId,
        payload.status,payload.createdAt,payload.updatedAt,
      ]);
      await enqueue(tx,options.profileId,options.deviceId,"task",id,payload);
    }

    for (const row of taskReminders) {
      const id = mapping.taskReminders[String(row.id)];
      const taskId = mapping.tasks[String(row.taskId)];
      if (!taskId) continue;
      const payload: Record<string, any> = { ...row,id,taskId,userId:options.targetUserId };
      await tx.run(`INSERT OR IGNORE INTO task_reminders (
        id,taskId,userId,offsetMinutes,enabled,lastNotifiedAt,snoozedUntil,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?)`,[
        id,taskId,options.targetUserId,payload.offsetMinutes,payload.enabled,payload.lastNotifiedAt,payload.snoozedUntil,payload.createdAt,payload.updatedAt,
      ]);
      await enqueue(tx,options.profileId,options.deviceId,"task_reminder",id,payload);
    }

    for (const row of diaries) {
      const id = mapping.diaries[String(row.id)];
      const payload: Record<string, any> = { ...row,id,scopeKey:"personal",workspaceId:null,userId:options.targetUserId };
      await tx.run(`INSERT OR IGNORE INTO diaries (id,scopeKey,workspaceId,userId,contentText,mood,images,media,createdAt)
        VALUES (?,'personal',NULL,?,?,?,?,?,?)`,[
        id,options.targetUserId,payload.contentText,payload.mood,payload.images,payload.media,payload.createdAt,
      ]);
      await enqueue(tx,options.profileId,options.deviceId,"diary",id,payload);
    }

    for (const row of mindmaps) {
      const id = mapping.mindmaps[String(row.id)];
      const payload: Record<string, any> = { ...row,id,scopeKey:"personal",workspaceId:null,userId:options.targetUserId,folderId:null };
      await tx.run(`INSERT OR IGNORE INTO mindmaps (
        id,scopeKey,workspaceId,userId,title,data,starred,folderId,createdAt,updatedAt
      ) VALUES (?,'personal',NULL,?,?,?,?,?,?,?)`,[
        id,options.targetUserId,payload.title,payload.data,payload.starred,null,payload.createdAt,payload.updatedAt,
      ]);
      await enqueue(tx,options.profileId,options.deviceId,"mindmap",id,payload);
    }

    for (const row of noteTags) {
      const noteId = mapping.notes[String(row.noteId)];
      const tagId = mapping.tags[String(row.tagId)];
      if (!noteId || !tagId) continue;
      await tx.run(
        "INSERT OR IGNORE INTO note_tags (scopeKey,workspaceId,noteId,tagId,createdAt) VALUES ('personal',NULL,?,?,?)",
        [noteId,tagId,row.createdAt || now()],
      );
      await enqueue(tx,options.profileId,options.deviceId,"note_tag",`${noteId}:${tagId}`,{ noteId,tagId,workspaceId:null });
    }

    for (const row of favorites) {
      const noteId = mapping.notes[String(row.noteId)];
      if (!noteId) continue;
      await tx.run(
        "INSERT OR IGNORE INTO favorites (scopeKey,workspaceId,userId,noteId,createdAt) VALUES ('personal',NULL,?,?,?)",
        [options.targetUserId,noteId,row.createdAt || now()],
      );
      await enqueue(tx,options.profileId,options.deviceId,"favorite",`${options.targetUserId}:${noteId}`,{
        userId:options.targetUserId,noteId,workspaceId:null,createdAt:row.createdAt || now(),
      });
    }

    for (const [sourceId, copied] of copiedAttachments) {
      const id = mapping.attachments[sourceId];
      const noteId = mapping.notes[String(copied.source.noteId)];
      const createdAt = String(copied.source.createdAt || now());
      if (!id || !noteId) continue;
      const payload = {
        id,noteId,userId:options.targetUserId,workspaceId:null,filename:copied.source.filename,
        mimeType:copied.source.mimeType,size:copied.stored.size,hash:copied.stored.sha256,createdAt,
      };
      await tx.run(`INSERT OR IGNORE INTO attachments (
        id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,localPath,hash,available,transferStatus,createdAt,updatedAt
      ) VALUES (?,'personal',NULL,?,?,?,?,?,?,?,1,'pending_upload',?,?)`, [
        id,noteId,options.targetUserId,copied.source.filename,copied.source.mimeType,copied.stored.size,
        copied.stored.path,copied.stored.sha256,createdAt,now(),
      ]);
      await enqueue(tx,options.profileId,options.deviceId,"attachment",id,payload);
    }

    mapping.status = copiedAttachments.size === attachments.length ? "complete" : "running";
    await saveMap(tx, mapping);
  });
}
