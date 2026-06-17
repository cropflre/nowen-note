import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-reorder-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "user-reorder";
const OTHER_ID = "other-reorder";

function db() {
  return getDb();
}

function seedUsers() {
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(OTHER_ID, OTHER_ID, "hash");
}

function resetTasks() {
  db().prepare("DELETE FROM task_reminders").run();
  db().prepare("DELETE FROM tasks").run();
}

async function requestJson(method: string, url: string, body?: unknown, userId = USER_ID) {
  const res = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test.before(async () => {
  const [tasksModule, schemaModule] = await Promise.all([
    import("../src/routes/tasks"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/tasks", tasksModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  seedUsers();
});

test.beforeEach(() => {
  resetTasks();
});

test.after(async () => {
  closeDb();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err?.code !== "EBUSY") throw err;
      if (i === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("task list includes active reminder count for current user only", async () => {
  const task = await requestJson("POST", "/tasks", { title: "Has reminder" });
  db().prepare(
    "INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled) VALUES (?, ?, ?, ?, ?)",
  ).run("r1", task.json.id, USER_ID, 5, 1);
  db().prepare(
    "INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled) VALUES (?, ?, ?, ?, ?)",
  ).run("r2", task.json.id, USER_ID, 60, 0);
  db().prepare(
    "INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled) VALUES (?, ?, ?, ?, ?)",
  ).run("r3", task.json.id, OTHER_ID, 30, 1);

  const list = await requestJson("GET", "/tasks");

  assert.equal(list.status, 200);
  assert.equal(list.json[0].activeReminderCount, 1);
});

test("reorder batch updates same-level sortOrder values", async () => {
  const a = await requestJson("POST", "/tasks", { title: "A" });
  const b = await requestJson("POST", "/tasks", { title: "B" });
  const c = await requestJson("POST", "/tasks", { title: "C" });

  const res = await requestJson("PUT", "/tasks/reorder/batch", {
    items: [
      { id: c.json.id, sortOrder: 0 },
      { id: a.json.id, sortOrder: 1 },
      { id: b.json.id, sortOrder: 2 },
    ],
  });

  assert.equal(res.status, 200);
  const rows = db()
    .prepare("SELECT id, sortOrder FROM tasks WHERE id IN (?, ?, ?) ORDER BY sortOrder ASC")
    .all(a.json.id, b.json.id, c.json.id) as Array<{ id: string; sortOrder: number }>;
  assert.deepEqual(rows.map((r) => r.id), [c.json.id, a.json.id, b.json.id]);
});

test("reorder batch rejects mixed parent levels", async () => {
  const parent = await requestJson("POST", "/tasks", { title: "Parent" });
  const child = await requestJson("POST", "/tasks", { title: "Child", parentId: parent.json.id });
  const root = await requestJson("POST", "/tasks", { title: "Root" });

  const res = await requestJson("PUT", "/tasks/reorder/batch", {
    items: [
      { id: child.json.id, sortOrder: 0 },
      { id: root.json.id, sortOrder: 1 },
    ],
  });

  assert.equal(res.status, 400);
  assert.equal(res.json.code, "MIXED_PARENT_TASKS");
});

test("reorder batch rejects missing tasks", async () => {
  const res = await requestJson("PUT", "/tasks/reorder/batch", {
    items: [{ id: "missing-task", sortOrder: 0 }],
  });

  assert.equal(res.status, 404);
  assert.equal(res.json.code, "TASK_NOT_FOUND");
});

test("reorder batch rejects tasks without permission", async () => {
  const otherTask = await requestJson("POST", "/tasks", { title: "Other" }, OTHER_ID);

  const res = await requestJson("PUT", "/tasks/reorder/batch", {
    items: [{ id: otherTask.json.id, sortOrder: 0 }],
  });

  assert.equal(res.status, 403);
  assert.equal(res.json.code, "FORBIDDEN");
});
