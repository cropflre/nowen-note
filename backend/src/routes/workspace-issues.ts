import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema.js";
import { IssueError, issueForRead, notifyIssue, requireIssue, textField, validateRelatedNote, workspaceIssueAccess, type WorkspaceIssue } from "../services/workspaceIssues.js";

const app = new Hono();
// V1 为登录账号的协作入口，尚未定义公共 API Token 权限范围。
app.use("*", async (c, next) => {
  if (c.req.header("X-Auth-Mode") === "api-token") return c.json({ error: "议题和通知需要账号登录" }, 403);
  await next();
});
app.onError((error, c) => {
  if (error instanceof IssueError) return c.json({ error: error.message }, error.status);
  console.error("[workspace-issues]", error);
  return c.json({ error: "议题操作失败" }, 500);
});

export function pageParams(limit?: string, offset?: string) {
  const size = limit === undefined ? 30 : Number(limit);
  const start = offset === undefined ? 0 : Number(offset);
  if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(start) || start < 0 || start > 1000000) {
    throw new IssueError("分页参数无效", 400);
  }
  return { limit: size, offset: start };
}

async function jsonBody(request: { json: () => Promise<unknown> }) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new IssueError("请求内容必须是 JSON 对象", 400); }
}

app.get("/", (c) => {
  const workspaceId = c.req.query("workspaceId") || "";
  const userId = c.req.header("X-User-Id") || "";
  const access = workspaceIssueAccess(workspaceId, userId);
  const status = c.req.query("status") || "all";
  if (!["all", "open", "closed"].includes(status)) throw new IssueError("议题状态无效", 400);
  const { limit, offset } = pageParams(c.req.query("limit"), c.req.query("offset"));
  const db = getDb();
  const where = "workspaceId = ?" + (status === "all" ? "" : " AND status = ?");
  const params = status === "all" ? [workspaceId] : [workspaceId, status];
  const rows = db.prepare(`SELECT * FROM workspace_issues WHERE ${where} ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as WorkspaceIssue[];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM workspace_issues WHERE ${where}`).get(...params) as { total: number }).total;
  return c.json({ items: rows.map((row) => issueForRead(row, userId)), total, canCreate: access.canComment, role: access.role });
});

app.post("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const body = await jsonBody(c.req);
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!workspaceIssueAccess(workspaceId, userId).canComment) throw new IssueError("当前角色不能创建议题", 403);
  const title = textField(body.title, "标题", 200);
  const content = textField(body.content ?? "", "正文", 100000, true);
  const relatedNoteId = validateRelatedNote(body.relatedNoteId, workspaceId, userId);
  const db = getDb();
  const issue = db.transaction(() => {
    const number = (db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS number FROM workspace_issues WHERE workspaceId = ?").get(workspaceId) as { number: number }).number;
    const now = new Date().toISOString();
    const row: WorkspaceIssue = { id: uuid(), workspaceId, number, title, content, status: "open", createdBy: userId, closedBy: null, closedAt: null, relatedNoteId, createdAt: now, updatedAt: now };
    db.prepare(`INSERT INTO workspace_issues (id, workspaceId, number, title, content, createdBy, relatedNoteId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, workspaceId, number, title, content, userId, relatedNoteId, now, now);
    notifyIssue(row, userId, "issue_created", content, now);
    return row;
  }).immediate();
  return c.json(issueForRead(issue, userId), 201);
});

app.get("/:id", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const { issue, access } = requireIssue(c.req.param("id"), userId);
  return c.json({ ...issueForRead(issue, userId), canComment: access.canComment,
    canChangeStatus: access.canManage || (access.canComment && issue.createdBy === userId),
    canEdit: access.canAdmin || (access.canComment && issue.createdBy === userId) });
});

app.patch("/:id", async (c) => {
  const body = await jsonBody(c.req);
  const userId = c.req.header("X-User-Id") || "";
  const { issue, access } = requireIssue(c.req.param("id"), userId);
  const editing = body.title !== undefined || body.content !== undefined || body.relatedNoteId !== undefined;
  if (editing && !(access.canAdmin || (access.canComment && issue.createdBy === userId))) throw new IssueError("无权编辑该议题", 403);
  if (body.status !== undefined && !(access.canManage || (access.canComment && issue.createdBy === userId))) throw new IssueError("无权改变该议题状态", 403);
  if (body.status !== undefined && body.status !== "open" && body.status !== "closed") throw new IssueError("议题状态无效", 400);
  const next = { ...issue,
    title: body.title === undefined ? issue.title : textField(body.title, "标题", 200),
    content: body.content === undefined ? issue.content : textField(body.content, "正文", 100000, true),
    relatedNoteId: body.relatedNoteId === undefined ? issue.relatedNoteId : validateRelatedNote(body.relatedNoteId, issue.workspaceId, userId),
    status: (body.status ?? issue.status) as WorkspaceIssue["status"],
  };
  const changed = next.status !== issue.status;
  if (!editing && !changed) return c.json(issueForRead(issue, userId));
  const db = getDb();
  db.transaction(() => {
    const now = new Date().toISOString();
    next.updatedAt = now;
    if (changed) {
      next.closedAt = next.status === "closed" ? now : null;
      next.closedBy = next.status === "closed" ? userId : null;
    }
    db.prepare(`UPDATE workspace_issues SET title = ?, content = ?, relatedNoteId = ?, status = ?, closedAt = ?, closedBy = ?, updatedAt = ? WHERE id = ?`)
      .run(next.title, next.content, next.relatedNoteId, next.status, next.closedAt, next.closedBy, now, next.id);
    if (changed) {
      const type = next.status === "closed" ? "closed" : "reopened";
      db.prepare("INSERT INTO workspace_issue_events (id, issueId, userId, type, createdAt) VALUES (?, ?, ?, ?, ?)").run(uuid(), next.id, userId, type, now);
      notifyIssue(next, userId, `issue_${type}`, "", now);
    }
  })();
  return c.json(issueForRead(next, userId));
});

app.get("/:id/activity", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const { issue, access } = requireIssue(c.req.param("id"), userId);
  const { limit, offset } = pageParams(c.req.query("limit"), c.req.query("offset"));
  const db = getDb();
  const union = `SELECT id, issueId, userId, parentId, content, 'comment' AS type, createdAt, updatedAt FROM workspace_issue_comments WHERE issueId = ?
    UNION ALL SELECT id, issueId, userId, NULL AS parentId, '' AS content, type, createdAt, createdAt AS updatedAt FROM workspace_issue_events WHERE issueId = ?`;
  const items = db.prepare(`SELECT a.*, COALESCE(NULLIF(u.displayName, ''), u.username) AS authorName FROM (${union}) a
    LEFT JOIN users u ON u.id = a.userId ORDER BY a.createdAt ASC, a.id ASC LIMIT ? OFFSET ?`).all(issue.id, issue.id, limit, offset) as { userId: string | null; type: string }[];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM (${union})`).get(issue.id, issue.id) as { total: number }).total;
  return c.json({ items: items.map((item) => ({ ...item, canEdit: item.type === "comment" && access.canComment && item.userId === userId })), total });
});

app.post("/:id/comments", async (c) => {
  const body = await jsonBody(c.req);
  const userId = c.req.header("X-User-Id") || "";
  const { issue, access } = requireIssue(c.req.param("id"), userId);
  if (!access.canComment) throw new IssueError("当前角色不能回复议题", 403);
  const content = textField(body.content, "回复", 20000);
  const parentId = body.parentId ?? null;
  const db = getDb();
  if (parentId !== null && (typeof parentId !== "string" || !db.prepare("SELECT id FROM workspace_issue_comments WHERE id = ? AND issueId = ?").get(parentId, issue.id))) {
    throw new IssueError("回复的父评论不属于当前议题", 400);
  }
  const row = { id: uuid(), issueId: issue.id, userId, parentId, content, createdAt: new Date().toISOString(), updatedAt: "" };
  row.updatedAt = row.createdAt;
  db.transaction(() => {
    db.prepare(`INSERT INTO workspace_issue_comments (id, issueId, userId, parentId, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, issue.id, userId, parentId, content, row.createdAt, row.updatedAt);
    db.prepare("UPDATE workspace_issues SET updatedAt = ? WHERE id = ?").run(row.createdAt, issue.id);
    notifyIssue(issue, userId, "issue_commented", content, row.createdAt);
  })();
  return c.json(row, 201);
});

app.on(["PATCH", "DELETE"], "/:id/comments/:commentId", async (c) => {
  const body = c.req.method === "PATCH" ? await jsonBody(c.req) : null;
  const userId = c.req.header("X-User-Id") || "";
  const { issue, access } = requireIssue(c.req.param("id"), userId);
  const db = getDb();
  const row = db.prepare("SELECT * FROM workspace_issue_comments WHERE id = ? AND issueId = ?").get(c.req.param("commentId"), issue.id) as { id: string; userId: string | null } | undefined;
  if (!row) throw new IssueError("回复不存在", 404);
  if (!access.canComment || row.userId !== userId) throw new IssueError("只能修改自己的回复", 403);
  const content = body ? textField(body.content, "回复", 20000) : null;
  const now = new Date().toISOString();
  db.transaction(() => {
    if (content !== null) db.prepare("UPDATE workspace_issue_comments SET content = ?, updatedAt = ? WHERE id = ?").run(content, now, row.id);
    else db.prepare("DELETE FROM workspace_issue_comments WHERE id = ?").run(row.id);
    db.prepare("UPDATE workspace_issues SET updatedAt = ? WHERE id = ?").run(now, issue.id);
  })();
  return c.json({ success: true });
});

export default app;
