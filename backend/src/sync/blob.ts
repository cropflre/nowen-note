// backend/src/sync/blob.ts
//
// 附件二进制的客户端传输层（阶段 H）。
//
// 与 metadata 的分工：
//   metadata（filename 等）走 Sync V2 的 push/pull —— 小、频繁、需要冲突检测；
//   binary  走本模块的独立通道         —— 大、一次性、只需要幂等与校验。
//
// 两者独立重试。一个 20MB 的附件传输失败，不该让同批次的 50 条笔记修改
// 一起卡住；反过来一次冲突也不该让已经传了 18MB 的附件重头再来。
//
// 顺序约束：**元数据必须先于二进制**。
//   服务端 PUT /blob/:id 要求 attachments 行已存在（applyAttachment 也是同样要求），
//   否则会产生一个无人引用的孤儿文件。因此上传器只处理 metadata 已 synced 的条目。

import crypto from "node:crypto";
import type Database from "better-sqlite3";

import { SYNC_V2_BLOB_PATH } from "./constants";
import { parseSyncScopeKey } from "./scope";
import { SyncError, classifyHttpStatus } from "./errors";
import { logSyncInfo, logSyncWarn } from "./log";
import type { RemoteCredentials } from "./remote";
import {
  listPendingDownloads,
  listPendingUploads,
  markAttachmentDownloaded,
  markUploadFailed,
  markUploaded,
  markUploading,
} from "./attachments";
import {
  readAttachmentObject,
  writeAttachmentObject,
  ensureAttachmentsDir,
  getUploadMonthPath,
} from "../services/attachment-storage";

/** 单轮处理的附件数量上限。 */
const DEFAULT_BATCH = 4;

/**
 * 并发上限。
 *
 * 刻意保守：附件动辄数 MB，同时开 10 个连接会把用户的上行带宽吃光，
 * 导致笔记正文的同步（真正影响体验的部分）被饿死。
 */
const DEFAULT_CONCURRENCY = 2;

export interface BlobClientOptions {
  serverUrl: string;
  credential: RemoteCredentials;
  /** 单次请求超时；附件大所以远比 JSON 请求宽松。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface BlobTransferResult {
  uploaded: number;
  downloaded: number;
  failed: number;
  skipped: number;
}

/** 远端二进制通道客户端。 */
export class SyncBlobClient {
  private readonly base: string;
  private readonly credential: RemoteCredentials;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BlobClientOptions) {
    this.base = options.serverUrl.replace(/\/+$/, "");
    this.credential = options.credential;
    // 60s：20MB 在 3Mbps 上行下约需 55s，太短会让大附件永远传不完。
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(attachmentId: string, scopeKey: string): string {
    return `${this.base}${SYNC_V2_BLOB_PATH}/${encodeURIComponent(attachmentId)}?scopeKey=${encodeURIComponent(scopeKey)}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credential.token}`,
      ...(extra || {}),
    };
  }

  private async request(
    attachmentId: string,
    init: RequestInit,
    scopeKey = "personal",
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.url(attachmentId, scopeKey), {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      // 断网与超时都归为可重试的网络错误：本地数据不受影响，
      // 下一轮同步会自然重试。
      throw new SyncError(
        "NETWORK_UNAVAILABLE",
        `附件传输失败: ${(error as Error)?.message || error}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 探测远端是否已有该二进制，避免重复上传（hash 去重下很常见）。 */
  async exists(attachmentId: string, scopeKey = "personal"): Promise<boolean> {
    const res = await this.request(
      attachmentId,
      { method: "HEAD", headers: this.headers() },
      scopeKey,
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new SyncError(classifyHttpStatus(res.status), `HEAD 失败: ${res.status}`);
  }

  /** 上传二进制。幂等：重复上传只是覆盖同一内容。 */
  async upload(
    attachmentId: string,
    buffer: Buffer,
    mimeType?: string,
    scopeKey = "personal",
  ): Promise<void> {
    const res = await this.request(attachmentId, {
      method: "PUT",
      headers: this.headers({
        "Content-Type": mimeType || "application/octet-stream",
      }),
      body: new Uint8Array(buffer),
    }, scopeKey);
    if (res.ok) return;

    const text = await res.text().catch(() => "");
    // 校验失败不可重试：重传同样的坏内容只会一直失败。
    if (res.status === 409 && text.includes("CHECKSUM_MISMATCH")) {
      throw new SyncError("VALIDATION_FAILED", "附件内容校验失败");
    }
    throw new SyncError(classifyHttpStatus(res.status), `上传失败: ${res.status}`);
  }

  /** 下载二进制。 */
  async download(
    attachmentId: string,
    scopeKey = "personal",
  ): Promise<{ buffer: Buffer; hash: string | null }> {
    const res = await this.request(
      attachmentId,
      { method: "GET", headers: this.headers() },
      scopeKey,
    );
    if (res.status === 409) {
      // 对端还没上传：这不是错误，只是还没准备好。
      throw new SyncError("BLOB_NOT_READY", "远端附件二进制尚未就绪");
    }
    if (!res.ok) {
      throw new SyncError(classifyHttpStatus(res.status), `下载失败: ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, hash: res.headers.get("X-Blob-Hash") };
  }
}

/**
 * 以受限并发执行任务。
 *
 * 不用 Promise.all 一把梭：那会同时打开全部连接。
 */
async function runLimited<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

interface AttachmentMetaRow {
  id: string;
  path: string | null;
  mimeType: string | null;
  filename: string | null;
  hash: string | null;
  size: number | null;
  workspaceId: string | null;
}

function loadMeta(db: Database.Database, attachmentId: string): AttachmentMetaRow | undefined {
  return db.prepare(`
    SELECT a.id, a.path, a.mimeType, a.filename, a.hash, a.size, n.workspaceId
      FROM attachments a JOIN notes n ON n.id = a.noteId WHERE a.id = ?
  `).get(attachmentId) as AttachmentMetaRow | undefined;
}

/**
 * 推送待上传的附件二进制。
 *
 * 失败只累加 retryCount，**永不删除本地附件**：
 * 同步不成功和"用户不再需要这个文件"是两件完全不同的事。
 */
export async function pushAttachmentBlobs(
  db: Database.Database,
  client: SyncBlobClient,
  options: { batchSize?: number; concurrency?: number; scopeKey?: string } = {},
): Promise<BlobTransferResult> {
  const expectedWorkspace = parseSyncScopeKey(options.scopeKey || "personal").workspaceId;
  const rows = listPendingUploads(db,options.batchSize ?? DEFAULT_BATCH,expectedWorkspace);
  const result: BlobTransferResult = { uploaded: 0, downloaded: 0, failed: 0, skipped: 0 };
  if (rows.length === 0) return result;

  await runLimited(rows, options.concurrency ?? DEFAULT_CONCURRENCY, async (row) => {
    const meta = loadMeta(db, row.attachmentId);
    if (!meta || !meta.path) {
      // 元数据缺失说明附件已被删除（FK CASCADE 会清掉状态行），
      // 或元数据还没同步过来。跳过而非标失败：不是传输问题。
      result.skipped += 1;
      return;
    }
    if (meta.workspaceId !== expectedWorkspace) {
      result.skipped += 1;
      return;
    }

    markUploading(db, row.attachmentId);
    try {
      // 先探测：hash 去重下服务端常已有同一份内容，省去整个上传。
      if (await client.exists(row.attachmentId, options.scopeKey)) {
        markUploaded(db, row.attachmentId);
        result.skipped += 1;
        return;
      }

      const buffer = await readAttachmentObject(meta.path);
      if (!buffer || buffer.length === 0) {
        // 本地文件不见了：标失败保留记录，不静默丢弃。
        markUploadFailed(db, row.attachmentId, "LOCAL_BLOB_MISSING");
        result.failed += 1;
        return;
      }

      await client.upload(
        row.attachmentId,
        buffer,
        meta.mimeType || undefined,
        options.scopeKey,
      );
      markUploaded(db, row.attachmentId);
      result.uploaded += 1;
    } catch (error) {
      const code = error instanceof SyncError ? error.code : "SERVER_ERROR";
      markUploadFailed(db, row.attachmentId, code);
      result.failed += 1;
      logSyncWarn("blob.upload-failed", { entityId: row.attachmentId, errorCode: code });
    }
  });

  if (result.uploaded > 0 || result.failed > 0) {
    logSyncInfo("blob.push-done", {
      pushCount: result.uploaded,
      retryCount: result.failed,
    });
  }
  return result;
}

/**
 * 拉取远端已有、本地缺失的附件二进制。
 *
 * 下载完成才置 remoteOnly=0 —— 在此之前 UI 应显示"正在获取"而不是破图。
 */
export async function pullAttachmentBlobs(
  db: Database.Database,
  client: SyncBlobClient,
  options: { batchSize?: number; concurrency?: number; scopeKey?: string } = {},
): Promise<BlobTransferResult> {
  const expectedWorkspace = parseSyncScopeKey(options.scopeKey || "personal").workspaceId;
  const rows = listPendingDownloads(db,options.batchSize ?? DEFAULT_BATCH,expectedWorkspace);
  const result: BlobTransferResult = { uploaded: 0, downloaded: 0, failed: 0, skipped: 0 };
  if (rows.length === 0) return result;

  await runLimited(rows, options.concurrency ?? DEFAULT_CONCURRENCY, async (row) => {
    const meta = loadMeta(db, row.attachmentId);
    if (!meta) {
      result.skipped += 1;
      return;
    }
    if (meta.workspaceId !== expectedWorkspace) {
      result.skipped += 1;
      return;
    }

    try {
      const { buffer, hash } = await client.download(row.attachmentId, options.scopeKey);

      // 完整性校验：元数据带 hash 就必须对得上。
      // 宁可重试也不写入损坏内容 —— 坏文件无法自愈，而重试是免费的。
      const expected = meta.hash || hash;
      if (expected) {
        const actual = crypto.createHash("sha256").update(buffer).digest("hex");
        if (actual !== expected) {
          markUploadFailed(db, row.attachmentId, "CHECKSUM_MISMATCH");
          result.failed += 1;
          return;
        }
      }

      // path 可能为空（元数据先于二进制同步过来），此时分配本地路径。
      let relPath = meta.path;
      if (!relPath) {
        const dot = (meta.filename || "").lastIndexOf(".");
        const ext = dot > 0 ? (meta.filename as string).slice(dot + 1) : "bin";
        relPath = `${getUploadMonthPath()}/${row.attachmentId}.${ext}`;
      }

      ensureAttachmentsDir();
      await writeAttachmentObject(relPath, buffer, meta.mimeType || undefined);

      // 落盘成功后才更新元数据与状态，顺序不能颠倒：
      // 先置 available 再写盘，中途崩溃会让 UI 以为图片已就绪。
      db.prepare(`
        UPDATE attachments
           SET path = ?, size = ?, hash = COALESCE(hash, ?)
         WHERE id = ?
      `).run(
        relPath,
        buffer.length,
        crypto.createHash("sha256").update(buffer).digest("hex"),
        row.attachmentId,
      );
      markAttachmentDownloaded(db, row.attachmentId);
      result.downloaded += 1;
    } catch (error) {
      const code = error instanceof SyncError ? error.code : "SERVER_ERROR";
      if (code === "BLOB_NOT_READY") {
        // 对端还没上传，不算失败，下一轮再试。
        result.skipped += 1;
        return;
      }
      markUploadFailed(db, row.attachmentId, code);
      result.failed += 1;
      logSyncWarn("blob.download-failed", { entityId: row.attachmentId, errorCode: code });
    }
  });

  if (result.downloaded > 0 || result.failed > 0) {
    logSyncInfo("blob.pull-done", {
      applyCount: result.downloaded,
      retryCount: result.failed,
    });
  }
  return result;
}
