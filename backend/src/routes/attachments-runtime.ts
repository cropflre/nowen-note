import crypto from "node:crypto";
import path from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import { v4 as uuid } from "uuid";

import type { DatabaseAdapter } from "../db/adapters/types";
import { computeAttachmentEtag, requestMatchesEtag } from "../lib/attachment-etag";
import {
  createAttachmentSignedUrl,
  createUserAttachmentScope,
  verifyAttachmentSignatureEnvelope,
} from "../lib/attachment-signed-url-core";
import { verifyLoginToken } from "../lib/auth-security";
import { inferVideoMime } from "../lib/media-mime";
import { createAttachmentCapabilitiesRuntime } from "../services/attachment-capabilities-runtime";
import {
  createAttachmentStorageRuntime,
  type AttachmentStorageRuntimeOptions,
} from "../services/attachment-storage-runtime";

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
};

const BLOCKED_MIMES = new Set([
  "application/x-msdownload",
  "application/x-ms-installer",
  "application/x-ms-shortcut",
  "application/x-bat",
  "application/x-sh",
  "application/hta",
  "application/x-executable",
  "application/x-elf",
]);

const HIGH_RISK_MIMES = new Set([
  "text/html",
  "text/xml",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
]);

type AttachmentRow = {
  id: string;
  noteId: string;
  userId: string;
  workspaceId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string | null;
};

export interface AttachmentHttpRuntimeOptions extends AttachmentStorageRuntimeOptions {
  maxSizeBytes?: number;
}

function maxAttachmentSize(options?: AttachmentHttpRuntimeOptions): number {
  if (Number.isFinite(options?.maxSizeBytes) && Number(options?.maxSizeBytes) > 0) {
    return Number(options!.maxSizeBytes);
  }
  const envMb = Number.parseInt(process.env.MAX_ATTACHMENT_SIZE_MB || "", 10);
  if (Number.isFinite(envMb) && envMb > 0 && envMb <= 10_240) return envMb * 1024 * 1024;
  return 100 * 1024 * 1024;
}

function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has((mime || "").toLowerCase());
}

function isHighRiskMime(mime: string): boolean {
  return HIGH_RISK_MIMES.has((mime || "").toLowerCase().split(";", 1)[0].trim());
}

function pickExt(filename: string, mime: string): string {
  const raw = path.extname(filename || "").replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(raw)) return raw;
  return MIME_TO_EXT[mime] || "bin";
}

function uploadMonthPath(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}/${month}`;
}

function contentDisposition(filename: string): string {
  const safe = (filename || "attachment")
    .replace(/[\r\n"\\]/g, "_")
    .slice(0, 180);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename || "attachment")}`;
}

function noStoreJson(
  c: Context,
  payload: unknown,
  status: 200 | 201 | 400 | 401 | 403 | 404 | 413 | 415 | 500 = 200,
): Response {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
  return c.json(payload, status);
}

async function verifiedBearerUser(adapter: DatabaseAdapter, c: Context): Promise<string> {
  const authorization = c.req.header("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return "";
  const payload = verifyLoginToken(authorization.slice(7).trim());
  if (!payload?.userId) return "";

  const user = await adapter.queryOne<{
    tokenVersion: number;
    isDisabled: boolean | number;
  }>(
    `SELECT "tokenVersion" AS "tokenVersion", "isDisabled" AS "isDisabled"
       FROM users WHERE id = ?`,
    [payload.userId],
  );
  if (!user || user.isDisabled === true || user.isDisabled === 1) return "";
  if ((payload.tver ?? 0) !== (user.tokenVersion ?? 0)) return "";

  if (payload.jti) {
    const session = await adapter.queryOne<{
      revokedAt: string | Date | null;
      expiresAt: string | Date | null;
    }>(
      `SELECT "revokedAt" AS "revokedAt", "expiresAt" AS "expiresAt"
         FROM user_sessions WHERE id = ? AND "userId" = ?`,
      [payload.jti, payload.userId],
    );
    if (!session || session.revokedAt) return "";
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) return "";
  }

  return payload.userId;
}

function parseRange(raw: string | undefined, size: number): { start: number; end: number } | null {
  if (!raw || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match) return null;
  if (!match[1] && !match[2]) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function findAttachment(adapter: DatabaseAdapter, id: string): Promise<AttachmentRow | undefined> {
  return adapter.queryOne<AttachmentRow>(
    `SELECT id,
            "noteId" AS "noteId",
            "userId" AS "userId",
            "workspaceId" AS "workspaceId",
            filename,
            "mimeType" AS "mimeType",
            size,
            path,
            hash
       FROM attachments
      WHERE id = ?`,
    [id],
  );
}

function buildUserAccessUrl(
  attachmentId: string,
  userId: string,
  noteId: string,
  allowDownload: boolean,
): string {
  return createAttachmentSignedUrl(
    `/api/attachments/${attachmentId}`,
    attachmentId,
    createUserAttachmentScope(userId, noteId, allowDownload),
  );
}

/**
 * Pre-auth attachment handler. Native <img>/<video> requests use signed URLs because they do not
 * carry Authorization. Bearer downloads remain supported for SDK/API clients.
 */
export async function handleAttachmentDownloadRuntime(
  c: Context,
  adapter: DatabaseAdapter,
  options: AttachmentHttpRuntimeOptions = {},
): Promise<Response> {
  const id = c.req.param("id");
  const row = await findAttachment(adapter, id);
  if (!row) return c.json({ error: "附件不存在", code: "ATTACHMENT_NOT_FOUND" }, 404);

  const capabilitiesRuntime = createAttachmentCapabilitiesRuntime(adapter);
  const exp = c.req.query("exp");
  const sig = c.req.query("sig");
  const rawScope = c.req.query("scope");
  const hasAnySignaturePart = Boolean(exp || sig || rawScope);
  const hasCompleteSignature = Boolean(exp && sig && rawScope);

  let allowDownload = true;
  if (hasAnySignaturePart) {
    if (!hasCompleteSignature) {
      return c.json({ error: "附件访问签名不完整", code: "INVALID_SIGNATURE" }, 403);
    }
    const envelope = verifyAttachmentSignatureEnvelope(id, exp!, sig!, rawScope!);
    if (!envelope.valid) {
      return c.json({
        error: "签名无效或已过期",
        code: "INVALID_SIGNATURE",
        reason: envelope.reason,
      }, 403);
    }
    const scope = envelope.scope;
    if (!scope || scope.kind !== "user") {
      return c.json({
        error: "该附件访问来源尚未迁移到 PostgreSQL runtime",
        code: "POSTGRES_ATTACHMENT_SCOPE_PENDING",
      }, 403);
    }
    if (scope.noteId !== row.noteId) {
      return c.json({ error: "附件签名与笔记不匹配", code: "ATTACHMENT_ACCESS_REVOKED" }, 403);
    }
    const capabilities = await capabilitiesRuntime.resolve(row.noteId, scope.subjectId);
    if (!capabilities.read) {
      return c.json({ error: "您已无权访问该附件", code: "ATTACHMENT_ACCESS_REVOKED" }, 403);
    }
    allowDownload = scope.allowDownload && capabilities.download;
  } else {
    const userId = await verifiedBearerUser(adapter, c);
    if (!userId) {
      // Do not restore the historical UUID-as-capability behavior in PostgreSQL mode.
      return c.json({ error: "附件不存在", code: "ATTACHMENT_NOT_FOUND" }, 404);
    }
    const capabilities = await capabilitiesRuntime.resolve(row.noteId, userId);
    if (!capabilities.read) {
      return c.json({ error: "无权访问该附件", code: "ATTACHMENT_ACCESS_DENIED" }, 403);
    }
    allowDownload = capabilities.download;
  }

  const forceDownload = /^(?:1|true|yes)$/i.test(c.req.query("download") || "");
  if (forceDownload && !allowDownload) {
    return c.json({ error: "当前权限不允许下载附件", code: "ATTACHMENT_DOWNLOAD_FORBIDDEN" }, 403);
  }

  const etag = computeAttachmentEtag(row.id, "original");
  if (requestMatchesEtag(new Headers(c.req.raw.headers), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        "Cache-Control": "private, no-cache, must-revalidate, no-transform",
        ETag: etag,
        Vary: "Authorization",
      },
    });
  }

  const storage = createAttachmentStorageRuntime(adapter, options);
  const buffer = await storage.readObject(row.path);
  if (!buffer) return c.json({ error: "attachment file missing", code: "ATTACHMENT_FILE_MISSING" }, 404);

  const mimeType = row.mimeType || "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": mimeType,
    "Cache-Control": "private, no-cache, must-revalidate, no-transform",
    ETag: etag,
    Vary: "Authorization",
    "Accept-Ranges": "bytes",
  };

  const highRisk = isHighRiskMime(mimeType);
  const inlinePreview = c.req.query("inline") === "1";
  if (highRisk || ((!isImageMime(mimeType) || forceDownload) && !(inlinePreview && !forceDownload))) {
    headers["Content-Disposition"] = contentDisposition(row.filename);
    if (highRisk) headers["X-Content-Type-Options"] = "nosniff";
  }

  const range = parseRange(c.req.header("Range"), buffer.length);
  if (c.req.header("Range") && !range) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${buffer.length}`,
      },
    });
  }
  if (range) {
    const chunk = buffer.subarray(range.start, range.end + 1);
    return new Response(chunk as BodyInit, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${range.start}-${range.end}/${buffer.length}`,
      },
    });
  }

  headers["Content-Length"] = String(buffer.length);
  return new Response(buffer as BodyInit, { status: 200, headers });
}

/** Authenticated attachment operations mounted after the shared PostgreSQL JWT middleware. */
export function createAttachmentsRuntimeRouter(
  adapter: DatabaseAdapter,
  options: AttachmentHttpRuntimeOptions = {},
) {
  const app = new Hono();
  const capabilitiesRuntime = createAttachmentCapabilitiesRuntime(adapter);
  const storage = createAttachmentStorageRuntime(adapter, options);

  app.get("/access/urls", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    const noteId = (c.req.query("noteId") || "").trim();
    if (!noteId) return noStoreJson(c, { error: "缺少 noteId", code: "NOTE_ID_REQUIRED" }, 400);

    const capabilities = await capabilitiesRuntime.resolve(noteId, userId);
    if (!capabilities.read) {
      return noStoreJson(c, {
        error: "无权访问该笔记的附件",
        code: "ATTACHMENT_ACCESS_DENIED",
      }, 403);
    }

    const rows = await adapter.queryMany<{ id: string }>(
      `SELECT id FROM attachments WHERE "noteId" = ? ORDER BY id ASC`,
      [noteId],
    );
    const urls: Record<string, string> = {};
    for (const row of rows) {
      urls[row.id] = buildUserAccessUrl(
        row.id,
        userId,
        noteId,
        capabilities.download,
      );
    }
    return noStoreJson(c, { noteId, urls });
  });

  app.post("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody() as Record<string, string | File>;
    } catch {
      return noStoreJson(c, { error: "invalid multipart body" }, 400);
    }

    const file = body.file;
    const noteId = typeof body.noteId === "string" ? body.noteId.trim() : "";
    if (!(file instanceof File)) return noStoreJson(c, { error: "file 字段缺失或非文件" }, 400);
    if (!noteId) return noStoreJson(c, { error: "noteId 必传" }, 400);

    const capabilities = await capabilitiesRuntime.resolve(noteId, userId);
    if (!capabilities.write) {
      return noStoreJson(c, { error: "无权向该笔记上传附件", code: "FORBIDDEN" }, 403);
    }

    const sizeLimit = maxAttachmentSize(options);
    if (file.size > sizeLimit) {
      return noStoreJson(c, { error: `文件过大（最大 ${sizeLimit / 1024 / 1024}MB）` }, 413);
    }

    let mimeType = (file.type || "application/octet-stream").toLowerCase();
    if (mimeType === "application/octet-stream") {
      mimeType = inferVideoMime(file.name || "") || mimeType;
    }
    if (BLOCKED_MIMES.has(mimeType)) {
      return noStoreJson(c, { error: `出于安全考虑，不支持该类型: ${mimeType}` }, 415);
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (error: any) {
      return noStoreJson(c, { error: `读取上传内容失败: ${error?.message || error}` }, 500);
    }

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const workspaceId = capabilities.workspaceId;
    const dedup = workspaceId
      ? await adapter.queryOne<AttachmentRow>(
          `SELECT id, "noteId" AS "noteId", "userId" AS "userId",
                  "workspaceId" AS "workspaceId", filename,
                  "mimeType" AS "mimeType", size, path, hash
             FROM attachments
            WHERE "userId" = ? AND "workspaceId" = ? AND hash = ?
            ORDER BY "createdAt" ASC LIMIT 1`,
          [userId, workspaceId, sha256],
        )
      : await adapter.queryOne<AttachmentRow>(
          `SELECT id, "noteId" AS "noteId", "userId" AS "userId",
                  "workspaceId" AS "workspaceId", filename,
                  "mimeType" AS "mimeType", size, path, hash
             FROM attachments
            WHERE "userId" = ? AND "workspaceId" IS NULL AND hash = ?
            ORDER BY "createdAt" ASC LIMIT 1`,
          [userId, sha256],
        );

    const id = uuid();
    if (dedup) {
      const filename = file.name || dedup.filename || `${id}.bin`;
      await adapter.execute(
        `INSERT INTO attachments (
           id, "noteId", "userId", filename, "mimeType", size, path, "workspaceId", hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          noteId,
          userId,
          filename,
          dedup.mimeType,
          dedup.size,
          dedup.path,
          workspaceId,
          sha256,
        ],
      );
      return noStoreJson(c, {
        id,
        url: `/api/attachments/${id}`,
        mimeType: dedup.mimeType,
        size: dedup.size,
        filename,
        category: isImageMime(dedup.mimeType) ? "image" : "file",
        deduplicated: true,
        accessUrls: {
          [id]: buildUserAccessUrl(id, userId, noteId, capabilities.download),
        },
      }, 201);
    }

    const ext = pickExt(file.name, mimeType);
    const storagePath = `${uploadMonthPath()}/${id}.${ext}`;
    try {
      await storage.writeObject(storagePath, buffer, mimeType);
    } catch (error: any) {
      return noStoreJson(c, { error: `写入文件失败: ${error?.message || error}` }, 500);
    }

    try {
      await adapter.execute(
        `INSERT INTO attachments (
           id, "noteId", "userId", filename, "mimeType", size, path, "workspaceId", hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          noteId,
          userId,
          file.name || `${id}.${ext}`,
          mimeType,
          file.size,
          storagePath,
          workspaceId,
          sha256,
        ],
      );
    } catch (error: any) {
      await storage.deleteObject(storagePath).catch(() => {});
      return noStoreJson(c, { error: `写入数据库失败: ${error?.message || error}` }, 500);
    }

    return noStoreJson(c, {
      id,
      url: `/api/attachments/${id}`,
      mimeType,
      size: file.size,
      filename: file.name || storagePath,
      category: isImageMime(mimeType) ? "image" : "file",
      accessUrls: {
        [id]: buildUserAccessUrl(id, userId, noteId, capabilities.download),
      },
    }, 201);
  });

  app.delete("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    const row = await findAttachment(adapter, c.req.param("id"));
    if (!row) return c.json({ error: "附件不存在" }, 404);

    const capabilities = await capabilitiesRuntime.resolve(row.noteId, userId);
    if (!capabilities.write) {
      return c.json({ error: "无权删除该附件", code: "FORBIDDEN" }, 403);
    }

    const otherReference = await adapter.queryOne<{ id: string }>(
      `SELECT id FROM attachments WHERE path = ? AND id <> ? LIMIT 1`,
      [row.path, row.id],
    );
    await adapter.execute(`DELETE FROM attachments WHERE id = ?`, [row.id]);
    if (!otherReference) await storage.deleteObject(row.path).catch(() => {});
    return c.json({ success: true });
  });

  return app;
}

export default createAttachmentsRuntimeRouter;
