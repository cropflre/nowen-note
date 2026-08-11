import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-time-planning-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const USER_A = "time-planning-user-a";
const USER_B = "time-planning-user-b";
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

test.before(async () => {
  const [tasksModule, planningModule, schemaModule, migrationModule] = await Promise.all([
    import("../src/routes/tasks"),
    import("../src/routes/task-time-blocks"),
    import("../src/db/schema"),
    import("../src/db/taskTimePlanningMigration"),
  ]);
  app = new Hono();
  app.route("/tasks", tasksModule.default);
  app.route("/task-time-blocks", planningModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  const db = getDb();
  migrationModule.taskTimePlanningMigration.up(db);
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
  );
  insertUser.run(USER_A, USER_A, "hash");
  insertUser.run(USER_B, USER_B, "hash");
});

test.beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM task_time_blocks").run();
  db.prepare("DELETE FROM task_reminders").run();
  db.prepare("DELETE FROM task_dependencies").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM workspace_members").run();
  db.prepare("DELETE FROM workspaces").run();
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("stores estimates and supports the full time block lifecycle", async () => {
  const task = await requestJson(USER_A, "POST", "/tasks", {
    title: "Plan focused implementation",
    priority: 3,
  });
  assert.equal(task.status, 201);

  const estimate = await requestJson(
    USER_A,
    "PUT",
    `/task-time-blocks/tasks/${task.json.id}/estimate`,
    { estimatedMinutes: 90 },
  );
  assert.equal(estimate.status, 200);
  assert.equal(estimate.json.estimatedMinutes, 90);

  const created = await requestJson(USER_A, "POST", "/task-time-blocks", {
    taskId: task.json.id,
    startAt: "2026-08-03T01:00:00.000Z",
    endAt: "2026-08-03T02:30:00.000Z",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.block.taskId, task.json.id);
  assert.equal(created.json.block.estimatedMinutes, 90);

  const listed = await requestJson(
    USER_A,
    "GET",
    "/task-time-blocks?workspaceId=personal&from=2026-08-03T00%3A00%3A00.000Z&to=2026-08-04T00%3A00%3A00.000Z",
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.json.blocks.length, 1);
  assert.equal(listed.json.blocks[0].taskTitle, "Plan focused implementation");

  const updated = await requestJson(USER_A, "PUT", `/task-time-blocks/${created.json.block.id}`, {
    startAt: "2026-08-03T03:00:00.000Z",
    endAt: "2026-08-03T04:00:00.000Z",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.block.startAt, "2026-08-03T03:00:00.000Z");

  const removed = await requestJson(USER_A, "DELETE", `/task-time-blocks/${created.json.block.id}`);
  assert.equal(removed.status, 200);

  const afterDelete = await requestJson(
    USER_A,
    "GET",
    "/task-time-blocks?workspaceId=personal&from=2026-08-03T00%3A00%3A00.000Z&to=2026-08-04T00%3A00%3A00.000Z",
  );
  assert.deepEqual(afterDelete.json.blocks, []);
});

test("rejects invalid block durations", async () => {
  const task = await requestJson(USER_A, "POST", "/tasks", { title: "Invalid duration" });

  const tooShort = await requestJson(USER_A, "POST", "/task-time-blocks", {
    taskId: task.json.id,
    startAt: "2026-08-03T01:00:00.000Z",
    endAt: "2026-08-03T01:01:00.000Z",
  });
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.json.code, "INVALID_TIME_BLOCK_DURATION");

  const badEstimate = await requestJson(
    USER_A,
    "PUT",
    `/task-time-blocks/tasks/${task.json.id}/estimate`,
    { estimatedMinutes: 0 },
  );
  assert.equal(badEstimate.status, 400);
  assert.equal(badEstimate.json.code, "INVALID_ESTIMATE");
});

test("keeps personal estimates and blocks private to the task owner", async () => {
  const task = await requestJson(USER_A, "POST", "/tasks", { title: "Private planning" });

  const otherEstimate = await requestJson(
    USER_B,
    "PUT",
    `/task-time-blocks/tasks/${task.json.id}/estimate`,
    { estimatedMinutes: 30 },
  );
  assert.equal(otherEstimate.status, 403);

  const otherBlock = await requestJson(USER_B, "POST", "/task-time-blocks", {
    taskId: task.json.id,
    startAt: "2026-08-03T01:00:00.000Z",
    endAt: "2026-08-03T01:30:00.000Z",
  });
  assert.equal(otherBlock.status, 404);
});

test("inherits the estimate when a recurring task generates its next instance", async () => {
  const task = await requestJson(USER_A, "POST", "/tasks", {
    title: "Recurring focus session",
    dueDate: "2026-08-03",
    repeatRule: "daily",
    repeatInterval: 1,
  });
  assert.equal(task.status, 201);

  const estimate = await requestJson(
    USER_A,
    "PUT",
    `/task-time-blocks/tasks/${task.json.id}/estimate`,
    { estimatedMinutes: 45 },
  );
  assert.equal(estimate.status, 200);

  const toggled = await requestJson(USER_A, "PATCH", `/tasks/${task.json.id}/toggle`);
  assert.equal(toggled.status, 200);
  assert.ok(toggled.json.generatedTask?.id);
  assert.equal(toggled.json.generatedTask.estimatedMinutes, 45);
});

test("lets workspace members plan the same shared task in private schedules", async () => {
  const db = getDb();
  const workspaceId = "time-planning-workspace";
  db.prepare(
    "INSERT INTO workspaces (id, name, ownerId, enabledFeatures) VALUES (?, ?, ?, ?)"
  ).run(workspaceId, "Time Planning", USER_A, "{}");
  db.prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)"
  ).run(workspaceId, USER_A, "owner");
  db.prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)"
  ).run(workspaceId, USER_B, "editor");

  const task = await requestJson(
    USER_A,
    "POST",
    `/tasks?workspaceId=${workspaceId}`,
    { title: "Shared launch task" },
  );
  assert.equal(task.status, 201);

  const ownerBlock = await requestJson(USER_A, "POST", "/task-time-blocks", {
    taskId: task.json.id,
    startAt: "2026-08-03T01:00:00.000Z",
    endAt: "2026-08-03T02:00:00.000Z",
  });
  const memberBlock = await requestJson(USER_B, "POST", "/task-time-blocks", {
    taskId: task.json.id,
    startAt: "2026-08-03T03:00:00.000Z",
    endAt: "2026-08-03T04:00:00.000Z",
  });
  assert.equal(ownerBlock.status, 201);
  assert.equal(memberBlock.status, 201);

  const range = `workspaceId=${workspaceId}&from=2026-08-03T00%3A00%3A00.000Z&to=2026-08-04T00%3A00%3A00.000Z`;
  const ownerSchedule = await requestJson(USER_A, "GET", `/task-time-blocks?${range}`);
  const memberSchedule = await requestJson(USER_B, "GET", `/task-time-blocks?${range}`);
  assert.deepEqual(ownerSchedule.json.blocks.map((block: { id: string }) => block.id), [ownerBlock.json.block.id]);
  assert.deepEqual(memberSchedule.json.blocks.map((block: { id: string }) => block.id), [memberBlock.json.block.id]);

  const memberCannotEditOwner = await requestJson(
    USER_B,
    "PUT",
    `/task-time-blocks/${ownerBlock.json.block.id}`,
    { startAt: "2026-08-03T05:00:00.000Z", endAt: "2026-08-03T06:00:00.000Z" },
  );
  assert.equal(memberCannotEditOwner.status, 404);
});
