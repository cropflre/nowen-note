import { Hono } from "hono";
import type { Context } from "hono";
import crypto from "crypto";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole } from "../middleware/acl";

const taskCalendar = new Hono();

function getUserId(c: Context): string {
  return c.req.header("X-User-Id")!;
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsFold(line: string): string {
  // ICS spec: lines should be <= 75 octets; fold with CRLF + space
  const result: string[] = [];
  let remaining = line;
  while (Buffer.byteLength(remaining, "utf-8") > 75) {
    // Find a safe cut point (at 75 bytes)
    let cut = 74;
    const buf = Buffer.from(remaining, "utf-8");
    // Walk back to avoid splitting a multi-byte char
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
    result.push(buf.subarray(0, cut).toString("utf-8"));
    remaining = buf.subarray(cut).toString("utf-8");
  }
  result.push(remaining);
  return result.join("\r\n ");
}

function toIcsDate(dateStr: string): { value: string; isDateTime: boolean } {
  // dueAt: "2026-06-12T18:00" -> DTSTART;TZID=...:20260612T180000
  // dueDate: "2026-06-12" -> DTSTART;VALUE=DATE:20260612
  if (dateStr.includes("T")) {
    const normalized = dateStr.replace(/[-:]/g, "").replace("T", "");
    return { value: normalized.length === 13 ? normalized + "00" : normalized, isDateTime: true };
  }
  return { value: dateStr.replace(/-/g, ""), isDateTime: false };
}

function buildVEvent(task: any, feed: any, reminders: any[]): string {
  const lines: string[] = [];
  lines.push("BEGIN:VEVENT");
  lines.push(icsFold(`UID:task-${task.id}@nowen-note`));
  lines.push(icsFold(`SUMMARY:${icsEscape(task.title)}`));

  if (feed.includeDescription && task.description) {
    lines.push(icsFold(`DESCRIPTION:${icsEscape(task.description)}`));
  }

  const dt = toIcsDate(task.dueAt || task.dueDate);
  if (dt.isDateTime) {
    lines.push(icsFold(`DTSTART:${dt.value}`));
    lines.push(icsFold(`DUE:${dt.value}`));
  } else {
    lines.push(icsFold(`DTSTART;VALUE=DATE:${dt.value}`));
    lines.push(icsFold(`DUE;VALUE=DATE:${dt.value}`));
  }

  if (task.updatedAt) {
    const lm = task.updatedAt.replace(/[-:]/g, "").replace(" ", "T").replace("Z", "");
    lines.push(icsFold(`LAST-MODIFIED:${lm}`));
  }

  lines.push("STATUS:CONFIRMED");

  // VALARM per enabled reminder
  const enabledReminders = reminders.filter((r) => r.enabled === 1);
  if (enabledReminders.length > 0) {
    for (const r of enabledReminders) {
      lines.push("BEGIN:VALARM");
      lines.push(icsFold(`TRIGGER:-PT${r.offsetMinutes}M`));
      lines.push("ACTION:DISPLAY");
      lines.push(icsFold(`DESCRIPTION:${icsEscape(task.title)}`));
      lines.push("END:VALARM");
    }
  } else {
    // Default alarm
    lines.push("BEGIN:VALARM");
    lines.push(icsFold(`TRIGGER:-PT${feed.defaultAlarmMinutes}M`));
    lines.push("ACTION:DISPLAY");
    lines.push(icsFold(`DESCRIPTION:${icsEscape(task.title)}`));
    lines.push("END:VALARM");
  }

  lines.push("END:VEVENT");
  return lines.join("\r\n");
}

// GET /feed — 获取当前用户的订阅配置
taskCalendar.get("/feed", (c) => {
  const userId = getUserId(c);
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM task_calendar_feeds WHERE userId = ?"
  ).get(userId) as any;
  if (!row) {
    return c.json({ feed: null });
  }
  return c.json({
    feed: {
      id: row.id,
      token: row.token,
      enabled: !!row.enabled,
      includeCompleted: !!row.includeCompleted,
      includeDescription: !!row.includeDescription,
      defaultAlarmMinutes: row.defaultAlarmMinutes,
      lastAccessedAt: row.lastAccessedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  });
});

// POST /feed — 创建或启用订阅
taskCalendar.post("/feed", (c) => {
  const userId = getUserId(c);
  const db = getDb();
  const existing = db.prepare(
    "SELECT * FROM task_calendar_feeds WHERE userId = ?"
  ).get(userId) as any;
  if (existing) {
    if (!existing.enabled) {
      db.prepare(
        "UPDATE task_calendar_feeds SET enabled = 1, updatedAt = datetime('now') WHERE id = ?"
      ).run(existing.id);
    }
    return c.json({
      feed: {
        id: existing.id,
        token: existing.token,
        enabled: true,
        includeCompleted: !!existing.includeCompleted,
        includeDescription: !!existing.includeDescription,
        defaultAlarmMinutes: existing.defaultAlarmMinutes,
      },
    });
  }
  const id = crypto.randomUUID();
  const token = generateToken();
  db.prepare(
    `INSERT INTO task_calendar_feeds (id, userId, token, enabled, includeCompleted, includeDescription, defaultAlarmMinutes)
     VALUES (?, ?, ?, 1, 0, 1, 30)`
  ).run(id, userId, token);
  return c.json({
    feed: {
      id,
      token,
      enabled: true,
      includeCompleted: false,
      includeDescription: true,
      defaultAlarmMinutes: 30,
    },
  });
});

// PATCH /feed — 更新配置
taskCalendar.patch("/feed", async (c) => {
  const userId = getUserId(c);
  const db = getDb();
  const body = await c.req.json().catch(() => ({}));
  const existing = db.prepare(
    "SELECT * FROM task_calendar_feeds WHERE userId = ?"
  ).get(userId) as any;
  if (!existing) {
    return c.json({ error: "Feed not found" }, 404);
  }
  const updates: string[] = [];
  const params: any[] = [];
  if (body.enabled !== undefined) {
    updates.push("enabled = ?");
    params.push(body.enabled ? 1 : 0);
  }
  if (body.includeCompleted !== undefined) {
    updates.push("includeCompleted = ?");
    params.push(body.includeCompleted ? 1 : 0);
  }
  if (body.includeDescription !== undefined) {
    updates.push("includeDescription = ?");
    params.push(body.includeDescription ? 1 : 0);
  }
  if (body.defaultAlarmMinutes !== undefined) {
    updates.push("defaultAlarmMinutes = ?");
    params.push(Number(body.defaultAlarmMinutes) || 30);
  }
  if (updates.length > 0) {
    updates.push("updatedAt = datetime('now')");
    params.push(existing.id);
    db.prepare(
      `UPDATE task_calendar_feeds SET ${updates.join(", ")} WHERE id = ?`
    ).run(...params);
  }
  const updated = db.prepare(
    "SELECT * FROM task_calendar_feeds WHERE id = ?"
  ).get(existing.id) as any;
  return c.json({
    feed: {
      id: updated.id,
      token: updated.token,
      enabled: !!updated.enabled,
      includeCompleted: !!updated.includeCompleted,
      includeDescription: !!updated.includeDescription,
      defaultAlarmMinutes: updated.defaultAlarmMinutes,
    },
  });
});

// POST /feed/rotate-token — 重新生成 token
taskCalendar.post("/feed/rotate-token", (c) => {
  const userId = getUserId(c);
  const db = getDb();
  const existing = db.prepare(
    "SELECT * FROM task_calendar_feeds WHERE userId = ?"
  ).get(userId) as any;
  if (!existing) {
    return c.json({ error: "Feed not found" }, 404);
  }
  const newToken = generateToken();
  db.prepare(
    "UPDATE task_calendar_feeds SET token = ?, updatedAt = datetime('now') WHERE id = ?"
  ).run(newToken, existing.id);
  return c.json({ success: true });
});

// GET /feed/:token.ics — 公开 ICS 订阅
taskCalendar.get("/feed/:token", (c) => {
  const token = c.req.param("token");
  if (!token || !token.endsWith(".ics")) {
    return c.json({ error: "Not found" }, 404);
  }
  const rawToken = token.replace(/\.ics$/, "");
  const db = getDb();
  const feed = db.prepare(
    "SELECT * FROM task_calendar_feeds WHERE token = ?"
  ).get(rawToken) as any;
  if (!feed) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!feed.enabled) {
    return c.json({ error: "Feed disabled" }, 403);
  }

  // Update lastAccessedAt
  db.prepare(
    "UPDATE task_calendar_feeds SET lastAccessedAt = datetime('now') WHERE id = ?"
  ).run(feed.id);

  // Query tasks
  let sql = `
    SELECT t.id, t.title, t.description, t.dueDate, t.dueAt, t.updatedAt, t.isCompleted
    FROM tasks t
    WHERE t.userId = ?
      AND (t.dueAt IS NOT NULL OR t.dueDate IS NOT NULL)
  `;
  const params: any[] = [feed.userId];

  if (!feed.includeCompleted) {
    sql += " AND t.isCompleted = 0";
  }
  if (feed.workspaceId) {
    sql += " AND t.workspaceId = ?";
    params.push(feed.workspaceId);
  }
  sql += " ORDER BY COALESCE(t.dueAt, t.dueDate) ASC";

  const tasks = db.prepare(sql).all(...params) as any[];

  // Get reminders for these tasks
  const taskIds = tasks.map((t) => t.id);
  let remindersByTask = new Map<string, any[]>();
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => "?").join(",");
    const reminders = db.prepare(
      `SELECT * FROM task_reminders WHERE taskId IN (${placeholders}) AND enabled = 1`
    ).all(...taskIds) as any[];
    for (const r of reminders) {
      const arr = remindersByTask.get(r.taskId) || [];
      arr.push(r);
      remindersByTask.set(r.taskId, arr);
    }
  }

  // Build ICS
  const calLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nowen Note//Tasks//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    icsFold("X-WR-CALNAME:Nowen Tasks"),
  ];
  for (const task of tasks) {
    calLines.push(buildVEvent(task, feed, remindersByTask.get(task.id) || []));
  }
  calLines.push("END:VCALENDAR");

  const body = calLines.join("\r\n") + "\r\n";
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="nowen-tasks.ics"',
      "Cache-Control": "no-store",
    },
  });
});

// ── 导出 ICS 生成逻辑供公开路由使用 ──

/** 根据 token 查询 feed 并生成 ICS 内容。返回 null 表示 token 无效或已禁用。 */
export function buildIcsForToken(token: string): { body: string; feedId: string } | null {
  const db = getDb();
  const feed = db.prepare(
    "SELECT * FROM task_calendar_feeds WHERE token = ? AND enabled = 1"
  ).get(token) as any;
  if (!feed) return null;

  // Update lastAccessedAt（fire and forget）
  try {
    db.prepare("UPDATE task_calendar_feeds SET lastAccessedAt = datetime('now') WHERE id = ?").run(feed.id);
  } catch { /* ignore */ }

  let sql = `
    SELECT t.id, t.title, t.description, t.dueDate, t.dueAt, t.updatedAt, t.isCompleted
    FROM tasks t
    WHERE t.userId = ?
      AND (t.dueAt IS NOT NULL OR t.dueDate IS NOT NULL)
  `;
  const params: any[] = [feed.userId];
  if (!feed.includeCompleted) sql += " AND t.isCompleted = 0";
  if (feed.workspaceId) { sql += " AND t.workspaceId = ?"; params.push(feed.workspaceId); }
  sql += " ORDER BY COALESCE(t.dueAt, t.dueDate) ASC";

  const tasks = db.prepare(sql).all(...params) as any[];

  const taskIds = tasks.map((t) => t.id);
  const remindersByTask = new Map<string, any[]>();
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => "?").join(",");
    const reminders = db.prepare(
      `SELECT * FROM task_reminders WHERE taskId IN (${placeholders}) AND enabled = 1`
    ).all(...taskIds) as any[];
    for (const r of reminders) {
      const arr = remindersByTask.get(r.taskId) || [];
      arr.push(r);
      remindersByTask.set(r.taskId, arr);
    }
  }

  const calLines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nowen Note//Tasks//CN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    icsFold("X-WR-CALNAME:Nowen Tasks"),
  ];
  for (const task of tasks) {
    calLines.push(buildVEvent(task, feed, remindersByTask.get(task.id) || []));
  }
  calLines.push("END:VCALENDAR");
  return { body: calLines.join("\r\n") + "\r\n", feedId: feed.id };
}

export default taskCalendar;
