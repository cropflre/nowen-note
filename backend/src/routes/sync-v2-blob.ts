// backend/src/routes/sync-v2-blob.ts
//
// Sync V2 附件二进制通道（阶段 H）。
//
// 为什么不复用 /api/attachments 的上传接口：
//   那个接口是 multipart 且**自己生成 attachmentId**，语义是"用户新建附件"。
//   同步要做的是"把本机已存在的 attachmentId 原样搬到对端"，ID 必须由调用方
//   指定，否则两端 ID 不一致，笔记正文里的引用就会指向不存在的附件。
//
// 为什么不把二进制塞进 Sync V2 的 push：
//   push 是 JSON 协议且一批多条，20MB 的附件 base64 后接近 27MB，
//   一条大附件会把整批 mutation 拖死，失败还得整批重试。
//   因此元数据走 Sync V2、二进制走本通道，两者独立重试。
//
// 端点：
//   PUT  /api/sync/v2/blob/:attachmentId    上传二进制（幂等）
//   GET  /api/sync/v2/blob/:attachmentId    下载二进制
//   HEAD /api/sync/v2/blob/:attachmentId    探测是否已存在（省去重复上传）

import { Hono } from "hono";
import crypto from "node:crypto";
import path from "node:path";

import { getDb } from "../db/schema";
import { isLocalFirstSyncV2Enabled } from "../sync/flag";
import { logSyncInfo, logSyncWarn } from "../sync/log";
import {
  ensureAttachmentsDir,
  getUploadMonthPath,
  readAttachmentObject,
  writeAttachmentObject,
} from "../services/attachment-storage";

const app = new Hono();

/** 单个附件上限，与业务上传保持一致语义（防止同步通道成为绕过限制的后门）。 */
const MAX_BLOB_SIZE = 100 * 1024 * 1024;

interface AttachmentRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  path: string;
  size: number;
  mimeType: string;
  filename: string;
  hash: string | null;
}

/**
 * 统一守卫。
 *
 * Flag 关闭时返回 404 而非 403：不存在"半启用"状态，
 * 对端应当据此判断远端未启用 V2，而不是以为自己没权限。
 */
function guard(c: any): Response | null {
  if (!isLocalFirstSyncV2Enabled()) {
    return c.json({ error: "Sync V2 未启用", code: "SYNC_V2_DISABLED" }, 404);
  }
  const userId = c.req.header("X-User-Id");
  if (!userId) {
    return c.json({ error: "未授权", code: "UNAUTHORIZED" }, 401);
  }
  return null;
}

/**
 * 取附件行并校验归属。
 *
 * 第一版只支持个人空间：工作区附件的 ACL 需要成员资格判定，
 * 属于阶段 K 范围。这里显式拒绝而不是静默按个人空间处理 ——
 * 后者会让客户端误以为工作区附件已同步。
 */
function loadOwnedAttachment(
  attachmentId: string,
  userId: string,
): { row?: AttachmentRow; error?: { message: string; code: string; status: 403 | 404 } } {
  const row = getDb()
    .prepare(`
      SELECT id, userId, workspaceId, path, size, mimeType, filename, hash
        FROM attachments WHERE id = ?
    `)
    .get(attachmentId) as AttachmentRow | undefined;

  if (!row) {
    return { error: { message: "附件不存在", code: "NOT_FOUND", status: 404 } };
  }
  if (row.userId !== userId) {
    // 不区分"不存在"与"不属于你"，避免用 ID 探测他人附件是否存在。
    return { error: { message: "附件不存在", code: "NOT_FOUND", status: 404 } };
  }
  if (row.workspaceId) {
    return {
      error: {
        message: "工作区附件暂不支持二进制同步",
        code: "WORKSPACE_NOT_SUPPORTED",
        status: 403,
      },
    };
  }
  return { row };
}

/**
 * 判断二进制是否已在服务端落地。
 *
 * readAttachmentObject 内部已同时兼容本地盘与对象存储，
 * 这里不再自行分支，避免两条读取路径的行为漂移。
 */
async function blobExists(relPath: string): Promise<boolean> {
  if (!relPath) return false;
  try {
    const buf = await readAttachmentObject(relPath);
    return buf != null && buf.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HEAD：探测是否已存在
// ---------------------------------------------------------------------------

/**
 * 探测远端是否已有该附件二进制。
 *
 * 客户端在上传前先 HEAD 一次：附件常因 hash 去重而在服务端已存在，
 * 直接重传 20MB 是纯粹浪费。返回 200 表示无需上传。
 */
app.on("HEAD", "/:attachmentId", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const userId = c.req.header("X-User-Id") as string;
  const { row, error } = loadOwnedAttachment(c.req.param("attachmentId"), userId);
  if (error) return c.body(null, error.status);

  const exists = await blobExists(row!.path);
  // HEAD 不能带 body，用响应头回传元信息。
  c.header("X-Blob-Size", String(row!.size));
  if (row!.hash) c.header("X-Blob-Hash", row!.hash);
  return c.body(null, exists ? 200 : 404);
});

// ---------------------------------------------------------------------------
// PUT：上传二进制
// ---------------------------------------------------------------------------

/**
 * 上传附件二进制。
 *
 * 幂等：同一 attachmentId 重复上传只是覆盖同一路径的同一内容。
 * 客户端请求超时后无法确认服务端是否成功，必须允许安全重传。
 *
 * 前置条件是元数据行已存在 —— 元数据通过 Sync V2 的 push 先行同步。
 * 顺序不能颠倒：先有二进制没有元数据，等于产生一个无人引用的孤儿文件。
 */
app.put("/:attachmentId", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const userId = c.req.header("X-User-Id") as string;
  const attachmentId = c.req.param("attachmentId");
  const { row, error } = loadOwnedAttachment(attachmentId, userId);
  if (error) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await c.req.arrayBuffer());
  } catch (err) {
    return c.json(
      { error: `读取上传内容失败: ${(err as Error)?.message || err}`, code: "INVALID_PAYLOAD" },
      400,
    );
  }

  if (buffer.length === 0) {
    return c.json({ error: "上传内容为空", code: "INVALID_PAYLOAD" }, 400);
  }
  if (buffer.length > MAX_BLOB_SIZE) {
    return c.json({ error: "附件超出大小上限", code: "PAYLOAD_TOO_LARGE" }, 413);
  }

  // 完整性校验：元数据里有 hash 就必须对得上。
  //
  // 不校验会让"传输中途被截断"表现为"图片打不开"，而用户会以为是数据丢了。
  // 这里宁可拒绝也不写入损坏内容 —— 客户端可以重传，损坏的文件无法自愈。
  const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (row!.hash && row!.hash !== actualHash) {
    logSyncWarn("blob.hash-mismatch", { entityId: attachmentId });
    return c.json(
      { error: "内容校验失败，与元数据记录的哈希不一致", code: "CHECKSUM_MISMATCH" },
      409,
    );
  }
  // size 只警告不拒绝：历史数据可能有 size 记录偏差（例如早期写入路径不一致），
  // 而 hash 一致已足以证明内容正确，因大小字段陈旧拒收会让老附件永远传不上去。
  if (row!.size > 0 && row!.size !== buffer.length) {
    logSyncWarn("blob.size-mismatch", { entityId: attachmentId });
  }

  // path 为空说明元数据是通过同步先建的，此时分配一个新的存储路径。
  let relPath = row!.path;
  if (!relPath) {
    const ext = path.extname(row!.filename || "").replace(/^\./, "") || "bin";
    relPath = `${getUploadMonthPath()}/${attachmentId}.${ext}`;
  }

  try {
    ensureAttachmentsDir();
    await writeAttachmentObject(relPath, buffer, row!.mimeType);
  } catch (err) {
    return c.json(
      { error: `写入失败: ${(err as Error)?.message || err}`, code: "SERVER_ERROR" },
      500,
    );
  }

  // 回填 path / size / hash：这些字段可能因元数据先行同步而缺失。
  getDb().prepare(`
    UPDATE attachments
       SET path = ?, size = ?, hash = COALESCE(hash, ?)
     WHERE id = ? AND userId = ?
  `).run(relPath, buffer.length, actualHash, attachmentId, userId);

  logSyncInfo("blob.uploaded", { entityId: attachmentId });
  return c.json({ attachmentId, size: buffer.length, hash: actualHash, stored: true });
});

// ---------------------------------------------------------------------------
// GET：下载二进制
// ---------------------------------------------------------------------------

/**
 * 下载附件二进制。
 *
 * 返回裸字节流而不是 JSON + base64：base64 膨胀 33%，
 * 而附件是同步流量的主要来源。
 */
app.get("/:attachmentId", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const userId = c.req.header("X-User-Id") as string;
  const attachmentId = c.req.param("attachmentId");
  const { row, error } = loadOwnedAttachment(attachmentId, userId);
  if (error) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }

  let buffer: Buffer | null = null;
  try {
    buffer = row!.path ? await readAttachmentObject(row!.path) : null;
  } catch {
    buffer = null;
  }

  if (!buffer || buffer.length === 0) {
    // 元数据存在但二进制缺失：明确区分于"附件不存在"，
    // 客户端据此知道该等对端上传，而不是把本地记录删掉。
    return c.json({ error: "附件二进制尚未上传", code: "BLOB_NOT_READY" }, 409);
  }

  c.header("Content-Type", row!.mimeType || "application/octet-stream");
  c.header("Content-Length", String(buffer.length));
  if (row!.hash) c.header("X-Blob-Hash", row!.hash);
  // 不回传 row.path —— 那是服务器本机文件系统路径，
  // 对客户端无意义，泄漏还会暴露服务器目录结构。
  return c.body(new Uint8Array(buffer));
});

export default app;
