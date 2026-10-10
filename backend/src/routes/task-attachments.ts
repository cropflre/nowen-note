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
import {
  getTaskAttachmentExtension,
  getTaskAttachmentMaxSizeBytes,
  isBlockedTaskAttachment,
  shouldInlineTaskAttachment,
} from "../lib/task-attachment-policy";

function canReadTask(task: { userId: string; workspaceId: string | null }, userId: string): boolean {
  return task.userId === userId ||
    (!!task.workspaceId && !!getUserWorkspaceRole(task.workspaceId, userId));
}

/** 不需要 JWT 的下载 handler，由 index.ts 挂在 JWT 中间件之前。 */
export async function handleDownloadTaskAttachment(c: Context): Promise<Response> {
  const id = c.req.param("id");
  const row = await taskAttachmentsRepository.getByIdAsync(id);
  if (!row) return c.json({ error: "附件不存在" }, 404);

  const buffer = await readAttachmentObject(row.path);
  if (!buffer) return c.json({ error: "attachment file missing" }, 404);

  const mime = row.mimeType || "application/octet-stream";
  const forceDownload = c.req.query("download") === "1" || !shouldInlineTaskAttachment(mime);
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  };
  if (forceDownload) {
    headers["Content-Disposition"] = encodeContentDispositionFilename(row.filename || "attachment");
  }

  return new Response(new Uint8Array(buffer), { headers });
}

const app = new Hono();

/** 列出任务的独立附件。 */
app.get("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const taskId = (c.req.query("taskId") || "").trim();
  if (!taskId) return c.json({ error: "taskId 必传" }, 400);
  const task = await taskAttachmentOperationsRepository.getTaskByIdAsync(taskId);
  if (!task) return c.json({ error: "任务不存在" }, 404);
  if (!canReadTask(task, userId)) {
    return c.json({ error: "无权访问该任务附件", code: "FORBIDDEN" }, 403);
  }
  const rows = await taskAttachmentsRepository.listByTaskIdAsync(taskId);
  return c.json(rows.map(row => ({
    id: row.id,
    taskId: row.taskId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    url: "/api/task-attachments/" + row.id,
  })));
});

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

  const maxSize = getTaskAttachmentMaxSizeBytes();
  if (file.size > maxSize) {
    return c.json(
      { error: `文件过大（最大 ${Math.floor(maxSize / 1024 / 1024)}MB）` },
      413,
    );
  }

  const mime = (file.type || "application/octet-stream").toLowerCase().split(";")[0].trim();
  if (isBlockedTaskAttachment(file.name || "", mime)) {
    return c.json({ error: "出于安全原因，不支持上传可执行或脚本类文件" }, 415);
  }

  ensureAttachmentsDir();
  const id = uuid();
  const ext = getTaskAttachmentExtension(file.name || "", mime);
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
      filename: file.name || `${id}.${ext}`,
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
      filename: file.name || `${id}.${ext}`,
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
