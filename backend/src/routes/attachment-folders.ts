import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import {
  attachmentFolderOperationsRepository,
  attachmentFoldersRepository,
} from "../repositories";

const app = new Hono();

/**
 * GET /api/attachment-folders
 * 获取当前用户的文件夹列表
 */
app.get("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const [folders, counts] = await Promise.all([
    attachmentFoldersRepository.listByUserAsync(userId),
    attachmentFolderOperationsRepository.listCountsByUserAsync(userId),
  ]);
  const countMap = new Map(counts.map((row) => [row.folderId, row.count]));

  return c.json({
    folders: folders.map((folder) => ({
      ...folder,
      fileCount: countMap.get(folder.id) || 0,
    })),
  });
});

/**
 * POST /api/attachment-folders
 * 创建文件夹
 */
app.post("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const name = (body.name || "").trim();
  const parentId = body.parentId || null;

  if (!name) return c.json({ error: "文件夹名称不能为空" }, 400);
  if (name.length > 100) return c.json({ error: "文件夹名称过长" }, 400);

  // 同级同名校验
  if (await attachmentFoldersRepository.existsByNameAsync(userId, name, parentId)) {
    return c.json({ error: "同级已存在同名文件夹" }, 409);
  }

  // 如果有 parentId，校验父文件夹存在且属于当前用户
  if (parentId && !await attachmentFoldersRepository.parentExistsAsync(parentId, userId)) {
    return c.json({ error: "父文件夹不存在" }, 404);
  }

  const id = uuid();
  await attachmentFoldersRepository.createAsync({ id, userId, name, parentId });

  return c.json({
    id,
    name,
    parentId,
    fileCount: 0,
  }, 201);
});

/**
 * PATCH /api/attachment-folders/:id
 * 重命名文件夹
 */
app.patch("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();
  const name = (body.name || "").trim();

  if (!name) return c.json({ error: "文件夹名称不能为空" }, 400);
  if (name.length > 100) return c.json({ error: "文件夹名称过长" }, 400);

  const folder = await attachmentFoldersRepository.getByIdAsync(id, userId);
  if (!folder) return c.json({ error: "文件夹不存在" }, 404);

  // 同级同名校验（排除自身）
  if (await attachmentFoldersRepository.existsByNameAsync(
    userId,
    name,
    folder.parentId,
    id,
  )) {
    return c.json({ error: "同级已存在同名文件夹" }, 409);
  }

  await attachmentFoldersRepository.updateNameAsync(id, name);

  return c.json({ id, name, parentId: folder.parentId });
});

/**
 * DELETE /api/attachment-folders/:id
 * 删除文件夹，文件夹内附件的 folderId 置为 NULL（归入未归档）
 */
app.delete("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const folder = await attachmentFoldersRepository.getByIdAsync(id, userId);
  if (!folder) return c.json({ error: "文件夹不存在" }, 404);

  await attachmentFolderOperationsRepository.deleteFolderAndUnassignAsync(id, userId);

  return c.json({ success: true });
});

export default app;
