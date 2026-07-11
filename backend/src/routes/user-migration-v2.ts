/**
 * User migration v2: safe one-way instance migration with preflight, backup,
 * idempotency, attachment verification and resumable execution.
 *
 * Mounted as /api/user-migration/v2 by user-migration-v2-register.ts.
 */
import { Hono } from "hono";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import {
  deleteAttachmentObject,
  getUploadMonthPath,
  readAttachmentObject,
  writeAttachmentObject,
} from "../services/attachment-storage";
import { syncReferences } from "../lib/attachmentRefs";

const router = new Hono();
const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
const MIGRATION_BACKUP_DIR = path.join(DATA_DIR, "migration-backups");
const MAX_SOURCE_ITEMS = 100_000;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

type Strategy = "skip" | "replace" | "keep-both";
type AttachmentKind = "note" | "task";
type JsonRecord = Record<string, any>;

interface MigrationSource {
  instanceId: string;
  userId: string;
  username: string;
}

interface AttachmentManifestItem {
  kind: AttachmentKind;
  id: string;
  parentId: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string;
  missing: boolean;
}

interface MigrationPayload {
  schemaVersion: 3;
  source: MigrationSource;
  snapshotHash: string;
  exportedAt: string;
  notebooks: JsonRecord[];
  notes: JsonRecord[];
  tags: JsonRecord[];
  noteTags: JsonRecord[];
  noteVersions: JsonRecord[];
  tasks: JsonRecord[];
}

interface MigrationItemRow {
  targetId: string;
  sourceHash: string;
  migrationId: string;
}

function sha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function entityHash(entityType: string, row: JsonRecord): string {
  const omit = new Set(["id", "userId", "workspaceId", "createdAt", "updatedAt", "creatorName"]);
  const normalized: JsonRecord = {};
  for (const key of Object.keys(row).sort()) {
    if (!omit.has(key)) normalized[key] = row[key];
  }
  return sha256(`${entityType}:${stableJson(normalized)}`);
}

function normalizeStrategy(value: unknown): Strategy | null {
  return value === "skip" || value === "replace" || value === "keep-both" ? value : null;
}

function safeFilename(value: string): string {
  const cleaned = (value || "attachment.bin")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "attachment.bin").slice(0, 180);
}

function extensionFor(filename: string, mimeType: string): string {
  const ext = path.extname(filename || "").replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "video/mp4": "mp4",
    "audio/mpeg": "mp3",
  };
  return map[(mimeType || "").toLowerCase()] || "bin";
}

function tableColumns(table: string): Set<string> {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function insertDynamic(table: string, row: JsonRecord): void {
  const columns = tableColumns(table);
  const keys = Object.keys(row).filter((key) => columns.has(key));
  if (keys.length === 0) throw new Error(`No writable columns for ${table}`);
  const placeholders = keys.map(() => "?").join(",");
  getDb()
    .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${placeholders})`)
    .run(...keys.map((key) => row[key]));
}

function updateDynamic(table: string, id: string, userId: string, row: JsonRecord): boolean {
  const columns = tableColumns(table);
  const keys = Object.keys(row).filter(
    (key) => columns.has(key) && !["id", "userId", "workspaceId", "createdAt"].includes(key),
  );
  if (keys.length === 0) return false;
  const assignments = keys.map((key) => `${key} = ?`);
  if (columns.has("updatedAt")) assignments.push("updatedAt = datetime('now')");
  const result = getDb()
    .prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ? AND userId = ?`)
    .run(...keys.map((key) => row[key]), id, userId);
  return result.changes > 0;
}

function ensureMigrationTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS user_migration_runs (
      id TEXT PRIMARY KEY,
      targetUserId TEXT NOT NULL,
      sourceInstanceId TEXT NOT NULL,
      sourceUserId TEXT NOT NULL,
      sourceSnapshotHash TEXT NOT NULL,
      strategy TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      backupFilename TEXT,
      backupSha256 TEXT,
      expectedAttachments INTEGER NOT NULL DEFAULT 0,
      importedAttachments INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      completedAt TEXT,
      FOREIGN KEY (targetUserId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_migration_runs_target
      ON user_migration_runs(targetUserId, sourceInstanceId, sourceUserId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS user_migration_items (
      targetUserId TEXT NOT NULL,
      sourceInstanceId TEXT NOT NULL,
      sourceUserId TEXT NOT NULL,
      entityType TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      sourceHash TEXT NOT NULL,
      targetId TEXT NOT NULL,
      migrationId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'imported',
      size INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (targetUserId, sourceInstanceId, sourceUserId, entityType, sourceId),
      FOREIGN KEY (targetUserId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_migration_items_run
      ON user_migration_items(migrationId, entityType);
  `);
}

function resolveInstanceId(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM system_settings WHERE key = ?").get("server_instance_id") as
    | { value: string }
    | undefined;
  if (row?.value) return row.value;
  const id = crypto.randomUUID();
  db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)").run("server_instance_id", id);
  const stored = db.prepare("SELECT value FROM system_settings WHERE key = ?").get("server_instance_id") as
    | { value: string }
    | undefined;
  return stored?.value || id;
}

function currentSource(userId: string): MigrationSource {
  const row = getDb().prepare("SELECT username FROM users WHERE id = ?").get(userId) as
    | { username: string }
    | undefined;
  return { instanceId: resolveInstanceId(), userId, username: row?.username || userId };
}

function queryPersonalData(userId: string) {
  const db = getDb();
  const notebooks = db
    .prepare("SELECT * FROM notebooks WHERE userId = ? AND workspaceId IS NULL AND COALESCE(isDeleted, 0) = 0 ORDER BY sortOrder, createdAt")
    .all(userId) as JsonRecord[];
  const notes = db
    .prepare("SELECT * FROM notes WHERE userId = ? AND workspaceId IS NULL ORDER BY createdAt, id")
    .all(userId) as JsonRecord[];
  const tags = db.prepare("SELECT * FROM tags WHERE userId = ? ORDER BY createdAt, id").all(userId) as JsonRecord[];
  const tasks = db
    .prepare("SELECT * FROM tasks WHERE userId = ? AND workspaceId IS NULL ORDER BY createdAt, id")
    .all(userId) as JsonRecord[];

  const noteIds = notes.map((row) => row.id);
  const noteTags = noteIds.length
    ? (db.prepare(`SELECT * FROM note_tags WHERE noteId IN (${noteIds.map(() => "?").join(",")})`).all(...noteIds) as JsonRecord[])
    : [];
  const noteVersions = noteIds.length
    ? (db.prepare(`SELECT * FROM note_versions WHERE noteId IN (${noteIds.map(() => "?").join(",")}) ORDER BY createdAt, id`).all(...noteIds) as JsonRecord[])
    : [];

  const noteAttachments = noteIds.length
    ? (db.prepare(
        `SELECT id, noteId AS parentId, filename, mimeType, size, path, hash
         FROM attachments WHERE userId = ? AND workspaceId IS NULL
         AND noteId IN (${noteIds.map(() => "?").join(",")}) ORDER BY createdAt, id`,
      ).all(userId, ...noteIds) as JsonRecord[])
    : [];

  const taskIds = tasks.map((row) => row.id);
  const taskAttachments = taskIds.length
    ? (db.prepare(
        `SELECT id, taskId AS parentId, filename, mimeType, size, path
         FROM task_attachments WHERE userId = ? AND workspaceId IS NULL
         AND taskId IN (${taskIds.map(() => "?").join(",")}) ORDER BY createdAt, id`,
      ).all(userId, ...taskIds) as JsonRecord[])
    : [];

  return { notebooks, notes, tags, noteTags, noteVersions, tasks, noteAttachments, taskAttachments };
}

async function buildAttachmentManifest(data: ReturnType<typeof queryPersonalData>): Promise<AttachmentManifestItem[]> {
  const manifest: AttachmentManifestItem[] = [];
  for (const [kind, rows] of [
    ["note", data.noteAttachments],
    ["task", data.taskAttachments],
  ] as const) {
    for (const row of rows) {
      const buffer = await readAttachmentObject(row.path);
      manifest.push({
        kind,
        id: String(row.id),
        parentId: String(row.parentId || ""),
        filename: String(row.filename || `${row.id}.bin`),
        mimeType: String(row.mimeType || "application/octet-stream"),
        size: Number(row.size || buffer?.length || 0),
        hash: buffer ? sha256(buffer) : "",
        missing: !buffer,
      });
    }
  }
  return manifest;
}

function buildPayload(userId: string, data = queryPersonalData(userId)): MigrationPayload {
  const source = currentSource(userId);
  const core = {
    schemaVersion: 3 as const,
    source,
    exportedAt: new Date().toISOString(),
    notebooks: data.notebooks,
    notes: data.notes,
    tags: data.tags,
    noteTags: data.noteTags,
    noteVersions: data.noteVersions,
    tasks: data.tasks,
  };
  const snapshotHash = sha256(stableJson({
    source,
    notebooks: data.notebooks.map((row) => [row.id, entityHash("notebook", row)]),
    notes: data.notes.map((row) => [row.id, entityHash("note", row)]),
    tags: data.tags.map((row) => [row.id, entityHash("tag", row)]),
    tasks: data.tasks.map((row) => [row.id, entityHash("task", row)]),
  }));
  return { ...core, snapshotHash };
}

function validatePayload(value: unknown): MigrationPayload {
  const payload = value as MigrationPayload;
  if (!payload || payload.schemaVersion !== 3 || !payload.source?.instanceId || !payload.source?.userId) {
    throw new Error("迁移数据格式不受支持");
  }
  for (const key of ["notebooks", "notes", "tags", "noteTags", "noteVersions", "tasks"] as const) {
    if (!Array.isArray(payload[key]) || payload[key].length > MAX_SOURCE_ITEMS) {
      throw new Error(`${key} 数据数量非法或超过限制`);
    }
  }
  const expected = sha256(stableJson({
    source: payload.source,
    notebooks: payload.notebooks.map((row) => [row.id, entityHash("notebook", row)]),
    notes: payload.notes.map((row) => [row.id, entityHash("note", row)]),
    tags: payload.tags.map((row) => [row.id, entityHash("tag", row)]),
    tasks: payload.tasks.map((row) => [row.id, entityHash("task", row)]),
  }));
  if (payload.snapshotHash !== expected) throw new Error("迁移快照校验失败");
  return payload;
}

function getTrackedItem(
  targetUserId: string,
  source: MigrationSource,
  entityType: string,
  sourceId: string,
): MigrationItemRow | undefined {
  return getDb()
    .prepare(
      `SELECT targetId, sourceHash, migrationId FROM user_migration_items
       WHERE targetUserId = ? AND sourceInstanceId = ? AND sourceUserId = ?
       AND entityType = ? AND sourceId = ?`,
    )
    .get(targetUserId, source.instanceId, source.userId, entityType, sourceId) as MigrationItemRow | undefined;
}

function saveTrackedItem(args: {
  targetUserId: string;
  source: MigrationSource;
  entityType: string;
  sourceId: string;
  sourceHash: string;
  targetId: string;
  migrationId: string;
  size?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO user_migration_items
       (targetUserId, sourceInstanceId, sourceUserId, entityType, sourceId, sourceHash, targetId, migrationId, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(targetUserId, sourceInstanceId, sourceUserId, entityType, sourceId)
       DO UPDATE SET sourceHash = excluded.sourceHash, targetId = excluded.targetId,
         migrationId = excluded.migrationId, size = excluded.size, status = 'imported',
         updatedAt = datetime('now')`,
    )
    .run(
      args.targetUserId,
      args.source.instanceId,
      args.source.userId,
      args.entityType,
      args.sourceId,
      args.sourceHash,
      args.targetId,
      args.migrationId,
      args.size ?? null,
    );
}

function targetExists(table: string, id: string, userId: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ? AND userId = ?`).get(id, userId));
}

function uniqueLabel(base: string, table: "notebooks" | "notes" | "tasks", userId: string, parentId?: string | null): string {
  const db = getDb();
  const normalized = (base || "未命名").trim();
  let candidate = normalized;
  for (let index = 0; index < 1000; index++) {
    const row = table === "notebooks"
      ? db.prepare("SELECT 1 FROM notebooks WHERE userId = ? AND workspaceId IS NULL AND COALESCE(parentId, '') = COALESCE(?, '') AND name = ?")
          .get(userId, parentId ?? null, candidate)
      : table === "notes"
        ? db.prepare("SELECT 1 FROM notes WHERE userId = ? AND workspaceId IS NULL AND title = ?").get(userId, candidate)
        : db.prepare("SELECT 1 FROM tasks WHERE userId = ? AND workspaceId IS NULL AND title = ?").get(userId, candidate);
    if (!row) return candidate;
    candidate = `${normalized}（迁移副本${index ? ` ${index + 1}` : ""}）`;
  }
  return `${normalized}（迁移副本 ${Date.now()}）`;
}

function topological<T extends JsonRecord>(rows: T[], parentField = "parentId"): T[] {
  const remaining = [...rows];
  const known = new Set(rows.map((row) => String(row.id)));
  const emitted = new Set<string>();
  const result: T[] = [];
  while (remaining.length) {
    const before = remaining.length;
    for (let index = remaining.length - 1; index >= 0; index--) {
      const row = remaining[index];
      const parent = row[parentField] ? String(row[parentField]) : "";
      if (!parent || !known.has(parent) || emitted.has(parent)) {
        result.push(row);
        emitted.add(String(row.id));
        remaining.splice(index, 1);
      }
    }
    if (remaining.length === before) {
      result.push(...remaining);
      break;
    }
  }
  return result;
}

router.get("/preflight", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const data = queryPersonalData(userId);
  const payload = buildPayload(userId, data);
  const attachments = await buildAttachmentManifest(data);
  const missing = attachments.filter((item) => item.missing);
  const totalBytes = attachments.reduce((sum, item) => sum + item.size, 0);

  return c.json({
    source: payload.source,
    snapshotHash: payload.snapshotHash,
    generatedAt: new Date().toISOString(),
    counts: {
      notebooks: data.notebooks.length,
      notes: data.notes.length,
      tags: data.tags.length,
      tasks: data.tasks.length,
      noteVersions: data.noteVersions.length,
      attachments: attachments.length,
      missingAttachments: missing.length,
    },
    attachments: {
      total: attachments.length,
      totalBytes,
      missing: missing.map((item) => ({ kind: item.kind, id: item.id, filename: item.filename })),
      manifest: attachments,
    },
    entities: {
      notebooks: data.notebooks.map((row) => ({ id: row.id, parentId: row.parentId, label: row.name, hash: entityHash("notebook", row) })),
      notes: data.notes.map((row) => ({ id: row.id, parentId: row.notebookId, label: row.title, hash: entityHash("note", row) })),
      tags: data.tags.map((row) => ({ id: row.id, label: row.name, hash: entityHash("tag", row) })),
      tasks: data.tasks.map((row) => ({ id: row.id, parentId: row.parentId, label: row.title, hash: entityHash("task", row) })),
    },
  });
});

router.get("/export", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  c.header("Cache-Control", "private, no-store");
  return c.json(buildPayload(userId));
});

router.post("/source-backup", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const data = queryPersonalData(userId);
  const payload = buildPayload(userId, data);
  const manifest = await buildAttachmentManifest(data);
  const totalBytes = manifest.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes > MAX_BACKUP_BYTES) {
    return c.json({ error: "迁移源附件超过 2GB，请先使用完整备份功能手动备份", code: "BACKUP_TOO_LARGE" }, 413);
  }
  if (manifest.some((item) => item.missing)) {
    return c.json({
      error: "源端存在物理文件缺失的附件，已阻止自动迁移备份",
      code: "SOURCE_ATTACHMENT_MISSING",
      missing: manifest.filter((item) => item.missing).map((item) => item.filename),
    }, 409);
  }

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    format: "nowen-user-migration-backup",
    version: 1,
    source: payload.source,
    snapshotHash: payload.snapshotHash,
    createdAt: new Date().toISOString(),
    attachments: manifest,
  }, null, 2));
  zip.file("data.json", JSON.stringify(payload));

  const sourceRows = new Map<string, JsonRecord>();
  for (const row of data.noteAttachments) sourceRows.set(`note:${row.id}`, row);
  for (const row of data.taskAttachments) sourceRows.set(`task:${row.id}`, row);
  for (const item of manifest) {
    const row = sourceRows.get(`${item.kind}:${item.id}`);
    if (!row) continue;
    const buffer = await readAttachmentObject(row.path);
    if (!buffer) continue;
    zip.file(`attachments/${item.kind}/${item.id}-${safeFilename(item.filename)}`, buffer);
  }

  fs.mkdirSync(MIGRATION_BACKUP_DIR, { recursive: true });
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `nowen-user-migration-${payload.source.username}-${stamp}.zip`;
  fs.writeFileSync(path.join(MIGRATION_BACKUP_DIR, filename), archive);
  return c.json({
    success: true,
    filename,
    size: archive.length,
    sha256: sha256(archive),
    snapshotHash: payload.snapshotHash,
    location: MIGRATION_BACKUP_DIR,
  });
});

router.post("/target-preview", async (c) => {
  ensureMigrationTables();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({}));
  const source = body.source as MigrationSource | undefined;
  const entities = body.entities as Record<string, Array<{ id: string; label?: string; hash: string }>> | undefined;
  if (!source?.instanceId || !source.userId || !entities) {
    return c.json({ error: "缺少源实例预检信息" }, 400);
  }
  if (source.instanceId === resolveInstanceId() && source.userId === userId) {
    return c.json({ error: "源实例和目标实例相同，无需迁移", code: "SAME_INSTANCE" }, 409);
  }

  const summary: Record<string, { total: number; alreadyImported: number; changed: number; newItems: number }> = {};
  const samples: Array<{ entityType: string; label: string; state: string }> = [];
  for (const [entityType, rows] of Object.entries(entities)) {
    let alreadyImported = 0;
    let changed = 0;
    let newItems = 0;
    for (const row of rows || []) {
      const tracked = getTrackedItem(userId, source, entityType.replace(/s$/, ""), String(row.id));
      if (!tracked) {
        newItems++;
      } else if (tracked.sourceHash === row.hash) {
        alreadyImported++;
        if (samples.length < 20) samples.push({ entityType, label: row.label || row.id, state: "already-imported" });
      } else {
        changed++;
        if (samples.length < 20) samples.push({ entityType, label: row.label || row.id, state: "source-changed" });
      }
    }
    summary[entityType] = { total: rows.length, alreadyImported, changed, newItems };
  }
  return c.json({
    target: { instanceId: resolveInstanceId(), userId },
    summary,
    samples,
    strategies: {
      skip: "跳过已迁移项目；源端有更新时保留目标旧副本",
      replace: "只更新由历史迁移创建并仍可追踪的副本，不覆盖目标端原生内容",
      "keep-both": "源端内容变化时新增迁移副本，目标原内容继续保留",
    },
  });
});

router.post("/import", async (c) => {
  ensureMigrationTables();
  const targetUserId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({}));
  const strategy = normalizeStrategy(body.strategy);
  const migrationId = typeof body.migrationId === "string" && body.migrationId ? body.migrationId : uuid();
  if (!strategy) return c.json({ error: "冲突策略无效" }, 400);

  let payload: MigrationPayload;
  try {
    payload = validatePayload(body.payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error), code: "INVALID_PAYLOAD" }, 400);
  }
  if (payload.source.instanceId === resolveInstanceId() && payload.source.userId === targetUserId) {
    return c.json({ error: "源实例和目标实例相同，无需迁移", code: "SAME_INSTANCE" }, 409);
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO user_migration_runs
     (id, targetUserId, sourceInstanceId, sourceUserId, sourceSnapshotHash, strategy, status)
     VALUES (?, ?, ?, ?, ?, ?, 'running')
     ON CONFLICT(id) DO UPDATE SET strategy = excluded.strategy, status = 'running',
       error = NULL, updatedAt = datetime('now')`,
  ).run(
    migrationId,
    targetUserId,
    payload.source.instanceId,
    payload.source.userId,
    payload.snapshotHash,
    strategy,
  );

  const idMap = {
    notebooks: {} as Record<string, string>,
    notes: {} as Record<string, string>,
    tags: {} as Record<string, string>,
    tasks: {} as Record<string, string>,
  };
  const stats = { created: 0, reused: 0, updated: 0, keptBoth: 0, skippedChanged: 0 };

  function importEntity(args: {
    entityType: "tag" | "notebook" | "note" | "task";
    table: "tags" | "notebooks" | "notes" | "tasks";
    sourceRow: JsonRecord;
    preparedRow: JsonRecord;
    exactId?: string | null;
  }): string {
    const sourceId = String(args.sourceRow.id);
    const sourceHash = entityHash(args.entityType, args.sourceRow);
    const tracked = getTrackedItem(targetUserId, payload.source, args.entityType, sourceId);

    if (tracked && targetExists(args.table, tracked.targetId, targetUserId)) {
      if (tracked.sourceHash === sourceHash) {
        stats.reused++;
        return tracked.targetId;
      }
      if (strategy === "skip") {
        stats.skippedChanged++;
        return tracked.targetId;
      }
      if (strategy === "replace") {
        if (!updateDynamic(args.table, tracked.targetId, targetUserId, args.preparedRow)) {
          throw new Error(`无法更新已迁移的 ${args.entityType} ${sourceId}`);
        }
        saveTrackedItem({
          targetUserId,
          source: payload.source,
          entityType: args.entityType,
          sourceId,
          sourceHash,
          targetId: tracked.targetId,
          migrationId,
        });
        stats.updated++;
        return tracked.targetId;
      }
      stats.keptBoth++;
    } else if (args.exactId && targetExists(args.table, args.exactId, targetUserId)) {
      saveTrackedItem({
        targetUserId,
        source: payload.source,
        entityType: args.entityType,
        sourceId,
        sourceHash,
        targetId: args.exactId,
        migrationId,
      });
      stats.reused++;
      return args.exactId;
    }

    const targetId = uuid();
    insertDynamic(args.table, { ...args.preparedRow, id: targetId, userId: targetUserId, workspaceId: null });
    saveTrackedItem({
      targetUserId,
      source: payload.source,
      entityType: args.entityType,
      sourceId,
      sourceHash,
      targetId,
      migrationId,
    });
    stats.created++;
    return targetId;
  }

  try {
    const tx = db.transaction(() => {
      for (const tag of payload.tags) {
        const existing = db.prepare("SELECT id FROM tags WHERE userId = ? AND name = ?").get(targetUserId, tag.name) as
          | { id: string }
          | undefined;
        idMap.tags[tag.id] = importEntity({
          entityType: "tag",
          table: "tags",
          sourceRow: tag,
          preparedRow: { ...tag, id: undefined, userId: targetUserId },
          exactId: existing?.id,
        });
      }

      for (const notebook of topological(payload.notebooks)) {
        const parentId = notebook.parentId ? idMap.notebooks[notebook.parentId] || null : null;
        const existing = db.prepare(
          "SELECT id FROM notebooks WHERE userId = ? AND workspaceId IS NULL AND COALESCE(parentId, '') = COALESCE(?, '') AND name = ? AND COALESCE(isDeleted,0)=0",
        ).get(targetUserId, parentId, notebook.name) as { id: string } | undefined;
        const prepared: JsonRecord = { ...notebook, parentId, userId: targetUserId, workspaceId: null };
        if (strategy === "keep-both" && !getTrackedItem(targetUserId, payload.source, "notebook", notebook.id) && existing) {
          prepared.name = uniqueLabel(notebook.name, "notebooks", targetUserId, parentId);
        }
        idMap.notebooks[notebook.id] = importEntity({
          entityType: "notebook",
          table: "notebooks",
          sourceRow: notebook,
          preparedRow: prepared,
          exactId: strategy === "keep-both" ? null : existing?.id,
        });
      }

      for (const note of payload.notes) {
        const notebookId = idMap.notebooks[note.notebookId];
        if (!notebookId) throw new Error(`笔记 ${note.title || note.id} 的笔记本映射缺失`);
        const hash = entityHash("note", note);
        const candidates = db.prepare("SELECT * FROM notes WHERE userId = ? AND workspaceId IS NULL AND title = ?").all(targetUserId, note.title) as JsonRecord[];
        const exact = candidates.find((row) => entityHash("note", { ...row, notebookId: note.notebookId }) === hash);
        const prepared: JsonRecord = { ...note, notebookId, userId: targetUserId, workspaceId: null };
        if (strategy === "keep-both" && !getTrackedItem(targetUserId, payload.source, "note", note.id) && candidates.length) {
          prepared.title = uniqueLabel(note.title, "notes", targetUserId);
        }
        idMap.notes[note.id] = importEntity({
          entityType: "note",
          table: "notes",
          sourceRow: note,
          preparedRow: prepared,
          exactId: strategy === "keep-both" ? null : exact?.id,
        });
      }

      for (const relation of payload.noteTags) {
        const noteId = idMap.notes[relation.noteId];
        const tagId = idMap.tags[relation.tagId];
        if (noteId && tagId) {
          db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(noteId, tagId);
        }
      }

      const newlyCreatedNotes = new Set(
        Object.entries(idMap.notes)
          .filter(([sourceId, targetId]) => {
            const tracked = getTrackedItem(targetUserId, payload.source, "note", sourceId);
            return Boolean(tracked && tracked.migrationId === migrationId && targetId === tracked.targetId);
          })
          .map(([, targetId]) => targetId),
      );
      for (const version of payload.noteVersions) {
        const noteId = idMap.notes[version.noteId];
        if (!noteId || !newlyCreatedNotes.has(noteId)) continue;
        const exists = db.prepare(
          "SELECT 1 FROM note_versions WHERE noteId = ? AND version = ? AND COALESCE(createdAt,'') = COALESCE(?, '')",
        ).get(noteId, version.version, version.createdAt);
        if (exists) continue;
        insertDynamic("note_versions", { ...version, id: uuid(), noteId, userId: targetUserId });
      }

      for (const task of topological(payload.tasks)) {
        const parentId = task.parentId ? idMap.tasks[task.parentId] || null : null;
        const noteId = task.noteId ? idMap.notes[task.noteId] || null : null;
        const candidates = db.prepare(
          "SELECT * FROM tasks WHERE userId = ? AND workspaceId IS NULL AND title = ? AND COALESCE(parentId,'') = COALESCE(?, '')",
        ).all(targetUserId, task.title, parentId) as JsonRecord[];
        const hash = entityHash("task", task);
        const exact = candidates.find((row) => entityHash("task", { ...row, parentId: task.parentId, noteId: task.noteId }) === hash);
        const prepared: JsonRecord = {
          ...task,
          parentId,
          noteId,
          projectId: null,
          workspaceId: null,
          userId: targetUserId,
        };
        if (strategy === "keep-both" && !getTrackedItem(targetUserId, payload.source, "task", task.id) && candidates.length) {
          prepared.title = uniqueLabel(task.title, "tasks", targetUserId);
        }
        idMap.tasks[task.id] = importEntity({
          entityType: "task",
          table: "tasks",
          sourceRow: task,
          preparedRow: prepared,
          exactId: strategy === "keep-both" ? null : exact?.id,
        });
      }
    });
    tx();
  } catch (error) {
    db.prepare("UPDATE user_migration_runs SET status='failed', error=?, updatedAt=datetime('now') WHERE id=? AND targetUserId=?")
      .run(error instanceof Error ? error.message : String(error), migrationId, targetUserId);
    return c.json({ error: error instanceof Error ? error.message : String(error), code: "IMPORT_FAILED", migrationId }, 500);
  }

  return c.json({ success: true, migrationId, idMap, stats });
});

router.get("/attachment/:kind/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const kind = c.req.param("kind") as AttachmentKind;
  const id = c.req.param("id");
  const db = getDb();
  let row: JsonRecord | undefined;
  if (kind === "note") {
    row = db.prepare(
      `SELECT a.id, a.path, a.filename, a.mimeType, a.size
       FROM attachments a JOIN notes n ON n.id = a.noteId
       WHERE a.id = ? AND a.userId = ? AND a.workspaceId IS NULL
       AND n.userId = ? AND n.workspaceId IS NULL`,
    ).get(id, userId, userId) as JsonRecord | undefined;
  } else if (kind === "task") {
    row = db.prepare(
      `SELECT a.id, a.path, a.filename, a.mimeType, a.size
       FROM task_attachments a JOIN tasks t ON t.id = a.taskId
       WHERE a.id = ? AND a.userId = ? AND a.workspaceId IS NULL
       AND t.userId = ? AND t.workspaceId IS NULL`,
    ).get(id, userId, userId) as JsonRecord | undefined;
  } else {
    return c.json({ error: "附件类型无效" }, 400);
  }
  if (!row) return c.json({ error: "附件不存在或无权访问" }, 404);
  const buffer = await readAttachmentObject(row.path);
  if (!buffer) return c.json({ error: "附件物理文件缺失", code: "ATTACHMENT_FILE_MISSING" }, 404);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      "Content-Length": String(buffer.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename || `${id}.bin`)}`,
      "Cache-Control": "private, no-store",
      "X-Content-SHA256": sha256(buffer),
    },
  });
});

router.post("/attachment/import", async (c) => {
  ensureMigrationTables();
  const targetUserId = c.req.header("X-User-Id") || "";
  const form = await c.req.parseBody().catch(() => ({} as Record<string, any>));
  const file = form.file;
  const migrationId = String(form.migrationId || "");
  const sourceInstanceId = String(form.sourceInstanceId || "");
  const sourceUserId = String(form.sourceUserId || "");
  const sourceAttachmentId = String(form.sourceAttachmentId || "");
  const sourceHash = String(form.sourceHash || "").toLowerCase();
  const kind = String(form.kind || "") as AttachmentKind;
  const targetParentId = String(form.targetParentId || "");
  if (!(file instanceof File) || !migrationId || !sourceInstanceId || !sourceUserId || !sourceAttachmentId || !sourceHash || !targetParentId) {
    return c.json({ error: "附件迁移参数不完整" }, 400);
  }
  if (kind !== "note" && kind !== "task") return c.json({ error: "附件类型无效" }, 400);

  const run = getDb().prepare(
    `SELECT id FROM user_migration_runs WHERE id = ? AND targetUserId = ?
     AND sourceInstanceId = ? AND sourceUserId = ?`,
  ).get(migrationId, targetUserId, sourceInstanceId, sourceUserId);
  if (!run) return c.json({ error: "迁移任务不存在或不属于当前用户" }, 404);

  const source: MigrationSource = { instanceId: sourceInstanceId, userId: sourceUserId, username: "" };
  const entityType = `${kind}-attachment`;
  const tracked = getTrackedItem(targetUserId, source, entityType, sourceAttachmentId);
  const table = kind === "note" ? "attachments" : "task_attachments";
  if (tracked && tracked.sourceHash === sourceHash && targetExists(table, tracked.targetId, targetUserId)) {
    return c.json({
      success: true,
      reused: true,
      id: tracked.targetId,
      url: kind === "note" ? `/api/attachments/${tracked.targetId}` : `/api/task-attachments/${tracked.targetId}`,
      hash: sourceHash,
      size: Number(file.size || 0),
    });
  }

  const db = getDb();
  if (kind === "note") {
    const parent = db.prepare("SELECT 1 FROM notes WHERE id = ? AND userId = ? AND workspaceId IS NULL").get(targetParentId, targetUserId);
    if (!parent) return c.json({ error: "目标笔记不存在" }, 404);
  } else {
    const parent = db.prepare("SELECT 1 FROM tasks WHERE id = ? AND userId = ? AND workspaceId IS NULL").get(targetParentId, targetUserId);
    if (!parent) return c.json({ error: "目标任务不存在" }, 404);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const actualHash = sha256(buffer);
  if (actualHash !== sourceHash) {
    return c.json({ error: "附件 SHA-256 校验失败", code: "ATTACHMENT_HASH_MISMATCH", expected: sourceHash, actual: actualHash }, 409);
  }

  const id = uuid();
  const filename = safeFilename(file.name || `${id}.bin`);
  const mimeType = (file.type || "application/octet-stream").toLowerCase();
  const storagePath = `${getUploadMonthPath()}/${id}.${extensionFor(filename, mimeType)}`;
  try {
    await writeAttachmentObject(storagePath, buffer, mimeType);
    if (kind === "note") {
      db.prepare(
        `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(id, targetParentId, targetUserId, filename, mimeType, buffer.length, storagePath, actualHash, "instance-migration");
    } else {
      db.prepare(
        `INSERT INTO task_attachments (id, taskId, userId, workspaceId, filename, mimeType, size, path)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(id, targetParentId, targetUserId, filename, mimeType, buffer.length, storagePath);
    }
    saveTrackedItem({
      targetUserId,
      source,
      entityType,
      sourceId: sourceAttachmentId,
      sourceHash,
      targetId: id,
      migrationId,
      size: buffer.length,
    });
    db.prepare(
      `UPDATE user_migration_runs SET importedAttachments =
       (SELECT COUNT(*) FROM user_migration_items WHERE migrationId = ? AND entityType IN ('note-attachment','task-attachment')),
       updatedAt = datetime('now') WHERE id = ?`,
    ).run(migrationId, migrationId);
  } catch (error) {
    try { await deleteAttachmentObject(storagePath); } catch { /* best effort */ }
    return c.json({ error: error instanceof Error ? error.message : String(error), code: "ATTACHMENT_IMPORT_FAILED" }, 500);
  }

  return c.json({
    success: true,
    reused: false,
    id,
    url: kind === "note" ? `/api/attachments/${id}` : `/api/task-attachments/${id}`,
    hash: actualHash,
    size: buffer.length,
  }, 201);
});

router.post("/rewrite", async (c) => {
  const targetUserId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({}));
  const noteMap = (body.noteAttachments || {}) as Record<string, string>;
  const taskMap = (body.taskAttachments || {}) as Record<string, string>;
  const noteIds = Array.isArray(body.noteIds) ? body.noteIds.map(String) : [];
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.map(String) : [];
  let notesRewritten = 0;
  let tasksRewritten = 0;
  const db = getDb();

  const tx = db.transaction(() => {
    for (const noteId of noteIds) {
      const row = db.prepare("SELECT content FROM notes WHERE id = ? AND userId = ?").get(noteId, targetUserId) as
        | { content: string }
        | undefined;
      if (!row) continue;
      let content = row.content || "";
      for (const [oldId, newId] of Object.entries(noteMap)) {
        content = content.split(`/api/attachments/${oldId}`).join(`/api/attachments/${newId}`);
      }
      if (content !== (row.content || "")) {
        db.prepare("UPDATE notes SET content = ?, updatedAt = datetime('now') WHERE id = ? AND userId = ?")
          .run(content, noteId, targetUserId);
        try { syncReferences(db, noteId, content); } catch { /* index repair is best effort */ }
        notesRewritten++;
      }
    }
    for (const taskId of taskIds) {
      const row = db.prepare("SELECT title, description FROM tasks WHERE id = ? AND userId = ?").get(taskId, targetUserId) as
        | { title: string; description: string | null }
        | undefined;
      if (!row) continue;
      let title = row.title || "";
      let description = row.description || "";
      for (const [oldId, newId] of Object.entries(taskMap)) {
        title = title.split(`/api/task-attachments/${oldId}`).join(`/api/task-attachments/${newId}`);
        description = description.split(`/api/task-attachments/${oldId}`).join(`/api/task-attachments/${newId}`);
      }
      if (title !== row.title || description !== (row.description || "")) {
        db.prepare("UPDATE tasks SET title = ?, description = ?, updatedAt = datetime('now') WHERE id = ? AND userId = ?")
          .run(title, description, taskId, targetUserId);
        tasksRewritten++;
      }
    }
  });
  tx();
  return c.json({ success: true, notesRewritten, tasksRewritten });
});

router.post("/complete", async (c) => {
  ensureMigrationTables();
  const targetUserId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({}));
  const migrationId = String(body.migrationId || "");
  const expected = Array.isArray(body.attachments) ? body.attachments as AttachmentManifestItem[] : [];
  const mismatches: Array<{ kind: string; id: string; reason: string }> = [];
  let verifiedBytes = 0;
  const db = getDb();

  for (const item of expected) {
    const entityType = `${item.kind}-attachment`;
    const tracked = db.prepare(
      `SELECT targetId, sourceHash, size FROM user_migration_items
       WHERE migrationId = ? AND targetUserId = ? AND entityType = ? AND sourceId = ?`,
    ).get(migrationId, targetUserId, entityType, item.id) as
      | { targetId: string; sourceHash: string; size: number | null }
      | undefined;
    if (!tracked) {
      mismatches.push({ kind: item.kind, id: item.id, reason: "missing-ledger" });
      continue;
    }
    const row = item.kind === "note"
      ? db.prepare("SELECT path, size FROM attachments WHERE id = ? AND userId = ?").get(tracked.targetId, targetUserId)
      : db.prepare("SELECT path, size FROM task_attachments WHERE id = ? AND userId = ?").get(tracked.targetId, targetUserId);
    if (!row) {
      mismatches.push({ kind: item.kind, id: item.id, reason: "missing-target-row" });
      continue;
    }
    const record = row as { path: string; size: number };
    const buffer = await readAttachmentObject(record.path);
    if (!buffer) {
      mismatches.push({ kind: item.kind, id: item.id, reason: "missing-target-file" });
      continue;
    }
    if (buffer.length !== item.size || sha256(buffer) !== item.hash || tracked.sourceHash !== item.hash) {
      mismatches.push({ kind: item.kind, id: item.id, reason: "hash-or-size-mismatch" });
      continue;
    }
    verifiedBytes += buffer.length;
  }

  if (mismatches.length) {
    db.prepare("UPDATE user_migration_runs SET status='verification-failed', error=?, updatedAt=datetime('now') WHERE id=? AND targetUserId=?")
      .run(JSON.stringify(mismatches.slice(0, 50)), migrationId, targetUserId);
    return c.json({ error: "迁移附件完整性校验失败", code: "MIGRATION_VERIFY_FAILED", mismatches }, 409);
  }

  db.prepare(
    `UPDATE user_migration_runs SET status='completed', expectedAttachments=?, importedAttachments=?,
     completedAt=datetime('now'), updatedAt=datetime('now'), error=NULL
     WHERE id=? AND targetUserId=?`,
  ).run(expected.length, expected.length, migrationId, targetUserId);
  return c.json({ success: true, migrationId, verifiedAttachments: expected.length, verifiedBytes });
});

router.get("/runs/:migrationId", (c) => {
  ensureMigrationTables();
  const userId = c.req.header("X-User-Id") || "";
  const migrationId = c.req.param("migrationId");
  const run = getDb().prepare("SELECT * FROM user_migration_runs WHERE id = ? AND targetUserId = ?").get(migrationId, userId);
  if (!run) return c.json({ error: "迁移记录不存在" }, 404);
  const items = getDb().prepare(
    "SELECT entityType, sourceId, sourceHash, targetId, size, status FROM user_migration_items WHERE migrationId = ? AND targetUserId = ?",
  ).all(migrationId, userId);
  return c.json({ run, items });
});

router.post("/rollback", async (c) => {
  ensureMigrationTables();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({}));
  const migrationId = String(body.migrationId || "");
  const db = getDb();
  const run = db.prepare("SELECT id FROM user_migration_runs WHERE id = ? AND targetUserId = ?").get(migrationId, userId);
  if (!run) return c.json({ error: "迁移记录不存在" }, 404);
  const items = db.prepare(
    "SELECT entityType, targetId FROM user_migration_items WHERE migrationId = ? AND targetUserId = ? ORDER BY createdAt DESC",
  ).all(migrationId, userId) as Array<{ entityType: string; targetId: string }>;
  const removed: Record<string, number> = {};

  for (const item of items.filter((row) => row.entityType.endsWith("-attachment"))) {
    const table = item.entityType === "note-attachment" ? "attachments" : "task_attachments";
    const row = db.prepare(`SELECT path FROM ${table} WHERE id = ? AND userId = ?`).get(item.targetId, userId) as
      | { path: string }
      | undefined;
    if (row?.path) {
      try { await deleteAttachmentObject(row.path); } catch { /* best effort */ }
    }
    const result = db.prepare(`DELETE FROM ${table} WHERE id = ? AND userId = ?`).run(item.targetId, userId);
    removed[item.entityType] = (removed[item.entityType] || 0) + result.changes;
  }

  const tx = db.transaction(() => {
    for (const [entityType, table] of [
      ["task", "tasks"],
      ["note", "notes"],
      ["notebook", "notebooks"],
      ["tag", "tags"],
    ] as const) {
      for (const item of items.filter((row) => row.entityType === entityType)) {
        const result = db.prepare(`DELETE FROM ${table} WHERE id = ? AND userId = ?`).run(item.targetId, userId);
        removed[entityType] = (removed[entityType] || 0) + result.changes;
      }
    }
    db.prepare("DELETE FROM user_migration_items WHERE migrationId = ? AND targetUserId = ?").run(migrationId, userId);
    db.prepare("UPDATE user_migration_runs SET status='rolled-back', updatedAt=datetime('now') WHERE id=? AND targetUserId=?")
      .run(migrationId, userId);
  });
  tx();
  return c.json({ success: true, removed });
});

export default router;
