import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-desc-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "user-desc";

function db() {
  return getDb();
}

function seedUser() {
  db()
    .prepare(
      "INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
    )
    .run(USER_ID, USER_ID, "hash");
}

function resetTasks() {
  db().prepare("DELETE FROM task_templates").run();
  db().prepare("DELETE FROM task_reminders").run();
  db().prepare("DELETE FROM tasks").run();
}

async function requestJson(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
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

test.before(() => {
  return Promise.all([
    import("../src/routes/tasks"),
    import("../src/routes/task-templates"),
    import("../src/db/schema"),
  ]).then(([tasksModule, taskTemplatesModule, schemaModule]) => {
    app = new Hono();
    app.route("/tasks", tasksModule.default);
    app.route("/task-templates", taskTemplatesModule.default);
    getDb = schemaModule.getDb;
    closeDb = schemaModule.closeDb;
  }).then(() => {
  seedUser();
  });
});

test.beforeEach(() => {
  resetTasks();
});

test.after(() => {
  closeDb();
  // Small delay to ensure file handles are released on Windows
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Retry once after a brief delay (Windows file lock issue)
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 100);
  }
});

test("creating a task stores description", async () => {
  const res = await requestJson("POST", "/tasks", {
    title: "Write spec",
    description: "Include acceptance criteria.",
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.description, "Include acceptance criteria.");
});

test("creating a task without description defaults to empty string", async () => {
  const res = await requestJson("POST", "/tasks", { title: "Untitled details" });

  assert.equal(res.status, 201);
  assert.equal(res.json.description, "");
});

test("updating description to an empty string succeeds", async () => {
  const created = await requestJson("POST", "/tasks", {
    title: "Editable",
    description: "Initial details",
  });

  const updated = await requestJson("PUT", `/tasks/${created.json.id}`, {
    description: "",
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.json.task.description, "");
});

test("updating title does not clear description", async () => {
  const created = await requestJson("POST", "/tasks", {
    title: "Old title",
    description: "Keep these details",
  });

  const updated = await requestJson("PUT", `/tasks/${created.json.id}`, {
    title: "New title",
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.json.task.title, "New title");
  assert.equal(updated.json.task.description, "Keep these details");
});

test("generated repeated task copies description", async () => {
  const created = await requestJson("POST", "/tasks", {
    title: "Weekly review",
    description: "Review metrics and blockers.",
    dueDate: "2026-06-16",
    repeatRule: "weekly",
    repeatInterval: 1,
  });

  const updated = await requestJson("PUT", `/tasks/${created.json.id}`, {
    isCompleted: 1,
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.json.generatedTask.description, "Review metrics and blockers.");
});

test("applying a template copies item description", async () => {
  const template = await requestJson("POST", "/task-templates", {
    name: "Launch checklist",
    items: [
      {
        title: "Verify release",
        description: "Check build, smoke tests, and rollback notes.",
        priority: 3,
        relativeDueDays: null,
        parentIndex: null,
        sortOrder: 0,
      },
    ],
  });

  const applied = await requestJson("POST", `/task-templates/${template.json.id}/apply`, {});

  assert.equal(applied.status, 200);
  assert.equal(applied.json.createdTasks[0].description, "Check build, smoke tests, and rollback notes.");
  const row = db()
    .prepare("SELECT description FROM tasks WHERE id = ?")
    .get(applied.json.createdTasks[0].id) as { description: string };
  assert.equal(row.description, "Check build, smoke tests, and rollback notes.");
});
