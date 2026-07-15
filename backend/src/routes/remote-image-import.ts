import { lookup } from "node:dns/promises";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { hasPermission, resolveNotePermission } from "../middleware/acl";
import { enqueueAttachment } from "../services/embedding-worker";
import {
  deleteAttachmentObject,
  getUploadMonthPath,
  writeAttachmentObject,
} from "../services/attachment-storage";
import { createUserAttachmentAccessUrls } from "../lib/attachment-signed-url";
import {
  createDeduplicatedAttachmentRow,
  type ExistingAttachmentForDedup,
} from "./attachments-core";
import {
  isBlockedRemoteAddress,
  isBlockedRemoteHostname,
  normalizeRemoteImageMime,
  REMOTE_IMAGE_MIME_TO_EXT,
  sanitizeRemoteImageFilename,
  sniffRemoteImageMime,
} from "../lib/remote-image-security";

const router = new Hono();
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

class RemoteImageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 408 | 413 | 415 | 502,
  ) {
    super(message);
  }
}

function readPositiveEnv(name: string, fallback: number, max: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

function getRemoteImageMaxBytes(): number {
  return readPositiveEnv("REMOTE_IMAGE_MAX_SIZE_MB", DEFAULT_MAX_BYTES / 1024 / 1024, 100) * 1024 * 1024;
}

function getRemoteImageTimeoutMs(): number {
  return readPositiveEnv("REMOTE_IMAGE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 60_000);
}

async function assertSafeRemoteUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteImageError("仅支持 HTTP/HTTPS 网络图片", "INVALID_REMOTE_IMAGE_URL", 400);
  }
  if (url.username || url.password || isBlockedRemoteHostname(url.hostname)) {
    throw new RemoteImageError("该网络图片地址不允许访问", "REMOTE_IMAGE_SSRF_BLOCKED", 403);
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new RemoteImageError("无法解析网络图片域名", "REMOTE_IMAGE_DNS_FAILED", 502);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedRemoteAddress(address))) {
    throw new RemoteImageError("该网络图片地址解析到了内网或保留地址", "REMOTE_IMAGE_SSRF_BLOCKED", 403);
  }
}

function filenameFromHeaders(headers: Headers, finalUrl: URL, mimeType: string): string {
  const disposition = headers.get("content-disposition") || "";
  let candidate = "";
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { candidate = decodeURIComponent(encoded.trim().replace(/^"|"$/g, "")); } catch { /* ignore */ }
  }
  if (!candidate) {
    candidate = disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
      || disposition.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim()
      || finalUrl.pathname.split("/").pop()
      || "remote-image";
  }
  return sanitizeRemoteImageFilename(candidate, mimeType);
}

async function downloadRemoteImage(rawUrl: string): Promise<{
  buffer: Buffer;
  mimeType: string;
  filename: string;
  finalUrl: string;
}> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new RemoteImageError("网络图片地址无效", "INVALID_REMOTE_IMAGE_URL", 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getRemoteImageTimeoutMs());
  const maxBytes = getRemoteImageMaxBytes();

  try {
    let response: Response | null = null;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertSafeRemoteUrl(current);
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp,image/x-icon;q=0.9,*/*;q=0.1",
          "User-Agent": "Nowen-Note-Remote-Image/1.0",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new RemoteImageError("网络图片重定向次数过多", "REMOTE_IMAGE_REDIRECT_LIMIT", 502);
        }
        current = new URL(location, current);
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      throw new RemoteImageError(`网络图片下载失败${response ? `（HTTP ${response.status}）` : ""}`, "REMOTE_IMAGE_DOWNLOAD_FAILED", 502);
    }

    const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new RemoteImageError(`网络图片过大（最大 ${Math.round(maxBytes / 1024 / 1024)}MB）`, "REMOTE_IMAGE_TOO_LARGE", 413);
    }
    if (!response.body) {
      throw new RemoteImageError("网络图片响应为空", "REMOTE_IMAGE_DOWNLOAD_FAILED", 502);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new RemoteImageError(`网络图片过大（最大 ${Math.round(maxBytes / 1024 / 1024)}MB）`, "REMOTE_IMAGE_TOO_LARGE", 413);
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const sniffedMime = sniffRemoteImageMime(buffer);
    if (!sniffedMime) {
      throw new RemoteImageError("远程响应不是受支持的图片格式", "REMOTE_IMAGE_NOT_IMAGE", 415);
    }

    const declaredMime = normalizeRemoteImageMime(response.headers.get("content-type"));
    if (declaredMime && declaredMime !== "application/octet-stream") {
      if (!declaredMime.startsWith("image/") || !REMOTE_IMAGE_MIME_TO_EXT[declaredMime]) {
        throw new RemoteImageError("远程响应的 Content-Type 不是受支持的图片", "REMOTE_IMAGE_NOT_IMAGE", 415);
      }
      if (normalizeRemoteImageMime(declaredMime) !== normalizeRemoteImageMime(sniffedMime)) {
        throw new RemoteImageError("远程图片声明类型与实际内容不一致", "REMOTE_IMAGE_TYPE_MISMATCH", 415);
      }
    }

    return {
      buffer,
      mimeType: sniffedMime,
      filename: filenameFromHeaders(response.headers, current, sniffedMime),
      finalUrl: current.toString(),
    };
  } catch (error) {
    if (error instanceof RemoteImageError) throw error;
    if ((error as { name?: string })?.name === "AbortError") {
      throw new RemoteImageError("网络图片下载超时", "REMOTE_IMAGE_TIMEOUT", 408);
    }
    throw new RemoteImageError(`网络图片下载失败：${(error as Error)?.message || String(error)}`, "REMOTE_IMAGE_DOWNLOAD_FAILED", 502);
  } finally {
    clearTimeout(timer);
  }
}

router.post("/import-remote-image", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  let body: { noteId?: unknown; url?: unknown; source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求格式错误", code: "INVALID_BODY" }, 400);
  }

  const noteId = typeof body.noteId === "string" ? body.noteId.trim() : "";
  const remoteUrl = typeof body.url === "string" ? body.url.trim() : "";
  const uploadSource = typeof body.source === "string"
    ? body.source.trim().slice(0, 64) || "remote-image"
    : "remote-image";
  if (!noteId || !remoteUrl) {
    return c.json({ error: "noteId 和 url 必传", code: "INVALID_BODY" }, 400);
  }

  const { permission, workspaceId } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "无权修改该笔记", code: "FORBIDDEN" }, 403);
  }

  let downloaded: Awaited<ReturnType<typeof downloadRemoteImage>>;
  try {
    downloaded = await downloadRemoteImage(remoteUrl);
  } catch (error) {
    const failure = error instanceof RemoteImageError
      ? error
      : new RemoteImageError("网络图片下载失败", "REMOTE_IMAGE_DOWNLOAD_FAILED", 502);
    return c.json({ error: failure.message, code: failure.code }, failure.status);
  }

  const db = getDb();
  const hash = crypto.createHash("sha256").update(downloaded.buffer).digest("hex");
  const dedupRow = db.prepare(
    workspaceId
      ? `SELECT id, path, mimeType, size, filename, hash FROM attachments
           WHERE userId = ? AND workspaceId = ? AND hash = ? LIMIT 1`
      : `SELECT id, path, mimeType, size, filename, hash FROM attachments
           WHERE userId = ? AND workspaceId IS NULL AND hash = ? LIMIT 1`,
  ).get(...(workspaceId ? [userId, workspaceId, hash] : [userId, hash])) as ExistingAttachmentForDedup | undefined;

  if (dedupRow) {
    try {
      const clone = createDeduplicatedAttachmentRow({
        source: dedupRow,
        noteId,
        userId,
        workspaceId,
        filename: downloaded.filename,
        hash,
        uploadSource,
      });
      enqueueAttachment({ attachmentId: clone.id, userId, workspaceId, noteId });
      return c.json({
        id: clone.id,
        url: clone.url,
        mimeType: clone.mimeType,
        size: clone.size,
        filename: clone.filename,
        category: "image",
        deduplicated: true,
        sourceUrl: remoteUrl,
        finalUrl: downloaded.finalUrl,
        accessUrls: createUserAttachmentAccessUrls(userId, [{ id: clone.id, noteId }]),
      }, 201);
    } catch (error) {
      return c.json({ error: `写入数据库失败：${(error as Error)?.message || error}` }, 500);
    }
  }

  const id = uuid();
  const ext = REMOTE_IMAGE_MIME_TO_EXT[downloaded.mimeType] || "img";
  const storagePath = `${getUploadMonthPath()}/${id}.${ext}`;
  try {
    await writeAttachmentObject(storagePath, downloaded.buffer, downloaded.mimeType);
  } catch (error) {
    return c.json({ error: `写入附件失败：${(error as Error)?.message || error}` }, 500);
  }

  try {
    db.prepare(
      `INSERT INTO attachments
       (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      noteId,
      userId,
      downloaded.filename,
      downloaded.mimeType,
      downloaded.buffer.byteLength,
      storagePath,
      workspaceId,
      hash,
      uploadSource,
    );
  } catch (error) {
    try { await deleteAttachmentObject(storagePath); } catch { /* best effort */ }
    return c.json({ error: `写入数据库失败：${(error as Error)?.message || error}` }, 500);
  }

  enqueueAttachment({ attachmentId: id, userId, workspaceId, noteId });
  return c.json({
    id,
    url: `/api/attachments/${id}`,
    mimeType: downloaded.mimeType,
    size: downloaded.buffer.byteLength,
    filename: downloaded.filename,
    category: "image",
    deduplicated: false,
    sourceUrl: remoteUrl,
    finalUrl: downloaded.finalUrl,
    accessUrls: createUserAttachmentAccessUrls(userId, [{ id, noteId }]),
  }, 201);
});

export default router;
