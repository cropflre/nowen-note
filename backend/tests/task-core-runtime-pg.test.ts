import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createTasksRuntimeRouter } from "../src/routes/tasks-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-task-runtime-owner";
const EDITOR = "pg-task-runtime-editor";
const VIEWER = "pg-task-runtime-viewer";
const OUTSIDER = "pg-task-runtime-outsider";
const WORKSPACE = "pg-task-runtime-workspace";

function jsonHeaders(userId: string) {
  return {
    "content-type": "application/json",
    "X-User-Id": userId,
  };
}

async function jsonResponse<T = any>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, EDITOR, VIEWER, OUTSIDER]]);
  await pool.query(`SET TIME ZONE 'UTC'`);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
       ($1, 'pg_task_runtime_owner', 'hash', 0),
       ($2, 'pg_task_runtime_editor', 'hash', 0),
       ($3, 'pg_task_runtime_viewer', 'hash', 0),
       ($4, 'pg_task_runtime_outsider', 'hash', 0)`,
    [OWNER, EDITOR, VIEWER, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId", "enabledFeatures")
     VALUES ($1, 'Task Runtime', $2, '')`,
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

test("PostgreSQL task core runtime preserves CRUD, ACL and recurrence semantics", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const app = createTasksRuntimeRouter(new PostgresAdapter(pool));

    const createRecurring = await app.request("http://runtime/?workspaceId=personal", {
      method: "POST",
      headers: jsonHeaders(OWNER),
      body: JSON.stringify({
        title: "Daily recurring",
        dueDate: "2028-01-01",
        repeatRule: "daily",
        repeatInterval: 1,
        repeatEndCount: 3,
        priority: 3,
      }),
    });
    assert.equal(createRecurring.status, 201);
    const recurring = await jsonResponse<any>(createRecurring);
    assert.ok(recurring.id);
    assert.equal(recurring.repeatSequenceIndex, 1);
    assert.equal(recurring.isCompleted, false);

    await pool.query(
      `INSERT INTO task_reminders (id, "taskId", "userId", "offsetMinutes", enabled)
       VALUES ('pg-task-runtime-reminder', $1, $2, 45, true)`,
      [recurring.id, OWNER],
    );

    const list = await app.request("http://runtime/?workspaceId=personal", {
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(list.status, 200);
    assert.ok((await jsonResponse<any[]>(list)).some((task) => task.id === recurring.id));

    const stats = await app.request("http://runtime/stats/summary?workspaceId=personal", {
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(stats.status, 200);
    assert.equal((await jsonResponse<any>(stats)).total, 1);

    const [completeA, completeB] = await Promise.all([
      app.request(`http://runtime/${recurring.id}`, {
        method: "PUT",
        headers: jsonHeaders(OWNER),
        body: JSON.stringify({ status: "done" }),
      }),
      app.request(`http://runtime/${recurring.id}`, {
        method: "PUT",
        headers: jsonHeaders(OWNER),
        body: JSON.stringify({ status: "done" }),
      }),
    ]);
    assert.equal(completeA.status, 200);
    assert.equal(completeB.status, 200);

    const originalRow = await pool.query(
      `SELECT "repeatNextGeneratedId" FROM tasks WHERE id = $1`,
      [recurring.id],
    );
    const secondId = originalRow.rows[0].repeatNextGeneratedId as string;
    assert.ok(secondId);
    const repeatRowsAfterConcurrentComplete = await pool.query(
      `SELECT id, "repeatSequenceIndex", "repeatGeneratedFromId", "dueDate"
         FROM tasks
        WHERE id = $1 OR "repeatGroupId" = $1
        ORDER BY "repeatSequenceIndex" NULLS FIRST`,
      [recurring.id],
    );
    assert.equal(repeatRowsAfterConcurrentComplete.rowCount, 2, "concurrent completion must create only one next task");
    assert.equal(Number(repeatRowsAfterConcurrentComplete.rows[1].repeatSequenceIndex), 2);
    assert.equal(repeatRowsAfterConcurrentComplete.rows[1].repeatGeneratedFromId, recurring.id);
    assert.equal(repeatRowsAfterConcurrentComplete.rows[1].dueDate, "2028-01-02");

    const copiedReminder = await pool.query(
      `SELECT "offsetMinutes", enabled, "lastNotifiedAt", "snoozedUntil"
         FROM task_reminders WHERE "taskId" = $1`,
      [secondId],
    );
    assert.equal(copiedReminder.rowCount, 1);
    assert.equal(copiedReminder.rows[0].offsetMinutes, 45);
    assert.equal(copiedReminder.rows[0].enabled, true);
    assert.equal(copiedReminder.rows[0].lastNotifiedAt, null);
    assert.equal(copiedReminder.rows[0].snoozedUntil, null);

    const secondComplete = await app.request(`http://runtime/${secondId}/toggle`, {
      method: "PATCH",
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(secondComplete.status, 200);
    const secondCompleteBody = await jsonResponse<any>(secondComplete);
    assert.ok(secondCompleteBody.generatedTask?.id);
    const thirdId = secondCompleteBody.generatedTask.id as string;
    assert.equal(secondCompleteBody.generatedTask.repeatSequenceIndex, 3);
    assert.equal(String(secondCompleteBody.generatedTask.dueDate).slice(0, 10), "2028-01-03");

    const thirdComplete = await app.request(`http://runtime/${thirdId}/toggle`, {
      method: "PATCH",
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(thirdComplete.status, 200);
    assert.equal((await jsonResponse<any>(thirdComplete)).generatedTask, null);
    const finalRepeatCount = await pool.query(
      `SELECT COUNT(*)::int AS count FROM tasks WHERE id = $1 OR "repeatGroupId" = $1`,
      [recurring.id],
    );
    assert.equal(finalRepeatCount.rows[0].count, 3, "repeatEndCount must stop generation");

    const createCustom = await app.request("http://runtime/", {
      method: "POST",
      headers: jsonHeaders(OWNER),
      body: JSON.stringify({
        title: "Month end custom",
        dueDate: "2028-01-31",
        repeatRule: "custom",
        repeatEndCount: 2,
        repeatRuleJson: {
          frequency: "month",
          interval: 1,
          monthDay: 31,
        },
      }),
    });
    assert.equal(createCustom.status, 201);
    const custom = await jsonResponse<any>(createCustom);
    const customToggle = await app.request(`http://runtime/${custom.id}/toggle`, {
      method: "PATCH",
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(customToggle.status, 200);
    const customGenerated = (await jsonResponse<any>(customToggle)).generatedTask;
    assert.equal(String(customGenerated.dueDate).slice(0, 10), "2028-02-29", "custom monthly recurrence must clamp leap-year month end");

    const createWorkspace = await app.request(`http://runtime/?workspaceId=${WORKSPACE}`, {
      method: "POST",
      headers: jsonHeaders(EDITOR),
      body: JSON.stringify({ title: "Workspace task" }),
    });
    assert.equal(createWorkspace.status, 201);
    const workspaceTask = await jsonResponse<any>(createWorkspace);
    assert.equal(workspaceTask.workspaceId, WORKSPACE);
    assert.equal(workspaceTask.userId, EDITOR);

    const viewerRead = await app.request(`http://runtime/${workspaceTask.id}`, {
      headers: { "X-User-Id": VIEWER },
    });
    assert.equal(viewerRead.status, 200, "workspace member may read shared task");

    const outsiderRead = await app.request(`http://runtime/${workspaceTask.id}`, {
      headers: { "X-User-Id": OUTSIDER },
    });
    assert.equal(outsiderRead.status, 404, "outsider must not learn workspace task existence");

    const viewerUpdate = await app.request(`http://runtime/${workspaceTask.id}`, {
      method: "PUT",
      headers: jsonHeaders(VIEWER),
      body: JSON.stringify({ title: "Viewer edit" }),
    });
    assert.equal(viewerUpdate.status, 403, "non-creator viewer cannot edit task");

    const ownerUpdate = await app.request(`http://runtime/${workspaceTask.id}`, {
      method: "PUT",
      headers: jsonHeaders(OWNER),
      body: JSON.stringify({ title: "Owner managed" }),
    });
    assert.equal(ownerUpdate.status, 200, "workspace owner can manage member task");
    assert.equal((await jsonResponse<any>(ownerUpdate)).task.title, "Owner managed");

    await pool.query(
      `UPDATE workspaces SET "enabledFeatures" = '{"tasks":false}' WHERE id = $1`,
      [WORKSPACE],
    );
    const featureDisabled = await app.request(`http://runtime/?workspaceId=${WORKSPACE}`, {
      headers: { "X-User-Id": EDITOR },
    });
    assert.equal(featureDisabled.status, 403);
    assert.equal((await jsonResponse<any>(featureDisabled)).code, "FEATURE_DISABLED");
    await pool.query(`UPDATE workspaces SET "enabledFeatures" = '' WHERE id = $1`, [WORKSPACE]);

    const personalParentResponse = await app.request("http://runtime/", {
      method: "POST",
      headers: jsonHeaders(OWNER),
      body: JSON.stringify({ title: "Personal parent" }),
    });
    const personalParent = await jsonResponse<any>(personalParentResponse);
    const scopeMismatch = await app.request(`http://runtime/?workspaceId=${WORKSPACE}`, {
      method: "POST",
      headers: jsonHeaders(OWNER),
      body: JSON.stringify({ title: "Wrong child", parentId: personalParent.id }),
    });
    assert.equal(scopeMismatch.status, 400);
    assert.equal((await jsonResponse<any>(scopeMismatch)).code, "SCOPE_MISMATCH");

    const childAResponse = await app.request("http://runtime/", {
      method: "POST",
      headers: jsonHeaders(OWNER),
      body: JSON.stringify({ title: "Child A", parentId: personalParent.id, sortOrder: 20 }),
    });
    const childA = await jsonResponse<any>(childAResponse);
    const childBResponse = await app.request("http://runtime/", {
      method: "POST",
      headers: jsonHeaders(OWNER),
      body: JSON.stringify({ title: "Child B", parentId: personalParent.id, sortOrder: 10 }),
    });
    const childB = await jsonResponse<any>(childBResponse);

    const reorder = await app.request("http://runtime/reorder/batch", {
      method: "PUT",
      headers: jsonHeaders(OWNER),
      body: JSON.stringify({
        items: [
          { id: childA.id, sortOrder: 0 },
          { id: childB.id, sortOrder: 1 },
        ],
      }),
    });
    assert.equal(reorder.status, 200);
    const parentDetail = await app.request(`http://runtime/${personalParent.id}`, {
      headers: { "X-User-Id": OWNER },
    });
    assert.deepEqual(
      (await jsonResponse<any>(parentDetail)).children.map((task: any) => task.id),
      [childA.id, childB.id],
    );

    await pool.query(
      `INSERT INTO task_dependencies (
         id, "userId", "predecessorTaskId", "successorTaskId", type
       ) VALUES ('pg-task-runtime-dependency', $1, $2, $3, 'finish_to_start')`,
      [OWNER, childA.id, childB.id],
    );
    const deleteParent = await app.request(`http://runtime/${personalParent.id}`, {
      method: "DELETE",
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(deleteParent.status, 200);
    const deletedChildren = await pool.query(
      `SELECT COUNT(*)::int AS count FROM tasks WHERE id = ANY($1::text[])`,
      [[personalParent.id, childA.id, childB.id]],
    );
    assert.equal(deletedChildren.rows[0].count, 0);
    const deletedDependency = await pool.query(
      `SELECT COUNT(*)::int AS count FROM task_dependencies WHERE id = 'pg-task-runtime-dependency'`,
    );
    assert.equal(deletedDependency.rows[0].count, 0, "recursive delete must clean dangling dependencies");
  } finally {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, EDITOR, VIEWER, OUTSIDER]]).catch(() => {});
    await closePgPool(pool);
  }
});
