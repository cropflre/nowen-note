import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-completed-at-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "user-completed-at";

function db() {
  return getDb();
}

function seedUser() {
  db()
    .prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
}

function resetTasks() {
  db().prepare("DELETE FROM task_reminders").run();
  db().prepare("DELETE FROM tasks").run();
  db().prepare("DELETE FROM offline_resource_field_clocks").run();
  db().prepare("DELETE FROM offline_mutation_results").run();
}

async function requestJson(method: string, url: string, body?: unknown, clientMutationAt?: string, operationId?: string) {
  const res = await app.request(url, {
    method,
    headers: {
      "X-User-Id": USER_ID,
      ...(clientMutationAt ? { "X-Client-Mutation-At": clientMutationAt } : {}),
      ...(operationId ? { "Idempotency-Key": operationId } : {}),
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

test("creating a done task persists completedAt", async () => {
  const created = await requestJson("POST", "/tasks", {
    title: "Already done",
    status: "done",
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.isCompleted, 1);
  assert.equal(created.json.status, "done");
  assert.ok(created.json.completedAt);

  const row = db().prepare("SELECT isCompleted, status, completedAt FROM tasks WHERE id = ?").get(created.json.id) as {
    isCompleted: number;
    status: string;
    completedAt: string | null;
  };
  assert.equal(row.isCompleted, 1);
  assert.equal(row.status, "done");
  assert.ok(row.completedAt);
});

test("put sets completedAt when marking task done and preserves it on later edits", async () => {
  const created = await requestJson("POST", "/tasks", { title: "Write changelog" });
  assert.equal(created.status, 201);
  assert.equal(created.json.completedAt, null);

  const completed = await requestJson("PUT", `/tasks/${created.json.id}`, {
    status: "done",
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.json.task.isCompleted, 1);
  assert.ok(completed.json.task.completedAt);

  const firstCompletedAt = completed.json.task.completedAt;

  const edited = await requestJson("PUT", `/tasks/${created.json.id}`, {
    title: "Write release changelog",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.task.completedAt, firstCompletedAt);

  const row = db().prepare("SELECT title, completedAt FROM tasks WHERE id = ?").get(created.json.id) as {
    title: string;
    completedAt: string | null;
  };
  assert.equal(row.title, "Write release changelog");
  assert.equal(row.completedAt, firstCompletedAt);
});

test("put clears completedAt when reopening a completed task", async () => {
  const created = await requestJson("POST", "/tasks", {
    title: "Reopen me",
    status: "done",
  });

  const reopened = await requestJson("PUT", `/tasks/${created.json.id}`, {
    isCompleted: 0,
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.task.isCompleted, 0);
  assert.equal(reopened.json.task.status, "todo");
  assert.equal(reopened.json.task.completedAt, null);

  const row = db().prepare("SELECT isCompleted, status, completedAt FROM tasks WHERE id = ?").get(created.json.id) as {
    isCompleted: number;
    status: string;
    completedAt: string | null;
  };
  assert.equal(row.isCompleted, 0);
  assert.equal(row.status, "todo");
  assert.equal(row.completedAt, null);
});

test("completion fields share an atomic LWW clock group", async () => {
  const created = await requestJson("POST", "/tasks", { title: "Clock group" });

  const completed = await requestJson(
    "PUT",
    `/tasks/${created.json.id}`,
    { isCompleted: true },
    "2026-07-21T12:00:00.000Z",
    "complete-newer",
  );
  assert.equal(completed.status, 200);
  assert.equal(completed.json.task.status, "done");

  const stale = await requestJson(
    "PUT",
    `/tasks/${created.json.id}`,
    { status: "todo" },
    "2026-07-21T11:00:00.000Z",
    "status-older",
  );
  assert.equal(stale.status, 200);
  assert.equal(stale.json.task.isCompleted, 1);
  assert.equal(stale.json.task.status, "done");
  assert.ok(stale.json.task.completedAt);
});

test("toggle writes and clears completedAt", async () => {
  const created = await requestJson("POST", "/tasks", { title: "Toggle me" });

  const done = await requestJson("PATCH", `/tasks/${created.json.id}/toggle`);
  assert.equal(done.status, 200);
  assert.equal(done.json.task.isCompleted, 1);
  assert.ok(done.json.task.completedAt);

  const undone = await requestJson("PATCH", `/tasks/${created.json.id}/toggle`);
  assert.equal(undone.status, 200);
  assert.equal(undone.json.task.isCompleted, 0);
  assert.equal(undone.json.task.completedAt, null);

  const row = db().prepare("SELECT isCompleted, completedAt FROM tasks WHERE id = ?").get(created.json.id) as {
    isCompleted: number;
    completedAt: string | null;
  };
  assert.equal(row.isCompleted, 0);
  assert.equal(row.completedAt, null);
});

test("batch complete stamps only incomplete tasks with completedAt", async () => {
  const first = await requestJson("POST", "/tasks", { title: "Batch A" });
  const second = await requestJson("POST", "/tasks", { title: "Batch B" });
  const alreadyDone = await requestJson("POST", "/tasks", { title: "Batch C", status: "done" });

  const existingCompletedAt = alreadyDone.json.completedAt;
  assert.ok(existingCompletedAt);

  const batch = await requestJson("POST", "/tasks/batch", {
    ids: [first.json.id, second.json.id, alreadyDone.json.id],
    action: "complete",
  });

  assert.equal(batch.status, 200);
  assert.equal(batch.json.success, true);
  assert.equal(batch.json.affected, 2);

  const rows = db().prepare(
    "SELECT id, isCompleted, status, completedAt FROM tasks WHERE id IN (?, ?, ?) ORDER BY id"
  ).all(first.json.id, second.json.id, alreadyDone.json.id) as Array<{
    id: string;
    isCompleted: number;
    status: string;
    completedAt: string | null;
  }>;

  const stamped = rows.filter((row) => row.id !== alreadyDone.json.id);
  assert.equal(stamped.length, 2);
  assert.ok(stamped[0].completedAt);
  assert.ok(stamped[1].completedAt);
  assert.equal(stamped[0].completedAt, stamped[1].completedAt);

  const preserved = rows.find((row) => row.id === alreadyDone.json.id);
  assert.ok(preserved);
  assert.equal(preserved?.isCompleted, 1);
  assert.equal(preserved?.status, "done");
  assert.equal(preserved?.completedAt, existingCompletedAt);
});