/**
 * 任务附件路由（/api/task-attachments）
 * ---------------------------------------------------------------------------
 * 任务附件独立于 notes / attachments：附件直接归属 task，可承载图片、PDF、
 * Office、音视频与普通文件。历史 task.title 中的 Markdown 图片 token 继续兼容，
 * 新通用附件则通过任务详情附件区管理，不再要求创建笔记中转。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import { ensureAttachmentsDir, encodeContentDispositionFilename } from "./attachments";
import {
  deleteAttachmentObject,
  getUploadMonthPath,
  readAttachmentObject,
  writeAttachmentObject,
} from "../services/attachment-storage";
import { getUserWorkspaceRole, canManageResource } from "../middleware/acl";
import { taskAttachmentsRepository } from "../repositories";
import {
  getTaskAttachmentExtension,
  getTaskAttachmentMaxSizeBytes,
  isBlockedTaskAttachment,
  shouldInlineTaskAttachment,
} from "../lib/task-attachment-policy";

function canReadTask(task: { userId: string; workspaceId: string | null }, userId: string): boolean {
  if (task.userId === userId) return true;
  return !!task.workspaceId && !!getUserWorkspaceRole(task.workspaceId, userId);
}

/**
 * 不经过 JWT 的二进制读取入口，保留历史图片 token 的直接 <img src> 兼容。
 * 通用文件默认 attachment 下载；仅图片/PDF/音视频/安全文本允许 inline。
 */
export async function handleDownloadTaskAttachment(c: Context): Promise<Response> {
  const id = c.req.param("id");
  const row = taskAttachmentsRepository.getById(id);
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
app.get("/", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const taskId = (c.req.query("taskId") || "").trim();
  if (!taskId) return c.json({ error: "taskId 必传" }, 400);

  const task = getDb()
    .prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?")
    .get(taskId) as { userId: string; workspaceId: string | null } | undefined;
  if (!task) return c.json({ error: "任务不存在" }, 404);
  if (!canReadTask(task, userId)) {
    return c.json({ error: "无权访问该任务附件", code: "FORBIDDEN" }, 403);
  }

  const items = taskAttachmentsRepository.listByTaskId(taskId).map((row) => ({
    id: row.id,
    taskId: row.taskId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    url: `/api/task-attachments/${row.id}`,
  }));
  return c.json(items);
});

/**
 * 上传任务附件。
 * taskId 可空：新建任务流程仍可先上传为孤儿，创建任务后再 bind。
 */
app.post("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const db = getDb();

  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid multipart body" }, 400);
  }

  const file = body.file;
  const taskId = typeof body.taskId === "string" && body.taskId ? body.taskId : null;
  if (!(file instanceof File)) return c.json({ error: "file 字段缺失或非文件" }, 400);

  let effectiveWorkspaceId: string | null = null;
  if (taskId) {
    const task = db
      .prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?")
      .get(taskId) as { userId: string; workspaceId: string | null } | undefined;
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
    return c.json({ error: `文件过大（最大 ${Math.floor(maxSize / 1024 / 1024)}MB）` }, 413);
  }

  const mime = (file.type || "application/octet-stream").toLowerCase().split(";")[0].trim();
  if (isBlockedTaskAttachment(file.name || "", mime)) {
    return c.json({ error: "出于安全原因，不支持上传可执行或脚本类文件" }, 415);
  }

  ensureAttachmentsDir();
  const id = uuid();
  const ext = getTaskAttachmentExtension(file.name || "", mime);
  const monthPath = getUploadMonthPath();
  const storagePath = `${monthPath}/${id}.${ext}`;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeAttachmentObject(storagePath, buffer, mime);
  } catch (err: any) {
    return c.json({ error: `写入文件失败: ${err?.message || err}` }, 500);
  }

  try {
    taskAttachmentsRepository.create({
      id,
      taskId,
      userId,
      workspaceId: effectiveWorkspaceId,
      filename: file.name || `${id}.${ext}`,
      mimeType: mime,
      size: file.size,
      path: storagePath,
    });
  } catch (err: any) {
    try { await deleteAttachmentObject(storagePath); } catch { /* ignore */ }
    return c.json({ error: `写入数据库失败: ${err?.message || err}` }, 500);
  }

  return c.json({
    id,
    url: `/api/task-attachments/${id}`,
    mimeType: mime,
    size: file.size,
    filename: file.name || `${id}.${ext}`,
  }, 201);
});

/** 把新建任务前上传的孤儿附件关联到具体 task。 */
app.patch("/:id/bind", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const db = getDb();
  const id = c.req.param("id");

  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  if (!taskId) return c.json({ error: "taskId 必传" }, 400);

  const att = taskAttachmentsRepository.getByIdForPermission(id);
  if (!att) return c.json({ error: "附件不存在" }, 404);
  if (att.userId !== userId) {
    return c.json({ error: "无权绑定该附件", code: "FORBIDDEN" }, 403);
  }

  const task = db
    .prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?")
    .get(taskId) as { userId: string; workspaceId: string | null } | undefined;
  if (!task) return c.json({ error: "任务不存在" }, 404);
  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "无权操作该任务", code: "FORBIDDEN" }, 403);
  }

  taskAttachmentsRepository.updateTaskAssociation(id, taskId, task.workspaceId);
  return c.json({ success: true });
});

/** 删除任务附件。 */
app.delete("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const row = taskAttachmentsRepository.getByIdForDelete(id);
  if (!row) return c.json({ error: "附件不存在" }, 404);

  if (row.taskId) {
    const task = db
      .prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?")
      .get(row.taskId) as { userId: string; workspaceId: string | null } | undefined;
    const ok = task
      ? canManageResource(task.userId, task.workspaceId, userId) || row.userId === userId
      : row.userId === userId;
    if (!ok) return c.json({ error: "无权删除该附件", code: "FORBIDDEN" }, 403);
  } else if (row.userId !== userId) {
    return c.json({ error: "无权删除该附件", code: "FORBIDDEN" }, 403);
  }

  try { await deleteAttachmentObject(row.path); } catch { /* DB record still must be removed */ }
  taskAttachmentsRepository.delete(id);
  return c.json({ success: true });
});

export default app;
