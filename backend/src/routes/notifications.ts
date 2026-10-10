import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { IssueError } from "../services/workspaceIssues.js";
import { visibleNotifications } from "../services/notificationListing.js";
import { resolveUnlockedFolderNodeIds } from "../lib/knowledgeTreePasswordAccess.js";
import { pageParams } from "./workspace-issues.js";

const app = new Hono();
// V1 为登录账号的协作入口，尚未定义公共 API Token 权限范围。
app.use("*", async (c, next) => {
  if (c.req.header("X-Auth-Mode") === "api-token") return c.json({ error: "议题和通知需要账号登录" }, 403);
  await next();
});
app.onError((error, c) => {
  if (error instanceof IssueError) return c.json({ error: error.message }, error.status);
  console.error("[notifications]", error);
  return c.json({ error: "通知操作失败" }, 500);
});
app.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ error: "请先登录" }, 401);
  await next();
});

app.get("/", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const { limit, offset } = pageParams(c.req.query("limit"), c.req.query("offset"));
  const unreadOnly = c.req.query("unread") === "true";
  const visible = visibleNotifications(userId, resolveUnlockedFolderNodeIds(getDb(), userId, c.req.header("X-Folder-Unlock-Tokens")));
  const filtered = unreadOnly ? visible.filter((item) => !item.readAt) : visible;
  return c.json({ items: filtered.slice(offset, offset + limit), total: filtered.length, unreadCount: visible.filter((item) => !item.readAt).length });
});

app.post("/read-all", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const db = getDb();
  const visible = visibleNotifications(userId, resolveUnlockedFolderNodeIds(db, userId, c.req.header("X-Folder-Unlock-Tokens")));
  const read = db.prepare("UPDATE notifications SET readAt = ? WHERE id = ? AND userId = ? AND readAt IS NULL");
  const now = new Date().toISOString();
  db.transaction(() => { for (const item of visible) if (!item.readAt) read.run(now, item.id, userId); })();
  return c.json({ success: true });
});

app.post("/:id/read", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const db = getDb();
  if (!visibleNotifications(userId, resolveUnlockedFolderNodeIds(db, userId, c.req.header("X-Folder-Unlock-Tokens"))).some((item) => item.id === id)) throw new IssueError("通知不存在", 404);
  db.prepare("UPDATE notifications SET readAt = COALESCE(readAt, ?) WHERE id = ? AND userId = ?").run(new Date().toISOString(), id, userId);
  return c.json({ success: true });
});

export default app;
