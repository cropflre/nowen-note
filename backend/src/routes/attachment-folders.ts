import { assetOrganizationWriteAvailable } from "../sync/assetOrganization";
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import { attachmentFoldersRepository } from "../repositories";

const app = new Hono();

// The existing schema owns folders by user, not workspace. Fail closed until scoped
// folders and their Sync V2 entities are implemented, without rewriting old rows.
app.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ error: "未授权", code: "UNAUTHORIZED" }, 401);
  const workspaceId = c.req.query("workspaceId");
  if (workspaceId && workspaceId !== "personal") {
    if (c.req.method === "GET") return c.json({ folders: [], supported: false, code: "WORKSPACE_ATTACHMENT_FOLDER_UNSUPPORTED" });
    return c.json({ error: "工作区暂不支持文件夹整理", code: "WORKSPACE_ATTACHMENT_FOLDER_UNSUPPORTED" }, 409);
  }
  if(c.req.method!=="GET" && !assetOrganizationWriteAvailable(getDb(),c.req.header("X-User-Id")!)) {
    return c.json({error:"请先连接支持附件目录同步的服务器并完成首次同步",code:"ATTACHMENT_FOLDER_SYNC_NOT_READY"},409);
  }
  await next();
});

app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const counts = db.prepare(`SELECT folderId, COUNT(*) AS count FROM attachments
    WHERE trashedAt IS NULL AND userId = ? AND workspaceId IS NULL AND folderId IS NOT NULL GROUP BY folderId`)
    .all(userId) as Array<{ folderId: string; count: number }>;
  const countMap = new Map(counts.map((r) => [r.folderId, r.count]));
  return c.json({ supported: assetOrganizationWriteAvailable(db,userId), folders: attachmentFoldersRepository.listByUser(userId)
    .map((f) => ({ ...f, fileCount: countMap.get(f.id) || 0 })) });
});

app.post("/", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const parentId = body?.parentId ?? null;
  if (!name || name.length > 100 || !(parentId === null || (typeof parentId === "string" && parentId))) {
    return c.json({ error: "请提供有效的文件夹名称和父目录", code: "INVALID_FOLDER" }, 400);
  }
  const result = getDb().transaction(() => {
    if (parentId && !attachmentFoldersRepository.parentExists(parentId, userId)) return "missing";
    if (attachmentFoldersRepository.existsByName(userId, name, parentId)) return "duplicate";
    const id = uuid();
    attachmentFoldersRepository.create({ id, userId, name, parentId });
    return { id, name, parentId, fileCount: 0 };
  })();
  if (result === "missing") return c.json({ error: "父文件夹不存在", code: "FOLDER_NOT_FOUND" }, 404);
  if (result === "duplicate") return c.json({ error: "同级已存在同名文件夹", code: "FOLDER_NAME_CONFLICT" }, 409);
  return c.json(result, 201);
});

app.patch("/:id", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || (body.name === undefined && body.parentId === undefined)
    || (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100))
    || (body.parentId !== undefined && !(body.parentId === null || (typeof body.parentId === "string" && body.parentId)))) {
    return c.json({ error: "无效的文件夹名称或目标目录", code: "INVALID_FOLDER" }, 400);
  }
  const db = getDb();
  const result = db.transaction(() => {
    const folder = db.prepare("SELECT name, parentId FROM attachment_folders WHERE id = ? AND userId = ?")
      .get(id, userId) as { name: string; parentId: string | null } | undefined;
    if (!folder) return "missing";
    if (body.expectedName !== undefined && body.expectedName !== folder.name) return "stale";
    if (Object.prototype.hasOwnProperty.call(body, "expectedParentId") && body.expectedParentId !== folder.parentId) return "stale";
    const parentId = body.parentId === undefined ? folder.parentId : body.parentId;
    const name = body.name === undefined ? folder.name : body.name.trim();
    const visited = new Set([id]);
    let ancestor = parentId;
    while (ancestor) {
      if (visited.has(ancestor)) return "cycle";
      visited.add(ancestor);
      const parent = attachmentFoldersRepository.getById(ancestor, userId);
      if (!parent) return "missing";
      ancestor = parent.parentId;
    }
    if (attachmentFoldersRepository.existsByName(userId, name, parentId, id)) return "duplicate";
    db.prepare("UPDATE attachment_folders SET name = ?, parentId = ?, updatedAt = datetime('now') WHERE id = ? AND userId = ?")
      .run(name, parentId, id, userId);
    return { id, name, parentId };
  })();
  if (result === "missing") return c.json({ error: "文件夹不存在", code: "FOLDER_NOT_FOUND" }, 404);
  if (result === "stale") return c.json({ error: "文件夹名称或位置已变化，请重新预览", code: "FOLDER_VERSION_CONFLICT" }, 409);
  if (result === "cycle") return c.json({ error: "不能移动到自身或子文件夹", code: "FOLDER_CYCLE" }, 409);
  if (result === "duplicate") return c.json({ error: "同级已存在同名文件夹", code: "FOLDER_NAME_CONFLICT" }, 409);
  return c.json(result);
});

app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const result = db.transaction(() => {
    if (!attachmentFoldersRepository.getById(id, userId)) return "missing";
    // Include legacy assignments in other scopes. Preserve every child and byte.
    if (db.prepare("SELECT 1 FROM attachments WHERE folderId = ? LIMIT 1").get(id)
      || db.prepare("SELECT 1 FROM attachment_folders WHERE parentId = ? LIMIT 1").get(id)) return "nonempty";
    attachmentFoldersRepository.delete(id);
    return "deleted";
  })();
  if (result === "missing") return c.json({ error: "文件夹不存在", code: "FOLDER_NOT_FOUND" }, 404);
  if (result === "nonempty") return c.json({ error: "文件夹非空，请先移出文件和子文件夹", code: "FOLDER_NOT_EMPTY" }, 409);
  return c.json({ success: true });
});

export default app;
