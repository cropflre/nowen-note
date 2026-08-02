import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-inbox-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const USER_A = "task-inbox-user-a";
const USER_B = "task-inbox-user-b";
const WORKSPACE_ID = "task-inbox-workspace";
let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

async function requestJson(userId: string, method: string, url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

function seedSharedTask(id: string, title = "Shared task") {
  getDb().prepare(`
    INSERT INTO tasks (
      id, userId, workspaceId, title, description, isCompleted, priority,
      dueDate, dueAt, startDate, noteId, parentId, projectId, status,
      repeatRule, repeatInterval
    ) VALUES (?, ?, ?, ?, '', 0, 2, NULL, NULL, NULL, NULL, NULL, NULL, 'todo', 'none', 1)
  `).run(id, USER_A, WORKSPACE_ID, title);
}

test.before(async () => {
  const [inboxModule, schemaModule, migrationModule] = await Promise.all([
    import("../src/routes/task-inbox"),
    import("../src/db/schema"),
    import("../src/db/taskInboxMigration"),
  ]);
  app = new Hono();
  app.route("/task-inbox", inboxModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  const db = getDb();
  migrationModule.taskInboxMigration.up(db);
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
  );
  insertUser.run(USER_A, USER_A, "hash");
  insertUser.run(USER_B, USER_B, "hash");
  db.prepare(
    "INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)",
  ).run(WORKSPACE_ID, "Task Inbox Workspace", USER_A);
  db.prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')",
  ).run(WORKSPACE_ID, USER_A);
  db.prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'editor')",
  ).run(WORKSPACE_ID, USER_B);
});

test.beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM task_inbox_items").run();
  db.prepare("DELETE FROM task_reminders").run();
  db.prepare("DELETE FROM task_dependencies").run();
  db.prepare("DELETE FROM tasks").run();
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("captures a task atomically and organizes it without deleting the task", async () => {
  const captured = await requestJson(USER_A, "POST", "/task-inbox/capture", {
    workspaceId: "personal",
    title: "Review release checklist",
    description: "Captured from an implementation note",
    priority: 3,
    dueDate: "2026-08-03",
    sourceType: "selection",
    sourceId: "note-123",
    sourceTitle: "Release plan",
    excerpt: "Review release checklist before publishing",
  });
  assert.equal(captured.status, 201);
  assert.equal(captured.json.count, 1);
  assert.equal(captured.json.task.title, "Review release checklist");
  assert.equal(captured.json.task.captureSourceType, "selection");
  assert.equal(captured.json.task.captureSourceId, "note-123");

  const listed = await requestJson(
    USER_A,
    "GET",
    "/task-inbox?workspaceId=personal",
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.items[0].captureSourceTitle, "Release plan");

  const organized = await requestJson(
    USER_A,
    "DELETE",
    `/task-inbox/${captured.json.task.id}`,
  );
  assert.equal(organized.status, 200);
  assert.equal(organized.json.count, 0);

  const task = getDb().prepare(
    "SELECT title, isCompleted FROM tasks WHERE id = ?",
  ).get(captured.json.task.id) as { title: string; isCompleted: number } | undefined;
  assert.deepEqual(task, { title: "Review release checklist", isCompleted: 0 });
});

test("keeps personal Inbox tasks private", async () => {
  const captured = await requestJson(USER_A, "POST", "/task-inbox/capture", {
    workspaceId: "personal",
    title: "Private capture",
  });
  assert.equal(captured.status, 201);

  const otherList = await requestJson(USER_B, "GET", "/task-inbox?workspaceId=personal");
  assert.equal(otherList.status, 200);
  assert.deepEqual(otherList.json.items, []);

  const otherAdd = await requestJson(
    USER_B,
    "POST",
    `/task-inbox/${captured.json.task.id}`,
    { sourceType: "manual" },
  );
  assert.equal(otherAdd.status, 404);
});

test("allows each workspace member to keep an independent Inbox membership", async () => {
  const taskId = "shared-inbox-task";
  seedSharedTask(taskId);

  const addedByA = await requestJson(
    USER_A,
    "POST",
    `/task-inbox/${taskId}`,
    { sourceType: "manual", sourceTitle: "Owner Inbox" },
  );
  const addedByB = await requestJson(
    USER_B,
    "POST",
    `/task-inbox/${taskId}`,
    { sourceType: "manual", sourceTitle: "Editor Inbox" },
  );
  assert.equal(addedByA.status, 200);
  assert.equal(addedByB.status, 200);

  const listA = await requestJson(
    USER_A,
    "GET",
    `/task-inbox?workspaceId=${WORKSPACE_ID}`,
  );
  const listB = await requestJson(
    USER_B,
    "GET",
    `/task-inbox?workspaceId=${WORKSPACE_ID}`,
  );
  assert.equal(listA.json.count, 1);
  assert.equal(listB.json.count, 1);
  assert.equal(listA.json.items[0].captureSourceTitle, "Owner Inbox");
  assert.equal(listB.json.items[0].captureSourceTitle, "Editor Inbox");

  const removedByA = await requestJson(USER_A, "DELETE", `/task-inbox/${taskId}`);
  assert.equal(removedByA.status, 200);

  const afterA = await requestJson(
    USER_A,
    "GET",
    `/task-inbox?workspaceId=${WORKSPACE_ID}`,
  );
  const afterB = await requestJson(
    USER_B,
    "GET",
    `/task-inbox?workspaceId=${WORKSPACE_ID}`,
  );
  assert.equal(afterA.json.count, 0);
  assert.equal(afterB.json.count, 1);
});

test("clears Inbox rows on completion and cascades rows when a task is deleted", async () => {
  const first = await requestJson(USER_A, "POST", "/task-inbox/capture", {
    workspaceId: "personal",
    title: "Complete captured task",
  });
  getDb().prepare(
    "UPDATE tasks SET isCompleted = 1, status = 'done' WHERE id = ?",
  ).run(first.json.task.id);

  const hidden = await requestJson(USER_A, "GET", "/task-inbox?workspaceId=personal");
  assert.equal(hidden.json.count, 0);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM task_inbox_items").get() as { count: number }).count,
    0,
  );

  const second = await requestJson(USER_A, "POST", "/task-inbox/capture", {
    workspaceId: "personal",
    title: "Delete captured task",
  });
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(second.json.task.id);
  assert.equal(
    (getDb().prepare(
      "SELECT COUNT(*) AS count FROM task_inbox_items WHERE taskId = ?",
    ).get(second.json.task.id) as { count: number }).count,
    0,
  );
});

test("validates capture dates and source metadata", async () => {
  const missingTitle = await requestJson(USER_A, "POST", "/task-inbox/capture", {
    workspaceId: "personal",
    title: "   ",
  });
  assert.equal(missingTitle.status, 400);
  assert.equal(missingTitle.json.code, "TITLE_REQUIRED");

  const invalidDate = await requestJson(USER_A, "POST", "/task-inbox/capture", {
    workspaceId: "personal",
    title: "Invalid date",
    dueDate: "2026-02-31",
  });
  assert.equal(invalidDate.status, 400);
  assert.equal(invalidDate.json.code, "INVALID_DUE_DATE");

  const fallbackSource = await requestJson(USER_A, "POST", "/task-inbox/capture", {
    workspaceId: "personal",
    title: "Unknown source",
    sourceType: "unexpected-source",
  });
  assert.equal(fallbackSource.status, 201);
  assert.equal(fallbackSource.json.task.captureSourceType, "other");
});
