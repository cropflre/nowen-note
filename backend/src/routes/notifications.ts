/**
 * 通用通知路由（notifications）
 * ---------------------------------------------------------------------------
 * 统一管理所有用户通知，包括：
 *   - @提及（mention）
 *   - 任务完成（task_completed）
 *   - 工作区新说说（diary_posted）
 *   - 笔记更新（note_updated）
 *   - ……
 *
 * 端点：
 *   GET    /api/notifications       — 列表（分页）
 *   GET    /api/notifications/unread-count — 未读数
 *   PUT    /api/notifications/:id/read     — 标记已读
 *   PUT    /api/notifications/read-all     — 全部已读
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";

const notifications = new Hono();

// ---------------------------------------------------------------------------
// 通知类型 → 显示配置
// ---------------------------------------------------------------------------
const NOTIFICATION_LABELS: Record<string, { label: string; icon: string }> = {
  mention: { label: "@了你", icon: "mention" },
  task_completed: { label: "完成了任务", icon: "task" },
  diary_posted: { label: "发布了新说说", icon: "diary" },
  note_updated: { label: "更新了笔记", icon: "note" },
};

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------
// GET /api/notifications?cursor=&limit=20
notifications.get("/", (c: Context) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);

  const args: unknown[] = [userId];
  const cursorClause = cursor ? " AND n.createdAt < ?" : "";
  if (cursor) args.push(cursor);

  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.sourceType, n.sourceId, n.sourceTitle,
              n.actorId, n.actorName, n.createdAt, n.readAt
       FROM notifications n
       WHERE n.userId = ?${cursorClause}
       ORDER BY n.createdAt DESC
       LIMIT ?`,
    )
    .all(...args, limit + 1) as any[];

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => {
    const typeInfo = NOTIFICATION_LABELS[r.type] || { label: "", icon: "bell" };
    return {
      id: r.id,
      type: r.type,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      sourceTitle: r.sourceTitle,
      actorId: r.actorId,
      actorName: r.actorName,
      label: typeInfo.label,
      createdAt: r.createdAt,
      readAt: r.readAt,
    };
  });

  const nextCursor = hasMore ? items[items.length - 1].createdAt : null;
  return c.json({ items, hasMore, nextCursor });
});

// ---------------------------------------------------------------------------
// 未读数
// ---------------------------------------------------------------------------
notifications.get("/unread-count", (c: Context) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const row = db
    .prepare("SELECT COUNT(*) as count FROM notifications WHERE userId = ? AND readAt IS NULL")
    .get(userId) as { count: number };
  return c.json({ count: row.count });
});

// ---------------------------------------------------------------------------
// 标记单条已读
// ---------------------------------------------------------------------------
notifications.put("/:id/read", (c: Context) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const { id } = c.req.param();

  const row = db
    .prepare("SELECT id FROM notifications WHERE id = ? AND userId = ?")
    .get(id, userId) as any;
  if (!row) return c.json({ error: "通知不存在" }, 404);

  db.prepare("UPDATE notifications SET readAt = datetime('now') WHERE id = ?").run(id);
  db.prepare("UPDATE mentions SET readAt = datetime('now') WHERE id = ?").run(id);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// 全部已读
// ---------------------------------------------------------------------------
notifications.put("/read-all", (c: Context) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  db.prepare(
    "UPDATE notifications SET readAt = datetime('now') WHERE userId = ? AND readAt IS NULL",
  ).run(userId);
  db.prepare(
    "UPDATE mentions SET readAt = datetime('now') WHERE mentionedUserId = ? AND readAt IS NULL",
  ).run(userId);
  return c.json({ success: true });
});

export default notifications;
