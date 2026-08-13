import "./task-ai-breakdown-runtime-pg.test";
import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createTaskCoreRepository } from "../src/repositories/taskCoreRepository";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-task-owner";
const EDITOR = "pg-task-editor";
const OTHER = "pg-task-other";
const WORKSPACE = "pg-task-workspace";
const OTHER_WORKSPACE = "pg-task-other-workspace";
const PERSONAL_TODAY = "pg-task-personal-today";
const PERSONAL_COMPLETED = "pg-task-personal-completed";
const PERSONAL_OVERDUE = "pg-task-personal-overdue";
const WORKSPACE_TASK = "pg-task-workspace-task";
const OTHER_WORKSPACE_TASK = "pg-task-other-workspace-task";

function dateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, EDITOR, OTHER]]);
  await pool.query(`SET TIME ZONE 'UTC'`);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
       ($1, 'pg_task_owner', 'hash', 0),
       ($2, 'pg_task_editor', 'hash', 0),
       ($3, 'pg_task_other', 'hash', 0)`,
    [OWNER, EDITOR, OTHER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES
       ($1, 'Tasks', $2),
       ($3, 'Other Tasks', $4)`,
    [WORKSPACE, OWNER, OTHER_WORKSPACE, OTHER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES
       ($1, $2, 'owner'),
       ($1, $3, 'editor'),
       ($4, $5, 'owner')`,
    [WORKSPACE, OWNER, EDITOR, OTHER_WORKSPACE, OTHER],
  );

  await pool.query(
    `INSERT INTO tasks (
       id, "userId", title, "isCompleted", "completedAt", priority,
       "dueDate", "workspaceId", "sortOrder", description
     ) VALUES
       ($1, $2, 'Today personal', false, NULL, 3, $3, NULL, 10, 'today'),
       ($4, $2, 'Completed personal', true, CURRENT_TIMESTAMP, 2, $5, NULL, 20, 'done'),
       ($6, $2, 'Overdue personal', false, NULL, 1, $5, NULL, 30, 'late'),
       ($7, $8, 'Workspace task', false, NULL, 3, $9, $10, 5, 'workspace'),
       ($11, $12, 'Other workspace task', false, NULL, 2, $9, $13, 5, 'other')`,
    [
      PERSONAL_TODAY,
      OWNER,
      dateOffset(0),
      PERSONAL_COMPLETED,
      dateOffset(-1),
      PERSONAL_OVERDUE,
      WORKSPACE_TASK,
      EDITOR,
      dateOffset(1),
      WORKSPACE,
      OTHER_WORKSPACE_TASK,
      OTHER,
      OTHER_WORKSPACE,
    ],
  );
  await pool.query(
    `INSERT INTO task_reminders (id, "taskId", "userId", "offsetMinutes", enabled)
     VALUES ('pg-task-reminder', $1, $2, 30, true)`,
    [WORKSPACE_TASK, OWNER],
  );
}

test("PostgreSQL task core repository preserves scope, stats and mutation primitives", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const repo = createTaskCoreRepository(new PostgresAdapter(pool), "postgres");

    assert.equal(await repo.getWorkspaceRole(WORKSPACE, OWNER), "owner");
    assert.equal(await repo.getWorkspaceRole(WORKSPACE, EDITOR), "editor");
    assert.equal(await repo.getWorkspaceRole(WORKSPACE, OTHER), null);

    const personalScope = { kind: "personal" as const, userId: OWNER, workspaceId: null };
    const personal = await repo.list({ scope: personalScope, filter: "all" });
    assert.deepEqual(
      new Set(personal.map((task) => task.id)),
      new Set([PERSONAL_TODAY, PERSONAL_COMPLETED, PERSONAL_OVERDUE]),
    );
    assert.ok(personal.every((task) => task.workspaceId === null));
    assert.ok(personal.every((task) => task.creatorName === "pg_task_owner"));

    const today = await repo.list({ scope: personalScope, filter: "today" });
    assert.deepEqual(today.map((task) => task.id), [PERSONAL_TODAY]);
    const overdue = await repo.list({ scope: personalScope, filter: "overdue" });
    assert.deepEqual(overdue.map((task) => task.id), [PERSONAL_OVERDUE]);
    const completed = await repo.list({ scope: personalScope, filter: "completed" });
    assert.deepEqual(completed.map((task) => task.id), [PERSONAL_COMPLETED]);

    const stats = await repo.stats(personalScope);
    assert.deepEqual(stats, {
      total: 3,
      completed: 1,
      pending: 2,
      today: 1,
      overdue: 1,
      week: 1,
    });

    const workspaceScope = { kind: "workspace" as const, userId: OWNER, workspaceId: WORKSPACE };
    const workspaceTasks = await repo.list({ scope: workspaceScope });
    assert.deepEqual(workspaceTasks.map((task) => task.id), [WORKSPACE_TASK]);
    assert.equal(workspaceTasks[0].creatorName, "pg_task_editor");
    assert.equal(workspaceTasks[0].activeReminderCount, 1);

    const workspaceStats = await repo.stats(workspaceScope);
    assert.equal(workspaceStats.total, 1);
    assert.equal(workspaceStats.pending, 1);
    assert.equal(workspaceStats.week, 1);

    const rootId = "pg-task-created-root";
    const childA = "pg-task-created-child-a";
    const childB = "pg-task-created-child-b";
    const root = await repo.create({
      id: rootId,
      userId: OWNER,
      title: "Created root",
      workspaceId: null,
      priority: 2,
      description: "created through repository",
      dueDate: dateOffset(2),
    });
    assert.equal(root.id, rootId);
    assert.equal(root.title, "Created root");
    assert.equal(root.isCompleted, false);

    await repo.create({
      id: childA,
      userId: OWNER,
      title: "Child A",
      workspaceId: null,
      parentId: rootId,
      sortOrder: 20,
    });
    await repo.create({
      id: childB,
      userId: OWNER,
      title: "Child B",
      workspaceId: null,
      parentId: rootId,
      sortOrder: 10,
    });

    const children = await repo.listChildren(rootId);
    assert.deepEqual(children.map((task) => task.id), [childB, childA]);

    const updated = await repo.update(rootId, {
      title: "Updated root",
      priority: 4,
      description: "updated",
      dueDate: dateOffset(3),
      startDate: dateOffset(1),
    });
    assert.equal(updated?.title, "Updated root");
    assert.equal(updated?.priority, 4);
    assert.equal(updated?.description, "updated");

    const completedRoot = await repo.setCompletion(rootId, true);
    assert.equal(completedRoot?.isCompleted, true);
    assert.equal(completedRoot?.status, "done");
    assert.ok(completedRoot?.completedAt);
    const reopenedRoot = await repo.setCompletion(rootId, false);
    assert.equal(reopenedRoot?.isCompleted, false);
    assert.equal(reopenedRoot?.status, "todo");
    assert.equal(reopenedRoot?.completedAt, null);

    const reorderRows = await repo.getRowsForReorder([childA, childB]);
    assert.equal(reorderRows.length, 2);
    assert.ok(reorderRows.every((row) => row.parentId === rootId));
    await repo.reorder([
      { id: childA, sortOrder: 0 },
      { id: childB, sortOrder: 1 },
    ]);
    const reordered = await repo.listChildren(rootId);
    assert.deepEqual(reordered.map((task) => task.id), [childA, childB]);

    const descendants = await repo.collectDescendantIds(rootId);
    assert.deepEqual(new Set(descendants), new Set([rootId, childA, childB]));
    assert.equal(await repo.deleteIds(descendants), 3);
    assert.equal(await repo.getById(rootId), undefined);
    assert.equal((await repo.listChildren(rootId)).length, 0);
  } finally {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, EDITOR, OTHER]]).catch(() => {});
    await closePgPool(pool);
  }
});
