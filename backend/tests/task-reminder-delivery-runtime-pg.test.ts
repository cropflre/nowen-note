import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createTaskReminderDeliveryRuntimeRouter } from "../src/routes/task-reminder-delivery-runtime";
import { createTaskReminderDeliveryRuntime } from "../src/services/task-reminder-delivery-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-reminder-delivery-user";
const TASK = "pg-reminder-delivery-task";
const REMINDER = "pg-reminder-delivery-reminder";

function headers(json = false) {
  return {
    "X-User-Id": USER,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, 'pg_reminder_delivery_user', 'hash', 0)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO tasks (
       id, "userId", title, "isCompleted", "dueAt", "dueDate", "workspaceId", status
     ) VALUES ($1, $2, 'Durable reminder', false, $3, NULL, NULL, 'todo')`,
    [TASK, USER, "2030-08-13T08:00:00.000Z"],
  );
  await pool.query(
    `INSERT INTO task_reminders (
       id, "taskId", "userId", "offsetMinutes", "timezoneOffsetMinutes", enabled, "updatedAt"
     ) VALUES ($1, $2, $3, 30, 0, true, CURRENT_TIMESTAMP)`,
    [REMINDER, TASK, USER],
  );
}

test("PostgreSQL reminder delivery survives restarts and is multi-instance/ACK safe", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const adapter = new PostgresAdapter(pool);

    const tableCheck = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])
        ORDER BY tablename`,
      [["task_reminder_delivery_state", "task_reminder_scanner_leases"]],
    );
    assert.deepEqual(
      tableCheck.rows.map((row) => row.tablename),
      ["task_reminder_delivery_state", "task_reminder_scanner_leases"],
    );

    const runtimeA = createTaskReminderDeliveryRuntime(adapter, {
      instanceId: "scanner-a",
      scanIntervalMs: 30_000,
      leaseMs: 45_000,
    });
    const runtimeB = createTaskReminderDeliveryRuntime(adapter, {
      instanceId: "scanner-b",
      scanIntervalMs: 30_000,
      leaseMs: 45_000,
    });

    const firstNow = new Date("2030-08-13T09:00:00.000Z");
    const [scanA, scanB] = await Promise.all([
      runtimeA.scanOnce(firstNow),
      runtimeB.scanOnce(firstNow),
    ]);
    assert.equal(Number(scanA.acquired) + Number(scanB.acquired), 1, "only one scanner instance may own the lease");

    const stateCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM task_reminder_delivery_state WHERE "reminderId" = $1`,
      [REMINDER],
    );
    assert.equal(stateCount.rows[0]?.count, "1", "multi-instance scan must materialize exactly one durable state row");

    const pendingAfterRestart = await createTaskReminderDeliveryRuntime(adapter, {
      instanceId: "scanner-restarted",
    }).listRecent(USER, firstNow.getTime() + 60_000);
    assert.equal(pendingAfterRestart.length, 1, "unacked durable delivery must survive a runtime restart and ignore a newer since cursor");
    assert.equal(pendingAfterRestart[0]?.reminderId, REMINDER);
    assert.equal(pendingAfterRestart[0]?.type, "task_reminder");

    const api = new Hono();
    api.route("/task-reminders", createTaskReminderDeliveryRuntimeRouter(runtimeA));
    const recentResponse = await api.request("http://runtime/task-reminders/recent?since=9999999999999", {
      headers: headers(),
    });
    assert.equal(recentResponse.status, 200);
    assert.equal((await recentResponse.json() as any).reminders.length, 1);

    const ackResponse = await api.request("http://runtime/task-reminders/recent/ack", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ reminderIds: [REMINDER] }),
    });
    assert.equal(ackResponse.status, 200);
    assert.deepEqual(await ackResponse.json(), { success: true, acked: 1 });

    const ackAgain = await api.request("http://runtime/task-reminders/recent/ack", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ reminderIds: [REMINDER] }),
    });
    assert.deepEqual(await ackAgain.json(), { success: true, acked: 0 }, "ACK must be idempotent");

    const reminderAfterAck = await pool.query<{ lastNotifiedAt: Date | null; snoozedUntil: Date | null }>(
      `SELECT "lastNotifiedAt", "snoozedUntil" FROM task_reminders WHERE id = $1`,
      [REMINDER],
    );
    assert.ok(reminderAfterAck.rows[0]?.lastNotifiedAt, "ACK must update the compatibility lastNotifiedAt marker");
    assert.equal((await runtimeA.listRecent(USER)).length, 0);

    const snoozeAt = "2030-08-13T09:30:00.000Z";
    await pool.query(
      `UPDATE task_reminders SET "snoozedUntil" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $2`,
      [snoozeAt, REMINDER],
    );
    const beforeSnoozeDue = await runtimeB.scanOnce(new Date("2030-08-13T09:10:00.000Z"));
    assert.equal(beforeSnoozeDue.acquired, true);
    assert.equal((await runtimeB.listRecent(USER)).length, 0, "future snooze must reset delivery but not trigger early");

    const afterSnoozeDue = await runtimeA.scanOnce(new Date("2030-08-13T09:31:00.000Z"));
    assert.equal(afterSnoozeDue.acquired, true);
    assert.equal((await runtimeA.listRecent(USER)).length, 1, "changed snooze schedule must create a fresh pending delivery");

    const laterSnooze = "2030-08-13T10:00:00.000Z";
    await pool.query(`UPDATE task_reminders SET "snoozedUntil" = $1 WHERE id = $2`, [laterSnooze, REMINDER]);
    assert.equal(await runtimeA.acknowledge(USER, [REMINDER]), 1);
    const preservedSnooze = await pool.query<{ snoozedUntil: Date | null }>(
      `SELECT "snoozedUntil" FROM task_reminders WHERE id = $1`,
      [REMINDER],
    );
    assert.equal(
      preservedSnooze.rows[0]?.snoozedUntil?.toISOString(),
      laterSnooze,
      "ACK for an older delivery must not clear a newer snooze chosen by the user",
    );

    await runtimeB.scanOnce(new Date("2030-08-13T09:32:00.000Z"));
    assert.equal((await runtimeB.listRecent(USER)).length, 0);
    await runtimeA.scanOnce(new Date("2030-08-13T10:01:00.000Z"));
    assert.equal((await runtimeA.listRecent(USER)).length, 1);
    assert.equal(await runtimeA.acknowledge(USER, [REMINDER]), 1);
    const consumedSnooze = await pool.query<{ snoozedUntil: Date | null }>(
      `SELECT "snoozedUntil" FROM task_reminders WHERE id = $1`,
      [REMINDER],
    );
    assert.equal(consumedSnooze.rows[0]?.snoozedUntil, null, "ACK must clear the snooze that produced the delivered event");

    await pool.query(`UPDATE tasks SET "isCompleted" = true, status = 'done' WHERE id = $1`, [TASK]);
    await runtimeB.scanOnce(new Date("2030-08-13T10:02:00.000Z"));
    const staleState = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM task_reminder_delivery_state WHERE "reminderId" = $1`,
      [REMINDER],
    );
    assert.equal(staleState.rows[0]?.count, "0", "completed tasks must not retain stale pending delivery state");

    await runtimeA.shutdown();
    await runtimeB.shutdown();
  } finally {
    await closePgPool(pool);
  }
});
