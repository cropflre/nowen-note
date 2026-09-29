import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { IssueError, VISIBLE_NOTIFICATIONS } from "../services/workspaceIssues.js";
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
  const db = getDb();
  const items = db.prepare(`SELECT n.*, (SELECT COALESCE(NULLIF(u.displayName, ''), u.username) FROM users u WHERE u.id = n.actorUserId) AS actorName,
    (SELECT w.name FROM workspaces w WHERE w.id = n.workspaceId) AS workspaceName
    ${VISIBLE_NOTIFICATIONS} ${unreadOnly ? "AND n.readAt IS NULL" : ""} ORDER BY n.createdAt DESC, n.id DESC LIMIT ? OFFSET ?`).all(userId, limit, offset);
  const total = (db.prepare(`SELECT COUNT(*) AS total ${VISIBLE_NOTIFICATIONS} ${unreadOnly ? "AND n.readAt IS NULL" : ""}`).get(userId) as { total: number }).total;
  const unreadCount = (db.prepare(`SELECT COUNT(*) AS total ${VISIBLE_NOTIFICATIONS} AND n.readAt IS NULL`).get(userId) as { total: number }).total;
  return c.json({ items, total, unreadCount });
});

app.post("/read-all", (c) => {
  const userId = c.req.header("X-User-Id")!;
  getDb().prepare(`UPDATE notifications SET readAt = ? WHERE readAt IS NULL AND id IN (SELECT n.id ${VISIBLE_NOTIFICATIONS})`)
    .run(new Date().toISOString(), userId);
  return c.json({ success: true });
});

app.post("/:id/read", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const db = getDb();
  if (!db.prepare(`SELECT n.id ${VISIBLE_NOTIFICATIONS} AND n.id = ?`).get(userId, id)) throw new IssueError("通知不存在", 404);
  db.prepare("UPDATE notifications SET readAt = COALESCE(readAt, ?) WHERE id = ? AND userId = ?").run(new Date().toISOString(), id, userId);
  return c.json({ success: true });
});

export default app;
