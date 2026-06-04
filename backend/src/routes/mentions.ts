/**
 * 用户 @ 提及通知路由（mentions）
 * ---------------------------------------------------------------------------
 * 提供用户 @ 消息的查询、已读标记等接口。权限方面：
 *   - 每个用户只能查自己的 mentions
 *   - 查看源内容时由前端按 sourceType 分别校验权限
 *
 * 所有端点需 JWT 认证（由父级 index.ts 中挂载时添加）。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";

const mentions = new Hono();

// ---------------------------------------------------------------------------
// 列出当前用户的 @ 消息（分页，按时间倒序）
// ---------------------------------------------------------------------------
// GET /api/mentions?cursor=&limit=20
mentions.get("/", (c: Context) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const cursor = c.req.query("cursor"); // 上次最后一条的 createdAt
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);

  const args: unknown[] = [userId];
  const cursorClause = cursor ? " AND m.createdAt < ?" : "";
  if (cursor) args.push(cursor);

  const rows = db
    .prepare(
      `SELECT m.id, m.sourceType, m.sourceId, m.sourceTitle,
              m.createdAt, m.readAt,
              u.id AS mentionedById, u.username AS mentionedByUsername,
              u.displayName AS mentionedByDisplayName, u.avatarUrl AS mentionedByAvatarUrl
       FROM mentions m
       LEFT JOIN users u ON u.id = m.mentionedByUserId
       WHERE m.mentionedUserId = ?${cursorClause}
       ORDER BY m.createdAt DESC
       LIMIT ?`,
    )
    .all(...args, limit + 1) as any[];

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    sourceType: r.sourceType as "note" | "diary" | "task",
    sourceId: r.sourceId,
    sourceTitle: r.sourceTitle,
    mentionedBy: {
      id: r.mentionedById,
      username: r.mentionedByUsername,
      displayName: r.mentionedByDisplayName,
      avatarUrl: r.mentionedByAvatarUrl,
    },
    createdAt: r.createdAt,
    readAt: r.readAt,
  }));

  const nextCursor = hasMore ? items[items.length - 1].createdAt : null;
  return c.json({ items, hasMore, nextCursor });
});

// ---------------------------------------------------------------------------
// 未读消息数
// ---------------------------------------------------------------------------
// GET /api/mentions/unread-count
mentions.get("/unread-count", (c: Context) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const row = db
    .prepare("SELECT COUNT(*) as count FROM mentions WHERE mentionedUserId = ? AND readAt IS NULL")
    .get(userId) as { count: number };
  return c.json({ count: row.count });
});

// ---------------------------------------------------------------------------
// 标记单条已读
// ---------------------------------------------------------------------------
// PUT /api/mentions/:id/read
mentions.put("/:id/read", (c: Context) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const { id } = c.req.param();

  const row = db
    .prepare("SELECT id FROM mentions WHERE id = ? AND mentionedUserId = ?")
    .get(id, userId) as any;

  if (!row) {
    return c.json({ error: "消息不存在" }, 404);
  }

  db.prepare("UPDATE mentions SET readAt = datetime('now') WHERE id = ?").run(id);
  db.prepare("UPDATE notifications SET readAt = datetime('now') WHERE id = ?").run(id);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// 标记全部已读
// ---------------------------------------------------------------------------
// PUT /api/mentions/read-all
mentions.put("/read-all", (c: Context) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  db.prepare(
    "UPDATE mentions SET readAt = datetime('now') WHERE mentionedUserId = ? AND readAt IS NULL",
  ).run(userId);
  db.prepare(
    "UPDATE notifications SET readAt = datetime('now') WHERE userId = ? AND type = 'mention' AND readAt IS NULL",
  ).run(userId);

  return c.json({ success: true });
});

export default mentions;
