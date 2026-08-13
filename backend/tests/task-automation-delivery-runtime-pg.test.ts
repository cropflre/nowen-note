import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createTaskReminderDeliveryRuntimeRouter } from "../src/routes/task-reminder-delivery-runtime";
import { createTaskAutomationDeliveryRuntime } from "../src/services/task-automation-delivery-runtime";
import { createTaskReminderDeliveryRuntime } from "../src/services/task-reminder-delivery-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-task-automation-user";
const OTHER_USER = "pg-task-automation-other";
const PREDECESSOR_A = "pg-task-automation-pred-a";
const PREDECESSOR_B = "pg-task-automation-pred-b";
const SUCCESSOR = "pg-task-automation-successor";
const OVERDUE = "pg-task-automation-overdue";

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[USER, OTHER_USER]]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
      ($1, 'pg_task_automation_user', 'hash', 0),
      ($2, 'pg_task_automation_other', 'hash', 0)`,
    [USER, OTHER_USER],
  );
  await pool.query(
    `INSERT INTO tasks (
       id, "userId", title, "isCompleted", "completedAt", "dueAt", "dueDate", "workspaceId", status
     ) VALUES
       ($1, $4, 'Pred A', true, '2026-08-13T08:10:00.000Z', NULL, NULL, NULL, 'done'),
       ($2, $4, 'Pred B', true, '2026-08-13T08:20:00.000Z', NULL, NULL, NULL, 'done'),
       ($3, $4, 'Ready successor', false, NULL, NULL, NULL, NULL, 'todo'),
       ($5, $4, 'Overdue task', false, NULL, '2026-08-13T08:00:00.000Z', NULL, NULL, 'todo')`,
    [PREDECESSOR_A, PREDECESSOR_B, SUCCESSOR, USER, OVERDUE],
  );
  await pool.query(
    `INSERT INTO task_dependencies (
       id, "userId", "workspaceId", "predecessorTaskId", "successorTaskId", type
     ) VALUES
       ('pg-task-auto-dep-a', $1, NULL, $2, $4, 'finish_to_start'),
       ('pg-task-auto-dep-b', $1, NULL, $3, $4, 'finish_to_start')`,
    [USER, PREDECESSOR_A, PREDECESSOR_B, SUCCESSOR],
  );
}

test("PostgreSQL task automation notifications are durable, multi-instance safe and share recent/ACK", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const adapter = new PostgresAdapter(pool);

    const runtimeA = createTaskAutomationDeliveryRuntime(adapter, {
      instanceId: "task-automation-a",
      scanIntervalMs: 30_000,
      leaseMs: 45_000,
    });
    const runtimeB = createTaskAutomationDeliveryRuntime(adapter, {
      instanceId: "task-automation-b",
      scanIntervalMs: 30_000,
      leaseMs: 45_000,
    });
    const reminderRuntime = createTaskReminderDeliveryRuntime(adapter, {
      instanceId: "task-reminder-api-test",
      scanIntervalMs: 30_000,
      leaseMs: 45_000,
    });

    const firstNow = new Date("2026-08-13T09:00:00.000Z");
    const [scanA, scanB] = await Promise.all([
      runtimeA.scanOnce(firstNow),
      runtimeB.scanOnce(firstNow),
    ]);
    assert.equal(Number(scanA.acquired) + Number(scanB.acquired), 1, "only one automation scanner may own the lease");

    const durableRows = await pool.query<{ type: string; count: string }>(
      `SELECT type, COUNT(*)::text AS count
         FROM task_automation_delivery_state
        GROUP BY type
        ORDER BY type`,
    );
    assert.deepEqual(durableRows.rows, [
      { type: "dependency_ready", count: "1" },
      { type: "overdue_daily", count: "1" },
    ]);

    const restarted = createTaskAutomationDeliveryRuntime(adapter, { instanceId: "task-automation-restarted" });
    const persisted = await restarted.listRecent(USER, firstNow.getTime() + 86_400_000);
    assert.equal(persisted.length, 2, "pending automation delivery must survive restart and ignore a newer since cursor");
    assert.deepEqual(new Set(persisted.map((item) => item.type)), new Set(["dependency_ready", "overdue_daily"]));

    const app = new Hono();
    app.route("/task-reminders", createTaskReminderDeliveryRuntimeRouter(reminderRuntime, runtimeA));
    const recentResponse = await app.request("http://runtime/task-reminders/recent?since=9999999999999", {
      headers: { "X-User-Id": USER },
    });
    assert.equal(recentResponse.status, 200);
    const recentBody = await recentResponse.json() as { reminders: Array<{ reminderId: string; type: string }> };
    assert.equal(recentBody.reminders.length, 2);

    const dependencyReminder = recentBody.reminders.find((item) => item.type === "dependency_ready");
    assert.ok(dependencyReminder);
    const crossUserAck = await runtimeA.acknowledge(OTHER_USER, [dependencyReminder.reminderId]);
    assert.equal(crossUserAck, 0, "a different user must not ACK another user's automation delivery");

    const ackResponse = await app.request("http://runtime/task-reminders/recent/ack", {
      method: "POST",
      headers: { "X-User-Id": USER, "content-type": "application/json" },
      body: JSON.stringify({ reminderIds: [dependencyReminder.reminderId] }),
    });
    assert.equal(ackResponse.status, 200);
    assert.deepEqual(await ackResponse.json(), { success: true, acked: 1 });

    const ackAgain = await app.request("http://runtime/task-reminders/recent/ack", {
      method: "POST",
      headers: { "X-User-Id": USER, "content-type": "application/json" },
      body: JSON.stringify({ reminderIds: [dependencyReminder.reminderId] }),
    });
    assert.deepEqual(await ackAgain.json(), { success: true, acked: 0 }, "automation ACK must be idempotent");

    await pool.query(
      `UPDATE tasks SET "isCompleted" = false, "completedAt" = NULL, status = 'todo' WHERE id = $1`,
      [PREDECESSOR_B],
    );
    const unreadyScan = await runtimeB.scanOnce(new Date("2026-08-13T09:01:00.000Z"));
    assert.equal(unreadyScan.acquired, true);
    assert.equal((await runtimeB.listRecent(USER)).some((item) => item.type === "dependency_ready"), false);

    await pool.query(
      `UPDATE tasks SET "isCompleted" = true, "completedAt" = '2026-08-13T09:01:30.000Z', status = 'done' WHERE id = $1`,
      [PREDECESSOR_B],
    );
    await runtimeA.scanOnce(new Date("2026-08-13T09:02:00.000Z"));
    const readyAgain = (await runtimeA.listRecent(USER)).filter((item) => item.type === "dependency_ready");
    assert.equal(readyAgain.length, 1, "a new predecessor completion cycle must create a fresh dependency-ready event");
    assert.notEqual(readyAgain[0]?.reminderId, dependencyReminder.reminderId);

    const overdueBeforeEdit = (await runtimeA.listRecent(USER)).find((item) => item.type === "overdue_daily");
    assert.ok(overdueBeforeEdit);
    await pool.query(`UPDATE tasks SET "dueAt" = '2026-08-14T12:00:00.000Z' WHERE id = $1`, [OVERDUE]);
    await runtimeB.scanOnce(new Date("2026-08-13T09:03:00.000Z"));
    assert.equal((await runtimeB.listRecent(USER)).some((item) => item.type === "overdue_daily"), false, "moving dueAt into the future must retire stale overdue delivery");

    await pool.query(`UPDATE tasks SET "dueAt" = '2026-08-13T08:00:00.000Z' WHERE id = $1`, [OVERDUE]);
    await runtimeA.scanOnce(new Date("2026-08-13T09:04:00.000Z"));
    assert.equal((await runtimeA.listRecent(USER)).some((item) => item.type === "overdue_daily"), false, "same UTC day must not re-notify an already retired overdue event");

    await runtimeB.scanOnce(new Date("2026-08-14T09:00:00.000Z"));
    const nextDayOverdue = (await runtimeB.listRecent(USER)).filter((item) => item.type === "overdue_daily");
    assert.equal(nextDayOverdue.length, 1, "an overdue task may notify again on the next UTC day");
    assert.notEqual(nextDayOverdue[0]?.reminderId, overdueBeforeEdit.reminderId);

    await runtimeA.shutdown();
    await runtimeB.shutdown();
    await restarted.shutdown();
    await reminderRuntime.shutdown();
  } finally {
    await closePgPool(pool);
  }
});
