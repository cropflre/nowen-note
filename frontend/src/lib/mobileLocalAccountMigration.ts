import { newLocalId } from "./localRepository";
import type { NativeAttachmentStore } from "./nativeAttachmentStore";
import type { NativeDatabase } from "./nativeDatabase";

const MIGRATION_KEY = "mobileLocalAccountMigrationV1";
type EntityType = "notebook" | "note" | "tag" | "note_tag" | "favorite" | "attachment"
  | "task" | "task_reminder" | "diary" | "mindmap";
type Row = Record<string, unknown>;
type IdMapKey = "notebooks" | "notes" | "tags" | "attachments" | "tasks" | "taskReminders" | "diaries" | "mindmaps";
type MigrationMap = Record<IdMapKey, Record<string, string>> & {
  status: "running" | "complete";
  versions: Record<string, { source: string; target: string; entityId?: string }>;
};
interface MigrationOptions {
  sourceDb: NativeDatabase;
  sourceAttachments: NativeAttachmentStore;
  targetDb: NativeDatabase;
  targetAttachments: NativeAttachmentStore;
  targetUserId: string;
  profileId: string;
  deviceId: string;
}

const TABLES: Record<EntityType, { table: string; columns: string[]; keys: string[]; map?: IdMapKey }> = {
  notebook: { table: "notebooks", columns: "id,scopeKey,workspaceId,userId,parentId,name,description,icon,color,sortOrder,isExpanded,isDeleted,deletedAt,createdAt,updatedAt".split(","), keys: ["scopeKey", "id"], map: "notebooks" },
  note: { table: "notes", columns: "id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,colorMark,isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt".split(","), keys: ["scopeKey", "id"], map: "notes" },
  tag: { table: "tags", columns: "id,scopeKey,workspaceId,userId,name,color,createdAt,updatedAt".split(","), keys: ["scopeKey", "id"], map: "tags" },
  note_tag: { table: "note_tags", columns: "scopeKey,workspaceId,noteId,tagId,createdAt".split(","), keys: ["scopeKey", "noteId", "tagId"] },
  favorite: { table: "favorites", columns: "scopeKey,workspaceId,userId,noteId,createdAt".split(","), keys: ["scopeKey", "userId", "noteId"] },
  attachment: { table: "attachments", columns: "id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,localPath,hash,available,transferStatus,createdAt,updatedAt".split(","), keys: ["scopeKey", "id"], map: "attachments" },
  task: { table: "tasks", columns: "id,scopeKey,workspaceId,userId,title,description,isCompleted,completedAt,priority,dueDate,dueAt,startDate,noteId,parentId,sortOrder,projectId,status,createdAt,updatedAt".split(","), keys: ["id"], map: "tasks" },
  task_reminder: { table: "task_reminders", columns: "id,taskId,userId,offsetMinutes,enabled,lastNotifiedAt,snoozedUntil,createdAt,updatedAt".split(","), keys: ["id"], map: "taskReminders" },
  diary: { table: "diaries", columns: "id,scopeKey,workspaceId,userId,contentText,mood,images,media,createdAt".split(","), keys: ["id"], map: "diaries" },
  mindmap: { table: "mindmaps", columns: "id,scopeKey,workspaceId,userId,title,data,starred,folderId,createdAt,updatedAt".split(","), keys: ["id"], map: "mindmaps" },
};

function now(): string { return new Date().toISOString(); }
function parseMap(value: string | undefined): MigrationMap {
  let saved: Partial<MigrationMap> = {};
  try { saved = value ? JSON.parse(value) : {}; } catch { /* Start with an empty mapping. */ }
  return {
    status: "running", notebooks: saved.notebooks || {}, notes: saved.notes || {},
    tags: saved.tags || {}, attachments: saved.attachments || {}, tasks: saved.tasks || {},
    taskReminders: saved.taskReminders || {}, diaries: saved.diaries || {}, mindmaps: saved.mindmaps || {},
    versions: saved.versions || {},
  };
}
async function saveMap(db: NativeDatabase, map: MigrationMap): Promise<void> {
  await db.run(
    `INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,
    [MIGRATION_KEY, JSON.stringify(map), now()],
  );
}
/** Compare content without server revisions or attachment transfer bookkeeping. */
async function fingerprint(row: Row, columns: string[]): Promise<string> {
  const ignored = ["id", "createdAt", "updatedAt", "version", "localPath", "available", "transferStatus"];
  const content = JSON.stringify(columns.filter((key) => !ignored.includes(key)).sort().map((key) => [key, row[key] ?? null]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 单向增量导入：账号库记录每项已导入版本，实体、Outbox 和版本记录在同一事务提交。
 * 两边都修改时保留账号原件并导入本机副本；本机删除不传播到账户。
 * 旧 V1 ID 映射继续复用，无法判定的旧版内容差异也保留为副本。
 */
export async function migrateMobileLocalAccount(options: MigrationOptions): Promise<void> {
  const marker = (await options.targetDb.query<{ value: string }>(
    "SELECT value FROM native_runtime_meta WHERE key=?", [MIGRATION_KEY],
  ))[0]?.value;
  const mapping = parseMap(marker);
  const rows = {} as Record<EntityType, Row[]>;
  await Promise.all(Object.entries(TABLES).map(async ([type, { table }]) => {
    const filter = type === "task_reminder" ? "" : " WHERE scopeKey='personal'";
    rows[type as EntityType] = await options.sourceDb.query<Row>(`SELECT * FROM ${table}${filter} ORDER BY createdAt`);
  }));
  for (const [type, { map }] of Object.entries(TABLES)) {
    if (!map) continue;
    for (const row of rows[type as EntityType]) {
      if (!mapping[map][String(row.id)]) mapping[map][String(row.id)] = newLocalId();
    }
  }
  await saveMap(options.targetDb, mapping);

  await options.targetDb.transaction(async (tx) => {
    const accountRow = (row: Row): Row => ({ ...row, scopeKey: "personal", workspaceId: null, userId: options.targetUserId });
    let attachmentsPending = false;
    const importedNotes: Array<{ sourceId: string; payload: Row; mutationId: string }> = [];
    const sourceNotes = new Map(rows.note.map((row) => [String(row.id), row]));
    const sourceNotebooks = new Map(rows.notebook.map((row) => [String(row.id), row]));
    const sourceFingerprint = (type: EntityType, sourceId: string, payload: Row) => fingerprint(
      type === "note" ? { ...payload, notebookId: sourceNotes.get(sourceId)?.notebookId } : payload, TABLES[type].columns,
    );
    const importRow = async (type: EntityType, sourceId: string, payload: Row, attachmentSource?: Row, force = false) => {
      const { table, columns, keys, map } = TABLES[type];
      const versionKey = `${type}:${sourceId}`;
      const source = await sourceFingerprint(type, sourceId, payload);
      const previous = mapping.versions[versionKey];
      if (!force && previous?.source === source) return;
      const current = (await tx.query<Row>(
        `SELECT * FROM ${table} WHERE ${keys.map((key) => `${key}=?`).join(" AND ")}`, keys.map((key) => payload[key]),
      ))[0];
      const currentHash = current ? await fingerprint(current, columns) : null;
      // V1 had no entity versions. Equal rows can be claimed without replay;
      // ambiguous differences must preserve the account copy.
      if (currentHash === await fingerprint(payload, columns)) {
        mapping.versions[versionKey] = { source, target: currentHash!, entityId: typeof payload.id === "string" ? payload.id : undefined };
        return;
      }
      if (map && ((current && currentHash !== previous?.target)
        || (!current && previous && (!previous.entityId || previous.entityId === payload.id))
        || (type === "attachment" && current && current.noteId !== payload.noteId))) {
        payload.id = newLocalId();
        mapping[map][sourceId] = String(payload.id);
        if (typeof payload.title === "string") payload.title += "（仅此设备副本）";
        if (type === "notebook") payload.name = `${String(payload.name)}（仅此设备副本）`;
      }
      if (type === "tag") {
        const duplicate = await tx.query<{ id: string }>(
          "SELECT id FROM tags WHERE scopeKey='personal' AND name=? AND id<>?", [payload.name, payload.id],
        );
        if (duplicate.length) payload.name = `${String(payload.name)}（仅此设备 ${String(payload.id)}）`;
      }
      if (type === "note") payload.version = current && payload.id === current.id ? Number(current.version) + 1 : 1;
      if (attachmentSource) {
        if (Number(attachmentSource.available) !== 1) { attachmentsPending = true; return; }
        try {
          const blob = await options.sourceAttachments.read(sourceId, String(payload.mimeType || "application/octet-stream"));
          const stored = await options.targetAttachments.save({
            attachmentId: String(payload.id), data: blob, expectedSize: Number(payload.size) || undefined,
            expectedHash: typeof payload.hash === "string" ? payload.hash : undefined,
          });
          Object.assign(payload, { localPath: stored.path, size: stored.size, hash: stored.sha256, available: 1, transferStatus: "pending_upload" });
        } catch (error) {
          attachmentsPending = true;
          console.warn("[mobile-local-first] 本机附件导入失败，将在下次登录重试", sourceId, error);
          return;
        }
      }
      await tx.run(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
         ON CONFLICT(${keys.join(",")}) DO UPDATE SET ${columns.filter((key) => !keys.includes(key)).map((key) => `${key}=excluded.${key}`).join(",")}`,
        columns.map((key) => payload[key] ?? null),
      );
      const entityId = type === "note_tag" ? `${payload.noteId}:${payload.tagId}`
        : type === "favorite" ? `${payload.userId}:${payload.noteId}` : String(payload.id);
      const upload = { ...payload };
      if (type === "attachment") { delete upload.localPath; delete upload.available; delete upload.transferStatus; }
      const mutationId = newLocalId();
      await tx.run(`INSERT INTO sync_outbox (
        id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,baseVersion,payload,status,retryCount,createdAt
      ) VALUES (?,?,?,?,?,?,?,'upsert',?,?,'pending',0,?)`, [
        newLocalId(),mutationId,options.profileId,options.deviceId,"personal",type,entityId,
        payload.id === current?.id ? current?.version ?? null : null,JSON.stringify(upload),now(),
      ]);
      mapping.versions[versionKey] = { source, target: await fingerprint(payload, columns), entityId };
      if (type === "note") importedNotes.push({ sourceId, payload, mutationId });
    };

    // Import parents before children to satisfy notebook foreign keys.
    const pendingNotebooks = [...rows.notebook];
    while (pendingNotebooks.length) {
      const index = pendingNotebooks.findIndex((row) => !row.parentId || !pendingNotebooks.some((parent) => parent.id === row.parentId));
      if (index < 0) throw new Error("本机笔记本存在循环父级，无法导入");
      const row = pendingNotebooks.splice(index, 1)[0];
      await importRow("notebook", String(row.id), { ...accountRow(row), id: mapping.notebooks[String(row.id)],
        parentId: row.parentId ? mapping.notebooks[String(row.parentId)] || null : null });
    }
    for (const row of rows.tag) {
      await importRow("tag", String(row.id), { ...accountRow(row), id: mapping.tags[String(row.id)] });
    }
    const ensureNotebook = async (sourceId: string): Promise<void> => {
      const current = await tx.query("SELECT id FROM notebooks WHERE scopeKey='personal' AND id=? AND isDeleted=0", [mapping.notebooks[sourceId]]);
      if (current.length) return;
      const row = sourceNotebooks.get(sourceId);
      if (!row) return;
      if (row.parentId) await ensureNotebook(String(row.parentId));
      await importRow("notebook", sourceId, { ...accountRow(row), id: mapping.notebooks[sourceId],
        parentId: row.parentId ? mapping.notebooks[String(row.parentId)] || null : null }, undefined, true);
    };
    for (const row of rows.note) {
      if (!mapping.notebooks[String(row.notebookId)]) continue;
      const payload = { ...accountRow(row), id: mapping.notes[String(row.id)], notebookId: mapping.notebooks[String(row.notebookId)] };
      if (mapping.versions[`note:${String(row.id)}`]?.source === await sourceFingerprint("note", String(row.id), payload)) continue;
      // A deleted account folder must not block new/edited device notes. Recreate
      // only the required folder as a separate copy, without replaying unchanged notes.
      await ensureNotebook(String(row.notebookId));
      payload.notebookId = mapping.notebooks[String(row.notebookId)];
      await importRow("note", String(row.id), payload);
    }
    for (const row of rows.task) {
      await importRow("task", String(row.id), { ...accountRow(row), id: mapping.tasks[String(row.id)],
        noteId: row.noteId ? mapping.notes[String(row.noteId)] || null : null,
        parentId: row.parentId ? mapping.tasks[String(row.parentId)] || null : null });
    }
    for (const row of rows.task_reminder) {
      const taskId = mapping.tasks[String(row.taskId)];
      if (taskId) await importRow("task_reminder", String(row.id), { ...accountRow(row), id: mapping.taskReminders[String(row.id)], taskId });
    }
    for (const row of rows.diary) {
      await importRow("diary", String(row.id), { ...accountRow(row), id: mapping.diaries[String(row.id)] });
    }
    for (const row of rows.mindmap) {
      await importRow("mindmap", String(row.id), { ...accountRow(row), id: mapping.mindmaps[String(row.id)], folderId: null });
    }
    for (const row of rows.note_tag) {
      const noteId = mapping.notes[String(row.noteId)], tagId = mapping.tags[String(row.tagId)];
      if (noteId && tagId) await importRow("note_tag", `${row.noteId}:${row.tagId}`, { ...accountRow(row), noteId, tagId });
    }
    for (const row of rows.favorite) {
      const noteId = mapping.notes[String(row.noteId)];
      if (noteId) await importRow("favorite", `${row.userId}:${row.noteId}`, { ...accountRow(row), noteId });
    }
    for (const row of rows.attachment) {
      const noteId = mapping.notes[String(row.noteId)];
      if (noteId) await importRow("attachment", String(row.id), { ...accountRow(row), id: mapping.attachments[String(row.id)], noteId }, row);
    }
    // Attachment IDs may change when a note is forked. Rewrite only notes imported
    // in this transaction, keeping both their local document and Outbox consistent.
    for (const { sourceId, payload, mutationId } of importedNotes) {
      if (typeof payload.content !== "string") continue;
      const content = payload.content.replace(/\/(?:api|publicapi)\/attachments\/([\w-]+)/g,
        (reference, id: string) => mapping.attachments[id] ? `/api/attachments/${mapping.attachments[id]}` : reference);
      if (content === payload.content) continue;
      payload.content = content;
      await tx.run("UPDATE notes SET content=? WHERE scopeKey='personal' AND id=?", [content, payload.id]);
      await tx.run("UPDATE sync_outbox SET payload=? WHERE mutationId=?", [JSON.stringify(payload), mutationId]);
      mapping.versions[`note:${sourceId}`].target = await fingerprint(payload, TABLES.note.columns);
    }
    mapping.status = attachmentsPending ? "running" : "complete";
    await saveMap(tx, mapping);
  });
}
