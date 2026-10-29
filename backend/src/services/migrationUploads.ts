import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { getDb } from "../db/schema.js";
import { MIGRATION_LIMITS, migrationRelativePathSchema } from "./migrationFormat.js";
import { migrationDirectoryBytes, hashMigrationFile, sniffMigrationAsset } from "./migrationSourceAdapter.js";
import {
  MigrationError, assertMigrationUploadAccess, beginMigrationUpload, failMigrationUpload,
  finishMigrationUpload, getMigration, migrationJobDirectory, registerMigrationAsset,
  type MigrationActor, type MigrationStatus,
} from "./migrationService.js";

export const MIGRATION_CHUNK_BYTES = 4 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const LEASE_MS = 120_000;
type SessionStatus = "OPEN" | "FINALIZING" | "COMPLETE" | "CANCELLED" | "EXPIRED" | "FAILED";
type SessionRow = {
  id: string; jobId: string; operationId: string; requestHash: string; tokenId: string | null;
  filename: string; size: number; sha256: string; assetPath: string | null; offset: number;
  status: SessionStatus; leaseId: string | null; leaseExpiresAt: string | null; expiresAt: string;
  finalizeTokenId: string | null; published: number; publishedIdentity: string | null; error: string | null;
};
type ChunkRow = { offset: number; size: number; sha256: string };
const digestPattern = /^[a-fA-F0-9]{64}$/;
export const createUploadSessionSchema = z.object({
  operationId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  filename: z.string().min(1).max(200).transform((value) => value.normalize("NFC"))
    .refine((value) => value === path.basename(value) && !/[\u0000-\u001f\\]/.test(value), "Invalid filename"),
  size: z.number().int().positive().max(MIGRATION_LIMITS.uploadBytes),
  sha256: z.string().regex(digestPattern).transform((value) => value.toLowerCase()),
  assetPath: migrationRelativePathSchema.optional(),
}).strict();

function sessionDirectory(row: SessionRow): string { return path.join(migrationJobDirectory(row.jobId), "sessions", row.id); }
function partPath(row: SessionRow, offset: number): string { return path.join(sessionDirectory(row), "chunks", `${offset}.part`); }
function destination(row: SessionRow): string { return row.assetPath || `sources/${row.id}/upload${path.extname(row.filename).toLowerCase()}`; }
function fileIdentity(filename: string): string | null {
  const stat = fs.lstatSync(filename);
  // Some remote filesystems do not expose file identities. Preserve an uncertain target.
  return stat.isFile() && !stat.isSymbolicLink() && stat.ino ? JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, stat.size]) : null;
}
function snapshot(row: SessionRow) {
  return { id: row.id, jobId: row.jobId, operationId: row.operationId, filename: row.filename, size: row.size,
    sha256: row.sha256, assetPath: row.assetPath, offset: row.offset, status: row.status,
    chunkBytes: MIGRATION_CHUNK_BYTES, expiresAt: row.expiresAt, error: row.error };
}
function rowFor(jobId: string, uploadId: string): SessionRow {
  const row = getDb().prepare("SELECT * FROM migration_upload_sessions WHERE id=? AND jobId=?").get(uploadId, jobId) as SessionRow | undefined;
  if (!row) throw new MigrationError("MIGRATION_UPLOAD_NOT_FOUND", "上传会话不存在", 404);
  return row;
}
function readOwned(actor: MigrationActor, jobId: string, uploadId: string): SessionRow {
  getMigration(actor, jobId);
  return rowFor(jobId, uploadId);
}
function checkWrite(actor: MigrationActor, row: SessionRow, states: MigrationStatus[] = ["CREATED"]): void {
  assertMigrationUploadAccess(actor, row.jobId, states, Boolean(row.assetPath));
  if (row.tokenId) assertMigrationUploadAccess({ userId: actor.userId, tokenId: row.tokenId }, row.jobId, states, Boolean(row.assetPath));
  if (row.status === "EXPIRED" || Date.parse(row.expiresAt) <= Date.now()) throw new MigrationError("MIGRATION_UPLOAD_EXPIRED", "上传会话已过期，请创建新的上传会话", 409);
}
function claim(row: SessionRow, statuses: SessionStatus[]): string {
  const lease = crypto.randomUUID();
  const changed = getDb().prepare(`UPDATE migration_upload_sessions SET leaseId=?,leaseExpiresAt=?
    WHERE id=? AND status IN (${statuses.map(() => "?").join(",")}) AND (leaseId IS NULL OR leaseExpiresAt <= ?)`)
    .run(lease, new Date(Date.now() + LEASE_MS).toISOString(), row.id, ...statuses, new Date().toISOString());
  if (changed.changes !== 1) throw new MigrationError("MIGRATION_UPLOAD_BUSY", "上传会话正在处理其他请求，请稍后按同一偏移重试", 409);
  return lease;
}
function release(uploadId: string, lease: string): void {
  getDb().prepare("UPDATE migration_upload_sessions SET leaseId=NULL,leaseExpiresAt=NULL WHERE id=? AND leaseId=?").run(uploadId, lease);
}
function checkLease(actor: MigrationActor, row: SessionRow, lease: string): void {
  checkWrite(actor, row, row.status === "FINALIZING" ? ["UPLOADING"] : ["CREATED"]);
  const current = rowFor(row.jobId, row.id);
  if (current.leaseId !== lease || !["OPEN", "FINALIZING"].includes(current.status)) throw new MigrationError("MIGRATION_UPLOAD_STATE", "上传会话状态已变化", 409);
  getDb().prepare("UPDATE migration_upload_sessions SET leaseExpiresAt=? WHERE id=? AND leaseId=?")
    .run(new Date(Date.now() + LEASE_MS).toISOString(), row.id, lease);
}
function assertQuota(row: SessionRow, extra: number): void {
  const directory = migrationJobDirectory(row.jobId);
  if (migrationDirectoryBytes(directory) + extra > MIGRATION_LIMITS.temporaryBytes) throw new MigrationError("MIGRATION_STAGING_QUOTA", "迁移临时目录超过容量限制", 413);
  const available = fs.statfsSync(directory);
  if (available.bavail * available.bsize < extra + 1024 * 1024) throw new MigrationError("MIGRATION_STORAGE_FULL", "临时存储空间不足", 413);
}

export function createMigrationUploadSession(actor: MigrationActor, jobId: string, input: unknown) {
  getMigration(actor, jobId);
  recoverMigrationUploadSessions();
  const value = createUploadSessionSchema.parse(input);
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const job = getMigration(actor, jobId);
  const existing = getDb().prepare("SELECT * FROM migration_upload_sessions WHERE jobId=? AND operationId=?").get(jobId, value.operationId) as SessionRow | undefined;
  if (existing) {
    assertMigrationUploadAccess(actor, jobId, [job.status], Boolean(existing.assetPath));
    if (existing.requestHash !== requestHash) throw new MigrationError("MIGRATION_UPLOAD_OPERATION_CONFLICT", "该上传标识已用于不同文件", 409);
    if (existing.status === "CANCELLED") throw new MigrationError("MIGRATION_UPLOAD_CANCELLED", "该文件上传已取消，请在新任务中重新上传", 409);
    if (existing.status === "EXPIRED") {
      assertMigrationUploadAccess(actor, jobId, ["CREATED"], Boolean(existing.assetPath));
      if (existing.tokenId) assertMigrationUploadAccess({ userId: actor.userId, tokenId: existing.tokenId }, jobId, ["CREATED"], Boolean(existing.assetPath));
      if (getDb().prepare("SELECT 1 FROM migration_upload_sessions WHERE jobId=? AND status IN ('OPEN','FINALIZING')").get(jobId)) throw new MigrationError("MIGRATION_UPLOAD_ACTIVE", "请先完成或取消当前文件上传", 409);
      removeUncommittedFiles(existing);
      getDb().transaction(() => {
        getDb().prepare("DELETE FROM migration_upload_chunks WHERE uploadId=?").run(existing.id);
        getDb().prepare("UPDATE migration_upload_sessions SET status='OPEN',offset=0,published=0,publishedIdentity=NULL,error=NULL,finalizeTokenId=NULL,leaseId=NULL,leaseExpiresAt=NULL,expiresAt=?,updatedAt=datetime('now') WHERE id=?")
          .run(new Date(Date.now() + SESSION_TTL_MS).toISOString(), existing.id);
      })();
      fs.mkdirSync(path.join(sessionDirectory(existing), "chunks"), { recursive: true, mode: 0o700 });
      return snapshot(rowFor(jobId, existing.id));
    }
    return snapshot(existing);
  }
  assertMigrationUploadAccess(actor, jobId, ["CREATED"], Boolean(value.assetPath));
  if (value.assetPath && !value.assetPath.startsWith("assets/")) throw new MigrationError("MIGRATION_ASSET_PATH", "附件必须位于 assets 目录");
  if (!value.assetPath && !/\.(md|markdown|html?|txt|zip)$/i.test(value.filename)) throw new MigrationError("MIGRATION_FORMAT_UNSUPPORTED", "请上传 Markdown、HTML、TXT 或 ZIP 文件");
  const limit = value.assetPath ? MIGRATION_LIMITS.assetBytes : /\.zip$/i.test(value.filename) ? MIGRATION_LIMITS.uploadBytes : MIGRATION_LIMITS.contentBytes;
  if (value.size > limit) throw new MigrationError("MIGRATION_UPLOAD_TOO_LARGE", "文件超过该格式的上传限制", 413);
  if (getDb().prepare("SELECT 1 FROM migration_upload_sessions WHERE jobId=? AND status IN ('OPEN','FINALIZING')").get(jobId)) throw new MigrationError("MIGRATION_UPLOAD_ACTIVE", "请先完成或取消当前文件上传", 409);
  const row = { ...value, id: crypto.randomUUID(), jobId, assetPath: value.assetPath || null, tokenId: actor.tokenId || null,
    requestHash, offset: 0, status: "OPEN" as const, leaseId: null, leaseExpiresAt: null, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    finalizeTokenId: null, published: 0, publishedIdentity: null, error: null };
  assertQuota(row, value.size * 2);
  getDb().prepare("INSERT INTO migration_upload_sessions(id,jobId,operationId,requestHash,tokenId,filename,size,sha256,assetPath,expiresAt) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(row.id, row.jobId, row.operationId, requestHash, row.tokenId, row.filename, row.size, row.sha256, row.assetPath, row.expiresAt);
  fs.mkdirSync(path.join(sessionDirectory(row), "chunks"), { recursive: true, mode: 0o700 });
  return snapshot(row);
}

export function getMigrationUploadSession(actor: MigrationActor, jobId: string, uploadId: string) {
  getMigration(actor, jobId);
  recoverMigrationUploadSessions();
  return snapshot(readOwned(actor, jobId, uploadId));
}

export async function putMigrationUploadChunk(actor: MigrationActor, jobId: string, uploadId: string, offset: number, expectedHash: string, body: ReadableStream<Uint8Array> | null) {
  const row = readOwned(actor, jobId, uploadId);
  checkWrite(actor, row);
  if (row.status !== "OPEN" || !Number.isSafeInteger(offset) || offset < 0 || offset > row.offset || !digestPattern.test(expectedHash)) throw new MigrationError("MIGRATION_UPLOAD_OFFSET", "上传偏移或校验和不匹配", 409);
  const previous = getDb().prepare("SELECT offset,size,sha256 FROM migration_upload_chunks WHERE uploadId=? AND offset=?").get(uploadId, offset) as ChunkRow | undefined;
  if (offset !== row.offset && (!previous || previous.sha256 !== expectedHash.toLowerCase())) throw new MigrationError("MIGRATION_UPLOAD_OFFSET", "请按服务端已确认的偏移继续上传", 409);
  if (offset === row.offset && offset >= row.size) throw new MigrationError("MIGRATION_UPLOAD_COMPLETE_REQUIRED", "文件已上传，请完成校验", 409);
  if (!body) throw new MigrationError("MIGRATION_UPLOAD_EMPTY", "上传分块为空");
  const lease = claim(row, ["OPEN"]);
  const temporary = path.join(sessionDirectory(row), `${crypto.randomUUID()}.tmp`);
  const maximum = previous?.size || Math.min(MIGRATION_CHUNK_BYTES, row.size - offset);
  let bytes = 0, lastCheck = 0;
  const started = performance.now(), digest = crypto.createHash("sha256");
  try {
    assertQuota(row, maximum);
    fs.mkdirSync(path.join(sessionDirectory(row), "chunks"), { recursive: true, mode: 0o700 });
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      try {
        if (performance.now() - lastCheck > 1000) { checkLease(actor, row, lease); lastCheck = performance.now(); }
        bytes += chunk.length;
        if (bytes > maximum) throw new MigrationError("MIGRATION_CHUNK_TOO_LARGE", "上传分块超过声明大小或 4MiB 限制", 413);
        digest.update(chunk);
        const wait = bytes / MIGRATION_LIMITS.uploadBytesPerSecond * 1000 - (performance.now() - started);
        if (wait > 1) setTimeout(() => callback(null, chunk), wait); else callback(null, chunk);
      } catch (error) { callback(error as Error); }
    } });
    await pipeline(Readable.fromWeb(body as never), meter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    if (bytes !== maximum || digest.digest("hex") !== expectedHash.toLowerCase()) throw new MigrationError("MIGRATION_CHUNK_HASH", "上传分块大小或校验和不匹配", 409);
    checkLease(actor, row, lease);
    if (previous) return snapshot(rowFor(jobId, uploadId));
    const handle = await fs.promises.open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    const target = partPath(row, offset);
    try { await fs.promises.link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || fs.statSync(target).size !== bytes || await hashMigrationFile(target) !== expectedHash.toLowerCase()) throw new MigrationError("MIGRATION_CHUNK_CONFLICT", "该偏移已存有不同分块", 409);
    }
    getDb().transaction(() => {
      checkLease(actor, row, lease);
      getDb().prepare("INSERT INTO migration_upload_chunks(uploadId,offset,size,sha256) VALUES (?,?,?,?)").run(uploadId, offset, bytes, expectedHash.toLowerCase());
      const changed = getDb().prepare("UPDATE migration_upload_sessions SET offset=offset+?,updatedAt=datetime('now') WHERE id=? AND offset=? AND leaseId=? AND status='OPEN'").run(bytes, uploadId, offset, lease);
      if (changed.changes !== 1) throw new MigrationError("MIGRATION_UPLOAD_OFFSET", "上传偏移已变化", 409);
    })();
    return snapshot(rowFor(jobId, uploadId));
  } finally {
    fs.rmSync(temporary, { force: true }); release(uploadId, lease);
  }
}

async function finalize(row: SessionRow, actor: MigrationActor) {
  const { jobId, id: uploadId } = row;
  checkWrite(actor, row, ["UPLOADING"]);
  const lease = claim(row, ["FINALIZING"]);
  const relative = destination(row), finalPath = path.join(migrationJobDirectory(jobId), relative);
  const assembled = path.join(sessionDirectory(row), `${lease}.assembled`);
  try {
    if (!fs.existsSync(finalPath)) {
      assertQuota(row, row.size);
      const chunks = getDb().prepare("SELECT offset,size,sha256 FROM migration_upload_chunks WHERE uploadId=? ORDER BY offset").all(uploadId) as ChunkRow[];
      async function* parts() {
        let next = 0;
        for (const chunk of chunks) {
          checkLease(actor, row, lease);
          if (chunk.offset !== next) throw new MigrationError("MIGRATION_UPLOAD_INCOMPLETE", "上传分块记录不连续", 409);
          next += chunk.size;
          yield* fs.createReadStream(partPath(row, chunk.offset));
        }
        if (next !== row.size) throw new MigrationError("MIGRATION_UPLOAD_INCOMPLETE", "上传分块记录不完整", 409);
      }
      await pipeline(Readable.from(parts()), fs.createWriteStream(assembled, { flags: "wx", mode: 0o600 }));
      if (fs.statSync(assembled).size !== row.size || await hashMigrationFile(assembled) !== row.sha256) throw new MigrationError("MIGRATION_UPLOAD_HASH", "完整文件校验失败，请取消此上传并重新选择文件", 409);
      if (row.assetPath) await sniffMigrationAsset(assembled, row.assetPath);
      checkLease(actor, row, lease);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
      getDb().prepare("UPDATE migration_upload_sessions SET publishedIdentity=? WHERE id=? AND leaseId=?").run(fileIdentity(assembled), uploadId, lease);
      try {
        await fs.promises.link(assembled, finalPath);
        getDb().prepare("UPDATE migration_upload_sessions SET published=1 WHERE id=? AND leaseId=?").run(uploadId, lease);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (!fs.lstatSync(finalPath).isFile() || fs.lstatSync(finalPath).isSymbolicLink() || fs.statSync(finalPath).size !== row.size || await hashMigrationFile(finalPath) !== row.sha256) throw new MigrationError("MIGRATION_UPLOAD_HASH", "目标文件校验失败，原有文件已保留", 409);
    if (row.assetPath) await sniffMigrationAsset(finalPath, row.assetPath);
    checkLease(actor, row, lease);
    fs.rmSync(assembled, { force: true });
    fs.rmSync(path.join(sessionDirectory(row), "chunks"), { recursive: true, force: true });
    getDb().transaction(() => {
      checkLease(actor, row, lease);
      if (row.assetPath) {
        registerMigrationAsset(actor, jobId, row.assetPath, row.sha256, row.size);
        failMigrationUpload(actor, jobId);
      } else finishMigrationUpload(actor, jobId, { filename: row.filename, path: relative, uploadId });
      getDb().prepare("UPDATE migration_upload_sessions SET status='COMPLETE',updatedAt=datetime('now') WHERE id=? AND leaseId=?").run(uploadId, lease);
    })();
    return getMigration(actor, jobId);
  } finally { fs.rmSync(assembled, { force: true }); release(uploadId, lease); }
}

const pending = new Set<string>();
let finalizerRunning = false;
function queue(uploadId: string): void {
  pending.add(uploadId);
  if (finalizerRunning) return;
  finalizerRunning = true;
  setImmediate(() => { void (async () => {
    try {
      while (pending.size) {
        const id = pending.values().next().value!; pending.delete(id);
        const row = getDb().prepare("SELECT * FROM migration_upload_sessions WHERE id=?").get(id) as SessionRow | undefined;
        if (!row || row.status !== "FINALIZING") continue;
        const job = getDb().prepare("SELECT userId,status FROM migration_jobs WHERE id=?").get(row.jobId) as { userId: string; status: MigrationStatus };
        try { await finalize(row, { userId: job.userId, tokenId: row.finalizeTokenId || row.tokenId }); }
        catch (error) {
          if (error instanceof MigrationError && error.code === "MIGRATION_UPLOAD_BUSY") { setTimeout(() => queue(id), 1000).unref(); continue; }
          const latest = getDb().prepare("SELECT status FROM migration_jobs WHERE id=?").get(row.jobId) as { status: string };
          const code = error instanceof MigrationError ? error.code : "MIGRATION_UPLOAD_FINALIZE_FAILED";
          getDb().prepare("UPDATE migration_upload_sessions SET status=?,error=?,leaseId=NULL,leaseExpiresAt=NULL WHERE id=? AND status='FINALIZING'")
            .run(latest.status === "CANCELLED" ? "CANCELLED" : "FAILED", code, id);
          getDb().prepare("UPDATE migration_jobs SET status='FAILED',error=?,updatedAt=datetime('now') WHERE id=? AND status='UPLOADING'").run(code, row.jobId);
          removeUncommittedFiles(rowFor(row.jobId, id));
        }
      }
    } finally { finalizerRunning = false; }
  })(); });
}

export function completeMigrationUploadSession(actor: MigrationActor, jobId: string, uploadId: string) {
  const row = readOwned(actor, jobId, uploadId);
  if (row.status === "COMPLETE") return getMigration(actor, jobId);
  checkWrite(actor, row, ["CREATED", "UPLOADING"]);
  if (!["OPEN", "FINALIZING"].includes(row.status) || row.offset !== row.size) throw new MigrationError("MIGRATION_UPLOAD_INCOMPLETE", "文件尚未上传完整", 409);
  getDb().transaction(() => {
    if (row.status === "OPEN") getDb().prepare("UPDATE migration_upload_sessions SET status='FINALIZING',finalizeTokenId=? WHERE id=? AND status='OPEN'").run(actor.tokenId || null, uploadId);
    if (getMigration(actor, jobId).status === "CREATED") beginMigrationUpload(actor, jobId);
  })();
  queue(uploadId);
  return getMigration(actor, jobId);
}

function removeUncommittedFiles(row: SessionRow): void {
  fs.rmSync(sessionDirectory(row), { recursive: true, force: true });
  const relative = destination(row);
  const committed = row.assetPath
    ? getDb().prepare("SELECT 1 FROM migration_assets WHERE jobId=? AND path=?").get(row.jobId, relative)
    : getDb().prepare("SELECT 1 FROM migration_uploads WHERE id=? AND jobId=?").get(row.id, row.jobId);
  const target = path.join(migrationJobDirectory(row.jobId), relative);
  if (!committed && fs.existsSync(target) && (!row.assetPath || (row.publishedIdentity && fileIdentity(target) === row.publishedIdentity))) fs.rmSync(target, { force: true });
}
export function cancelMigrationUploadSession(actor: MigrationActor, jobId: string, uploadId: string) {
  const row = readOwned(actor, jobId, uploadId);
  if (row.status === "COMPLETE") throw new MigrationError("MIGRATION_UPLOAD_STATE", "文件已进入迁移任务，请通过任务操作取消", 409);
  const job = getMigration(actor, jobId); assertMigrationUploadAccess(actor, jobId, [job.status]);
  if (["CANCELLED", "EXPIRED", "FAILED"].includes(row.status)) {
    getDb().prepare("UPDATE migration_upload_sessions SET status='CANCELLED' WHERE id=?").run(uploadId);
    return snapshot(rowFor(jobId, uploadId));
  }
  getDb().prepare("UPDATE migration_upload_sessions SET status='CANCELLED',leaseId=NULL,leaseExpiresAt=NULL WHERE id=?").run(uploadId);
  if (job.status === "UPLOADING") failMigrationUpload(actor, jobId);
  removeUncommittedFiles(row); return snapshot(rowFor(jobId, uploadId));
}
export function recoverMigrationUploadSessions(): void {
  // Handoff and COMPLETE are committed together. This also repairs old interrupted finalizers.
  getDb().prepare(`UPDATE migration_upload_sessions SET status='COMPLETE',leaseId=NULL,leaseExpiresAt=NULL
    WHERE status='FINALIZING' AND EXISTS(SELECT 1 FROM migration_uploads u WHERE u.id=migration_upload_sessions.id AND u.jobId=migration_upload_sessions.jobId)`).run();
  const rows = getDb().prepare(`SELECT s.* FROM migration_upload_sessions s JOIN migration_jobs j ON j.id=s.jobId
    WHERE s.status IN ('OPEN','FINALIZING') AND (s.expiresAt<=? OR j.status IN ('CANCELLED','UNDONE','COMPLETED','PARTIAL','FAILED'))`).all(new Date().toISOString()) as SessionRow[];
  for (const row of rows) {
    getDb().prepare("UPDATE migration_upload_sessions SET status=?,leaseId=NULL,leaseExpiresAt=NULL WHERE id=?").run(Date.parse(row.expiresAt) <= Date.now() ? "EXPIRED" : "CANCELLED", row.id);
    removeUncommittedFiles(row);
  }
  const unfinished = getDb().prepare("SELECT s.*,j.userId,j.status AS jobStatus FROM migration_upload_sessions s JOIN migration_jobs j ON j.id=s.jobId WHERE s.status='FINALIZING' AND s.expiresAt>?").all(new Date().toISOString()) as (SessionRow & { userId: string; jobStatus: MigrationStatus })[];
  for (const row of unfinished) {
    try {
      if (row.jobStatus === "CREATED") beginMigrationUpload({ userId: row.userId, tokenId: row.finalizeTokenId || row.tokenId }, row.jobId);
      queue(row.id);
    } catch (error) {
      const code = error instanceof MigrationError ? error.code : "MIGRATION_UPLOAD_FINALIZE_FAILED";
      getDb().prepare("UPDATE migration_upload_sessions SET status='FAILED',error=?,leaseId=NULL,leaseExpiresAt=NULL WHERE id=?").run(code, row.id);
      getDb().prepare("UPDATE migration_jobs SET status='FAILED',error=? WHERE id=? AND status IN ('CREATED','UPLOADING')").run(code, row.jobId);
      removeUncommittedFiles(rowFor(row.jobId, row.id));
    }
  }
}
