import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-repeat-count-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "user-repeat-count";

function db() {
  return getDb();
}

function seedUser() {
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
}

function resetTasks() {
  db().prepare("DELETE FROM task_reminders").run();
  db().prepare("DELETE FROM tasks").run();
}

async function requestJson(method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: {
      "X-User-Id": USER_ID,
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
  seedUser();
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

test("repeatEndCount=1 does not generate another occurrence", async () => {
  const created = await requestJson("POST", "/tasks", {
    title: "One shot repeat",
    dueDate: "2026-07-01",
    repeatRule: "daily",
    repeatEndCount: 1,
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.repeatEndCount, 1);
  assert.equal(created.json.repeatSequenceIndex, 1);

  const toggled = await requestJson("PATCH", `/tasks/${created.json.id}/toggle`);

  assert.equal(toggled.status, 200);
  assert.equal(toggled.json.generatedTask, null);
  const rows = db().prepare("SELECT id FROM tasks").all() as { id: string }[];
  assert.equal(rows.length, 1);
});

test("repeatEndCount=2 generates exactly one next occurrence", async () => {
  const first = await requestJson("POST", "/tasks", {
    title: "Two payments",
    dueDate: "2026-07-01",
    repeatRule: "daily",
    repeatEndCount: 2,
  });

  const firstDone = await requestJson("PATCH", `/tasks/${first.json.id}/toggle`);

  assert.equal(firstDone.status, 200);
  assert.ok(firstDone.json.generatedTask);
  assert.equal(firstDone.json.generatedTask.repeatEndCount, 2);
  assert.equal(firstDone.json.generatedTask.repeatGroupId, first.json.id);
  assert.equal(firstDone.json.generatedTask.repeatSequenceIndex, 2);

  const secondDone = await requestJson("PATCH", `/tasks/${firstDone.json.generatedTask.id}/toggle`);

  assert.equal(secondDone.status, 200);
  assert.equal(secondDone.json.generatedTask, null);
  const rows = db().prepare("SELECT id FROM tasks").all() as { id: string }[];
  assert.equal(rows.length, 2);
});

test("repeatEndCount rejects invalid values", async () => {
  for (const value of [0, -1, 1.5, "abc", 1000]) {
    const res = await requestJson("POST", "/tasks", {
      title: `Invalid ${value}`,
      dueDate: "2026-07-01",
      repeatRule: "daily",
      repeatEndCount: value,
    });

    assert.equal(res.status, 400);
    assert.equal(res.json.code, "INVALID_REPEAT_END_COUNT");
  }
});

test("repeatRule none clears repeatEndCount", async () => {
  const created = await requestJson("POST", "/tasks", {
    title: "Not repeating",
    repeatRule: "none",
    repeatEndCount: 5,
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.repeatEndCount, null);
});
