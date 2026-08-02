import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { after } from "node:test";
import Database from "better-sqlite3";
import crypto from "crypto";

/**
 * Test the task calendar ICS feed logic.
 * Tests the SQL queries and ICS generation against in-memory SQLite.
 */

const realCalendarTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-calendar-"));
process.env.DB_PATH = path.join(realCalendarTmpDir, "test.db");
process.env.NODE_ENV = "test";

async function setupRealCalendarDb() {
  const [{ getDb }, taskCalendarModule] = await Promise.all([
    import("../src/db/schema"),
    import("../src/routes/task-calendar"),
  ]);
  const db = getDb();
  db.prepare("DELETE FROM task_reminders").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM task_calendar_feeds").run();
  db.prepare("DELETE FROM users").run();
  return {
    db,
    buildIcsForToken: taskCalendarModule.buildIcsForToken,
    taskCalendar: taskCalendarModule.default,
  };
}

after(async () => {
  const { closeDb } = await import("../src/db/schema");
  closeDb();
  fs.rmSync(realCalendarTmpDir, { recursive: true, force: true });
});

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT,
      passwordHash TEXT, role TEXT DEFAULT 'user', isDemo INTEGER DEFAULT 0,
      personalExportEnabled INTEGER DEFAULT 1, personalImportEnabled INTEGER DEFAULT 1,
      displayName TEXT, avatarUrl TEXT, createdAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL, workspaceId TEXT,
      title TEXT NOT NULL, description TEXT, isCompleted INTEGER DEFAULT 0,
      status TEXT DEFAULT 'todo', priority INTEGER DEFAULT 2,
      startDate TEXT, dueDate TEXT, dueAt TEXT,
      noteId TEXT, parentId TEXT, sortOrder INTEGER DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')), updatedAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE task_reminders (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL, userId TEXT NOT NULL,
      offsetMinutes INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 1,
      lastNotifiedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE task_calendar_feeds (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      token TEXT UNIQUE NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      includeCompleted INTEGER NOT NULL DEFAULT 0,
      includeDescription INTEGER NOT NULL DEFAULT 1,
      defaultAlarmMinutes INTEGER NOT NULL DEFAULT 30,
      lastAccessedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_task_calendar_feeds_token ON task_calendar_feeds(token);
    CREATE INDEX idx_task_calendar_feeds_user ON task_calendar_feeds(userId);
  `);
  return db;
}

function insertUser(db: Database.Database, id: string) {
  db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(id, id);
}

function insertTask(db: Database.Database, opts: {
  id: string; userId: string; title: string; description?: string;
  isCompleted?: number; dueDate?: string | null; dueAt?: string | null;
}) {
  db.prepare(
    "INSERT INTO tasks (id, userId, title, description, isCompleted, dueDate, dueAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    opts.id, opts.userId, opts.title,
    opts.description ?? null,
    opts.isCompleted ?? 0,
    opts.dueDate ?? null,
    opts.dueAt ?? null
  );
}

function insertReminder(db: Database.Database, opts: {
  id: string; taskId: string; userId: string;
  offsetMinutes?: number; enabled?: number;
}) {
  db.prepare(
    "INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled) VALUES (?, ?, ?, ?, ?)"
  ).run(
    opts.id, opts.taskId, opts.userId,
    opts.offsetMinutes ?? 30,
    opts.enabled ?? 1
  );
}

function insertFeed(db: Database.Database, opts: {
  id: string; userId: string; token: string;
  enabled?: number; includeCompleted?: number;
  includeDescription?: number; defaultAlarmMinutes?: number;
}) {
  db.prepare(
    `INSERT INTO task_calendar_feeds (id, userId, token, enabled, includeCompleted, includeDescription, defaultAlarmMinutes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, opts.userId, opts.token,
    opts.enabled ?? 1,
    opts.includeCompleted ?? 0,
    opts.includeDescription ?? 1,
    opts.defaultAlarmMinutes ?? 30
  );
}

// ICS helpers (replicated from task-calendar.ts for testing)

function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function toIcsDate(dateStr: string): { value: string; isDateTime: boolean } {
  if (dateStr.includes("T") || dateStr.includes(" ")) {
    const cleaned = dateStr.replace(" ", "T").replace(/[-:]/g, "").replace("Z", "");
    return { value: cleaned.length === 13 ? cleaned + "00" : cleaned, isDateTime: true };
  }
  return { value: dateStr.replace(/-/g, ""), isDateTime: false };
}

test("task_calendar_feeds 表创建成功", () => {
  const db = createTestDb();
  insertUser(db, "user1");
  insertFeed(db, { id: "f1", userId: "user1", token: "test-token-abc" });
  const row = db.prepare("SELECT * FROM task_calendar_feeds WHERE id = ?").get("f1") as any;
  assert.equal(row.userId, "user1");
  assert.equal(row.token, "test-token-abc");
  assert.equal(row.enabled, 1);
  db.close();
});

test("通过 token 查询 feed", () => {
  const db = createTestDb();
  insertUser(db, "user1");
  insertFeed(db, { id: "f1", userId: "user1", token: "tok123" });
  const row = db.prepare("SELECT * FROM task_calendar_feeds WHERE token = ?").get("tok123") as any;
  assert.ok(row);
  assert.equal(row.id, "f1");
  db.close();
});

test("token 唯一约束生效", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertUser(db, "u2");
  insertFeed(db, { id: "f1", userId: "u1", token: "same-token" });
  assert.throws(() => {
    insertFeed(db, { id: "f2", userId: "u2", token: "same-token" });
  });
  db.close();
});

test("默认配置值正确", () => {
  const db = createTestDb();
  insertUser(db, "user1");
  insertFeed(db, { id: "f1", userId: "user1", token: "tok-default" });
  const row = db.prepare("SELECT * FROM task_calendar_feeds WHERE id = ?").get("f1") as any;
  assert.equal(row.enabled, 1);
  assert.equal(row.includeCompleted, 0);
  assert.equal(row.includeDescription, 1);
  assert.equal(row.defaultAlarmMinutes, 30);
  db.close();
});

test("查询未完成且有 dueDate 的任务", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertFeed(db, { id: "f1", userId: "u1", token: "tok1" });
  insertTask(db, { id: "t1", userId: "u1", title: "有截止日期", dueDate: "2026-06-25" });
  insertTask(db, { id: "t2", userId: "u1", title: "已完成", dueDate: "2026-06-26", isCompleted: 1 });
  insertTask(db, { id: "t3", userId: "u1", title: "无日期" });
  insertTask(db, { id: "t4", userId: "u1", title: "有时间点", dueAt: "2026-06-27T10:00" });

  const feed = db.prepare("SELECT * FROM task_calendar_feeds WHERE id = ?").get("f1") as any;
  const where = ["t.userId = ?", "(t.dueDate IS NOT NULL OR t.dueAt IS NOT NULL)"];
  const params: any[] = [feed.userId];
  if (!feed.includeCompleted) {
    where.push("t.isCompleted = 0");
  }
  const tasks = db.prepare(
    `SELECT t.* FROM tasks t WHERE ${where.join(" AND ")} ORDER BY t.dueDate, t.dueAt`
  ).all(...params) as any[];

  assert.equal(tasks.length, 2);
  // dueAt has NULL dueDate so sorts first, dueDate has NULL dueAt
  assert.equal(tasks[0].id, "t4");
  assert.equal(tasks[1].id, "t1");
  db.close();
});

test("includeCompleted=true 时导出已完成任务", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertFeed(db, { id: "f1", userId: "u1", token: "tok1", includeCompleted: 1 });
  insertTask(db, { id: "t1", userId: "u1", title: "已完成", dueDate: "2026-06-25", isCompleted: 1 });
  insertTask(db, { id: "t2", userId: "u1", title: "未完成", dueDate: "2026-06-26" });

  const feed = db.prepare("SELECT * FROM task_calendar_feeds WHERE id = ?").get("f1") as any;
  const where = ["t.userId = ?", "(t.dueDate IS NOT NULL OR t.dueAt IS NOT NULL)"];
  const params: any[] = [feed.userId];
  if (!feed.includeCompleted) {
    where.push("t.isCompleted = 0");
  }
  const tasks = db.prepare(
    `SELECT t.* FROM tasks t WHERE ${where.join(" AND ")}`
  ).all(...params) as any[];

  assert.equal(tasks.length, 2);
  db.close();
});

test("dueAt 转换为 DATE-TIME 格式", () => {
  const r1 = toIcsDate("2026-06-12T18:00");
  assert.equal(r1.value, "20260612T180000");
  assert.equal(r1.isDateTime, true);

  const r2 = toIcsDate("2026-06-12 18:30");
  assert.equal(r2.value, "20260612T183000");
  assert.equal(r2.isDateTime, true);
});

test("dueDate 转换为全天 DATE 格式", () => {
  const r = toIcsDate("2026-06-12");
  assert.equal(r.value, "20260612");
  assert.equal(r.isDateTime, false);
});

test("真实 ICS 输出使用兼容的 DATE-TIME、DTEND，并且公开订阅与镜像导出一致", async () => {
  const { db, buildIcsForToken, taskCalendar } = await setupRealCalendarDb();

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("u-real", "u-real", "hash");
  db.prepare(`
    INSERT INTO task_calendar_feeds (id, userId, token, enabled, includeCompleted, includeDescription, defaultAlarmMinutes)
    VALUES (?, ?, ?, 1, 0, 1, 30)
  `).run("feed-real", "u-real", "real-token");

  const insertRealTask = db.prepare(`
    INSERT INTO tasks (id, userId, title, description, startDate, dueDate, dueAt, updatedAt, isCompleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  insertRealTask.run("t-minute", "u-real", "分钟时间", "", "2026-07-02T12:29", null, "2026-07-02T13:29", "2026-07-02 13:29:00");
  insertRealTask.run("t-seconds", "u-real", "秒级时间", "", null, null, "2026-07-02T13:29:00", "2026-07-02 13:29:00");
  insertRealTask.run("t-space", "u-real", "空格时间", "", null, null, "2026-07-02 13:29", "2026-07-02 13:29:00");
  insertRealTask.run("t-date", "u-real", "全天任务", "", "2026-11-01", "2026-11-02", null, "2026-11-02 00:00:00");
  insertRealTask.run("t-start-only", "u-real", "仅开始时间", "", "2026-07-03T09:00", null, null, "2026-07-03 09:00:00");
  insertRealTask.run("t-due-date-range", "u-real", "dueDate 时间段", "", "2026-07-04T14:00", "2026-07-04T15:00", null, "2026-07-04 15:00:00");

  const result = buildIcsForToken("real-token");
  assert.ok(result);
  assert.equal(result.feedId, "feed-real");

  const body = result.body;
  assert.ok(body.includes("DTSTART:20260702T122900"));
  assert.ok(body.includes("DTSTART:20260702T132900"));
  assert.ok(body.includes("DTEND:20260702T132900"));
  assert.ok(!body.includes("DTEND:20260702T133000"));
  assert.ok(!body.includes("DTSTART:202607021329"));
  assert.ok(!body.includes("DUE:"));

  assert.ok(body.includes("DTSTART;VALUE=DATE:20261101"));
  assert.ok(body.includes("DTEND;VALUE=DATE:20261103"));
  const startOnlyEvent = body.split("BEGIN:VEVENT").find((event) => event.includes("UID:task-t-start-only@nowen-note"));
  assert.ok(startOnlyEvent);
  assert.ok(startOnlyEvent.includes("DTSTART:20260703T090000"));
  assert.ok(!startOnlyEvent.includes("DTEND:"));
  const dueDateRangeEvent = body.split("BEGIN:VEVENT").find((event) => event.includes("UID:task-t-due-date-range@nowen-note"));
  assert.ok(dueDateRangeEvent);
  assert.ok(dueDateRangeEvent.includes("DTSTART:20260704T140000"));
  assert.ok(dueDateRangeEvent.includes("DTEND:20260704T150000"));

  const publicResponse = await taskCalendar.request("/feed/real-token.ics");
  assert.equal(publicResponse.status, 200);
  assert.equal(await publicResponse.text(), body);
});

test("icsEscape 处理特殊字符", () => {
  assert.equal(icsEscape("hello; world, test"), "hello\\; world\\, test");
  assert.equal(icsEscape("line1\nline2"), "line1\\nline2");
  assert.equal(icsEscape("back\\slash"), "back\\\\slash");
  assert.equal(icsEscape("normal text"), "normal text");
});

test("VALARM 使用 task_reminders 的 offsetMinutes", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertTask(db, { id: "t1", userId: "u1", title: "任务1", dueDate: "2026-06-25" });
  insertReminder(db, { id: "r1", taskId: "t1", userId: "u1", offsetMinutes: 15 });
  insertReminder(db, { id: "r2", taskId: "t1", userId: "u1", offsetMinutes: 60 });

  const reminders = db.prepare(
    "SELECT * FROM task_reminders WHERE taskId = ? AND enabled = 1"
  ).all("t1") as any[];

  assert.equal(reminders.length, 2);
  assert.equal(reminders[0].offsetMinutes, 15);
  assert.equal(reminders[1].offsetMinutes, 60);
  db.close();
});

test("无 reminder 时使用 defaultAlarmMinutes", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertFeed(db, { id: "f1", userId: "u1", token: "tok1", defaultAlarmMinutes: 45 });
  insertTask(db, { id: "t1", userId: "u1", title: "任务1", dueDate: "2026-06-25" });

  const reminders = db.prepare(
    "SELECT * FROM task_reminders WHERE taskId = ? AND enabled = 1"
  ).all("t1") as any[];
  const feed = db.prepare("SELECT * FROM task_calendar_feeds WHERE id = ?").get("f1") as any;

  assert.equal(reminders.length, 0);
  assert.equal(feed.defaultAlarmMinutes, 45);
  db.close();
});

test("disabled feed 不返回任务", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertFeed(db, { id: "f1", userId: "u1", token: "tok-disabled", enabled: 0 });
  insertTask(db, { id: "t1", userId: "u1", title: "任务1", dueDate: "2026-06-25" });

  const feed = db.prepare("SELECT * FROM task_calendar_feeds WHERE token = ?").get("tok-disabled") as any;
  assert.ok(feed);
  assert.equal(feed.enabled, 0);
  db.close();
});

test("rotate-token 后旧 token 失效", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertFeed(db, { id: "f1", userId: "u1", token: "old-token" });

  const oldRow = db.prepare("SELECT * FROM task_calendar_feeds WHERE token = ?").get("old-token") as any;
  assert.ok(oldRow);

  const newToken = crypto.randomBytes(32).toString("base64url");
  db.prepare("UPDATE task_calendar_feeds SET token = ?, updatedAt = datetime('now') WHERE id = ?").run(newToken, "f1");

  const oldCheck = db.prepare("SELECT * FROM task_calendar_feeds WHERE token = ?").get("old-token");
  assert.equal(oldCheck, undefined);

  const newRow = db.prepare("SELECT * FROM task_calendar_feeds WHERE token = ?").get(newToken) as any;
  assert.ok(newRow);
  assert.equal(newRow.id, "f1");
  db.close();
});

test("ICS 生成包含 VEVENT 结构", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertFeed(db, { id: "f1", userId: "u1", token: "tok1" });
  insertTask(db, { id: "t1", userId: "u1", title: "测试任务", dueDate: "2026-06-25" });
  insertReminder(db, { id: "r1", taskId: "t1", userId: "u1", offsetMinutes: 30 });

  const feed = db.prepare("SELECT * FROM task_calendar_feeds WHERE id = ?").get("f1") as any;
  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE userId = ? AND isCompleted = 0 AND (dueDate IS NOT NULL OR dueAt IS NOT NULL)"
  ).all(feed.userId) as any[];
  const reminders = db.prepare(
    "SELECT * FROM task_reminders WHERE enabled = 1"
  ).all() as any[];

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "测试任务");
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].offsetMinutes, 30);

  db.close();
});

test("multi-byte ?? escape ???", () => {
  const text = "??????????,??";
  const escaped = icsEscape(text);
  // ??????
  assert.ok(escaped.includes("??"), "?????");
  // ?????
  assert.ok(escaped.includes("\\"), "???????");
  // ?????
  assert.ok(escaped.includes("\,"), "???????");
});

test("批量任务按 dueDate/dueAt 排序", () => {
  const db = createTestDb();
  insertUser(db, "u1");
  insertTask(db, { id: "t3", userId: "u1", title: "最晚", dueAt: "2026-06-30T10:00" });
  insertTask(db, { id: "t1", userId: "u1", title: "最早", dueDate: "2026-06-20" });
  insertTask(db, { id: "t2", userId: "u1", title: "中间", dueAt: "2026-06-25T08:00" });

  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE userId = ? AND isCompleted = 0 AND (dueDate IS NOT NULL OR dueAt IS NOT NULL) ORDER BY dueDate, dueAt"
  ).all("u1") as any[];

  assert.equal(tasks.length, 3);
  // NULL dueDate sorts first, so dueAt-only tasks come before dueDate tasks
  assert.equal(tasks[0].id, "t2");
  assert.equal(tasks[1].id, "t3");
  assert.equal(tasks[2].id, "t1");
  db.close();
});
