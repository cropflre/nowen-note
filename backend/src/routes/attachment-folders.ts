import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";

const app = new Hono();

/**
 * GET /api/attachment-folders
 * 获取当前用户的文件夹列表
 */
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  const folders = db
    .prepare(
      `SELECT id, name, parentId, createdAt, updatedAt
       FROM attachment_folders
       WHERE userId = ?
       ORDER BY name COLLATE NOCASE`
    )
    .all(userId) as Array<{
      id: string;
      name: string;
      parentId: string | null;
      createdAt: string;
      updatedAt: string;
    }>;

  // 统计每个文件夹下的附件数
  const counts = db
    .prepare(
      `SELECT folderId, COUNT(*) AS count
       FROM attachments
       WHERE userId = ? AND folderId IS NOT NULL
       GROUP BY folderId`
    )
    .all(userId) as Array<{ folderId: string; count: number }>;
  const countMap = new Map(counts.map((r) => [r.folderId, r.count]));

  return c.json({
    folders: folders.map((f) => ({
      ...f,
      fileCount: countMap.get(f.id) || 0,
    })),
  });
});

/**
 * POST /api/attachment-folders
 * 创建文件夹
 */
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const name = (body.name || "").trim();
  const parentId = body.parentId || null;

  if (!name) return c.json({ error: "文件夹名称不能为空" }, 400);
  if (name.length > 100) return c.json({ error: "文件夹名称过长" }, 400);

  // 同级同名校验
  const existing = db
    .prepare(
      "SELECT id FROM attachment_folders WHERE userId = ? AND name = ? AND (parentId = ? OR (parentId IS NULL AND ? IS NULL))"
    )
    .get(userId, name, parentId, parentId) as { id: string } | undefined;
  if (existing) {
    return c.json({ error: "同级已存在同名文件夹" }, 409);
  }

  // 如果有 parentId，校验父文件夹存在且属于当前用户
  if (parentId) {
    const parent = db
      .prepare("SELECT id FROM attachment_folders WHERE id = ? AND userId = ?")
      .get(parentId, userId) as { id: string } | undefined;
    if (!parent) return c.json({ error: "父文件夹不存在" }, 404);
  }

  const id = uuid();
  db.prepare(
    "INSERT INTO attachment_folders (id, userId, name, parentId) VALUES (?, ?, ?, ?)"
  ).run(id, userId, name, parentId);

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
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();
  const name = (body.name || "").trim();

  if (!name) return c.json({ error: "文件夹名称不能为空" }, 400);
  if (name.length > 100) return c.json({ error: "文件夹名称过长" }, 400);

  const folder = db
    .prepare("SELECT id, parentId FROM attachment_folders WHERE id = ? AND userId = ?")
    .get(id, userId) as { id: string; parentId: string | null } | undefined;
  if (!folder) return c.json({ error: "文件夹不存在" }, 404);

  // 同级同名校验（排除自身）
  const dup = db
    .prepare(
      "SELECT id FROM attachment_folders WHERE userId = ? AND name = ? AND id != ? AND (parentId = ? OR (parentId IS NULL AND ? IS NULL))"
    )
    .get(userId, name, id, folder.parentId, folder.parentId) as { id: string } | undefined;
  if (dup) return c.json({ error: "同级已存在同名文件夹" }, 409);

  db.prepare("UPDATE attachment_folders SET name = ?, updatedAt = datetime('now') WHERE id = ?")
    .run(name, id);

  return c.json({ id, name, parentId: folder.parentId });
});

/**
 * DELETE /api/attachment-folders/:id
 * 删除文件夹，文件夹内附件的 folderId 置为 NULL（归入未归档）
 */
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const folder = db
    .prepare("SELECT id FROM attachment_folders WHERE id = ? AND userId = ?")
    .get(id, userId) as { id: string } | undefined;
  if (!folder) return c.json({ error: "文件夹不存在" }, 404);

  // 把该文件夹内附件的 folderId 清空
  db.prepare("UPDATE attachments SET folderId = NULL WHERE folderId = ? AND userId = ?")
    .run(id, userId);

  db.prepare("DELETE FROM attachment_folders WHERE id = ?").run(id);

  return c.json({ success: true });
});

export default app;
