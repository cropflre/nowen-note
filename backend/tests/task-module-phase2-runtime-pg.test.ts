import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createTaskDependenciesRuntimeRouter } from "../src/routes/task-dependencies-runtime";
import { createTaskProjectsRuntimeRouter } from "../src/routes/task-projects-runtime";
import { createTaskRemindersRuntimeRouter } from "../src/routes/task-reminders-runtime";
import { createTasksRuntimeRouter } from "../src/routes/tasks-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-task-phase2-owner";
const EDITOR = "pg-task-phase2-editor";
const VIEWER = "pg-task-phase2-viewer";
const OUTSIDER = "pg-task-phase2-outsider";
const WORKSPACE = "pg-task-phase2-workspace";

function headers(userId: string, json = false) {
  return {
    "X-User-Id": userId,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function body<T = any>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, EDITOR, VIEWER, OUTSIDER]]);
  await pool.query(`SET TIME ZONE 'UTC'`);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
       ($1, 'pg_task_phase2_owner', 'hash', 0),
       ($2, 'pg_task_phase2_editor', 'hash', 0),
       ($3, 'pg_task_phase2_viewer', 'hash', 0),
       ($4, 'pg_task_phase2_outsider', 'hash', 0)`,
    [OWNER, EDITOR, VIEWER, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId", "enabledFeatures")
     VALUES ($1, 'Task Phase 2', $2, '')`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES
       ($1, $2, 'owner'),
       ($1, $3, 'editor'),
       ($1, $4, 'viewer')`,
    [WORKSPACE, OWNER, EDITOR, VIEWER],
  );
}

test("PostgreSQL task module phase 2 preserves projects, dependencies and reminder user runtime", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const adapter = new PostgresAdapter(pool);

    const app = new Hono();
    app.route("/tasks", createTasksRuntimeRouter(adapter));
    app.route("/task-projects", createTaskProjectsRuntimeRouter(adapter));
    app.route("/task-dependencies", createTaskDependenciesRuntimeRouter(adapter));
    app.route("/task-reminders", createTaskRemindersRuntimeRouter(adapter));

    const updatedAtColumn = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'task_reminders' AND column_name = 'updatedAt'`,
    );
    assert.equal(updatedAtColumn.rowCount, 1, "0057 must add task_reminders.updatedAt parity");

    const viewerProjectCreate = await app.request(`http://runtime/task-projects?workspaceId=${WORKSPACE}`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ name: "Viewer forbidden" }),
    });
    assert.equal(viewerProjectCreate.status, 403);

    const projectCreate = await app.request(`http://runtime/task-projects?workspaceId=${WORKSPACE}`, {
      method: "POST",
      headers: headers(EDITOR, true),
      body: JSON.stringify({ name: "Release project", icon: "rocket", color: "#123456" }),
    });
    assert.equal(projectCreate.status, 201);
    const project = await body<any>(projectCreate);
    assert.ok(project.id);
    assert.equal(project.taskCount, 0);
    assert.equal(project.completedCount, 0);

    const dueAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const firstTaskResponse = await app.request(`http://runtime/tasks?workspaceId=${WORKSPACE}`, {
      method: "POST",
      headers: headers(EDITOR, true),
      body: JSON.stringify({ title: "Build", projectId: project.id, dueAt }),
    });
    assert.equal(firstTaskResponse.status, 201);
    const firstTask = await body<any>(firstTaskResponse);

    const secondTaskResponse = await app.request(`http://runtime/tasks?workspaceId=${WORKSPACE}`, {
      method: "POST",
      headers: headers(EDITOR, true),
      body: JSON.stringify({ title: "Ship", projectId: project.id, dueAt }),
    });
    assert.equal(secondTaskResponse.status, 201);
    const secondTask = await body<any>(secondTaskResponse);

    const projectListBefore = await app.request(`http://runtime/task-projects?workspaceId=${WORKSPACE}`, {
      headers: headers(VIEWER),
    });
    assert.equal(projectListBefore.status, 200);
    const listedBefore = (await body<any[]>(projectListBefore)).find((item) => item.id === project.id);
    assert.equal(listedBefore.taskCount, 2);
    assert.equal(listedBefore.completedCount, 0);
    assert.equal(listedBefore.progress, 0);

    const completeFirst = await app.request(`http://runtime/tasks/${firstTask.id}/toggle`, {
      method: "PATCH",
      headers: headers(EDITOR),
    });
    assert.equal(completeFirst.status, 200);
    const projectListAfter = await app.request(`http://runtime/task-projects?workspaceId=${WORKSPACE}`, {
      headers: headers(VIEWER),
    });
    const listedAfter = (await body<any[]>(projectListAfter)).find((item) => item.id === project.id);
    assert.equal(listedAfter.taskCount, 2);
    assert.equal(listedAfter.completedCount, 1);
    assert.equal(listedAfter.progress, 50, "PostgreSQL boolean stats must calculate correctly");

    const ownerProjectUpdate = await app.request(`http://runtime/task-projects/${project.id}`, {
      method: "PUT",
      headers: headers(OWNER, true),
      body: JSON.stringify({ name: "Owner managed project" }),
    });
    assert.equal(ownerProjectUpdate.status, 200);
    assert.equal((await body<any>(ownerProjectUpdate)).name, "Owner managed project");

    const viewerDependencyCreate = await app.request("http://runtime/task-dependencies", {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ predecessorTaskId: firstTask.id, successorTaskId: secondTask.id }),
    });
    assert.equal(viewerDependencyCreate.status, 403);

    const dependencyCreate = await app.request("http://runtime/task-dependencies", {
      method: "POST",
      headers: headers(EDITOR, true),
      body: JSON.stringify({ predecessorTaskId: firstTask.id, successorTaskId: secondTask.id }),
    });
    assert.equal(dependencyCreate.status, 201);
    const dependency = await body<any>(dependencyCreate);
    assert.ok(dependency.id);
    assert.equal(dependency.predecessorTaskId, firstTask.id);

    const duplicateDependency = await app.request("http://runtime/task-dependencies", {
      method: "POST",
      headers: headers(EDITOR, true),
      body: JSON.stringify({ predecessorTaskId: firstTask.id, successorTaskId: secondTask.id }),
    });
    assert.equal(duplicateDependency.status, 409);

    const cycleDependency = await app.request("http://runtime/task-dependencies", {
      method: "POST",
      headers: headers(EDITOR, true),
      body: JSON.stringify({ predecessorTaskId: secondTask.id, successorTaskId: firstTask.id }),
    });
    assert.equal(cycleDependency.status, 400);
    assert.equal((await body<any>(cycleDependency)).code, "DEPENDENCY_CYCLE");

    const dependencyList = await app.request(
      `http://runtime/task-dependencies?workspaceId=${WORKSPACE}&taskId=${encodeURIComponent(firstTask.id)}`,
      { headers: headers(VIEWER) },
    );
    assert.equal(dependencyList.status, 200);
    assert.equal((await body<any[]>(dependencyList)).length, 1);

    const outsiderReminderCreate = await app.request(`http://runtime/task-reminders/${secondTask.id}`, {
      method: "POST",
      headers: headers(OUTSIDER, true),
      body: JSON.stringify({ offsetMinutes: 30 }),
    });
    assert.equal(outsiderReminderCreate.status, 404, "outsider must not create reminder on hidden workspace task");

    const reminderCreate = await app.request(`http://runtime/task-reminders/${secondTask.id}`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ offsetMinutes: 30, timezoneOffsetMinutes: -480 }),
    });
    assert.equal(reminderCreate.status, 201, "workspace reader may create their own reminder");
    const reminder = await body<any>(reminderCreate);
    assert.equal(reminder.userId, VIEWER);
    assert.equal(reminder.timezoneOffsetMinutes, -480);
    assert.ok(reminder.updatedAt);

    const reminderList = await app.request(`http://runtime/task-reminders/${secondTask.id}`, {
      headers: headers(VIEWER),
    });
    assert.equal(reminderList.status, 200);
    assert.equal((await body<any[]>(reminderList)).length, 1);

    const schedule = await app.request("http://runtime/task-reminders/schedule", {
      headers: headers(VIEWER),
    });
    assert.equal(schedule.status, 200);
    const scheduled = (await body<any>(schedule)).reminders.find((item: any) => item.reminderId === reminder.id);
    assert.ok(scheduled, "future workspace reminder must appear in native schedule");
    assert.equal(scheduled.offsetMinutes, 30);

    const reminderUpdate = await app.request(`http://runtime/task-reminders/${reminder.id}`, {
      method: "PUT",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ offsetMinutes: 45, snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    });
    assert.equal(reminderUpdate.status, 200);
    assert.equal((await body<any>(reminderUpdate)).offsetMinutes, 45);

    const ownerCannotEditOthersReminder = await app.request(`http://runtime/task-reminders/${reminder.id}`, {
      method: "PUT",
      headers: headers(OWNER, true),
      body: JSON.stringify({ offsetMinutes: 5 }),
    });
    assert.equal(ownerCannotEditOthersReminder.status, 403, "reminders are per-user even for workspace owners");

    await pool.query(
      `UPDATE workspaces SET "enabledFeatures" = '{"tasks":false}' WHERE id = $1`,
      [WORKSPACE],
    );
    const projectFeatureDisabled = await app.request(`http://runtime/task-projects?workspaceId=${WORKSPACE}`, {
      headers: headers(EDITOR),
    });
    assert.equal(projectFeatureDisabled.status, 403);
    assert.equal((await body<any>(projectFeatureDisabled)).code, "FEATURE_DISABLED");

    const disabledSchedule = await app.request("http://runtime/task-reminders/schedule", {
      headers: headers(VIEWER),
    });
    assert.equal(disabledSchedule.status, 200);
    assert.equal(
      (await body<any>(disabledSchedule)).reminders.some((item: any) => item.reminderId === reminder.id),
      false,
      "disabled task feature must hide workspace reminders from schedule",
    );
    await pool.query(`UPDATE workspaces SET "enabledFeatures" = '' WHERE id = $1`, [WORKSPACE]);

    const dependencyDelete = await app.request(`http://runtime/task-dependencies/${dependency.id}`, {
      method: "DELETE",
      headers: headers(EDITOR),
    });
    assert.equal(dependencyDelete.status, 200);

    const projectDelete = await app.request(`http://runtime/task-projects/${project.id}`, {
      method: "DELETE",
      headers: headers(OWNER),
    });
    assert.equal(projectDelete.status, 200);
    const unlinked = await pool.query(
      `SELECT "projectId" FROM tasks WHERE id = ANY($1::text[]) ORDER BY id`,
      [[firstTask.id, secondTask.id]],
    );
    assert.equal(unlinked.rows.every((row) => row.projectId === null), true, "deleting project must unlink tasks without deleting them");

    const reminderDelete = await app.request(`http://runtime/task-reminders/${reminder.id}`, {
      method: "DELETE",
      headers: headers(VIEWER),
    });
    assert.equal(reminderDelete.status, 200);
  } finally {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, EDITOR, VIEWER, OUTSIDER]]).catch(() => {});
    await closePgPool(pool);
  }
});
