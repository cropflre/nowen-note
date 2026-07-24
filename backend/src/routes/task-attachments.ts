/**
 * 任务附件路由（/api/task-attachments）
 *
 * 任务图片使用独立 task_attachments 表和主附件目录。路由只负责 HTTP、权限与
 * 对象存储协调，数据库读写统一委托给异步 Repository。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { v4 as uuid } from "uuid";
import {
  ensureAttachmentsDir,
  MIME_TO_EXT,
  isHighRiskMime,
  encodeContentDispositionFilename,
} from "./attachments";
import {
  deleteAttachmentObject,
  getUploadMonthPath,
  readAttachmentObject,
  writeAttachmentObject,
} from "../services/attachment-storage";
import { getUserWorkspaceRole, canManageResource } from "../middleware/acl";
import {
  taskAttachmentOperationsRepository,
  taskAttachmentsRepository,
} from "../repositories";

const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;

/** 不需要 JWT 的下载 handler，由 index.ts 挂在 JWT 中间件之前。 */
export async function handleDownloadTaskAttachment(c: Context): Promise<Response> {
  const id = c.req.param("id");
  const row = await taskAttachmentsRepository.getByIdAsync(id);
  if (!row) return c.json({ error: "附件不存在" }, 404);

  const buffer = await readAttachmentObject(row.path);
  if (!buffer) return c.json({ error: "attachment file missing" }, 404);

  const headers: Record<string, string> = {
    "Content-Type": row.mimeType || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  if (isHighRiskMime(row.mimeType)) {
    headers["Content-Disposition"] = encodeContentDispositionFilename(row.filename || "");
    headers["X-Content-Type-Options"] = "nosniff";
  }

  return new Response(new Uint8Array(buffer), { headers });
}

const app = new Hono();

/** 上传任务附件。 */
app.post("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";

  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid multipart body" }, 400);
  }

  const file = body.file;
  const taskId = typeof body.taskId === "string" && body.taskId ? body.taskId : null;
  if (!(file instanceof File)) {
    return c.json({ error: "file 字段缺失或非文件" }, 400);
  }

  let effectiveWorkspaceId: string | null = null;
  if (taskId) {
    const task = await taskAttachmentOperationsRepository.getTaskByIdAsync(taskId);
    if (!task) return c.json({ error: "任务不存在" }, 404);
    if (!canManageResource(task.userId, task.workspaceId, userId)) {
      return c.json({ error: "无权向该任务上传附件", code: "FORBIDDEN" }, 403);
    }
    effectiveWorkspaceId = task.workspaceId;
  } else {
    const raw = c.req.query("workspaceId");
    if (raw && raw !== "personal") {
      const role = getUserWorkspaceRole(raw, userId);
      if (!role) return c.json({ error: "无权访问该工作区", code: "FORBIDDEN" }, 403);
      effectiveWorkspaceId = raw;
    }
  }

  if (file.size > MAX_ATTACHMENT_SIZE) {
    return c.json(
      { error: `文件过大（最大 ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB）` },
      413,
    );
  }

  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(mime)) {
    return c.json({ error: `不支持的 MIME 类型: ${mime}` }, 415);
  }

  ensureAttachmentsDir();
  const id = uuid();
  const ext = MIME_TO_EXT[mime] || "bin";
  const monthPath = getUploadMonthPath();
  const storedPath = `${monthPath}/${id}.${ext}`;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeAttachmentObject(storedPath, buffer, mime);
  } catch (error: any) {
    return c.json({ error: `写入文件失败: ${error?.message || error}` }, 500);
  }

  try {
    await taskAttachmentsRepository.createAsync({
      id,
      taskId,
      userId,
      workspaceId: effectiveWorkspaceId,
      filename: file.name || storedPath,
      mimeType: mime,
      size: file.size,
      path: storedPath,
    });
  } catch (error: any) {
    try {
      await deleteAttachmentObject(storedPath);
    } catch {
      // Best effort rollback of the object written before the database insert.
    }
    return c.json({ error: `写入数据库失败: ${error?.message || error}` }, 500);
  }

  return c.json(
    {
      id,
      url: `/api/task-attachments/${id}`,
      mimeType: mime,
      size: file.size,
      filename: file.name || storedPath,
    },
    201,
  );
});

/** 把孤儿附件关联到具体 task。 */
app.patch("/:id/bind", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  if (!taskId) return c.json({ error: "taskId 必传" }, 400);

  const attachment = await taskAttachmentsRepository.getByIdForPermissionAsync(id);
  if (!attachment) return c.json({ error: "附件不存在" }, 404);
  if (attachment.userId !== userId) {
    return c.json({ error: "无权绑定该附件", code: "FORBIDDEN" }, 403);
  }

  const task = await taskAttachmentOperationsRepository.getTaskByIdAsync(taskId);
  if (!task) return c.json({ error: "任务不存在" }, 404);
  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "无权操作该任务", code: "FORBIDDEN" }, 403);
  }

  await taskAttachmentsRepository.updateTaskAssociationAsync(id, taskId, task.workspaceId);
  return c.json({ success: true });
});

/** 删除任务附件。物理文件删除失败不阻塞数据库记录清理。 */
app.delete("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const row = await taskAttachmentsRepository.getByIdForDeleteAsync(id);
  if (!row) return c.json({ error: "附件不存在" }, 404);

  if (row.taskId) {
    const task = await taskAttachmentOperationsRepository.getTaskByIdAsync(row.taskId);
    const allowed = task
      ? canManageResource(task.userId, task.workspaceId, userId) || row.userId === userId
      : row.userId === userId;
    if (!allowed) return c.json({ error: "无权删除该附件", code: "FORBIDDEN" }, 403);
  } else if (row.userId !== userId) {
    return c.json({ error: "无权删除该附件", code: "FORBIDDEN" }, 403);
  }

  try {
    await deleteAttachmentObject(row.path);
  } catch {
    // 文件删不掉不阻塞，DB 记录仍然要清掉。
  }
  await taskAttachmentsRepository.deleteAsync(id);

  return c.json({ success: true });
});

export default app;
