import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-offline-associations-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const USER_ID = "offline-association-user";
const OTHER_USER_ID = "offline-association-other";
const FIRST_TASK_ID = "73a43e5e-d0d1-4a2e-9a1a-73f2ce317842";
const SECOND_TASK_ID = "1e233ce1-f0cf-4af5-b080-27f1eae8e76d";
const OTHER_TASK_ID = "4e3f64a3-4f91-45e4-bfe9-2a26780f9d22";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

async function requestJson(method: string, url: string, body?: unknown, operationId?: string, userId = USER_ID, clientMutationAt?: string) {
  const response = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(operationId ? { "Idempotency-Key": operationId } : {}),
      ...(clientMutationAt ? { "X-Client-Mutation-At": clientMutationAt } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function resetData() {
  db().prepare("DELETE FROM task_dependencies").run();
  db().prepare("DELETE FROM task_reminders").run();
  db().prepare("DELETE FROM habit_checkins").run();
  db().prepare("DELETE FROM habits").run();
  db().prepare("DELETE FROM tasks").run();
  db().prepare("DELETE FROM offline_mutation_results").run();
  db().prepare("DELETE FROM offline_resource_field_clocks").run();
  db().prepare("DELETE FROM offline_resource_tombstones").run();
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(OTHER_USER_ID, OTHER_USER_ID, "hash");
  db().prepare("INSERT INTO tasks (id, userId, title) VALUES (?, ?, ?)").run(FIRST_TASK_ID, USER_ID, "First task");
  db().prepare("INSERT INTO tasks (id, userId, title) VALUES (?, ?, ?)").run(SECOND_TASK_ID, USER_ID, "Second task");
  db().prepare("INSERT INTO tasks (id, userId, title) VALUES (?, ?, ?)").run(OTHER_TASK_ID, OTHER_USER_ID, "Private task");
}

test.before(async () => {
  const [dependenciesModule, habitsModule, remindersModule, tasksModule, schemaModule] = await Promise.all([
    import("../src/routes/task-dependencies"),
    import("../src/routes/habits"),
    import("../src/routes/task-reminders"),
    import("../src/routes/tasks"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/task-dependencies", dependenciesModule.default);
  app.route("/habits", habitsModule.default);
  app.route("/task-reminders", remindersModule.default);
  app.route("/tasks", tasksModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
});

test.beforeEach(() => {
  resetData();
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("offline dependency creation preserves the client UUID across replay", async () => {
  const id = "ac1e307e-1d04-48a5-9152-4d6fed9988dc";
  const payload = { id, predecessorTaskId: FIRST_TASK_ID, successorTaskId: SECOND_TASK_ID };

  const created = await requestJson("POST", "/task-dependencies", payload, "dependency-create-1");
  assert.equal(created.status, 201);
  assert.equal(created.json.id, id);

  const replayed = await requestJson("POST", "/task-dependencies", payload, "dependency-create-2");
  assert.equal(replayed.status, 200);
  assert.equal(replayed.json.id, id);
  assert.equal((db().prepare("SELECT COUNT(*) AS count FROM task_dependencies WHERE id = ?").get(id) as { count: number }).count, 1);
});

test("offline reminder creation preserves the client UUID across replay", async () => {
  const id = "baf6d8e1-6a33-47cf-96e2-f1cfa4aef840";
  const payload = { id, offsetMinutes: 45 };

  const created = await requestJson("POST", `/task-reminders/${FIRST_TASK_ID}`, payload, "reminder-create-1");
  assert.equal(created.status, 201);
  assert.equal(created.json.id, id);

  const replayed = await requestJson("POST", `/task-reminders/${FIRST_TASK_ID}`, payload, "reminder-create-2");
  assert.equal(replayed.status, 200);
  assert.equal(replayed.json.id, id);
  assert.equal((db().prepare("SELECT COUNT(*) AS count FROM task_reminders WHERE id = ?").get(id) as { count: number }).count, 1);
});

test("a user cannot create or read reminders for another user's personal task", async () => {
  const create = await requestJson("POST", `/task-reminders/${OTHER_TASK_ID}`, { offsetMinutes: 30 });
  assert.equal(create.status, 403);
  assert.equal(create.json.code, "FORBIDDEN");
  assert.equal((db().prepare("SELECT COUNT(*) AS count FROM task_reminders WHERE taskId = ?").get(OTHER_TASK_ID) as { count: number }).count, 0);

  const list = await requestJson("GET", `/task-reminders/${OTHER_TASK_ID}`);
  assert.equal(list.status, 404);
});

test("overview and snapshot do not expose legacy cross-user personal reminders", async () => {
  db().prepare("INSERT INTO task_reminders (id, taskId, userId, offsetMinutes) VALUES (?, ?, ?, ?)")
    .run("legacy-cross-user-reminder", OTHER_TASK_ID, USER_ID, 30);

  const overview = await requestJson("GET", "/task-reminders/overview");
  assert.equal(overview.status, 200);
  assert.equal(JSON.stringify(overview.json).includes("Private task"), false);

  const snapshot = await requestJson("GET", "/task-reminders/snapshot");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.reminders.some((item: { id: string }) => item.id === "legacy-cross-user-reminder"), false);
});

test("stale reminder update does not overwrite a newer value and retries are idempotent", async () => {
  const created = await requestJson("POST", `/task-reminders/${FIRST_TASK_ID}`, { offsetMinutes: 30 });

  const newer = await requestJson(
    "PUT",
    `/task-reminders/${created.json.id}`,
    { enabled: true },
    "reminder-enable-newer",
    USER_ID,
    "2026-07-21T12:00:00.000Z",
  );
  assert.equal(newer.status, 200);
  assert.equal(newer.json.enabled, 1);

  const stale = await requestJson(
    "PUT",
    `/task-reminders/${created.json.id}`,
    { enabled: false },
    "reminder-disable-older",
    USER_ID,
    "2026-07-21T11:00:00.000Z",
  );
  assert.equal(stale.status, 200);
  assert.equal(stale.json.enabled, 1);

  const retry = await requestJson(
    "PUT",
    `/task-reminders/${created.json.id}`,
    { enabled: false },
    "reminder-disable-older",
    USER_ID,
    "2026-07-21T11:00:00.000Z",
  );
  assert.equal(retry.status, 200);
  assert.equal(retry.json.enabled, 1);
});

test("same-time task mutations use operation id as a deterministic LWW tie-break", async () => {
  const at = "2026-07-21T12:00:00.000Z";
  const earlier = await requestJson("PUT", `/tasks/${FIRST_TASK_ID}`, { title: "first" }, "operation-a", USER_ID, at);
  assert.equal(earlier.status, 200);
  const later = await requestJson("PUT", `/tasks/${FIRST_TASK_ID}`, { title: "second" }, "operation-z", USER_ID, at);
  assert.equal(later.status, 200);
  const replayedEarlier = await requestJson("PUT", `/tasks/${FIRST_TASK_ID}`, { title: "first again" }, "operation-a2", USER_ID, at);
  assert.equal(replayedEarlier.status, 200);
  assert.equal(replayedEarlier.json.task.title, "second");
});

test("reminder snapshot reports current reminders and server tombstones", async () => {
  const reminder = await requestJson("POST", `/task-reminders/${FIRST_TASK_ID}`, { offsetMinutes: 15 });
  assert.equal(reminder.status, 201);

  const current = await requestJson("GET", "/task-reminders/snapshot");
  assert.equal(current.status, 200);
  assert.equal(current.json.reminders.some((item: { id: string }) => item.id === reminder.json.id), true);

  const deleted = await requestJson("DELETE", `/task-reminders/${reminder.json.id}`, undefined, "reminder-snapshot-delete");
  assert.equal(deleted.status, 200);
  const afterDelete = await requestJson("GET", "/task-reminders/snapshot");
  assert.equal(afterDelete.status, 200);
  assert.equal(afterDelete.json.reminders.some((item: { id: string }) => item.id === reminder.json.id), false);
  assert.equal(afterDelete.json.deletedIds.includes(reminder.json.id), true);
});

test("stale task, habit, and reminder deletes preserve newer field updates", async () => {
  const taskUpdate = await requestJson("PUT", `/tasks/${FIRST_TASK_ID}`, { title: "new task title" }, "task-update-new", USER_ID, "2026-07-21T12:00:00.000Z");
  assert.equal(taskUpdate.status, 200);
  const taskDelete = await requestJson("DELETE", `/tasks/${FIRST_TASK_ID}`, undefined, "task-delete-old", USER_ID, "2026-07-21T11:00:00.000Z");
  assert.deepEqual(taskDelete.json, { success: true, syncIgnored: true });
  assert.equal((db().prepare("SELECT title FROM tasks WHERE id = ?").get(FIRST_TASK_ID) as { title: string }).title, "new task title");

  const habitId = "ed9d1e83-6f04-4a80-a691-7e4761bcfc54";
  db().prepare("INSERT INTO habits (id, userId, title, icon, color, sortOrder) VALUES (?, ?, ?, ?, ?, ?)")
    .run(habitId, USER_ID, "Old habit", "check-circle", "#10b981", 0);
  const habitUpdate = await requestJson("PUT", `/habits/${habitId}`, { title: "new habit title" }, "habit-update-new", USER_ID, "2026-07-21T12:00:00.000Z");
  assert.equal(habitUpdate.status, 200);
  const habitDelete = await requestJson("DELETE", `/habits/${habitId}`, undefined, "habit-delete-old", USER_ID, "2026-07-21T11:00:00.000Z");
  assert.deepEqual(habitDelete.json, { success: true, syncIgnored: true });
  assert.equal((db().prepare("SELECT title FROM habits WHERE id = ?").get(habitId) as { title: string }).title, "new habit title");

  const reminder = await requestJson("POST", `/task-reminders/${SECOND_TASK_ID}`, { offsetMinutes: 30 });
  const reminderUpdate = await requestJson("PUT", `/task-reminders/${reminder.json.id}`, { enabled: false }, "reminder-update-new", USER_ID, "2026-07-21T12:00:00.000Z");
  assert.equal(reminderUpdate.status, 200);
  const reminderDelete = await requestJson("DELETE", `/task-reminders/${reminder.json.id}`, undefined, "reminder-delete-old", USER_ID, "2026-07-21T11:00:00.000Z");
  assert.deepEqual(reminderDelete.json, { success: true, syncIgnored: true });
  assert.equal((db().prepare("SELECT enabled FROM task_reminders WHERE id = ?").get(reminder.json.id) as { enabled: number }).enabled, 0);
});

test("deleted habit check-in query returns a silent tombstone response", async () => {
  const habitId = "816afde5-0e32-4694-8797-5b9856d2b15f";
  db().prepare(`
    INSERT INTO offline_resource_tombstones (resourceType, resourceId, userId, workspaceId, deletedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run("habit", habitId, USER_ID, null, "2026-07-21T00:00:00.000Z");

  const result = await requestJson("GET", `/habits/${habitId}/checkins`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { success: true, syncIgnored: true });
});

test("another user cannot observe or consume a tombstoned habit", async () => {
  const habitId = "9576e9bf-9bda-4293-9e6e-e51e6ce9cb84";
  db().prepare(`
    INSERT INTO offline_resource_tombstones (resourceType, resourceId, userId, workspaceId, deletedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run("habit", habitId, USER_ID, null, "2026-07-21T00:00:00.000Z");

  const result = await requestJson("GET", `/habits/${habitId}/checkins`, undefined, undefined, OTHER_USER_ID);
  assert.equal(result.status, 404);
  assert.equal(result.json.syncIgnored, undefined);
});

test("stale offline habit check-in returns the current row without a duplicate insert", async () => {
  const habitId = "6a6bb057-b4e7-4630-bb58-b57c02c8d99a";
  const checkinDate = "2026-07-21";
  db().prepare("INSERT INTO habits (id, userId, title, icon, color, sortOrder) VALUES (?, ?, ?, ?, ?, ?)")
    .run(habitId, USER_ID, "Walk", "check-circle", "#10b981", 0);

  const newer = await requestJson("POST", `/habits/${habitId}/checkins`, { status: "success", note: "new", checkinDate }, "checkin-new", USER_ID, "2026-07-21T12:00:00.000Z");
  assert.equal(newer.status, 201);

  const stale = await requestJson("POST", `/habits/${habitId}/checkins`, { status: "failure", note: "old", checkinDate }, "checkin-old", USER_ID, "2026-07-21T11:00:00.000Z");
  assert.equal(stale.status, 200);
  assert.equal(stale.json.status, "success");
  assert.equal(stale.json.note, "new");
  assert.equal((db().prepare("SELECT COUNT(*) AS count FROM habit_checkins WHERE habitId = ? AND checkinDate = ?").get(habitId, checkinDate) as { count: number }).count, 1);
});

test("future client clocks are normalized so they cannot block later mutations", async () => {
  const future = await requestJson(
    "PUT",
    `/tasks/${FIRST_TASK_ID}`,
    { title: "future clock" },
    "future-clock",
    USER_ID,
    "2099-01-01T00:00:00.000Z",
  );
  assert.equal(future.status, 200);

  const current = await requestJson(
    "PUT",
    `/tasks/${FIRST_TASK_ID}`,
    { title: "current clock" },
    "current-clock",
    USER_ID,
    new Date(Date.now() + 1_000).toISOString(),
  );
  assert.equal(current.status, 200);
  assert.equal(current.json.task.title, "current clock");
  const clock = db().prepare(`
    SELECT clientUpdatedAt
    FROM offline_resource_field_clocks
    WHERE resourceType = 'task' AND resourceId = ? AND fieldName = 'title'
  `).get(FIRST_TASK_ID) as { clientUpdatedAt: string };
  assert.ok(clock.clientUpdatedAt < "2099-01-01T00:00:00.000Z");
});

test("another user cannot silently consume a deleted task tombstone", async () => {
  const taskId = "c0c15c39-9a5c-4c7b-9985-6199b9fccddf";
  db().prepare(`
    INSERT INTO offline_resource_tombstones (resourceType, resourceId, userId, workspaceId, deletedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run("task", taskId, USER_ID, null, "2026-07-21T00:00:00.000Z");

  const result = await requestJson("PATCH", `/tasks/${taskId}/toggle`, { isCompleted: true }, "task-toggle-other", OTHER_USER_ID, "2026-07-21T00:01:00.000Z");
  assert.equal(result.status, 404);
  assert.equal(result.json.syncIgnored, undefined);
});

test("dependency deletion succeeds when replayed after a lost response", async () => {
  const created = await requestJson("POST", "/task-dependencies", {
    predecessorTaskId: FIRST_TASK_ID,
    successorTaskId: SECOND_TASK_ID,
  });
  const firstDelete = await requestJson("DELETE", `/task-dependencies/${created.json.id}`, undefined, "dependency-delete-1");
  assert.equal(firstDelete.status, 200);

  const replayedDelete = await requestJson("DELETE", `/task-dependencies/${created.json.id}`, undefined, "dependency-delete-2");
  assert.equal(replayedDelete.status, 200);
  assert.deepEqual(replayedDelete.json, { success: true, syncIgnored: true });
});

test("reminder deletion succeeds when replayed after a lost response", async () => {
  const created = await requestJson("POST", `/task-reminders/${FIRST_TASK_ID}`, { offsetMinutes: 30 });
  const firstDelete = await requestJson("DELETE", `/task-reminders/${created.json.id}`, undefined, "reminder-delete-1");
  assert.equal(firstDelete.status, 200);

  const replayedDelete = await requestJson("DELETE", `/task-reminders/${created.json.id}`, undefined, "reminder-delete-2");
  assert.equal(replayedDelete.status, 200);
  assert.deepEqual(replayedDelete.json, { success: true, syncIgnored: true });
});

test("stale dependency and reminder creates do not revive tombstoned associations", async () => {
  const dependencyId = "4a26b1de-8bbb-423f-bd4f-3ddc2ed6e6df";
  db().prepare(`
    INSERT INTO offline_resource_tombstones (resourceType, resourceId, userId, workspaceId, deletedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run("taskDependency", dependencyId, USER_ID, null, "2026-07-21T12:00:00.000Z");
  const dependency = await requestJson(
    "POST",
    "/task-dependencies",
    { id: dependencyId, predecessorTaskId: FIRST_TASK_ID, successorTaskId: SECOND_TASK_ID },
    "dependency-create-old",
    USER_ID,
    "2026-07-21T11:00:00.000Z",
  );
  assert.deepEqual(dependency.json, { success: true, syncIgnored: true });
  assert.equal((db().prepare("SELECT COUNT(*) AS count FROM task_dependencies WHERE id = ?").get(dependencyId) as { count: number }).count, 0);

  const reminderId = "8f22a0d3-1e62-4518-b7c4-b0999ba790bd";
  db().prepare(`
    INSERT INTO offline_resource_tombstones (resourceType, resourceId, userId, workspaceId, deletedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run("taskReminder", reminderId, USER_ID, null, "2026-07-21T12:00:00.000Z");
  const reminder = await requestJson(
    "POST",
    `/task-reminders/${FIRST_TASK_ID}`,
    { id: reminderId, offsetMinutes: 30 },
    "reminder-create-old",
    USER_ID,
    "2026-07-21T11:00:00.000Z",
  );
  assert.deepEqual(reminder.json, { success: true, syncIgnored: true });
  assert.equal((db().prepare("SELECT COUNT(*) AS count FROM task_reminders WHERE id = ?").get(reminderId) as { count: number }).count, 0);
});