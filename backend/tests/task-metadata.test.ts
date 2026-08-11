import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-metadata-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const USER_ID = "task-metadata-user";
let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

async function requestJson(method: string, url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: {
      "X-User-Id": USER_ID,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

test.before(async () => {
  const [tasksModule, metadataModule, schemaModule, migrationModule] = await Promise.all([
    import("../src/routes/tasks"),
    import("../src/routes/task-metadata"),
    import("../src/db/schema"),
    import("../src/db/taskMetadataMigration"),
  ]);
  app = new Hono();
  app.route("/tasks", tasksModule.default);
  app.route("/task-metadata", metadataModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  const db = getDb();
  // The route also installs the schema lazily on first request. Tests clean the
  // tables in beforeEach, so initialize v71 explicitly before that hook runs.
  migrationModule.taskMetadataMigration.up(db);
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
  ).run(USER_ID, USER_ID, "hash");
});

test.beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM task_label_links").run();
  db.prepare("DELETE FROM task_saved_views").run();
  db.prepare("DELETE FROM task_labels").run();
  db.prepare("DELETE FROM task_reminders").run();
  db.prepare("DELETE FROM task_dependencies").run();
  db.prepare("DELETE FROM tasks").run();
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("creates labels, assigns them to a task and persists a saved view", async () => {
  const task = await requestJson("POST", "/tasks", { title: "Ship task labels", priority: 3 });
  assert.equal(task.status, 201);

  const label = await requestJson("POST", "/task-metadata/labels", {
    name: "Release",
    color: "#10b981",
  });
  assert.equal(label.status, 201);

  const assignment = await requestJson(
    "PUT",
    `/task-metadata/tasks/${task.json.id}/labels`,
    { labelIds: [label.json.label.id] },
  );
  assert.equal(assignment.status, 200);
  assert.deepEqual(assignment.json.labelIds, [label.json.label.id]);

  const view = await requestJson("POST", "/task-metadata/views", {
    name: "Release focus",
    filters: {
      labelIds: [label.json.label.id],
      labelMode: "all",
      priorities: [3],
      statuses: ["todo", "doing"],
      due: "pending",
      keyword: "ship",
    },
  });
  assert.equal(view.status, 201);
  assert.deepEqual(view.json.view.filters.labelIds, [label.json.label.id]);

  const snapshot = await requestJson("GET", "/task-metadata");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.labels[0].taskCount, 1);
  assert.deepEqual(snapshot.json.assignments[task.json.id], [label.json.label.id]);
  assert.equal(snapshot.json.views[0].name, "Release focus");
});

test("rejects duplicate label names after case normalization", async () => {
  const first = await requestJson("POST", "/task-metadata/labels", { name: "Urgent" });
  assert.equal(first.status, 201);

  const duplicate = await requestJson("POST", "/task-metadata/labels", { name: " urgent " });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, "LABEL_NAME_CONFLICT");
});

test("deleting a label removes task links and prunes saved view filters", async () => {
  const task = await requestJson("POST", "/tasks", { title: "Clean metadata" });
  const label = await requestJson("POST", "/task-metadata/labels", { name: "Cleanup" });
  await requestJson("PUT", `/task-metadata/tasks/${task.json.id}/labels`, {
    labelIds: [label.json.label.id],
  });
  await requestJson("POST", "/task-metadata/views", {
    name: "Cleanup view",
    filters: { labelIds: [label.json.label.id] },
  });

  const removed = await requestJson("DELETE", `/task-metadata/labels/${label.json.label.id}`);
  assert.equal(removed.status, 200);

  const snapshot = await requestJson("GET", "/task-metadata");
  assert.deepEqual(snapshot.json.labels, []);
  assert.deepEqual(snapshot.json.assignments, {});
  assert.deepEqual(snapshot.json.views[0].filters.labelIds, []);
});
