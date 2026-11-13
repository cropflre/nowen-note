import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type Database from "better-sqlite3";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotebookPermission, getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl.js";
import { createKnowledgeChild, deleteKnowledgeNode } from "./knowledgeTree.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import { syncNoteBlocks } from "../lib/noteBlocks.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import { syncReferences } from "../lib/attachmentRefs.js";
import { rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore.js";
import { rebuildYjsSubdocumentsIfEnabled } from "./yjs-subdocuments.js";
import { extractSearchableText } from "../lib/searchIndex.js";
import { sanitizeForImport } from "../lib/sanitizeHtml.js";
import { writeAttachmentObjectFromFile, deleteAttachmentObject, probeAttachmentStorage, readAttachmentRange, getAttachmentStorageInfo, ensureAttachmentsDir } from "./attachment-storage.js";
import { notifySyncChanged } from "../sync/notify.js";
import { broadcastToUser } from "./realtime.js";
import { logAudit } from "./audit.js";
import { yFlush, yDestroyDoc } from "./yjs.js";
import { MIGRATION_LIMITS, migrationSourceSchema, nmfNoteSchema, type NmfNote } from "./migrationFormat.js";
import { migrationDirectoryBytes, sniffMigrationAsset, MigrationSourceError } from "./migrationSourceAdapter.js";

export type MigrationActor = { userId: string; tokenId?: string | null };
export type MigrationStatus = "CREATED" | "UPLOADING" | "SCANNING" | "NORMALIZING" | "PREVIEW_READY" | "APPROVED" | "IMPORTING" | "VERIFYING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" | "PAUSED" | "UNDONE";
type Source = { platform: string; exportId: string };
type JobRow = {
  id: string; userId: string; operationId: string; requestHash: string; tokenId: string | null;
  workspaceId: string | null; targetNotebookId: string | null; name: string; sourceJson: string;
  status: MigrationStatus; previewDigest: string | null; previewExpiresAt: string | null;
  approvedBySession: string | null; rootNotebookId: string | null; warningsJson: string;
  error: string | null; createdAt: string; updatedAt: string;
};
type ItemRow = {
  id: string; jobId: string; sourceKey: string; contentHash: string; payloadHash: string;
  metadataJson: string; contentPath: string; status: string; action: string;
  targetNoteId: string | null; error: string | null; warningsJson: string;
  decision: "auto" | "skip" | "keep-existing" | "create-copy";
};
type Metadata = Omit<NmfNote, "content"> & { contentBytes: number };
type UploadRow = { id: string; jobId: string; filename: string; path: string; status: string };
export class MigrationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export const createMigrationSchema = z.object({
  operationId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  source: migrationSourceSchema,
  name: z.string().trim().min(1).max(200).default("迁移的笔记"),
  workspaceId: z.string().max(128).nullable().optional().transform((value) => value === "personal" ? null : value),
  targetNotebookId: z.string().max(128).nullable().optional(),
}).strict();
const terminal = new Set<MigrationStatus>(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "UNDONE"]);
const runnable = new Set<MigrationStatus>(["APPROVED", "IMPORTING", "VERIFYING", "SCANNING", "NORMALIZING"]);
const rootDir = () => path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "migration-staging");
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const stagingBytes = new Map<string, number>();
function parse<T>(value: string): T { return JSON.parse(value) as T; }
// Thousands of short-lived native SQLite statements otherwise outlive their tiny JS wrappers.
const queryCache = new WeakMap<Database.Database, Map<string, Database.Statement<unknown[]>>>();
function prepare(sql: string) {
  const connection = getDb();
  let cache = queryCache.get(connection);
  if (!cache) { cache = new Map(); queryCache.set(connection, cache); }
  let statement = cache.get(sql);
  if (!statement) { statement = connection.prepare<unknown[]>(sql); cache.set(sql, statement); }
  return statement;
}
export function migrationJobDirectory(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new MigrationError("MIGRATION_NOT_FOUND", "迁移任务不存在", 404);
  return path.join(rootDir(), id);
}
function fileFor(job: JobRow, relative: string): string {
  if (!relative || relative.includes("\\") || relative.includes("\0") || path.posix.isAbsolute(relative)
    || relative.split("/").some((part) => part === "." || part === ".." || !part)) {
    throw new MigrationError("MIGRATION_ASSET_PATH", "迁移文件路径无效");
  }
  const filename = path.join(migrationJobDirectory(job.id), relative);
  const root = fs.realpathSync(migrationJobDirectory(job.id));
  const resolved = fs.realpathSync(filename);
  if (!resolved.startsWith(root + path.sep) || !fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) {
    throw new MigrationError("MIGRATION_ASSET_PATH", "迁移文件路径无效");
  }
  return filename;
}
function readJob(id: string): JobRow {
  const job = prepare("SELECT * FROM migration_jobs WHERE id = ?").get(id) as JobRow | undefined;
  if (!job) throw new MigrationError("MIGRATION_NOT_FOUND", "迁移任务不存在", 404);
  return job;
}
function tokenAccess(tokenId: string, userId: string, targetId: string | null, write: boolean): void {
  const db = getDb();
  const token = prepare("SELECT userId, scopes, resourceMode, revokedAt, expiresAt FROM api_tokens WHERE id = ?").get(tokenId) as
    { userId: string; scopes: string; resourceMode: string; revokedAt: string | null; expiresAt: string | null } | undefined;
  if (!token || token.userId !== userId || token.revokedAt || (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())) {
    throw new MigrationError("MIGRATION_TOKEN_REVOKED", "迁移授权已过期或被撤销", 403);
  }
  const scopes = new Set(parse<string[]>(token.scopes));
  for (const scope of write ? ["export:import", "notes:write", "notebooks:write"] : ["export:import", "notes:read"]) {
    if (!scopes.has(scope)) throw new MigrationError("API_TOKEN_SCOPE_REQUIRED", `迁移需要 ${scope} 权限`, 403);
  }
  if (token.resourceMode === "restricted") {
    if (!targetId) throw new MigrationError("API_TOKEN_RESOURCE_DENIED", "请将迁移目标设为 Token 已授权的笔记本", 403);
    const grant = prepare(`WITH RECURSIVE scope(id, permission, recurse) AS (
      SELECT resourceId, permission, includeDescendants FROM api_token_resources WHERE tokenId = ? AND resourceType = 'notebook'
      UNION SELECT n.id, s.permission, s.recurse FROM notebooks n JOIN scope s ON n.parentId = s.id WHERE s.recurse = 1 AND n.isDeleted = 0
    ) SELECT 1 FROM scope WHERE id = ? AND (? = 0 OR (permission = 'write' AND recurse = 1)) LIMIT 1`).get(tokenId, targetId, write ? 1 : 0);
    if (!grant) throw new MigrationError("API_TOKEN_RESOURCE_DENIED", "Token 无权访问迁移目标笔记本", 403);
  }
}
function checkAccess(actor: MigrationActor, job: JobRow, write = false): void {
  if (!actor.userId) throw new MigrationError("UNAUTHENTICATED", "请先登录", 401);
  if (job.userId !== actor.userId) throw new MigrationError("MIGRATION_NOT_FOUND", "迁移任务不存在", 404);
  const db = getDb();
  const user = prepare("SELECT isDisabled, personalImportEnabled FROM users WHERE id = ?").get(actor.userId) as
    { isDisabled: number; personalImportEnabled: number } | undefined;
  if (!user || user.isDisabled) throw new MigrationError("MIGRATION_FORBIDDEN", "账号不可用", 403);
  if (write && !job.workspaceId && user.personalImportEnabled === 0 && !isSystemAdmin(actor.userId)) {
    throw new MigrationError("FEATURE_DISABLED", "管理员已禁用个人空间导入", 403);
  }
  if (job.workspaceId && !hasRole(getUserWorkspaceRole(job.workspaceId, actor.userId), write ? "editor" : "viewer")) {
    throw new MigrationError("WORKSPACE_FORBIDDEN", "无权访问迁移目标工作区", 403);
  }
  if (job.targetNotebookId) {
    const notebook = prepare("SELECT userId, workspaceId, isDeleted FROM notebooks WHERE id = ?").get(job.targetNotebookId) as
      { userId: string; workspaceId: string | null; isDeleted: number } | undefined;
    if (!notebook || notebook.isDeleted || notebook.workspaceId !== job.workspaceId
      || (!job.workspaceId && notebook.userId !== actor.userId)
      || !hasPermission(resolveNotebookPermission(job.targetNotebookId, actor.userId).permission, write ? "write" : "read")) {
      throw new MigrationError("MIGRATION_TARGET_FORBIDDEN", "迁移目标不存在或当前没有权限", 403);
    }
    if (write && !resolveKnowledgeNodeAccess(`notebook:${job.targetNotebookId}`, actor.userId, db).capabilities.canCreate) {
      throw new MigrationError("MIGRATION_TARGET_FORBIDDEN", "不能在此笔记本创建迁移目录", 403);
    }
  }
  if (actor.tokenId) tokenAccess(actor.tokenId, actor.userId, job.targetNotebookId, write);
}
function owned(actor: MigrationActor, id: string, write = false): JobRow {
  const job = readJob(id); checkAccess(actor, job, write); return job;
}
/** Upload transports share the same live caller/creator token and target ACL checks. */
export function assertMigrationUploadAccess(actor: MigrationActor, id: string, states: MigrationStatus[], attachments = false): void {
  const job = owned(actor, id, true);
  assertState(job, states);
  requireExtraScopes(job, { attachments: attachments ? [{}] as Metadata["attachments"] : [], tags: [] }, actor);
}
function assertState(job: JobRow, states: MigrationStatus[]): void {
  if (!states.includes(job.status)) throw new MigrationError("MIGRATION_STATE_CONFLICT", "任务状态已变化，请刷新后重试", 409);
}
function status(id: string, next: MigrationStatus, expected: MigrationStatus[]): void {
  const changed = prepare(`UPDATE migration_jobs SET status = ?, updatedAt = datetime('now') WHERE id = ? AND status IN (${expected.map(() => "?").join(",")})`)
    .run(next, id, ...expected);
  if (changed.changes !== 1) throw new MigrationError("MIGRATION_STATE_CONFLICT", "任务状态已变化，请刷新后重试", 409);
}
function warnings(job: JobRow, values: string[]): void {
  const merged = [...new Set([...parse<string[]>(job.warningsJson), ...values])].slice(0, 100);
  prepare("UPDATE migration_jobs SET warningsJson = ? WHERE id = ?").run(JSON.stringify(merged), job.id);
}
export function migrationSnapshot(job: JobRow) {
  const db = getDb();
  const counts = prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN action = 'create' THEN 1 ELSE 0 END) AS 'create',
    SUM(CASE WHEN action = 'existing' THEN 1 ELSE 0 END) AS existing,
    SUM(CASE WHEN action = 'skip' THEN 1 ELSE 0 END) AS skipped,
    SUM(CASE WHEN status = 'ATTENTION' THEN 1 ELSE 0 END) AS needsAttention,
    SUM(CASE WHEN status = 'IMPORTED' THEN 1 ELSE 0 END) AS imported,
    SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
    SUM(json_array_length(metadataJson, '$.attachments')) AS attachments,
    SUM(json_extract(metadataJson, '$.contentBytes')) AS bytes
    FROM migration_items WHERE jobId = ?`).get(job.id) as Record<string, number | null>;
  for (const key of Object.keys(counts)) counts[key] = Number(counts[key] || 0);
  counts.bytes = Number(counts.bytes) + Number((prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM migration_assets WHERE jobId = ?").get(job.id) as { bytes: number }).bytes);
  return {
    id: job.id, status: job.status, source: parse<Source>(job.sourceJson), name: job.name,
    workspaceId: job.workspaceId, targetNotebookId: job.targetNotebookId, counts,
    previewDigest: job.previewDigest, warnings: parse<string[]>(job.warningsJson),
    rootNotebookId: job.rootNotebookId,
    createdAt: new Date(job.createdAt.replace(" ", "T") + (job.createdAt.includes("T") ? "" : "Z")).toISOString(),
    updatedAt: new Date(job.updatedAt.replace(" ", "T") + (job.updatedAt.includes("T") ? "" : "Z")).toISOString(), error: job.error,
    undo: { available: Boolean(job.rootNotebookId && ["COMPLETED", "PARTIAL", "CANCELLED", "FAILED"].includes(job.status)), reason: job.status === "UNDONE" ? "本次导入已经撤销" : null },
  };
}
export function getMigration(actor: MigrationActor, id: string) { return migrationSnapshot(owned(actor, id)); }
export function listMigrations(actor: MigrationActor) {
  if (!actor.userId) throw new MigrationError("UNAUTHENTICATED", "请先登录", 401);
  const rows = prepare("SELECT * FROM migration_jobs WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT 100").all(actor.userId) as JobRow[];
  return rows.filter((job) => { try { checkAccess(actor, job); return true; } catch { return false; } }).map(migrationSnapshot);
}
export function createMigration(actor: MigrationActor, input: unknown) {
  cleanupMigrationStaging();
  const value = createMigrationSchema.parse(input);
  const requestHash = hash(JSON.stringify(value));
  const db = getDb();
  const existing = prepare("SELECT * FROM migration_jobs WHERE userId = ? AND operationId = ?").get(actor.userId, value.operationId) as JobRow | undefined;
  if (existing) {
    checkAccess(actor, existing, true);
    if (existing.requestHash !== requestHash) throw new MigrationError("MIGRATION_OPERATION_CONFLICT", "operationId 已用于不同的迁移请求", 409);
    return migrationSnapshot(existing);
  }
  const job: JobRow = { ...value, id: crypto.randomUUID(), userId: actor.userId, tokenId: actor.tokenId || null,
    sourceJson: JSON.stringify(value.source), workspaceId: value.workspaceId || null, targetNotebookId: value.targetNotebookId || null,
    requestHash, status: "CREATED", previewDigest: null, previewExpiresAt: null, approvedBySession: null,
    rootNotebookId: null, warningsJson: "[]", error: null, createdAt: "", updatedAt: "" };
  checkAccess(actor, job, true);
  const active = (prepare("SELECT COUNT(*) AS count FROM migration_jobs WHERE userId = ? AND status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED','UNDONE')").get(actor.userId) as { count: number }).count;
  if (active >= 3) throw new MigrationError("MIGRATION_ACTIVE_LIMIT", "最多同时准备三个迁移任务，请先完成或取消现有任务", 429);
  prepare("INSERT INTO migration_jobs (id,userId,operationId,requestHash,tokenId,workspaceId,targetNotebookId,name,sourceJson) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(job.id, job.userId, value.operationId, requestHash, job.tokenId, job.workspaceId, job.targetNotebookId, value.name, job.sourceJson);
  fs.mkdirSync(path.join(migrationJobDirectory(job.id), "contents"), { recursive: true, mode: 0o700 });
  return migrationSnapshot(readJob(job.id));
}

export function registerMigrationAsset(actor: MigrationActor, id: string, relative: string, sha256: string, size: number): void {
  const job = owned(actor, id, true);
  assertState(job, ["CREATED", "UPLOADING", "SCANNING", "NORMALIZING"]);
  requireExtraScopes(job, { attachments: [{}] as Metadata["attachments"], tags: [] }, actor);
  const filename = fileFor(job, relative);
  if (!/^[a-f0-9]{64}$/.test(sha256) || fs.statSync(filename).size !== size) throw new MigrationError("MIGRATION_ASSET_INVALID", "附件校验失败");
  const previous = prepare("SELECT sha256 FROM migration_assets WHERE jobId = ? AND path = ?").get(id, relative) as { sha256: string } | undefined;
  if (previous && previous.sha256 !== sha256) throw new MigrationError("MIGRATION_ASSET_CONFLICT", "同一路径已登记不同的附件", 409);
  prepare("INSERT OR IGNORE INTO migration_assets(jobId,path,sha256,size) VALUES (?,?,?,?)").run(id, relative, sha256, size);
}
async function fileHash(filename: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}
async function stage(actor: MigrationActor, job: JobRow, input: unknown[], fromAdapter = false): Promise<void> {
  checkAccess(actor, job, true);
  assertState(job, fromAdapter ? ["SCANNING", "NORMALIZING"] : ["CREATED"]);
  if (!Array.isArray(input) || input.length < 1 || input.length > 50) throw new MigrationError("MIGRATION_BATCH_LIMIT", "每次请提交 1 至 50 篇笔记");
  const db = getDb();
  for (const raw of input) {
    const note = nmfNoteSchema.parse(raw);
    let source = parse<Source>(job.sourceJson);
    if (fromAdapter && source.platform === "files" && !(prepare("SELECT 1 FROM migration_items WHERE jobId = ? LIMIT 1").get(job.id))) {
      source = { platform: note.source.platform, exportId: note.source.exportId };
      job.sourceJson = JSON.stringify(source);
      prepare("UPDATE migration_jobs SET sourceJson = ? WHERE id = ?").run(job.sourceJson, job.id);
    }
    if (note.source.platform !== source.platform || note.source.exportId !== source.exportId) throw new MigrationError("MIGRATION_SOURCE_MISMATCH", "笔记来源与迁移任务不一致");
    if (note.contentFormat === "html") note.content = sanitizeForImport(note.content);
    requireExtraScopes(job, note, actor);
    if (note.contentFormat === "html" || Object.keys(note.metadata).length) warnings(readJob(job.id), [
      ...(note.contentFormat === "html" ? ["HTML_SANITIZED; 已移除危险脚本与不支持的组件"] : []),
      ...(Object.keys(note.metadata).length ? ["SOURCE_METADATA_REPORTED_ONLY; 特殊属性不写入笔记，未迁移字段名列在报告中"] : []),
    ]);
    for (const attachment of note.attachments) {
      if (fromAdapter) {
        const filename = fileFor(job, attachment.path);
        if (await fileHash(filename) !== attachment.sha256) throw new MigrationError("MIGRATION_HASH_MISMATCH", "附件校验失败");
        registerMigrationAsset(actor, job.id, attachment.path, attachment.sha256, fs.statSync(filename).size);
      }
      const asset = prepare("SELECT sha256 FROM migration_assets WHERE jobId = ? AND path = ?").get(job.id, attachment.path) as { sha256: string } | undefined;
      if (!asset || asset.sha256 !== attachment.sha256) throw new MigrationError("MIGRATION_ASSET_NOT_STAGED", "请先上传并校验笔记引用的附件");
    }
    const sourceKey = hash(JSON.stringify([note.source.platform, note.source.exportId, note.source.sourceId]));
    const contentHash = hash(JSON.stringify([note.contentFormat, note.content]));
    const payloadHash = hash(JSON.stringify(note));
    const previous = prepare("SELECT payloadHash FROM migration_items WHERE jobId = ? AND sourceKey = ?").get(job.id, sourceKey) as { payloadHash: string } | undefined;
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new MigrationError("MIGRATION_ITEM_CONFLICT", "同一来源 ID 已提交不同内容，请新建迁移任务", 409);
      continue;
    }
    const count = (prepare("SELECT COUNT(*) AS count FROM migration_items WHERE jobId = ?").get(job.id) as { count: number }).count;
    if (count >= MIGRATION_LIMITS.notes) throw new MigrationError("MIGRATION_ITEM_LIMIT", "每个任务最多迁移 10,000 篇笔记", 413);
    const stagedBytes = (prepare("SELECT stagedBytes AS bytes FROM migration_jobs WHERE id = ?").get(job.id) as { bytes: number }).bytes;
    const assetBytes = (prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM migration_assets WHERE jobId=?").get(job.id) as { bytes: number }).bytes;
    if (stagedBytes + assetBytes + Buffer.byteLength(JSON.stringify(note)) > MIGRATION_LIMITS.extractedBytes) throw new MigrationError("MIGRATION_STAGING_QUOTA", "迁移暂存数据总量超过容量限制", 413);
    checkAccess(actor, readJob(job.id), true);
    assertState(readJob(job.id), fromAdapter ? ["SCANNING", "NORMALIZING"] : ["CREATED"]);
    const itemId = crypto.randomUUID();
    const contentPath = `contents/${itemId}.txt`;
    const { content, ...metadata } = note;
    const metadataJson = JSON.stringify({ ...metadata, contentBytes: Buffer.byteLength(content) });
    const diskBytes = stagingBytes.get(job.id) ?? migrationDirectoryBytes(migrationJobDirectory(job.id));
    if (diskBytes + Buffer.byteLength(content) > MIGRATION_LIMITS.temporaryBytes) throw new MigrationError("MIGRATION_STAGING_QUOTA", "迁移临时目录超过容量限制", 413);
    fs.writeFileSync(path.join(migrationJobDirectory(job.id), contentPath), content, { flag: "wx", mode: 0o600 });
    try { db.transaction(() => {
    prepare("INSERT INTO migration_items(id,jobId,sourceKey,contentHash,payloadHash,metadataJson,contentPath,targetNoteId) VALUES (?,?,?,?,?,?,?,?)")
      .run(itemId, job.id, sourceKey, contentHash, payloadHash, metadataJson, contentPath, crypto.randomUUID());
    prepare("UPDATE migration_jobs SET stagedBytes=stagedBytes+? WHERE id=?").run(Buffer.byteLength(content) + Buffer.byteLength(metadataJson), job.id);
    stagingBytes.set(job.id, diskBytes + Buffer.byteLength(content));
    })(); } catch (error) {
      fs.rmSync(path.join(migrationJobDirectory(job.id), contentPath), { force: true });
      throw error;
    }
  }
  prepare("UPDATE migration_jobs SET updatedAt = datetime('now') WHERE id = ?").run(job.id);
}
export async function stageMigrationItems(actor: MigrationActor, id: string, input: unknown[]) {
  const job = owned(actor, id, true); await stage(actor, job, input); return getMigration(actor, id);
}
type MigrationDuplicate = { noteId: string; contentHash: string; metadataSignature: string };
function duplicateSignature(note: Metadata): string {
  const tags = [...new Set(note.tags)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return JSON.stringify([note.title, tags, note.attachments.map((asset) => [asset.originalPath || asset.path, asset.sha256])]);
}
function migrationDuplicate(job: JobRow, item: ItemRow, note: Metadata): MigrationDuplicate | undefined {
  const scope = [job.userId, job.workspaceId || "personal", job.workspaceId, job.workspaceId, job.userId];
  const signature = `json_array(json_extract(mapped.metadataJson,'$.title'),
    json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(mapped.metadataJson,'$.tags') ORDER BY value COLLATE BINARY))),
    json((SELECT json_group_array(json_array(COALESCE(json_extract(ref.value,'$.originalPath'),json_extract(ref.value,'$.path')),json_extract(ref.value,'$.sha256'))) FROM json_each(mapped.metadataJson,'$.attachments') ref)))`;
  const base = `SELECT o.noteId,o.contentHash,${signature} AS metadataSignature FROM note_import_origins o JOIN notes n ON n.id=o.noteId
    LEFT JOIN migration_items mapped ON mapped.targetNoteId=o.noteId AND mapped.jobId=o.batchId AND mapped.status='IMPORTED'
    WHERE o.userId=? AND o.workspaceScope=? AND n.isTrashed=0 AND n.workspaceId IS ? AND (? IS NOT NULL OR n.userId=?)`;
  const exact = prepare(`${base} AND o.sourceType=? AND o.externalId=? LIMIT 1`)
    .get(...scope, `migration:${note.source.platform}`, item.sourceKey) as MigrationDuplicate | undefined;
  if (exact) return exact;
  if (["notion", "siyuan"].includes(note.source.platform)) {
    const stable = prepare(`${base} AND o.sourceType=? AND o.noteId IN (
      SELECT targetNoteId FROM migration_items WHERE json_extract(metadataJson,'$.source.platform')=?
        AND json_extract(metadataJson,'$.source.sourceId')=? AND status='IMPORTED')
      ORDER BY CASE WHEN o.contentHash=? AND ${signature}=? THEN 0 ELSE 1 END,julianday(n.updatedAt) DESC LIMIT 1`)
      .get(...scope, `migration:${note.source.platform}`, note.source.platform, note.source.sourceId, item.contentHash, duplicateSignature(note)) as MigrationDuplicate | undefined;
    if (stable) return stable;
  }
  return prepare(`${base} AND o.sourceType LIKE 'migration:%' AND o.contentHash=? AND ${signature}=? LIMIT 1`)
    .get(...scope, item.contentHash, duplicateSignature(note)) as MigrationDuplicate | undefined;
}

function assertMigrationSourcesComplete(id: string): void {
  if (prepare("SELECT 1 FROM migration_upload_sessions WHERE jobId=? AND status NOT IN ('COMPLETE','CANCELLED') LIMIT 1").get(id)) {
    throw new MigrationError("MIGRATION_UPLOAD_INCOMPLETE", "来源文件尚未完成上传与校验，请继续上传后再预览", 409);
  }
  if (prepare("SELECT 1 FROM migration_uploads WHERE jobId=? AND status!='DONE' LIMIT 1").get(id)) {
    throw new MigrationError("MIGRATION_SOURCE_INCOMPLETE", "来源文件尚未完整解析，请重新上传到新任务，不可将部分解析视为完整迁移", 409);
  }
}
export async function previewMigration(actor: MigrationActor, id: string) {
  const job = owned(actor, id, true);
  assertState(job, ["CREATED", "PREVIEW_READY", "PARTIAL", "FAILED"]);
  const db = getDb();
  assertMigrationSourcesComplete(id);
  const count = (prepare("SELECT COUNT(*) AS count FROM migration_items WHERE jobId = ?").get(id) as { count: number }).count;
  if (!count) throw new MigrationError("MIGRATION_EMPTY", "请先添加要迁移的笔记");
  if (migrationSnapshot(job).counts.attachments) {
    const health = await probeAttachmentStorage();
    if (!health.ok) throw new MigrationError("MIGRATION_STORAGE_UNAVAILABLE", "附件存储当前不可用，请修复后重新预检", 409);
  }
  const digest = crypto.createHash("sha256").update(job.requestHash).update(job.sourceJson).update(crypto.randomBytes(32));
  db.transaction(() => {
    assertState(readJob(id), ["CREATED", "PREVIEW_READY", "PARTIAL", "FAILED"]);
    assertMigrationSourcesComplete(id);
    let cursor = "";
    while (true) {
      const batch = prepare("SELECT * FROM migration_items WHERE jobId = ? AND id > ? ORDER BY id LIMIT 50").all(id, cursor) as ItemRow[];
      if (!batch.length) break;
      for (const item of batch) {
      const note = parse<Metadata>(item.metadataJson);
      requireExtraScopes(job, note, actor);
      if (item.status !== "IMPORTED") {
        const duplicate = migrationDuplicate(job, item, note);
        const accessible = duplicate && hasPermission(resolveNotebookPermission((prepare("SELECT notebookId FROM notes WHERE id = ?").get(duplicate.noteId) as { notebookId: string }).notebookId, actor.userId).permission, "read");
        // A restricted client must not learn or link to a duplicate outside its grant.
        let withinToken = true;
        if (duplicate) {
          const notebookId = (prepare("SELECT notebookId FROM notes WHERE id = ?").get(duplicate.noteId) as { notebookId: string }).notebookId;
          for (const tokenId of new Set([actor.tokenId, job.tokenId].filter(Boolean) as string[])) {
            try { tokenAccess(tokenId, actor.userId, notebookId, false); } catch { withinToken = false; }
          }
        }
        const existing = Boolean(accessible && withinToken && item.decision !== "create-copy" && item.decision !== "skip");
        const sourceChanged = existing && (duplicate!.contentHash !== item.contentHash || duplicate!.metadataSignature !== duplicateSignature(note));
        const itemWarnings = sourceChanged ? ["SOURCE_CHANGED_EXISTING_KEPT; 来源内容已变化，请确认本次处理方式；已有笔记不会被覆盖"] : [];
        const missingExisting = item.decision === "keep-existing" && !existing;
        if (missingExisting) itemWarnings.push("EXISTING_TARGET_UNAVAILABLE; 已有笔记不再可用，请选择新副本或跳过");
        const targetNoteId = item.decision === "skip" || missingExisting ? null : existing ? duplicate!.noteId : item.action === "existing" ? crypto.randomUUID() : item.targetNoteId || crypto.randomUUID();
        const itemStatus = item.decision === "skip" ? "SKIPPED" : missingExisting ? "ATTENTION" : existing ? sourceChanged && item.decision === "auto" ? "ATTENTION" : "EXISTING" : "READY";
        const action = item.decision === "skip" ? "skip" : existing || missingExisting ? "existing" : "create";
        prepare("UPDATE migration_items SET status = ?, action = ?, targetNoteId = ?, error = NULL, warningsJson = ? WHERE id = ?")
          .run(itemStatus, action, targetNoteId, JSON.stringify(itemWarnings), item.id);
        if (itemWarnings.length) warnings(readJob(id), itemWarnings);
        digest.update(action).update(itemStatus).update(item.decision).update(targetNoteId || "");
      }
      digest.update(item.id).update(item.payloadHash).update(item.status === "IMPORTED" ? item.targetNoteId || "" : "");
      }
      cursor = batch[batch.length - 1].id;
    }
    const requiredAssets = (prepare(`SELECT COALESCE(SUM(a.size),0) AS bytes FROM migration_items i
      JOIN json_each(i.metadataJson,'$.attachments') ref
      JOIN migration_assets a ON a.jobId=i.jobId AND a.path=json_extract(ref.value,'$.path')
      WHERE i.jobId=? AND i.action='create' AND i.status!='IMPORTED'`).get(id) as { bytes: number }).bytes;
    if (requiredAssets) {
      if (getAttachmentStorageInfo().driver === "local") {
        const space = fs.statfsSync(ensureAttachmentsDir());
        if (space.bavail * space.bsize < requiredAssets + 1024 * 1024) throw new MigrationError("MIGRATION_STORAGE_CAPACITY", "附件存储剩余空间不足以创建预览中的附件副本", 409);
      } else warnings(readJob(id), ["STORAGE_QUOTA_UNVERIFIED; 对象存储容量配额无法自动确认，请在开始前检查配额"]);
    }
    const previewDigest = digest.digest("hex");
    prepare("UPDATE migration_jobs SET status = 'PREVIEW_READY', previewDigest = ?, previewExpiresAt = ?, approvedBySession = NULL, error = NULL, updatedAt = datetime('now') WHERE id = ?")
      .run(previewDigest, new Date(Date.now() + 15 * 60_000).toISOString(), id);
  })();
  return getMigration(actor, id);
}
export async function decideMigrationItem(actor: MigrationActor, id: string, itemId: string, input: unknown) {
  const value = z.object({ previewDigest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["auto", "skip", "keep-existing", "create-copy"]) }).strict().parse(input);
  const job = owned(actor, id, true);
  assertState(job, ["PREVIEW_READY"]);
  if (job.previewDigest !== value.previewDigest) throw new MigrationError("MIGRATION_PREVIEW_EXPIRED", "预览已变化，请刷新后重新选择", 409);
  const item = prepare("SELECT * FROM migration_items WHERE jobId=? AND id=?").get(id, itemId) as ItemRow | undefined;
  if (!item) throw new MigrationError("MIGRATION_ITEM_NOT_FOUND", "迁移记录不存在", 404);
  if (item.status === "IMPORTED") throw new MigrationError("MIGRATION_ITEM_COMMITTED", "已经导入的记录不能改变策略", 409);
  if (value.decision === "keep-existing" && item.action !== "existing") throw new MigrationError("MIGRATION_DECISION_INVALID", "本条没有可保留的已有笔记", 409);
  getDb().transaction(() => {
    prepare("UPDATE migration_items SET decision=?,targetNoteId=? WHERE id=? AND jobId=?")
      .run(value.decision, value.decision === "create-copy" ? crypto.randomUUID() : item.targetNoteId, itemId, id);
    prepare("UPDATE migration_jobs SET status='CREATED',previewDigest=NULL,previewExpiresAt=NULL,approvedBySession=NULL WHERE id=?").run(id);
  })();
  return previewMigration(actor, id);
}

function assertSession(userId: string, sessionId: string): void {
  const session = prepare("SELECT revokedAt, expiresAt FROM user_sessions WHERE id = ? AND userId = ?").get(sessionId, userId) as { revokedAt: string | null; expiresAt: string | null } | undefined;
  if (!session || session.revokedAt || (session.expiresAt && Date.parse(session.expiresAt) <= Date.now())) throw new MigrationError("MIGRATION_HUMAN_APPROVAL_REQUIRED", "请在 Nowen Note 中重新登录并确认迁移预览", 403);
}
export function approveMigration(actor: MigrationActor, id: string, previewDigest: string, sessionId: string) {
  if (actor.tokenId || !sessionId) throw new MigrationError("MIGRATION_HUMAN_APPROVAL_REQUIRED", "请在 Nowen Note 中确认迁移预览", 403);
  const job = owned(actor, id, true);
  assertSession(actor.userId, sessionId);
  if (job.tokenId) tokenAccess(job.tokenId, job.userId, job.targetNotebookId, true);
  assertState(job, ["PREVIEW_READY"]);
  if (job.previewDigest !== previewDigest || !job.previewExpiresAt || Date.parse(job.previewExpiresAt) <= Date.now()) throw new MigrationError("MIGRATION_PREVIEW_EXPIRED", "预览已过期或发生变化，请重新预览后确认", 409);
  const counts = migrationSnapshot(job).counts;
  if (Number(counts.needsAttention)) throw new MigrationError("MIGRATION_NEEDS_ATTENTION", "请先处理预检问题", 409);
  prepare("UPDATE migration_jobs SET status = 'APPROVED', approvedBySession = ?, previewExpiresAt = NULL, updatedAt = datetime('now') WHERE id = ? AND status = 'PREVIEW_READY'").run(sessionId, id);
  logAudit(actor.userId, "system", "migration_approved", { jobId: id, previewDigest }, { targetType: "migration", targetId: id });
  queueMigration(id);
  return getMigration(actor, id);
}

const pending = new Set<string>();
let workerRunning = false;
function replaceReference(content: string, href: string, destination: string): string {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`((?:src|href)\\s*=\\s*["'])${escaped}(["'])`, "gi"), (_all, before, after) => `${before}${destination}${after}`)
    .replace(new RegExp(`(\\]\\(<?)${escaped}(>?[)\\s])`, "g"), (_all, before, after) => `${before}${destination}${after}`);
}
function folder(job: JobRow, segments: string[]): string {
  const db = getDb();
  let parentId = job.targetNotebookId ? `notebook:${job.targetNotebookId}` : null;
  for (let index = 0; index <= segments.length; index++) {
    const pathKey = JSON.stringify(segments.slice(0, index));
    const mapped = prepare("SELECT resourceId FROM migration_resources WHERE jobId = ? AND resourceType = 'notebook' AND pathKey = ?").get(job.id, pathKey) as { resourceId: string } | undefined;
    if (mapped) {
      const current = prepare("SELECT parentId,workspaceId,isDeleted FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${mapped.resourceId}`) as { parentId: string | null; workspaceId: string | null; isDeleted: number } | undefined;
      if (!current || current.isDeleted || current.parentId !== parentId || current.workspaceId !== job.workspaceId) throw new MigrationError("MIGRATION_TARGET_CHANGED", "导入目录已被移动或删除，已停止向变化后的目标写入", 409);
      parentId = `notebook:${mapped.resourceId}`; continue;
    }
    const created = createKnowledgeChild({ actorUserId: job.userId, workspaceId: job.workspaceId, parentId, nodeType: "folder", title: index === 0 ? job.name : segments[index - 1], db });
    prepare("INSERT INTO migration_resources(jobId,resourceType,resourceId,pathKey,fingerprint) VALUES (?,'notebook',?,?,?)").run(job.id, created.resourceId, pathKey, resourceFingerprint("notebook", created.resourceId));
    if (index === 0) prepare("UPDATE migration_jobs SET rootNotebookId = ? WHERE id = ?").run(created.resourceId, job.id);
    parentId = created.id;
  }
  return parentId!;
}
function requireExtraScopes(job: JobRow, note: Pick<Metadata, "attachments" | "tags">, actor?: MigrationActor): void {
  for (const tokenId of new Set([job.tokenId, actor?.tokenId].filter(Boolean) as string[])) {
  tokenAccess(tokenId, job.userId, job.targetNotebookId, true);
  const scopes = new Set(parse<string[]>((prepare("SELECT scopes FROM api_tokens WHERE id = ?").get(tokenId) as { scopes: string }).scopes));
  for (const scope of [...(note.attachments.length ? ["attachments:write"] : []), ...(note.tags.length ? ["tags:write"] : [])]) {
    if (!scopes.has(scope)) throw new MigrationError("API_TOKEN_SCOPE_REQUIRED", `迁移需要 ${scope} 权限`, 403);
  }
  }
}
function resourceFingerprint(resourceType: string, id: string): string | null {
  const db = getDb();
  const table = resourceType === "notebook" ? "notebooks" : "notes";
  const row = prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return null;
  const node = prepare("SELECT * FROM knowledge_tree_nodes WHERE resourceType = ? AND resourceId = ?").get(resourceType, id);
  const related = resourceType === "note" ? {
    attachments: prepare("SELECT * FROM attachments WHERE noteId = ? ORDER BY id").all(id),
    tags: prepare("SELECT tagId FROM note_tags WHERE noteId = ? ORDER BY tagId").all(id),
  } : null;
  return hash(JSON.stringify({ row, node, related }));
}
async function importItem(job: JobRow, item: ItemRow): Promise<void> {
  const actor = { userId: job.userId, tokenId: job.tokenId };
  checkAccess(actor, job, true);
  assertSession(job.userId, job.approvedBySession || "");
  const note = parse<Metadata>(item.metadataJson);
  requireExtraScopes(job, note);
  const db = getDb();
  let content = fs.readFileSync(fileFor(job, item.contentPath), "utf8");
  if (hash(JSON.stringify([note.contentFormat, content])) !== item.contentHash) throw new MigrationError("MIGRATION_HASH_MISMATCH", "暂存正文校验失败");
  const assets: { id: string; storagePath: string; asset: Metadata["attachments"][number]; size: number }[] = [];
  let committed = false;
  try {
  for (const asset of note.attachments) {
    const registered = prepare("SELECT sha256, size FROM migration_assets WHERE jobId = ? AND path = ?").get(job.id, asset.path) as { sha256: string; size: number } | undefined;
    if (!registered || registered.sha256 !== asset.sha256) throw new MigrationError("MIGRATION_ASSET_NOT_STAGED", "迁移附件未通过校验");
    const filename = fileFor(job, asset.path);
    if (await fileHash(filename) !== asset.sha256) throw new MigrationError("MIGRATION_HASH_MISMATCH", "迁移附件校验失败");
    const id = crypto.createHash("sha256").update(`${item.id}:${asset.assetId}`).digest("hex").slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const storagePath = `migrations/${job.id}/${id}${path.extname(asset.path).slice(0, 12)}`;
    const mimeType = await sniffMigrationAsset(filename, asset.path);
    assets.push({ id, storagePath, asset: { ...asset, mimeType }, size: registered.size });
    prepare("INSERT OR IGNORE INTO migration_objects(path,jobId,itemId) VALUES (?,?,?)").run(storagePath, job.id, item.id);
    await writeAttachmentObjectFromFile(storagePath, filename, mimeType);
    const original = (asset as typeof asset & { originalPath?: string }).originalPath || asset.path;
    content = replaceReference(content, original, `/api/attachments/${id}`);
    content = replaceReference(content, encodeURI(original), `/api/attachments/${id}`);
  }
  const itemWarnings: string[] = [];
  for (const link of note.links) {
    if (!link.targetSourceId) continue;
    const sourceKey = hash(JSON.stringify([note.source.platform, note.source.exportId, link.targetSourceId]));
    const target = prepare("SELECT targetNoteId FROM migration_items WHERE jobId = ? AND sourceKey = ? AND status IN ('READY','IMPORTED','EXISTING')").get(job.id, sourceKey) as { targetNoteId: string } | undefined;
    const anchor = link.href.includes("#") ? link.href.slice(link.href.indexOf("#")) : "";
    if (!target || (anchor && !/^#blk:[A-Za-z0-9_-]+$/.test(anchor))) { itemWarnings.push("有无法转换的内部链接或锚点，已保留来源链接"); continue; }
    content = replaceReference(content, link.href, `note:${target.targetNoteId}${anchor}`);
  }
  db.transaction(() => {
    const currentJob = readJob(job.id);
    if (currentJob.status !== "IMPORTING") return;
    checkAccess(actor, currentJob, true);
    assertSession(job.userId, job.approvedBySession || "");
    const currentItem = prepare("SELECT status FROM migration_items WHERE id = ?").get(item.id) as { status: string };
    if (currentItem.status === "IMPORTED") return;
    const parentId = folder(currentJob, note.path);
    const created = createKnowledgeChild({ actorUserId: job.userId, workspaceId: job.workspaceId, parentId, nodeType: note.contentFormat === "markdown" ? "markdown" : "note", title: note.title, noteId: item.targetNoteId!, db });
    const format = note.contentFormat === "txt" ? "plaintext" : note.contentFormat;
    const synced = format === "markdown" ? syncNoteBlocks(db, created.resourceId, content, format) : { content, contentText: extractSearchableText(content, format) };
    prepare("UPDATE notes SET content = ?, contentText = ?, contentFormat = ?, createdAt = COALESCE(?,createdAt), updatedAt = COALESCE(?,updatedAt) WHERE id = ?")
      .run(synced.content, synced.contentText, format, note.createdAt || null, note.updatedAt || null, created.resourceId);
    for (const asset of assets) {
      prepare("INSERT INTO attachments(id,noteId,userId,workspaceId,filename,mimeType,size,path,hash,uploadSource) VALUES (?,?,?,?,?,?,?,?,?,'migration')")
        .run(asset.id, created.resourceId, job.userId, job.workspaceId, path.basename(asset.asset.path), asset.asset.mimeType || "application/octet-stream", asset.size, asset.storagePath, asset.asset.sha256);
    }
    for (const name of note.tags) {
      let tag = prepare("SELECT id FROM tags WHERE userId = ? AND workspaceId IS ? AND name = ?").get(job.userId, job.workspaceId, name) as { id: string } | undefined;
      if (!tag) { tag = { id: crypto.randomUUID() }; prepare("INSERT INTO tags(id,userId,workspaceId,name) VALUES (?,?,?,?)").run(tag.id, job.userId, job.workspaceId, name); }
      prepare("INSERT OR IGNORE INTO note_tags(noteId,tagId) VALUES (?,?)").run(created.resourceId, tag.id);
    }
    syncReferences(db, created.resourceId, synced.content);
    syncNoteLinks(db, job.userId, created.resourceId, synced.content);
    if (format === "markdown") {
      rebuildBlockAuthorityStore(db, created.resourceId, synced.content, format, { noteVersion: 1, operationType: "create" });
      rebuildYjsSubdocumentsIfEnabled(db, created.resourceId, synced.content, format);
    }
    prepare("INSERT INTO note_import_origins(id,userId,workspaceId,workspaceScope,noteId,sourceType,externalId,contentHash,batchId) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(userId,workspaceScope,sourceType,externalId) DO UPDATE SET noteId=excluded.noteId,contentHash=excluded.contentHash,batchId=excluded.batchId")
      .run(crypto.randomUUID(), job.userId, job.workspaceId, job.workspaceId || "personal", created.resourceId, `migration:${note.source.platform}`, item.decision === "create-copy" ? hash(JSON.stringify([item.sourceKey, job.id])) : item.sourceKey, item.contentHash, job.id);
    prepare("INSERT INTO migration_resources(jobId,resourceType,resourceId,fingerprint) VALUES (?,'note',?,?)").run(job.id, created.resourceId, resourceFingerprint("note", created.resourceId));
    prepare("UPDATE migration_items SET status='IMPORTED', error=NULL, warningsJson=? WHERE id=?").run(JSON.stringify(itemWarnings), item.id);
    prepare("UPDATE migration_objects SET status='COMMITTED' WHERE itemId=?").run(item.id);
    committed = true;
  })();
  } finally {
    if (!committed) for (const asset of assets) {
      if (!prepare("SELECT 1 FROM attachments WHERE path = ? LIMIT 1").get(asset.storagePath)) {
        try { await deleteAttachmentObject(asset.storagePath); prepare("DELETE FROM migration_objects WHERE path=?").run(asset.storagePath); }
        catch { /* persisted object intent is retried after restart */ }
      }
    }
  }
}
async function processJob(id: string): Promise<void> {
  let job = readJob(id);
  const actor = { userId: job.userId, tokenId: job.tokenId };
  checkAccess(actor, job, true);
  if (["SCANNING", "NORMALIZING"].includes(job.status)) {
    stagingBytes.delete(id);
    const upload = prepare("SELECT * FROM migration_uploads WHERE jobId = ? AND status = 'PENDING' ORDER BY id LIMIT 1").get(id) as UploadRow | undefined;
    if (!upload) { status(id, "CREATED", ["SCANNING", "NORMALIZING"]); return; }
    status(id, "NORMALIZING", ["SCANNING", "NORMALIZING"]);
    const { stageMigrationFile } = await import("./migrationSourceAdapter.js");
    const result = await stageMigrationFile({ filePath: fileFor(job, upload.path), filename: upload.filename, jobDir: migrationJobDirectory(id), source: parse<Source>(job.sourceJson), assertActive: () => {
      const current = readJob(id);
      assertState(current, ["SCANNING", "NORMALIZING"]);
      checkAccess(actor, current, true);
    }, onNote: async (note: NmfNote) => {
      const current = readJob(id);
      if (!["SCANNING", "NORMALIZING"].includes(current.status)) throw new MigrationError("MIGRATION_INTERRUPTED", "迁移任务已停止", 409);
      await stage(actor, current, [note], true);
    } });
    job = readJob(id);
    if (!["SCANNING", "NORMALIZING"].includes(job.status)) return;
    warnings(job, result.warnings);
    prepare("UPDATE migration_uploads SET status = 'DONE' WHERE id = ?").run(upload.id);
    status(id, "CREATED", ["SCANNING", "NORMALIZING"]);
    return;
  }
  if (job.status === "APPROVED") status(id, "IMPORTING", ["APPROVED"]);
  job = readJob(id);
  if (job.status === "IMPORTING") {
    const items = prepare("SELECT * FROM migration_items WHERE jobId = ? AND status = 'READY' ORDER BY id LIMIT 20").all(id) as ItemRow[];
    for (const item of items) {
      job = readJob(id);
      if (job.status !== "IMPORTING") return;
      try { await importItem(job, item); }
      catch (error) {
        const code = error instanceof MigrationError ? error.code : "MIGRATION_ITEM_WRITE_FAILED";
        prepare("UPDATE migration_items SET status='FAILED',error=? WHERE id=? AND status != 'IMPORTED'").run(code, item.id);
      }
      await delay(10);
    }
    if ((prepare("SELECT 1 FROM migration_items WHERE jobId = ? AND status = 'READY' LIMIT 1").get(id))) { queueMigration(id); return; }
    status(id, "VERIFYING", ["IMPORTING"]);
  }
  job = readJob(id);
  if (job.status === "VERIFYING") {
    // Verification reads the committed snapshots; it never overwrites a user's subsequent edit.
    let cursor = "";
    while (true) {
      const batch = prepare("SELECT id,targetNoteId FROM migration_items WHERE jobId = ? AND status = 'IMPORTED' AND id > ? ORDER BY id LIMIT 50").all(id, cursor) as { id: string; targetNoteId: string }[];
      if (!batch.length) break;
      for (const item of batch) {
      const exists = prepare("SELECT 1 FROM notes n JOIN knowledge_tree_nodes k ON k.resourceType='note' AND k.resourceId=n.id WHERE n.id=?").get(item.targetNoteId);
      if (!exists) { prepare("UPDATE migration_items SET status='FAILED',error='MIGRATION_VERIFY_NOTE_MISSING' WHERE id=?").run(item.id); continue; }
      for (const asset of prepare("SELECT path,hash,size FROM attachments WHERE noteId = ?").all(item.targetNoteId) as { path: string; hash: string; size: number }[]) {
        const digest = crypto.createHash("sha256");
        for (let offset = 0; offset < asset.size; offset += 1024 * 1024) {
          const chunk = await readAttachmentRange(asset.path, offset, Math.min(asset.size - 1, offset + 1024 * 1024 - 1));
          if (!chunk) throw new MigrationError("MIGRATION_VERIFY_ATTACHMENT_MISSING", "附件写入后无法完整读取", 409);
          digest.update(chunk);
        }
        if (digest.digest("hex") !== asset.hash) throw new MigrationError("MIGRATION_VERIFY_ATTACHMENT_HASH", "附件写入后校验失败", 409);
      }
      }
      cursor = batch[batch.length - 1].id;
      await delay(0);
    }
    const counts = migrationSnapshot(job).counts;
    status(id, Number(counts.failed) ? (Number(counts.imported) ? "PARTIAL" : "FAILED") : "COMPLETED", ["VERIFYING"]);
    stagingBytes.delete(id);
    notifySyncChanged(getDb(), job.userId, job.workspaceId ? `workspace:${job.workspaceId}` : "personal");
    broadcastToUser(job.userId, { type: "notes:imported", payload: { jobId: id, rootNotebookId: readJob(id).rootNotebookId } } as never);
  }
}
export function queueMigration(id: string): void {
  pending.add(id);
  if (workerRunning) return;
  workerRunning = true;
  setImmediate(() => { void (async () => {
    try {
      while (pending.size) {
        const current = pending.values().next().value!; pending.delete(current);
        try { if (runnable.has(readJob(current).status)) await processJob(current); }
        catch (error) {
          const job = readJob(current);
          if (!terminal.has(job.status) && job.status !== "PAUSED") prepare("UPDATE migration_jobs SET status = 'FAILED', error = ?, updatedAt=datetime('now') WHERE id = ?")
            .run(error instanceof MigrationError || error instanceof MigrationSourceError ? error.code : "MIGRATION_PROCESS_FAILED", current);
        }
        await delay(5);
      }
    } finally { workerRunning = false; }
  })(); });
}
export function recoverMigrations(): void {
  cleanupMigrationStaging();
  const db = getDb();
  // An interrupted upload has no complete file and cannot be interpreted as a successful scan.
  prepare("UPDATE migration_jobs SET status='CREATED',error='MIGRATION_UPLOAD_INTERRUPTED' WHERE status='UPLOADING'").run();
  const jobs = prepare("SELECT id FROM migration_jobs WHERE status IN ('APPROVED','IMPORTING','VERIFYING','SCANNING','NORMALIZING')").all() as { id: string }[];
  void cleanupMigrationObjects().then(() => { for (const job of jobs) queueMigration(job.id); });
}

/** Only uncommitted migration-owned object intents can be compensated after a crash. */
export async function cleanupMigrationObjects(): Promise<void> {
  const objects = prepare("SELECT path FROM migration_objects WHERE status='STAGED'").all() as { path: string }[];
  for (const object of objects) {
    if (prepare("SELECT 1 FROM attachments WHERE path=?").get(object.path)) {
      prepare("UPDATE migration_objects SET status='COMMITTED' WHERE path=?").run(object.path);
    } else {
      try { await deleteAttachmentObject(object.path); prepare("DELETE FROM migration_objects WHERE path=?").run(object.path); }
      catch { /* keep intent for the next recovery; never hide a storage failure as a commit */ }
    }
  }
}

/** Lazy expiry runs on startup and before new jobs, retaining reports and all committed notes. */
export function cleanupMigrationStaging(): void {
  const expired = prepare(`SELECT id,status FROM migration_jobs
    WHERE (status IN ('COMPLETED','CANCELLED','UNDONE') AND updatedAt < datetime('now','-1 day'))
       OR (status IN ('CREATED','PREVIEW_READY','PAUSED','PARTIAL','FAILED') AND updatedAt < datetime('now','-7 days'))`).all() as { id: string; status: MigrationStatus }[];
  for (const job of expired) {
    if (["CREATED", "PREVIEW_READY", "PAUSED"].includes(job.status)) {
      prepare("UPDATE migration_jobs SET status='CANCELLED',error='MIGRATION_STAGING_EXPIRED',previewDigest=NULL WHERE id=?").run(job.id);
    }
    fs.rmSync(migrationJobDirectory(job.id), { recursive: true, force: true });
    stagingBytes.delete(job.id);
  }
}
export function controlMigration(actor: MigrationActor, id: string, action: "pause" | "resume" | "retry" | "cancel") {
  const job = owned(actor, id, true);
  if (action === "cancel") {
    if (job.status === "CANCELLED") return migrationSnapshot(job);
    if (terminal.has(job.status)) throw new MigrationError("MIGRATION_STATE_CONFLICT", "任务已经结束", 409);
    status(id, "CANCELLED", [job.status]);
  } else if (action === "pause") {
    assertState(job, ["APPROVED", "IMPORTING"]); status(id, "PAUSED", [job.status]);
  } else {
    assertState(job, action === "resume" ? ["PAUSED"] : ["PARTIAL", "FAILED"]);
    if (!fs.existsSync(migrationJobDirectory(id))) throw new MigrationError("MIGRATION_STAGING_EXPIRED", "暂存文件已过期，请新建任务重新上传来源文件", 409);
    if (!job.approvedBySession) throw new MigrationError("MIGRATION_HUMAN_APPROVAL_REQUIRED", "请重新预览并在 Nowen Note 中确认", 403);
    assertSession(job.userId, job.approvedBySession);
    if (job.tokenId) tokenAccess(job.tokenId, job.userId, job.targetNotebookId, true);
    if (action === "retry") prepare("UPDATE migration_items SET status='READY',error=NULL WHERE jobId=? AND status='FAILED'").run(id);
    status(id, "IMPORTING", [job.status]); queueMigration(id);
  }
  return getMigration(actor, id);
}
export function beginMigrationUpload(actor: MigrationActor, id: string): void {
  stagingBytes.delete(id);
  if (prepare("SELECT 1 FROM migration_upload_sessions WHERE jobId=? AND status='OPEN' LIMIT 1").get(id)) throw new MigrationError("MIGRATION_UPLOAD_INCOMPLETE", "请继续当前分块上传或取消上传会话", 409);
  const job = owned(actor, id, true); assertState(job, ["CREATED"]); status(id, "UPLOADING", ["CREATED"]);
}
export function finishMigrationUpload(actor: MigrationActor, id: string, upload: { filename: string; path: string; uploadId?: string }): void {
  const job = owned(actor, id, true); assertState(job, ["UPLOADING"]);
  fileFor(job, upload.path);
  prepare("INSERT INTO migration_uploads(id,jobId,filename,path) VALUES (?,?,?,?)").run(upload.uploadId || crypto.randomUUID(), id, upload.filename, upload.path);
  status(id, "SCANNING", ["UPLOADING"]); queueMigration(id);
}
export function failMigrationUpload(actor: MigrationActor, id: string): void {
  const job = owned(actor, id, true);
  if (job.status === "UPLOADING") status(id, "CREATED", ["UPLOADING"]);
}
export function migrationReport(actor: MigrationActor, id: string, cursor = "", limit = 100) {
  const job = owned(actor, id);
  const rows = prepare("SELECT * FROM migration_items WHERE jobId = ? AND id > ? ORDER BY id LIMIT ?").all(id, cursor, Math.min(Math.max(limit, 1), 100) + 1) as ItemRow[];
  const hasMore = rows.length > Math.min(Math.max(limit, 1), 100);
  const items = rows.slice(0, Math.min(Math.max(limit, 1), 100)).map((item) => {
    const note = parse<Metadata>(item.metadataJson);
    return { id: item.id, sourceId: note.source.sourceId, title: note.title, path: note.path, status: item.status, action: item.action, decision: item.decision, targetNoteId: item.targetNoteId, error: item.error, warnings: parse<string[]>(item.warningsJson), unsupportedFields: Object.keys(note.metadata) };
  });
  return { job: migrationSnapshot(job), items, warnings: parse<string[]>(job.warningsJson), nextCursor: hasMore ? items[items.length - 1].id : null };
}
export function undoMigration(actor: MigrationActor, id: string, sessionId: string) {
  if (actor.tokenId || !sessionId) throw new MigrationError("MIGRATION_HUMAN_APPROVAL_REQUIRED", "请在 Nowen Note 中撤销本次导入", 403);
  assertSession(actor.userId, sessionId);
  const job = owned(actor, id, true);
  assertState(job, ["COMPLETED", "PARTIAL", "CANCELLED", "FAILED"]);
  if (!job.rootNotebookId) throw new MigrationError("MIGRATION_UNDO_UNAVAILABLE", "任务没有可撤销的导入结果", 409);
  const db = getDb();
  const resources = prepare("SELECT resourceType,resourceId,fingerprint FROM migration_resources WHERE jobId = ?").all(id) as { resourceType: string; resourceId: string; fingerprint: string | null }[];
  for (const resource of resources) if (resource.resourceType === "note") yFlush(resource.resourceId);
  db.transaction(() => {
    checkAccess(actor, readJob(id), true);
    for (const resource of resources) {
      if (!resource.fingerprint || resourceFingerprint(resource.resourceType, resource.resourceId) !== resource.fingerprint) throw new MigrationError("MIGRATION_UNDO_CONFLICT", "导入结果已被修改或移动，已保留全部内容并拒绝撤销", 409);
    }
    const subtree = prepare(`WITH RECURSIVE nodes(id,resourceType,resourceId) AS (
      SELECT id,resourceType,resourceId FROM knowledge_tree_nodes WHERE id = ?
      UNION ALL SELECT n.id,n.resourceType,n.resourceId FROM knowledge_tree_nodes n JOIN nodes p ON n.parentId=p.id
    ) SELECT resourceType,resourceId FROM nodes`).all(`notebook:${job.rootNotebookId}`) as { resourceType: string; resourceId: string }[];
    const expected = new Set(resources.map((item) => `${item.resourceType}:${item.resourceId}`));
    if (subtree.some((item) => !expected.has(`${item.resourceType}:${item.resourceId}`)) || subtree.length !== expected.size) throw new MigrationError("MIGRATION_UNDO_CONFLICT", "导入目录中已有其他内容，已拒绝撤销", 409);
    deleteKnowledgeNode({ actorUserId: actor.userId, nodeId: `notebook:${job.rootNotebookId}`, mode: "subtree", db });
    status(id, "UNDONE", [job.status]);
  })();
  for (const resource of resources) if (resource.resourceType === "note") yDestroyDoc(resource.resourceId);
  notifySyncChanged(db, job.userId, job.workspaceId ? `workspace:${job.workspaceId}` : "personal");
  logAudit(actor.userId, "system", "migration_undone", { jobId: id }, { targetType: "migration", targetId: id });
  return getMigration(actor, id);
}
