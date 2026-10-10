import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-digest-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(dir, "task-digest.test.db");

test("personal digests are isolated, timezone-aware, and delivery claims are idempotent", async () => {
  const { getDb, closeDb } = await import("../src/db/schema");
  const { initWebhookTables } = await import("../src/services/webhook");
  const { default: router, buildTaskDigest, dispatchScheduledTaskDigests } = await import("../src/routes/task-digest");
  const db = getDb();
  initWebhookTables();
  db.exec(`
    INSERT OR IGNORE INTO users(id,username,passwordHash) VALUES
      ('digest-user-a','digest-a','hash'),('digest-user-b','digest-b','hash');
    INSERT INTO tasks(id,userId,title,dueDate,isCompleted,priority) VALUES
      ('digest-a-today','digest-user-a','Review PR','2026-10-08',0,3),
      ('digest-a-past','digest-user-a','Finish tests','2026-10-07',0,2),
      ('digest-b-secret','digest-user-b','Private task','2026-10-08',0,3);
    INSERT INTO tasks(id,userId,title,dueDate,isCompleted,completedAt,priority) VALUES
      ('digest-a-done','digest-user-a','Ship fixes','2026-10-08',1,'2026-10-08T00:35:00.000Z',2);
    INSERT INTO tasks(id,userId,title,dueAt,isCompleted,priority) VALUES
      ('digest-a-clock','digest-user-a','Run check','2026-10-08T09:00:00',0,3);
  `);
  try {
    const app = new Hono();
    app.route("/api/task-digest", router);
    const headers = { "X-User-Id": "digest-user-a", "Content-Type": "application/json" };
    const saved = await app.request("/api/task-digest", {
      method: "PUT", headers,
      body: JSON.stringify({ morningEnabled: true, eveningEnabled: true, dueEnabled: true,
        morningTime: "09:00", eveningTime: "21:00", timezone: "Asia/Shanghai" }),
    });
    assert.equal(saved.status, 200);
    const morning = buildTaskDigest("digest-user-a", "morning", new Date("2026-10-08T01:00:00.000Z"));
    assert.equal(morning.counts.dueToday, 3);
    assert.equal(morning.counts.completedToday, 1);
    assert.equal(morning.counts.overdue, 1);
    assert.equal(morning.tasks.some((item) => item.title === "Private task"), false);
    const first = dispatchScheduledTaskDigests(new Date("2026-10-08T01:00:00.000Z"));
    const second = dispatchScheduledTaskDigests(new Date("2026-10-08T01:00:00.000Z"));
    assert.equal(first, 2); // morning brief + one precise deadline
    assert.equal(second, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM task_digest_dispatches").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM task_digest_deadlines").get() as { n: number }).n, 1);
    const bad = await app.request("/api/task-digest", {
      method: "PUT", headers, body: JSON.stringify({ timezone: "Invalid/Nowhere" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
