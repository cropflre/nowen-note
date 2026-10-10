/**
 * Webhook 管理 API
 *
 * - GET    /api/webhooks              — 列出 Webhook
 * - POST   /api/webhooks              — 创建 Webhook
 * - PUT    /api/webhooks/:id          — 更新 Webhook
 * - DELETE /api/webhooks/:id          — 删除 Webhook
 * - POST   /api/webhooks/:id/test     — 发送测试事件
 * - GET    /api/webhooks/:id/deliveries — 查看投递日志
 */

import { Hono } from "hono";
import crypto from "crypto";
import { getDb } from "../db/schema.js";
import { initWebhookTables, emitWebhook } from "../services/webhook.js";

const webhooksRouter = new Hono();
function isSafeDestination(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  } catch { return false; }
}

// 确保表已创建
let tablesReady = false;
function ensureTables() {
  if (!tablesReady) {
    initWebhookTables();
    tablesReady = true;
  }
}

// ===== GET /api/webhooks =====
webhooksRouter.get("/", (c) => {
  ensureTables();
  const userId = c.req.header("X-User-Id") || "";
  const db = getDb();
  const webhooks = db.prepare("SELECT * FROM webhooks WHERE userId = ? ORDER BY createdAt DESC").all(userId);
  return c.json(webhooks.map((w: any) => ({
    ...w,
    events: JSON.parse(w.events),
    secret: w.secret ? "***" : "", // 不暴露 secret
  })));
});

// ===== POST /api/webhooks =====
webhooksRouter.post("/", async (c) => {
  ensureTables();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json() as { url: string; events?: string[]; description?: string; secret?: string };

  if (!isSafeDestination(body.url)) return c.json({ error: "Webhook 仅支持 HTTPS URL" }, 400);

  const db = getDb();
  const id = crypto.randomUUID();
  const secret = body.secret || crypto.randomBytes(32).toString("hex");

  db.prepare(`
    INSERT INTO webhooks (id, userId, url, secret, events, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    body.url,
    secret,
    JSON.stringify(body.events || ["*"]),
    body.description || "",
  );

  return c.json({
    id,
    url: body.url,
    events: body.events || ["*"],
    secret, // 仅创建时返回一次
    description: body.description || "",
    isActive: 1,
  }, 201);
});

// ===== PUT /api/webhooks/:id =====
webhooksRouter.put("/:id", async (c) => {
  ensureTables();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json() as { url?: string; events?: string[]; description?: string; isActive?: number };

  const db = getDb();
  const existing = db.prepare("SELECT * FROM webhooks WHERE id = ? AND userId = ?").get(id, userId);
  if (!existing) return c.json({ error: "Webhook 不存在" }, 404);

  const updates: string[] = [];
  const values: any[] = [];

  if (body.url !== undefined) {
    if (!isSafeDestination(body.url)) return c.json({ error: "Webhook 仅支持 HTTPS URL" }, 400);
    updates.push("url = ?"); values.push(body.url);
  }
  if (body.events !== undefined) { updates.push("events = ?"); values.push(JSON.stringify(body.events)); }
  if (body.description !== undefined) { updates.push("description = ?"); values.push(body.description); }
  if (body.isActive !== undefined) { updates.push("isActive = ?"); values.push(body.isActive); }

  if (updates.length > 0) {
    updates.push("updatedAt = datetime('now')");
    values.push(id, userId);
    db.prepare(`UPDATE webhooks SET ${updates.join(", ")} WHERE id = ? AND userId = ?`).run(...values);
  }

  const updated = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as any;
  return c.json({ ...updated, events: JSON.parse(updated.events), secret: "***" });
});

// ===== DELETE /api/webhooks/:id =====
webhooksRouter.delete("/:id", (c) => {
  ensureTables();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const db = getDb();
  db.prepare("DELETE FROM webhooks WHERE id = ? AND userId = ?").run(id, userId);
  return c.json({ success: true });
});

// ===== POST /api/webhooks/:id/test =====
webhooksRouter.post("/:id/test", (c) => {
  ensureTables();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const db = getDb();
  const webhook = db.prepare("SELECT * FROM webhooks WHERE id = ? AND userId = ?").get(id, userId) as any;
  if (!webhook) return c.json({ error: "Webhook 不存在" }, 404);

  emitWebhook("note.created", userId, {
    test: true,
    message: "这是一条测试事件",
    timestamp: new Date().toISOString(),
  });

  return c.json({ success: true, message: "测试事件已发送" });
});

// ===== GET /api/webhooks/:id/deliveries =====
webhooksRouter.get("/:id/deliveries", (c) => {
  ensureTables();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const db = getDb();

  // 验证所有权
  const webhook = db.prepare("SELECT id FROM webhooks WHERE id = ? AND userId = ?").get(id, userId);
  if (!webhook) return c.json({ error: "Webhook 不存在" }, 404);

  const deliveries = db.prepare(
    "SELECT * FROM webhook_deliveries WHERE webhookId = ? ORDER BY deliveredAt DESC LIMIT 50"
  ).all(id);

  return c.json(deliveries);
});

export default webhooksRouter;
